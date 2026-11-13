/**
 * @file src/features/video-subtitle/content/courseCaptionSource.ts
 * 文件职责：读取 B 站、Udemy 和 edX 的完整原文时间轴，并隔离换课、语言变化及关闭后的迟到结果。
 * 主要内容：复用有界字幕传输，B 站重用当前 CID 的签名资源或固定播放器接口；Udemy 在当前企业域请求已订阅课程，edX 读取当前块语言；失败由用户明确重试。
 * 模块边界：只依赖注入的网页读取端口，不翻译、不保存账号数据或音视频；同一媒体身份只保留一份在途请求和成功时间轴。
 */
import {captionRecord, chooseBilibiliCaption, chooseUdemyCaption, parseCourseCaptionJson, type CourseCaptionRequest} from './courseCaptionData';
import {readVideoCaptionText} from './subtitleTransport';
import {parseWebVttSubtitleResponse} from './xVideoSubtitleData';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

export type CourseCaptionStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export interface CourseCaptionSourcePorts {
    base: URL;
    fetch: typeof fetch;
    manifest(part: string, signal: AbortSignal): Promise<number>;
    resources(): string[];
    changed(): void;
}

export class CourseCaptionSource {
    status: CourseCaptionStatus = 'idle';
    cues: VideoSubtitleCue[] = [];
    language = '';
    private identity = '';
    private controller: AbortController | null = null;
    constructor(private readonly ports: CourseCaptionSourcePorts) {}

    sync(request: CourseCaptionRequest | null, mediaKey: string): void {
        const key = request ? `${mediaKey}:${request.key}` : '';
        if (key === this.identity) return;
        this.clear(); this.identity = key;
        if (!request) return;
        const controller = this.controller = new AbortController();
        this.status = 'loading';
        void this.load(request, controller.signal).then(result => {
            if (controller.signal.aborted || this.controller !== controller) return;
            this.cues = result.cues; this.language = result.language;
            this.status = result.cues.length ? 'ready' : 'empty';
        }).catch(() => {
            if (!controller.signal.aborted && this.controller === controller) this.status = 'error';
        }).finally(() => {
            if (!controller.signal.aborted && this.controller === controller) {
                this.controller = null; this.ports.changed();
            }
        });
    }
    clear(): void {
        this.controller?.abort(); this.controller = null;
        this.identity = ''; this.cues = []; this.language = ''; this.status = 'idle';
    }
    retry(): void { this.clear(); }

    private async load(request: CourseCaptionRequest, signal: AbortSignal): Promise<{language: string; cues: VideoSubtitleCue[]}> {
        const {base} = this.ports;
        const text = (url: string, maxBytes = 8_000_000) => readVideoCaptionText(url, this.ports.fetch,
            {signal, credentials: new URL(url).origin === base.origin || new URL(url).hostname === 'api.bilibili.com' ? 'include' : 'omit', maxBytes});
        const json = async (url: string) => captionRecord(JSON.parse(await text(url, 2_000_000)));
        if (request.platform === 'bilibili') {
            const cid = await this.ports.manifest(request.id, signal);
            const signed = this.ports.resources().reverse().find(value => {
                try {
                    const url = new URL(value);
                    return url.origin === 'https://api.bilibili.com' && /^\/x\/player\/(?:wbi\/)?v2$/.test(url.pathname)
                        && url.searchParams.get('cid') === String(cid);
                } catch { return false; }
            });
            const id = request.id.split(':')[0];
            const url = signed || `https://api.bilibili.com/x/player/v2?cid=${cid}&${id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`}`;
            const data = captionRecord((await json(url)).data);
            if (data.cid !== cid) throw new Error('字幕媒体身份不匹配');
            const track = chooseBilibiliCaption(captionRecord(data.subtitle).subtitles, base);
            return track ? {language: track.language, cues: parseCourseCaptionJson('bilibili', JSON.parse(await text(track.url)))} : {language: '', cues: []};
        }
        if (request.platform === 'udemy') {
            const [slug, lecture] = request.id.split('/');
            const course = await json(`${base.origin}/api-2.0/courses/${encodeURIComponent(slug)}/?fields[course]=id,locale`);
            if (!Number.isSafeInteger(course.id) || Number(course.id) <= 0) throw new Error('无法读取课程');
            const locale = captionRecord(course.locale).locale;
            if (typeof locale !== 'string' || !locale) throw new Error('无法读取课程原语言');
            const data = await json(`${base.origin}/api-2.0/users/me/subscribed-courses/${course.id}/lectures/${lecture}/?fields[lecture]=asset&fields[asset]=captions`);
            const captions = captionRecord(data.asset).captions;
            if (!Array.isArray(captions)) throw new Error('无法读取课程字幕');
            const track = chooseUdemyCaption(captions, locale, base);
            if (!track) return {language: '', cues: []};
            const body = await text(track.url);
            if (!body.replace(/^\uFEFF/, '').startsWith('WEBVTT')) throw new Error('无效的课程字幕');
            return {language: track.language, cues: parseWebVttSubtitleResponse(body)};
        }
        return {language: request.language, cues: parseCourseCaptionJson('edx', JSON.parse(await text(request.url)))};
    }
}

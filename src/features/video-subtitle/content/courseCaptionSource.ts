/**
 * @file src/features/video-subtitle/content/courseCaptionSource.ts
 * 文件职责：读取 B 站、Udemy、edX 与 Coursera 的完整原文时间轴，并隔离换课、语言变化及关闭后的迟到结果。
 * 主要内容：支持动态解析当前页面基准地址以兼容 SPA 导航；复用有界字幕传输并对瞬态网络/5xx/超时执行有界退避重试；B 站无签名空列表延迟复查迟到的 wbi/v2 签名接口；Udemy 在当前企业域请求已订阅课程，edX 读取当前块语言，Coursera 读取公开 WebVTT 字幕。
 * 模块边界：只依赖注入的网页读取端口，不翻译、不保存账号数据或音视频；同一媒体身份只保留一份在途请求、延迟复查和成功时间轴。
 */
import {captionRecord, chooseBilibiliCaption, chooseUdemyCaption, parseCourseCaptionJson, type CourseCaptionRequest} from './courseCaptionData';
import {readVideoCaptionText} from './subtitleTransport';
import {parseWebVttSubtitleResponse} from './xVideoSubtitleData';
import type {VideoSubtitleCue} from './youtubeSubtitleData';

export type CourseCaptionStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
export interface CourseCaptionSourcePorts {
    base: URL | (() => URL);
    fetch: typeof fetch;
    manifest(part: string, signal: AbortSignal): Promise<number>;
    resources(): string[];
    changed(): void;
}

interface CourseCaptionLoadResult {
    language: string;
    cues: VideoSubtitleCue[];
    bilibiliUnsignedCid?: number;
}

const TRANSIENT_RETRY_DELAYS_MS = [800, 2000] as const;
const BILIBILI_SIGNED_RECHECK_DELAY_MS = 1500;

function isTransientCourseCaptionError(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    if (typeof error === 'object' && error !== null) {
        const candidate = error as {name?: unknown; statusCode?: unknown};
        if (candidate.name === 'TimeoutError') return true;
        if (typeof candidate.statusCode === 'number'
            && (candidate.statusCode === 429 || (candidate.statusCode >= 500 && candidate.statusCode <= 599))) {
            return true;
        }
    }
    if (!(error instanceof Error)) return false;
    return /超时|timeout|（(?:429|5\d{2})）|\b(?:429|5\d{2})\b/i.test(error.message);
}

function waitWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        signal.addEventListener('abort', onAbort, {once: true});
    });
}

export class CourseCaptionSource {
    status: CourseCaptionStatus = 'idle';
    cues: VideoSubtitleCue[] = [];
    language = '';
    private identity = '';
    private controller: AbortController | null = null;
    private recheckTimer: ReturnType<typeof setTimeout> | null = null;
    constructor(private readonly ports: CourseCaptionSourcePorts) {}

    sync(request: CourseCaptionRequest | null, mediaKey: string): void {
        const key = request ? `${mediaKey}:${request.key}` : '';
        if (key === this.identity) return;
        this.clear(); this.identity = key;
        if (!request) return;
        const controller = this.controller = new AbortController();
        this.status = 'loading';
        void this.loadWithRetry(request, controller.signal).then(result => {
            if (controller.signal.aborted || this.controller !== controller) return;
            this.cues = result.cues; this.language = result.language;
            this.status = result.cues.length ? 'ready' : 'empty';
            if (!result.cues.length && result.bilibiliUnsignedCid !== undefined) {
                this.scheduleBilibiliRecheck(request, result.bilibiliUnsignedCid);
            }
        }).catch(() => {
            if (!controller.signal.aborted && this.controller === controller) this.status = 'error';
        }).finally(() => {
            if (!controller.signal.aborted && this.controller === controller) {
                this.controller = null; this.ports.changed();
            }
        });
    }
    clear(): void {
        this.clearRecheckTimer();
        this.abortController();
        this.identity = ''; this.cues = []; this.language = ''; this.status = 'idle';
    }
    retry(): void { this.clear(); }

    private clearRecheckTimer(): void {
        if (this.recheckTimer !== null) {
            clearTimeout(this.recheckTimer);
            this.recheckTimer = null;
        }
    }

    private abortController(): void {
        this.controller?.abort();
        this.controller = null;
    }

    private resolveBase(): URL {
        return typeof this.ports.base === 'function' ? this.ports.base() : this.ports.base;
    }

    private findSignedBilibiliUrl(cid: number): string | undefined {
        return [...this.ports.resources()].reverse().find(value => {
            try {
                const url = new URL(value);
                if (url.origin !== 'https://api.bilibili.com' || url.searchParams.get('cid') !== String(cid)) return false;
                return url.pathname === '/x/player/wbi/v2'
                    || (url.pathname === '/x/player/v2' && Boolean(url.searchParams.get('w_rid')));
            } catch { return false; }
        });
    }

    private readText(url: string, signal: AbortSignal, maxBytes = 8_000_000): Promise<string> {
        const base = this.resolveBase();
        return readVideoCaptionText(url, this.ports.fetch, {
            signal,
            credentials: new URL(url).origin === base.origin || new URL(url).hostname === 'api.bilibili.com' ? 'include' : 'omit',
            maxBytes,
        });
    }

    private async readJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
        return captionRecord(JSON.parse(await this.readText(url, signal, 2_000_000)));
    }

    private async loadBilibiliFromUrl(
        request: CourseCaptionRequest,
        cid: number,
        url: string,
        signal: AbortSignal,
    ): Promise<{language: string; cues: VideoSubtitleCue[]}> {
        const base = this.resolveBase();
        const response = await this.readJson(url, signal);
        if (response.code !== 0) throw new Error('无法读取平台字幕');
        const data = captionRecord(response.data);
        if (data.cid !== cid) throw new Error('字幕媒体身份不匹配');
        const tracks = captionRecord(data.subtitle).subtitles;
        if (!Array.isArray(tracks)) throw new Error('无法读取平台字幕列表');
        if (!tracks.length) return {language: '', cues: []};
        const track = chooseBilibiliCaption(tracks, base, request.language, request.target);
        if (!track) throw new Error('平台字幕轨道暂不可用');
        const cues = parseCourseCaptionJson('bilibili', JSON.parse(await this.readText(track.url, signal)));
        if (!cues.length) throw new Error('平台字幕内容暂不可用');
        return {language: track.language, cues};
    }

    private scheduleBilibiliRecheck(request: CourseCaptionRequest, cid: number): void {
        this.clearRecheckTimer();
        this.recheckTimer = setTimeout(() => {
            this.recheckTimer = null;
            const signed = this.findSignedBilibiliUrl(cid);
            if (!signed) return;
            this.abortController();
            const controller = this.controller = new AbortController();
            void this.loadBilibiliFromUrl(request, cid, signed, controller.signal).then(result => {
                if (controller.signal.aborted || this.controller !== controller || !result.cues.length) return;
                this.cues = result.cues;
                this.language = result.language;
                this.status = 'ready';
                this.ports.changed();
            }).catch(() => {
                // 延迟复查失败时维持既有空状态，避免覆盖此前确认结果。
            }).finally(() => {
                if (this.controller === controller) this.controller = null;
            });
        }, BILIBILI_SIGNED_RECHECK_DELAY_MS);
    }

    private async loadWithRetry(request: CourseCaptionRequest, signal: AbortSignal): Promise<CourseCaptionLoadResult> {
        let attempt = 0;
        while (true) {
            try {
                return await this.load(request, signal);
            } catch (error) {
                if (attempt >= TRANSIENT_RETRY_DELAYS_MS.length || !isTransientCourseCaptionError(error)) {
                    throw error;
                }
                await waitWithAbort(TRANSIENT_RETRY_DELAYS_MS[attempt]!, signal);
                attempt += 1;
            }
        }
    }

    private async load(request: CourseCaptionRequest, signal: AbortSignal): Promise<CourseCaptionLoadResult> {
        const base = this.resolveBase();
        if (request.platform === 'bilibili') {
            const cid = await this.ports.manifest(request.id, signal);
            const signed = this.findSignedBilibiliUrl(cid);
            const id = request.id.split(':')[0];
            const url = signed || `https://api.bilibili.com/x/player/v2?cid=${cid}&${id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`}`;
            const result = await this.loadBilibiliFromUrl(request, cid, url, signal);
            return !result.cues.length && !signed ? {...result, bilibiliUnsignedCid: cid} : result;
        }
        if (request.platform === 'udemy') {
            const [slug, lecture] = request.id.split('/');
            const course = await this.readJson(`${base.origin}/api-2.0/courses/${encodeURIComponent(slug)}/?fields[course]=id,locale`, signal);
            if (!Number.isSafeInteger(course.id) || Number(course.id) <= 0) throw new Error('无法读取课程');
            const locale = captionRecord(course.locale).locale;
            if (typeof locale !== 'string' || !locale) throw new Error('无法读取课程原语言');
            const data = await this.readJson(`${base.origin}/api-2.0/users/me/subscribed-courses/${course.id}/lectures/${lecture}/?fields[lecture]=asset&fields[asset]=captions`, signal);
            const captions = captionRecord(data.asset).captions;
            if (!Array.isArray(captions)) throw new Error('无法读取课程字幕');
            const track = chooseUdemyCaption(captions, locale, base);
            if (!track) return {language: '', cues: []};
            const body = await this.readText(track.url, signal);
            if (!body.replace(/^\uFEFF/, '').startsWith('WEBVTT')) throw new Error('无效的课程字幕');
            return {language: track.language, cues: parseWebVttSubtitleResponse(body)};
        }
        if (import.meta.env.BROWSER !== 'userscript' && request.platform === 'coursera') {
            const body = await this.readText(request.url, signal);
            if (!body.replace(/^\uFEFF/u, '').startsWith('WEBVTT')) throw new Error('无效的课程字幕');
            return {language: request.language, cues: parseWebVttSubtitleResponse(body)};
        }
        return {language: request.language, cues: parseCourseCaptionJson('edx', JSON.parse(await this.readText(request.url, signal)))};
    }
}

/**
 * @file src/features/video-subtitle/content/courseCaptionData.ts
 * 文件职责：解析课程视频身份、原文字幕轨道及 B 站和 edX 的完整字幕时间轴。
 * 主要内容：分 P、课程小节和 edX 语言进入身份；人工原文优先，限定字幕资源主机，校验数字与数组边界并复用时间轴规范化。
 * 模块边界：只读取传入的地址、视频节点和数据，不调用网络、页面全局、翻译或持久化。
 */
import type {VideoCoursePlatform} from '@/src/core/config/videoCourse';
import {finalizeVideoSubtitleCues, type VideoSubtitleCue} from './youtubeSubtitleData';

export interface CourseCaptionRequest {
    platform: VideoCoursePlatform;
    key: string;
    id: string;
    language: string;
    url: string;
}
export interface CourseCaptionTrack {url: string; language: string; manual: boolean}

export function captionRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function getBilibiliPart(url: URL): string {
    const id = url.pathname.startsWith('/list/') ? url.searchParams.get('bvid')
        : url.pathname.match(/^\/(?:[A-Za-z-]+\/)?video\/((?:BV[\dA-Za-z]{10}|av\d+))\/?$/)?.[1];
    if (!id || !/^(?:BV[\dA-Za-z]{10}|av\d+)$/.test(id)) return '';
    const part = Number(url.searchParams.get('p'));
    return `${id}:${Number.isSafeInteger(part) && part > 0 ? part : 1}`;
}

/** 字幕地址来自宿主元数据，仍按站点限制；跨站资源不携带账号凭据。 */
export function resolveCourseCaptionUrl(value: unknown, base: URL, platform: VideoCoursePlatform): string {
    if (typeof value !== 'string' || !value || value.length > 8192) return '';
    try {
        const url = new URL(value, base);
        if (url.protocol !== 'https:' || url.username || url.password) return '';
        const allowed = platform === 'bilibili' ? /(^|\.)(?:hdslb|bilibili|biliapi)\.com$/.test(url.hostname)
            : platform === 'udemy' ? /(^|\.)(?:udemy|udemycdn)\.com$/.test(url.hostname)
            : url.origin === base.origin;
        return allowed ? url.href : '';
    } catch { return ''; }
}

export function getCourseCaptionRequest(platform: VideoCoursePlatform, url: URL, video: HTMLVideoElement): CourseCaptionRequest | null {
    if (platform === 'bilibili') {
        const id = getBilibiliPart(url);
        return id ? {platform, key: id, id, language: '', url: ''} : null;
    }
    if (platform === 'udemy') {
        const match = url.pathname.match(/^\/course\/([^/]+)\/learn\/lecture\/(\d+)\/?$/);
        return match ? {platform, key: `${match[1]}/${match[2]}`, id: `${match[1]}/${match[2]}`, language: '', url: ''} : null;
    }
    const block = video.closest<HTMLElement>('.video[data-metadata]');
    if (!block) return null;
    try {
        const metadata = captionRecord(JSON.parse(block.dataset.metadata!));
        const language = block.querySelector<HTMLElement>('.langs-list .is-active[data-lang-code]')?.dataset.langCode
            || (typeof metadata.transcriptLanguage === 'string' ? metadata.transcriptLanguage : '');
        const id = block.dataset.blockId || block.id;
        if (!id || !language || !/^[\w-]{1,35}$/.test(language) || typeof metadata.transcriptTranslationUrl !== 'string') return null;
        const source = resolveCourseCaptionUrl(metadata.transcriptTranslationUrl.replace('__lang__', language), url, platform);
        return source ? {platform, key: `${id}:${language}:${source}`, id, language, url: source} : null;
    } catch { return null; }
}

export function chooseBilibiliCaption(value: unknown, base: URL): CourseCaptionTrack | null {
    if (!Array.isArray(value)) return null;
    const tracks = value.flatMap(item => {
        const entry = captionRecord(item);
        const url = resolveCourseCaptionUrl(entry.subtitle_url, base, 'bilibili');
        if (!url || typeof entry.lan !== 'string' || !entry.lan) return [];
        return [{url, language: entry.lan.replace(/^ai-/, ''), manual: !entry.lan.startsWith('ai-')}];
    });
    return tracks.find(track => track.manual) || tracks[0] || null;
}

export function chooseUdemyCaption(value: unknown, locale: string, base: URL): CourseCaptionTrack | null {
    if (!Array.isArray(value)) return null;
    const tracks = value.flatMap(item => {
        const entry = captionRecord(item);
        const rawLanguage = entry.locale_id || (typeof entry.locale === 'string' ? entry.locale : captionRecord(entry.locale).locale);
        const url = resolveCourseCaptionUrl(entry.url, base, 'udemy');
        if (!url || entry.status !== 1 || typeof rawLanguage !== 'string' || !rawLanguage) return [];
        return [{url, language: rawLanguage.replace(/_/g, '-'), manual: entry.source === 'manual'}];
    });
    const language = locale.toLowerCase().split(/[-_]/)[0];
    const originals = language ? tracks.filter(track => track.language.toLowerCase().split('-')[0] === language) : tracks;
    // 已知课程语言时不使用另一种语言的机器译轨，避免二次翻译。
    return originals.find(track => track.manual) || originals[0] || null;
}

export function parseCourseCaptionJson(platform: 'bilibili' | 'edx', value: unknown): VideoSubtitleCue[] {
    const data = captionRecord(value);
    const cues: VideoSubtitleCue[] = [];
    if (platform === 'bilibili') {
        if (!Array.isArray(data.body) || data.body.length > 200_000) return [];
        for (const item of data.body) {
            const cue = captionRecord(item);
            if (typeof cue.from === 'number' && typeof cue.to === 'number' && typeof cue.content === 'string') {
                cues.push({startMs: cue.from * 1000, durationMs: (cue.to - cue.from) * 1000, text: cue.content});
            }
        }
    } else {
        const {start, end, text} = data;
        if (!Array.isArray(start) || !Array.isArray(text) || start.length !== text.length || start.length > 200_000
            || (end !== undefined && (!Array.isArray(end) || end.length !== start.length))) return [];
        for (let index = 0; index < start.length; index++) {
            const begin = start[index], finish = end === undefined ? start[index + 1] ?? begin + 3000 : (end as unknown[])[index];
            if (typeof begin === 'number' && typeof finish === 'number' && typeof text[index] === 'string') {
                cues.push({startMs: begin, durationMs: finish - begin, text: text[index]});
            }
        }
    }
    return finalizeVideoSubtitleCues(cues.filter(cue => Number.isFinite(cue.startMs) && cue.startMs >= 0
        && Number.isFinite(cue.durationMs) && cue.durationMs > 0));
}

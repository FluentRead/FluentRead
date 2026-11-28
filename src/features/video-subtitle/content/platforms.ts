/**
 * @file src/features/video-subtitle/content/platforms.ts
 * 文件职责：定义会议、课程及主流流媒体视频的站点边界、字幕节点与明确开启控件，并选择目标语言人工轨。
 * 主要内容：识别会议、上课与 Netflix/Prime Video/TED/Vimeo/Disney+ 等视频播放站点入口；规范化语言别名并排除自动生成或机器翻译轨。
 * 模块边界：只处理传入的位置、轨道和节点，不读取配置、请求网络或修改宿主页面。
 */
export type CaptionPlatform =
    | 'meet' | 'teams' | 'zoom'
    | 'bilibili' | 'udemy' | 'edx' | 'coursera'
    | 'disney' | 'netflix' | 'primevideo' | 'ted' | 'vimeo';

export function getCourseraLectureId(pathname: string): string {
    return pathname.match(/^\/learn\/[\w%-]+\/lecture\/([\w-]{1,80})(?:\/[\w%-]+)?\/?$/u)?.[1] ?? '';
}

export function getCaptionPlatform(location: Pick<Location, 'hostname' | 'pathname'>): CaptionPlatform | null {
    const host = location.hostname.toLowerCase();
    if (host === 'meet.google.com') return 'meet';
    if (['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].includes(host)) return 'teams';
    if (/(^|\.)zoom\.(us|com)$/.test(host) && /^\/wc(?:\/|$)/.test(location.pathname)) return 'zoom';
    if (/(^|\.)udemy\.com$/.test(host)) return 'udemy';
    if (host === 'bilibili.com' || host === 'www.bilibili.com') return 'bilibili';
    if (/(^|\.)edx\.org$/.test(host)) return 'edx';
    if (import.meta.env.BROWSER !== 'userscript' && (host === 'www.coursera.org' || host === 'coursera.org') && getCourseraLectureId(location.pathname)) return 'coursera';
    if (/(^|\.)disneyplus\.com$/.test(host)) return 'disney';
    if (/(^|\.)netflix\.com$/.test(host)) return 'netflix';
    if (/(^|\.)primevideo\.com$/.test(host)) return 'primevideo';
    if (/^(?:www\.)?amazon\.(?:com|co\.jp|co\.uk|de)$/.test(host) && /^\/(?:gp\/video|detail)(?:\/|$)/.test(location.pathname)) return 'primevideo';
    if (/(^|\.)ted\.com$/.test(host)) return 'ted';
    if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') return 'vimeo';
    return null;
}

export function isMeetingCaptionPlatform(platform: CaptionPlatform): boolean {
    return platform === 'meet' || platform === 'teams' || platform === 'zoom';
}

export function isStreamingCaptionPlatform(platform: CaptionPlatform): boolean {
    return platform === 'disney' || platform === 'netflix' || platform === 'primevideo' || platform === 'ted' || platform === 'vimeo';
}

export const PLATFORM_CAPTION_SELECTORS: Record<CaptionPlatform, string> = {
    meet: '.ygicle.VbkSUe, [data-caption-text]',
    teams: '[data-tid="closed-caption-text"]',
    zoom: '.live-transcription-subtitle__item',
    udemy: '[data-purpose="captions-cue-text"], .shaka-text-container',
    bilibili: '.bpx-player-subtitle-wrap',
    edx: '.closed-captions',
    coursera: '.vjs-text-track-display, .vjs-text-track-cue',
    disney: '.dss-hls-subtitle-overlay, .hive-subtitle-renderer, .shaka-text-container',
    netflix: '.player-timedtext-text-container, .player-timedtext',
    primevideo: '.atvwebplayersdk-captions-text, .f35bt6a',
    ted: '.vjs-text-track-display, .vjs-text-track-cue, [data-testid="caption-text"], .ted-captions',
    vimeo: '.vp-captions, .vp-telecine',
};

const CAPTION_BUTTON_SELECTORS: Partial<Record<CaptionPlatform, string>> = {
    meet: 'button[aria-label], [role="button"][aria-label]',
    teams: '[data-tid="closed-caption-button"], [data-tid="toggle-captions"], [data-tid="turn-on-live-captions"], [role="menuitem"][aria-label], button[aria-label]',
    zoom: '.footer__cc-button, button[aria-label], [role="button"][aria-label]',
};

const CAPTION_ENABLE_LABEL = /^(?:(?:turn on|show|enable)\s+(?:closed\s+|live\s+)?(?:captions|subtitles)|(?:开启|打开|显示|開啟|打開|顯示)(?:实时|即時|隐藏式|隱藏式)?字幕|(?:ライブ)?字幕を(?:オンにする|オン|有効にする|表示する|表示)|(?:실시간\s*)?자막\s*(?:켜기|표시|사용)|(?:activer|afficher)\s+les\s+sous-titres(?:\s+en\s+direct)?|(?:live[- ]?)?untertitel\s+(?:aktivieren|einschalten|einblenden)|(?:activar|mostrar)\s+(?:los\s+)?subt[ií]tulos(?:\s+en\s+(?:directo|vivo))?|(?:ativar|mostrar)\s+(?:as\s+)?legendas(?:\s+ao\s+vivo)?)(?:\s*\([^)]*\))?$/i;
const TEAMS_LANGUAGE_MENU_LABEL = /^(?:language and speech|语言[和与]语音|語言[和與]語音|言語と音声|언어 및 음성|langue et voix|sprache und sprach(?:aus|ein)gabe|idioma y voz|idioma e fala)$/i;

/** 只接受明确的“开启/显示字幕”；不点击录制、转录、更多菜单或已开启的开关。 */
export function findCaptionEnableButton(root: ParentNode, platform: CaptionPlatform): HTMLElement | null {
    const selector = CAPTION_BUTTON_SELECTORS[platform];
    if (!selector) return null;
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(button => {
        if (button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'
            || button.getAttribute('aria-pressed') === 'true' || button.getAttribute('aria-checked') === 'true'
            || button.closest('[hidden], [aria-hidden="true"]')) return false;
        const label = button.getAttribute('aria-label') || button.textContent || '';
        return CAPTION_ENABLE_LABEL.test(label.trim());
    }) || null;
}

/** Teams 把字幕开关放在会议的更多操作菜单中，只沿明确的会议控件与语言菜单导航。 */
export function findTeamsCaptionMenuStep(root: ParentNode): HTMLElement | null {
    const language = Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(node =>
        TEAMS_LANGUAGE_MENU_LABEL.test((node.getAttribute('aria-label') || node.textContent || '').trim())
        && !node.closest('[hidden], [aria-hidden="true"]') && node.getAttribute('aria-disabled') !== 'true');
    if (language) return language;
    const more = root.querySelector<HTMLElement>('#callingButtons-showMoreBtn, [data-tid="callingButtons-showMoreBtn"], [data-tid="call-more-options"]');
    return more && !more.hasAttribute('disabled') && more.getAttribute('aria-disabled') !== 'true'
        && more.getAttribute('aria-expanded') !== 'true' && !more.closest('[hidden], [aria-hidden="true"]') ? more : null;
}

export interface HumanCaptionTrack {
    languageCode: string;
    kind?: string;
    name?: string;
    generated?: boolean;
}

function captionLanguage(value: string): string {
    const language = value.trim().toLowerCase().replace(/_/g, '-');
    if (/^zh-(?:cn|sg|hans)(?:-|$)/.test(language)) return 'zh-hans';
    if (/^zh-(?:tw|hk|mo|hant)(?:-|$)/.test(language)) return 'zh-hant';
    return language;
}

/** 中文简繁分开匹配；其他语言允许地域别名，但精确语言排在前面。 */
export function captionLanguageMatch(language: string, target: string): number {
    const left = captionLanguage(language), right = captionLanguage(target);
    if (!left || !right || right === 'auto') return 0;
    if (left === right) return 2;
    if (left.startsWith('zh-') && right.startsWith('zh-')) return 0;
    return left.split('-')[0] === right.split('-')[0] ? 1 : 0;
}

export function chooseTargetHumanCaptionTrack<T extends HumanCaptionTrack>(tracks: readonly T[], target: string): T | null {
    let best: T | null = null;
    let rank = 0;
    for (const track of tracks) {
        if (track.generated || /^(?:asr|auto|machine)$/i.test(track.kind || '')
            || /auto[- ]?(?:generated|translated)|automatic|自动(?:生成|翻译)|机器翻译/i.test(track.name || '')) continue;
        const match = captionLanguageMatch(track.languageCode, target);
        if (match > rank) { best = track; rank = match; }
    }
    return best;
}

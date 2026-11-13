/**
 * @file src/features/video-subtitle/content/platforms.ts
 * 文件职责：定义会议及课程视频的站点边界、字幕节点与明确开启控件，并选择目标语言人工轨。
 * 主要内容：按域名识别 Teams、Zoom、Meet、B 站、Udemy、edX 和 Disney+；规范化语言别名并排除自动生成或机器翻译轨。
 * 模块边界：只处理传入的位置、轨道和节点，不读取配置、请求网络或修改宿主页面。
 */
export type CaptionPlatform = 'meet' | 'teams' | 'zoom' | 'bilibili' | 'udemy' | 'edx' | 'disney';

export function getCaptionPlatform(location: Pick<Location, 'hostname' | 'pathname'>): CaptionPlatform | null {
    const host = location.hostname.toLowerCase();
    if (host === 'meet.google.com') return 'meet';
    if (['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].includes(host)) return 'teams';
    if (/(^|\.)zoom\.(us|com)$/.test(host) && /^\/wc(?:\/|$)/.test(location.pathname)) return 'zoom';
    if (/(^|\.)udemy\.com$/.test(host)) return 'udemy';
    if (host === 'bilibili.com' || host === 'www.bilibili.com') return 'bilibili';
    if (/(^|\.)edx\.org$/.test(host)) return 'edx';
    if (/(^|\.)disneyplus\.com$/.test(host)) return 'disney';
    return null;
}

export function isMeetingCaptionPlatform(platform: CaptionPlatform): boolean {
    return platform === 'meet' || platform === 'teams' || platform === 'zoom';
}

export const PLATFORM_CAPTION_SELECTORS: Record<CaptionPlatform, string> = {
    meet: '.ygicle.VbkSUe, [data-caption-text]',
    teams: '[data-tid="closed-caption-text"]',
    zoom: '.live-transcription-subtitle__item',
    udemy: '[data-purpose="captions-cue-text"], .shaka-text-container',
    bilibili: '.bpx-player-subtitle-wrap',
    edx: '.closed-captions',
    disney: '.dss-hls-subtitle-overlay, .hive-subtitle-renderer, .shaka-text-container',
};

const CAPTION_BUTTON_SELECTORS: Partial<Record<CaptionPlatform, string>> = {
    meet: 'button[aria-label], [role="button"][aria-label]',
    teams: '[data-tid="closed-caption-button"], [data-tid="toggle-captions"], [data-tid="turn-on-live-captions"], [role="menuitem"][aria-label], button[aria-label]',
    zoom: '.footer__cc-button, button[aria-label], [role="button"][aria-label]',
};

/** 只接受明确的“开启/显示字幕”；不点击录制、转录、更多菜单或已开启的开关。 */
export function findCaptionEnableButton(root: ParentNode, platform: CaptionPlatform): HTMLElement | null {
    const selector = CAPTION_BUTTON_SELECTORS[platform];
    if (!selector) return null;
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(button => {
        if (button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true'
            || button.getAttribute('aria-pressed') === 'true' || button.getAttribute('aria-checked') === 'true'
            || button.closest('[hidden], [aria-hidden="true"]')) return false;
        const label = button.getAttribute('aria-label') || button.textContent || '';
        return /^(?:turn on (?:live )?captions|show (?:closed |live )?(?:captions|subtitles)|开启(?:实时)?字幕|打开(?:实时)?字幕|显示(?:实时)?字幕)(?:\s*\([^)]*\))?$/i.test(label.trim());
    }) || null;
}

/** Teams 把字幕开关放在会议的更多操作菜单中，只沿明确的会议控件与语言菜单导航。 */
export function findTeamsCaptionMenuStep(root: ParentNode): HTMLElement | null {
    const language = Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(node =>
        /^(?:language and speech|语言和语音|语言与语音)$/i.test((node.getAttribute('aria-label') || node.textContent || '').trim())
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

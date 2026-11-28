/**
 * @file src/features/video-subtitle/content/platformProfiles.ts
 * 文件职责：为课程及主流流媒体视频平台提供统一的播放器容器、控制栏挂载锚点与转录文本定位规则。
 * 主要内容：声明 B 站、Udemy、edX、Coursera、Netflix、Prime Video、TED、Vimeo 与 Disney+ 的播放器选择器及控制栏锚点；提供可见锚点筛选和 TED 演讲稿活跃句读取函数。
 * 模块边界：仅只读查询传入的 DOM 节点和平台标识，不创建或修改页面节点、不读取扩展配置，也不发起任何网络请求。
 */
import type {CaptionPlatform} from './platforms';

export interface PlatformDomProfile {
    readonly playerSelector: string;
    readonly controlBarSelector: string;
    readonly controlAnchorSelector: string;
    readonly streamingControlBar: boolean;
}

export interface PlatformControlMountTarget {
    readonly controls: HTMLElement;
    readonly anchor: HTMLElement | null;
    readonly nativeFallback: boolean;
}

export const PLATFORM_DOM_PROFILES: Partial<Record<CaptionPlatform, PlatformDomProfile>> = {
    bilibili: {
        playerSelector: '.bpx-player-container',
        controlBarSelector: '.bpx-player-control-bottom-right',
        controlAnchorSelector: '.bpx-player-ctrl-subtitle, .bpx-player-ctrl-setting, .bpx-player-ctrl-full',
        streamingControlBar: false,
    },
    udemy: {
        playerSelector: '[data-purpose="shaka-video-player"]',
        controlBarSelector: '[data-purpose="video-control-bar"]',
        controlAnchorSelector: '[data-purpose="captions-dropdown-button"], [data-purpose="fullscreen-button"]',
        streamingControlBar: false,
    },
    edx: {
        playerSelector: '.video[data-metadata]',
        controlBarSelector: '.secondary-controls',
        controlAnchorSelector: '.toggle-captions, .toggle-fullscreen, [data-role="fullscreen"]',
        streamingControlBar: false,
    },
    coursera: {
        playerSelector: '.video-js, [data-testid="video-player"]',
        controlBarSelector: '.vjs-control-bar',
        controlAnchorSelector: '.vjs-subs-caps-button, .vjs-fullscreen-control',
        streamingControlBar: false,
    },
    netflix: {
        playerSelector: '.watch-video--player-view, .VideoContainer',
        controlBarSelector: '.watch-video--bottom-controls-container, [data-uia="controls-standard"]',
        controlAnchorSelector: '[data-uia="control-audio-subtitle"], [data-uia="control-fullscreen-enter"], [data-uia="control-fullscreen-exit"]',
        streamingControlBar: true,
    },
    primevideo: {
        playerSelector: '.webPlayerSDKContainer, .atvwebplayersdk-overlays-container, #dv-web-player',
        controlBarSelector: '.atvwebplayersdk-bottompanel-container, .atvwebplayersdk-hideabletopbuttons-container',
        controlAnchorSelector: '.atvwebplayersdk-subtitle-button, .atvwebplayersdk-fullscreen-button',
        streamingControlBar: true,
    },
    ted: {
        playerSelector: '[data-testid="talk-player"], .video-js, .ted-player',
        controlBarSelector: '.vjs-control-bar, [data-testid="player-controls"]',
        controlAnchorSelector: '.vjs-subs-caps-button, .vjs-fullscreen-control, [data-testid="cc-button"]',
        streamingControlBar: true,
    },
    vimeo: {
        playerSelector: '.vp-video-wrapper, .vp-player-layout, #player',
        controlBarSelector: '.vp-controls, [data-testid="controls"]',
        controlAnchorSelector: '.vp-cc, button[aria-label*="CC" i], button[aria-label*="Captions" i], .fullscreen, button[aria-label*="Fullscreen" i]',
        streamingControlBar: true,
    },
    disney: {
        playerSelector: '.btm-media-player, [data-testid="video-player"]',
        controlBarSelector: '',
        controlAnchorSelector: '',
        streamingControlBar: false,
    },
};

export function getPlatformDomProfile(platform: CaptionPlatform): PlatformDomProfile | null {
    return PLATFORM_DOM_PROFILES[platform] ?? null;
}

export function hasStreamingControlBar(platform: CaptionPlatform): boolean {
    return Boolean(PLATFORM_DOM_PROFILES[platform]?.streamingControlBar);
}

/** 优先命中已知播放器容器，未命中时回退到 video 的直接父节点。 */
export function findPlatformPlayerRoot(video: HTMLVideoElement | null, platform: CaptionPlatform): HTMLElement | null {
    if (!video) return null;
    const profile = PLATFORM_DOM_PROFILES[platform];
    if (profile?.playerSelector) {
        const matched = video.closest<HTMLElement>(profile.playerSelector);
        if (matched) return matched;
    }
    return video.parentElement;
}

/**
 * 为课程或主流流媒体播放器解析安全的控制栏挂载目标。
 * 流媒体平台仅在真实控制栏或锚点存在时返回，避免在无控制栏视图上额外悬浮占位。
 */
export function findPlatformControlMount(
    root: HTMLElement | null,
    platform: CaptionPlatform,
    video: HTMLVideoElement | null,
    view: Window,
    allowRootFallback: boolean,
): PlatformControlMountTarget | null {
    const profile = PLATFORM_DOM_PROFILES[platform];
    if (!root || !profile?.controlBarSelector) return null;
    const bars = Array.from(root.querySelectorAll<HTMLElement>(profile.controlBarSelector));
    const anchors = bars.flatMap(bar => Array.from(bar.querySelectorAll<HTMLElement>(profile.controlAnchorSelector)));
    const anchor = anchors.find(node => {
        const bounds = node.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && view.getComputedStyle(node).visibility !== 'hidden';
    }) || anchors[0] || null;
    const bar = anchor?.closest<HTMLElement>(profile.controlBarSelector) || bars[0] || null;
    if (!allowRootFallback && !anchor && !bar) return null;
    const nativeFallback = Boolean(video?.controls && !anchor && !bar?.querySelector('button, [role="button"], .bpx-player-ctrl'));
    const controls = nativeFallback ? root : anchor?.parentElement || bar || root;
    return {controls, anchor, nativeFallback};
}

/**
 * TED 演讲页面在未挂载字幕叠层或 `<track>` 时，可能通过页面演讲稿高亮节点暴露当前句。
 * 优先匹配显式 `aria-current="true"` / `data-cue-active="true"`，再按起止时间属性匹配。
 */
export function readPlatformTranscriptCue(platform: CaptionPlatform, root: ParentNode, timeSeconds: number): string {
    if (platform !== 'ted') return '';
    const active = root.querySelector<HTMLElement>('[data-testid="transcript-cue"][aria-current="true"], [data-transcript-cue][data-cue-active="true"], .ted-transcript-cue[aria-current="true"]');
    const activeText = active?.textContent?.trim();
    if (activeText) return activeText;
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) return '';
    const timedCues = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="transcript-cue"][data-start], [data-transcript-cue][data-start], .ted-transcript-cue[data-start]'));
    for (const node of timedCues) {
        const start = Number.parseFloat(node.dataset.start || '');
        const end = Number.parseFloat(node.dataset.end || '');
        if (Number.isFinite(start) && Number.isFinite(end) && timeSeconds >= start && timeSeconds < end) {
            const text = node.textContent?.trim();
            if (text) return text;
        }
    }
    return '';
}

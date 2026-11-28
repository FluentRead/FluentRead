/**
 * @file src/features/video-subtitle/content/modeShortcut.ts
 * 文件职责：统一处理视频字幕显示模式切换快捷键的网页键盘事件判定、模式转移与文案键映射，供 YouTube/X/HTML 媒体与 B 站/课程/会议平台运行时共同调用。
 * 主要内容：过滤非可信事件、长按重复、输入法合成和输入框聚焦场景；匹配已启用的模式切换快捷键后阻止事件继续传播，计算并应用下一个显示模式并触发通知回调。
 * 模块边界：本模块不直接持有配置存储、不绑定全局监听器、不操作播放器菜单 DOM；按键规则归 core/config/videoSubtitleShortcut，编辑态检测归 shared/dom/editingTarget，实际应用与提示渲染由调用方运行时注入端口完成。
 */
import {
    matchesVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkeyAction,
    resolveNextVideoSubtitleMenuMode,
    type VideoSubtitleShortcutDisplayMode,
    type VideoSubtitleShortcutMenuMode,
} from '@/src/core/config/videoSubtitleShortcut';
import {dismissPageNotice, showPageNotice} from '@/src/features/page-notice/public';
import {isEditingInPage} from '@/src/shared/dom/editingTarget';

const VIDEO_SUBTITLE_MODE_NOTICE_KEY = 'video-subtitle-mode';

export interface VideoSubtitleModeShortcutConfig {
    videoSubtitleModeHotkeyEnabled?: boolean;
    videoSubtitleModeHotkey?: string;
    customVideoSubtitleModeHotkey?: string;
    videoSubtitleModeHotkeyAction?: string;
    videoSubtitleDisplayMode?: unknown;
}

export interface VideoSubtitleModeShortcutPorts {
    document: Document;
    config: VideoSubtitleModeShortcutConfig;
    isActive: () => boolean;
    isVisible: () => boolean;
    applyMode: (mode: VideoSubtitleShortcutMenuMode) => void;
    notify?: (mode: VideoSubtitleShortcutMenuMode) => void;
}

const MODE_LABEL_KEYS: Record<VideoSubtitleShortcutMenuMode, string> = {
    bilingual: 'video.modeBilingual',
    'translation-only': 'video.modeTranslation',
    'original-only': 'video.modeOriginal',
    off: 'video.modeOff',
};

function normalizeDisplayMode(mode: unknown): VideoSubtitleShortcutDisplayMode {
    if (mode === 'translation-only' || mode === 'original-only') return mode;
    return 'bilingual';
}

/** 返回与播放器菜单一致的模式文案键，供快捷切换提示复用。 */
export function videoSubtitleModeLabelKey(mode: VideoSubtitleShortcutMenuMode): string {
    return MODE_LABEL_KEYS[mode];
}

/** 展示视频字幕显示模式切换反馈；同 key 原地更新，避免连续按键堆叠多条通知。 */
export function notifyVideoSubtitleModeSwitch(
    mode: VideoSubtitleShortcutMenuMode,
    translateText: (key: string, params?: Record<string, string | number>) => string,
    shortcut?: string,
): void {
    const modeLabel = translateText(videoSubtitleModeLabelKey(mode));
    const trimmedShortcut = shortcut?.trim();
    const message = trimmedShortcut
        ? translateText('video.modeShortcut.switchedWithKey', {mode: modeLabel, shortcut: trimmedShortcut})
        : translateText('video.modeShortcut.switched', {mode: modeLabel});
    showPageNotice(message, 'success', {key: VIDEO_SUBTITLE_MODE_NOTICE_KEY, durationMs: 1600});
}

/** 卸载或离开视频页面时撤销残留的字幕模式切换提示。 */
export function clearVideoSubtitleModeNotice(): void {
    dismissPageNotice(VIDEO_SUBTITLE_MODE_NOTICE_KEY);
}

/**
 * 处理视频页面上的键盘按下事件；先按极轻量热路径过滤无关按键，
 * 命中已启用的模式切换快捷键时阻止默认与同层/冒泡传播，按切换方式应用下一模式并返回 true。
 */
export function handleVideoSubtitleModeShortcutKeydown(
    event: KeyboardEvent,
    ports: VideoSubtitleModeShortcutPorts,
): boolean {
    if (!event.isTrusted || event.repeat || event.isComposing || event.defaultPrevented) return false;
    if (ports.config.videoSubtitleModeHotkeyEnabled !== true) return false;
    if (!matchesVideoSubtitleModeHotkey(
        event,
        ports.config.videoSubtitleModeHotkey,
        ports.config.customVideoSubtitleModeHotkey,
    )) {
        return false;
    }
    if (!ports.isActive()) return false;
    if (isEditingInPage(event, ports.document)) return false;

    event.preventDefault();
    event.stopImmediatePropagation();

    const nextMode = resolveNextVideoSubtitleMenuMode(
        normalizeDisplayMode(ports.config.videoSubtitleDisplayMode),
        ports.isVisible(),
        normalizeVideoSubtitleModeHotkeyAction(ports.config.videoSubtitleModeHotkeyAction),
    );
    ports.applyMode(nextMode);
    ports.notify?.(nextMode);
    return true;
}

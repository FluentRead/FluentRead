/**
 * @file src/core/config/videoSubtitleShortcut.ts
 * 文件职责：定义视频字幕显示模式切换快捷键的默认值、预设组合、切换方式、自定义热键合法性、保留热键解析与下一步模式计算规则，让配置、设置界面和视频字幕运行时共用同一份真值。
 * 主要内容：导出 DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY、VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS、VIDEO_SUBTITLE_MODE_HOTKEY_ACTIONS 与 DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY_ACTION，提供快捷键与切换方式归一化、自定义热键修饰键/功能键校验、启停态保留热键解析、带单槽编译缓存的按键事件匹配以及五种模式状态转移。
 * 模块边界：本文件只做纯配置归一、键盘事件匹配与模式状态转移，不读取存储、不绑定 DOM 监听、不渲染界面；按键解析规则归 core/hotkey，播放器菜单与配置持久化由 video-subtitle content 运行时负责。
 */
import {canonicalizeHotkey, matchesHotkey, parseHotkey, type ParsedHotkey} from '@/src/core/hotkey';

/**
 * 视频字幕模式切换的默认组合键。M 取 Mode 之意；避开 Alt+T（全文翻译）、Alt+C（段落复制）、
 * Alt+R（局部翻译）、Shift+Z（圈选翻译）、Alt+Shift+S（两点选取），也避开浏览器菜单和播放器单键。
 */
export const DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY = 'Alt+M';

/** 设置界面的预设选项；界面再追加“自定义快捷键”入口，对应 custom 取值。 */
export const VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS: readonly {value: string; label: string}[] = [
    {value: 'Alt+M', label: 'Alt+M / Option+M'},
    {value: 'Alt+B', label: 'Alt+B / Option+B'},
    {value: 'Shift+M', label: 'Shift+M'},
    {value: 'Shift+B', label: 'Shift+B'},
    {value: 'Ctrl+Alt+M', label: 'Ctrl+Alt+M / Control+Option+M'},
];

const PRESET_HOTKEY_MAP: ReadonlyMap<string, string> = new Map(
    VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS.map((option) => [option.value.toLowerCase(), option.value]),
);

/**
 * 快捷键切换方式：
 * - bilingual-original：在双语和仅原文之间一键往返；处于仅译文或关闭时切回双语；
 * - listening-cycle：听力练习循环（关闭 → 仅原文 → 双语 → 关闭）；处于仅译文时先切回仅原文；
 * - toggle-visibility：一键隐藏或恢复视频字幕，保留当前显示模式；
 * - cycle-display：循环切换双语 → 仅译文 → 仅原文；字幕关闭时先恢复显示；
 * - cycle-all：循环切换双语 → 仅译文 → 仅原文 → 关闭。
 */
export type VideoSubtitleModeHotkeyAction =
    | 'bilingual-original'
    | 'listening-cycle'
    | 'toggle-visibility'
    | 'cycle-display'
    | 'cycle-all';

export const VIDEO_SUBTITLE_MODE_HOTKEY_ACTIONS: readonly VideoSubtitleModeHotkeyAction[] = [
    'bilingual-original',
    'listening-cycle',
    'toggle-visibility',
    'cycle-display',
    'cycle-all',
];

export const DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY_ACTION: VideoSubtitleModeHotkeyAction = 'bilingual-original';

export type VideoSubtitleShortcutDisplayMode = 'bilingual' | 'translation-only' | 'original-only';
export type VideoSubtitleShortcutMenuMode = VideoSubtitleShortcutDisplayMode | 'off';

export interface ReservedVideoSubtitleModeHotkeyConfig {
    videoTranslationEnabled?: boolean;
    videoSubtitleModeHotkeyEnabled?: boolean;
    videoSubtitleModeHotkey?: string;
    customVideoSubtitleModeHotkey?: string;
}

const DISPLAY_MODE_ORDER: readonly VideoSubtitleShortcutDisplayMode[] = ['bilingual', 'translation-only', 'original-only'];
const ALL_MODE_ORDER: readonly VideoSubtitleShortcutMenuMode[] = ['bilingual', 'translation-only', 'original-only', 'off'];

/** 预设选择只接受列表内的组合键，其余值（含 none 和单键）回到默认值。 */
export function normalizeVideoSubtitleModeHotkey(value: unknown): string {
    if (value === 'custom') return 'custom';
    if (typeof value !== 'string') return DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY;
    const canonical = canonicalizeHotkey(value);
    return PRESET_HOTKEY_MAP.get(canonical.toLowerCase()) ?? DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY;
}

/** 视频字幕自定义快捷键必须包含修饰键或使用功能键（F1-F12），避免占用播放器单键。 */
export function isSupportedCustomVideoSubtitleModeHotkey(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const parsed = parseHotkey(value);
    return parsed.isValid && (parsed.modifiers.length > 0 || /^f\d+$/u.test(parsed.key));
}

/** 自定义组合键保存为平台无关的规范写法；无法解析或不满足修饰键/功能键要求时留空，交由预设兜底。 */
export function normalizeCustomVideoSubtitleModeHotkey(value: unknown): string {
    return isSupportedCustomVideoSubtitleModeHotkey(value) ? canonicalizeHotkey(value as string) : '';
}

/**
 * 返回运行时真正监听的组合键。选择了自定义但尚未录制成功时回到默认值，
 * 避免快捷键开关处于开启状态却没有可用组合。
 */
export function resolveVideoSubtitleModeHotkey(hotkey: unknown, customHotkey: unknown): string {
    const choice = normalizeVideoSubtitleModeHotkey(hotkey);
    if (choice !== 'custom') return choice;
    return normalizeCustomVideoSubtitleModeHotkey(customHotkey) || DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY;
}

/** 仅当视频翻译未关闭且模式快捷键开关开启时保留该组合键，避免停用状态下占用其他功能热键。 */
export function resolveReservedVideoSubtitleModeHotkey(config: ReservedVideoSubtitleModeHotkeyConfig): string {
    if (config.videoTranslationEnabled === false || config.videoSubtitleModeHotkeyEnabled !== true) {
        return '';
    }
    return resolveVideoSubtitleModeHotkey(config.videoSubtitleModeHotkey, config.customVideoSubtitleModeHotkey);
}

/** 生成界面展示用的按键名称，Mac 上显示 Option/Control 习惯写法。 */
export function videoSubtitleModeHotkeyDisplayName(hotkey: unknown, customHotkey: unknown): string {
    return parseHotkey(resolveVideoSubtitleModeHotkey(hotkey, customHotkey)).displayName;
}

let cachedMatchTarget: {rawHotkey: unknown; rawCustomHotkey: unknown; parsed: ParsedHotkey} | null = null;

/** 判断键盘事件是否为已配置的视频字幕显示模式切换快捷键；修饰键必须完全一致。 */
export function matchesVideoSubtitleModeHotkey(event: KeyboardEvent, hotkey: unknown, customHotkey: unknown): boolean {
    if (!cachedMatchTarget || cachedMatchTarget.rawHotkey !== hotkey || cachedMatchTarget.rawCustomHotkey !== customHotkey) {
        cachedMatchTarget = {
            rawHotkey: hotkey,
            rawCustomHotkey: customHotkey,
            parsed: parseHotkey(resolveVideoSubtitleModeHotkey(hotkey, customHotkey)),
        };
    }
    return matchesHotkey(event, cachedMatchTarget.parsed);
}

/** 切换方式只接受既定取值，历史配置或异常输入回到双语与原文往返。 */
export function normalizeVideoSubtitleModeHotkeyAction(value: unknown): VideoSubtitleModeHotkeyAction {
    return VIDEO_SUBTITLE_MODE_HOTKEY_ACTIONS.includes(value as VideoSubtitleModeHotkeyAction)
        ? value as VideoSubtitleModeHotkeyAction
        : DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY_ACTION;
}

/** 按当前显示模式、字幕可见状态和切换方式计算快捷键触发后的目标菜单模式。 */
export function resolveNextVideoSubtitleMenuMode(
    currentMode: VideoSubtitleShortcutDisplayMode,
    visible: boolean,
    action: VideoSubtitleModeHotkeyAction,
): VideoSubtitleShortcutMenuMode {
    if (action === 'bilingual-original') {
        return visible && currentMode === 'bilingual' ? 'original-only' : 'bilingual';
    }
    if (action === 'listening-cycle') {
        if (!visible) return 'original-only';
        if (currentMode === 'original-only') return 'bilingual';
        if (currentMode === 'bilingual') return 'off';
        return 'original-only';
    }
    if (action === 'toggle-visibility') {
        return visible ? 'off' : currentMode;
    }
    if (action === 'cycle-all') {
        const active: VideoSubtitleShortcutMenuMode = visible ? currentMode : 'off';
        return ALL_MODE_ORDER[(ALL_MODE_ORDER.indexOf(active) + 1) % ALL_MODE_ORDER.length];
    }
    if (!visible) return currentMode;
    return DISPLAY_MODE_ORDER[(DISPLAY_MODE_ORDER.indexOf(currentMode) + 1) % DISPLAY_MODE_ORDER.length];
}

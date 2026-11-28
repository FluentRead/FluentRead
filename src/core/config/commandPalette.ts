/**
 * @file src/core/config/commandPalette.ts
 * 文件职责：定义全局命令面板的启用开关默认值、默认快捷键与纯归一化规则，供配置模型、冲突校验、设置页和网页运行时共享。
 * 主要内容：默认采用 Alt+K 以避免劫持 GitHub、Notion、Slack、Linear 等站点的 Cmd/Ctrl+K，提供五组常用预设与自定义组合键归一化、展示名称生成及事件匹配函数。
 * 模块边界：本文件属于 core 纯配置算法层，只依赖 core/hotkey 的解析与匹配能力，不访问浏览器 API、不读写配置存储、不注册全局监听或挂载界面。
 */
import {canonicalizeHotkey, matchesHotkey, parseHotkey} from '@/src/core/hotkey';

/** 默认开启全局命令面板，方便通过键盘快速触达核心翻译与学习功能。 */
export const DEFAULT_COMMAND_PALETTE_ENABLED = true;

/**
 * 全局命令面板默认组合键：刻意选用 Alt+K 而非 Cmd/Ctrl+K，
 * 避免劫持 GitHub、Notion、Slack、Linear 等网页应用自带的快速跳转面板。
 */
export const DEFAULT_COMMAND_PALETTE_HOTKEY = 'Alt+K';

/** 设置页提供的预设快捷键；界面另附“自定义快捷键”入口，对应 custom 取值。 */
export const COMMAND_PALETTE_HOTKEY_OPTIONS: readonly {value: string; label: string}[] = [
    {value: 'Alt+K', label: 'Alt+K / Option+K'},
    {value: 'Alt+P', label: 'Alt+P / Option+P'},
    {value: 'Ctrl+Shift+K', label: 'Ctrl+Shift+K / Control+Shift+K'},
    {value: 'Ctrl+Alt+K', label: 'Ctrl+Alt+K / Control+Option+K'},
    {value: 'Shift+Alt+K', label: 'Shift+Alt+K / Shift+Option+K'},
];

const PRESET_HOTKEYS: readonly string[] = COMMAND_PALETTE_HOTKEY_OPTIONS.map((option) => option.value);

/** 开关缺失或非布尔值时默认开启；只有显式 false 才关闭。 */
export function normalizeCommandPaletteEnabled(value: unknown): boolean {
    return typeof value === 'boolean' ? value : DEFAULT_COMMAND_PALETTE_ENABLED;
}

/** 预设选择只接受列表内的组合键或 custom，非法值回退默认值 Alt+K。 */
export function normalizeCommandPaletteHotkey(value: unknown): string {
    if (value === 'custom') return 'custom';
    if (typeof value !== 'string') return DEFAULT_COMMAND_PALETTE_HOTKEY;
    const canonical = canonicalizeHotkey(value);
    const preset = PRESET_HOTKEYS.find((hotkey) => hotkey.toLocaleLowerCase() === canonical.toLocaleLowerCase());
    return preset ?? DEFAULT_COMMAND_PALETTE_HOTKEY;
}

/** 自定义组合键统一保存为平台无关规范格式；无法解析时留空交由预设兜底。 */
export function normalizeCustomCommandPaletteHotkey(value: unknown): string {
    return typeof value === 'string' ? canonicalizeHotkey(value) : '';
}

/** 返回运行时实际监听的组合键；选择自定义但尚未录制有效组合时回退默认值。 */
export function resolveCommandPaletteHotkey(hotkey: unknown, customHotkey: unknown): string {
    const choice = normalizeCommandPaletteHotkey(hotkey);
    if (choice !== 'custom') return choice;
    return normalizeCustomCommandPaletteHotkey(customHotkey) || DEFAULT_COMMAND_PALETTE_HOTKEY;
}

/** 生成界面展示用的快捷键名称，在 macOS 上自动呈现 Option/Control 习惯写法。 */
export function commandPaletteHotkeyDisplayName(hotkey: unknown, customHotkey: unknown): string {
    return parseHotkey(resolveCommandPaletteHotkey(hotkey, customHotkey)).displayName;
}

/** 判断键盘事件是否命中已配置的全局命令面板快捷键；修饰键必须完全一致。 */
export function matchesCommandPaletteHotkey(event: KeyboardEvent, hotkey: unknown, customHotkey: unknown): boolean {
    return matchesHotkey(event, parseHotkey(resolveCommandPaletteHotkey(hotkey, customHotkey)));
}

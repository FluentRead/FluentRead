/**
 * @file src/app/background/contextMenuPreferences.ts
 * 文件职责：把共享配置和浏览器能力读成右键菜单需要的一份快照，决定哪些入口可用、菜单标题带什么信息。
 * 主要内容：从同一配置来源合并总开关、各入口偏好、工具栏面板入口、功能可用性和界面语言，签名只包含实际影响结构或动作标题的字段；保留旧附加信息字段的读取兼容。
 * 模块边界：本文件只读配置，不创建菜单、不发送消息、不渲染标题；结构推导属于 core/context-menu，菜单生命周期属于 contextMenuRuntime。
 */
import {
    resolveContextMenuEntryToggles,
    type ContextMenuDisplayOptions,
    type ContextMenuEntryToggles,
} from '@/src/core/context-menu/domain';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {config} from '@/src/services/config/store';
import {imageMenuEnabled} from './imageContextMenu';
import {type ContextMenuTitleContext} from '@/src/core/context-menu/presentation';
import {normalizeUiLanguage} from '@/src/core/i18n';

export interface ContextMenuSettingsSnapshot {
    /** 扩展总开关或网页右键菜单开关关闭时，不创建网页菜单入口。 */
    readonly enabled: boolean;
    /** 工具栏的一键翻译启用时，独立保留打开面板入口，不受网页右键菜单开关影响。 */
    readonly toolbarQuickPanel: boolean;
    readonly toggles: ContextMenuEntryToggles;
    readonly display: ContextMenuDisplayOptions;
    readonly titleContext: ContextMenuTitleContext;
    /** 结构与文案的组合签名；只有它变化时才需要重建菜单。 */
    readonly signature: string;
}

type ContextMenuConfigSource = typeof config;

/** 读取当前配置下右键菜单应有的样子；调用方只比较 signature，不需要逐字段比对。 */
export function readContextMenuSettings(source: ContextMenuConfigSource = config): ContextMenuSettingsSnapshot {
    const pluginOn = source.on !== false;
    const language = normalizeUiLanguage(source.uiLanguage);
    const toggles = resolveContextMenuEntryToggles(source.contextMenuEntries, {
        selectionTranslation: pluginOn && source.selectionTranslatorMode !== 'disabled' && source.disableSelectionTranslator !== true,
        imageTranslation: imageMenuEnabled(source),
        areaTranslation: pluginOn && browserCapabilities.areaTranslation && source.selectionAreaEnabled === true,
    });
    const display: ContextMenuDisplayOptions = {
        showTargetLanguage: source.contextMenuShowTargetLanguage !== false,
        showShortcut: source.contextMenuShowShortcut !== false,
    };
    const titleContext: ContextMenuTitleContext = {
        language,
        targetLanguage: '',
        shortcut: '',
    };
    const enabled = pluginOn && source.contextMenuEnabled !== false;
    const toolbarQuickPanel = source.toolbarClickAction === 'translate';
    return {
        enabled,
        toolbarQuickPanel,
        toggles,
        display,
        titleContext,
        signature: JSON.stringify([enabled, toggles, language, toolbarQuickPanel]),
    };
}

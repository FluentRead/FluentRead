/**
 * @file src/core/config/clickSelection.ts
 * 文件职责：定义两点选取的显式开关、单次启动快捷键及与其他阅读动作的冲突规则。
 * 主要内容：规范化带修饰键的组合键，按全局与划词开关判断入口可用性，复用既有快捷键解析及方案冲突检查；只在匹配启动键后检查其他动作占用，并向设置入口提供不随全局暂停释放的点选保留键。
 * 模块边界：这里只读取传入配置并比较键盘事件，不订阅配置、不绑定事件、不选取网页文字，也不持久化用户偏好。
 */
import {canonicalizeHotkey, matchesHotkey, parseHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey';
import {resolveAreaTranslationHotkey} from './areaTranslation';
import {resolveParagraphCopyHotkey} from './paragraphCopy';
import {resolveSectionTranslationHotkey} from './sectionTranslation';
import {findEnabledQuickTranslationHotkeyConflict, inputBoxTranslationTriggerHotkey, type QuickTranslationProfile} from './quickTranslation';

export const DEFAULT_CLICK_SELECTION_HOTKEY = 'Alt+Shift+S';

interface ClickSelectionConfig {
    on?: boolean;
    selectionTranslatorMode?: string;
    disableSelectionTranslator?: boolean;
    selectionClickSelectEnabled?: boolean;
    selectionClickSelectHotkey?: string;
    hotkey?: string;
    customHotkey?: string;
    floatingBallHotkey?: string;
    customFloatingBallHotkey?: string;
    selectionTranslatorTrigger?: string;
    customSelectionTranslatorHotkey?: string;
    selectionAreaEnabled?: boolean;
    selectionAreaHotkey?: string;
    customSelectionAreaHotkey?: string;
    paragraphCopyEnabled?: boolean;
    paragraphCopyHotkey?: string;
    customParagraphCopyHotkey?: string;
    sectionTranslationHotkeyEnabled?: boolean;
    sectionTranslationHotkey?: string;
    customSectionTranslationHotkey?: string;
    inputBoxTranslationTrigger?: string;
    customInputBoxTranslationHotkey?: string;
    quickTranslationProfiles?: readonly QuickTranslationProfile[];
    informationHighlight?: {hotkeyEnabled?: boolean; hotkey?: string};
}

/** 不接受单键或仅修饰键，避免正常输入或临时按住 Control 时进入点选模式。 */
export function normalizeClickSelectionHotkey(value: unknown): string {
    if (typeof value !== 'string') return DEFAULT_CLICK_SELECTION_HOTKEY;
    const parsed = parseHotkey(value);
    return parsed.isValid && parsed.modifiers.length > 0 && !parsed.modifiers.includes('meta')
        ? canonicalizeHotkey(value) : DEFAULT_CLICK_SELECTION_HOTKEY;
}

export function isClickSelectionAvailable(config: ClickSelectionConfig): boolean {
    return config.on === true && config.selectionClickSelectEnabled === true
        && config.selectionTranslatorMode !== 'disabled' && config.disableSelectionTranslator !== true;
}

/** 设置页保留已启用点选的按键；全局暂停不清除偏好，划词停用则不占用。 */
export function resolveReservedClickSelectionHotkey(config: ClickSelectionConfig): string {
    return config.selectionClickSelectEnabled === true && config.selectionTranslatorMode !== 'disabled'
        && config.disableSelectionTranslator !== true ? normalizeClickSelectionHotkey(config.selectionClickSelectHotkey) : '';
}

/** 返回已占用此组合的功能名称；配置导入或另一入口后续改键也不能让一次按键触发两个动作。 */
export function findClickSelectionHotkeyConflict(config: ClickSelectionConfig, hotkey: string): string {
    const identity = normalizeClickSelectionHotkey(hotkey).toLowerCase();
    const owners = [
        {hotkey: resolveConfiguredHotkey(config.hotkey, config.customHotkey), feature: '鼠标悬停翻译'},
        {hotkey: resolveConfiguredHotkey(config.floatingBallHotkey, config.customFloatingBallHotkey), feature: '全文翻译'},
        {hotkey: config.selectionTranslatorMode === 'disabled' || config.disableSelectionTranslator === true ? ''
            : resolveConfiguredHotkey(config.selectionTranslatorTrigger, config.customSelectionTranslatorHotkey), feature: '划词翻译'},
        {hotkey: config.selectionAreaEnabled ? resolveAreaTranslationHotkey(config.selectionAreaHotkey, config.customSelectionAreaHotkey) : '', feature: '圈选翻译'},
        {hotkey: config.paragraphCopyEnabled ? resolveParagraphCopyHotkey(config.paragraphCopyHotkey, config.customParagraphCopyHotkey) : '', feature: '段落复制'},
        {hotkey: config.sectionTranslationHotkeyEnabled ? resolveSectionTranslationHotkey(config.sectionTranslationHotkey, config.customSectionTranslationHotkey) : '', feature: '局部翻译'},
        {hotkey: inputBoxTranslationTriggerHotkey(config.inputBoxTranslationTrigger, config.customInputBoxTranslationHotkey), feature: '输入框翻译'},
        {hotkey: config.informationHighlight?.hotkeyEnabled === true ? config.informationHighlight.hotkey ?? '' : '', feature: '智能高亮'},
    ];
    const owner = owners.find(item => canonicalizeHotkey(item.hotkey).toLowerCase() === identity);
    if (owner) return owner.feature;
    return findEnabledQuickTranslationHotkeyConflict(config.quickTranslationProfiles ?? [], hotkey) ? '额外翻译方案' : '';
}

export function matchesClickSelectionShortcut(event: KeyboardEvent, config: ClickSelectionConfig): boolean {
    if (!isClickSelectionAvailable(config)) return false;
    const hotkey = normalizeClickSelectionHotkey(config.selectionClickSelectHotkey);
    return matchesHotkey(event, parseHotkey(hotkey)) && !findClickSelectionHotkeyConflict(config, hotkey);
}

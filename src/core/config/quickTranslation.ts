/**
 * @file src/core/config/quickTranslation.ts
 * 文件职责：定义多快捷翻译方案的持久化结构、数量边界与纯归一化规则。
 * 主要内容：约束悬停、全文与局部容器动作、独立服务模型、目标语言及中文简繁别名、显示方式和全文范围，并为 UI 生成稳定方案 ID 与动作文案键。
 * 模块边界：本文件不监听键盘鼠标、不读取浏览器存储、不执行翻译；运行时路由和设置界面分别由 feature 与 settings 层负责。
 */
import {normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {canonicalizeHotkey} from '@/src/core/hotkey';
import {MAX_CUSTOM_OPENAI_MODEL_LENGTH} from '@/src/core/config/customOpenAI';
import {normalizeCustomInputBoxTranslationHotkey} from '@/src/core/config/inputTranslation';
import {normalizeGlossaryIds, type GlossaryLibrary} from '@/src/core/glossary';

/** 每种动作可保存的快捷翻译方案上限；悬浮、全文与局部分别计数。 */
export const MAX_QUICK_TRANSLATION_PROFILES = 8;
export const MAX_QUICK_TRANSLATION_MODEL_LENGTH = MAX_CUSTOM_OPENAI_MODEL_LENGTH;
export const INPUT_BOX_TRANSLATION_TRIGGER_HOTKEYS: Readonly<Record<string, string>> = {
    ctrl_enter: 'Ctrl+Enter',
    triple_space: 'Space',
    triple_equal: '=',
    triple_dash: '-',
};

export type QuickTranslationAction = 'hover' | 'full-page' | 'section';

/** 设置、Popup 与冲突提示共用同一动作文案口径。 */
export function quickTranslationActionKey(action: QuickTranslationAction): 'hover' | 'fullPage' | 'section' {
    return action === 'full-page' ? 'fullPage' : action;
}
export type QuickTranslationDisplayMode = 'inherit' | 'bilingual' | 'translation-only';
export type QuickTranslationFullPageMode = 'inherit' | 'viewport' | 'all';

export interface QuickTranslationProfile {
    id: string;
    enabled: boolean;
    action: QuickTranslationAction;
    /** 规范化后的组合键；空值表示尚未完成设置，运行时不会接管按键。 */
    hotkey: string;
    /** 空值表示跟随默认网页翻译服务。 */
    service: string;
    /** 空值表示跟随所选服务当前模型。 */
    model: string;
    /** 空值表示跟随默认目标语言。 */
    targetLanguage: string;
    displayMode: QuickTranslationDisplayMode;
    /** 只对全文方案生效。 */
    fullPageMode: QuickTranslationFullPageMode;
    /** null / 缺省跟随全局；空数组停用本方案术语；显式 ID 仍遵守词库范围。 */
    glossaryIds?: string[] | null;
}

export interface QuickTranslationNormalizationContext {
    isSupportedService: (service: string) => boolean;
    serviceUsesModel: (service: string) => boolean;
    reservedHotkeys?: readonly string[];
    glossaryLibraries?: readonly Pick<GlossaryLibrary, 'id'>[];
}

/** 返回会被输入框翻译消费的快捷键或首个按键，用于配置和设置 UI 的双向冲突保护。 */
export function inputBoxTranslationTriggerHotkey(trigger: unknown, customHotkey?: unknown): string {
    if (trigger === 'custom') return normalizeCustomInputBoxTranslationHotkey(customHotkey);
    return typeof trigger === 'string' ? INPUT_BOX_TRANSLATION_TRIGGER_HOTKEYS[trigger] ?? '' : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedId(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/[^a-zA-Z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48);
}

function normalizedString(value: unknown, maximumLength: number): string {
    return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

export function createQuickTranslationProfileId(
    profiles: readonly Pick<QuickTranslationProfile, 'id'>[],
): string {
    const existing = new Set(profiles.map((profile) => profile.id));
    let suffix = 1;
    while (existing.has(`quick-${suffix}`)) suffix += 1;
    return `quick-${suffix}`;
}

export function createQuickTranslationProfile(
    action: QuickTranslationAction,
    profiles: readonly Pick<QuickTranslationProfile, 'id'>[] = [],
): QuickTranslationProfile {
    return {
        id: createQuickTranslationProfileId(profiles),
        enabled: false,
        action,
        hotkey: '',
        service: '',
        model: '',
        targetLanguage: '',
        displayMode: 'inherit',
        fullPageMode: 'inherit',
    };
}

/**
 * 导入/存储边界只保留有限、可执行且无重复热键的方案。重复项保留为待编辑空热键，
 * 避免一次损坏的备份同时接管同一个键，也不丢掉其余服务与展示偏好。
 */
export function normalizeQuickTranslationProfiles(
    value: unknown,
    context: QuickTranslationNormalizationContext,
): QuickTranslationProfile[] {
    if (!Array.isArray(value)) return [];

    const result: QuickTranslationProfile[] = [];
    const actionCounts: Record<QuickTranslationAction, number> = {
        hover: 0,
        'full-page': 0,
        section: 0,
    };
    const ids = new Set<string>();
    const hotkeys = new Set<string>();
    const reservedHotkeys = new Set((context.reservedHotkeys || [])
        .map((hotkey) => canonicalizeHotkey(hotkey).toLocaleLowerCase()).filter(Boolean));
    for (const candidate of value) {
        if (!isRecord(candidate)) continue;
        if (candidate.action !== 'hover' && candidate.action !== 'full-page' && candidate.action !== 'section') continue;
        if (actionCounts[candidate.action] >= MAX_QUICK_TRANSLATION_PROFILES) continue;
        actionCounts[candidate.action] += 1;

        let id = normalizedId(candidate.id);
        if (!id || ids.has(id)) id = createQuickTranslationProfileId(result);
        ids.add(id);

        let hotkey = canonicalizeHotkey(normalizedString(candidate.hotkey, 80));
        const hotkeyIdentity = hotkey.toLocaleLowerCase();
        if (hotkeyIdentity && hotkeys.has(hotkeyIdentity)) hotkey = '';
        if (hotkey) hotkeys.add(hotkeyIdentity);

        const requestedService = normalizedString(candidate.service, 128);
        const service = requestedService && context.isSupportedService(requestedService)
            ? requestedService
            : '';
        const model = service && context.serviceUsesModel(service)
            ? normalizedString(candidate.model, MAX_QUICK_TRANSLATION_MODEL_LENGTH)
            : '';
        const displayMode: QuickTranslationDisplayMode = candidate.displayMode === 'bilingual'
            || candidate.displayMode === 'translation-only'
            ? candidate.displayMode
            : 'inherit';
        const fullPageMode = candidate.action === 'full-page'
            && (candidate.fullPageMode === 'viewport' || candidate.fullPageMode === 'all')
            ? candidate.fullPageMode
            : 'inherit';

        result.push({
            id,
            enabled: candidate.enabled === true && Boolean(hotkey)
                && (!requestedService || Boolean(service)) && !reservedHotkeys.has(hotkeyIdentity),
            action: candidate.action,
            hotkey,
            service,
            model,
            targetLanguage: normalizeChineseLanguageCode(normalizedString(candidate.targetLanguage, 32)),
            displayMode,
            fullPageMode,
            ...(candidate.glossaryIds !== undefined
                ? {glossaryIds: normalizeGlossaryIds(candidate.glossaryIds, context.glossaryLibraries)}
                : {}),
        });
    }
    return result;
}

export function enabledQuickTranslationProfiles(
    profiles: readonly QuickTranslationProfile[],
    action?: QuickTranslationAction,
): QuickTranslationProfile[] {
    return profiles.filter((profile) => profile.enabled && Boolean(profile.hotkey)
        && (!action || profile.action === action));
}

/** 查找当前已启用、会与旧入口争用同一个组合键的快捷翻译方案。 */
export function findEnabledQuickTranslationHotkeyConflict(
    profiles: readonly QuickTranslationProfile[],
    hotkey: string,
): QuickTranslationProfile | undefined {
    const identity = canonicalizeHotkey(hotkey).toLocaleLowerCase();
    if (!identity) return undefined;
    return profiles.find((profile) => profile.enabled
        && canonicalizeHotkey(profile.hotkey).toLocaleLowerCase() === identity);
}

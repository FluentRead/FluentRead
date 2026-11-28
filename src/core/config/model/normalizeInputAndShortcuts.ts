/**
 * @file src/core/config/model/normalizeInputAndShortcuts.ts
 *
 * 文件职责：规范化输入框翻译、鼠标悬停、悬浮球、划词与词典朗读、单词本与个人校订、圈选/段落复制/局部翻译、右键菜单及快捷翻译方案配置。
 * 主要内容：提供 normalizeInputAndShortcutsConfig，收敛旧版划词触发与快捷键状态、补齐悬浮球和输入框安全边界，并基于保留热键集合清洗 quickTranslationProfiles。
 * 模块边界：仅由 normalizeConfig.ts 在供应商、术语库和视频快捷键归一完成后调用，不注册键盘事件或访问浏览器存储。
 */

import {
    DEFAULT_AREA_TRANSLATION_HOTKEY,
    normalizeAreaTranslationHotkey,
    normalizeCustomAreaTranslationHotkey,
    resolveAreaTranslationHotkey,
} from '../areaTranslation';
import {options} from '../catalog/options';
import {defaultOption} from '../catalog/prompts';
import {servicesType} from '../catalog/serviceTypes';
import {normalizeClickSelectionHotkey} from '../clickSelection';
import {isCustomOpenAIProviderId} from '../customOpenAI';
import {dictionaryId, normalizeDictionaryWorkspace} from '../dictionaryWorkspace';
import {
    normalizeCustomInputBoxTranslationHotkey,
    normalizeInputBoxTranslationInterval,
    normalizeInputBoxTranslationModel,
    normalizeInputBoxTranslationOutputMode,
    normalizeInputBoxTranslationPrompt,
    normalizeInputBoxTranslationService,
} from '../inputTranslation';
import {normalizeLocalTtsMode, normalizeLocalTtsVoice} from '../localTts';
import {
    DEFAULT_PARAGRAPH_COPY_HOTKEY,
    normalizeCustomParagraphCopyHotkey,
    normalizeParagraphCopyContentMode,
    normalizeParagraphCopyHotkey,
    resolveParagraphCopyHotkey,
} from '../paragraphCopy';
import {inputBoxTranslationTriggerHotkey, normalizeQuickTranslationProfiles} from '../quickTranslation';
import {
    DEFAULT_SECTION_TRANSLATION_HOTKEY,
    normalizeCustomSectionTranslationHotkey,
    normalizeSectionTranslationHotkey,
    resolveSectionTranslationHotkey,
} from '../sectionTranslation';
import {normalizeSectionTranslationRules} from '../sectionTranslationRules';
import {normalizeWordDictionarySource} from '../selectionDictionary';
import {
    normalizeSelectionTtsOnlineSources,
    normalizeSelectionTtsOpenAiModel,
    normalizeSelectionTtsOpenAiVoice,
    normalizeSelectionTtsRate,
    normalizeSelectionTtsVoiceOrder,
} from '../selectionTts';
import {
    DEFAULT_COMMAND_PALETTE_HOTKEY,
    normalizeCommandPaletteEnabled,
    normalizeCommandPaletteHotkey,
    normalizeCustomCommandPaletteHotkey,
    resolveCommandPaletteHotkey,
} from '../commandPalette';
import {resolveReservedVideoSubtitleModeHotkey} from '../videoSubtitleShortcut';
import {resolveWritingHotkey} from '../writing';
import {normalizeContextMenuEntryPreferences} from '@/src/core/context-menu/domain';
import {resolveConfiguredHotkey} from '@/src/core/hotkey';
import {normalizeFloatingBallDisabledDomains} from '@/src/core/site-rules/domain';
import type {Config} from './configClass';
import {
    DEFAULT_FLOATING_BALL_DEFAULT_MARGIN,
    DEFAULT_FLOATING_BALL_POPOUT_MARGIN,
    normalizeFloatingBallClickAction,
    normalizeFloatingBallCollapsedOpacity,
    normalizeFloatingBallHoverDelay,
    normalizeFloatingBallMargin,
    normalizeFloatingBallToolsDisplay,
    normalizeFloatingBallVerticalPosition,
    normalizeMouseHoverTranslationDelay,
    normalizeSelectionTranslatorDelay,
} from './interactionDefaults';
import {normalizeConfigLanguage} from './normalizeAppearanceAndReading';
import {isSupportedTranslationService} from './providerNormalization';

const SELECTION_TRIGGER_VALUES = ['direct', 'icon', 'dot', 'hover', 'contextMenu', 'Control', 'Alt', 'Shift', 'custom'];
const SELECTION_SHORTCUT_VALUES = ['Control', 'Alt', 'Shift', 'custom'];

function normalizeInputBoxAndFloatingBall(normalized: Config, source: Partial<Config>): void {
    normalized.customInputBoxTranslationHotkey = normalizeCustomInputBoxTranslationHotkey(
        source.customInputBoxTranslationHotkey,
    );
    if (normalized.inputBoxTranslationTrigger === 'custom' && !normalized.customInputBoxTranslationHotkey) {
        normalized.inputBoxTranslationTrigger = 'disabled';
    }
    normalized.inputBoxTranslationTarget = normalizeConfigLanguage(source.inputBoxTranslationTarget)
        || defaultOption.inputBoxTranslationTarget;
    normalized.inputBoxTranslationOutputMode = normalizeInputBoxTranslationOutputMode(source.inputBoxTranslationOutputMode);
    normalized.inputBoxTranslationInterval = normalizeInputBoxTranslationInterval(source.inputBoxTranslationInterval);
    normalized.inputBoxTranslationModel = normalizeInputBoxTranslationModel(source.inputBoxTranslationModel);
    normalized.inputBoxTranslationPrompt = normalizeInputBoxTranslationPrompt(source.inputBoxTranslationPrompt);
    normalized.inputBoxTranslationSystemPrompt = normalizeInputBoxTranslationPrompt(source.inputBoxTranslationSystemPrompt);
    normalized.inputBoxTranslationService = normalizeInputBoxTranslationService(
        source.inputBoxTranslationService,
        normalized.customOpenAIProviders,
        normalized.compositeTranslationProviders,
    );

    const enabledHoverChoices = options.keys
        .filter(item => !('disabled' in item && item.disabled) && item.value !== 'none')
        .map(item => item.value);
    normalized.hoverShortcutBeforeDisable = enabledHoverChoices.includes(normalized.hotkey)
        ? normalized.hotkey
        : enabledHoverChoices.includes(source.hoverShortcutBeforeDisable ?? '')
            ? source.hoverShortcutBeforeDisable!
            : defaultOption.hotkey;
    normalized.mouseHoverTranslationDelay = normalizeMouseHoverTranslationDelay(source.mouseHoverTranslationDelay);
    normalized.floatingBallToolsDisplay = normalizeFloatingBallToolsDisplay(source.floatingBallToolsDisplay);
    normalized.floatingBallVerticalPosition = normalizeFloatingBallVerticalPosition(source.floatingBallVerticalPosition);
    normalized.floatingBallHoverDelay = normalizeFloatingBallHoverDelay(source.floatingBallHoverDelay);
    normalized.floatingBallClickAction = normalizeFloatingBallClickAction(source.floatingBallClickAction);
    normalized.floatingBallCompact = source.floatingBallCompact === true;
    normalized.floatingBallSettingsEntryVisible = source.floatingBallSettingsEntryVisible !== false;
    normalized.floatingBallCollapsedOpacity = normalizeFloatingBallCollapsedOpacity(source.floatingBallCollapsedOpacity);
    normalized.floatingBallDefaultMargin = normalizeFloatingBallMargin(
        source.floatingBallDefaultMargin,
        DEFAULT_FLOATING_BALL_DEFAULT_MARGIN,
    );
    normalized.floatingBallPopoutMargin = normalizeFloatingBallMargin(
        source.floatingBallPopoutMargin,
        DEFAULT_FLOATING_BALL_POPOUT_MARGIN,
    );
    normalized.floatingBallDisabledDomains = normalizeFloatingBallDisabledDomains(source.floatingBallDisabledDomains);
}

function normalizeSelectionAndTts(normalized: Config, source: Partial<Config>): void {
    if (!['disabled', 'bilingual', 'translation-only'].includes(normalized.selectionTranslatorMode)) {
        normalized.selectionTranslatorMode = 'disabled';
    }
    // 仅旧版本缺失呈现字段时迁移；关闭统一开关后，学习偏好不能再次把功能打开。
    const legacySelection = source.selectionTranslatorPresentation === undefined;
    normalized.selectionTranslatorPresentation = 'card';
    if (legacySelection && normalized.harness.enabled && normalized.selectionTranslatorMode === 'disabled') {
        normalized.selectionTranslatorMode = 'bilingual';
        normalized.selectionTranslatorTrigger = normalized.harness.trigger === 'shortcut' ? 'custom'
            : normalized.harness.trigger === 'hover' ? 'hover' : 'icon';
        if (normalized.harness.trigger === 'shortcut') normalized.customSelectionTranslatorHotkey = normalized.harness.customHotkey;
    }
    const hasExplicitSelectionTrigger = typeof source.selectionTranslatorTrigger === 'string'
        && SELECTION_TRIGGER_VALUES.includes(source.selectionTranslatorTrigger);
    if (!SELECTION_TRIGGER_VALUES.includes(normalized.selectionTranslatorTrigger)) {
        normalized.selectionTranslatorTrigger = 'icon';
    }
    if (!['none', 'Control', 'Alt', 'Shift', 'custom'].includes(normalized.selectionTranslatorHotkey)) {
        normalized.selectionTranslatorHotkey = 'none';
    }
    if (typeof normalized.customSelectionTranslatorHotkey !== 'string') {
        normalized.customSelectionTranslatorHotkey = '';
    }
    normalized.selectionClickSelectEnabled = source.selectionClickSelectEnabled === true;
    normalized.selectionClickSelectHotkey = normalizeClickSelectionHotkey(source.selectionClickSelectHotkey);
    normalized.selectionTranslatorDelay = normalizeSelectionTranslatorDelay(source.selectionTranslatorDelay);
    normalized.selectionTranslatorBidirectional = source.selectionTranslatorBidirectional === true;
    normalized.selectionDictionarySource = normalizeWordDictionarySource(source.selectionDictionarySource);
    if (import.meta.env?.BROWSER !== 'userscript') {
        normalized.selectionDictionaryWorkspace = normalizeDictionaryWorkspace(source.selectionDictionaryWorkspace);
        const recipe = dictionaryId(source.selectionDictionaryRecipe);
        normalized.selectionDictionaryRecipe = normalized.selectionDictionaryWorkspace.recipes.some(item => item.id === recipe)
            ? recipe
            : '';
    }
    normalized.selectionTranslatorAutoDismiss = typeof source.selectionTranslatorAutoDismiss === 'boolean'
        ? source.selectionTranslatorAutoDismiss
        : true;
    // 兼容上一版“触发方式 + 可选快捷键”配置，并将最终状态收敛为单一触发方式。
    if (!hasExplicitSelectionTrigger
        && ['direct', 'icon', 'dot'].includes(normalized.selectionTranslatorTrigger)
        && normalized.selectionTranslatorHotkey !== 'none') {
        normalized.selectionTranslatorTrigger = normalized.selectionTranslatorHotkey;
    }
    if (SELECTION_SHORTCUT_VALUES.includes(normalized.selectionTranslatorTrigger)) {
        if (normalized.selectionTranslatorTrigger === 'custom'
            && (!normalized.customSelectionTranslatorHotkey.trim() || normalized.customSelectionTranslatorHotkey === 'none')) {
            normalized.selectionTranslatorTrigger = 'icon';
            normalized.selectionTranslatorHotkey = 'none';
        } else {
            normalized.selectionTranslatorHotkey = normalized.selectionTranslatorTrigger;
        }
    } else {
        normalized.selectionTranslatorHotkey = 'none';
    }
    normalized.selectionTtsVoices = normalizeSelectionTtsVoiceOrder(normalized.selectionTtsVoices);
    normalized.selectionTtsMode = normalizeLocalTtsMode(source.selectionTtsMode);
    normalized.selectionTtsLocalVoice = normalizeLocalTtsVoice(source.selectionTtsLocalVoice);
    normalized.selectionTtsRate = normalizeSelectionTtsRate(source.selectionTtsRate);
    normalized.selectionTtsOnlineSources = normalizeSelectionTtsOnlineSources(source.selectionTtsOnlineSources);
    normalized.selectionTtsOpenAiModel = normalizeSelectionTtsOpenAiModel(source.selectionTtsOpenAiModel);
    normalized.selectionTtsOpenAiVoice = normalizeSelectionTtsOpenAiVoice(source.selectionTtsOpenAiVoice);
    normalized.disableSelectionTranslator = normalized.selectionTranslatorMode === 'disabled';
    normalized.selectionTranslatorModeBeforeDisable = normalized.selectionTranslatorMode === 'translation-only'
        || (normalized.selectionTranslatorMode === 'disabled' && source.selectionTranslatorModeBeforeDisable === 'translation-only')
        ? 'translation-only'
        : 'bilingual';
    if (typeof normalized.vocabularyBookEnabled !== 'boolean') {
        normalized.vocabularyBookEnabled = false;
    }
    if (typeof normalized.vocabularyReencounterEnabled !== 'boolean') normalized.vocabularyReencounterEnabled = false;
    if (import.meta.env?.BROWSER !== 'userscript') normalized.personalCorrectionsEnabled = source.personalCorrectionsEnabled === true;
    else delete (normalized as Partial<Config>).personalCorrectionsEnabled;
}

function normalizeToolsAndQuickProfiles(normalized: Config, source: Partial<Config>): void {
    if (typeof normalized.selectionAreaEnabled !== 'boolean') {
        normalized.selectionAreaEnabled = true;
    }
    normalized.customSelectionAreaHotkey = normalizeCustomAreaTranslationHotkey(source.customSelectionAreaHotkey);
    normalized.selectionAreaHotkey = normalizeAreaTranslationHotkey(source.selectionAreaHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，圈选翻译不会失去唯一入口。
    if (normalized.selectionAreaHotkey === 'custom' && !normalized.customSelectionAreaHotkey) {
        normalized.selectionAreaHotkey = DEFAULT_AREA_TRANSLATION_HOTKEY;
    }
    if (typeof normalized.paragraphCopyEnabled !== 'boolean') {
        normalized.paragraphCopyEnabled = false;
    }
    normalized.customParagraphCopyHotkey = normalizeCustomParagraphCopyHotkey(source.customParagraphCopyHotkey);
    normalized.paragraphCopyHotkey = normalizeParagraphCopyHotkey(source.paragraphCopyHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，段落复制不会失去唯一入口。
    if (normalized.paragraphCopyHotkey === 'custom' && !normalized.customParagraphCopyHotkey) {
        normalized.paragraphCopyHotkey = DEFAULT_PARAGRAPH_COPY_HOTKEY;
    }
    normalized.paragraphCopyContent = normalizeParagraphCopyContentMode(source.paragraphCopyContent);
    if (typeof normalized.sectionTranslationHotkeyEnabled !== 'boolean') {
        normalized.sectionTranslationHotkeyEnabled = false;
    }
    normalized.sectionTranslationRules = normalizeSectionTranslationRules(source.sectionTranslationRules);
    normalized.customSectionTranslationHotkey = normalizeCustomSectionTranslationHotkey(source.customSectionTranslationHotkey);
    normalized.sectionTranslationHotkey = normalizeSectionTranslationHotkey(source.sectionTranslationHotkey);
    // 选择自定义却没有可用组合键时回到预设默认值，开启的快捷键不会失去可用组合。
    if (normalized.sectionTranslationHotkey === 'custom' && !normalized.customSectionTranslationHotkey) {
        normalized.sectionTranslationHotkey = DEFAULT_SECTION_TRANSLATION_HOTKEY;
    }
    normalized.commandPaletteEnabled = normalizeCommandPaletteEnabled(source.commandPaletteEnabled);
    normalized.customCommandPaletteHotkey = normalizeCustomCommandPaletteHotkey(source.customCommandPaletteHotkey);
    normalized.commandPaletteHotkey = normalizeCommandPaletteHotkey(source.commandPaletteHotkey);
    if (normalized.commandPaletteHotkey === 'custom' && !normalized.customCommandPaletteHotkey) {
        normalized.commandPaletteHotkey = DEFAULT_COMMAND_PALETTE_HOTKEY;
    }
    if (typeof normalized.contextMenuEnabled !== 'boolean') {
        normalized.contextMenuEnabled = true;
    }
    normalized.contextMenuEntries = normalizeContextMenuEntryPreferences(source.contextMenuEntries);
    normalized.contextMenuShowTargetLanguage = normalized.contextMenuShowTargetLanguage !== false;
    normalized.contextMenuShowShortcut = normalized.contextMenuShowShortcut !== false;
    const reservedVideoSubtitleModeHotkey = resolveReservedVideoSubtitleModeHotkey(normalized);
    normalized.quickTranslationProfiles = normalizeQuickTranslationProfiles(
        source.quickTranslationProfiles,
        {
            isSupportedService: (service) => isSupportedTranslationService(
                service,
                normalized.customOpenAIProviders,
                normalized.compositeTranslationProviders,
            ),
            serviceUsesModel: (service) => isCustomOpenAIProviderId(service)
                || servicesType.isUseModel(service),
            glossaryLibraries: normalized.glossaryLibraries,
            reservedHotkeys: [
                resolveConfiguredHotkey(normalized.hotkey, normalized.customHotkey),
                resolveConfiguredHotkey(normalized.floatingBallHotkey, normalized.customFloatingBallHotkey),
                ...(normalized.selectionAreaEnabled
                    ? [resolveAreaTranslationHotkey(normalized.selectionAreaHotkey, normalized.customSelectionAreaHotkey)]
                    : []),
                ...(normalized.paragraphCopyEnabled
                    ? [resolveParagraphCopyHotkey(normalized.paragraphCopyHotkey, normalized.customParagraphCopyHotkey)]
                    : []),
                ...(normalized.sectionTranslationHotkeyEnabled
                    ? [resolveSectionTranslationHotkey(normalized.sectionTranslationHotkey, normalized.customSectionTranslationHotkey)]
                    : []),
                ...(reservedVideoSubtitleModeHotkey ? [reservedVideoSubtitleModeHotkey] : []),
                ...(resolveWritingHotkey(normalized.writing)
                    ? [resolveWritingHotkey(normalized.writing)]
                    : []),
                ...(normalized.commandPaletteEnabled
                    ? [resolveCommandPaletteHotkey(normalized.commandPaletteHotkey, normalized.customCommandPaletteHotkey)]
                    : []),
                inputBoxTranslationTriggerHotkey(
                    normalized.inputBoxTranslationTrigger,
                    normalized.customInputBoxTranslationHotkey,
                ),
            ],
        },
    );
}

export function normalizeInputAndShortcutsConfig(normalized: Config, source: Partial<Config>): void {
    normalizeInputBoxAndFloatingBall(normalized, source);
    normalizeSelectionAndTts(normalized, source);
    normalizeToolsAndQuickProfiles(normalized, source);
}

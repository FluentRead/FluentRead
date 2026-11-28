/**
 * @file src/core/config/scenarioPresets.ts
 * 文件职责：定义面向不同阅读与工作场景的配置预设目录，以及非破坏性多选合并与变更摘要计算逻辑。
 * 主要内容：提供学术科研、程序员技术文档、语言学习、追剧与漫画、跨境办公五类场景定义；实现 buildScenarioPresetPatch 纯函数，支持多选叠加并严格保留用户已有密钥、自定义规则、已设快捷键与排除标签，输出最小配置补丁与可读能力清单，供首启向导与设置中心复用。
 * 模块边界：本文件属于 core 纯配置领域层，只依赖配置模型类型与不可变数据结构，不读写浏览器存储、不发起网络请求、不挂载任何 Vue 组件。
 */
import type {Config} from './model';

export type ScenarioPresetId =
    | 'academic'
    | 'developer'
    | 'language-learning'
    | 'media-manga'
    | 'cross-border';

export interface ScenarioPresetDefinition {
    readonly id: ScenarioPresetId;
    readonly icon: string;
    readonly titleKey: string;
    readonly descriptionKey: string;
    readonly highlightKeys: readonly string[];
}

export const DEVELOPER_PROTECTED_TAGS: readonly string[] = ['code', 'pre', 'kbd', 'samp'];

export const SCENARIO_PRESETS: readonly ScenarioPresetDefinition[] = [
    {
        id: 'academic',
        icon: 'graduation',
        titleKey: 'scenarioPresets.academic.title',
        descriptionKey: 'scenarioPresets.academic.description',
        highlightKeys: [
            'scenarioPresets.features.bilingualSentenceHighlight',
            'scenarioPresets.features.glossary',
            'scenarioPresets.features.aiContext',
            'scenarioPresets.features.documentGuidance',
        ],
    },
    {
        id: 'developer',
        icon: 'code',
        titleKey: 'scenarioPresets.developer.title',
        descriptionKey: 'scenarioPresets.developer.description',
        highlightKeys: [
            'scenarioPresets.features.preserveInlineCode',
            'scenarioPresets.features.hoverTranslation',
            'scenarioPresets.features.sectionTranslation',
            'scenarioPresets.features.selectionTranslation',
        ],
    },
    {
        id: 'language-learning',
        icon: 'book',
        titleKey: 'scenarioPresets.languageLearning.title',
        descriptionKey: 'scenarioPresets.languageLearning.description',
        highlightKeys: [
            'scenarioPresets.features.selectionDictionarySpeech',
            'scenarioPresets.features.vocabularyReencounter',
            'scenarioPresets.features.smartHighlight',
            'scenarioPresets.features.videoListening',
        ],
    },
    {
        id: 'media-manga',
        icon: 'film',
        titleKey: 'scenarioPresets.mediaManga.title',
        descriptionKey: 'scenarioPresets.mediaManga.description',
        highlightKeys: [
            'scenarioPresets.features.videoBilingualSubtitles',
            'scenarioPresets.features.imageMangaTranslation',
            'scenarioPresets.features.floatingBall',
        ],
    },
    {
        id: 'cross-border',
        icon: 'briefcase',
        titleKey: 'scenarioPresets.crossBorder.title',
        descriptionKey: 'scenarioPresets.crossBorder.description',
        highlightKeys: [
            'scenarioPresets.features.inputTranslation',
            'scenarioPresets.features.writingAssistant',
            'scenarioPresets.features.bilingualDisplay',
            'scenarioPresets.features.sidepanelTranslation',
        ],
    },
] as const;

const SCENARIO_PRESET_ID_SET: ReadonlySet<string> = new Set(SCENARIO_PRESETS.map((preset) => preset.id));

export type ScenarioPresetCurrentConfig = Pick<
    Config,
    | 'display'
    | 'hotkey'
    | 'excludedTags'
    | 'bilingualSentenceHighlightEnabled'
    | 'glossaryEnabled'
    | 'enableAIContext'
    | 'sectionTranslationHotkeyEnabled'
    | 'selectionTranslatorMode'
    | 'disableSelectionTranslator'
    | 'selectionTranslatorBidirectional'
    | 'vocabularyBookEnabled'
    | 'vocabularyReencounterEnabled'
    | 'informationHighlight'
    | 'videoTranslationEnabled'
    | 'videoSubtitleVisible'
    | 'videoSubtitleDisplayMode'
    | 'disableImageTranslator'
    | 'imageTranslationHoverEnabled'
    | 'imageTranslationMangaEnabled'
    | 'disableFloatingBall'
    | 'inputBoxTranslationTrigger'
    | 'writing'
>;

export interface ScenarioPresetPatchResult {
    readonly scenarioIds: readonly ScenarioPresetId[];
    readonly patch: Partial<Config>;
    readonly changedKeys: readonly (keyof Config)[];
    readonly featureSummaryKeys: readonly string[];
    readonly alreadySatisfied: boolean;
}

export function isScenarioPresetId(value: unknown): value is ScenarioPresetId {
    return typeof value === 'string' && SCENARIO_PRESET_ID_SET.has(value);
}

/** 按目录顺序去重并过滤无效场景标识，确保多选组合结果稳定可复现。 */
export function normalizeScenarioPresetIds(ids: readonly unknown[]): ScenarioPresetId[] {
    const selected = new Set<ScenarioPresetId>();
    for (const id of ids) {
        if (isScenarioPresetId(id)) selected.add(id);
    }
    return SCENARIO_PRESETS
        .map((preset) => preset.id)
        .filter((id) => selected.has(id));
}

function mergeExcludedTags(current: readonly string[] | undefined, required: readonly string[]): string[] {
    const existing = Array.isArray(current) ? current : [];
    const normalizedExisting = new Set(existing.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
    const additions = required.filter((tag) => !normalizedExisting.has(tag.toLowerCase()));
    return additions.length > 0 ? [...existing, ...additions] : [...existing];
}

/**
 * 按选中的一个或多个场景生成最小且非破坏性的配置补丁：
 * 绝不清空或覆盖用户 API Key、服务地址、自定义服务、站点规则或已有快捷键，只补全所选场景需要的阅读能力。
 */
export function buildScenarioPresetPatch(
    scenarioIds: readonly unknown[],
    currentConfig: ScenarioPresetCurrentConfig,
): ScenarioPresetPatchResult {
    const normalizedIds = normalizeScenarioPresetIds(scenarioIds);
    const patch: Partial<Config> = {};
    const featureSummarySet = new Set<string>();

    const enableBilingualDisplay = () => {
        if (currentConfig.display !== 1) patch.display = 1;
    };
    const enableSelectionTranslator = () => {
        if (currentConfig.disableSelectionTranslator !== false) patch.disableSelectionTranslator = false;
        if (currentConfig.selectionTranslatorMode === 'disabled') patch.selectionTranslatorMode = 'bilingual';
    };
    const enableSmartHighlight = () => {
        if (currentConfig.informationHighlight?.enabled !== true) {
            patch.informationHighlight = {
                ...currentConfig.informationHighlight,
                enabled: true,
            };
        }
    };
    const enableVideoSubtitles = () => {
        if (currentConfig.videoTranslationEnabled !== true) patch.videoTranslationEnabled = true;
        if (currentConfig.videoSubtitleVisible !== true) patch.videoSubtitleVisible = true;
        if (currentConfig.videoSubtitleDisplayMode !== 'bilingual') patch.videoSubtitleDisplayMode = 'bilingual';
    };

    for (const id of normalizedIds) {
        const preset = SCENARIO_PRESETS.find((item) => item.id === id)!;
        for (const key of preset.highlightKeys) featureSummarySet.add(key);

        if (id === 'academic') {
            enableBilingualDisplay();
            enableSelectionTranslator();
            if (currentConfig.bilingualSentenceHighlightEnabled !== true) patch.bilingualSentenceHighlightEnabled = true;
            if (currentConfig.glossaryEnabled !== true) patch.glossaryEnabled = true;
            if (currentConfig.enableAIContext !== true) patch.enableAIContext = true;
            enableSmartHighlight();
        } else if (id === 'developer') {
            enableBilingualDisplay();
            enableSelectionTranslator();
            if (!currentConfig.hotkey || currentConfig.hotkey === 'none') patch.hotkey = 'Control';
            if (currentConfig.sectionTranslationHotkeyEnabled !== true) patch.sectionTranslationHotkeyEnabled = true;
            const mergedTags = mergeExcludedTags(currentConfig.excludedTags, DEVELOPER_PROTECTED_TAGS);
            if (mergedTags.length !== (currentConfig.excludedTags?.length ?? 0)) {
                patch.excludedTags = mergedTags;
            }
        } else if (id === 'language-learning') {
            enableSelectionTranslator();
            if (currentConfig.selectionTranslatorBidirectional !== true) patch.selectionTranslatorBidirectional = true;
            if (currentConfig.vocabularyBookEnabled !== true) patch.vocabularyBookEnabled = true;
            if (currentConfig.vocabularyReencounterEnabled !== true) patch.vocabularyReencounterEnabled = true;
            enableSmartHighlight();
            enableVideoSubtitles();
        } else if (id === 'media-manga') {
            enableVideoSubtitles();
            if (currentConfig.disableImageTranslator !== false) patch.disableImageTranslator = false;
            if (currentConfig.imageTranslationHoverEnabled !== true) patch.imageTranslationHoverEnabled = true;
            if (currentConfig.imageTranslationMangaEnabled !== true) patch.imageTranslationMangaEnabled = true;
            if (currentConfig.disableFloatingBall !== false) patch.disableFloatingBall = false;
        } else {
            enableBilingualDisplay();
            if (!currentConfig.inputBoxTranslationTrigger || currentConfig.inputBoxTranslationTrigger === 'disabled') {
                patch.inputBoxTranslationTrigger = 'triple_space';
            }
            if (currentConfig.writing?.enabled !== true) {
                patch.writing = {
                    ...currentConfig.writing,
                    enabled: true,
                };
            }
            if (currentConfig.disableFloatingBall !== false) patch.disableFloatingBall = false;
        }
    }

    const changedKeys = Object.keys(patch) as (keyof Config)[];
    return {
        scenarioIds: normalizedIds,
        patch,
        changedKeys,
        featureSummaryKeys: [...featureSummarySet],
        alreadySatisfied: normalizedIds.length > 0 && changedKeys.length === 0,
    };
}

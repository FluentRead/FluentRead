/**
 * @file src/core/config/diff.ts
 * 文件职责：把两份配置转换为可供预览的结构化差异，同时确保凭据和嵌套敏感内容只显示脱敏摘要。
 * 主要内容：维护设置字段到页面分组及中文标签的映射，格式化枚举、映射和长文本，递归检查未知对象并生成稳定的分组差异结果。
 * 模块边界：本文件是无浏览器副作用的纯配置算法，不读取存储、不打开确认框也不执行恢复；设置页面只消费其脱敏后的 ConfigDiffResult。
 */
import {CONFIG_CREDENTIAL_FIELDS, isSensitiveConfigKey} from './credentials';
import {options} from './catalog';
import {isCustomOpenAIProviderId} from './customOpenAI';
import {
    interfaceSkinOptions,
    interfaceVisibilityOptions,
    popupModuleOptions,
    popupQuickFeatureOptions,
} from './interfaceAppearance';
import {translationLoadingStyleOptions} from './translationLoadingStyle';
import {parseApiKeyRequirementKey} from './validation';

export const CONFIG_DIFF_GROUPS = [
    {id: 'general', label: '通用设置'},
    {id: 'translationServices', label: '翻译服务'},
    {id: 'translation', label: '翻译设置'},
    {id: 'siteRules', label: '网站规则'},
    {id: 'imageTranslation', label: '图片翻译'},
    {id: 'areaTranslation', label: '圈选翻译'},
    {id: 'videoSubtitles', label: '视频字幕翻译'},
    {id: 'advanced', label: '高级'},
    {id: 'tools', label: '工具'},
    {id: 'other', label: '其他'},
] as const;

export type ConfigDiffGroupId = typeof CONFIG_DIFF_GROUPS[number]['id'];

export interface ConfigDiffItem {
    key: string;
    label: string;
    before: string;
    after: string;
}

export interface ConfigDiffGroup {
    id: ConfigDiffGroupId;
    label: string;
    changes: ConfigDiffItem[];
}

export interface ConfigDiffResult {
    changeCount: number;
    groups: ConfigDiffGroup[];
}

type ConfigRecord = Record<string, unknown>;
type ValueFormatter = (value: unknown) => string;

interface MappingDefinition {
    itemLabel: (key: string) => string;
    format: ValueFormatter;
}

interface FieldDefinition {
    group: ConfigDiffGroupId;
    label: string;
    format?: ValueFormatter;
    mapping?: MappingDefinition;
}

type Option = {value: unknown; label: string};

const EXCLUDED_FIELDS = new Set([
    'count',
    'persistCredentials',
    'videoServiceDefaultMigrated',
    'uiLanguageSetupCompleted',
    '__fluentConfigRevision',
]);
const CREDENTIAL_FIELDS = new Set<string>(CONFIG_CREDENTIAL_FIELDS);
const SENSITIVE_SUMMARY_PREFIX = '敏感内容已隐藏';
const MAX_INLINE_ITEMS = 4;
const MAX_INLINE_TEXT_LENGTH = 120;

function isRecord(value: unknown): value is ConfigRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toSnakeCase(value: string): string {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

function containsSensitiveContent(value: string): boolean {
    return /(?:authorization|bearer\s+[a-z0-9._~+/=-]+|(?:api[-_ ]?key|token|password|passwd|secret)\s*["']?\s*[:=])/iu.test(value)
        || /:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value);
}

function sensitiveSummary(value: string): string {
    return `${SENSITIVE_SUMMARY_PREFIX}（${value.length} 字符）`;
}

function sanitizeSensitiveValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed) as unknown;
                if (isRecord(parsed) || Array.isArray(parsed)) {
                    return sanitizeSensitiveValue(parsed, seen);
                }
            } catch {
                // 非 JSON 的 prompt 或模板会在下方按普通文本处理。
            }
        }
        return containsSensitiveContent(value) ? sensitiveSummary(value) : value;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) return '[循环引用]';
        seen.add(value);
        return value.map((item) => sanitizeSensitiveValue(item, seen));
    }
    if (!isRecord(value)) return value;
    if (seen.has(value)) return '[循环引用]';
    seen.add(value);

    const result: ConfigRecord = {};
    for (const [key, item] of Object.entries(value)) {
        if (isSensitiveConfigKey(key)) continue;
        result[key] = sanitizeSensitiveValue(item, seen);
    }
    return result;
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
    if (!Array.isArray(value) && !isRecord(value)) return value;
    if (seen.has(value)) return '[循环引用]';
    seen.add(value);
    const result = Array.isArray(value)
        ? value.map((item) => canonicalize(item, seen))
        : Object.fromEntries(
        Object.keys(value)
            .sort((left, right) => left.localeCompare(right))
            .map((key) => [key, canonicalize(value[key], seen)]),
        );
    seen.delete(value);
    return result;
}

function valuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function labelsFor(...optionLists: ReadonlyArray<ReadonlyArray<Option>>): Map<unknown, string> {
    return new Map(optionLists.flatMap((items) => items.map((item) => [item.value, item.label] as const)));
}

const LANGUAGE_LABELS = labelsFor(options.to, options.inputBoxTranslationTarget, options.from);
const SERVICE_LABELS = labelsFor(options.services);
const STYLE_LABELS = labelsFor(options.styles);
const THEME_LABELS = labelsFor(options.theme);
const UI_LANGUAGE_LABELS = new Map<unknown, string>([
    ['zh-CN', '中文'],
    ['en-US', 'English'],
    ['ja-JP', '日本語'],
    ['ko-KR', '한국어'],
    ['fr-FR', 'Français'],
    ['ru-RU', 'Русский'],
    ['es-ES', 'Español'],
]);
const INTERFACE_SKIN_LABELS = labelsFor(interfaceSkinOptions);
const TRANSLATION_LOADING_STYLE_LABELS = labelsFor(translationLoadingStyleOptions);
const TRANSLATION_SCOPE_LABELS = new Map<unknown, string>([['content', '关闭'], ['all', '开启']]);
const POPUP_MODULE_LABELS = new Map<string, string>(popupModuleOptions.map((item) => [item.id, item.label]));
const POPUP_QUICK_FEATURE_LABELS = new Map<string, string>(
    popupQuickFeatureOptions.map((item) => [item.id, item.label]),
);
const HOVER_TRIGGER_LABELS = labelsFor(options.keys);
const SELECTION_TRIGGER_LABELS = labelsFor(options.selectionTranslatorTriggers);
const FLOATING_HOTKEY_LABELS = labelsFor(options.floatingBallHotkeys);
const INPUT_TRIGGER_LABELS = labelsFor(options.inputBoxTranslationTrigger);
const BILLING_PLAN_LABELS = labelsFor(options.minimaxBillingPlan, options.mimoBillingPlan);
const DEEPL_API_PLAN_LABELS = new Map<unknown, string>([
    ['free', 'API Free（免费）'],
    ['pro', 'API Pro（付费）'],
]);
const REGION_LABELS = labelsFor(options.minimaxRegion, options.mimoRegion);
const DEEPSEEK_API_LABELS = labelsFor(options.deepseekApiType);
const DEEPSEEK_THINKING_LABELS = labelsFor(options.deepseekThinkingMode);
const DISPLAY_LABELS = new Map<unknown, string>([
    [0, '仅译文模式'],
    [1, '双语对照模式'],
]);
const FULL_PAGE_MODE_LABELS = new Map<unknown, string>([
    ['viewport', '按阅读进度'],
    ['all', '立即翻译到网页底部'],
]);
const SELECTION_MODE_LABELS = new Map<unknown, string>([
    ['disabled', '关闭'],
    ['bilingual', '双语显示'],
    ['translation-only', '只显示译文'],
]);
const VIDEO_DISPLAY_MODE_LABELS = new Map<unknown, string>([
    ['bilingual', '双语显示'],
    ['translation-only', '只显示译文'],
    ['original-only', '只显示原文'],
]);
const SIDE_LABELS = new Map<unknown, string>([
    ['left', '左侧'],
    ['right', '右侧'],
]);

function formatEnum(value: unknown, labels: Map<unknown, string>): string {
    return labels.get(value) ?? formatValue(value);
}

function formatBoolean(value: unknown, inverted = false): string {
    if (typeof value !== 'boolean') return formatValue(value);
    return (inverted ? !value : value) ? '开启' : '关闭';
}

function formatNumber(value: unknown, suffix = ''): string {
    return typeof value === 'number' && Number.isFinite(value)
        ? `${value}${suffix}`
        : formatValue(value);
}

function formatRequestRate(value: unknown): string {
    return value === 0 ? '不限速' : formatNumber(value, ' 次');
}

function formatString(value: string): string {
    if (!value.trim()) return '未设置';
    if (value.startsWith(SENSITIVE_SUMMARY_PREFIX)) return value;
    if (value.length > MAX_INLINE_TEXT_LENGTH) return `长文本（${value.length} 字符）`;
    return value.replace(/\s+/gu, ' ').trim();
}

function formatArray(value: unknown[], itemFormatter: ValueFormatter = formatValue): string {
    if (value.length === 0) return '无';
    const formatted = value.map(itemFormatter);
    const visible = formatted.slice(0, MAX_INLINE_ITEMS).join('、');
    return formatted.length > MAX_INLINE_ITEMS
        ? `${formatted.length} 项：${visible} 等`
        : visible;
}

function formatRecord(value: ConfigRecord): string {
    const entries = Object.entries(value).filter(([key]) => !isSensitiveConfigKey(key));
    if (entries.length === 0) return '无';
    const visible = entries.slice(0, MAX_INLINE_ITEMS).map(([key, item]) => {
        const displayKey = SERVICE_LABELS.get(key) ?? key;
        return `${displayKey}：${formatValue(item)}`;
    }).join('；');
    return entries.length > MAX_INLINE_ITEMS ? `${entries.length} 项：${visible} 等` : visible;
}

function formatValue(value: unknown): string {
    if (value === undefined || value === null || value === '') return '未设置';
    if (typeof value === 'boolean') return formatBoolean(value);
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '未设置';
    if (typeof value === 'string') return formatString(value);
    if (Array.isArray(value)) return formatArray(value);
    if (isRecord(value)) return formatRecord(value);
    return String(value);
}

function formatEndpoint(value: unknown): string {
    return formatValue(value);
}

function formatPrompt(value: unknown): string {
    if (value === undefined || value === null || value === '') return '未设置';
    if (typeof value === 'string') {
        if (value.startsWith(SENSITIVE_SUMMARY_PREFIX)) return value;
        return `已配置（${value.length} 字符）`;
    }
    return formatValue(value);
}

function formatCustomBody(value: unknown): string {
    if (value === undefined || value === null || value === '') return '未设置';
    if (typeof value === 'string' && value.startsWith(SENSITIVE_SUMMARY_PREFIX)) return value;
    if (Array.isArray(value)) return `${value.length} 项 JSON（内容已摘要）`;
    if (isRecord(value)) return `${Object.keys(value).length} 个公开字段（内容已摘要）`;
    if (typeof value === 'string') return `文本请求体（${value.length} 字符，内容已摘要）`;
    return '已配置（内容已摘要）';
}

function serviceName(key: string): string {
    if (SERVICE_LABELS.has(key)) return SERVICE_LABELS.get(key)!;
    if (isCustomOpenAIProviderId(key)) {
        return `自定义服务 ${key.slice('custom:'.length)}`;
    }
    return key;
}

function formatService(value: unknown): string {
    return typeof value === 'string' ? serviceName(value) : formatValue(value);
}

function formatInterfaceVisibility(value: unknown): string {
    if (!isRecord(value)) return formatValue(value);
    return interfaceVisibilityOptions
        .map(({key, label}) => `${label}${value[key] === false ? '关闭' : '开启'}`)
        .join('、');
}

function formatPopupModuleOrder(value: unknown): string {
    if (!Array.isArray(value)) return formatValue(value);
    if (value.length === 0) return '无';
    return value.map((item) => typeof item === 'string'
        ? POPUP_MODULE_LABELS.get(item) ?? item
        : formatValue(item)).join(' → ');
}

function formatPopupQuickFeatureVisibility(value: unknown): string {
    if (!isRecord(value)) return formatValue(value);
    return popupQuickFeatureOptions
        .map(({id, label}) => `${label}：${value[id] === false ? '隐藏' : '显示'}`)
        .join('、');
}

function formatPopupQuickFeatureOrder(value: unknown): string {
    if (!Array.isArray(value)) return formatValue(value);
    if (value.length === 0) return '无';
    return value.map((item) => typeof item === 'string'
        ? POPUP_QUICK_FEATURE_LABELS.get(item) ?? item
        : formatValue(item)).join(' → ');
}

function formatCustomOpenAIProviders(value: unknown): string {
    if (!Array.isArray(value) || value.length === 0) return '无';
    return formatArray(value, (item) => {
        if (!isRecord(item)) return formatValue(item);
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '未命名服务';
        const endpoint = formatEndpoint(item.endpoint);
        const models = Array.isArray(item.models) ? formatArray(item.models) : '无';
        return `${name}（接口：${endpoint}；模型：${models}）`;
    });
}

function formatQuickTranslationProfiles(value: unknown): string {
    if (!Array.isArray(value) || value.length === 0) return '无';
    return value.map((item) => {
        if (!isRecord(item)) return formatValue(item);
        const action = item.action === 'full-page' ? '全文' : '悬停';
        const hotkey = typeof item.hotkey === 'string' && item.hotkey ? item.hotkey : '未设置';
        const service = typeof item.service === 'string' && item.service
            ? serviceName(item.service)
            : '默认服务';
        const model = typeof item.model === 'string' && item.model ? ` · ${item.model}` : '';
        const language = typeof item.targetLanguage === 'string' && item.targetLanguage
            ? formatEnum(item.targetLanguage, LANGUAGE_LABELS)
            : '默认语言';
        const display = item.displayMode === 'bilingual'
            ? '双语'
            : item.displayMode === 'translation-only' ? '仅译文' : '默认显示';
        const range = item.action === 'full-page'
            ? `，${item.fullPageMode === 'viewport'
                ? '按阅读进度'
                : item.fullPageMode === 'all' ? '立即翻译到网页底部' : '默认范围'}`
            : '';
        const disabled = item.enabled === false ? '（已停用）' : '';
        const glossary = item.glossaryIds === undefined ? '' : `，术语库：${formatGlossarySelection(item.glossaryIds)}`;
        return `${action} ${hotkey}${disabled}：${service}${model}，${language}，${display}${range}${glossary}`;
    }).join('；');
}

/** 历史预览只显示规模，避免把用户保存的专业词句展开到配置差异中。 */
function formatGlossaryLibraries(value: unknown): string {
    if (!Array.isArray(value)) return formatValue(value);
    const libraries = value.filter(isRecord);
    const entries = libraries.reduce((count, library) => count + (Array.isArray(library.entries) ? library.entries.length : 0), 0);
    return `${libraries.length} 套词库，${entries} 条术语`;
}

function formatGlossarySelection(value: unknown): string {
    if (value == null) return '跟随全局词库';
    if (!Array.isArray(value)) return formatValue(value);
    return value.length ? `指定 ${value.length} 套词库` : '不使用术语库';
}

function serviceMapping(label: string, format: ValueFormatter = formatValue): MappingDefinition {
    return {
        itemLabel: (key) => `${serviceName(key)}${label}`,
        format,
    };
}

function apiKeyRequirementMapping(): MappingDefinition {
    return {
        itemLabel: (key) => {
            const parsed = parseApiKeyRequirementKey(key);
            if (!parsed) return `${serviceName(key)} API Key 校验`;
            const [service, model] = parsed;
            return `${serviceName(service)} · ${model || '默认模型'} API Key 校验`;
        },
        format: formatBoolean,
    };
}

const FIELD_DEFINITIONS: Record<string, FieldDefinition> = {
    on: {group: 'general', label: '插件状态', format: formatBoolean},
    uiLanguage: {group: 'general', label: '界面语言', format: (value) => formatEnum(value, UI_LANGUAGE_LABELS)},
    from: {group: 'general', label: '默认源语言', format: (value) => formatEnum(value, LANGUAGE_LABELS)},
    to: {group: 'general', label: '默认目标语言', format: (value) => formatEnum(value, LANGUAGE_LABELS)},
    theme: {group: 'general', label: '主题', format: (value) => formatEnum(value, THEME_LABELS)},
    interfaceSkin: {group: 'general', label: '界面皮肤', format: (value) => formatEnum(value, INTERFACE_SKIN_LABELS)},
    interfaceVisibility: {group: 'general', label: '界面栏目', format: formatInterfaceVisibility},
    popupModuleOrder: {group: 'general', label: '菜单栏布局顺序', format: formatPopupModuleOrder},
    popupQuickFeatureVisibility: {group: 'general', label: '快捷功能卡片', format: formatPopupQuickFeatureVisibility},
    popupQuickFeatureOrder: {group: 'general', label: '快捷功能顺序', format: formatPopupQuickFeatureOrder},

    display: {group: 'general', label: '翻译模式', format: (value) => formatEnum(value, DISPLAY_LABELS)},
    style: {group: 'general', label: '译文样式', format: (value) => formatEnum(value, STYLE_LABELS)},
    disableFloatingBall: {group: 'general', label: '全文翻译悬浮球', format: (value) => formatBoolean(value, true)},
    translationProgressPanelEnabled: {group: 'general', label: '翻译进度面板', format: formatBoolean},
    bilingualSentenceHighlightEnabled: {group: 'general', label: '双语逐句高亮', format: formatBoolean},

    service: {group: 'general', label: '默认翻译服务', format: formatService},
    customOpenAIProviders: {group: 'translationServices', label: '自定义 OpenAI 服务', format: formatCustomOpenAIProviders},
    model: {group: 'translationServices', label: '服务模型', mapping: serviceMapping('模型')},
    customModel: {group: 'translationServices', label: '自定义模型', mapping: serviceMapping('自定义模型')},
    customModels: {group: 'translationServices', label: '自定义模型列表', mapping: serviceMapping('自定义模型列表')},
    modelThinking: {group: 'translationServices', label: '模型 Thinking', mapping: serviceMapping('模型 Thinking')},
    requireApiKey: {group: 'translationServices', label: 'API Key 校验', mapping: apiKeyRequirementMapping()},
    minimaxBillingPlan: {group: 'translationServices', label: 'MiniMax 计费方案', format: (value) => formatEnum(value, BILLING_PLAN_LABELS)},
    minimaxRegion: {group: 'translationServices', label: 'MiniMax API 区域', format: (value) => formatEnum(value, REGION_LABELS)},
    mimoBillingPlan: {group: 'translationServices', label: 'MiMo 计费方案', format: (value) => formatEnum(value, BILLING_PLAN_LABELS)},
    mimoRegion: {group: 'translationServices', label: 'MiMo API 区域', format: (value) => formatEnum(value, REGION_LABELS)},
    customBody: {group: 'translationServices', label: '自定义请求体', mapping: serviceMapping('自定义请求体', formatCustomBody)},
    proxy: {group: 'translationServices', label: '代理地址', mapping: serviceMapping('代理地址', formatEndpoint)},
    custom: {group: 'translationServices', label: '自定义服务地址', format: formatEndpoint},
    deeplApiPlan: {group: 'translationServices', label: 'DeepL API 套餐', format: (value) => formatEnum(value, DEEPL_API_PLAN_LABELS)},
    deeplx: {group: 'translationServices', label: 'DeepLX 服务地址', format: formatEndpoint},
    newApiUrl: {group: 'translationServices', label: 'New API 地址', format: formatEndpoint},
    azureOpenaiEndpoint: {group: 'translationServices', label: 'Azure 端点', format: formatEndpoint},
    system_role: {group: 'translationServices', label: 'System 提示词', mapping: serviceMapping(' System 提示词', formatPrompt)},
    user_role: {group: 'translationServices', label: 'User 提示词', mapping: serviceMapping(' User 提示词', formatPrompt)},
    deepseekApiType: {group: 'translationServices', label: 'DeepSeek API 格式', format: (value) => formatEnum(value, DEEPSEEK_API_LABELS)},
    deepseekThinkingMode: {group: 'translationServices', label: 'DeepSeek 思考模式', format: (value) => formatEnum(value, DEEPSEEK_THINKING_LABELS)},

    hotkey: {group: 'translation', label: '鼠标悬浮快捷键', format: (value) => formatEnum(value, HOVER_TRIGGER_LABELS)},
    customHotkey: {group: 'translation', label: '自定义悬浮快捷键'},
    mouseHoverTranslationDelay: {group: 'translation', label: '悬浮翻译延迟', format: (value) => formatNumber(value, ' ms')},
    disableSelectionTranslator: {group: 'translation', label: '划词翻译', format: (value) => formatBoolean(value, true)},
    selectionTranslatorMode: {group: 'translation', label: '划词显示模式', format: (value) => formatEnum(value, SELECTION_MODE_LABELS)},
    selectionTranslatorTrigger: {group: 'translation', label: '划词触发方式', format: (value) => formatEnum(value, SELECTION_TRIGGER_LABELS)},
    selectionTranslatorHotkey: {group: 'translation', label: '划词快捷键', format: (value) => formatEnum(value, SELECTION_TRIGGER_LABELS)},
    customSelectionTranslatorHotkey: {group: 'translation', label: '自定义划词快捷键'},
    selectionTranslatorDelay: {group: 'translation', label: '划词显示延迟', format: (value) => formatNumber(value, ' ms')},
    selectionTtsVoices: {group: 'translation', label: '划词朗读音色'},
    inputBoxTranslationTrigger: {group: 'translation', label: '输入框翻译触发方式', format: (value) => formatEnum(value, INPUT_TRIGGER_LABELS)},
    inputBoxTranslationTarget: {group: 'translation', label: '输入框翻译目标语言', format: (value) => formatEnum(value, LANGUAGE_LABELS)},
    contextMenuEnabled: {group: 'translation', label: '右键全文翻译', format: formatBoolean},
    fullPageTranslationMode: {group: 'translation', label: '全文翻译范围', format: (value) => formatEnum(value, FULL_PAGE_MODE_LABELS)},
    floatingBallPosition: {group: 'translation', label: '悬浮球位置', format: (value) => formatEnum(value, SIDE_LABELS)},
    floatingBallHotkey: {group: 'translation', label: '全文翻译快捷键', format: (value) => formatEnum(value, FLOATING_HOTKEY_LABELS)},
    customFloatingBallHotkey: {group: 'translation', label: '自定义全文快捷键'},
    quickTranslationProfiles: {group: 'translation', label: '快捷翻译方案', format: formatQuickTranslationProfiles},
    glossaryEnabled: {group: 'translation', label: '术语库', format: formatBoolean},
    glossaryLibraries: {group: 'translation', label: '术语库内容', format: formatGlossaryLibraries},

    autoTranslate: {group: 'siteRules', label: '所有网站自动翻译', format: formatBoolean},
    alwaysTranslateDomains: {group: 'siteRules', label: '始终翻译网站'},
    disabledExtensionDomains: {group: 'siteRules', label: '禁用扩展网站'},

    imageTranslationHoverEnabled: {group: 'imageTranslation', label: '图片悬浮按钮', format: formatBoolean},
    imageTranslationContextMenuEnabled: {group: 'imageTranslation', label: '图片右键菜单', format: formatBoolean},
    disableImageTranslator: {group: 'imageTranslation', label: '图片翻译', format: (value) => formatBoolean(value, true)},
    selectionAreaEnabled: {group: 'areaTranslation', label: '圈选翻译', format: formatBoolean},
    areaTranslationMode: {group: 'areaTranslation', label: '圈选翻译方式', format: value => value === 'ai' ? 'AI 上下文增强' : '标准翻译'},
    areaTranslationService: {group: 'areaTranslation', label: '圈选翻译服务', format: value => value ? formatService(value) : '跟随当前服务'},

    videoTranslationEnabled: {group: 'videoSubtitles', label: '视频字幕翻译', format: formatBoolean},
    videoService: {group: 'videoSubtitles', label: '视频翻译服务', format: formatService},
    videoSourceLanguage: {group: 'videoSubtitles', label: '视频原语言'},
    videoGlossaryIds: {group: 'videoSubtitles', label: '字幕术语库', format: formatGlossarySelection},
    videoSubtitleVisible: {group: 'videoSubtitles', label: '显示视频字幕', format: formatBoolean},
    videoSubtitleDisplayMode: {group: 'videoSubtitles', label: '视频字幕显示模式', format: (value) => formatEnum(value, VIDEO_DISPLAY_MODE_LABELS)},
    videoSubtitleFontSize: {group: 'videoSubtitles', label: '视频字幕字号', format: (value) => formatNumber(value, '%')},
    videoSubtitleAppearance: {group: 'videoSubtitles', label: '视频字幕外观'},

    useCache: {group: 'advanced', label: '缓存翻译结果', format: formatBoolean},
    translationCacheMaxBytes: {group: 'advanced', label: '翻译缓存容量上限', format: (value) => formatNumber(value, ' B')},
    translationCacheMaxEntries: {group: 'advanced', label: '翻译缓存条数上限', format: (value) => formatNumber(value, ' 条')},
    enableAIContext: {group: 'general', label: 'AI 智能上下文', format: formatBoolean},
    enableAIMultiSegment: {group: 'translation', label: 'AI 多段翻译', format: formatBoolean},
    maxConcurrentTranslations: {group: 'advanced', label: '翻译并发数'},
    translationRequestsPerSecond: {group: 'advanced', label: '每秒最多请求数', format: formatRequestRate},
    translationRequestsPerMinute: {group: 'advanced', label: '每分钟最多请求数', format: formatRequestRate},
    freeTranslationOrder: {group: 'translationServices', label: '免费翻译顺序', format: (value) => Array.isArray(value) ? formatArray(value, formatService) : formatValue(value)},
    freeTranslationTimeoutMs: {group: 'translationServices', label: '每路免费翻译超时', format: (value) => formatNumber(value, ' ms')},
    freeTranslationCooldownMs: {group: 'translationServices', label: '免费翻译失败后休息', format: (value) => formatNumber(value, ' ms')},
    myMemoryEmail: {group: 'translationServices', label: 'MyMemory 邮箱', format: formatValue},
    translationMaxRetries: {group: 'advanced', label: '失败后最多重试', format: (value) => formatNumber(value, ' 次')},
    translationBackoffBaseMs: {group: 'advanced', label: '退避初始间隔', format: (value) => formatNumber(value, ' ms')},
    translationBackoffMaxMs: {group: 'advanced', label: '退避最大间隔', format: (value) => formatNumber(value, ' ms')},
    animations: {group: 'advanced', label: '动画效果', format: formatBoolean},
    translationScope: {group: 'advanced', label: '识别全部节点', format: (value) => formatEnum(value, TRANSLATION_SCOPE_LABELS)},
    translationLoadingStyle: {group: 'advanced', label: '段落加载样式', format: (value) => formatEnum(value, TRANSLATION_LOADING_STYLE_LABELS)},

    documentService: {group: 'tools', label: '文档翻译服务', format: formatService},
    documentGlossaryIds: {group: 'tools', label: '文档术语库', format: formatGlossarySelection},
    documentModel: {group: 'tools', label: '文档翻译模型', mapping: serviceMapping('文档模型')},
    documentCustomModel: {group: 'tools', label: '文档自定义模型', mapping: serviceMapping('文档自定义模型')},
    translationCenterServices: {group: 'tools', label: '翻译中心服务', format: (value) => Array.isArray(value) ? formatArray(value, formatService) : formatValue(value)},
    translationCenterSourceLanguage: {group: 'tools', label: '翻译中心源语言', format: (value) => formatEnum(value, LANGUAGE_LABELS)},
    translationCenterTargetLanguage: {group: 'tools', label: '翻译中心目标语言', format: (value) => formatEnum(value, LANGUAGE_LABELS)},
    vocabularyBookEnabled: {group: 'tools', label: '单词本', format: formatBoolean},
};
const FIELD_ORDER = new Map(Object.keys(FIELD_DEFINITIONS).map((field, index) => [field, index]));

function configRecord(value: unknown): ConfigRecord {
    return isRecord(value) ? value : {};
}

function humanizeUnknownKey(key: string): string {
    const words = toSnakeCase(key).split('_').filter(Boolean);
    return words.length > 0 ? words.join(' ') : key;
}

function diffMapping(
    field: string,
    definition: FieldDefinition,
    before: unknown,
    after: unknown,
): ConfigDiffItem[] | null {
    if (!definition.mapping || (!isRecord(before) && !isRecord(after))) return null;
    const beforeRecord = isRecord(before) ? before : {};
    const afterRecord = isRecord(after) ? after : {};
    const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])]
        .filter((key) => !isSensitiveConfigKey(key))
        .sort((left, right) => left.localeCompare(right));
    const format = definition.mapping.format;

    return keys.flatMap((key) => {
        if (valuesEqual(beforeRecord[key], afterRecord[key])) return [];
        const safeBefore = sanitizeSensitiveValue(beforeRecord[key]);
        const safeAfter = sanitizeSensitiveValue(afterRecord[key]);
        return [{
            key: `${field}.${key}`,
            label: definition.mapping!.itemLabel(key),
            before: format(safeBefore),
            after: format(safeAfter),
        }];
    });
}

function diffField(field: string, before: unknown, after: unknown): {group: ConfigDiffGroupId; changes: ConfigDiffItem[]} | null {
    if (EXCLUDED_FIELDS.has(field) || CREDENTIAL_FIELDS.has(field)) return null;
    const definition = FIELD_DEFINITIONS[field];
    if (!definition && isSensitiveConfigKey(field)) return null;
    if (valuesEqual(before, after)) return null;

    const safeBefore = sanitizeSensitiveValue(before);
    const safeAfter = sanitizeSensitiveValue(after);

    if (definition?.mapping) {
        const mappingChanges = diffMapping(field, definition, before, after);
        if (mappingChanges) return {group: definition.group, changes: mappingChanges};
    }

    const format = definition?.format ?? formatValue;
    const formattedBefore = format(safeBefore);
    const formattedAfter = format(safeAfter);
    return {
        group: definition?.group ?? 'other',
        changes: [{
            key: field,
            label: definition?.label ?? humanizeUnknownKey(field),
            before: formattedBefore,
            after: field === 'glossaryLibraries' && formattedBefore === formattedAfter
                ? `${formattedAfter}（内容已更新）` : formattedAfter,
        }],
    };
}

/**
 * 比较两份公开配置快照，并按设置页的稳定顺序返回面向用户的变更。
 * 格式化值之前会排除凭据字段，因此结果可以安全用于备份预览。
 */
export function buildConfigDiff(current: unknown, target: unknown): ConfigDiffResult {
    const currentConfig = configRecord(current);
    const targetConfig = configRecord(target);
    const changesByGroup = new Map<ConfigDiffGroupId, ConfigDiffItem[]>(
        CONFIG_DIFF_GROUPS.map(({id}) => [id, []]),
    );
    const fields = [...new Set([...Object.keys(currentConfig), ...Object.keys(targetConfig)])].sort((left, right) => {
        const leftOrder = FIELD_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = FIELD_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.localeCompare(right);
    });

    for (const field of fields) {
        const result = diffField(field, currentConfig[field], targetConfig[field]);
        if (!result) continue;
        changesByGroup.get(result.group)!.push(...result.changes);
    }

    const groups = CONFIG_DIFF_GROUPS.flatMap(({id, label}) => {
        const changes = changesByGroup.get(id)!;
        return changes.length > 0 ? [{id, label, changes}] : [];
    });
    return {
        changeCount: groups.reduce((total, group) => total + group.changes.length, 0),
        groups,
    };
}

/**
 * @file src/core/config/driveSync.ts
 * 文件职责：定义默认排除敏感信息的云同步范围、兼容完整快照和不泄露凭据的差异预览。
 * 主要内容：投影普通设置、读取 v1 完整与 v2 普通快照、保留凭据明确删除语义、执行三方字段合并，并将请求体、
 * 地址、请求头、密钥和未知字段统一隐藏，普通设置展示稳定名称和值；数组整体合并。
 * 模块边界：只处理纯数据；不拥有口令、加密、存储、浏览器消息或 Google API。
 */
import {options, servicesType} from './catalog';
import {CONFIG_CREDENTIAL_FIELDS, isSensitiveConfigKey} from './credentials';
import {Config} from './model';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, normalizeCustomOpenAIProviders} from './customOpenAI';
import {isConfigImportValid, prepareConfigForExport} from './transfer';
import {configDiffFieldLabel} from './diff';
export class DriveConfigError extends Error {}

export type DriveSyncConfig = Record<string, unknown>;
export type DriveChoice = 'local' | 'remote';
export interface DriveSyncChange {
    id: string;
    label: string;
    sensitive: boolean;
    local: string;
    remote: string;
    conflict: boolean;
    recommended: DriveChoice | null;
    details?: string[];
}
export interface DriveSyncField {
    path: string[];
    local: unknown;
    remote: unknown;
    recommended: DriveChoice | null;
}
export interface DriveSyncDiff {
    draft: DriveSyncConfig;
    fields: DriveSyncField[];
    changes: DriveSyncChange[];
}

function record(value: unknown): value is DriveSyncConfig {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function driveValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => driveValuesEqual(value, right[index]));
    }
    if (!record(left) || !record(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && driveValuesEqual(left[key], right[key]));
}

/** 防止解密得到的扩展参数带入原型键，或以过深结构阻断设置页与合并流程。 */
function validateTree(value: unknown, depth = 0, budget = {nodes: 0}): void {
    if (depth > 40 || ++budget.nodes > 50_000) throw new DriveConfigError('同步配置结构过于复杂');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new DriveConfigError('同步配置包含无效字段');
        validateTree(child, depth + 1, budget);
    }
}

export function toDriveSyncConfig(value: unknown): DriveSyncConfig {
    validateTree(value);
    const snapshot = prepareConfigForExport(value);
    delete snapshot.uiLanguageSetupCompleted;
    delete snapshot.videoServiceDefaultMigrated;
    const result = JSON.parse(JSON.stringify(snapshot)) as DriveSyncConfig;
    validateTree(result);
    return result;
}

export interface DriveSyncSnapshot {config: DriveSyncConfig; includesSensitive: boolean}

/** v2 普通快照不经过完整配置补默认值，避免把未备份连接解释为明确删除。 */
export function parseDriveSyncSnapshot(value: unknown): DriveSyncSnapshot {
    if (record(value) && value.format === 'fluentread-complete-config' && value.version === 2 && value.scope === 'settings'
        && record(value.config) && typeof value.config.on === 'boolean'
        && (value.config.display === 0 || value.config.display === 1)
        && typeof value.config.from === 'string' && value.config.from.trim()
        && typeof value.config.to === 'string' && value.config.to.trim()) {
        validateTree(value.config);
        const config = projectDriveSyncConfig(value.config);
        if (!driveValuesEqual(config, value.config)) throw new DriveConfigError('普通云备份包含不属于此范围的字段，请重新生成备份。');
        return {config, includesSensitive: false};
    }
    return {config: parseCompleteDriveSyncPayload(value), includesSensitive: true};
}

/** 保留纯编解码器的完整 v1 读取契约；恢复范围由事务中的本次确认决定。 */
export function parseDriveSyncPayload(value: unknown): DriveSyncConfig {
    return parseDriveSyncSnapshot(value).config;
}

function parseCompleteDriveSyncPayload(value: unknown): DriveSyncConfig {
    if (!record(value) || value.format !== 'fluentread-complete-config' || value.version !== 1
        || !isConfigImportValid(value.config)
        || !CONFIG_CREDENTIAL_FIELDS.every(field => Object.hasOwn(value.config as object, field))) {
        throw new DriveConfigError('云端文件不包含完整的配置和凭据快照');
    }
    const config = value.config;
    validateTree(config);
    const providers = normalizeCustomOpenAIProviders(config.customOpenAIProviders);
    const references = [
        ...SERVICE_FIELDS.map(field => config[field]),
        ...(Array.isArray(config.translationCenterServices) ? config.translationCenterServices : []),
        ...(Array.isArray(config.favoriteServices) ? config.favoriteServices : []),
        ...(Array.isArray(config.quickTranslationProfiles) ? config.quickTranslationProfiles.map(profile => record(profile) ? profile.service : '') : []),
        record(config.writing) ? config.writing.service : '',
        record(config.harness) ? config.harness.service : '',
    ];
    if (references.some(service => isCustomOpenAIProviderId(service) && !isConfiguredCustomOpenAIProvider(providers, service))) {
        throw new DriveConfigError('同步配置引用了不存在的自定义服务，请重新预览并选择完整连接配置。');
    }
    // 快照省略运行时迁移状态，但必须按已完成迁移的用户配置解析，保留用户选择。
    return toDriveSyncConfig({...value.config, videoServiceDefaultMigrated: true});
}

export function driveSyncPayload(config: DriveSyncConfig, includeSensitive = false): unknown {
    validateDriveSyncConsent(includeSensitive);
    return includeSensitive
        ? {format: 'fluentread-complete-config', version: 1, config}
        : {format: 'fluentread-complete-config', version: 2, scope: 'settings', config: projectDriveSyncConfig(config)};
}

const SERVICE_FIELDS = ['service', 'hoverTranslationService', 'selectionTranslationService', 'imageTranslationService', 'documentService', 'videoService', 'areaTranslationService', 'inputBoxTranslationService'];
const VISIBLE_FIELDS: Record<string, string> = {
    on: '插件开关', service: '默认翻译服务', from: '源语言', to: '目标语言',
    display: '翻译模式', language: '界面语言', uiLanguage: '界面语言', theme: '主题',
    fontStyle: '译文字体', fontColor: '译文颜色',
    mouseHoverTranslationDelay: '悬停翻译延迟（毫秒）', selectionTranslatorDelay: '划词翻译延迟（毫秒）',
    disableFloatingBall: '禁用悬浮球', disableSelectionTranslator: '禁用划词翻译', disableImageTranslator: '禁用图片翻译',
    autoTranslate: '自动翻译', useCache: '使用翻译缓存', animations: '界面动画',

    style: '译文样式',
    videoTranslationEnabled: '视频字幕翻译',
    videoMeetingAutoEnabled: '会议平台自动开启双语字幕',
    videoPreferHumanSubtitles: '优先使用人工字幕',
    videoSubtitleVisible: '显示视频字幕',
    videoSubtitleFontSize: '视频字幕字号',
    videoSubtitleOffsetMs: '字幕时间偏移',
    translationCacheMaxBytes: '翻译缓存容量上限',
    translationCacheMaxEntries: '翻译缓存条数上限',
    enableAIContext: 'AI 智能上下文',
    glossaryEnabled: '术语库',
    enableAIMultiSegment: 'AI 多段翻译',
    bilingualSentenceHighlightEnabled: '双语逐句高亮',
    bilingualSentenceHighlightStyle: '逐句高亮样式',
    bilingualSentenceHighlightAppearance: '逐句高亮自定义外观',
    bilingualSentenceHighlightProfiles: '已保存的逐句高亮样式',
    activeSentenceHighlightProfileId: '当前逐句高亮配置',
    contextMenuEnabled: '右键全文翻译',
    pageTitleTranslationEnabled: '翻译页面标题',
    sidebarTranslationEnabled: '侧边栏翻译',
    minTranslationTextLength: '翻译段落最少字符数',
    eagerTranslationCharacters: '免滚动预翻译字符数',
    longParagraphLineBreakEnabled: '长段落自动换行',
    translationBeforeOriginal: '译文在原文之前',
    floatingBallHoverDelay: '悬浮球展开延迟',
    floatingBallCompact: '缩小悬浮球',
    floatingBallSettingsEntryVisible: '悬浮球设置入口',
    floatingBallCollapsedOpacity: '悬浮球收起不透明度',
    paragraphCopyEnabled: '段落复制',
    sectionTranslationHotkeyEnabled: '局部翻译快捷键',
    selectionAreaEnabled: '圈选翻译',
    imageTranslationMangaEnabled: '漫画连续翻译入口',
    imageTranslationMangaPromptEnabled: '独立漫画按钮',
    imageTranslationMangaDownloadConfirmed: '已了解漫画资源下载',
    imageTranslationMangaSites: '自定义漫画网站',
    imageTranslationMangaPrefetchPages: '提前翻译后续页面',
    imageTranslationMangaCachePages: '快速缓存图片数量',
    imageTranslationHoverEnabled: '图片悬浮按钮',
    imageTranslationContextMenuEnabled: '图片右键菜单',
    freeTranslationTimeoutMs: '每路免费翻译超时',
    freeTranslationCooldownMs: '免费翻译失败后休息',
    selectionTranslatorAutoDismiss: '继续阅读时自动收起',
    selectionTranslatorBidirectional: '中英双向划词',
    vocabularyBookEnabled: '单词本',
    vocabularyReencounterEnabled: '再次遇见收藏表达',
    maxConcurrentTranslations: '翻译并发数',
    translationRequestsPerSecond: '每秒最多请求数',
    translationRequestsPerMinute: '每分钟最多请求数',
    apiKeyRecoveryMs: '失败 Key 冷却时间',
    translationMaxRetries: '失败后最多重试',
    translationBackoffBaseMs: '退避初始间隔',
    translationBackoffMaxMs: '退避最大间隔',
    translationProgressPanelEnabled: '翻译进度面板',
    inputBoxTranslationInterval: '输入框翻译触发间隔',
    interfaceSkin: '界面皮肤', interfaceFont: '界面字体', interfaceVisibility: '界面栏目',
    popupModuleOrder: '菜单栏布局顺序', popupQuickFeatureVisibility: '快捷功能卡片', popupQuickFeatureOrder: '快捷功能顺序',
    translationAppearance: '译文外观', translationStyleProfiles: '译文样式', activeTranslationStyleProfileId: '译文样式',
    siteAdaptation: '网站规则', alwaysTranslateDomains: '网站规则', disabledExtensionDomains: '网站规则',
    excludedLanguages: '跳过翻译的语言', videoSubtitleAppearance: '视频字幕外观',
    system_role: 'System 提示词', user_role: 'User 提示词', glossaryLibraries: '术语库内容',
    contextMenuEntries: '右键菜单入口', shareCard: '双语卡片',
    contextMenuShowTargetLanguage: '右键菜单显示目标语言', contextMenuShowShortcut: '右键菜单显示快捷键',
    hoverShortcutBeforeDisable: '已保存的悬浮快捷键', selectionTranslatorModeBeforeDisable: '已保存的划词模式',
    videoLocalModel: '本地语音识别模型', requestHeaderRules: '移除来源请求头',
};
// 端点、路由模型与凭据一起选择，防止自动合并把某端的密钥绑定到另一端的新地址。
const CONNECTION_FIELDS = new Set<string>([
    ...CONFIG_CREDENTIAL_FIELDS, ...SERVICE_FIELDS, 'translationCenterServices', 'favoriteServices',
    'quickTranslationProfiles', 'writing', 'harness', 'serviceRegion', 'customModels', 'modelThinking',
    'requireApiKey', 'apiKeyRotationEnabled', 'inputBoxTranslationModel', 'deepseekApiType', 'deepseekThinkingMode', 'proxy', 'custom', 'deeplx', 'customBody', 'customOpenAIProviders',
    'newApiUrl', 'azureOpenaiEndpoint', 'deeplApiPlan', 'minimaxBillingPlan', 'minimaxRegion',
    'mimoBillingPlan', 'mimoRegion', 'model', 'customModel', 'documentModel', 'documentCustomModel',
]);
const PRIVATE_FIELDS = new Set(['system_role', 'user_role', 'activeTranslationStyleProfileId', 'myMemoryEmail', 'areaVisionPrompt', 'inputBoxTranslationPrompt', 'inputBoxTranslationSystemPrompt']);
const SETTINGS_SCHEMA = new Config() as unknown as DriveSyncConfig;
const KNOWN_SETTINGS = new Set(Object.keys(SETTINGS_SCHEMA));

export function validateDriveSyncConsent(includeSensitive: unknown): asserts includeSensitive is boolean {
    if (typeof includeSensitive !== 'boolean') throw new DriveConfigError('敏感信息同步选项必须为布尔值。');
}

/** 已知连接整个排除，未知根字段保守排除；嵌套秘密使所属偏好整组排除。 */
function containsExcludedSettings(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => CONNECTION_FIELDS.has(key) || PRIVATE_FIELDS.has(key)
        || isSensitiveConfigKey(key) || containsExcludedSettings(child));
}
/** 归一化器是已知嵌套设置的结构边界；额外字段或伪装成标量的对象整组排除。 */
function hasUnknownStructure(value: unknown, normalized: unknown): boolean {
    if (Array.isArray(value)) return !Array.isArray(normalized) || value.length !== normalized.length
        || value.some((child, index) => hasUnknownStructure(child, normalized[index]));
    if (!record(value)) return false;
    return !record(normalized) || Object.keys(value).some(key => !Object.hasOwn(normalized, key) || hasUnknownStructure(value[key], normalized[key]));
}
export function projectDriveSyncConfig(config: DriveSyncConfig, includeSensitive = false): DriveSyncConfig {
    validateDriveSyncConsent(includeSensitive);
    validateTree(config);
    if (includeSensitive) return structuredClone(config);
    const normalized = toDriveSyncConfig(config);
    return Object.fromEntries(Object.entries(config).filter(([key, value]) => KNOWN_SETTINGS.has(key)
        && !CONNECTION_FIELDS.has(key) && !PRIVATE_FIELDS.has(key) && !containsExcludedSettings(value)
        && (!(value && typeof value === 'object') || SETTINGS_SCHEMA[key] !== null && typeof SETTINGS_SCHEMA[key] === 'object')
        && !hasUnknownStructure(value, normalized[key]))
        .map(([key, value]) => [key, structuredClone(value)]));
}

/** 普通范围仅替换可备份设置；本机完整连接、未知字段和私密偏好保持原子性。 */
export function restoreDriveSyncSettings(local: DriveSyncConfig, settings: DriveSyncConfig): DriveSyncConfig {
    const projected = projectDriveSyncConfig(local);
    const preserved = Object.fromEntries(Object.entries(local).filter(([key]) => !Object.hasOwn(projected, key)));
    return {...structuredClone(settings), ...structuredClone(preserved)};
}

const fieldLabel = (field: string) => Object.hasOwn(VISIBLE_FIELDS, field) ? VISIBLE_FIELDS[field] : configDiffFieldLabel(field);
const CONNECTION_SUMMARIES: [string, readonly string[]][] = [
    ['settings.cloud.changed.credentials', CONFIG_CREDENTIAL_FIELDS],
    ['settings.cloud.changed.requests', ['proxy', 'custom', 'deeplx', 'customBody', 'newApiUrl', 'azureOpenaiEndpoint']],
    ['settings.cloud.changed.models', ['model', 'customModel', 'customModels', 'modelThinking', 'documentModel', 'documentCustomModel', 'inputBoxTranslationModel']],
    ['settings.cloud.changed.services', [...SERVICE_FIELDS, 'translationCenterServices', 'favoriteServices', 'quickTranslationProfiles']],
    ['settings.cloud.changed.customServices', ['customOpenAIProviders']],
    ['settings.cloud.changed.assistants', ['writing', 'harness']],
    ['settings.cloud.changed.options', ['serviceRegion', 'requireApiKey', 'apiKeyRotationEnabled', 'deepseekApiType', 'deepseekThinkingMode', 'deeplApiPlan', 'minimaxBillingPlan', 'minimaxRegion', 'mimoBillingPlan', 'mimoRegion']],
];
function connectionDetails(local: DriveSyncConfig, remote: DriveSyncConfig): string[] {
    return CONNECTION_SUMMARIES.filter(([, keys]) => keys.some(key => !driveValuesEqual(local[key], remote[key]))).map(([label]) => label);
}
function partition(config: DriveSyncConfig) {
    const connection: DriveSyncConfig = {};
    const settings: DriveSyncConfig = {};
    for (const [key, value] of Object.entries(config)) (CONNECTION_FIELDS.has(key) ? connection : settings)[key] = value;
    return {connection, settings};
}

function previewConnection(value: unknown): string {
    if (!record(value) || Object.keys(value).length === 0) return '空值';
    // 只允许内置服务 ID 和服务数量进入摘要，不能返回用户起的名字、模型、地址或任何凭据。
    const service = typeof value.service === 'string' && (servicesType.machine.has(value.service) || servicesType.AI.has(value.service)) ? value.service : 'custom';
    const count = Array.isArray(value.customOpenAIProviders) ? value.customOpenAIProviders.length : 0;
    return `翻译连接：${service}；自定义服务：${count}；凭据和地址已隐藏`;
}
function previewValue(value: unknown, sensitive: boolean, field: string): string {
    if (value === undefined) return '已删除';
    if (value === '' || value === null || (Array.isArray(value) && value.length === 0)
        || (record(value) && Object.keys(value).length === 0)) return '空值';
    if (sensitive) return '已设置（内容隐藏）';
    if (typeof value === 'boolean') return value ? '开启' : '关闭';
    if (typeof value === 'number') {
        if (field === 'translationCacheMaxBytes' && Number.isFinite(value)) return `${Number((value / 1024 / 1024).toFixed(2))} MiB`;
        if (field.endsWith('Ms') || field.endsWith('Delay') || field === 'selectionTranslatorDelay' || field === 'inputBoxTranslationInterval') return `${value} ms`;
        if (field === 'floatingBallCollapsedOpacity' || field === 'videoSubtitleFontSize') return `${value}%`;
    }
    const choices = field === 'theme' ? options.theme : field === 'from' ? options.from : field === 'to' ? options.to : field === 'style' ? options.styles : [];
    const option = choices.find(option => option.value === value);
    if (option) return option.label;
    return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 160);
}

export function buildDriveSyncDiff(base: DriveSyncConfig | null, local: DriveSyncConfig, remote: DriveSyncConfig): DriveSyncDiff {
    const fields: DriveSyncField[] = [];
    const changes: DriveSyncChange[] = [];
    const walk = (path: string[], before: unknown, left: unknown, right: unknown, atomic = false): unknown => {
        if (driveValuesEqual(left, right)) return left;
        // 已知的复合偏好整体比较，避免把一组外观/站点规则拆成许多无法辨认的子字段。
        if (!atomic && record(left) && record(right) && !(path.length === 1 && fieldLabel(path[0]))) {
            const result: DriveSyncConfig = {};
            const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
            for (const key of keys) {
                const value = walk([...path, key], record(before) ? before[key] : undefined, left[key], right[key]);
                if (value !== undefined) result[key] = value;
            }
            return result;
        }
        const recommended = base === null ? null : driveValuesEqual(left, before) ? 'remote'
            : driveValuesEqual(right, before) ? 'local' : null;
        const root = path[0];
        const sensitive = atomic || PRIVATE_FIELDS.has(root) || path.length !== 1 || !fieldLabel(root) || (typeof left === 'object' && left !== null) || (typeof right === 'object' && right !== null);
        const id = String(fields.length);
        fields.push({path, local: left, remote: right, recommended});
        changes.push({
            id, label: atomic ? '翻译连接与凭据（整组）' : fieldLabel(root) ?? '私密或自定义设置',
            sensitive, local: atomic ? previewConnection(left) : previewValue(left, sensitive, root), remote: atomic ? previewConnection(right) : previewValue(right, sensitive, root),
            conflict: recommended === null, recommended,
            ...(atomic ? {details: connectionDetails(left as DriveSyncConfig, right as DriveSyncConfig)} : {}),
        });
        return recommended === 'remote' ? right : left;
    };
    const left = partition(local);
    const right = partition(remote);
    const before = base === null ? null : partition(base);
    const settings = walk([], before?.settings, left.settings, right.settings) as DriveSyncConfig;
    const connection = walk([], before?.connection, left.connection, right.connection, true) as DriveSyncConfig;
    return {draft: structuredClone({...settings, ...connection}), fields, changes};
}

export function resolveDriveSyncDiff(diff: DriveSyncDiff, choices: unknown): DriveSyncConfig {
    if (!record(choices)) throw new DriveConfigError('同步差异选择无效');
    const result = structuredClone(diff.draft);
    diff.fields.forEach((field, index) => {
        const choice = choices[String(index)] ?? field.recommended;
        if (choice !== 'local' && choice !== 'remote') throw new DriveConfigError('请为每个冲突选择本机或云端配置');
        if (field.path.length === 0) {
            for (const key of CONNECTION_FIELDS) delete result[key];
            Object.assign(result, structuredClone(field[choice]));
            return;
        }
        let target = result;
        for (const key of field.path.slice(0, -1)) target = target[key] as DriveSyncConfig;
        const key = field.path.at(-1)!;
        const value = field[choice];
        if (value === undefined) delete target[key];
        else target[key] = structuredClone(value);
    });
    return result;
}

/**
 * @file src/core/config/driveSync.ts
 * 文件职责：定义包含全部配置凭据的云同步快照和不泄露凭据的差异预览。
 * 主要内容：验证完整快照、保留凭据明确删除语义、执行三方字段合并，并将请求体、
 * 地址、请求头、密钥和未知字段统一隐藏，普通设置展示稳定名称和值；数组整体合并。
 * 模块边界：只处理纯数据；不拥有口令、加密、存储、浏览器消息或 Google API。
 */
import {options, servicesType} from './catalog';
import {CONFIG_CREDENTIAL_FIELDS} from './credentials';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, normalizeCustomOpenAIProviders} from './customOpenAI';
import {isConfigImportValid, prepareConfigForExport} from './transfer';
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

export function parseDriveSyncPayload(value: unknown): DriveSyncConfig {
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

export function driveSyncPayload(config: DriveSyncConfig): unknown {
    return {format: 'fluentread-complete-config', version: 1, config};
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
    imageTranslationHoverEnabled: '图片悬浮按钮',
    imageTranslationContextMenuEnabled: '图片右键菜单',
    freeTranslationTimeoutMs: '每路免费翻译超时',
    freeTranslationCooldownMs: '免费翻译失败后休息',
    selectionTranslatorAutoDismiss: '继续阅读时自动收起',
    selectionTranslatorBidirectional: '中英双向划词',
    vocabularyBookEnabled: '单词本',
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
};
// 端点、路由模型与凭据一起选择，防止自动合并把某端的密钥绑定到另一端的新地址。
const CONNECTION_FIELDS = new Set<string>([
    ...CONFIG_CREDENTIAL_FIELDS, ...SERVICE_FIELDS, 'translationCenterServices', 'favoriteServices',
    'quickTranslationProfiles', 'writing', 'harness', 'serviceRegion', 'customModels', 'modelThinking',
    'requireApiKey', 'apiKeyRotationEnabled', 'inputBoxTranslationModel', 'deepseekApiType', 'deepseekThinkingMode', 'proxy', 'deeplx', 'customBody', 'customOpenAIProviders',
    'newApiUrl', 'azureOpenaiEndpoint', 'deeplApiPlan', 'minimaxBillingPlan', 'minimaxRegion',
    'mimoBillingPlan', 'mimoRegion', 'model', 'customModel', 'documentModel', 'documentCustomModel',
]);
const PRIVATE_FIELDS = new Set(['system_role', 'user_role', 'activeTranslationStyleProfileId']);
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
    return JSON.stringify(value).slice(0, 160);
}

export function buildDriveSyncDiff(base: DriveSyncConfig | null, local: DriveSyncConfig, remote: DriveSyncConfig): DriveSyncDiff {
    const fields: DriveSyncField[] = [];
    const changes: DriveSyncChange[] = [];
    const walk = (path: string[], before: unknown, left: unknown, right: unknown, atomic = false): unknown => {
        if (driveValuesEqual(left, right)) return left;
        // 已知的复合偏好整体比较，避免把一组外观/站点规则拆成许多无法辨认的子字段。
        if (!atomic && record(left) && record(right) && !(path.length === 1 && Object.hasOwn(VISIBLE_FIELDS, path[0]))) {
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
        const sensitive = atomic || PRIVATE_FIELDS.has(root) || path.length !== 1 || !Object.hasOwn(VISIBLE_FIELDS, root) || (typeof left === 'object' && left !== null) || (typeof right === 'object' && right !== null);
        const id = String(fields.length);
        fields.push({path, local: left, remote: right, recommended});
        changes.push({
            id, label: atomic ? '翻译连接与凭据（整组）' : VISIBLE_FIELDS[root] ?? '私密或自定义设置',
            sensitive, local: atomic ? previewConnection(left) : previewValue(left, sensitive, root), remote: atomic ? previewConnection(right) : previewValue(right, sensitive, root),
            conflict: recommended === null, recommended,
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

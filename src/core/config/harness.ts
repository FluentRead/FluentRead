/**
 * @file src/core/config/harness.ts
 * 文件职责：定义 Harness 学习辅助功能的动作注册表、配置类型、默认值与纯规范化规则。
 * 主要内容：提供 HarnessActionId/HarnessPreferences、动作注册表、通用AI与阅读专用服务判断和规范化函数，限制触发方式、快捷键、悬停延迟、服务/模型覆盖和动作白名单、上下文长度和学习难度；B站仅开放读懂与用法，不支持语法、练习、多轮追问或通用AI写作，统一解析固定模型，让缓存身份只包含实际使用的配置，保留完整AI服务的全部阅读动作、追问、请求头及多 Key 凭据标识。 可编辑提示词的中文默认数据由 promptDefaults 提供，多语言解析由 core/harness/prompts 负责，并提供两个学习视图共用的讲解配置比较。
 * 模块边界：本文件只处理领域数据，不读取浏览器存储、不发起 AI 请求，也不决定选区或网页生命周期。
 */
import {DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH} from '../harness/promptDefaults';
export {DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH, HARNESS_PROMPT_VARIABLES, type HarnessPromptKind} from '../harness/promptDefaults';
import {parseHotkey} from '../hotkey';
import {customModelString, resolveConfiguredModel, services, servicesType} from './catalog';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, type CustomOpenAIProvider} from './customOpenAI';
import type {RequestHeaderRule} from './requestHeaders';
import {BILIBILI_FREE_TRANSLATION_MODEL} from './freeTranslation';

export const HARNESS_ACTIONS = [
    {id: 'meaning', label: '读懂', description: '解释这段内容在说什么。'},
    {id: 'grammar', label: '词性与句法', description: '拆解句子结构和关键语法。'},
    {id: 'usage', label: '用法', description: '说明词语或表达的自然用法。'},
    {id: 'practice', label: '练习', description: '根据内容生成一个小练习。'},
] as const;

export type HarnessActionId = typeof HARNESS_ACTIONS[number]['id'];
export type HarnessContextMode = 'paragraph' | 'selection';
export type HarnessExplanationDepth = 'concise' | 'detailed';

export interface HarnessPreferences {
    enabled: boolean;
    trigger: 'click' | 'hover' | 'shortcut';
    customHotkey: string;
    hoverDelay: number;
    service: string;
    model: string;
    defaultAction: HarnessActionId;
    actions: HarnessActionId[];
    contextMode: HarnessContextMode;
    maxContextChars: number;
    explanationDepth: HarnessExplanationDepth;
    learningLevel: 'beginner' | 'intermediate' | 'advanced';
    memoryEnabled: boolean;
    systemPrompt: string;
    actionPrompts: Record<HarnessActionId, string>;
}

export const DEFAULT_HARNESS_PREFERENCES: HarnessPreferences = {
    enabled: false,
    trigger: 'click',
    customHotkey: 'Alt+R',
    hoverDelay: 600,
    service: '',
    model: '',
    defaultAction: 'meaning',
    actions: HARNESS_ACTIONS.map((action) => action.id),
    contextMode: 'paragraph',
    maxContextChars: 1500,
    explanationDepth: 'concise',
    learningLevel: 'intermediate',
    memoryEnabled: false,
    systemPrompt: DEFAULT_HARNESS_SYSTEM_PROMPT,
    actionPrompts: {...DEFAULT_HARNESS_ACTION_PROMPTS},
};

const HARNESS_UNSUPPORTED_SERVICES = new Set([services.huanYuanTranslation]);

/** 通用AI支持兼容会话及原生 Claude/Gemini；写作等功能仍遵循此能力边界。 */
export function isHarnessService(service: unknown, customProviders: readonly CustomOpenAIProvider[] = []): service is string {
    if (typeof service !== 'string' || service.length > 128) return false;
    if (isCustomOpenAIProviderId(service)) return isConfiguredCustomOpenAIProvider(customProviders, service);
    return servicesType.isAI(service) && !HARNESS_UNSUPPORTED_SERVICES.has(service);
}

/** 仅阅读讲解允许已验证的B站匿名模型，不扩展写作或其他通用AI能力。 */
export function isReadingService(service: unknown, customProviders: readonly CustomOpenAIProvider[] = []): service is string {
    return service === services.bilibili || isHarnessService(service, customProviders);
}

/** 免费翻译模型只开放实际验证可用的基础讲解，不把接口兼容当作语法或练习能力。 */
export function isReadingActionSupported(service: string, action: HarnessActionId): boolean {
    return service !== services.bilibili || action === 'meaning' || action === 'usage';
}

/** B站多轮反馈没有通过真实验证，完整追问继续由通用AI承担。 */
export function isReadingFollowUpSupported(service: string): boolean {
    return service !== services.bilibili;
}

const HARNESS_ACTION_IDS = new Set<HarnessActionId>(HARNESS_ACTIONS.map((action) => action.id));

export function normalizeHarnessPreferences(value: unknown, customProviders: readonly CustomOpenAIProvider[] = []): HarnessPreferences {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<HarnessPreferences>
        : {};
    const hotkey = typeof source.customHotkey === 'string' ? source.customHotkey.trim().slice(0, 100) : '';
    const hoverDelay = source.hoverDelay;
    const actions = Array.isArray(source.actions)
        ? [...new Set(source.actions.filter((action): action is HarnessActionId => (
            typeof action === 'string' && HARNESS_ACTION_IDS.has(action as HarnessActionId)
        )))]
        : [...DEFAULT_HARNESS_PREFERENCES.actions];
    if (!actions.includes('meaning')) actions.unshift('meaning');
    const rawChars = typeof source.maxContextChars === 'number' ? source.maxContextChars : Number(source.maxContextChars);
    const promptSource = source.actionPrompts && typeof source.actionPrompts === 'object' && !Array.isArray(source.actionPrompts) ? source.actionPrompts : {} as Partial<Record<HarnessActionId, unknown>>;
    const normalizePrompt = (value: unknown, fallback: string): string => typeof value === 'string' ? value.slice(0, HARNESS_PROMPT_MAX_LENGTH) : fallback;
    return {
        systemPrompt: normalizePrompt(source.systemPrompt, DEFAULT_HARNESS_SYSTEM_PROMPT),
        actionPrompts: Object.fromEntries(HARNESS_ACTIONS.map(({id}) => [id, normalizePrompt(promptSource[id], DEFAULT_HARNESS_ACTION_PROMPTS[id])])) as Record<HarnessActionId, string>,
        enabled: source.enabled === true,
        trigger: source.trigger === 'hover' || source.trigger === 'shortcut' ? source.trigger : 'click',
        customHotkey: parseHotkey(hotkey).isValid ? hotkey : DEFAULT_HARNESS_PREFERENCES.customHotkey,
        hoverDelay: typeof hoverDelay === 'number' && Number.isFinite(hoverDelay) ? Math.min(3000, Math.max(200, Math.round(hoverDelay))) : 600,
        service: isReadingService(typeof source.service === 'string' ? source.service.trim() : '', customProviders) ? source.service!.trim().slice(0, 128) : '',
        model: typeof source.model === 'string' && source.model.trim() !== customModelString ? source.model.trim().slice(0, 128) : '',
        defaultAction: typeof source.defaultAction === 'string' && HARNESS_ACTION_IDS.has(source.defaultAction as HarnessActionId) && actions.includes(source.defaultAction as HarnessActionId)
            ? source.defaultAction as HarnessActionId
            : 'meaning',
        actions,
        contextMode: source.contextMode === 'selection' ? 'selection' : 'paragraph',
        maxContextChars: Number.isFinite(rawChars) ? Math.min(4000, Math.max(500, Math.round(rawChars))) : 1500,
        explanationDepth: source.explanationDepth === 'detailed' ? 'detailed' : 'concise',
        learningLevel: source.learningLevel === 'beginner' || source.learningLevel === 'advanced'
            ? source.learningLevel
            : 'intermediate',
        memoryEnabled: source.memoryEnabled === true,
    };
}

/** B站匿名服务只使用官方固定模型；其他服务保留专项模型覆盖和自定义模型解析。 */
export function resolveHarnessModel(config: {
    harness: Pick<HarnessPreferences, 'service' | 'model'>;
    service: string;
    model: Record<string, string>;
    customModel: Record<string, string>;
}): {service: string; model: string} {
    const service = config.harness.service || config.service;
    const model = service === services.bilibili ? BILIBILI_FREE_TRANSLATION_MODEL
        : config.harness.model || resolveConfiguredModel(config.model[service], config.customModel[service]);
    return {service, model};
}

/** 仅用于内存比较，不持久化或展示；无关界面配置刷新不能清除阅读回答。 */
export function getHarnessModelCacheKey(config: {
    harness: Pick<HarnessPreferences, 'service' | 'model'>;
    service: string;
    model: Record<string, string>;
    customModel: Record<string, string>;
    token: Record<string, string>;
    apiKeys?: Record<string, string[]>;
    apiKeyRotationEnabled?: Record<string, boolean>;
    customHeaders?: Record<string, string>;
    proxy: Record<string, string>;
    on: boolean;
    uiLanguage: string;
    modelThinking: unknown;
    customOpenAIProviders: unknown;
    custom: string;
    newApiUrl: string;
    azureOpenaiEndpoint: string;
    deepseekApiType: string;
    minimaxBillingPlan: string;
    minimaxRegion: string;
    mimoBillingPlan: string;
    mimoRegion: string;
    serviceRegion?: Record<string, string>;
}): string {
    const {service, model} = resolveHarnessModel(config);
    // 匿名B站不读取密钥、代理或默认服务模型；缓存只比较实际生效输入。
    if (service === services.bilibili) return JSON.stringify([config.on, config.uiLanguage, service, model]);
    return JSON.stringify([
        config.on, config.uiLanguage, service, model, config.token[service], config.proxy[service],
        config.modelThinking, config.customOpenAIProviders, config.custom, config.newApiUrl,
        config.azureOpenaiEndpoint, config.deepseekApiType, config.minimaxBillingPlan,
        config.minimaxRegion, config.mimoBillingPlan, config.mimoRegion, config.serviceRegion?.[service],
        config.apiKeys?.[service], config.apiKeyRotationEnabled?.[service], config.customHeaders?.[service],
    ]);
}

/** 学习视图的保守请求配置比较；只在内存使用，不展示、记录或持久化含凭据的标识。 */
export function getHarnessRequestConfigKey(config: Parameters<typeof getHarnessModelCacheKey>[0] & {
    harness: HarnessPreferences;
    to: string;
    apiKeyRecoveryMs: number;
    requireApiKey: Readonly<Record<string, boolean>>;
    requestHeaderRules: readonly RequestHeaderRule[];
}): string {
    return JSON.stringify([
        config.on, config.to, config.harness, getHarnessModelCacheKey(config),
        config.apiKeyRecoveryMs, config.requireApiKey, config.requestHeaderRules,
    ]);
}

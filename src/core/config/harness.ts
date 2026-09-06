/**
 * @file src/core/config/harness.ts
 * 文件职责：定义 Harness 学习辅助功能的动作注册表、配置类型、默认值与纯规范化规则。
 * 主要内容：提供 HarnessActionId/HarnessPreferences、动作注册表、支持服务判断和规范化函数，限制服务/模型覆盖、动作白名单、上下文长度和学习难度，并定义可编辑提示词、默认模板及占位符替换规则。
 * 模块边界：本文件只处理领域数据，不读取浏览器存储、不发起 AI 请求，也不决定选区或网页生命周期。
 */
import {DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH} from '../harness/prompts';
export {DEFAULT_HARNESS_ACTION_PROMPTS, DEFAULT_HARNESS_SYSTEM_PROMPT, HARNESS_PROMPT_MAX_LENGTH, HARNESS_PROMPT_VARIABLES, renderHarnessPrompt} from '../harness/prompts';
import {customModelString, services, servicesType} from './catalog';
import {isConfiguredCustomOpenAIProvider, isCustomOpenAIProviderId, type CustomOpenAIProvider} from './customOpenAI';

export const HARNESS_ACTIONS = [
    {id: 'meaning', label: '读懂', description: '解释这段内容在说什么。'},
    {id: 'grammar', label: '拆句', description: '拆解句子结构和关键语法。'},
    {id: 'usage', label: '用法', description: '说明词语或表达的自然用法。'},
    {id: 'practice', label: '练习', description: '根据内容生成一个小练习。'},
] as const;

export type HarnessActionId = typeof HARNESS_ACTIONS[number]['id'];
export type HarnessContextMode = 'paragraph' | 'selection';
export type HarnessExplanationDepth = 'concise' | 'detailed';

export interface HarnessPreferences {
    enabled: boolean;
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

/** Harness 支持兼容会话及原生 Claude/Gemini，目录与 gateway 共用此规则。 */
export function isHarnessService(service: unknown, customProviders: readonly CustomOpenAIProvider[] = []): service is string {
    if (typeof service !== 'string' || service.length > 128) return false;
    if (isCustomOpenAIProviderId(service)) return isConfiguredCustomOpenAIProvider(customProviders, service);
    return servicesType.isAI(service) && !HARNESS_UNSUPPORTED_SERVICES.has(service);
}

const HARNESS_ACTION_IDS = new Set<HarnessActionId>(HARNESS_ACTIONS.map((action) => action.id));

export function normalizeHarnessPreferences(value: unknown, customProviders: readonly CustomOpenAIProvider[] = []): HarnessPreferences {
    const source = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<HarnessPreferences>
        : {};
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
        service: isHarnessService(typeof source.service === 'string' ? source.service.trim() : '', customProviders) ? source.service!.trim().slice(0, 128) : '',
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

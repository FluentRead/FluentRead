/**
 * @file src/services/translation/modelThinking.ts
 *
 * 文件职责：把统一的模型级 Thinking 布尔偏好转换为已确认支持的供应商请求字段，避免向未知 OpenAI-compatible 网关猜测参数。
 * 主要内容：覆盖 DeepSeek Chat/Responses、通义混合思考模型、Gemini 各代最低档与动态档、Claude 自适应思考、豆包 2.1、Kimi K2.5/K2.6 以及已确认的 GPT 模型。
 * 模块边界：本文件只修改调用方提供的公开请求 payload，不读取全局配置、不发起网络请求；未知服务或模型保持原样，自定义请求体仍由模板层最后合并并拥有覆盖权。
 */

import {services} from '@/src/core/config/catalog';

export type ModelThinkingProtocol =
    | 'openai-chat'
    | 'deepseek-chat'
    | 'deepseek-responses'
    | 'tongyi-chat'
    | 'gemini-generate-content'
    | 'claude-messages';

export type ModelThinkingEffect = 'toggle' | 'minimum' | 'mandatory' | 'unsupported';

export interface ModelThinkingApplication {
    effect: ModelThinkingEffect;
    payload: Record<string, unknown>;
}

function withGenerationThinking(
    payload: Record<string, unknown>,
    thinkingConfig: Record<string, unknown>,
): Record<string, unknown> {
    const generationConfig = payload.generationConfig;
    return {
        ...payload,
        generationConfig: {
            ...(generationConfig && typeof generationConfig === 'object' && !Array.isArray(generationConfig)
                ? generationConfig as Record<string, unknown>
                : {}),
            thinkingConfig,
        },
    };
}

function applyGeminiThinking(
    payload: Record<string, unknown>,
    model: string,
    enabled: boolean,
): ModelThinkingApplication {
    const normalized = model.toLowerCase();
    // Image、TTS、Live 等专用模型拥有不同的 Thinking 档位或根本不接受
    // 文本生成字段，不能仅凭主模型前缀套用通用文本模型规则。
    if (/(?:^|-)(?:image|tts|live|audio|native|computer-use)(?:-|$)/u.test(normalized)) {
        return {effect: 'unsupported', payload};
    }
    if (/^gemini-2\.5-flash(?:-lite)?(?:-|$)/u.test(normalized)) {
        return {effect: 'toggle', payload: withGenerationThinking(payload, {thinkingBudget: enabled ? -1 : 0})};
    }
    if (/^gemini-2\.5-pro(?:-|$)/u.test(normalized)) {
        return {effect: enabled ? 'toggle' : 'minimum', payload: withGenerationThinking(payload, {thinkingBudget: enabled ? -1 : 128})};
    }
    if (/^gemini-4-argon(?:-|$)/u.test(normalized)
        || /^gemini-3\.(?:7|8)[^/]*flash(?:-lite)?(?:-|$)/u.test(normalized)) {
        return {effect: enabled ? 'toggle' : 'minimum', payload: withGenerationThinking(payload, {thinkingLevel: enabled ? 'medium' : 'low'})};
    }
    if (/^gemini-3(?:\.(?:1|5|6))?-flash(?:-lite)?(?:-|$)/u.test(normalized)) {
        return {effect: enabled ? 'toggle' : 'minimum', payload: withGenerationThinking(payload, {thinkingLevel: enabled ? 'medium' : 'minimal'})};
    }
    if (/^gemini-3(?:\.\d+)?[^/]*pro(?:-|$)/u.test(normalized)) {
        return {effect: enabled ? 'toggle' : 'minimum', payload: withGenerationThinking(payload, {thinkingLevel: enabled ? 'high' : 'low'})};
    }
    return {effect: 'unsupported', payload};
}

function applyClaudeThinking(
    payload: Record<string, unknown>,
    model: string,
    enabled: boolean,
): ModelThinkingApplication {
    const normalized = model.toLowerCase();
    if (/^claude-(?:fable|mythos)-5(?:-|$)/u.test(normalized)
        || /^claude-opus-5-5(?:-|$)/u.test(normalized)) {
        const outputConfig = payload.output_config;
        return {
            effect: 'mandatory',
            payload: {
                ...payload,
                thinking: {type: 'adaptive'},
                ...(!enabled ? {
                    output_config: {
                        ...(outputConfig && typeof outputConfig === 'object' && !Array.isArray(outputConfig)
                            ? outputConfig as Record<string, unknown>
                            : {}),
                        effort: 'low',
                    },
                } : {}),
            },
        };
    }
    if (/^claude-sonnet-5-5(?:-|$)/u.test(normalized)) {
        return {
            effect: 'toggle',
            payload: {...payload, thinking: {type: enabled ? 'adaptive' : 'between_tools'}},
        };
    }
    if (/^claude-haiku-5-5(?:-|$)/u.test(normalized)) {
        return {
            effect: 'toggle',
            payload: {...payload, thinking: {type: enabled ? 'adaptive' : 'disabled'}},
        };
    }
    if (/^claude-(?:opus|sonnet)-5(?:-|$)/u.test(normalized)
        || /^claude-(?:opus|sonnet)-4-(?:6|7|8)(?:-|$)/u.test(normalized)) {
        return {
            effect: 'toggle',
            payload: {...payload, thinking: {type: enabled ? 'adaptive' : 'disabled'}},
        };
    }
    if (/^claude-(?:haiku|opus|sonnet)-4-5(?:-|$)/u.test(normalized)) {
        const maximumOutputTokens = typeof payload.max_tokens === 'number'
            ? payload.max_tokens
            : 4096;
        if (enabled && maximumOutputTokens <= 1024) {
            return {effect: 'unsupported', payload};
        }
        return {
            effect: 'toggle',
            payload: {
                ...payload,
                thinking: enabled
                    ? {type: 'enabled', budget_tokens: 1024}
                    : {type: 'disabled'},
            },
        };
    }
    return {effect: 'unsupported', payload};
}

function applyOpenAICompatibleThinking(
    payload: Record<string, unknown>,
    service: string,
    model: string,
    enabled: boolean,
): ModelThinkingApplication {
    if (service === services.openrouter
        && /^google\/gemini-3\.(?:5|6)-flash(?:-|$)/iu.test(model)) {
        return {
            effect: enabled ? 'toggle' : 'minimum',
            payload: {...payload, reasoning: {effort: enabled ? 'medium' : 'minimal'}},
        };
    }
    if ((service === services.openai || service === services.azureOpenai)
        && /^(?:gpt-6-astra|gpt-6\.1-sol)(?:-|$)/iu.test(model)) {
        return {
            effect: enabled ? 'toggle' : 'minimum',
            payload: {...payload, reasoning_effort: 'low'},
        };
    }
    if ((service === services.openai || service === services.azureOpenai)
        && /^(?:gpt-6-sol|gpt-6-luna|gpt-6\.1-terra)(?:-|$)/iu.test(model)) {
        return {effect: 'toggle', payload: {...payload, reasoning_effort: enabled ? 'low' : 'none'}};
    }
    if ((service === services.openai || service === services.azureOpenai)
        && /^gpt-5\.(?:[1-9]\d*)(?:-|$)/iu.test(model)) {
        return {effect: 'toggle', payload: {...payload, reasoning_effort: enabled ? 'low' : 'none'}};
    }
    if ((service === services.openai || service === services.azureOpenai)
        && /^gpt-5-(?:mini|nano)(?:-|$)/iu.test(model)) {
        return {
            effect: enabled ? 'toggle' : 'minimum',
            payload: {...payload, reasoning_effort: enabled ? 'low' : 'minimal'},
        };
    }
    if (service === services.moonshot && /^kimi-k2\.(?:5|6)(?:-|$)/iu.test(model)) {
        return {effect: 'toggle', payload: {...payload, thinking: {type: enabled ? 'enabled' : 'disabled'}}};
    }
    if (service === services.doubao
        && /^(?:doubao-seed-2-1-(?:lite-260915|pro-260915|turbo-260628)|doubao-seed-evolving)$/iu.test(model)) {
        return {effect: 'toggle', payload: {...payload, thinking: {type: enabled ? 'enabled' : 'disabled'}}};
    }
    return {effect: 'unsupported', payload};
}

export function applyModelThinkingPreference(
    payload: Record<string, unknown>,
    input: {
        protocol: ModelThinkingProtocol;
        service: string;
        model: string;
        enabled: boolean;
    },
): ModelThinkingApplication {
    if (input.protocol === 'deepseek-chat') {
        return {
            effect: 'toggle',
            payload: {...payload, thinking: {type: input.enabled ? 'enabled' : 'disabled'}},
        };
    }
    if (input.protocol === 'deepseek-responses') {
        return {
            effect: 'toggle',
            payload: {...payload, reasoning: {effort: input.enabled ? 'high' : 'none'}},
        };
    }
    if (input.protocol === 'tongyi-chat') {
        const normalized = input.model.toLowerCase();
        const isThinkingOnly = /(?:^|-)thinking(?:-|$)/u.test(normalized);
        const isConfirmedHybrid = /^qwen3(?:\.\d+)?-(?:flash|plus|max)(?:-|$)/u.test(normalized);
        if (isThinkingOnly || !isConfirmedHybrid) return {effect: 'unsupported', payload};
        return {effect: 'toggle', payload: {...payload, enable_thinking: input.enabled}};
    }
    if (input.protocol === 'gemini-generate-content') {
        return applyGeminiThinking(payload, input.model, input.enabled);
    }
    if (input.protocol === 'claude-messages') {
        return applyClaudeThinking(payload, input.model, input.enabled);
    }
    return applyOpenAICompatibleThinking(payload, input.service, input.model, input.enabled);
}

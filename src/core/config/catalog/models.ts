/**
 * @file src/core/config/catalog/models.ts
 *
 * 文件职责：集中声明各内置 AI 与本地翻译服务的官方模型编号、开箱默认模型、可选模型列表与首项派生函数。
 * 主要内容：导出 currentModelIds、defaultModelIds、models、firstConfiguredModel 与 defaultModels，将本地模型目录和豆包翻译专用模型编号纳入统一列表，同时保持 ChatGPT 套餐为空列表以等待账户发现。
 * 模块边界：仅聚焦模型清单与默认模型派生，依赖 ./services、../localTranslation 与 ../doubaoSeedTranslation；不引入界面选项、译文样式或语言标签。
 */

import {DOUBAO_SEED_TRANSLATION_MODEL_ID} from '../doubaoSeedTranslation';
import {
    DEFAULT_LOCAL_TRANSLATION_MODEL,
    LOCAL_TRANSLATION_MODELS,
} from '../localTranslation';
import {customModelString, services} from './services';

// 2026-11-28 更新已核实的文本模型与默认档位，清理退役或过旧候选；历史选型依据见 docs/reports/model-catalog-20261103.md。
// 当前官方模型编号的单一来源，同时供列表和旧配置迁移使用。
export const currentModelIds = {
    openai: "gpt-5.6-luna",
    chatgptPlan: "", // 套餐模型依账户发现，不能用 API 模型目录代替。
    zhipu: "glm-5.3",
    zhipuFlash: "glm-4.5-flash",
    tongyiTokenPlan: "qwen3.8-max-preview",
    moonshot: "kimi-k3",
    moonshotCompatible: "kimi-k2.6",
    claude: "claude-fable-5",
    claudeSonnet: "claude-sonnet-5",
    claudeOpus: "claude-opus-5",
    claudeHaiku: "claude-haiku-5-5",
    deepseek: "deepseek-flash",
    infiniDeepseek: "deepseek-v4-flash",
    minimax: "MiniMax-M3",
    mimo: "mimo-v2.6-pro",
    jieyue: "step-3.7-flash",
    huanYuan: "hy4",
    grok: "grok-4.5",
    groqLarge: "openai/gpt-oss-120b",
    groqSmall: "openai/gpt-oss-20b",
    yiyan: "ernie-5.1",
    yiyanFast: "ernie-5.1",
    infiniZhipu: "glm-5.2",
    infiniGeneral: "qwen3.6-27b",
} as const;

// 各 AI 服务的开箱默认模型优先选择近期、低延迟或低成本档位。
// currentModelIds 仍作为官方编号与旧配置迁移的单一来源；用户仍可在模型列表中主动选择更大的模型。
export const defaultModelIds = {
    [services.openai]: "gpt-5.4-mini",
    [services.azureOpenai]: "gpt-5.4-mini",
    [services.gemini]: "gemini-3.5-flash-lite",
    [services.yiyan]: currentModelIds.yiyanFast,
    [services.tongyi]: "qwen3.8-flash",
    [services.zhipu]: currentModelIds.zhipuFlash,
    [services.moonshot]: currentModelIds.moonshotCompatible,
    [services.claude]: currentModelIds.claudeHaiku,
    [services.custom]: "gpt-5.4-mini",
    [services.infini]: currentModelIds.infiniDeepseek,
    [services.baichuan]: "Baichuan-M3",
    [services.lingyi]: "yi-lightning",
    [services.deepseek]: currentModelIds.deepseek,
    [services.minimax]: "MiniMax-M3.1-flash",
    [services.mimo]: "mimo-v2.6-flash",
    [services.jieyue]: currentModelIds.jieyue,
    [services.huanYuan]: "hy4-flash",
    [services.huanYuanTranslation]: "hunyuan-translation-lite",
    [services.localTranslation]: DEFAULT_LOCAL_TRANSLATION_MODEL,
    [services.newapi]: "gpt-5.4-mini",
    [services.grok]: "grok-4.3",
    [services.doubao]: "doubao-seed-2-1-lite-260915",
    [services.siliconCloud]: "deepseek-ai/DeepSeek-V4.1-Flash",
    [services.groq]: currentModelIds.groqSmall,
    [services.openrouter]: "google/gemini-3.5-flash-lite",
    // 兼容平台默认选择各家的低延迟档，翻译场景优先响应速度。
    [services.mistral]: "mistral-small-latest",
    [services.cohere]: "command-a-translate-08-2025",
    [services.cerebras]: currentModelIds.groqSmall,
    [services.togetherai]: "Qwen/Qwen3.5-9B",
    [services.fireworks]: "accounts/fireworks/models/gpt-oss-20b",
    [services.deepinfra]: "Qwen/Qwen3.5-9B",
    [services.perplexity]: "sonar",
    [services.runcrate]: "deepseek-ai/DeepSeek-V4.1-Flash",
    [services.cloudgpu]: "deepseek-v4.1-flash",
    [services.cheaperinference]: "gpt-5.4-mini",
    [services.cheapaimodel]: "deepseek-v4-1-flash",
    [services.ollama]: "gemma3:4b",
} as const;

export const models = new Map<string, Array<string>>([
    [services.chatgptPlan, []],
    [services.openai, [defaultModelIds[services.openai], "gpt-5.4-nano", "gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6.2-astra", "gpt-6-astra", currentModelIds.openai, "gpt-5.6-sol", "gpt-5.6-terra", customModelString]],
    [services.azureOpenai, [defaultModelIds[services.azureOpenai], "gpt-5.4-nano", "gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-sol", currentModelIds.openai, "gpt-5.6-sol", "gpt-5.6-terra", customModelString]],
    [services.gemini, [defaultModelIds[services.gemini], "gemini-3.8-flash", "gemini-4-argon", "gemini-3.6-flash", customModelString]],
    [services.yiyan, [defaultModelIds[services.yiyan], "ernie-5.5-flash-preview", "ernie-x1.1-preview", customModelString]],
    [services.tongyi, [defaultModelIds[services.tongyi], "qwen3.8-max", "qwen3.8-27b", "qwen3.8-2.4t-a95b", currentModelIds.tongyiTokenPlan, "qwen-mt-flash", "qwen-mt-turbo", "qwen-mt-plus", "qwen-mt-lite", "qwen-long-latest", customModelString]],
    [services.zhipu, [defaultModelIds[services.zhipu], "glm-5.3-flash", currentModelIds.zhipu, "glm-5.2", "glm-5-turbo", "glm-4.7", customModelString]],
    [services.moonshot, [defaultModelIds[services.moonshot], currentModelIds.moonshot, "kimi-k2.7-code-highspeed", "kimi-k2.7-code", "kimi-k2.5", customModelString]],
    [services.claude, [defaultModelIds[services.claude], "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-fable-5-1", currentModelIds.claude, currentModelIds.claudeOpus, currentModelIds.claudeSonnet, "claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4-6", customModelString]],
    [services.custom, [defaultModelIds[services.custom], "gpt-6-luna", currentModelIds.openai, "gemini-3.8-flash", "claude-haiku-5-5", "qwen3.8-flash", currentModelIds.deepseek, "gemma3:4b", "qwen3:8b", customModelString]],
    [services.infini, [defaultModelIds[services.infini], "deepseek-v4-pro", currentModelIds.infiniZhipu, "kimi-k2.7-code", currentModelIds.infiniGeneral, "qwen3.6-35b-a3b", customModelString]],
    [services.baichuan, [defaultModelIds[services.baichuan], "Baichuan-M3-Plus", "Baichuan4-Air", "Baichuan4-Turbo", "Baichuan4", customModelString]],
    [services.lingyi, [defaultModelIds[services.lingyi], customModelString]],
    // 旧 Flash 编号仍由官方兼容路由，保留它以维持已保存的模型与 Thinking 偏好。
    [services.deepseek, [currentModelIds.deepseek, "deepseek-v4-pro", "deepseek-v4-flash", customModelString]],
    [services.minimax, [defaultModelIds[services.minimax], currentModelIds.minimax, customModelString]],
    [services.mimo, [defaultModelIds[services.mimo], currentModelIds.mimo, customModelString]],
    [services.jieyue, [defaultModelIds[services.jieyue], "step-5-preview", "step-3.5-flash", "step-3", customModelString]],
    [services.huanYuan, [defaultModelIds[services.huanYuan], currentModelIds.huanYuan, "hy3", customModelString]],
    [services.huanYuanTranslation, [defaultModelIds[services.huanYuanTranslation], "hunyuan-translation", customModelString]],
    [services.localTranslation, [...LOCAL_TRANSLATION_MODELS.map((model) => model.value), customModelString]],
    [services.newapi, [defaultModelIds[services.newapi], "gpt-6-luna", currentModelIds.openai, "gemini-3.8-flash", "gemini-3.5-flash-lite", "claude-haiku-5-5", "claude-sonnet-5-5", "qwen3.8-flash", currentModelIds.deepseek, "kimi-k2.7-code", customModelString]],
    [services.grok, [defaultModelIds[services.grok], "grok-4.7", "grok-4.6", currentModelIds.grok, customModelString]],
    [services.doubao, [defaultModelIds[services.doubao], "doubao-seed-2-1-pro-260915", "doubao-seed-2-1-turbo-260628", "doubao-seed-evolving", DOUBAO_SEED_TRANSLATION_MODEL_ID, customModelString]],

    // 混合模型。
    [services.siliconCloud, [defaultModelIds[services.siliconCloud], "Qwen/Qwen3.8-27B", "deepseek-ai/DeepSeek-V4-Pro", "zai-org/GLM-5.2", "deepseek-ai/DeepSeek-V4-Flash", customModelString]],

    // 旧 Qwen 仅对部分企业账户继续可用，保留以免破坏已保存的选择。
    [services.groq, [defaultModelIds[services.groq], currentModelIds.groqLarge, "qwen/qwen3.8-27b", "qwen/qwen3.6-27b", customModelString]],
    [services.openrouter, [defaultModelIds[services.openrouter], "qwen/qwen3.8-flash", "google/gemini-4-argon", "openai/gpt-6-luna", "openai/gpt-6.1-sol", "anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "anthropic/claude-fable-5.2", "stepfun/step-3.7-flash", "deepseek/deepseek-v4.1-flash", "openai/gpt-5.4-mini", "openai/gpt-6-astra", "x-ai/grok-4.7", "x-ai/grok-4.6", "openrouter/auto", "moonshotai/kimi-k3", "z-ai/glm-5.2", customModelString]],

    // 支持的 OpenAI 兼容平台。列表只放各家稳定的公开编号，
    // 平台上新更快，用户可以随时用“自定义模型”补充。
    [services.mistral, [
        defaultModelIds[services.mistral], "mistral-large-4", "mistral-medium-latest",
        "mistral-large-latest", "magistral-small-latest", "open-mistral-nemo",
        "zai-glm-5-3", "zai-glm-5-3-flash", "deepseek-v4-1-flash-1017", customModelString,
    ]],
    [services.cohere, [defaultModelIds[services.cohere], "command-a-03-2025", "command-r7b-12-2024", "command-r-plus", customModelString]],
    [services.cerebras, [defaultModelIds[services.cerebras], currentModelIds.groqLarge, "qwen-3-32b", "llama-3.3-70b", customModelString]],
    [services.togetherai, [defaultModelIds[services.togetherai], "Qwen/Qwen3.8-27B", "Qwen/Qwen3.5-35B-A3B", customModelString]],
    [services.fireworks, [defaultModelIds[services.fireworks], "accounts/fireworks/models/gpt-oss-120b", "accounts/fireworks/models/qwen3-30b-a3b", "accounts/fireworks/models/deepseek-v3p2", customModelString]],
    [services.deepinfra, [defaultModelIds[services.deepinfra], "Qwen/Qwen3.8-27B", "Qwen/Qwen3.5-35B-A3B", customModelString]],
    [services.perplexity, [defaultModelIds[services.perplexity], "sonar-pro", "sonar-reasoning", customModelString]],
    [services.runcrate, [defaultModelIds[services.runcrate], "zai-org/GLM-5.3-Flash", "Qwen/Qwen3.8-Flash", "openai/gpt-oss-120b", customModelString]],
    [services.cloudgpu, [defaultModelIds[services.cloudgpu], "kimi-k3", "qwen3.6-35b", customModelString]],
    [services.cheaperinference, [defaultModelIds[services.cheaperinference], "deepseek-v4-flash", "glm-5.3", "claude-sonnet-5", customModelString]],
    [services.cheapaimodel, [defaultModelIds[services.cheapaimodel], "glm-5.3-flash", "glm-5.3", customModelString]],
    [services.ollama, [defaultModelIds[services.ollama], "qwen3:8b", "gemma3:12b", "qwen3.8:27b", "qwen3.8-flash-next:125b-a6b-q4_K_M", "qwen3.8-flash-next:125b-mlx", customModelString]],
    [services.rapidmlx, [customModelString]],
]);

// 每个需要模型选择的 AI 服务都把列表第一项作为开箱即用的默认模型。
// 统一从模型列表生成，避免设置页、配置初始化和请求模板各自维护一份默认值。
export function firstConfiguredModel(modelOptions: readonly string[]): string {
    return modelOptions[0] || '';
}

export const defaultModels = new Map<string, string>(
    Array.from(models.entries())
        .map(([service, modelOptions]) => [service, firstConfiguredModel(modelOptions)] as [string, string])
        .filter(([, model]) => Boolean(model)),
);

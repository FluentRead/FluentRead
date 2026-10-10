/**
 * @file src/features/input-translation/background/handler.ts
 * 文件职责：定义输入框快捷翻译的后台消息处理器，在调用共享翻译 broker 前校验原文和目标语言，并统一返回成功译文结构。
 * 主要内容：包含 inputBoxTranslation 消息常量、请求/响应与依赖接口、非空字符串解析，以及 createInputBoxTranslationHandler 工厂对本地配置快照和共享翻译 broker 的薄编排；隐私仅来自可信 sender/platform 上下文。
 * 模块边界：此文件不监听键盘、不修改输入框也不绑定具体 provider；content feature 负责触发和提交，翻译实现由 background composition root 注入，统一路由负责错误响应。网页消息只能携带纯文本和目标语言，服务、模型、提示词与凭据均从后台配置读取。
 */
import {servicesType, resolveConfiguredModel} from '@/src/core/config/catalog';
import {Config} from '@/src/core/config/model';
import {
    DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT,
    completeInputBoxTranslationPrompt,
    normalizeInputBoxTranslationModel,
    normalizeInputBoxTranslationPrompt,
    normalizeInputBoxTranslationService,
    supportsInputBoxTranslationPrompt,
} from '@/src/core/config/inputTranslation';
import {
    attachTranslationProviderConfig,
    attachTranslationGlossaryContext,
    translationPrivacyContext,
    type TrustedTranslationSenderContext,
    createTranslationProviderConfigSnapshot,
} from '@/src/services/translation/requestSnapshot';
import type {TranslationSingleRequestMessage} from '@/src/services/translation/types';
export const INPUT_BOX_TRANSLATION_MESSAGE_TYPE = 'inputBoxTranslation' as const;

export interface InputBoxTranslationMessage {
    type: typeof INPUT_BOX_TRANSLATION_MESSAGE_TYPE;
    text?: unknown;
    targetLang?: unknown;
}

export interface InputBoxTranslationResponse {
    success: true;
    translatedText: string;
}

export interface InputBoxTranslationDependencies {
    readonly ready: Promise<unknown>;
    readonly getConfig: () => Config;
    readonly translate: (message: TranslationSingleRequestMessage) => Promise<string | string[]>;
}

export interface InputBoxTranslationHandler {
    readonly type: typeof INPUT_BOX_TRANSLATION_MESSAGE_TYPE;
    handle(message: InputBoxTranslationMessage, context?: TrustedTranslationSenderContext): Promise<InputBoxTranslationResponse>;
}

function parseRequiredString(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new TypeError(`输入框翻译 ${field} 必须是字符串`);
    if (!value.trim()) throw new TypeError(`输入框翻译 ${field} 不能为空`);
    return field === 'targetLang' ? value.trim() : value;
}

/**
 * 从本地配置按独立选择或网页默认建立输入框翻译 provider snapshot。
 * 只有通用提示词型 AI 服务接收输入框 prompt；机器翻译和原生 MT 模型沿用原配置，
 * 从而不会把无效的提示词或模型设置误传给不支持它们的 provider。
 */
export function createInputBoxTranslationRequest(
    current: Config,
    text: string,
    targetLanguage: string,
): TranslationSingleRequestMessage {
    const service = normalizeInputBoxTranslationService(
        current.inputBoxTranslationService,
        current.customOpenAIProviders,
    ) || current.service;
    const model = normalizeInputBoxTranslationModel(current.inputBoxTranslationModel);
    const configuredModel = resolveConfiguredModel(current.model[service], current.customModel[service]);
    const effectiveModel = model || configuredModel;
    const promptEnabled = supportsInputBoxTranslationPrompt(service, effectiveModel);
    const snapshotSource = {
        ...current,
        ...(promptEnabled ? {
            system_role: {
                ...current.system_role,
                [service]: normalizeInputBoxTranslationPrompt(current.inputBoxTranslationSystemPrompt)
                    .trim() || DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT,
            },
            user_role: {
                ...current.user_role,
                [service]: completeInputBoxTranslationPrompt(current.inputBoxTranslationPrompt),
            },
        } : {}),
    };
    const snapshot = createTranslationProviderConfigSnapshot(snapshotSource);
    return attachTranslationProviderConfig({
        origin: text,
        sourceLanguage: 'auto',
        targetLanguage,
        enableAIContext: false,
        glossaryIds: [],
        serviceOverride: service,
        ...(servicesType.isUseModel(service) && model ? {modelOverride: model} : {}),
        useCache: current.useCache,
    }, snapshot);
}

/** 创建输入框翻译 handler；服务、模型、提示词和凭据均由后台配置快照决定。 */
export function createInputBoxTranslationHandler(
    dependencies: InputBoxTranslationDependencies,
): InputBoxTranslationHandler {
    return {
        type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE,
        async handle(message, context) {
            // 步骤 1：页面消息先经过严格协议收窄，避免对象、HTML 或空值进入翻译 broker。
            const text = parseRequiredString(message.text, 'text');
            const targetLanguage = parseRequiredString(message.targetLang, 'targetLang');

            await dependencies.ready;
            // 步骤 2：服务、模型、提示词和凭据均从配置读取，并在任何 await 前冻结。
            const request = createInputBoxTranslationRequest(dependencies.getConfig(), text, targetLanguage);
            const result = await dependencies.translate(attachTranslationGlossaryContext(request, translationPrivacyContext(context)));
            const translatedText = Array.isArray(result) ? result[0] : result;
            if (typeof translatedText !== 'string' || !translatedText.trim()) {
                throw new Error('输入框翻译未返回有效译文');
            }
            return {success: true, translatedText};
        },
    };
}

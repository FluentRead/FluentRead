/**
 * @file src/features/input-translation/background/handler.ts
 * 文件职责：定义输入框快捷翻译的后台消息处理器，在调用共享翻译 broker 前校验原文和目标语言，并统一返回成功译文结构。
 * 主要内容：包含 inputBoxTranslation 消息常量、请求/响应与依赖接口、非空字符串、可选请求标识和有界超时解析，按发送者注册可取消请求，在配置水合和共享翻译 broker 调用期间响应取消，先按可信隐私身份确定有效服务，再绑定输入提示词并冻结服务配置与超时快照；可信属于本次目标的普通文本直接保留原文。
 * 模块边界：此文件不监听键盘、不修改输入框也不绑定具体 provider；content feature 负责触发和提交，翻译实现与请求注册表由 composition root 注入，统一路由负责错误响应。网页消息只能携带纯文本、目标语言、取消标识和不超出配置的请求预算，服务、模型、提示词与凭据均从后台配置读取。
 */
import {servicesType, resolveConfiguredModel} from '@/src/core/config/catalog';
import {Config} from '@/src/core/config/model';
import {MAX_AI_REQUEST_TIMEOUT_MS, normalizeAiRequestTimeoutMs} from '@/src/core/config/aiRequestTimeout';
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {
    DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT,
    completeInputBoxTranslationPrompt,
    normalizeInputBoxTranslationModel,
    normalizeInputBoxTranslationPrompt,
    normalizeInputBoxTranslationService,
    supportsInputBoxTranslationPrompt,
} from '@/src/core/config/inputTranslation';
import {
    attachTranslationGlossaryContext,
    translationPrivacyContext,
    attachTranslationProviderConfig,
    attachTranslationRequestControl,
    createTranslationProviderConfigSnapshot,
} from '@/src/services/translation/requestSnapshot';
import {resolvePrivateTranslation} from '@/src/services/translation/privateRouting';
import type {TrustedTranslationGlossaryContext} from '@/src/services/translation/requestSnapshot';
import type {TranslationRequestControl} from '@/src/services/translation/types';
import type {TranslationSingleRequestMessage} from '@/src/services/translation/types';
export const INPUT_BOX_TRANSLATION_MESSAGE_TYPE = 'inputBoxTranslation' as const;

export interface InputBoxTranslationMessage {
    type: typeof INPUT_BOX_TRANSLATION_MESSAGE_TYPE;
    text?: unknown;
    targetLang?: unknown;
    clientRequestId?: unknown;
    requestTimeoutMs?: unknown;
}

/** 仅约束 composition root 提供的发送者上下文，不依赖 app 的具体后台实现。 */
export interface InputBoxTranslationRequestContext {
    sender?: {
        id?: string;
        url?: string;
        frameId?: number;
        documentId?: string;
        tab?: {id?: number; incognito?: boolean};
    };
}

/** 复用共享取消注册表；feature 只消费 run，不拥有其它入口的请求。 */
export interface InputBoxTranslationRequestRegistry {
    run<T>(clientRequestId: string, context: InputBoxTranslationRequestContext, operation: (
        signal: AbortSignal,
        ownershipKey: string,
    ) => Promise<T>): Promise<T>;
}

export interface InputBoxTranslationResponse {
    success: true;
    translatedText: string;
}

export interface InputBoxTranslationDependencies {
    readonly ready: Promise<unknown>;
    readonly getConfig: () => Config;
    readonly translate: (message: TranslationSingleRequestMessage) => Promise<string | string[]>;
    readonly requestRegistry?: InputBoxTranslationRequestRegistry;
}

export interface InputBoxTranslationHandler {
    readonly type: typeof INPUT_BOX_TRANSLATION_MESSAGE_TYPE;
    handle(message: InputBoxTranslationMessage, context?: InputBoxTranslationRequestContext): Promise<InputBoxTranslationResponse>;
}

function parseRequiredString(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new TypeError(`输入框翻译 ${field} 必须是字符串`);
    if (!value.trim()) throw new TypeError(`输入框翻译 ${field} 不能为空`);
    return field === 'targetLang' ? value.trim() : value;
}

function parseClientRequestId(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
        throw new TypeError('输入框翻译 clientRequestId 格式无效');
    }
    return value;
}

function parseRequestTimeoutMs(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > MAX_AI_REQUEST_TIMEOUT_MS) {
        throw new TypeError('输入框翻译 requestTimeoutMs 必须是有效的正数预算');
    }
    return Math.floor(value);
}

function createAbortError(): Error {
    const error = new Error('输入框翻译已取消');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw createAbortError();
}

/** 配置水合之前也响应取消，取消后不读取配置或启动 provider。 */
async function waitForReady(ready: Promise<unknown>, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!signal) {
        await ready;
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        signal.addEventListener('abort', onAbort, {once: true});
        ready.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
    throwIfAborted(signal);
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
    requestTimeoutMs?: number,
    privacyContext: TrustedTranslationGlossaryContext = {},
): TranslationSingleRequestMessage {
    const normalService = normalizeInputBoxTranslationService(
        current.inputBoxTranslationService,
        current.customOpenAIProviders,
        current.compositeTranslationProviders,
    ) || current.service;
    const normalModel = normalizeInputBoxTranslationModel(current.inputBoxTranslationModel);
    // 先解析可信路由，再把输入提示词绑定到有效服务；broker 仍复核同一不可变路由，不复制 feature 提示词。
    const routed = resolvePrivateTranslation(createTranslationProviderConfigSnapshot(current),
        attachTranslationGlossaryContext({origin: text, serviceOverride: normalService,
            ...(servicesType.isUseModel(normalService) && normalModel ? {modelOverride: normalModel} : {})}, privacyContext));
    const service = routed.request.serviceOverride!;
    const model = routed.request.modelOverride;
    const effective = routed.config;
    const configuredModel = resolveConfiguredModel(effective.model[service], effective.customModel[service]);
    const effectiveModel = model || configuredModel;
    const promptEnabled = supportsInputBoxTranslationPrompt(service, effectiveModel);
    const snapshotSource = {
        ...effective,
        ...(promptEnabled ? {
            system_role: {
                ...effective.system_role,
                [service]: normalizeInputBoxTranslationPrompt(current.inputBoxTranslationSystemPrompt)
                    .trim() || DEFAULT_INPUT_BOX_TRANSLATION_SYSTEM_PROMPT,
            },
            user_role: {
                ...effective.user_role,
                [service]: completeInputBoxTranslationPrompt(current.inputBoxTranslationPrompt),
            },
        } : {}),
    };
    const snapshot = createTranslationProviderConfigSnapshot(snapshotSource);
    const configuredTimeoutMs = servicesType.isAI(service) ? normalizeAiRequestTimeoutMs(snapshot.aiRequestTimeoutMs) : 45_000;
    return attachTranslationGlossaryContext(attachTranslationProviderConfig({
        origin: text,
        sourceLanguage: 'auto',
        targetLanguage,
        enableAIContext: false,
        glossaryIds: [],
        serviceOverride: service,
        ...(servicesType.isUseModel(service) && model ? {modelOverride: model} : {}),
        useCache: effective.useCache,
        requestTimeoutMs: Math.min(configuredTimeoutMs, requestTimeoutMs ?? configuredTimeoutMs),
    }, snapshot), privacyContext);
}

/** 创建输入框翻译 handler；服务、模型、提示词和凭据均由后台配置快照决定。 */
export function createInputBoxTranslationHandler(
    dependencies: InputBoxTranslationDependencies,
): InputBoxTranslationHandler {
    return {
        type: INPUT_BOX_TRANSLATION_MESSAGE_TYPE,
        async handle(message, context = {}) {
            const privacyContext = translationPrivacyContext(context);
            // 步骤 1：页面消息先经过严格协议收窄，避免对象、HTML 或空值进入翻译 broker。
            const text = parseRequiredString(message.text, 'text');
            const targetLanguage = parseRequiredString(message.targetLang, 'targetLang');
            const clientRequestId = parseClientRequestId(message.clientRequestId);
            const requestTimeoutMs = parseRequestTimeoutMs(message.requestTimeoutMs);
            const translate = async (control?: TranslationRequestControl): Promise<InputBoxTranslationResponse> => {
                const signal = control?.signal;
                await waitForReady(dependencies.ready, signal);
                // 步骤 2：服务、模型、提示词和凭据均从配置读取，并在 provider await 前冻结。
                const request = createInputBoxTranslationRequest(dependencies.getConfig(), text, targetLanguage, requestTimeoutMs, privacyContext);
                if (control) attachTranslationRequestControl(request, control);
                if (shouldSkipTranslationForTarget(text, targetLanguage)) {
                    throwIfAborted(signal);
                    return {success: true, translatedText: text};
                }
                const result = await dependencies.translate(request);
                throwIfAborted(signal);
                const translatedText = Array.isArray(result) ? result[0] : result;
                if (typeof translatedText !== 'string' || !translatedText.trim()) {
                    throw new Error('输入框翻译未返回有效译文');
                }
                return {success: true, translatedText};
            };
            if (!clientRequestId) return translate();
            if (!dependencies.requestRegistry) throw new Error('输入框翻译取消注册表未配置');
            return dependencies.requestRegistry.run(clientRequestId, context,
                (signal, ownershipKey) => translate({signal, ownershipKey}));
        },
    };
}

/**
 * @file src/providers/translation/chrome-translator.ts
 *
 * 文件职责：适配 Chrome 和 Edge 的 Translator API，通过离屏文档执行浏览器内置翻译。
 * 主要内容：createChromeTranslator 注入能力、OffscreenClient 与待准备语言存储，校验响应身份和实际缺包语言对，在未取消时保存待准备记录，默认实例使用请求级语言 payload。
 * 模块边界：本文件位于 provider 适配层，只把统一翻译请求转换为外部或浏览器服务协议；不管理页面 DOM、UI 生命周期或配置持久化，缓存、去重和超时总预算由 translation broker 统一协调。
 */

import {abortErrorFromSignal} from '@/src/platform/http/runtime';
import {requireTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import {BROWSER_TRANSLATOR_UNAVAILABLE_MESSAGE} from '@/src/services/translation/capabilities';
import {BROWSER_TRANSLATION_PREPARATION_REQUIRED, BROWSER_TRANSLATION_UNAVAILABLE} from '@/src/services/translation/errors';
import {
    browserCapabilities,
    type BrowserCapabilities,
} from '@/src/platform/browser/capabilities';
import {
    chromeOffscreenClient,
    OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE,
    type OffscreenClient,
} from '@/src/platform/offscreen/client';
import {
    chromeTranslationPreparationStore,
    isChromeTranslationPreparationRequest,
} from '@/src/platform/browser/chromeTranslationPreparationRequest';
import {
    buildChromeOffscreenTranslationData,
    type ChromeTranslatorMessage,
} from './chromeTranslatorRequest';

interface ChromeTranslationOffscreenResponse {
    readonly success?: boolean;
    readonly result?: unknown;
    readonly error?: string;
    readonly errorCode?: string;
    readonly errorName?: string;
    readonly sourceLanguage?: string;
    readonly targetLanguage?: string;
    readonly requestId?: unknown;
}

// 首次创建语言包可能包含下载；与 Offscreen client 的受控上限保持一致。
const DEFAULT_CHROME_TRANSLATION_TIMEOUT_MS = 300_000;

export interface ChromeTranslatorDependencies {
    readonly capabilities: Pick<BrowserCapabilities, 'browserTranslation'>;
    readonly offscreenClient: Pick<OffscreenClient, 'send'>;
    readonly createRequestId: () => string;
    readonly preparationStore?: Pick<typeof chromeTranslationPreparationStore, 'set'>;
}

export function createChromeTranslationRequestId(): string {
    return crypto.randomUUID();
}

/** 原生翻译 provider，沿用已有服务 ID 和离屏消息协议。 */
export function createChromeTranslator(dependencies: ChromeTranslatorDependencies) {
    return async (message: ChromeTranslatorMessage): Promise<string> => {
        if (typeof message.origin !== 'string' || !message.origin.trim()) {
            throw new Error('翻译文本不能为空');
        }
        if (!dependencies.capabilities.browserTranslation) {
            throw Object.assign(new Error(BROWSER_TRANSLATOR_UNAVAILABLE_MESSAGE), {
                code: BROWSER_TRANSLATION_UNAVAILABLE, retryable: false,
            });
        }

        try {
            if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
            const current = requireTranslationProviderConfig(message);
            const requestId = dependencies.createRequestId();
            const response = await dependencies.offscreenClient.send<ChromeTranslationOffscreenResponse>({
                type: 'CHROME_TRANSLATE_OFFSCREEN',
                requestId,
                data: buildChromeOffscreenTranslationData(message, {
                    sourceLanguage: current.from,
                    targetLanguage: current.to,
                }),
            }, {
                signal: message.abortSignal,
                timeoutMs: typeof message.requestTimeoutMs === 'number'
                    ? message.requestTimeoutMs
                    : DEFAULT_CHROME_TRANSLATION_TIMEOUT_MS,
                cancelMessage: {
                    type: OFFSCREEN_CANCEL_CHROME_TRANSLATION_MESSAGE_TYPE,
                    requestId,
                },
            });
            if (message.abortSignal?.aborted) throw abortErrorFromSignal(message.abortSignal);
            if (response?.requestId !== requestId) throw new Error('Offscreen 翻译响应 requestId 不匹配');
            if (!response.success || typeof response.result !== 'string') {
                if (response.errorCode === 'preparation-required') {
                    const preparation = {
                        sourceLanguage: response.sourceLanguage,
                        targetLanguage: response.targetLanguage,
                    };
                    if (isChromeTranslationPreparationRequest(preparation)) {
                        await (dependencies.preparationStore || chromeTranslationPreparationStore).set(preparation);
                    }
                    throw Object.assign(
                        new Error(response.error || '请在「浏览器内置翻译」中点击「准备语言包」后重试。'),
                        {code: BROWSER_TRANSLATION_PREPARATION_REQUIRED, retryable: false},
                    );
                }
                const unavailable = new Error(response?.error || '无效的翻译响应');
                if (response.errorCode === 'model-unavailable' || response.errorCode === 'api-unavailable') {
                    Object.assign(unavailable, {
                        name: response.errorName || 'ChromeModelUnavailableError',
                        code: BROWSER_TRANSLATION_UNAVAILABLE,
                        retryable: false,
                    });
                }
                throw unavailable;
            }
            return response.result;
        } catch (error) {
            const message = error instanceof Error ? error.message : '未知错误';
            if (error instanceof Error && 'retryable' in error && error.retryable === false) throw error;
            const wrapped = new Error(`浏览器内置翻译失败：${message}`);
            if (error instanceof Error) wrapped.name = error.name;
            throw wrapped;
        }
    };
}

const chromeTranslator = createChromeTranslator({
    capabilities: browserCapabilities,
    offscreenClient: chromeOffscreenClient,
    createRequestId: createChromeTranslationRequestId,
    preparationStore: chromeTranslationPreparationStore,
});

export default chromeTranslator;

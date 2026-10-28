import {withProviderSnapshot} from './helpers/providerSnapshot';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    config: {from: 'auto', to: 'zh-Hans'},
    createRequestId: vi.fn(() => 'chrome-request-1'),
    send: vi.fn(),
}));

vi.mock('webextension-polyfill', () => ({default: {storage: {
    session: {get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), remove: vi.fn(async () => undefined)},
    onChanged: {addListener: vi.fn(), removeListener: vi.fn()},
}}}));

vi.mock('@/src/services/config/store', () => ({config: mocks.config}));

import defaultChromeTranslator, {
    createChromeTranslationRequestId,
    createChromeTranslator,
} from '@/src/providers/translation/chrome-translator';
import {buildChromeOffscreenTranslationData} from '@/src/providers/translation/chromeTranslatorRequest';
import browser from 'webextension-polyfill';

const chromeTranslator = createChromeTranslator({
    capabilities: {chromeTranslation: true},
    offscreenClient: {send: mocks.send},
    createRequestId: mocks.createRequestId,
});

describe('Chrome translator 请求级语言回归', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.send.mockReset();
        Object.assign(mocks.config, {from: 'auto', to: 'zh-Hans'});
        mocks.createRequestId.mockReturnValue('chrome-request-1');
        mocks.send.mockImplementation(async (request: {requestId?: unknown}) => ({
            success: true,
            result: '翻译结果',
            requestId: request.requestId,
        }));
    });

    it('纯 payload builder 保留标记正文与独立检测样本，并只在 auto 源语言下携带样本', () => {
        const markedText = [
            '___FLUENTREAD_test_0_BEGIN___',
            'Bonjour le monde.',
            '___FLUENTREAD_test_0_END___',
        ].join('\n');
        expect(buildChromeOffscreenTranslationData({
            origin: markedText,
            sourceLanguage: 'auto',
            targetLanguage: 'zh-Hans',
            sourceLanguageDetectionText: 'Bonjour le monde.',
        }, {sourceLanguage: 'en', targetLanguage: 'ja'})).toEqual({
            text: markedText,
            from: 'auto',
            to: 'zh-Hans',
            sourceLanguageDetectionText: 'Bonjour le monde.',
        });
        expect(buildChromeOffscreenTranslationData({
            origin: 'hello',
            sourceLanguage: ' en ',
            targetLanguage: ' ja ',
            sourceLanguageDetectionText: 'Bonjour le monde.',
        }, {sourceLanguage: 'auto', targetLanguage: 'zh-Hans'})).toEqual({
            text: 'hello', from: 'en', to: 'ja',
        });
        expect(buildChromeOffscreenTranslationData({
            origin: 'hello', sourceLanguage: ' ', targetLanguage: undefined,
        }, {sourceLanguage: 'auto', targetLanguage: 'zh-Hans'})).toEqual({
            text: 'hello', from: 'auto', to: 'zh-Hans',
        });
        expect(() => buildChromeOffscreenTranslationData({origin: null}, {
            sourceLanguage: 'auto', targetLanguage: 'zh-Hans',
        })).toThrow('翻译文本不能为空');
        expect(() => buildChromeOffscreenTranslationData({origin: '   '}, {
            sourceLanguage: 'auto', targetLanguage: 'zh-Hans',
        })).toThrow('翻译文本不能为空');
        expect(() => buildChromeOffscreenTranslationData({
            origin: 'hello',
            sourceLanguageDetectionText: ['forged'],
        }, {sourceLanguage: 'auto', targetLanguage: 'zh-Hans'})).toThrow('检测文本必须是字符串');
    });

    it('真实 provider 发往 offscreen 的标记正文和纯检测样本彼此独立，并为首次下载保留五分钟', async () => {
        const markedText = '___FLUENTREAD_test_0_BEGIN___\nBonjour\n___FLUENTREAD_test_0_END___';
        await expect(chromeTranslator(withProviderSnapshot({
            origin: markedText,
            sourceLanguage: 'auto',
            targetLanguage: 'ja',
            sourceLanguageDetectionText: 'Bonjour',
        }, mocks.config))).resolves.toBe('翻译结果');

        expect(mocks.send).toHaveBeenCalledWith({
            type: 'CHROME_TRANSLATE_OFFSCREEN',
            requestId: 'chrome-request-1',
            data: {
                text: markedText,
                from: 'auto',
                to: 'ja',
                sourceLanguageDetectionText: 'Bonjour',
            },
        }, {
            signal: undefined,
            timeoutMs: 300_000,
            cancelMessage: {
                type: 'CANCEL_CHROME_TRANSLATE_OFFSCREEN',
                requestId: 'chrome-request-1',
            },
        });
    });

    it('未覆盖语言时仍使用当前配置，非法原文不会发消息', async () => {
        await expect(chromeTranslator(withProviderSnapshot({origin: 'hello'}, mocks.config))).resolves.toBe('翻译结果');
        expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({
            data: {text: 'hello', from: 'auto', to: 'zh-Hans'},
        }), expect.any(Object));

        mocks.send.mockClear();
        await expect(chromeTranslator(withProviderSnapshot({origin: ''}, mocks.config))).rejects.toThrow('翻译文本不能为空');
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('默认 unknown 构建保守拒绝 Chrome provider，且不会触碰 Offscreen', async () => {
        await expect(defaultChromeTranslator(withProviderSnapshot({origin: 'hello'}, mocks.config)))
            .rejects.toThrow('当前浏览器不支持 Chrome 内置翻译');
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('AbortSignal 仅作为 client 控制参数传递，runtime payload 保持可克隆', async () => {
        const controller = new AbortController();
        let receivedOptions: {signal?: AbortSignal} | undefined;
        mocks.send.mockImplementationOnce((_request: unknown, options: {signal?: AbortSignal}) => {
            receivedOptions = options;
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {once: true});
            });
        });

        const pending = chromeTranslator(withProviderSnapshot({
            origin: 'hello',
            abortSignal: controller.signal,
            requestTimeoutMs: 1_234,
        }, mocks.config));
        await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
        const [runtimePayload, options] = mocks.send.mock.calls[0] as unknown as [
            Record<string, unknown>,
            Record<string, unknown>,
        ];
        expect(runtimePayload).not.toHaveProperty('abortSignal');
        expect(runtimePayload).toEqual(expect.objectContaining({requestId: 'chrome-request-1'}));
        expect(options).toMatchObject({signal: controller.signal, timeoutMs: 1_234});
        expect(receivedOptions?.signal).toBe(controller.signal);

        controller.abort();
        await expect(pending).rejects.toThrow('Chrome Translation API 不可用：cancelled');
    });

    it('拒绝缺失或错配 requestId 的迟到响应', async () => {
        mocks.send.mockResolvedValueOnce({success: true, result: '旧结果', requestId: 'old-request'});
        await expect(chromeTranslator(withProviderSnapshot({origin: 'hello'}, mocks.config))).rejects.toThrow('requestId 不匹配');

        mocks.send.mockResolvedValueOnce({success: false, error: '请求已取消', requestId: 'chrome-request-1'});
        await expect(chromeTranslator(withProviderSnapshot({origin: 'hello'}, mocks.config))).rejects.toThrow('请求已取消');

        mocks.send.mockResolvedValueOnce({success: false, requestId: 'chrome-request-1'});
        await expect(chromeTranslator(withProviderSnapshot({origin: 'hello'}, mocks.config))).rejects.toThrow('无效的翻译响应');

        mocks.send.mockRejectedValueOnce('string failure');
        await expect(chromeTranslator(withProviderSnapshot({origin: 'hello'}, mocks.config))).rejects.toThrow('未知错误');
    });

    it('收到待准备 pair 时写入 session 状态，取消请求不写入', async () => {
        const set = vi.fn(async () => undefined);
        const provider = createChromeTranslator({
            capabilities: {chromeTranslation: true},
            offscreenClient: {send: mocks.send},
            createRequestId: mocks.createRequestId,
            preparationStore: {set},
        });
        mocks.send.mockResolvedValueOnce({
            success: false,
            requestId: 'chrome-request-1',
            errorCode: 'preparation-required',
            errorName: 'ChromePreparationRequiredError',
            sourceLanguage: 'en',
            targetLanguage: 'zh',
            error: 'prepare',
        });
        await expect(provider(withProviderSnapshot({origin: 'hello'}, mocks.config))).rejects.toThrow('prepare');
        expect(set).toHaveBeenCalledWith({sourceLanguage: 'en', targetLanguage: 'zh'});

        set.mockClear();
        const controller = new AbortController();
        controller.abort();
        mocks.send.mockClear();
        await expect(provider(withProviderSnapshot({origin: 'hello', abortSignal: controller.signal}, mocks.config))).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.send).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();
    });

    it('不保存无效的待准备语言对，并向调用者提供缺省提示', async () => {
        const set = vi.fn(async () => undefined);
        const provider = createChromeTranslator({
            capabilities: {chromeTranslation: true}, offscreenClient: {send: mocks.send},
            createRequestId: mocks.createRequestId, preparationStore: {set},
        });
        mocks.send.mockResolvedValueOnce({
            success: false, requestId: 'chrome-request-1', errorCode: 'preparation-required',
            sourceLanguage: 'auto', targetLanguage: 'zh',
        });
        await expect(provider(withProviderSnapshot({origin: 'hello'}, mocks.config)))
            .rejects.toThrow('Chrome 本地翻译模型需要用户激活');
        expect(set).not.toHaveBeenCalled();
    });

    it('未注入准备存储时使用生产会话存储，保存规范化语言对', async () => {
        mocks.send.mockResolvedValueOnce({
            success: false, requestId: 'chrome-request-1', errorCode: 'preparation-required',
            sourceLanguage: 'en', targetLanguage: 'zh-Hans', error: 'prepare',
        });
        await expect(chromeTranslator(withProviderSnapshot({origin: 'hello'}, mocks.config)))
            .rejects.toThrow('prepare');
        expect(browser.storage.session.set).toHaveBeenCalledWith({
            'fluentread.chromeTranslationPreparation.en:zh': {
                sourceLanguage: 'en', targetLanguage: 'zh', updatedAt: expect.any(Number),
            },
        });
    });

    it('生产 requestId 使用浏览器安全随机 UUID', () => {
        const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000001');
        vi.stubGlobal('crypto', {randomUUID});
        expect(createChromeTranslationRequestId()).toBe('00000000-0000-4000-8000-000000000001');
        expect(randomUUID).toHaveBeenCalledOnce();
    });
});

it('Chrome provider 请求级简繁体互译不被全局目标覆盖', async () => {
    mocks.send.mockReset();
    mocks.send.mockImplementation(async (request: {requestId?: unknown}) => ({success: true, result: '繁體譯文', requestId: request.requestId}));
    await expect(chromeTranslator(withProviderSnapshot({origin: '简体中文', sourceLanguage: 'zh-Hans', targetLanguage: 'zh-Hant'}, mocks.config))).resolves.toBe('繁體譯文');
    expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({data: {text: '简体中文', from: 'zh-Hans', to: 'zh-Hant'}}), expect.any(Object));
});

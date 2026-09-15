/**
 * @file tests/translationVisionBroker.test.ts
 *
 * 文件职责：验证 broker 对受信图片请求的缓存、去重、取消和服务边界。
 * 主要内容：确认不同图片不会共享 pending/cache，图片请求不写缓存，并拒绝免费或 qwen-mt 服务。
 * 模块边界：使用依赖注入 provider/cache 替身，不访问网络和页面运行时。
 */
import {describe, expect, it, vi} from 'vitest';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {attachTranslationImageInput, attachTranslationRequestControl} from '@/src/services/translation/requestSnapshot';

const imgA = 'data:image/png;base64,iVBORw0KGgo=';
const imgB = 'data:image/png;base64,AAAAiVBORw0KGgo=';

function setup() {
    const config: any = {service: 'openai', from: 'en', to: 'zh-Hans', useCache: true, enableAIContext: true, model: {openai: 'gpt-4.1'}, customModel: {}, proxy: {}, custom: '', deeplx: '', newApiUrl: '', minimaxBillingPlan: 'payg', minimaxRegion: 'global', mimoBillingPlan: 'payg', mimoRegion: 'global', azureOpenaiEndpoint: '', customBody: {}, customHeaders: {}, system_role: {}, user_role: {}, deepseekApiType: 'chat', deepseekThinkingMode: 'disabled'};
    const cache = {get: vi.fn(async () => null), set: vi.fn(async () => true), clear: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined)};
    const provider = vi.fn(async (message: any) => `translated:${message.origin}`);
    const broker = createTranslationBroker({ready: Promise.resolve(), getConfig: () => config, providers: {openai: provider, deepseek: provider, tongyi: provider, freeTranslation: provider}, cache, serviceTypes: {machine: {has: (s: string) => s === 'freeTranslation'}, isAI: (s: string) => ['openai', 'deepseek', 'tongyi'].includes(s), isAiSdk: (s: string) => s === 'openai', isUseAIContext: () => false}, endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://ai.test'}), aiSdkTransportProfile: 'test'}, promptBuilder: {buildPageSummaryPrompt: (s: string) => s, buildPageSummarySystemPrompt: () => ''}, getMissingCredentialMessage: () => null, getTranslationLanguages: (o) => ({sourceLanguage: o?.sourceLanguage || 'en', targetLanguage: o?.targetLanguage || 'zh-Hans'}), resolveConfiguredModel: (s, c) => c || s || '', buildTranslationCacheKey: (v) => JSON.stringify(v)});
    return {config, cache, provider, broker};
}

function message(image: string, service = 'openai') {
    const value: any = {origin: 'text', serviceOverride: service, requestTimeoutMs: 2000};
    attachTranslationImageInput(value, image);
    return value;
}

describe('translation vision broker boundaries', () => {
    it('does not read/write cache and separates concurrent images', async () => {
        const {cache, provider, broker} = setup();
        const first = broker.translateWithCache(message(imgA));
        const second = broker.translateWithCache(message(imgB));
        await expect(Promise.all([first, second])).resolves.toEqual(['translated:text', 'translated:text']);
        expect(provider).toHaveBeenCalledTimes(2);
        expect(cache.get).not.toHaveBeenCalled();
        expect(cache.set).not.toHaveBeenCalled();
    });

    it('rejects free translation and keeps image absent from serialized message', async () => {
        const {broker} = setup();
        await expect(broker.translateWithCache(message(imgA, 'freeTranslation'))).rejects.toThrow('支持视觉输入');
        await expect(broker.translateWithCache(message(imgA, 'deepseek'))).rejects.toThrow('支持视觉输入');
        const qwen = message(imgA, 'tongyi');
        qwen.modelOverride = 'qwen-mt-plus';
        await expect(broker.translateWithCache(qwen)).rejects.toThrow('支持视觉输入');
    });

    it('returns empty image batches without provider work and rejects non-empty image batches', async () => {
        const {broker, provider} = setup();
        const empty: any = {origin: [], requestTimeoutMs: 2000};
        attachTranslationImageInput(empty, imgA);
        await expect(broker.translateWithCache(empty)).resolves.toEqual([]);
        const batch: any = {origin: ['one', 'two'], requestTimeoutMs: 2000};
        attachTranslationImageInput(batch, imgA);
        await expect(broker.translateWithCache(batch)).rejects.toThrow('单条原文');
        expect(provider).not.toHaveBeenCalled();
    });

    it('cancels before provider execution', async () => {
        const {provider, broker} = setup();
        const controller = new AbortController();
        controller.abort();
        const value: any = message(imgA);
        attachTranslationRequestControl(value, {signal: controller.signal, ownershipKey: 'cancel-test'});
        await expect(broker.translateWithCache(value)).rejects.toThrow('取消');
        expect(provider).not.toHaveBeenCalled();
    });
});

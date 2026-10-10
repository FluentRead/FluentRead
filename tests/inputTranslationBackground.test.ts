/**
 * @file tests/inputTranslationBackground.test.ts
 * 文件职责：验证输入框翻译后台 handler 从本地配置建立冻结独立请求，并拒绝网页侧伪造服务、模型或凭据。
 * 主要内容：覆盖 AI prompt 的默认与自定义变量、机器翻译忽略 prompt/model、源语言/上下文/词库隔离、缓存开关和 userscript 共用返回语义。
 * 模块边界：本文件使用内存 mock 翻译函数，不发起网络请求；provider 的真实协议由 translation broker 与 provider 专项测试负责。
 */
import {describe, expect, it, vi} from 'vitest';
import {Config} from '@/src/core/config/model';
import {services} from '@/src/core/config/catalog';
import {getTranslationProviderConfig} from '@/src/services/translation/requestSnapshot';
import type {TranslationSingleRequestMessage} from '@/src/services/translation/types';
import {
    createInputBoxTranslationHandler,
    createInputBoxTranslationRequest,
} from '@/src/features/input-translation/background/handler';

describe('输入框翻译后台配置绑定', () => {
    it.each([
        ['  修复保存记录后再次打开页面时内容丢失的问题。  ', 'zh-Hans', 'en'],
        ['You can return to your saved paragraphs after closing the browser.', 'en', 'zh-Hans'],
    ])('输入内容已是本次目标 %s → %s 时原文返回，切换目标 %s 后才调用服务', async (text, target, otherTarget) => {
        const config = new Config();
        config.to = otherTarget;
        const translate = vi.fn(async (_request: TranslationSingleRequestMessage) => '新的译文');
        const handler = createInputBoxTranslationHandler({ready: Promise.resolve(), getConfig: () => config, translate});
        await expect(handler.handle({type: 'inputBoxTranslation', text, targetLang: target}))
            .resolves.toEqual({success: true, translatedText: text});
        expect(translate).not.toHaveBeenCalled();
        await expect(handler.handle({type: 'inputBoxTranslation', text, targetLang: otherTarget}))
            .resolves.toEqual({success: true, translatedText: '新的译文'});
        expect(translate).toHaveBeenCalledOnce();
        expect(translate.mock.calls[0][0]).toMatchObject({origin: text, targetLanguage: otherTarget});
    });

    it('输入框中的真实外语句子继续翻译，不继承网页排除语言', async () => {
        const config = new Config();
        config.excludedLanguages = ['en'];
        const translate = vi.fn(async (_request: TranslationSingleRequestMessage) => '修复了保存错误。请重启浏览器后重试。');
        const handler = createInputBoxTranslationHandler({ready: Promise.resolve(), getConfig: () => config, translate});
        const text = '修复了保存错误。Please restart your browser and try again.';
        await expect(handler.handle({type: 'inputBoxTranslation', text, targetLang: 'zh-Hans'}))
            .resolves.toMatchObject({success: true});
        expect(translate).toHaveBeenCalledOnce();
        expect(translate.mock.calls[0][0].origin).toBe(text);
    });

    it('水合完成后才读取配置，期间网页修改消息不会更换已解析的目标', async () => {
        const config = new Config();
        let hydrate!: () => void;
        const ready = new Promise<void>(resolve => { hydrate = resolve; });
        const getConfig = vi.fn(() => config);
        const translate = vi.fn(async (_request: TranslationSingleRequestMessage) => '不应调用');
        const handler = createInputBoxTranslationHandler({ready, getConfig, translate});
        const message = {type: 'inputBoxTranslation' as const, text: '修复保存记录后再次打开页面时内容丢失的问题。', targetLang: 'zh-Hans'};
        const pending = handler.handle(message);
        message.targetLang = 'en';
        expect(getConfig).not.toHaveBeenCalled();
        hydrate();
        await expect(pending).resolves.toEqual({success: true, translatedText: message.text});
        expect(getConfig).toHaveBeenCalledOnce();
        expect(translate).not.toHaveBeenCalled();
    });

    it('继承当前默认服务，已建立的请求保持快照，独立选择不随默认变更', () => {
        const config = new Config();
        config.service = services.google;
        const first = createInputBoxTranslationRequest(config, 'hello', 'zh');
        expect(first.serviceOverride).toBe(services.google);
        config.service = services.deepseek;
        const next = createInputBoxTranslationRequest(config, 'hello', 'zh');
        expect(next.serviceOverride).toBe(services.deepseek);
        expect(getTranslationProviderConfig(first, config as never).service).toBe(services.google);
        config.inputBoxTranslationService = services.microsoft;
        expect(createInputBoxTranslationRequest(config, 'hello', 'zh').serviceOverride).toBe(services.microsoft);
    });

    it('冻结独立 AI service/model/prompt，并忽略网页消息中的伪造字段', async () => {
        const config = new Config();
        config.service = services.microsoft;
        config.from = 'zh-Hans';
        config.to = 'zh-Hant';
        config.useCache = false;
        config.inputBoxTranslationService = services.deepseek;
        config.inputBoxTranslationModel = 'input-model';
        config.inputBoxTranslationPrompt = '语气自然';
        config.inputBoxTranslationSystemPrompt = '只输出译文';
        config.model[services.deepseek] = 'page-model';
        config.user_role[services.deepseek] = '网页全局用户模板';
        config.system_role[services.deepseek] = '网页全局系统模板';

        const translate = vi.fn(async (request) => {
            const snapshot = getTranslationProviderConfig(request, config as never);
            expect(snapshot.service).toBe(services.microsoft);
            return '译文';
        });
        const handler = createInputBoxTranslationHandler({
            ready: Promise.resolve(),
            getConfig: () => config,
            translate,
        });

        await expect(handler.handle({
            type: 'inputBoxTranslation',
            text: 'Hello <b>world</b>',
            targetLang: '  ja  ',
            serviceOverride: services.openai,
            modelOverride: 'forged-model',
            token: 'forged-token',
        } as never)).resolves.toEqual({success: true, translatedText: '译文'});

        const request = translate.mock.calls[0][0];
        const snapshot = getTranslationProviderConfig(request, config as never);
        expect(request).toMatchObject({
            origin: 'Hello <b>world</b>',
            sourceLanguage: 'auto',
            targetLanguage: 'ja',
            enableAIContext: false,
            glossaryIds: [],
            serviceOverride: services.deepseek,
            modelOverride: 'input-model',
            useCache: false,
        });
        expect(snapshot.user_role[services.deepseek]).toContain('语气自然');
        expect(snapshot.user_role[services.deepseek]).toContain('{{to}}');
        expect(snapshot.user_role[services.deepseek]).toContain('{{origin}}');
        expect(snapshot.system_role[services.deepseek]).toBe('只输出译文');
        expect(snapshot.user_role[services.deepseek]).not.toContain('网页全局用户模板');
        expect(Object.keys(request)).not.toContain('token');
        expect(snapshot.token).toEqual(config.token);
    });

    it('机器翻译忽略输入框 prompt 和 model，仍使用独立服务并遵循缓存设置', () => {
        const config = new Config();
        config.useCache = true;
        config.inputBoxTranslationService = services.microsoft;
        config.inputBoxTranslationModel = 'forged-machine-model';
        config.inputBoxTranslationPrompt = '不要泄漏';
        config.inputBoxTranslationSystemPrompt = '不要泄漏';
        config.user_role[services.microsoft] = '网页用户模板';
        config.system_role[services.microsoft] = '网页系统模板';

        const request = createInputBoxTranslationRequest(config, 'hello', 'zh');
        const snapshot = getTranslationProviderConfig(request, config as never);
        expect(request).toMatchObject({
            serviceOverride: services.microsoft,
            useCache: true,
            sourceLanguage: 'auto',
            enableAIContext: false,
            glossaryIds: [],
        });
        expect(request).not.toHaveProperty('modelOverride');
        expect(snapshot.user_role[services.microsoft]).toBe('网页用户模板');
        expect(snapshot.system_role[services.microsoft]).toBe('网页系统模板');
    });

    it('AI 空 system prompt 使用输入框默认值，单条数组结果仍转换为纯文本响应', async () => {
        const config = new Config();
        config.inputBoxTranslationService = services.deepseek;
        config.inputBoxTranslationModel = '';
        config.inputBoxTranslationSystemPrompt = '';
        const translate = vi.fn(async (_message: TranslationSingleRequestMessage) => ['数组译文']);
        const handler = createInputBoxTranslationHandler({
            ready: Promise.resolve(),
            getConfig: () => config,
            translate,
        });

        await expect(handler.handle({type: 'inputBoxTranslation', text: 'hello', targetLang: 'zh'}))
            .resolves.toEqual({success: true, translatedText: '数组译文'});
        const request = translate.mock.calls[0][0];
        const snapshot = getTranslationProviderConfig(request, config as never);
        expect(snapshot.system_role[services.deepseek]).toContain('professional translation assistant');
        expect(request).not.toHaveProperty('modelOverride');
    });

    it('Qwen-MT 只忽略输入框 prompt，仍保留用户选择的模型覆盖', () => {
        const config = new Config();
        config.inputBoxTranslationService = services.tongyi;
        config.inputBoxTranslationModel = 'qwen-mt-plus';
        config.inputBoxTranslationPrompt = '不应进入 Qwen-MT 原生协议';
        config.inputBoxTranslationSystemPrompt = '不应进入 Qwen-MT 原生协议';
        config.user_role[services.tongyi] = '网页用户模板';
        config.system_role[services.tongyi] = '网页系统模板';

        const request = createInputBoxTranslationRequest(config, 'hello', 'zh-Hans');
        const snapshot = getTranslationProviderConfig(request, config as never);
        expect(request).toMatchObject({
            serviceOverride: services.tongyi,
            modelOverride: 'qwen-mt-plus',
        });
        expect(snapshot.user_role[services.tongyi]).toBe('网页用户模板');
        expect(snapshot.system_role[services.tongyi]).toBe('网页系统模板');
    });

    it('空输入、空目标或 provider 空响应仍在 handler 边界失败', async () => {
        const config = new Config();
        const translate = vi.fn(async () => '');
        const handler = createInputBoxTranslationHandler({
            ready: Promise.resolve(),
            getConfig: () => config,
            translate,
        });
        await expect(handler.handle({type: 'inputBoxTranslation', text: ' ', targetLang: 'zh'}))
            .rejects.toThrow('text 不能为空');
        await expect(handler.handle({type: 'inputBoxTranslation', text: 1, targetLang: 'zh'} as never))
            .rejects.toThrow('text 必须是字符串');
        await expect(handler.handle({type: 'inputBoxTranslation', text: 'hello', targetLang: ''}))
            .rejects.toThrow('targetLang 不能为空');
        await expect(handler.handle({type: 'inputBoxTranslation', text: 'hello', targetLang: null} as never))
            .rejects.toThrow('targetLang 必须是字符串');
        await expect(handler.handle({type: 'inputBoxTranslation', text: 'hello', targetLang: 'zh'}))
            .rejects.toThrow('有效译文');
    });
});

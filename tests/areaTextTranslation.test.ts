import {describe, expect, it, vi} from 'vitest';
import {normalizeConfig} from '@/src/core/config/model';
import {prepareAreaTextTranslation, supportsAreaTranslationAI} from '@/src/features/area-translation/services/textTranslation';
import {getTranslationProviderConfig, getTranslationRequestControl, getTranslationGlossaryContext, createTranslationProviderConfigSnapshot} from '@/src/services/translation/requestSnapshot';
import type {TranslationRequestMessage} from '@/src/services/translation/types';
import type {GlossaryLibrary} from '@/src/core/glossary';

const recognized = {image: 'data:image/png,cropped', lines: [
    {text: 'He11o world.', bbox: {x0: 0, y0: 0, x1: 100, y1: 15}},
    {text: 'A second line.', bbox: {x0: 0, y0: 16, x1: 100, y1: 31}},
]};
const options = (signal = new AbortController().signal, timeoutMs = 10_000) => ({requestId: 'area-text-1', timeoutMs, signal});
const config = (mode: 'standard' | 'ai' = 'standard') => normalizeConfig({
    service: 'microsoft', areaTranslationMode: mode, areaTranslationService: mode === 'ai' ? 'openai' : '',
    model: {openai: 'gpt-4o'}, from: 'auto', to: 'zh-Hans', token: {openai: 'private-old-key'},
});
const chineseTerms = (): GlossaryLibrary => ({id: 'notes', name: '阅读用语', enabled: true,
    sourceLanguage: 'zh-Hans', targetLanguage: 'zh-Hans', domains: ['example.org'],
    entries: [{id: 'record', source: '记录', target: '笔记', caseSensitive: false}]});

describe('圈选整块文字翻译事务', () => {
    it.each([
        ['修复保存记录后再次打开页面时内容丢失的问题。', 'zh-Hans', 'en'],
        ['You can return to your saved paragraphs after closing the browser.', 'en', 'zh-Hans'],
    ])('标准圈选原文已是目标 %s → %s 时不请求，改用目标 %s 后仍翻译', async (text, target, otherTarget) => {
        const source = config();
        source.to = target;
        const translate = vi.fn(async (_request: TranslationRequestMessage) => '新的译文');
        const original = {...recognized, lines: [{...recognized.lines[0], text}], sourceText: text,
            recognitionMethod: 'ocr' as const, recognitionFallback: 'unknown' as const};
        const run = prepareAreaTextTranslation(source, 'auto', 'Article', {}, translate);
        source.to = otherTarget;
        const unchanged = await run(original, options());
        expect(unchanged).toMatchObject({sourceText: text, translatedText: text, mode: 'standard',
            image: original.image, recognitionMethod: 'ocr', recognitionFallback: 'unknown', warnings: ['standard-quality']});
        expect(unchanged.lines).toBe(original.lines);
        expect(translate).not.toHaveBeenCalled();
        const changed = await prepareAreaTextTranslation(source, 'auto', 'Article', {}, translate)(original, options());
        expect(changed.translatedText).toBe('新的译文');
        expect(translate).toHaveBeenCalledOnce();
        expect(translate.mock.calls[0][0]).toMatchObject({origin: text, targetLanguage: otherTarget});
    });

    it('标准圈选中的真实外语句子继续请求，且不继承网页排除语言', async () => {
        const source = config();
        source.excludedLanguages = ['en'];
        const text = '修复了保存错误。Please restart your browser and try again.';
        const translate = vi.fn(async (_request: TranslationRequestMessage) => '修复了保存错误。请重启浏览器后重试。');
        const result = await prepareAreaTextTranslation(source, 'auto', '', {}, translate)({...recognized, sourceText: text}, options());
        expect(result.sourceText).toBe(text);
        expect(translate).toHaveBeenCalledOnce();
        expect(translate.mock.calls[0][0].origin).toBe(text);
    });

    it('标准圈选同目标命中用户固定译名时仍调用broker，沿用冻结词库与可信网站来源', async () => {
        const source = config();
        source.glossaryEnabled = true;
        source.glossaryLibraries = [chineseTerms()];
        const text = '修复保存记录后再次打开页面时内容丢失的问题。';
        const context = {pageUrl: 'https://example.org/article', context: 'page' as const};
        const translate = vi.fn(async (_request: TranslationRequestMessage) => text.replace('记录', '笔记'));
        const run = prepareAreaTextTranslation(source, 'zh-Hans', '', context, translate);
        source.glossaryEnabled = false;
        source.glossaryLibraries[0].entries[0].target = '新术语';
        context.pageUrl = 'https://other.org/article';
        const result = await run({...recognized, sourceText: text}, options());
        expect(result).toMatchObject({sourceText: text, translatedText: text.replace('记录', '笔记')});
        expect(translate).toHaveBeenCalledOnce();
        const request = translate.mock.calls[0][0];
        expect(request).toMatchObject({origin: text, sourceLanguage: 'zh-Hans', targetLanguage: 'zh-Hans'});
        expect(getTranslationGlossaryContext(request)?.pageUrl).toBe('https://example.org/article');
        const frozen = getTranslationProviderConfig(request, createTranslationProviderConfigSnapshot(source));
        expect(frozen.glossaryEnabled).toBe(true);
        expect(frozen.glossaryLibraries?.[0]?.entries[0]?.target).toBe('笔记');
    });

    it('可选翻译配置缺少术语库时仍安全跳过标准同目标原文', async () => {
        const source = config();
        source.glossaryEnabled = true;
        Reflect.deleteProperty(source, 'glossaryLibraries');
        const text = '修复保存记录后再次打开页面时内容丢失的问题。';
        const translate = vi.fn(async (_request: TranslationRequestMessage) => '不应请求');
        const result = await prepareAreaTextTranslation(source, 'zh-Hans', '', {}, translate)({...recognized, sourceText: text}, options());
        expect(result.translatedText).toBe(text);
        expect(translate).not.toHaveBeenCalled();
    });

    it.each(['disabled', 'library-disabled', 'website', 'source', 'target', 'unmatched', 'document-disabled'] as const)(
        '标准同目标的术语范围为%s时保留原文且不请求', async boundary => {
            const source = config();
            source.glossaryEnabled = true;
            const library = chineseTerms();
            source.glossaryLibraries = [library];
            if (boundary === 'disabled') source.glossaryEnabled = false;
            if (boundary === 'library-disabled') library.enabled = false;
            if (boundary === 'source') library.sourceLanguage = 'en';
            if (boundary === 'target') library.targetLanguage = 'en';
            if (boundary === 'unmatched') library.entries[0].source = '书签';
            if (boundary === 'document-disabled') source.documentGlossaryIds = [];
            const text = '修复保存记录后再次打开页面时内容丢失的问题。';
            const translate = vi.fn(async (_request: TranslationRequestMessage) => '不应请求');
            const context = {pageUrl: boundary === 'website' ? 'https://other.org' : 'https://example.org',
                context: boundary === 'document-disabled' ? 'document' as const : 'page' as const};
            const result = await prepareAreaTextTranslation(source, 'zh-Hans', '', context, translate)({...recognized, sourceText: text}, options());
            expect(result.translatedText).toBe(text);
            expect(translate).not.toHaveBeenCalled();
        },
    );

    it('AI圈选同目标仍执行OCR纠错并校验结构化结果', async () => {
        const source = config('ai');
        const text = '修复保存记录后再次打开页面时内容丢失的问题。';
        const translate = vi.fn(async (_request: TranslationRequestMessage) => JSON.stringify({correctedText: text, translatedText: text}));
        const result = await prepareAreaTextTranslation(source, 'auto', '', {}, translate)({...recognized, sourceText: text}, options());
        expect(result).toMatchObject({sourceText: text, correctedText: text, translatedText: text, mode: 'ai'});
        expect(translate).toHaveBeenCalledOnce();
        expect(translate.mock.calls[0][0]).toMatchObject({origin: text, targetLanguage: 'zh-Hans', useCache: false});
    });

    it('视觉识别在未指定服务和提示词时使用主服务与默认提示', async () => {
        const source = config();
        source.areaTranslationService = '';
        Reflect.deleteProperty(source, 'areaVisionPrompt');
        const crop = vi.fn(async () => ({image: 'data:image/png;base64,AA==', lines: []}));
        const translate = vi.fn(async (_request: TranslationRequestMessage) => 'Detected text');
        const result = await (await import('@/src/features/area-translation/services/textTranslation')).prepareAreaVisionRecognition(
            source, 'en', 'Page', crop, translate,
        )('data:image/png;base64,AA==', {left: 0, top: 0, width: 10, height: 10, viewportWidth: 20, viewportHeight: 20}, options());
        expect(result).toMatchObject({sourceText: 'Detected text', recognitionMethod: 'vision'});
        expect(translate.mock.calls[0][0].targetLanguage).toBe('zh-Hans');
    });

    it('标准模式以一个完整文本调用免费服务，冻结服务语言凭据术语来源并不发送截图', async () => {
        const source = config();
        source.areaTranslationService = 'freeTranslation';
        const translate = vi.fn(async (_request: TranslationRequestMessage) => '你好世界。\n第二行。');
        let now = 0;
        const context = {pageUrl: 'https://example.org/page', context: 'page' as const};
        const run = prepareAreaTextTranslation(source, 'en', 'Article', context, translate, () => now);
        source.service = 'openai'; source.to = 'ja'; source.token.openai = 'changed'; context.pageUrl = 'https://elsewhere.org'; now = 4_000;
        const operation = options();
        const result = await run(recognized, operation);
        expect(result).toEqual({...recognized, sourceText: 'He11o world.\nA second line.', translatedText: '你好世界。\n第二行。', mode: 'standard', service: 'freeTranslation', serviceName: '免费翻译服务', model: '', warnings: ['standard-quality']});
        expect(translate).toHaveBeenCalledOnce();
        const request = translate.mock.calls[0][0] as TranslationRequestMessage;
        expect(request).toMatchObject({origin: result.sourceText, serviceOverride: 'freeTranslation', targetLanguage: 'zh-Hans', requestTimeoutMs: 6_000, useCache: true, enableAIContext: false});
        expect(JSON.stringify(request)).not.toContain('data:image');
        expect(JSON.stringify(request)).not.toContain('private-old-key');
        expect(getTranslationProviderConfig(request, createTranslationProviderConfigSnapshot(source)).token.openai).toBe('private-old-key');
        expect(getTranslationRequestControl(request)).toEqual({signal: operation.signal, ownershipKey: 'area:area-text-1'});
        expect(getTranslationGlossaryContext(request)?.pageUrl).toBe('https://example.org/page');
    });

    it('AI只发一次整体纠错翻译请求，专属提示不改变用户设置，并分别保留OCR与校正文', async () => {
        const source = config('ai');
        const oldPrompt = source.system_role.openai;
        const translate = vi.fn(async (_request: TranslationRequestMessage) => JSON.stringify({correctedText: 'Hello world.\nA second line.', translatedText: '你好世界。\n第二行。'}));
        const result = await prepareAreaTextTranslation(source, 'en', '', {}, translate)(recognized, options());
        expect(result).toMatchObject({service: 'openai', serviceName: 'OpenAI', model: 'gpt-4o'});
        expect(result.sourceText).toBe('He11o world.\nA second line.');
        expect(result.correctedText).toBe('Hello world.\nA second line.');
        expect(result.lines).toBe(recognized.lines);
        expect(result.warnings).toEqual(['ai-text-only']);
        expect(translate).toHaveBeenCalledOnce();
        const request = translate.mock.calls[0][0];
        expect(request.useCache).toBe(false);
        const snapshot = getTranslationProviderConfig(request, createTranslationProviderConfigSnapshot(source));
        expect(snapshot.system_role.openai).toContain('cannot inspect the screenshot');
        expect(snapshot.user_role.openai).toContain('{{origin}}');
        expect(source.system_role.openai).toBe(oldPrompt);
    });

    it.each(['custom:area', 'custom'])('自定义服务 %s 名称与实际模型随请求冻结，后续重试采用新配置', async service => {
        const source = config();
        source.areaTranslationService = service;
        source.customOpenAIProviders = [{id: service, name: '我的翻译服务', endpoint: 'https://example.org/v1', models: ['model-old']}];
        source.model[service] = '自定义模型';
        source.customModel[service] = 'model-old';
        const translate = vi.fn(async (_request: TranslationRequestMessage) => '你好');
        const run = prepareAreaTextTranslation(source, 'en', '', {}, translate);
        source.customOpenAIProviders[0].name = '新名称';
        source.customModel[service] = 'model-new';
        expect(await run(recognized, options())).toMatchObject({service: service, serviceName: '我的翻译服务', model: 'model-old'});
        expect(translate.mock.calls[0][0]).toMatchObject({serviceOverride: service, modelOverride: 'model-old'});
        expect(await prepareAreaTextTranslation(source, 'en', '', {}, translate)(recognized, options()))
            .toMatchObject({serviceName: '新名称', model: 'model-new'});
    });

    it('未知服务只显示原始标识，不推断名称或模型', async () => {
        const source = config(); source.areaTranslationService = 'future-service';
        const result = await prepareAreaTextTranslation(source, 'en', '', {}, async () => '你好')(recognized, options());
        expect(result).toMatchObject({service: 'future-service', serviceName: 'future-service', model: ''});
    });

    it('AI能力按照服务与实际模型判断，不把微软、免费或Qwen-MT当通用AI', () => {
        expect(supportsAreaTranslationAI('openai', 'gpt-4o')).toBe(true);
        expect(supportsAreaTranslationAI('tongyi', 'qwen-mt-plus')).toBe(false);
        for (const service of ['microsoft', 'freeTranslation']) {
            expect(supportsAreaTranslationAI(service, '')).toBe(false);
            const source = config('ai'); source.areaTranslationService = service;
            expect(() => prepareAreaTextTranslation(source, 'en', '', {}, vi.fn())).toThrow('不支持 AI 文字增强');
        }
    });

    it.each(['', '   ', ['wrong']])('无有效文字译文 %j 明确失败', async value => {
        await expect(prepareAreaTextTranslation(config(), 'en', '', {}, vi.fn(async () => value))(recognized, options())).rejects.toThrow('未返回有效译文');
    });

    it.each([
        ['not JSON', '有效 JSON'], ['null', '结构无效'], ['[]', '结构无效'], ['1', '结构无效'],
        ['{}', '字段无效'], ['{"correctedText":1,"translatedText":"好"}', '字段无效'],
        ['{"correctedText":" ","translatedText":"好"}', '字段无效'],
        ['{"correctedText":"Hello","translatedText":2}', '字段无效'],
        ['{"correctedText":"Hello","translatedText":" "}', '字段无效'],
        ['{"correctedText":"Hello","translatedText":"好","extra":1}', '字段无效'],
        [JSON.stringify({correctedText: 'x'.repeat(500), translatedText: '好'}), '字段无效'],
        [JSON.stringify({correctedText: 'Hello', translatedText: 'x'.repeat(2_000)}), '字段无效'],
    ])('AI错误协议不降级为成功或静默改写原文 %#', async (value, error) => {
        await expect(prepareAreaTextTranslation(config('ai'), 'en', '', {}, vi.fn(async () => value))(recognized, options())).rejects.toThrow(error);
        expect(recognized.lines[0].text).toBe('He11o world.');
    });

    it('无文字、超大选区与OCR耗尽预算都在网络调用前失败', async () => {
        const translate = vi.fn();
        let now = 0;
        const run = prepareAreaTextTranslation(config(), 'en', '', {}, translate, () => now);
        await expect(run({...recognized, lines: []}, options())).rejects.toThrow('没有识别到');
        await expect(run({...recognized, lines: [{...recognized.lines[0], text: 'x'.repeat(12_001)}]}, options())).rejects.toThrow('文字过多');
        now = 10_000;
        await expect(run(recognized, options())).rejects.toThrow('总时间已耗尽');
        expect(translate).not.toHaveBeenCalled();
    });

    it('视觉识别在裁剪后预算耗尽时不发送模型请求', async () => {
        const source = config();
        const crop = vi.fn(async () => { now = 2; return {image: 'data:image/png;base64,AA==', lines: []}; });
        const translate = vi.fn(async (_request: TranslationRequestMessage) => 'Detected text');
        let now = 0;
        const run = (await import('@/src/features/area-translation/services/textTranslation')).prepareAreaVisionRecognition(
            source, 'en', '', crop, translate, () => now,
        );
        const pending = run('data:image/png;base64,AA==', {left: 0, top: 0, width: 10, height: 10, viewportWidth: 20, viewportHeight: 20}, options(undefined, 1));
        await expect(pending).rejects.toThrow('总时间已耗尽');
        expect(crop).toHaveBeenCalledOnce();
        expect(translate).not.toHaveBeenCalled();
    });

    it('整块翻译保留视觉与回退识别元数据', async () => {
        const source = config();
        const recognizedWithMetadata = {...recognized, recognitionMethod: 'ocr' as const, recognitionFallback: 'unknown' as const};
        const result = await prepareAreaTextTranslation(source, 'en', '', {}, async () => '你好')(recognizedWithMetadata, options());
        expect(result).toMatchObject({recognitionMethod: 'ocr', recognitionFallback: 'unknown'});
    });

    it('取消覆盖OCR完成前与provider迟到响应，不返回成功结果', async () => {
        const controller = new AbortController(); controller.abort();
        const translate = vi.fn();
        const run = prepareAreaTextTranslation(config(), 'en', '', {}, translate);
        await expect(run(recognized, {...options(), signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(translate).not.toHaveBeenCalled();
        const late = new AbortController();
        translate.mockImplementationOnce(async () => {late.abort(); return '你好';});
        await expect(run(recognized, {...options(), signal: late.signal})).rejects.toMatchObject({name: 'AbortError'});
    });
});

import type {TranslationProviderRequest} from '@/src/services/translation/types';
import {describe, expect, it, vi} from 'vitest';
import {createImageGlossaryContext, type ImageGlossarySenderContext} from '@/src/app/background/imageGlossaryContext';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {
    createImageTranslationBackgroundHandlers, IMAGE_TRANSLATE_MESSAGE_TYPE, IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE,
    IMAGE_CANCEL_MESSAGE_TYPE, type ImageTranslationBackgroundDependencies,
} from '@/src/features/image-translation/background/handlers';
import {AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, createAreaTranslationBackgroundHandlers} from '@/src/features/area-translation/background/handlers';
import {buildGlossaryRevision} from '@/src/core/glossary';
import {Config} from '@/src/core/config/model';
import {resolveConfiguredModel, servicesType} from '@/src/core/config/catalog';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {commonMsgTemplate} from '@/src/services/translation/templates';
import {
    attachTranslationGlossaryContext, createTranslationProviderConfigSnapshot,
    getTranslationGlossaryContext, getTranslationGlossaryTerms, getTranslationProviderConfig, getTranslationRequestControl,
} from '@/src/services/translation/requestSnapshot';

const OFFSCREEN_URL = 'chrome-extension://this-extension/offscreen.html';
const page = (url = 'https://docs.example.com/article'): ImageGlossarySenderContext => ({sender: {url, tab: {id: 7}}});
const offscreen = {sender: {url: OFFSCREEN_URL}};
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {resolve = resolvePromise; reject = rejectPromise;});
    return {promise, resolve, reject};
}
function simple(ready = Promise.resolve()) {
    let revision = 'revision-before';
    let sourceLanguage = 'auto';
    const start = vi.fn(async (_message: unknown) => 'done');
    const texts = vi.fn(async (message: object) => message);
    const plain = {type: IMAGE_CANCEL_MESSAGE_TYPE, handle: vi.fn()};
    const adapter = createImageGlossaryContext<ImageGlossarySenderContext>({
        ready, offscreenUrl: OFFSCREEN_URL, getSourceLanguage: () => sourceLanguage, getGlossaryRevision: () => revision,
    });
    const handlers = adapter.wrap([
        {type: IMAGE_TRANSLATE_MESSAGE_TYPE, handle: start},
        {type: AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, handle: start},
        {type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, handle: texts}, plain,
    ]);
    const call = (type: string, message: Record<string, unknown>, context: ImageGlossarySenderContext = page()) =>
        Promise.resolve(handlers.find((handler) => handler.type === type)!.handle({type, ...message}, context));
    return {adapter, handlers, start, texts, plain, call,
        change: (value = 'revision-after', from = 'ja') => {revision = value; sourceLanguage = from;}};
}

describe('图片及圈选术语的后台来源上下文', () => {
    it('等待配置就绪再冻结原页面与OCR源语，识别期间配置变更不改已有事务', async () => {
        const ready = deferred<void>();
        const ocr = deferred<string>();
        const entered = deferred<void>();
        const h = simple(ready.promise);
        h.start.mockImplementationOnce(async () => {entered.resolve(); return ocr.promise;});
        const pending = h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, {
            requestId: 'image-1', sourceLanguage: 'en', imageUrl: 'https://cdn.other.example/image.png',
            pageUrl: 'https://fake.example', glossaryRevision: 'fake',
        });
        await Promise.resolve();
        expect(h.start).not.toHaveBeenCalled();
        h.change('ready-revision', 'de');
        ready.resolve();
        await entered.promise;
        h.change();
        const imageLabelSlots = [1];
        const reply = h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'image-1', glossaryRevision: 'forged', imageLabelSlots}, offscreen);
        imageLabelSlots.push(2);
        const result = await reply as object;
        expect(result).toMatchObject({sourceLanguage: 'en', glossaryRevision: 'ready-revision', imageLabelSlots: [1]});
        const pageReply = await h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'image-1', imageLabelSlots}, page(OFFSCREEN_URL));
        expect(pageReply).not.toHaveProperty('imageLabelSlots');
        expect(getTranslationGlossaryContext(result)).toEqual({pageUrl: 'https://docs.example.com/article', context: 'page'});
        expect(Object.isFrozen(getTranslationGlossaryContext(result))).toBe(true);
        ocr.resolve('done');
        await expect(pending).resolves.toBe('done');
        await expect(h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'image-1'}, offscreen)).rejects.toThrow('上下文已失效');
    });

    it('圈选缺省源语在开始时冻结，普通取消handler保持原有实例', async () => {
        const h = simple();
        expect(h.handlers.find(({type}) => type === IMAGE_CANCEL_MESSAGE_TYPE)).toBe(h.plain);
        h.start.mockImplementationOnce(async () => {
            h.change();
            const result = await h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'area-1'}, offscreen);
            expect(result).toMatchObject({sourceLanguage: 'auto', glossaryRevision: 'revision-before'});
            return 'area-done';
        });
        await expect(h.call(AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, {requestId: 'area-1'})).resolves.toBe('area-done');
    });

    it('跨图片圈选的重复ID不覆盖上下文，失败或取消后删除并允许重用', async () => {
        const h = simple();
        const ocr = deferred<string>();
        const entered = deferred<void>();
        h.start.mockImplementationOnce(async () => {entered.resolve(); return ocr.promise;});
        const first = h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, {requestId: 'same'});
        await entered.promise;
        await expect(h.call(AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, {requestId: 'same'}, page('https://other.example'))).rejects.toThrow('正在执行');
        const callback = await h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'same'}, offscreen) as object;
        expect(getTranslationGlossaryContext(callback)?.pageUrl).toBe('https://docs.example.com/article');
        const rejected = expect(first).rejects.toThrow('取消');
        ocr.reject(new Error('已取消'));
        await rejected;
        await expect(h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'same'}, offscreen)).rejects.toThrow('上下文已失效');
        await expect(h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, {requestId: 'same'})).resolves.toBe('done');
    });

    it('兼容无ID调用，生成的ID避开已有事务且传到原handler', async () => {
        const h = simple();
        const ocr = deferred<string>();
        const entered = deferred<void>();
        h.start.mockImplementationOnce(async () => {entered.resolve(); return ocr.promise;});
        const first = h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, {requestId: 'legacy-image-glossary-1'});
        await entered.promise;
        await h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, {sourceLanguage: ''});
        expect(h.start.mock.calls[1][0]).toMatchObject({requestId: 'legacy-image-glossary-2'});
        ocr.resolve('done');
        await first;
    });

    it('未知或非法Offscreen事务拒绝，不借用相同payload中的页面和版本', async () => {
        const h = simple();
        await expect(h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'missing'}, offscreen)).rejects.toThrow('上下文已失效');
        for (const requestId of [undefined, null, '', 'bad id', 'a'.repeat(129)]) {
            await expect(h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId}, offscreen)).rejects.toThrow('requestId 格式');
        }
        for (const requestId of [null, '', 'bad id']) {
            await expect(h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, {requestId})).rejects.toThrow('requestId 格式');
        }
        expect(h.start).not.toHaveBeenCalled();
        expect(h.texts).not.toHaveBeenCalled();
    });

    it('content文本直接请求只用自身真实sender，不能通过已有ID读取其他页术语范围', async () => {
        const h = simple();
        h.start.mockImplementationOnce(async () => {
            h.change('current-revision', 'fr');
            const result = await h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {
                requestId: 'known', pageUrl: 'https://docs.example.com', glossaryRevision: 'forged', sourceLanguage: 'en',
            }, page('http://reader.example')) as object;
            expect(result).toMatchObject({sourceLanguage: 'fr', glossaryRevision: 'current-revision'});
            expect(getTranslationGlossaryContext(result)).toEqual({pageUrl: 'http://reader.example/', context: 'page'});
            return 'done';
        });
        await h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, {requestId: 'known'});
    });

    it('Offscreen信任要求本扩展精确URL且无tab；其他扩展页或非法URL无法取得页面作用域', async () => {
        const h = simple();
        const senders: ImageGlossarySenderContext[] = [
            {sender: {url: 'chrome-extension://another-extension/offscreen.html'}},
            {sender: {url: OFFSCREEN_URL, tab: {id: 4}}},
            {sender: {url: `${OFFSCREEN_URL}?fake=true`}},
            {sender: {url: 'ftp://docs.example.com/file'}}, {sender: {url: 'bad URL'}}, {}, {sender: {}},
        ];
        for (const sender of senders) {
            const result = await h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'missing'}, sender) as object;
            expect(getTranslationGlossaryContext(result)).toEqual({pageUrl: undefined, context: 'page'});
        }
    });
});

function integration(batch: boolean, texts = ['API', 'other']) {
    const config = Object.assign(new Config(), {
        service: 'openai', from: 'auto', to: 'zh-Hans', glossaryEnabled: true,
        glossaryLibraries: [{id: 'site', name: '页面库', enabled: true, sourceLanguage: '', targetLanguage: '',
            domains: ['docs.example.com'], entries: [{id: 'api', source: 'API', target: '专用接口', caseSensitive: false}]}],
    });
    const requests: object[] = [];
    const provider = vi.fn(async (message: TranslationProviderRequest) => {
        const snapshot = getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config));
        const translate = (origin: string) => getTranslationGlossaryTerms(snapshot, origin)[0]?.target ?? `译文:${origin}`;
        return Array.isArray(message.origin) ? message.origin.map(translate) : translate(String(message.origin));
    });
    const broker = createTranslationBroker({
        ready: Promise.resolve(), getConfig: () => config, providers: {openai: provider},
        cache: {get: async () => null, set: async () => true, clear: async () => {}, cleanup: async () => {}},
        serviceTypes: servicesType,
        endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}),
            aiSdkTransportProfile: 'fixture'},
        promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
        getMissingCredentialMessage: () => null,
        getTranslationLanguages: request => ({sourceLanguage: request?.sourceLanguage ?? config.from, targetLanguage: config.to}),
        resolveConfiguredModel, buildTranslationCacheKey: identity => JSON.stringify(identity), logger: {warn: vi.fn()},
    });
    let beforeText = async () => {};
    let wrapped: BackgroundMessageHandler<ImageGlossarySenderContext>[];
    const call = async (type: string, message: Record<string, unknown>, context = page()) =>
        wrapped.find((handler) => handler.type === type)!.handle({type, ...message}, context);
    const translatedImage = async (options: {requestId: string}) => {
        await beforeText();
        const result = await call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: options.requestId, texts}, offscreen) as {translations: string[]};
        return {image: 'data:image/png;base64,translated', lines: result.translations};
    };
    const dependencies: ImageTranslationBackgroundDependencies = {
        assertLanguagesDownloaded: async () => {}, fetchImage: async () => '',
        translateImage: async (_image, _language, _title, options) => translatedImage(options),
        getTranslationService: () => 'openai', supportsBatchTranslation: () => batch,
        translateTexts: async (request) => {requests.push(request); return broker.translateWithCache(request);},
        downloadLanguages: async () => {}, markLanguagesDownloaded: async () => [],
    };
    wrapped = createImageGlossaryContext<ImageGlossarySenderContext>({
        ready: Promise.resolve(), offscreenUrl: OFFSCREEN_URL, getSourceLanguage: () => config.from,
        getGlossaryRevision: () => buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
    }).wrap([
        ...createImageTranslationBackgroundHandlers(dependencies),
        ...createAreaTranslationBackgroundHandlers({
            captureVisibleTab: async () => '', getDefaultSourceLanguage: () => config.from,
            assertLanguagesDownloaded: async () => {},
            translateArea: async (_image, _source, _title, _selection, options) => translatedImage(options),
        }),
    ] as BackgroundMessageHandler<ImageGlossarySenderContext>[]);
    return {config, provider, requests, call, pause: (operation: () => Promise<void>) => {beforeText = operation;}};
}
const imageRequest = {image: 'data:image/png;base64,source', sourceLanguage: 'en', requestId: 'image-transaction'};

describe('图片、圈选OCR到真实术语broker的完整请求边界', () => {
    it.each([true, false])('批量=%s时每次broker调用都携带同一可信页面、源语言和revision', async (batch) => {
        const h = integration(batch);
        const revision = buildGlossaryRevision(h.config.glossaryLibraries, true);
        await expect(h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, imageRequest)).resolves.toMatchObject({
            success: true, lines: ['专用接口', '译文:other'],
        });
        expect(h.requests).toHaveLength(batch ? 1 : 2);
        for (const request of h.requests) {
            expect(request).toMatchObject({sourceLanguage: 'en', glossaryRevision: revision});
            expect(getTranslationGlossaryContext(request)).toEqual({pageUrl: 'https://docs.example.com/article', context: 'page'});
        }
        const serialized = JSON.stringify(h.provider.mock.calls);
        expect(serialized).not.toContain('docs.example.com');
    });

    it('重复OCR文本经三路并发和乱序回执后保序还原，每个请求仍携带同一可信术语上下文', async () => {
        const h = integration(false, ['API', 'other', 'API', 'third', 'fourth', 'other']);
        const translate = h.provider.getMockImplementation()!;
        const gates = new Map(['API', 'other', 'third', 'fourth'].map(text => [text, deferred<void>()]));
        const firstWindow = deferred<void>();
        const fourthStarted = deferred<void>();
        const started: string[] = [];
        h.provider.mockImplementation(async message => {
            // 真实 broker 会把术语替换为受保护 token；乱序夹具按保留的原文安排回执。
            const origin = String(message.sourceLanguageDetectionText ?? message.origin);
            started.push(origin);
            if (started.length === 3) firstWindow.resolve();
            if (origin === 'fourth') fourthStarted.resolve();
            await gates.get(origin)!.promise;
            return translate(message);
        });
        const revision = buildGlossaryRevision(h.config.glossaryLibraries, true);
        const pending = h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, imageRequest);
        await firstWindow.promise;
        expect(started).toEqual(['API', 'other', 'third']);
        expect(h.requests).toHaveLength(3);
        h.config.from = 'ja';
        gates.get('third')!.resolve();
        await fourthStarted.promise;
        expect(started).toEqual(['API', 'other', 'third', 'fourth']);
        gates.get('fourth')!.resolve();
        gates.get('other')!.resolve();
        gates.get('API')!.resolve();
        await expect(pending).resolves.toMatchObject({
            success: true, lines: ['专用接口', '译文:other', '专用接口', '译文:third', '译文:fourth', '译文:other'],
        });
        expect(h.provider).toHaveBeenCalledTimes(4);
        const control = getTranslationRequestControl(h.requests[0])!;
        expect(control.ownershipKey).toBe(`image:${imageRequest.requestId}`);
        for (const request of h.requests) {
            expect(request).toMatchObject({sourceLanguage: 'en', glossaryRevision: revision});
            expect(getTranslationGlossaryContext(request)).toEqual({pageUrl: 'https://docs.example.com/article', context: 'page'});
            expect(getTranslationRequestControl(request)?.signal).toBe(control.signal);
        }
        expect(control.signal.aborted).toBe(false);
    });

    it('术语图片并发一段失败取消同批且不启动余段，同ID重试使用新版本并忽略旧provider迟到结果', async () => {
        const h = integration(false, ['API', 'other', 'API', 'third', 'fourth']);
        h.config.translationMaxRetries = 0;
        const translate = h.provider.getMockImplementation()!;
        const gates = new Map(['API', 'other', 'third'].map(text => [text, deferred<void>()]));
        const firstWindow = deferred<void>();
        let started = 0;
        h.provider.mockImplementation(async message => {
            if (++started === 3) firstWindow.resolve();
            await gates.get(String(message.sourceLanguageDetectionText ?? message.origin))!.promise;
            return translate(message);
        });
        const oldRevision = buildGlossaryRevision(h.config.glossaryLibraries, true);
        const pending = h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, imageRequest);
        const failed = expect(pending).rejects.toThrow('provider down');
        await firstWindow.promise;
        const oldRequests = [...h.requests];
        const oldProviderResults = h.provider.mock.results.map(result => result.value);
        h.config.glossaryLibraries[0].entries[0].target = '更新接口';
        gates.get('other')!.reject(new Error('provider down'));
        await failed;
        expect(h.requests).toHaveLength(3);
        expect(h.provider).toHaveBeenCalledTimes(3);
        for (const request of oldRequests) {
            expect(request).toMatchObject({sourceLanguage: 'en', glossaryRevision: oldRevision});
            expect(getTranslationRequestControl(request)?.signal.aborted).toBe(true);
        }
        await expect(h.call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {
            requestId: imageRequest.requestId, texts: ['API'],
        }, offscreen)).rejects.toThrow('上下文已失效');

        h.provider.mockImplementation(translate);
        const revision = buildGlossaryRevision(h.config.glossaryLibraries, true);
        expect(revision).not.toBe(oldRevision);
        await expect(h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, imageRequest)).resolves.toMatchObject({
            success: true, lines: ['更新接口', '译文:other', '更新接口', '译文:third', '译文:fourth'],
        });
        gates.get('API')!.resolve();
        gates.get('third')!.resolve();
        await Promise.allSettled(oldProviderResults);
        expect(h.requests).toHaveLength(7);
        expect(h.provider).toHaveBeenCalledTimes(7);
        const retryRequests = h.requests.slice(3);
        const oldSignal = getTranslationRequestControl(oldRequests[0])!.signal;
        for (const request of retryRequests) {
            expect(request).toMatchObject({sourceLanguage: 'en', glossaryRevision: revision});
            expect(getTranslationGlossaryContext(request)).toEqual({pageUrl: 'https://docs.example.com/article', context: 'page'});
            expect(getTranslationRequestControl(request)?.signal).not.toBe(oldSignal);
            expect(getTranslationRequestControl(request)?.signal.aborted).toBe(false);
        }
    });

    it('圈选使用原页面范围及缺省源语言，识别后不会误取Offscreen或图片域名', async () => {
        const h = integration(true);
        h.config.from = 'fr';
        await expect(h.call(AREA_TRANSLATE_CAPTURE_MESSAGE_TYPE, {
            image: 'data:image/png;base64,source', requestId: 'area-transaction',
            selection: {left: 0, top: 0, width: 20, height: 20, viewportWidth: 200, viewportHeight: 200},
        })).resolves.toMatchObject({success: true, lines: ['专用接口', '译文:other']});
        expect(h.requests[0]).toMatchObject({sourceLanguage: 'fr'});
    });

    it('长OCR期间编辑术语后真实broker拒绝旧事务，重试才使用新译名', async () => {
        const h = integration(true);
        h.pause(async () => {h.config.glossaryLibraries[0].entries[0].target = '更新接口';});
        await expect(h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, imageRequest)).rejects.toThrow('术语库已更新');
        expect(h.provider).not.toHaveBeenCalled();
        h.pause(async () => {});
        await expect(h.call(IMAGE_TRANSLATE_MESSAGE_TYPE, imageRequest)).resolves.toMatchObject({lines: ['更新接口', '译文:other']});
    });

    it('feature不接受孤立payload中的版本与来源，仅内部symbol可以开启受信传递', async () => {
        const requests: object[] = [];
        const handler = createImageTranslationBackgroundHandlers({
            assertLanguagesDownloaded: async () => {}, translateImage: async () => ({}), fetchImage: async () => '',
            getTranslationService: () => 'openai', supportsBatchTranslation: () => true,
            translateTexts: async request => {requests.push(request); return ['译文'];},
            downloadLanguages: async () => {}, markLanguagesDownloaded: async () => [],
        }).find(({type}) => type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE)!;
        const message = {type: IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, texts: ['API'], sourceLanguage: 'forged', glossaryRevision: 'forged'};
        await handler.handle(message);
        expect(requests[0]).not.toHaveProperty('sourceLanguage');
        expect(requests[0]).not.toHaveProperty('glossaryRevision');
        await expect(handler.handle(attachTranslationGlossaryContext({...message, glossaryRevision: undefined}, {context: 'page'})))
            .rejects.toThrow('glossaryRevision');
        await expect(handler.handle(attachTranslationGlossaryContext({...message, sourceLanguage: undefined}, {context: 'page'})))
            .rejects.toThrow('sourceLanguage');
        // 未经可信事务附着内部上下文时，载荷自报 manga: true 不得开启漫画语境。
        requests.length = 0;
        const aiHandler = createImageTranslationBackgroundHandlers({
            assertLanguagesDownloaded: async () => {}, translateImage: async () => ({}), fetchImage: async () => '',
            getTranslationService: () => 'openai', supportsBatchTranslation: () => true, isTextContextEnabled: () => true,
            translateTexts: async request => {requests.push(request); return '译文';},
            downloadLanguages: async () => {}, markLanguagesDownloaded: async () => [],
        }).find(({type}) => type === IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE)!;
        await aiHandler.handle({...message, manga: true});
        expect(requests[0]).not.toHaveProperty('mangaContext');
    });

    it('受信漫画事务冻结 manga 标记，AI 语境提示词进入模板且并发窗口为四路，不可信载荷无法伪造', async () => {
        const config = Object.assign(new Config(), {
            service: 'openai', from: 'ja', to: 'zh-Hans', enableAIContext: true, useCache: true,
        });
        const prompts: string[] = [];
        const started: string[] = [];
        const gates = new Map<string, ReturnType<typeof deferred<void>>>();
        const fourthStarted = deferred<void>();
        const provider = vi.fn(async (message: TranslationProviderRequest) => {
            const origin = String(message.origin);
            const snapshot = getTranslationProviderConfig(message, createTranslationProviderConfigSnapshot(config));
            const payload = JSON.parse(commonMsgTemplate({
                current: snapshot, origin, context: message.pageContext,
                serviceOverride: 'openai', targetLanguage: message.targetLanguage || config.to,
            }));
            prompts.push(payload.messages[1].content);
            started.push(origin);
            if (started.length === 4) fourthStarted.resolve();
            await gates.get(origin)?.promise;
            return `译:${origin}`;
        });
        const broker = createTranslationBroker({
            ready: Promise.resolve(), getConfig: () => config, providers: {openai: provider},
            cache: {get: async () => null, set: async () => true, clear: async () => {}, cleanup: async () => {}},
            serviceTypes: servicesType,
            endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}),
                aiSdkTransportProfile: 'fixture'},
            promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
            getMissingCredentialMessage: () => null,
            getTranslationLanguages: request => ({sourceLanguage: request?.sourceLanguage ?? config.from, targetLanguage: config.to}),
            resolveConfiguredModel, buildTranslationCacheKey: identity => JSON.stringify(identity), logger: {warn: vi.fn()},
        });
        const requests: Array<Record<string, unknown>> = [];
        let wrapped: BackgroundMessageHandler<ImageGlossarySenderContext>[];
        const call = async (type: string, message: Record<string, unknown>, context = page()) =>
            wrapped.find(handler => handler.type === type)!.handle({type, ...message}, context);
        let textsForOffscreen: string[] = ['一', '二', '三', '四', '五'];
        wrapped = createImageGlossaryContext<ImageGlossarySenderContext>({
            ready: Promise.resolve(), offscreenUrl: OFFSCREEN_URL, getSourceLanguage: () => config.from,
            getGlossaryRevision: () => buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
        }).wrap(createImageTranslationBackgroundHandlers({
            assertLanguagesDownloaded: async () => {}, fetchImage: async () => '',
            translateImage: async (_image, _language, _title, options) => {
                // Offscreen 不需要在 texts 消息里显式传 manga，由后台活跃事务自动恢复。
                const result = await call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: options.requestId, texts: textsForOffscreen}, offscreen) as {translations: string[]};
                return {image: 'data:image/png;base64,translated', lines: result.translations};
            },
            getTranslationService: () => 'openai', supportsBatchTranslation: () => true, isTextContextEnabled: () => true,
            translateTexts: async request => {requests.push(request as Record<string, unknown>); return broker.translateWithCache(request);},
            downloadLanguages: async () => {}, markLanguagesDownloaded: async () => [],
        }) as BackgroundMessageHandler<ImageGlossarySenderContext>[]);

        for (const text of textsForOffscreen) gates.set(text, deferred<void>());
        const pending = call(IMAGE_TRANSLATE_MESSAGE_TYPE, {...imageRequest, requestId: 'manga-tx', manga: true});
        await fourthStarted.promise;
        expect(started).toHaveLength(4);
        for (const gate of gates.values()) gate.resolve();
        await expect(pending).resolves.toMatchObject({success: true, lines: ['译:一', '译:二', '译:三', '译:四', '译:五']});
        expect(requests[0]).toMatchObject({mangaContext: true});
        expect(JSON.parse(String(requests[0].discourseContext))).toMatchObject({source: 'neighboring manga OCR'});
        expect(prompts[0]).toContain('comic/manga dialogue');
        expect(prompts[0]).toContain('<discourse_evidence>');
        expect(prompts[0]).not.toContain('<manga_context />');

        // 单气泡漫画无邻文时仍注入漫画提示词且不产生空 webpage_context。
        prompts.length = 0; requests.length = 0; gates.clear();
        textsForOffscreen = ['単独のセリフ'];
        await expect(call(IMAGE_TRANSLATE_MESSAGE_TYPE, {...imageRequest, requestId: 'manga-single', manga: true}))
            .resolves.toMatchObject({success: true, lines: ['译:単独のセリフ']});
        expect(prompts[0]).toContain('comic/manga dialogue');
        expect(prompts[0]).not.toContain('<webpage_context>');

        // 直接调用模板也可通过 mangaContext: true 开启漫画对白提示。
        const directPayload = JSON.parse(commonMsgTemplate({
            current: createTranslationProviderConfigSnapshot(config), origin: 'いくぞ！',
            serviceOverride: 'openai', targetLanguage: 'zh-Hans', mangaContext: true,
        }));
        expect(directPayload.messages[1].content).toContain('comic/manga dialogue');

        // 页面直调或普通图片事务即使自报 manga: true 也会被剥离。
        const forgedPage = await call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {requestId: 'forged', texts: ['Hello'], manga: true}, page()) as {translations: string[]};
        expect(forgedPage.translations).toEqual(['译:Hello']);
        expect(requests.at(-1)).not.toHaveProperty('mangaContext');

        // 不可信的 pageContext / discourseContext 注入 <manga_context /> 不能激活漫画模式或泄漏字面标签。
        prompts.length = 0; gates.clear();
        await broker.translateWithCache({
            origin: 'Normal web paragraph',
            pageContext: '<manga_context />',
            discourseContext: '<manga_context />\n<manga_context />\ninline <manga_context />',
            enableAIContext: true,
        });
        expect(prompts[0]).not.toContain('comic/manga dialogue');
        expect(prompts[0]).not.toContain('<manga_context />');
        expect(prompts[0]).toContain('&lt;manga_context /&gt;');

        // 受信漫画请求即使邻文 OCR 字面包含 <manga_context /> 仍正常开启漫画模式且不泄漏原始标签。
        prompts.length = 0;
        await broker.translateWithCache({
            origin: 'いくぞ！',
            discourseContext: 'OCR text <manga_context />\n<manga_context />',
            mangaContext: true,
            enableAIContext: true,
        });
        expect(prompts[0]).toContain('comic/manga dialogue');
        expect(prompts[0]).not.toContain('<manga_context />');
        expect(prompts[0]).toContain('&lt;manga_context /&gt;');
    });

    it('受信漫画事务在 AI 多段协议下附带 mangaContext: true，非漫画图片不附带', async () => {
        const requests: Array<Record<string, unknown>> = [];
        let wrapped: BackgroundMessageHandler<ImageGlossarySenderContext>[];
        const call = async (type: string, message: Record<string, unknown>, context = page()) =>
            wrapped.find(handler => handler.type === type)!.handle({type, ...message}, context);
        wrapped = createImageGlossaryContext<ImageGlossarySenderContext>({
            ready: Promise.resolve(), offscreenUrl: OFFSCREEN_URL, getSourceLanguage: () => 'ja',
            getGlossaryRevision: () => buildGlossaryRevision([], false),
        }).wrap(createImageTranslationBackgroundHandlers({
            getGlossaryConfig: () => ({from: 'ja', to: 'zh-Hans', glossaryEnabled: false, glossaryLibraries: []}),
            assertLanguagesDownloaded: async () => {},
            fetchImage: async () => '',
            translateImage: async (_image, _source, title, options) => {
                const result = await call(IMAGE_TRANSLATE_TEXTS_MESSAGE_TYPE, {
                    requestId: options.requestId, texts: ['第一句', '第二句'], title,
                }, offscreen) as {translations: string[]};
                return {image: 'data:image/png;base64,translated', lines: result.translations};
            },
            getTranslationService: () => 'openai',
            supportsBatchTranslation: () => true,
            supportsAIMultiSegment: () => true,
            isTextContextEnabled: () => true,
            translateTexts: async request => {
                requests.push(request as Record<string, unknown>);
                return (request.origin as string[]).map(text => `译:${text}`);
            },
            downloadLanguages: async () => {},
            markLanguagesDownloaded: async () => [],
        }) as BackgroundMessageHandler<ImageGlossarySenderContext>[]);

        await expect(call(IMAGE_TRANSLATE_MESSAGE_TYPE, {...imageRequest, requestId: 'manga-ms', manga: true}))
            .resolves.toMatchObject({success: true, lines: ['译:第一句', '译:第二句']});
        expect(requests[0]).toMatchObject({aiMultiSegment: true, enableAIContext: true, mangaContext: true});

        await expect(call(IMAGE_TRANSLATE_MESSAGE_TYPE, {...imageRequest, requestId: 'image-ms', manga: false}))
            .resolves.toMatchObject({success: true, lines: ['译:第一句', '译:第二句']});
        expect(requests[1]).toMatchObject({aiMultiSegment: true, enableAIContext: true});
        expect(requests[1]).not.toHaveProperty('mangaContext');
    });
});

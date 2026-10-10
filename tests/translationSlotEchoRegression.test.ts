/**
 * @file tests/translationSlotEchoRegression.test.ts
 * 文件职责：通过真实 broker 入口验证全文单条槽协议的局部恢复、术语豁免和缓存安全。
 * 主要内容：注入 provider、内存 cache 与时钟，观察顺序、请求次数、旧缓存/pending 隔离、协议形状、取消和共享 deadline；零宽空槽验证首次恢复、恢复后拒绝和旧缓存失效；Chrome 接入真实请求构造与 offscreen 检测逻辑，覆盖逐槽长样本、调用快照与乱序结算，上下文泄漏验证只恢复坏槽；frontend 验证标记透传、中文过滤及失败会话复用。
 * 模块边界：不 mock broker 或校验算法，不使用网络、浏览器与真实存储；client 替身把 frontend 请求交给真实 broker，公共翻译出口仅替换为纯槽协议模块。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resolveTranslationLanguages} from '@/src/core/translation/languages';
import {parseTranslationSlots, serializeTranslationSlots,
    type SerializedTranslationSlots} from '@/src/core/translation/slotProtocol';
import {createTranslationBroker} from '@/src/services/translation/broker';
import {buildChromeOffscreenTranslationData} from '@/src/providers/translation/chromeTranslatorRequest';
import {translateWithChromeApi, type ChromeTranslationEnvironment} from '@/src/app/offscreen/translation';
import {attachTranslationRequestControl} from '@/src/services/translation/requestSnapshot';
import type {TranslationConfigSource, TranslationProvider} from '@/src/services/translation/types';
import type {TranslateOptions} from '@/src/app/translation/client';
import {translateTextSlots, type FullPageTranslationConfigSnapshot,
    type FullPageTranslationSessionCache} from '@/src/features/full-page-translation/content/translationRequest';

const ports = vi.hoisted(() => ({single: vi.fn(), batch: vi.fn()}));
vi.mock('@/src/app/translation/client', () => ({translateText: ports.single, translateTextBatch: ports.batch}));
vi.mock('@/src/services/config/store', () => ({config: {maxConcurrentTranslations: 2}}));
vi.mock('@/src/core/translation/public', () => import('@/src/core/translation/slotProtocol'));

const first = 'The software reads the document and translates the language on this page.';
const second = 'The second paragraph explains the settings for the computer network.';
const third = 'The final paragraph describes how the application stores translated documents.';
const translated = ['软件读取文档并翻译页面上的语言。', '第二段说明计算机网络设置。', '最后一段说明应用如何存储翻译文档。'];
const snapshot: FullPageTranslationConfigSnapshot = {service: 'openai', model: '', thinking: false,
    sourceLanguage: 'auto', targetLanguage: 'zh-Hans', useCache: true, enableAIContext: false,
    enableAIMultiSegment: false, displayMode: 'bilingual', style: 0};

function renderPacket(packet: SerializedTranslationSlots, outputs: readonly string[]): string {
    return outputs.map((output, index) => `${packet.starts[index]}${output}${packet.ends[index]}`).join('\n');
}
function slotRequest(sources: readonly string[]) {
    return {origin: serializeTranslationSlots(sources).payload, validateTranslationSlots: true as const};
}
function createHarness(options: {service?: string; now?: () => number} = {}) {
    const service = options.service ?? 'openai';
    const config: TranslationConfigSource = {
        service, from: 'auto', to: 'zh-Hans', useCache: true, enableAIContext: false,
        model: {[service]: 'fixture-model'}, customModel: {}, proxy: {}, custom: '', deeplx: '', newApiUrl: '',
        minimaxBillingPlan: 'payg', minimaxRegion: 'cn', mimoBillingPlan: 'payg', mimoRegion: 'cn',
        azureOpenaiEndpoint: '', customBody: {}, system_role: {}, user_role: {},
        deepseekApiType: 'auto', deepseekThinkingMode: 'disabled',
    };
    // 额外请求必须失败，不能用兜底成功值掩盖术语误重试。
    const provider = vi.fn<TranslationProvider>().mockRejectedValue(new Error('unexpected provider request'));
    const store = new Map<string, string>();
    const cacheGet = vi.fn(async (key: string) => store.get(key) ?? null);
    const cacheSet = vi.fn(async (key: string, value: string) => {store.set(key, value); return true;});
    const broker = createTranslationBroker({
        ready: Promise.resolve(), getConfig: () => config, providers: {[service]: provider},
        cache: {get: cacheGet, set: cacheSet, clear: async () => {store.clear();}, cleanup: async () => undefined},
        serviceTypes: {machine: new Set(['chromeTranslator', 'deepL']), isAI: selected => selected === 'openai',
            isAiSdk: () => false, isUseAIContext: selected => selected === 'openai'},
        endpointResolver: {resolveOpenAICompatibleEndpoint: () => ({endpoint: 'https://fixture.invalid/v1'}), aiSdkTransportProfile: 'fixture'},
        promptBuilder: {buildPageSummaryPrompt: text => text, buildPageSummarySystemPrompt: () => ''},
        getMissingCredentialMessage: () => null,
        getTranslationLanguages: overrides => resolveTranslationLanguages(overrides,
            {sourceLanguage: 'auto', targetLanguage: 'zh-Hans'}),
        resolveConfiguredModel: (selected, custom) => custom || selected || '',
        buildTranslationCacheKey: identity => JSON.stringify(identity),
        ...(options.now ? {now: options.now} : {}),
    });
    return {broker, provider, config, store, cacheGet, cacheSet};
}
function connectFrontend(harness: ReturnType<typeof createHarness>): void {
    ports.batch.mockImplementation((origins: readonly string[], context: string, options: TranslateOptions) => {
        const message = {origin: [...origins], context, useCache: options.useCache,
            serviceOverride: options.serviceOverride, modelOverride: options.modelOverride,
            sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage,
            aiMultiSegment: options.aiMultiSegment};
        return harness.broker.translateWithCache(options.signal
            ? attachTranslationRequestControl(message, {signal: options.signal, ownershipKey: 'frontend-array-fixture'}) : message);
    });
    ports.single.mockImplementation((origin: string, context: string, options: TranslateOptions) => {
        const message = {origin, context, useCache: options.useCache,
            sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage,
            validateTranslationSlots: options.validateTranslationSlots,
            ...(options.sourceLanguageDetectionText !== undefined
                ? {sourceLanguageDetectionText: options.sourceLanguageDetectionText} : {})};
        return harness.broker.translateWithCache(options.signal
            ? attachTranslationRequestControl(message, {signal: options.signal, ownershipKey: 'frontend-slot-fixture'}) : message);
    });
}
beforeEach(() => {
    vi.stubGlobal('document', {title: 'Slot protocol fixture'});
    ports.single.mockReset(); ports.batch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('真实 broker 的全文单条槽协议', () => {
    it('首槽以异命名空间字面标记开头时仍修复其回显并复用完整缓存', async () => {
        const h = createHarness({service: 'deepL'});
        connectFrontend(h);
        const literal = '___FLUENTREAD_literal_0_BEGIN___';
        const sources = [`${literal} ${first}`, second];
        const packet = serializeTranslationSlots(sources);
        const outputs = [`${literal} ${translated[0]}`, translated[1]!];
        const complete = renderPacket(packet, outputs);
        expect(parseTranslationSlots(packet, complete)).toEqual(outputs);
        h.provider.mockResolvedValueOnce(renderPacket(packet, [sources[0]!, outputs[1]!])).mockResolvedValueOnce(outputs[0]);
        await expect(h.broker.translateWithCache(slotRequest(sources))).resolves.toBe(complete);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, sources[0]]);
        expect(h.provider.mock.calls[1]![0]).toMatchObject({validateTranslationSlots: false});
        expect([...h.store.values()]).toEqual([complete]);
        await expect(h.broker.translateWithCache(slotRequest(sources))).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledTimes(2);
    });

    it('最后一槽内序号等于槽数的字面标记不能掩盖该槽回显', async () => {
        const h = createHarness({service: 'deepL'});
        connectFrontend(h);
        const literal = '___FLUENTREAD_abcdef_2_BEGIN___example___FLUENTREAD_abcdef_2_END___';
        // 默认 FNV 来源摘要为 abcdef；私用区尾部字符不影响自然语言正文。
        const sources = [first, `${second} Literal marker ${literal} eh\uea89\ue003`];
        const packet = serializeTranslationSlots(sources);
        expect(packet.starts[0]).toBe('___FLUENTREAD_abcdef_0_BEGIN___');
        const outputs = [translated[0]!, `${translated[1]} 字面标记 ${literal} eh\uea89\ue003`];
        const complete = renderPacket(packet, outputs);
        h.provider.mockResolvedValueOnce(renderPacket(packet, [outputs[0]!, sources[1]!])).mockResolvedValueOnce(outputs[1]);
        await expect(h.broker.translateWithCache(slotRequest(sources))).resolves.toBe(complete);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, sources[1]]);
        expect(h.provider.mock.calls[1]![0]).toMatchObject({validateTranslationSlots: false});
        expect(parseTranslationSlots(packet, complete)).toEqual(outputs);
        expect([...h.store.values()]).toEqual([complete]);
        await expect(h.broker.translateWithCache(slotRequest(sources))).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledTimes(2);
    });

    it('默认 serializer 生成的包含超范围字面标记时仍修复回显槽，并缓存完整结果', async () => {
        const h = createHarness({service: 'deepL'});
        connectFrontend(h);
        // 两个 code unit 令默认来源摘要为 abcdef；没有传自定义 nonce，复现真实生成包的边界。
        const literal = '___FLUENTREAD_abcdef_999_BEGIN___example___FLUENTREAD_abcdef_999_END___';
        const sources = [`${first} Literal marker ${literal} \ua306\uf5dd`, second];
        const packet = serializeTranslationSlots(sources);
        expect(packet.starts[0]).toBe('___FLUENTREAD_abcdef_0_BEGIN___');
        const outputs = [`${translated[0]} 字面标记 ${literal} \ua306\uf5dd`, translated[1]!];
        const partial = renderPacket(packet, [sources[0]!, outputs[1]!]);
        const complete = renderPacket(packet, outputs);
        h.provider.mockResolvedValueOnce(partial).mockResolvedValueOnce(outputs[0]);
        await expect(h.broker.translateWithCache(slotRequest(sources))).resolves.toBe(complete);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, sources[0]]);
        expect(h.provider.mock.calls[1]![0]).toMatchObject({validateTranslationSlots: false});
        expect(parseTranslationSlots(packet, complete)).toEqual(outputs);
        expect([...h.store.values()]).toEqual([complete]);
        expect([...h.store.values()]).not.toContain(partial);
        await expect(h.broker.translateWithCache(slotRequest(sources))).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledTimes(2);
    });

    it('只重试中间坏槽一次，保留两侧良槽及顺序，修复整包后复用缓存', async () => {
        const h = createHarness();
        const sources = [first, second, third];
        const packet = serializeTranslationSlots(sources);
        const complete = renderPacket(packet, translated);
        h.provider.mockResolvedValueOnce(renderPacket(packet, [translated[0]!, second + '\u200b!', translated[2]!]))
            .mockResolvedValueOnce(translated[1]);
        const result = await h.broker.translateWithCache(slotRequest(sources));
        expect(result).toBe(complete);
        expect(parseTranslationSlots(packet, result as string)).toEqual(translated);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, second]);
        expect(h.provider.mock.calls[1]![0]).toMatchObject({validateTranslationSlots: false});
        expect(h.cacheSet).toHaveBeenCalledOnce();
        expect([...h.store.values()]).toEqual([complete]);
        await expect(h.broker.translateWithCache(slotRequest(sources))).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(h.cacheSet).toHaveBeenCalledOnce();
    });

    it('坏槽连续回显使整包失败且不缓存，再次调用仍重新请求', async () => {
        const h = createHarness();
        const packet = serializeTranslationSlots([first, second]);
        const partial = renderPacket(packet, [first + '\u200b!', translated[1]!]);
        h.provider.mockImplementation(async message => message.origin === packet.payload ? partial : first + '!');
        for (let attempt = 0; attempt < 2; attempt++) {
            await expect(h.broker.translateWithCache(slotRequest([first, second]))).rejects.toMatchObject({
                kind: 'response', code: 'UNTRANSLATED_RESPONSE', retryable: false,
            });
        }
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, first, packet.payload, first]);
        expect(h.cacheSet).not.toHaveBeenCalled();
        expect(h.store.size).toBe(0);
    });

    it('Software Engineer 保留术语沿用冻结配置，良槽正常翻译且绝不多发请求', async () => {
        const h = createHarness();
        const sources = ['Software Engineer', second];
        const packet = serializeTranslationSlots(sources);
        h.config.glossaryEnabled = true;
        h.config.glossaryLibraries = [{id: 'preserve-job', name: '保留职业', enabled: true,
            sourceLanguage: '', targetLanguage: '', domains: [],
            entries: [{id: 'job', source: sources[0]!, target: '', caseSensitive: false}]}];
        h.provider.mockImplementationOnce(async message => {
            expect(message.origin).not.toContain('Software Engineer');
            // 上游执行期间编辑配置；本次恢复判断须沿用请求开始时的术语。
            h.config.glossaryEnabled = false;
            h.config.glossaryLibraries = [];
            return (message.origin as string).replace(second, translated[1]!);
        });
        const complete = renderPacket(packet, [sources[0]!, translated[1]!]);
        await expect(h.broker.translateWithCache(slotRequest(sources))).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledOnce();
        expect([...h.store.values()]).toEqual([complete]);
    });

    it('旧 slot-protocol 缓存中的部分回显不能复用，重新请求正常整包后替换', async () => {
        const h = createHarness();
        const packet = serializeTranslationSlots([first, second]);
        const complete = renderPacket(packet, translated.slice(0, 2));
        h.cacheGet.mockResolvedValueOnce(renderPacket(packet, [first, translated[1]!]));
        h.provider.mockResolvedValueOnce(complete);
        await expect(h.broker.translateWithCache(slotRequest([first, second]))).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledOnce();
        expect([...h.store.values()]).toEqual([complete]);
        await expect(h.broker.translateWithCache(slotRequest([first, second]))).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledOnce();
    });

    it('旧 single 模式的部分回显缓存不污染新协议请求，两种结果分别可复用', async () => {
        const h = createHarness();
        const packet = serializeTranslationSlots([first, second]);
        const partial = renderPacket(packet, [first, translated[1]!]);
        const complete = renderPacket(packet, translated.slice(0, 2));
        h.provider.mockResolvedValueOnce(partial).mockResolvedValueOnce(partial).mockResolvedValueOnce(translated[0]);
        await expect(h.broker.translateWithCache({origin: packet.payload})).resolves.toBe(partial);
        await expect(h.broker.translateWithCache(slotRequest([first, second]))).resolves.toBe(complete);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, packet.payload, first]);
        await expect(h.broker.translateWithCache({origin: packet.payload})).resolves.toBe(partial);
        await expect(h.broker.translateWithCache(slotRequest([first, second]))).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledTimes(3);
        expect([...h.store.values()]).toEqual([partial, complete]);
        expect([...h.store.keys()].map(key => JSON.parse(key).requestMode)).toEqual(['single', 'slot-protocol']);
    });

    it.each([undefined, false])('字面协议文本 flag=%s 按普通原文处理，不恢复内部回显槽', async flag => {
        const h = createHarness();
        const packet = serializeTranslationSlots([first, second]);
        const partial = renderPacket(packet, [first, translated[1]!]);
        h.provider.mockResolvedValueOnce(partial);
        const message = {origin: packet.payload, ...(flag === undefined ? {} : {validateTranslationSlots: flag})};
        await expect(h.broker.translateWithCache(message)).resolves.toBe(partial);
        await expect(h.broker.translateWithCache(message)).resolves.toBe(partial);
        expect(h.provider).toHaveBeenCalledOnce();
    });

    it.each(['custom-nonce', 'leading-prose'] as const)('flag=true 的 %s 原文不会误认成内部 canonical 包', async variant => {
        const h = createHarness();
        const packet = serializeTranslationSlots([first, second], variant === 'custom-nonce' ? 'literal' : undefined);
        const prefix = variant === 'leading-prose' ? 'Quoted protocol example:\n' : '';
        const origin = prefix + packet.payload;
        const result = prefix + renderPacket(packet, [first, translated[1]!]);
        h.provider.mockResolvedValueOnce(result);
        await expect(h.broker.translateWithCache({origin, validateTranslationSlots: true})).resolves.toBe(result);
        expect(h.provider).toHaveBeenCalledOnce();
        expect(h.provider.mock.calls[0]![0].origin).toBe(origin);
        expect(h.cacheSet).not.toHaveBeenCalled();
    });

    it('相同原文的 single 与 slot-protocol 在途工作隔离，协议调用不 JOIN 字面调用', async () => {
        const h = createHarness();
        const packet = serializeTranslationSlots([first, second]);
        const partial = renderPacket(packet, [first, translated[1]!]);
        const complete = renderPacket(packet, translated.slice(0, 2));
        let releaseLiteral!: (value: string) => void;
        let markLiteralStarted!: () => void;
        const literalStarted = new Promise<void>(resolve => {markLiteralStarted = resolve;});
        const literalResponse = new Promise<string>(resolve => {releaseLiteral = resolve;});
        h.provider.mockImplementationOnce(async () => {markLiteralStarted(); return literalResponse;})
            .mockResolvedValueOnce(complete);
        const literal = h.broker.translateWithCache({origin: packet.payload, useCache: false});
        await literalStarted;
        const protocol = h.broker.translateWithCache({...slotRequest([first, second]), useCache: false});
        const joined = Promise.allSettled([literal, protocol]);
        try {
            await vi.waitFor(() => expect(h.provider).toHaveBeenCalledTimes(2), {timeout: 500, interval: 5});
        } finally {
            releaseLiteral(partial);
            await joined;
        }
        await expect(literal).resolves.toBe(partial);
        await expect(protocol).resolves.toBe(complete);
        expect(h.provider.mock.calls.map(([message]) => message.validateTranslationSlots)).toEqual([undefined, true]);
    });

    it.each(['missing-end', 'reordered'] as const)('返回协议 %s 时交回 raw 供前端 fallback，重复调用也不缓存', async shape => {
        const h = createHarness();
        const packet = serializeTranslationSlots([first, second]);
        const result = shape === 'missing-end'
            ? renderPacket(packet, translated.slice(0, 2)).replace(packet.ends[1]!, '')
            : `${packet.starts[1]}${translated[1]}${packet.ends[1]}\n${packet.starts[0]}${translated[0]}${packet.ends[0]}`;
        h.provider.mockResolvedValueOnce(result).mockResolvedValueOnce(result);
        await expect(h.broker.translateWithCache(slotRequest([first, second]))).resolves.toBe(result);
        await expect(h.broker.translateWithCache(slotRequest([first, second]))).resolves.toBe(result);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, packet.payload]);
        expect(h.cacheSet).not.toHaveBeenCalled();
        expect(h.store.size).toBe(0);
    });

    it.each([' \t', '\u200b', ' \u200b\t\u200b'])('不可见空槽 %j 仅恢复该槽，保留良槽并缓存修复整包', async empty => {
        const h = createHarness();
        const packet = serializeTranslationSlots([first, second]);
        const complete = renderPacket(packet, translated.slice(0, 2));
        h.provider.mockResolvedValueOnce(renderPacket(packet, [empty, translated[1]!])).mockResolvedValueOnce(translated[0]);
        await expect(h.broker.translateWithCache({...slotRequest([first, second]), context: 'Document title'})).resolves.toBe(complete);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, first]);
        expect(h.provider.mock.calls[1]![0]).toMatchObject({context: '', pageContext: '', validateTranslationSlots: false});
        expect([...h.store.values()]).toEqual([complete]);
    });

    it.each([' \t', '\u200b', ' \u200b\t\u200b'])('恢复仍为不可见空槽 %j 时整包失败，不再请求或缓存', async empty => {
        const h = createHarness({service: 'deepL'});
        const packet = serializeTranslationSlots([first, second]);
        h.provider.mockResolvedValueOnce(renderPacket(packet, ['', translated[1]!])).mockResolvedValueOnce(empty);
        await expect(h.broker.translateWithCache(slotRequest([first, second]))).rejects.toMatchObject({
            kind: 'response', code: 'TRANSLATION_SLOT_RESPONSE_INVALID', retryable: false,
        });
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, first]);
        expect(h.cacheSet).not.toHaveBeenCalled();
    });

    it('旧缓存的零宽字符空槽不能作为成功整包复用', async () => {
        const h = createHarness({service: 'deepL'});
        const packet = serializeTranslationSlots([first, second]);
        const complete = renderPacket(packet, translated.slice(0, 2));
        h.cacheGet.mockResolvedValueOnce(renderPacket(packet, ['\u200b', translated[1]!]));
        h.provider.mockResolvedValueOnce(complete);
        await expect(h.broker.translateWithCache(slotRequest([first, second]))).resolves.toBe(complete);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload]);
        expect([...h.store.values()]).toEqual([complete]);
    });

    it('首包返回时共享 deadline 已耗尽，不启动坏槽恢复请求', async () => {
        let clock = 10_000;
        const h = createHarness({now: () => clock});
        const packet = serializeTranslationSlots([first, second]);
        h.provider.mockImplementationOnce(async () => {
            clock += 1_000;
            return renderPacket(packet, [first, translated[1]!]);
        });
        await expect(h.broker.translateWithCache({...slotRequest([first, second]), requestTimeoutMs: 1_000}))
            .rejects.toMatchObject({name: 'TranslationProviderDeadlineError'});
        expect(h.provider).toHaveBeenCalledOnce();
        expect(h.cacheSet).not.toHaveBeenCalled();
    });

    it('前一个坏槽耗尽剩余预算后，后一个坏槽不获得新 deadline 或启动新请求', async () => {
        let clock = 10_000;
        const h = createHarness({now: () => clock});
        const packet = serializeTranslationSlots([first, second, third]);
        h.provider.mockImplementationOnce(async () => {
            clock += 600;
            return renderPacket(packet, [first, second, translated[2]!]);
        }).mockImplementationOnce(async () => {clock += 400; return translated[0];});
        await expect(h.broker.translateWithCache({...slotRequest([first, second, third]), requestTimeoutMs: 1_000}))
            .rejects.toMatchObject({name: 'TranslationProviderDeadlineError'});
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, first]);
        expect(h.provider.mock.calls[1]![0].requestTimeoutMs).toBe(400);
        expect(h.cacheSet).not.toHaveBeenCalled();
    });

    it('首包回显返回前调用方取消，不发恢复请求或缓存', async () => {
        const h = createHarness();
        const controller = new AbortController();
        const packet = serializeTranslationSlots([first, second]);
        h.provider.mockImplementationOnce(async () => {controller.abort(); return renderPacket(packet, [first, translated[1]!]);});
        const message = attachTranslationRequestControl(slotRequest([first, second]), {
            signal: controller.signal, ownershipKey: 'cancel-slot-fixture',
        });
        await expect(h.broker.translateWithCache(message)).rejects.toMatchObject({name: 'AbortError'});
        expect(h.provider).toHaveBeenCalledOnce();
        expect((h.provider.mock.calls[0]![0].abortSignal as AbortSignal).aborted).toBe(true);
        expect(h.cacheSet).not.toHaveBeenCalled();
    });

    it('Chrome auto 恢复短槽沿用冻结的整段检测样本，避免短标题无法确定语言', async () => {
        const h = createHarness({service: 'chromeTranslator'});
        const packet = serializeTranslationSlots([first, second]);
        h.provider.mockResolvedValueOnce(renderPacket(packet, [translated[0]!, second])).mockResolvedValueOnce(translated[1]);
        await expect(h.broker.translateWithCache({...slotRequest([first, second]), sourceLanguage: 'auto',
            sourceLanguageDetectionText: [first, second].join('\n')})).resolves.toBe(renderPacket(packet, translated.slice(0, 2)));
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(h.provider.mock.calls[0]![0].sourceLanguageDetectionText).toBe([first, second].join('\n'));
        expect(h.provider.mock.calls[1]![0]).toMatchObject({origin: second, sourceLanguageDetectionText: [first, second].join('\n'), validateTranslationSlots: false});
    });

    it.each([
        {name: 'und', shortResult: {detectedLanguage: 'und', confidence: 0.99}},
        {name: 'en/0.39', shortResult: {detectedLanguage: 'en', confidence: 0.39}},
    ])('真实 Chrome 检测短标题返回 $name 时，broker 用冻结长样本只恢复 Software Engineer', async ({shortResult}) => {
        const h = createHarness({service: 'chromeTranslator'});
        const heading = 'Software Engineer';
        const sources = [heading, second];
        const packet = serializeTranslationSlots(sources);
        const detectionSample = sources.join('\n');
        const headingTranslation = '软件工程师';
        const complete = renderPacket(packet, [headingTranslation, translated[1]!]);
        const detect = vi.fn(async (text: string) => {
            if (text === detectionSample) return [{detectedLanguage: 'en', confidence: 0.99}];
            if (text === heading) return [shortResult];
            throw new Error('unexpected detection sample');
        });
        const detectorDestroy = vi.fn();
        const translate = vi.fn(async (text: string) => {
            if (text === packet.payload) return renderPacket(packet, [heading, translated[1]!]);
            if (text === heading) return headingTranslation;
            throw new Error('good slot must not be translated again');
        });
        const translatorCreate = vi.fn<NonNullable<ChromeTranslationEnvironment['Translator']>['create']>(async () => ({translate}));
        const environment: ChromeTranslationEnvironment = {
            LanguageDetector: {
                availability: vi.fn(async () => 'available'),
                create: vi.fn(async () => ({detect, destroy: detectorDestroy})),
            },
            Translator: {availability: vi.fn(async () => 'available'), create: translatorCreate},
        };
        const languageDefaults = {sourceLanguage: 'auto', targetLanguage: 'zh-Hans'};

        // 旧候选把检测样本缩成短槽：真实 request builder/offscreen 校验在创建 translator 前失败。
        await expect(translateWithChromeApi(buildChromeOffscreenTranslationData({
            origin: heading, sourceLanguage: 'auto', targetLanguage: 'zh-Hans', sourceLanguageDetectionText: heading,
        }, languageDefaults), environment)).rejects.toThrow('无法可靠识别源语言');
        expect(translatorCreate).not.toHaveBeenCalled();

        h.provider.mockImplementation(message => translateWithChromeApi(
            buildChromeOffscreenTranslationData(message, languageDefaults), environment, message.abortSignal as AbortSignal | undefined,
        ));
        const request = {...slotRequest(sources), sourceLanguage: 'auto', sourceLanguageDetectionText: detectionSample};
        const result = await h.broker.translateWithCache(request);
        expect(result).toBe(complete);
        expect(parseTranslationSlots(packet, result as string)).toEqual([headingTranslation, translated[1]]);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([packet.payload, heading]);
        expect(h.provider.mock.calls[1]![0]).toMatchObject({
            origin: heading, sourceLanguageDetectionText: detectionSample, validateTranslationSlots: false,
        });
        expect(detect.mock.calls.map(([text]) => text)).toEqual([heading, detectionSample, detectionSample]);
        expect(detectorDestroy).toHaveBeenCalledTimes(3);
        expect(translatorCreate).toHaveBeenCalledTimes(2);
        for (const [options] of translatorCreate.mock.calls) {
            expect(options).toMatchObject({sourceLanguage: 'en', targetLanguage: 'zh'});
        }
        expect(translate.mock.calls.map(([text]) => text)).toEqual([packet.payload, heading]);
        expect([...h.store.values()]).toEqual([complete]);
        await expect(h.broker.translateWithCache(request)).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(detect).toHaveBeenCalledTimes(3);
    });

    it('单槽强 marker 上下文泄漏只重试坏槽，正常摘要和两侧良槽均不重复请求', async () => {
        const h = createHarness();
        h.config.enableAIContext = true;
        const sources = [first, second, third];
        const packet = serializeTranslationSlots(sources);
        const pageContext = 'This page explains document translation, computer network settings, and application storage.';
        const summary = '页面介绍文档翻译、网络设置和应用存储。';
        const leaked = '<webpage_context>仅用于参考的页面上下文被泄漏。</webpage_context>';
        const partial = renderPacket(packet, [translated[0]!, leaked, translated[2]!]);
        const complete = renderPacket(packet, translated);
        h.provider.mockImplementation(async message => {
            if ('summaryPrompt' in message) {
                expect(message.summaryPrompt).toBe(pageContext);
                return summary;
            }
            if (message.origin === packet.payload) {
                expect(message.pageContext).toContain(summary);
                return partial;
            }
            if (message.origin === second) {
                expect(message).toMatchObject({context: '', pageContext: '', validateTranslationSlots: false});
                return translated[1]!;
            }
            throw new Error('good slot must not be translated again');
        });
        const request = {...slotRequest(sources), context: 'Document translation', pageContext};
        const result = await h.broker.translateWithCache(request);
        expect(result).toBe(complete);
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual(['', packet.payload, second]);
        expect(h.provider.mock.calls.filter(([message]) => 'summaryPrompt' in message)).toHaveLength(1);
        expect(parseTranslationSlots(packet, result as string)).toEqual(translated);
        expect([...h.store.values()]).toContain(complete);
        expect([...h.store.values()]).not.toContain(partial);
        await expect(h.broker.translateWithCache(request)).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledTimes(3);
    });

    it('整包掩盖的短槽上下文软重合只复验该槽，复验合法译名后可稳定命中缓存', async () => {
        const h = createHarness();
        h.config.enableAIContext = true;
        const sources = ['AI', second];
        const packet = serializeTranslationSlots(sources);
        const name = '人工智能驱动的网页阅读辅助工具';
        const pageContext = `页面摘要：${name}，可帮助用户理解网页并阅读更多相关内容。`;
        h.provider.mockImplementation(async message => {
            if ('summaryPrompt' in message) return '网页阅读工具摘要。';
            if (message.origin === packet.payload) return renderPacket(packet, [name, translated[1]!]);
            if (message.origin === sources[0]) {
                expect(message.pageContext).toBe('');
                return name;
            }
            throw new Error('unexpected request');
        });
        const request = {...slotRequest(sources), pageContext};
        const complete = renderPacket(packet, [name, translated[1]!]);
        await expect(h.broker.translateWithCache(request)).resolves.toBe(complete);
        expect(h.provider.mock.calls.filter(([message]) => !('summaryPrompt' in message))
            .map(([message]) => message.origin)).toEqual([packet.payload, sources[0]]);
        const calls = h.provider.mock.calls.length;
        await expect(h.broker.translateWithCache(request)).resolves.toBe(complete);
        expect(h.provider).toHaveBeenCalledTimes(calls);
    });
});

describe('frontend 区分原生数组、机器逐槽与 AI 槽协议的会话边界', () => {
    it.each([
        {name: 'und', shortResult: {detectedLanguage: 'und', confidence: 0.99}},
        {name: 'en/0.39', shortResult: {detectedLanguage: 'en', confidence: 0.39}},
    ])('Chrome 逐槽遇到短标题 $name 时使用冻结长样本，乱序完成仍按来源回填', async ({shortResult}) => {
        const h = createHarness({service: 'chromeTranslator'});
        connectFrontend(h);
        const heading = 'Software Engineer';
        const sources = [heading, second];
        const detectionSample = sources.join('\n');
        const outputs = ['软件工程师', translated[1]!];
        let markStarted!: () => void;
        const started = new Promise<void>(resolve => {markStarted = resolve;});
        let releaseSecond!: () => void;
        const secondGate = new Promise<void>(resolve => {releaseSecond = resolve;});
        let releaseHeading!: () => void;
        const secondCompleted = new Promise<void>(resolve => {releaseHeading = resolve;});
        const completed: string[] = [];
        const detect = vi.fn(async (text: string) => {
            if (text === detectionSample) return [{detectedLanguage: 'en', confidence: 0.99}];
            if (text === heading) return [shortResult];
            throw new Error('unexpected detection sample');
        });
        const destroy = vi.fn();
        const translate = vi.fn(async (text: string) => {
            if (text === heading) {
                markStarted();
                await secondCompleted;
                completed.push(heading);
                return outputs[0]!;
            }
            if (text === second) {
                await secondGate;
                completed.push(second);
                releaseHeading();
                return outputs[1]!;
            }
            throw new Error('unexpected source or marker packet');
        });
        const translatorCreate = vi.fn<NonNullable<ChromeTranslationEnvironment['Translator']>['create']>(async () => ({translate}));
        const environment: ChromeTranslationEnvironment = {
            LanguageDetector: {availability: vi.fn(async () => 'available'), create: vi.fn(async () => ({detect, destroy}))},
            Translator: {availability: vi.fn(async () => 'available'), create: translatorCreate},
        };
        h.provider.mockImplementation(message => translateWithChromeApi(
            buildChromeOffscreenTranslationData(message, {sourceLanguage: 'auto', targetLanguage: 'zh-Hans'}),
            environment, message.abortSignal as AbortSignal | undefined,
        ));
        const invocation = {...snapshot, service: 'chromeTranslator', useCache: false};
        const controller = new AbortController();
        const pending = translateTextSlots(sources, invocation, controller.signal);
        try {
            await started;
            sources[0] = 'Changed source';
            sources.reverse();
            invocation.service = 'deepL';
            invocation.sourceLanguage = 'fr';
            invocation.targetLanguage = 'en';
            invocation.model = 'edited-model';
            releaseSecond();
            await expect(pending).resolves.toEqual(outputs);
        } finally {
            releaseSecond();
            releaseHeading();
            controller.abort();
        }
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual([heading, second]);
        expect(detect.mock.calls.map(([text]) => text)).toEqual([detectionSample, detectionSample]);
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(translatorCreate).toHaveBeenCalledTimes(2);
        for (const [options] of translatorCreate.mock.calls) {
            expect(options).toMatchObject({sourceLanguage: 'en', targetLanguage: 'zh'});
        }
        expect(completed).toEqual([second, heading]);
        for (const [, , options] of ports.single.mock.calls) {
            expect(options).toMatchObject({serviceOverride: 'chromeTranslator', sourceLanguage: 'auto',
                targetLanguage: 'zh-Hans', sourceLanguageDetectionText: detectionSample, useCache: false,
                modelOverride: undefined, thinkingOverride: false});
            expect(options).not.toHaveProperty('validateTranslationSlots');
            expect(options).not.toHaveProperty('timeout');
        }
        expect(ports.batch).not.toHaveBeenCalled();
        expect(h.cacheSet).not.toHaveBeenCalled();
    });

    it.each([
        {service: 'localTranslation', sourceLanguage: 'auto', sample: true},
        {service: 'localTranslation', sourceLanguage: 'en', sample: false},
        {service: 'chromeTranslator', sourceLanguage: 'en', sample: false},
    ])('逐槽兼容 $service/$sourceLanguage 保留本地样本策略且不扩散样本', async ({service, sourceLanguage, sample}) => {
        const h = createHarness({service});
        connectFrontend(h);
        const sources = [first, second];
        h.provider.mockImplementation(async message => {
            if (message.origin === first) return translated[0]!;
            if (message.origin === second) return translated[1]!;
            throw new Error('unexpected provider request');
        });
        await expect(translateTextSlots(sources, {...snapshot, service, sourceLanguage, useCache: false}))
            .resolves.toEqual(translated.slice(0, 2));
        expect(h.provider.mock.calls.map(([message]) => message.origin)).toEqual(sources);
        for (const [, , options] of ports.single.mock.calls) {
            if (sample) expect(options.sourceLanguageDetectionText).toBe(sources.join('\n'));
            else expect(options).not.toHaveProperty('sourceLanguageDetectionText');
        }
        expect(ports.batch).not.toHaveBeenCalled();
        expect(h.cacheSet).not.toHaveBeenCalled();
    });

    it('DeepL frontend 使用真实 broker 的原生数组，中文过滤后保持逐项映射', async () => {
        const h = createHarness({service: 'deepL'});
        connectFrontend(h);
        const chinese = '这里的中文说明保持原样。';
        h.provider.mockResolvedValueOnce(translated.slice(0, 2));
        await expect(translateTextSlots([first, chinese, second], {...snapshot, service: 'deepL'}))
            .resolves.toEqual([translated[0], chinese, translated[1]]);
        expect(ports.batch).toHaveBeenCalledOnce();
        expect(ports.single).not.toHaveBeenCalled();
        expect(h.provider.mock.calls[0]![0].origin).toEqual([first, second]);
        expect(h.provider.mock.calls[0]![0].validateTranslationSlots).not.toBe(true);
    });

    it('serialized single 向 client 透传 validateTranslationSlots=true', async () => {
        const h = createHarness();
        connectFrontend(h);
        const packet = serializeTranslationSlots([first, second]);
        h.provider.mockResolvedValueOnce(renderPacket(packet, translated.slice(0, 2)));
        await expect(translateTextSlots([first, second], snapshot)).resolves.toEqual(translated.slice(0, 2));
        expect(ports.single).toHaveBeenCalledOnce();
        expect(ports.single.mock.calls[0]![0]).toBe(packet.payload);
        expect(ports.single.mock.calls[0]![2]).toMatchObject({validateTranslationSlots: true});
        expect(ports.batch).not.toHaveBeenCalled();
    });

    it('同目标中文留在原位置，不进入 provider 槽包', async () => {
        const h = createHarness();
        connectFrontend(h);
        const chinese = '这里的中文说明保持原样。';
        const packet = serializeTranslationSlots([first, second]);
        h.provider.mockResolvedValueOnce(renderPacket(packet, translated.slice(0, 2)));
        await expect(translateTextSlots([first, chinese, second], snapshot)).resolves.toEqual([translated[0], chinese, translated[1]]);
        expect(ports.single).toHaveBeenCalledOnce();
        expect(ports.single.mock.calls[0]![0]).toBe(packet.payload);
        expect(h.provider.mock.calls[0]![0].origin).not.toContain(chinese);
    });

    it('真实 broker 的回显失败进入失败会话缓存，重复调用保留失败且不重新请求', async () => {
        const h = createHarness();
        connectFrontend(h);
        const packet = serializeTranslationSlots([first, second]);
        const session: FullPageTranslationSessionCache = {active: true, translationSlotCache: new Map(),
            requestSignal: new AbortController().signal};
        h.provider.mockResolvedValueOnce(renderPacket(packet, [first, translated[1]!])).mockResolvedValueOnce(first);
        const failure = await translateTextSlots([first, second], snapshot, undefined, undefined, session)
            .then(() => {throw new Error('broker echo must fail');}, error => error);
        expect(failure).toMatchObject({kind: 'response', code: 'UNTRANSLATED_RESPONSE'});
        expect([...session.translationRequestCache!.values()]).toHaveLength(1);
        expect([...session.translationRequestCache!.values()][0]).toMatchObject({settled: true, failed: true});
        await expect(translateTextSlots([first, second], snapshot, undefined, undefined, session)).rejects.toBe(failure);
        expect(ports.single).toHaveBeenCalledOnce();
        expect(h.provider).toHaveBeenCalledTimes(2);
        expect(h.cacheSet).not.toHaveBeenCalled();
        expect(session.translationSlotCache.size).toBe(0);
    });
});

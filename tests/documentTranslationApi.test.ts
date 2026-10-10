import {TranslationRequestError, serializeTranslationError} from '@/src/services/translation/errors';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
    createDocumentFileLoadGuard,
    createDocumentSegmentTranslator,
    stripInventedPictographs,
} from '@/src/features/document-translation/services/translation';

const mocks = {
    defaultService: 'microsoft',
    waitUntilReady: vi.fn<() => Promise<void>>(),
    translateText: vi.fn(),
    translateTextBatch: vi.fn(),
};

const translateDocumentSegments = createDocumentSegmentTranslator({
    waitUntilReady: mocks.waitUntilReady,
    getDefaultService: () => mocks.defaultService,
    supportsBatch: (service) => service === 'microsoft' || service === 'freeTranslation',
    translateText: mocks.translateText,
    translateTextBatch: mocks.translateTextBatch,
});

beforeEach(() => {
    mocks.defaultService = 'microsoft';
    mocks.waitUntilReady.mockReset().mockResolvedValue();
    mocks.translateText.mockReset();
    mocks.translateTextBatch.mockReset();
});

describe('document translation API', () => {
    it.each(['microsoft', 'openai'])('默认服务 %s 在整份文档期间保持不变', async (service) => {
        mocks.defaultService = service;
        const observed: string[] = [];
        const translate = async (sources: string | string[], _context: string, options: {serviceOverride?: string}) => {
            observed.push(options.serviceOverride || mocks.defaultService);
            mocks.defaultService = 'changed-service';
            return sources;
        };
        mocks.translateText.mockImplementation(translate);
        mocks.translateTextBatch.mockImplementation(translate);
        await translateDocumentSegments(Array.from({length: 17}, (_, id) => ({id, source: `Source ${id}`})), {fileName: 'stable.txt'});
        expect(observed.length).toBeGreaterThan(1);
        expect(new Set(observed)).toEqual(new Set([service]));
    });

    it('显式服务与模型同语言一样在任务开始时快照，调用方修改参数不会混用模型', async () => {
        const options = {fileName: 'stable.txt', serviceOverride: 'openai', modelOverride: 'before'};
        const observed: Array<[string, string]> = [];
        mocks.translateText.mockImplementation(async (source: string, _context: string, request: typeof options) => {
            observed.push([request.serviceOverride, request.modelOverride]);
            options.serviceOverride = 'changed'; options.modelOverride = 'after';
            return source;
        });
        await translateDocumentSegments(Array.from({length: 7}, (_, id) => ({id, source: `Source ${id}`})), options);
        expect(observed).toEqual(Array.from({length: 7}, () => ['openai', 'before']));
    });

    it('整份文档冻结术语版本与选择，分批期间修改入口设置不能改变后续请求', async () => {
        const selected = ['technical'];
        const glossary = {glossaryIds: selected, glossaryRevision: 'version-before'};
        const gateway = {waitUntilReady: async () => {}, getDefaultService: () => 'microsoft',
            supportsBatch: () => true, getGlossaryOptions: () => glossary,
            translateText: vi.fn(), translateTextBatch: vi.fn(async (origins: string[]) => {
                selected.push('changed'); glossary.glossaryRevision = 'version-after';
                return origins;
            })};
        const translate = createDocumentSegmentTranslator(gateway);
        await translate(Array.from({length: 17}, (_, id) => ({id, source: `source ${id}`})), {fileName: 'sample.txt'});
        for (const call of gateway.translateTextBatch.mock.calls as unknown as Array<[string[], string, Record<string, unknown>]>) {
            expect(call[2]).toMatchObject({glossaryIds: ['technical'], glossaryRevision: 'version-before', glossaryContext: 'document'});
        }
        gateway.translateTextBatch.mockClear();
        await translate([{id: 0, source: 'source'}], {fileName: 'sample.txt', glossaryIds: [], glossaryRevision: 'explicit'});
        expect(gateway.translateTextBatch).toHaveBeenLastCalledWith(['source'], 'sample.txt', expect.objectContaining({glossaryIds: [], glossaryRevision: 'explicit'}));
    });
    it('较慢的旧文件解析完成后不能覆盖后选文件，重置也会作废在途解析', async () => {
        const guard = createDocumentFileLoadGuard();
        const commits: string[] = [];
        let resolveOld!: (value: string) => void;
        let resolveNew!: (value: string) => void;
        const oldParse = new Promise<string>((resolve) => { resolveOld = resolve; });
        const newParse = new Promise<string>((resolve) => { resolveNew = resolve; });
        const runLoad = async (parse: Promise<string>) => {
            const request = guard.begin();
            const value = await parse;
            if (request.isCurrent()) commits.push(value);
        };

        const oldLoad = runLoad(oldParse);
        const newLoad = runLoad(newParse);
        resolveNew('new.epub');
        await newLoad;
        resolveOld('old.pdf');
        await oldLoad;
        expect(commits).toEqual(['new.epub']);

        const pendingRequest = guard.begin();
        guard.invalidate();
        expect(pendingRequest.isCurrent()).toBe(false);
    });

    it('等待运行时就绪，并对空文档短路', async () => {
        await expect(translateDocumentSegments([], {fileName: 'empty.txt'})).resolves.toEqual([]);

        expect(mocks.waitUntilReady).toHaveBeenCalledOnce();
        expect(mocks.translateText).not.toHaveBeenCalled();
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
    });

    it('在开始前或批次之间取消时抛出 AbortError', async () => {
        const beforeStart = new AbortController();
        beforeStart.abort();
        await expect(translateDocumentSegments([{id: 0, source: 'Source'}], {
            fileName: 'sample.txt',
            signal: beforeStart.signal,
        })).rejects.toMatchObject({name: 'AbortError', message: '文档翻译已取消'});

        const betweenBatches = new AbortController();
        mocks.translateTextBatch.mockImplementation(async (sources: string[]) => {
            betweenBatches.abort();
            return sources.map((source) => `T:${source}`);
        });
        const segments = Array.from({length: 17}, (_, id) => ({id, source: `Source ${id}`}));
        await expect(translateDocumentSegments(segments, {
            fileName: 'sample.txt',
            signal: betweenBatches.signal,
        })).rejects.toMatchObject({name: 'AbortError'});
    });

    it('对机器翻译服务按大小分批，并报告完整进度', async () => {
        const segments = Array.from({length: 17}, (_, id) => ({id, source: `Source ${id}`}));
        const progress: number[] = [];
        mocks.translateTextBatch.mockImplementation(async (origins: string[]) => origins.map((origin) => `T:${origin}`));

        const result = await translateDocumentSegments(segments, {
            fileName: 'sample.txt',
            onProgress: ({completed}) => progress.push(completed),
        });

        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
        expect(result[0]).toBe('T:Source 0');
        expect(result[16]).toBe('T:Source 16');
        expect(progress.at(-1)).toBe(17);
        expect(mocks.translateText).not.toHaveBeenCalled();
    });

    it('未注入多段槽能力的 AI 服务保持逐段翻译，避免把数组隐式拼成一个请求', async () => {
        mocks.defaultService = 'openai';
        mocks.translateText.mockImplementation(async (origin: string) => `T:${origin}`);
        const segments = [
            {id: 0, source: 'First'},
            {id: 1, source: 'Second'},
            {id: 2, source: 'Third'},
        ];

        await expect(translateDocumentSegments(segments, {fileName: 'sample.md'})).resolves.toEqual([
            'T:First',
            'T:Second',
            'T:Third',
        ]);
        expect(mocks.translateText).toHaveBeenCalledTimes(3);
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
    });

    it('传递文档入口独立的服务和模型，不复用网页当前模型', async () => {
        mocks.defaultService = 'microsoft';
        mocks.translateText.mockImplementation(async (origin: string) => `T:${origin}`);

        await translateDocumentSegments([{id: 0, source: 'Document source'}], {
            fileName: 'sample.md',
            serviceOverride: 'openai',
            modelOverride: 'gpt-document-model',
            sourceLanguage: 'en',
            targetLanguage: 'fr',
        });

        expect(mocks.translateText).toHaveBeenCalledWith('Document source', 'sample.md', expect.objectContaining({
            serviceOverride: 'openai',
            modelOverride: 'gpt-document-model',
            sourceLanguage: 'en',
            targetLanguage: 'fr',
        }));
    });

    it('多批次任务在开始时快照语言对，不受任务期间配置变化影响', async () => {
        const segments = Array.from({length: 17}, (_, id) => ({id, source: `Source ${id}`}));
        const requestOptions = {
            fileName: 'stable-language.txt',
            sourceLanguage: 'en',
            targetLanguage: 'fr',
        };
        mocks.translateTextBatch.mockImplementation(async (sources: string[]) => {
            requestOptions.sourceLanguage = 'ja';
            requestOptions.targetLanguage = 'de';
            return sources.map((source) => `T:${source}`);
        });

        await translateDocumentSegments(segments, requestOptions);

        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
        for (const call of mocks.translateTextBatch.mock.calls) {
            expect(call[2]).toEqual(expect.objectContaining({
                sourceLanguage: 'en',
                targetLanguage: 'fr',
            }));
        }
    });

    it('使用默认文件名、清理显式页面上下文，并按字符上限拆批', async () => {
        mocks.defaultService = 'openai';
        mocks.translateText.mockResolvedValue('译文');
        await translateDocumentSegments([{id: 0, source: 'Source'}], {
            fileName: '',
            pageContext: '  supplied context  ',
        });
        expect(mocks.translateText).toHaveBeenCalledWith('Source', 'FluentRead 文档', expect.objectContaining({
            pageContext: 'supplied context',
        }));

        mocks.defaultService = 'microsoft';
        mocks.translateTextBatch.mockImplementation(async (sources: string[]) => sources);
        await translateDocumentSegments([
            {id: 0, source: 'a'.repeat(3_000)},
            {id: 1, source: 'b'.repeat(600)},
        ], {fileName: 'large.txt'});
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
    });

    it('批量服务失败时保留首个未完成片段序号和非 Error 原因', async () => {
        mocks.translateTextBatch.mockRejectedValue('provider offline');

        await expect(translateDocumentSegments([{id: 0, source: 'Broken'}], {fileName: 'sample.txt'}))
            .rejects.toThrow('第 1 段文档翻译失败：provider offline');
    });

    it('在单段失败时报告可定位的片段序号', async () => {
        mocks.defaultService = 'openai';
        mocks.translateText.mockRejectedValue(new Error('provider unavailable'));

        await expect(translateDocumentSegments([{id: 0, source: 'Broken'}], {fileName: 'sample.json'}))
            .rejects.toThrow('第 1 段文档翻译失败：provider unavailable');
    });

    it('AI 并行 worker 首次失败后不再派发余下段落或继续报告进度', async () => {
        mocks.defaultService = 'openai';
        const releaseSlowRequests: Array<() => void> = [];
        const progress: number[] = [];
        mocks.translateText.mockImplementation((origin: string) => {
            if (origin === 'fail') return Promise.reject(new Error('provider unavailable'));
            return new Promise<string>((resolve) => {
                releaseSlowRequests.push(() => resolve(`T:${origin}`));
            });
        });
        const segments = Array.from({length: 8}, (_, id) => ({
            id,
            source: id === 0 ? 'fail' : `Source ${id}`,
        }));

        await expect(translateDocumentSegments(segments, {
            fileName: 'sample.md',
            onProgress: ({completed}) => progress.push(completed),
        })).rejects.toThrow('第 1 段文档翻译失败');
        expect(mocks.translateText).toHaveBeenCalledTimes(3);

        releaseSlowRequests.forEach((release) => release());
        await Promise.resolve();
        await Promise.resolve();

        expect(mocks.translateText).toHaveBeenCalledTimes(3);
        expect(progress).toEqual([0]);
    });

    it('AI 请求取消和并发重复失败都只暴露首个终止结果', async () => {
        mocks.defaultService = 'openai';
        const controller = new AbortController();
        mocks.translateText.mockImplementation(async () => {
            controller.abort();
            throw new Error('provider unavailable');
        });
        await expect(translateDocumentSegments([{id: 0, source: 'Source'}], {
            fileName: 'sample.md',
            signal: controller.signal,
        })).rejects.toMatchObject({name: 'AbortError'});

        const releases: Array<(value: never) => void> = [];
        mocks.translateText.mockImplementation(() => new Promise((_, reject) => releases.push(reject)));
        const pending = translateDocumentSegments([
            {id: 0, source: 'One'},
            {id: 1, source: 'Two'},
        ], {fileName: 'sample.md'});
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        releases.forEach((reject) => reject('duplicate failure' as never));
        await expect(pending).rejects.toThrow('第 1 段文档翻译失败：duplicate failure');
        await Promise.resolve();
    });
});

describe('document translation transient AI batching', () => {
    const createAITranslator = (getDefaultModel?: (service: string) => string) => createDocumentSegmentTranslator({
        waitUntilReady: mocks.waitUntilReady,
        getDefaultService: () => mocks.defaultService,
        getDefaultModel,
        supportsBatch: service => service === 'microsoft',
        supportsAIMultiSegment: (service, model) => service === 'openai' && model !== 'translation-only',
        translateText: mocks.translateText,
        translateTextBatch: mocks.translateTextBatch,
    });
    const segments = Array.from({length: 53}, (_, id) => ({id, source: `Paragraph ${id}`}));
    const translated = (sources: string[]) => sources.map(source => `译 ${source}`);
    const protocolError = () => Object.assign(new Error('unsupported slots'), {code: 'AI_MULTI_SEGMENT_RESPONSE_INVALID'});

    it('defaults to sixteen-item AI batches and snapshots the transient toggle and default model', async () => {
        mocks.defaultService = 'openai';
        let model = 'first-model';
        const options = {fileName: 'paper.pdf', batchTranslation: true};
        mocks.translateTextBatch.mockImplementation(async (sources: string[]) => {
            options.batchTranslation = false;
            model = 'changed-model';
            return translated(sources);
        });
        const result = await createAITranslator(() => model)(segments, options);
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0].length)).toEqual([16, 16, 16, 5]);
        for (const call of mocks.translateTextBatch.mock.calls) {
            expect(call[2]).toMatchObject({aiMultiSegment: true, serviceOverride: 'openai', modelOverride: 'first-model'});
        }
        expect(result).toEqual(translated(segments.map(segment => segment.source)));
        expect(mocks.translateText).not.toHaveBeenCalled();
        mocks.translateTextBatch.mockClear();
        await createAITranslator()([{id: 0, source: 'Default enabled'}], {fileName: 'paper.pdf'});
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
    });

    it.each(['openai', 'microsoft'])('closing document batching uses single requests for %s and leaves the next document enabled', async service => {
        mocks.defaultService = service;
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        mocks.translateTextBatch.mockImplementation(async sources => translated(sources));
        const translate = createAITranslator();
        const short = segments.slice(0, 4);
        expect(await translate(short, {fileName: 'disabled.pdf', batchTranslation: false})).toEqual(translated(short.map(segment => segment.source)));
        expect(mocks.translateText).toHaveBeenCalledTimes(4);
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
        await translate(short, {fileName: 'next.pdf'});
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateTextBatch.mock.calls[0][2].aiMultiSegment).toBe(service === 'openai' ? true : undefined);
    });

    it('keeps translation-only models on their native single-request path', async () => {
        mocks.defaultService = 'openai';
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        await createAITranslator(() => 'translation-only')(segments.slice(0, 2), {fileName: 'paper.pdf'});
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
        expect(mocks.translateText.mock.calls.every(call => call[2].modelOverride === 'translation-only')).toBe(true);
    });

    it('removes duplicate sources before allocating batch size and commits all repeated rows in order', async () => {
        mocks.defaultService = 'openai';
        const repeated = Array.from({length: 512}, (_, id) => ({id, source: `Row ${Math.floor(id / 32)}`}));
        mocks.translateTextBatch.mockImplementation(async sources => translated(sources));
        const committed: number[] = [];
        const progress: number[] = [];
        const result = await createAITranslator()(repeated, {fileName: 'table.pdf', onSegment: ({id}) => committed.push(id), onProgress: ({completed}) => progress.push(completed)});
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateTextBatch.mock.calls[0][0]).toEqual(Array.from({length: 16}, (_, id) => `Row ${id}`));
        expect(result).toEqual(translated(repeated.map(segment => segment.source)));
        expect(committed).toEqual(repeated.map(segment => segment.id));
        expect(progress).toEqual([0, 512]);
    });

    it.each([true, false])('stops duplicate-row callbacks immediately when the first callback cancels (batch=%s)', async batchTranslation => {
        mocks.defaultService = 'openai';
        mocks.translateTextBatch.mockImplementation(async sources => translated(sources));
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        const repeated = [{id: 0, source: 'Same source'}, {id: 1, source: 'Same source'}];
        const controller = new AbortController();
        const committed = vi.fn(() => controller.abort());
        await expect(createAITranslator()(repeated, {fileName: 'paper.pdf', batchTranslation, signal: controller.signal, onSegment: committed})).rejects.toMatchObject({name: 'AbortError'});
        expect(committed).toHaveBeenCalledOnce();
        expect(committed).toHaveBeenCalledWith({id: 0, translation: '译 Same source'});
    });

    it('uses the currently visible occurrence when prioritizing a repeated source', async () => {
        mocks.defaultService = 'openai';
        const repeated = ['Header', 'First sentence', 'Second sentence', 'Header'].map((source, id) => ({id, source}));
        mocks.translateTextBatch.mockImplementation(async sources => translated(sources));
        const priorities: number[][] = [];
        await createAITranslator()(repeated, {fileName: 'paper.pdf', batchLimits: {items: 2}, batchConcurrency: 1, prioritize: pending => {
            priorities.push(pending.map(segment => segment.id));
            return [...pending].sort((left, right) => Math.abs(left.id - 3) - Math.abs(right.id - 3));
        }});
        expect(priorities[0]).toEqual([0, 3, 1, 2]);
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0])).toEqual([['Header', 'Second sentence'], ['First sentence']]);
    });

    it('only downgrades malformed AI slots once per document and bounds fallback concurrency', async () => {
        mocks.defaultService = 'openai';
        mocks.translateTextBatch.mockRejectedValue(protocolError());
        let inFlight = 0, peak = 0;
        mocks.translateText.mockImplementation(async source => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            if (source === 'Paragraph 48') throw Object.assign(new Error('echo'), {code: 'UNTRANSLATED_RESPONSE'});
            return `译 ${source}`;
        });
        const waits: number[] = [];
        const translate = createAITranslator();
        const result = await translate(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 120_000, sleep: async delay => {waits.push(delay);}}});
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
        expect(mocks.translateText).toHaveBeenCalledTimes(53);
        expect(peak).toBe(3);
        expect(waits).toEqual([]);
        expect(result).toEqual(segments.map(segment => segment.id === 48 ? segment.source : `译 ${segment.source}`));
        mocks.translateTextBatch.mockClear().mockImplementation(async sources => translated(sources));
        await translate(segments.slice(0, 2), {fileName: 'next.pdf'});
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
    });

    it('backs off a limited AI batch without expanding it into single requests', async () => {
        mocks.defaultService = 'openai';
        const waits: number[] = [];
        mocks.translateTextBatch.mockRejectedValueOnce(new Error('429 rate limited')).mockImplementation(async sources => translated(sources));
        await createAITranslator()(segments.slice(0, 16), {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 2_000, sleep: async delay => {waits.push(delay);}}});
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
        expect(waits).toEqual([2_000]);
        expect(mocks.translateText).not.toHaveBeenCalled();
    });

    it('retains completed batches on failure and resumes only the remaining segments', async () => {
        mocks.defaultService = 'openai';
        mocks.translateTextBatch.mockImplementationOnce(async sources => translated(sources)).mockRejectedValueOnce(new Error('403 denied'));
        const initial = Array<string>(32).fill('');
        const translate = createAITranslator();
        await expect(translate(segments.slice(0, 32), {fileName: 'paper.pdf', batchConcurrency: 1, onSegment: ({id, translation}) => {initial[id] = translation;}})).rejects.toThrow('第 17 段文档翻译失败：403 denied');
        expect(initial.filter(Boolean)).toHaveLength(16);
        expect(mocks.translateText).not.toHaveBeenCalled();
        mocks.translateTextBatch.mockClear().mockImplementation(async sources => translated(sources));
        const resumed = await translate(segments.slice(0, 32), {fileName: 'paper.pdf', initialTranslations: initial});
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateTextBatch.mock.calls[0][0]).toEqual(segments.slice(16, 32).map(segment => segment.source));
        expect(resumed).toEqual(translated(segments.slice(0, 32).map(segment => segment.source)));
    });

    it('cancels all claimed AI batches without claiming later work or committing late results', async () => {
        mocks.defaultService = 'openai';
        const controller = new AbortController();
        const releases: Array<() => void> = [];
        mocks.translateTextBatch.mockImplementation((sources: string[], _context: string, options: {signal?: AbortSignal}) => {
            expect(options.signal).toBe(controller.signal);
            return new Promise(resolve => releases.push(() => resolve(translated(sources))));
        });
        const committed = vi.fn();
        const running = createAITranslator()(segments, {fileName: 'paper.pdf', signal: controller.signal, onSegment: committed});
        const outcome = expect(running).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(releases).toHaveLength(3));
        controller.abort();
        releases.forEach(release => release());
        await outcome;
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
        expect(committed).not.toHaveBeenCalled();
    });

    it.each(['resolve', 'reject'])('stops an echoed batch fallback when another batch failed before its single request can %s', async completion => {
        mocks.defaultService = 'openai';
        const batches: Array<{resolve: (value: string[]) => void; reject: (error: Error) => void}> = [];
        const singles: Array<{resolve: (value: string) => void; reject: (error: Error) => void}> = [];
        mocks.translateTextBatch.mockImplementation(() => new Promise((resolve, reject) => batches.push({resolve, reject})));
        mocks.translateText.mockImplementation(() => new Promise((resolve, reject) => singles.push({resolve, reject})));
        const committed = vi.fn();
        const running = createAITranslator()(segments, {fileName: 'paper.pdf', onSegment: committed});
        const outcome = expect(running).rejects.toThrow('第 17 段文档翻译失败：quota exhausted');
        await vi.waitFor(() => expect(batches).toHaveLength(3));
        batches[0].reject(Object.assign(new Error('echo'), {code: 'UNTRANSLATED_RESPONSE'}));
        await vi.waitFor(() => expect(singles).toHaveLength(1));
        batches[1].reject(new Error('quota exhausted'));
        await outcome;
        if (completion === 'resolve') singles[0].resolve('late translation');
        else singles[0].reject(new Error('late failure'));
        batches[2].resolve(translated(segments.slice(32, 48).map(segment => segment.source)));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(mocks.translateText).toHaveBeenCalledOnce();
        expect(committed).not.toHaveBeenCalled();
    });

    it('does not restart a batch after its backoff if another worker already failed', async () => {
        mocks.defaultService = 'openai';
        let releaseSleep!: () => void;
        const batches: Array<{reject: (error: Error) => void}> = [];
        mocks.translateTextBatch.mockImplementation(() => new Promise((_resolve, reject) => batches.push({reject})));
        const running = createAITranslator()(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 2000, sleep: () => new Promise(resolve => {releaseSleep = resolve;})}});
        const outcome = expect(running).rejects.toMatchObject({code: 'TRANSLATION_DISABLED'});
        await vi.waitFor(() => expect(batches).toHaveLength(3));
        batches[0].reject(new Error('temporary'));
        await vi.waitFor(() => expect(releaseSleep).toBeTypeOf('function'));
        batches[1].reject(new TranslationRequestError({kind: 'config', retryable: false, message: 'disabled', code: 'TRANSLATION_DISABLED'} as never));
        await outcome;
        releaseSleep();
        batches[2].reject(new Error('late'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
        expect(mocks.translateText).not.toHaveBeenCalled();
    });
});

describe('document incremental translation and resume', () => {
    const segments = Array.from({length: 18}, (_, id) => ({id, source: `Paragraph ${id}`}));

    it('批次成功后立即提交片段，失败后仅补译缺失内容并保留人工校订', async () => {
        const committed: string[] = [];
        mocks.translateTextBatch.mockResolvedValueOnce(segments.slice(0, 16).map(({id}) => `译文 ${id}`)).mockRejectedValueOnce(new Error('offline'));
        await expect(translateDocumentSegments(segments, {fileName: 'resume.txt', onSegment: ({id, translation}) => { committed[id] = translation; }})).rejects.toThrow('第 17 段');
        expect(committed).toHaveLength(16);
        committed[0] = '人工校订';
        const saved = [...committed];
        const progress: number[] = [];
        mocks.translateTextBatch.mockResolvedValueOnce(['译文 16', '译文 17']);
        const result = await translateDocumentSegments(segments, {fileName: 'resume.txt', initialTranslations: committed, onProgress: ({completed}) => progress.push(completed)});
        expect(mocks.translateTextBatch.mock.calls.at(-1)?.[0]).toEqual(['Paragraph 16', 'Paragraph 17']);
        expect(result).toEqual([...saved, '译文 16', '译文 17']);
        expect(committed).toEqual(saved);
        expect(progress).toEqual([16, 18]);
    });

    it('取消后网关即使正常返回，也不得提交迟到批次', async () => {
        const controller = new AbortController();
        const onSegment = vi.fn();
        mocks.translateTextBatch.mockImplementation(async () => { controller.abort(); return ['迟到译文']; });
        await expect(translateDocumentSegments(segments.slice(0, 1), {fileName: 'cancel.txt', signal: controller.signal, onSegment})).rejects.toMatchObject({name: 'AbortError'});
        expect(onSegment).not.toHaveBeenCalled();
    });

    it.each([[['only one']], [['ok', '']], [['ok', 42]]])('不完整批次 %j 不能污染已完成结果', async (result) => {
        const onSegment = vi.fn();
        mocks.translateTextBatch.mockResolvedValue(result);
        await expect(translateDocumentSegments(segments.slice(0, 2), {fileName: 'bad.txt', onSegment})).rejects.toThrow('片段不完整');
        expect(onSegment).not.toHaveBeenCalled();
    });

    it('单段并发返回乱序时保留原始位置，空白位置可以继续翻译', async () => {
        mocks.defaultService = 'openai';
        const onSegment = vi.fn();
        mocks.translateText.mockResolvedValue('补译');
        const result = await translateDocumentSegments(segments.slice(0, 3), {fileName: 'single.txt', initialTranslations: ['校订', ' ', '已完成'], onSegment});
        expect(result).toEqual(['校订', '补译', '已完成']);
        expect(onSegment).toHaveBeenCalledOnce();
        expect(onSegment).toHaveBeenCalledWith({id: 1, translation: '补译'});
        expect(mocks.translateText.mock.calls[0][0]).toBe('Paragraph 1');
        mocks.translateText.mockClear();
        await expect(translateDocumentSegments(segments.slice(0, 3), {fileName: 'done.txt', initialTranslations: result})).resolves.toEqual(result);
        expect(mocks.translateText).not.toHaveBeenCalled();
    });

    it.each(['', '   ', 42])('拒绝单段空白或无效返回 %j', async (result) => {
        mocks.defaultService = 'openai';
        mocks.translateText.mockResolvedValue(result);
        const onSegment = vi.fn();
        await expect(translateDocumentSegments(segments.slice(0, 1), {fileName: 'empty.txt', onSegment})).rejects.toThrow('空译文');
        expect(onSegment).not.toHaveBeenCalled();
    });

    it('单段服务忽略取消信号时也不能产生迟到提交', async () => {
        mocks.defaultService = 'openai';
        const controller = new AbortController();
        const onSegment = vi.fn();
        mocks.translateText.mockImplementation(async () => { controller.abort(); return '迟到译文'; });
        await expect(translateDocumentSegments(segments.slice(0, 1), {fileName: 'late.txt', signal: controller.signal, onSegment})).rejects.toMatchObject({name: 'AbortError'});
        expect(onSegment).not.toHaveBeenCalled();
    });
});

// 后台停用响应可以早于本页面的配置广播，必须透传状态码供页面转为暂停。
it.each(['microsoft', 'openai'])('服务 %s 的全局暂停不被包装为片段翻译失败', async (service) => {
    const error = new TranslationRequestError(serializeTranslationError({message: 'paused', code: 'TRANSLATION_DISABLED', retryable: false}));
    const translate = createDocumentSegmentTranslator({
        waitUntilReady: async () => {}, getDefaultService: () => service,
        supportsBatch: value => value === 'microsoft',
        translateText: async () => {throw error;}, translateTextBatch: async () => {throw error;},
    });
    await expect(translate([{id: 0, source: 'Source text'}], {fileName: 'sample.txt'})).rejects.toBe(error);
});

describe('document translation reading-order priority and batch sizing', () => {
    const segments = Array.from({length: 6}, (_, id) => ({id, source: `Source ${id}`}));
    const echo = async (sources: string[]) => sources.map(source => `译 ${source}`);

    it('re-orders the remaining segments before every batch and honours tighter batch limits', async () => {
        mocks.translateTextBatch.mockImplementation(echo);
        let focus = 4;
        const order: number[] = [];
        const result = await translateDocumentSegments(segments, {
            fileName: 'paper.pdf', batchLimits: {items: 2}, batchConcurrency: 1,
            prioritize: pending => [...pending].sort((left, right) => Math.abs(left.id - focus) - Math.abs(right.id - focus) || left.id - right.id),
            onSegment: ({id}) => {order.push(id); if (id === 3) focus = 0;},
        });
        // 先译阅读位置附近的两段；读者翻回开头后，下一批立即改从开头继续。
        expect(order).toEqual([4, 3, 0, 1, 2, 5]);
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0])).toEqual([['Source 4', 'Source 3'], ['Source 0', 'Source 1'], ['Source 2', 'Source 5']]);
        expect(result).toEqual(segments.map(segment => `译 ${segment.source}`));
    });

    it('keeps several batches in flight so the first finished batch is shown first, and stops claiming work after a failure', async () => {
        const releases: Array<() => void> = [];
        let inFlight = 0, peak = 0;
        mocks.translateTextBatch.mockImplementation(async (sources: string[]) => {
            inFlight += 1; peak = Math.max(peak, inFlight);
            await new Promise<void>(resolve => releases.push(resolve));
            inFlight -= 1;
            return sources.map(source => `译 ${source}`);
        });
        const order: number[] = [];
        const running = translateDocumentSegments(segments, {fileName: 'paper.pdf', batchLimits: {items: 1}, onSegment: ({id}) => order.push(id)});
        await vi.waitFor(() => expect(releases).toHaveLength(3));
        // 第三批先返回就先显示，不必等前两批。
        releases[2](); await vi.waitFor(() => expect(order).toEqual([2]));
        releases[0](); releases[1]();
        await vi.waitFor(() => expect(releases).toHaveLength(6));
        releases.slice(3).forEach(release => release());
        expect(await running).toEqual(segments.map(segment => `译 ${segment.source}`));
        expect(peak).toBe(3);

        // 一批失败后，其余在途批次的结果不再提交，也不再认领新的片段。
        mocks.translateTextBatch.mockReset();
        const pending: Array<{resolve: (value: string[]) => void; reject: (error: Error) => void; sources: string[]}> = [];
        mocks.translateTextBatch.mockImplementation((sources: string[]) => new Promise<string[]>((resolve, reject) => pending.push({resolve, reject, sources})));
        const committed: number[] = [];
        const failing = translateDocumentSegments(segments, {fileName: 'paper.pdf', batchLimits: {items: 1}, onSegment: ({id}) => committed.push(id)});
        const outcome = expect(failing).rejects.toThrow('第 1 段文档翻译失败：quota exceeded');
        await vi.waitFor(() => expect(pending).toHaveLength(3));
        pending[0].reject(new Error('quota exceeded'));
        await outcome;
        pending[1].resolve(['late']); pending[2].reject(new Error('also late'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(committed).toEqual([]); expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
    });

    it('limits a batch by characters, always takes at least one segment and ignores invalid or loosened limits', async () => {
        mocks.translateTextBatch.mockImplementation(echo);
        const long = [{id: 0, source: 'a'.repeat(30)}, {id: 1, source: 'b'.repeat(30)}, {id: 2, source: 'c'.repeat(5)}];
        await translateDocumentSegments(long, {fileName: 'paper.pdf', batchLimits: {characters: 40}});
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0].length)).toEqual([1, 2]);
        mocks.translateTextBatch.mockClear();
        await translateDocumentSegments(long, {fileName: 'paper.pdf', batchLimits: {characters: 10}});
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0].length)).toEqual([1, 1, 1]);
        mocks.translateTextBatch.mockClear();
        const many = Array.from({length: 20}, (_, id) => ({id, source: `x${id}`}));
        await translateDocumentSegments(many, {fileName: 'paper.pdf', batchLimits: {items: 0, characters: Number.NaN}});
        await translateDocumentSegments(many, {fileName: 'paper.pdf', batchLimits: {items: 500, characters: 1e9}});
        await translateDocumentSegments(many, {fileName: 'paper.pdf', batchLimits: {items: 2.9}});
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0].length)).toEqual([16, 4, 16, 4, ...Array.from({length: 10}, () => 2)]);
    });

    it('translates identical sources once, commits every repeat together and reuses earlier translations on resume', async () => {
        mocks.translateTextBatch.mockImplementation(async (sources: string[]) => sources.map((source, index) => `译${mocks.translateTextBatch.mock.calls.length}-${index} ${source}`));
        const lines = ['Hello.', 'Bye.', 'Hello.', 'Wait.', 'Bye.', 'Hello.'].map((source, id) => ({id, source}));
        const committed: number[] = [], progress: number[] = [];
        // 每批一段：重复的台词不再各占一批，也不会因为落在不同批次而译法不同。
        const result = await translateDocumentSegments(lines, {fileName: 'show.srt', batchLimits: {items: 1}, batchConcurrency: 1, onSegment: ({id}) => committed.push(id), onProgress: ({completed}) => progress.push(completed)});
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0])).toEqual([['Hello.'], ['Bye.'], ['Wait.']]);
        expect(result).toEqual(['译1-0 Hello.', '译2-0 Bye.', '译1-0 Hello.', '译3-0 Wait.', '译2-0 Bye.', '译1-0 Hello.']);
        expect(committed).toEqual([0, 2, 5, 1, 4, 3]); expect(progress).toEqual([0, 3, 5, 6]);
        // 同一批里的重复原文只发送一次。
        mocks.translateTextBatch.mockClear();
        await translateDocumentSegments(lines, {fileName: 'show.srt'});
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0])).toEqual([['Hello.', 'Bye.', 'Wait.']]);
        // 继续任务：已有译文的原文直接复用，只请求真正没译过的。
        mocks.translateTextBatch.mockClear();
        const resumed = await translateDocumentSegments(lines, {fileName: 'show.srt', initialTranslations: ['你好。', '', '', '', '', '']});
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0])).toEqual([['Bye.', 'Wait.']]);
        expect([resumed[0], resumed[2], resumed[5]]).toEqual(['你好。', '你好。', '你好。']); expect(resumed[1]).toBe(resumed[4]);
        // 不支持批量的服务同样只翻译一次。
        mocks.defaultService = 'deepseek'; mocks.translateText.mockImplementation(async (source: string) => `单 ${source}`);
        expect(await translateDocumentSegments(lines, {fileName: 'show.srt'})).toEqual(['单 Hello.', '单 Bye.', '单 Hello.', '单 Wait.', '单 Bye.', '单 Hello.']);
        expect(mocks.translateText.mock.calls.map(call => call[0]).sort()).toEqual(['Bye.', 'Hello.', 'Wait.']);
    });

    it('keeps every segment when a prioritizer drops, duplicates or invents segments', async () => {
        mocks.translateTextBatch.mockImplementation(echo);
        for (const prioritize of [
            (pending: readonly typeof segments[number][]) => pending.slice(1),
            (pending: readonly typeof segments[number][]) => pending.map(() => pending[0]),
            (pending: readonly typeof segments[number][]) => pending.map((segment, index) => index === 0 ? {...segment} : segment),
        ]) {
            const order: number[] = [];
            const result = await translateDocumentSegments(segments, {fileName: 'paper.pdf', prioritize, onSegment: ({id}) => order.push(id)});
            expect(order).toEqual([0, 1, 2, 3, 4, 5]);
            expect(result.every(Boolean)).toBe(true);
        }
    });

    it('lets single-request services claim the most relevant remaining segment', async () => {
        mocks.defaultService = 'openai';
        mocks.translateText.mockImplementation(async (source: string) => `译 ${source}`);
        const order: number[] = [];
        await translateDocumentSegments(segments, {fileName: 'paper.pdf', prioritize: pending => [...pending].reverse(), onSegment: ({id}) => order.push(id)});
        // 三个并发 worker 每次领取都重排；反转两次即恢复，领取顺序在首尾之间交替。
        expect([...order].sort()).toEqual([0, 1, 2, 3, 4, 5]);
        expect(order[0]).toBe(5);
    });

    it('removes pictographs a service invents while keeping the ones the author wrote', async () => {
        expect(stripInventedPictographs('g(x) is linear', 'g😍~x 是线性函数')).toBe('g~x 是线性函数');
        expect(stripInventedPictographs('© 2013 The Authors ™', '© 2013 作者 ™ ✅')).toBe('© 2013 作者 ™ ');
        expect(stripInventedPictographs('Family 👨‍👩‍👧 trip ❤️', '家庭 👨‍👩‍👧 旅行 ❤️ 🎉')).toBe('家庭 👨‍👩‍👧 旅行 ❤️ ');
        expect(stripInventedPictographs('Smile', '😀')).toBe('😀');
        expect(stripInventedPictographs('Plain', '普通译文')).toBe('普通译文');
        mocks.translateTextBatch.mockResolvedValue(['如果 g😍~x 是线性函数']);
        const committed: string[] = [];
        expect(await translateDocumentSegments([{id: 0, source: 'if g(x) were the linear function'}], {fileName: 'paper.pdf', onSegment: ({translation}) => committed.push(translation)})).toEqual(['如果 g~x 是线性函数']);
        expect(committed).toEqual(['如果 g~x 是线性函数']);
    });
});

describe('document translation retry backoff', () => {
    const segments = [{id: 0, source: 'First'}, {id: 1, source: 'Second'}];
    const sleeper = () => {const waits: number[] = []; return {waits, sleep: async (milliseconds: number) => {waits.push(milliseconds);}};};

    it.each(['microsoft', 'openai'])('does not wait or retry authentication/configuration errors on %s', async service => {
        mocks.defaultService = service;
        const failures = [
            new TranslationRequestError(serializeTranslationError({message: '401 unauthorized', kind: 'authentication', retryable: false})),
            new TranslationRequestError(serializeTranslationError({message: 'invalid model', kind: 'bad-request', retryable: false})),
            new Error('API 密钥未配置'),
            new Error('模型不存在'),
            new Error('Extension context invalidated'),
        ];
        for (const failure of failures) {
            mocks.translateText.mockReset().mockRejectedValue(failure);
            mocks.translateTextBatch.mockReset().mockRejectedValue(failure);
            const {waits, sleep} = sleeper();
            const retry = vi.fn();
            await expect(translateDocumentSegments(segments.slice(0, 1), {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 120_000, sleep}, onRetry: retry})).rejects.toThrow(failure.message);
            expect(waits).toEqual([]);
            expect(retry).not.toHaveBeenCalled();
            expect(service === 'microsoft' ? mocks.translateTextBatch : mocks.translateText).toHaveBeenCalledOnce();
            expect(service === 'microsoft' ? mocks.translateText : mocks.translateTextBatch).not.toHaveBeenCalled();
        }
    });

    it('keeps a structured retryable rate-limit on its batch request', async () => {
        const failure = new TranslationRequestError(serializeTranslationError({message: '429 limited', kind: 'rate-limit', retryable: true}));
        mocks.translateTextBatch.mockRejectedValueOnce(failure).mockResolvedValue(['译一', '译二']);
        const {waits, sleep} = sleeper();
        expect(await translateDocumentSegments(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 2_000, sleep}})).toEqual(['译一', '译二']);
        expect(waits).toEqual([2_000]);
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
        expect(mocks.translateText).not.toHaveBeenCalled();
    });

    it('retries a failing batch with growing waits and reports each retry before continuing', async () => {
        mocks.translateTextBatch.mockRejectedValueOnce(new Error('429 rate limited')).mockResolvedValueOnce(['First']).mockResolvedValueOnce(['译一', '译二']);
        const {waits, sleep} = sleeper(); const retries: Array<{attempt: number; delayMs: number; reason: string}> = [];
        const result = await translateDocumentSegments(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 120_000, sleep}, onRetry: retry => retries.push(retry)});
        expect(result).toEqual(['译一', '译二']); expect(waits).toEqual([2000, 4000]);
        expect(retries).toEqual([{attempt: 1, delayMs: 2000, reason: '429 rate limited'}, {attempt: 2, delayMs: 4000, reason: '翻译服务返回的片段不完整，请重试'}]);
    });

    it('caps a single wait at thirty seconds, spends at most the budget and then fails with the last reason', async () => {
        mocks.translateTextBatch.mockRejectedValue(new Error('service unavailable'));
        const {waits, sleep} = sleeper();
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 120_000, sleep}})).rejects.toThrow('第 1 段文档翻译失败：service unavailable');
        expect(waits).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]); expect(waits.reduce((sum, value) => sum + value, 0)).toBe(120_000);
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(8);
    });

    it('does not retry without a budget, after the user disables translation, or once the task is cancelled', async () => {
        mocks.translateTextBatch.mockRejectedValue(new Error('offline'));
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf'})).rejects.toThrow('offline');
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(1);
        mocks.translateTextBatch.mockReset().mockRejectedValue(new TranslationRequestError({kind: 'config', retryable: false, message: 'off', code: 'TRANSLATION_DISABLED'} as never));
        const {waits, sleep} = sleeper();
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 120_000, sleep}})).rejects.toMatchObject({code: 'TRANSLATION_DISABLED'});
        expect(waits).toEqual([]);
        mocks.translateTextBatch.mockReset().mockRejectedValue(new Error('offline'));
        const controller = new AbortController();
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf', signal: controller.signal, retryBackoff: {maxWaitMs: 120_000, sleep: async () => {controller.abort();}}})).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(1);
    });

    it('waits on a real timer that an abort signal cuts short', async () => {
        vi.useFakeTimers();
        try {
            mocks.translateTextBatch.mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(['译一', '译二']);
            const pending = translateDocumentSegments(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 120_000}});
            await vi.advanceTimersByTimeAsync(2000);
            expect(await pending).toEqual(['译一', '译二']);
            mocks.translateTextBatch.mockReset().mockRejectedValue(new Error('busy'));
            const controller = new AbortController();
            const cancelled = translateDocumentSegments(segments, {fileName: 'paper.pdf', signal: controller.signal, retryBackoff: {maxWaitMs: 120_000}});
            const outcome = expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
            await vi.advanceTimersByTimeAsync(10); controller.abort(); await outcome;
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });

    it('retries single-request services per segment, including empty answers, and stops retrying once another worker failed', async () => {
        mocks.defaultService = 'openai';
        let firstCalls = 0;
        mocks.translateText.mockImplementation(async (source: string) => source === 'First' ? (firstCalls += 1) === 1 ? '' : '译一' : '译二');
        const {waits, sleep} = sleeper();
        expect(await translateDocumentSegments(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 120_000, sleep}})).toEqual(['译一', '译二']);
        expect(waits).toEqual([2000]); expect(firstCalls).toBe(2);
        mocks.translateText.mockReset().mockImplementation(async (source: string) => {if (source === 'First') throw new Error('first failed'); return '';});
        const second = sleeper();
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 4000, sleep: second.sleep}})).rejects.toThrow('文档翻译失败');
    });
});

describe('document translation keeps going when a service echoes names and short terms', () => {
    const echo = () => Object.assign(new Error('翻译服务连续返回未翻译的原文'), {code: 'UNTRANSLATED_RESPONSE'});
    const segments = [{id: 0, source: 'Latency'}, {id: 1, source: 'ARGUS'}, {id: 2, source: 'Seconds'}, {id: 3, source: 'A full sentence follows the table.'}];

    it('preserves translation-disabled errors met during echo fallback so the page can pause', async () => {
        mocks.translateTextBatch.mockRejectedValue(echo());
        const disabled = new TranslationRequestError(serializeTranslationError({message: 'off', retryable: false, code: 'TRANSLATION_DISABLED'}));
        mocks.translateText.mockRejectedValue(disabled);
        const sleep = vi.fn();
        const committed = vi.fn();
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf', batchConcurrency: 1, retryBackoff: {maxWaitMs: 120_000, sleep}, onSegment: committed})).rejects.toBe(disabled);
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateText).toHaveBeenCalledOnce();
        expect(sleep).not.toHaveBeenCalled();
        expect(committed).not.toHaveBeenCalled();
    });

    it('re-translates an echoed batch segment by segment, keeps the source for terms that stay unchanged and continues with later batches', async () => {
        mocks.translateTextBatch.mockRejectedValueOnce(echo()).mockResolvedValueOnce(['表格之后是一个完整的句子。']);
        mocks.translateText.mockImplementation(async (source: string) => {if (source === 'ARGUS') throw echo(); return source === 'Seconds' ? '  ' : '延迟';});
        const committed: Array<[number, string]> = []; const waits: number[] = [];
        const result = await translateDocumentSegments(segments, {fileName: 'paper.pdf', batchLimits: {items: 3}, batchConcurrency: 1, retryBackoff: {maxWaitMs: 120_000, sleep: async milliseconds => {waits.push(milliseconds);}}, onSegment: ({id, translation}) => committed.push([id, translation])});
        expect(result).toEqual(['延迟', 'ARGUS', 'Seconds', '表格之后是一个完整的句子。']);
        expect(committed).toEqual([[0, '延迟'], [1, 'ARGUS'], [2, 'Seconds'], [3, '表格之后是一个完整的句子。']]);
        // 原样返回不是暂时性故障，不进入退避等待。
        expect(waits).toEqual([]); expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
    });

    it('still reports a real failure met while re-translating an echoed batch, and stops on cancellation', async () => {
        mocks.translateTextBatch.mockRejectedValue(echo());
        mocks.translateText.mockRejectedValue(new Error('quota exceeded'));
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf'})).rejects.toThrow('第 1 段文档翻译失败：quota exceeded');
        const controller = new AbortController();
        mocks.translateText.mockReset().mockImplementation(async () => {controller.abort(); throw new Error('late');});
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf', signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        const early = new AbortController();
        mocks.translateTextBatch.mockReset().mockImplementation(async () => {throw echo();});
        mocks.translateText.mockReset().mockImplementation(async () => {early.abort(); return '延迟';});
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf', signal: early.signal})).rejects.toMatchObject({name: 'AbortError'});
    });

    it('keeps the source for an echoed segment on single-request services without stopping the other workers', async () => {
        mocks.defaultService = 'openai';
        mocks.translateText.mockImplementation(async (source: string) => {if (source === 'ARGUS') throw echo(); return `译 ${source}`;});
        expect(await translateDocumentSegments(segments, {fileName: 'paper.pdf'})).toEqual(['译 Latency', 'ARGUS', '译 Seconds', '译 A full sentence follows the table.']);
    });
});

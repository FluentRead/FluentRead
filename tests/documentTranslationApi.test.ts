import {TranslationRequestError, serializeTranslationError} from '@/src/services/translation/errors';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
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
    it.each(['resolve', 'reject'] as const)('取消未就绪运行时立即结束任务并消费迟到 %s', async late => {
        let resolveReady!: () => void, rejectReady!: (error: Error) => void;
        const readiness = new Promise<void>((resolve, reject) => {resolveReady = resolve; rejectReady = reject;});
        mocks.waitUntilReady.mockReturnValue(readiness);
        const controller = new AbortController();
        const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
        let outcome: unknown;
        const work = translateDocumentSegments([{id: 0, source: 'Source'}], {fileName: 'paused.txt', signal: controller.signal})
            .then(value => {outcome = value;}, error => {outcome = error;});
        controller.abort();
        // 运行时仍然未就绪：取消必须独立完成，也不能把监听器挂在永久未决任务上。
        await Promise.resolve(); await Promise.resolve();
        expect(outcome).toMatchObject({name: 'AbortError'});
        expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
        if (late === 'resolve') resolveReady(); else rejectReady(new Error('Late readiness failure'));
        await work; await Promise.resolve();
        expect(mocks.translateText).not.toHaveBeenCalled();
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
    });
    it.each(['microsoft', 'openai'])('为 %s 固定本次缓存策略，未指定时保留客户端默认值', async service => {
        mocks.defaultService = service;
        const segments = Array.from({length: 17}, (_, id) => ({id, source: `Source ${id}`}));
        for (const useCache of [undefined, false, true]) {
            mocks.translateText.mockClear();
            mocks.translateTextBatch.mockClear();
            const options = {fileName: 'cache-policy.pdf', useCache};
            const translate = async (origins: string | string[]) => {
                options.useCache = useCache === false;
                return Array.isArray(origins) ? origins.map(origin => `T:${origin}`) : `T:${origins}`;
            };
            mocks.translateText.mockImplementation(translate);
            mocks.translateTextBatch.mockImplementation(translate);
            expect(await translateDocumentSegments(segments, options)).toEqual(segments.map(({source}) => `T:${source}`));
            const calls = (service === 'microsoft' ? mocks.translateTextBatch : mocks.translateText).mock.calls;
            expect(calls.length).toBeGreaterThan(1);
            for (const call of calls) {
                if (useCache === undefined) expect(call[2]).not.toHaveProperty('useCache');
                else expect(call[2]).toMatchObject({useCache});
            }
        }
    });

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

    it('AI 并行 worker 首次失败后停止派发，收齐在途成功译文与真实进度后报告失败', async () => {
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

        const running = translateDocumentSegments(segments, {
            fileName: 'sample.md',
            onProgress: ({completed}) => progress.push(completed),
        });
        const outcome = expect(running).rejects.toThrow('第 1 段文档翻译失败');
        await vi.waitFor(() => expect(mocks.translateText).toHaveBeenCalledTimes(3));
        expect(progress).toEqual([0]);
        releaseSlowRequests.forEach((release) => release());
        await outcome;

        expect(mocks.translateText).toHaveBeenCalledTimes(3);
        expect(progress).toEqual([0, 1, 2]);
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
        const onFailure = vi.fn();
        mocks.translateText.mockImplementation(() => new Promise((_, reject) => releases.push(reject)));
        const pending = translateDocumentSegments([
            {id: 0, source: 'One'},
            {id: 1, source: 'Two'},
        ], {fileName: 'sample.md', onFailure});
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        releases[0]('duplicate failure' as never);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(onFailure).toHaveBeenCalledOnce();
        expect(onFailure).toHaveBeenCalledWith({id: 0, reason: '第 1 段文档翻译失败：duplicate failure'});
        releases[1]('later failure' as never);
        await expect(pending).rejects.toThrow('第 1 段文档翻译失败：duplicate failure');
        expect(onFailure).toHaveBeenCalledOnce();
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

    it('显式重译在槽协议失败的逐段补译及后续逐段请求中继续跳过缓存', async () => {
        mocks.defaultService = 'openai';
        mocks.translateTextBatch.mockRejectedValueOnce(protocolError());
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        const short = segments.slice(0, 4);
        const result = await createAITranslator()(short, {fileName: 'retry.pdf', useCache: false,
            batchLimits: {items: 2}, batchConcurrency: 1});
        expect(result).toEqual(translated(short.map(segment => segment.source)));
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateTextBatch.mock.calls[0][2]).toMatchObject({useCache: false, aiMultiSegment: true});
        expect(mocks.translateText).toHaveBeenCalledTimes(4);
        for (const call of mocks.translateText.mock.calls) expect(call[2]).toMatchObject({useCache: false, enableNativeBatch: false});
    });

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
            expect(call[2]).toMatchObject({documentBatch: true, aiMultiSegment: true, enableNativeBatch: true, serviceOverride: 'openai', modelOverride: 'first-model'});
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
        expect(mocks.translateText.mock.calls.every(call => call[2].documentBatch === undefined)).toBe(true);
        expect(mocks.translateText.mock.calls.every(call => call[2].enableNativeBatch === false)).toBe(true);
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
        await translate(short, {fileName: 'next.pdf'});
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateTextBatch.mock.calls[0][2].documentBatch).toBe(true);
        expect(mocks.translateTextBatch.mock.calls[0][2].enableNativeBatch).toBe(true);
        expect(mocks.translateTextBatch.mock.calls[0][2].aiMultiSegment).toBe(service === 'openai' ? true : undefined);
    });

    it('keeps translation-only models on their native single-request path', async () => {
        mocks.defaultService = 'openai';
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        await createAITranslator(() => 'translation-only')(segments.slice(0, 2), {fileName: 'paper.pdf'});
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
        expect(mocks.translateText.mock.calls.every(call => call[2].modelOverride === 'translation-only')).toBe(true);
    });

    it('keeps AI discourse sequential even when document slot batching is available', async () => {
        mocks.defaultService = 'openai';
        const definition = 'Accumulation Protocol (AP) schedules replicas.';
        const usage = 'AP sends the next replica.';
        mocks.translateText.mockImplementation(async source => {
            await Promise.resolve();
            return source === definition ? '累积协议（AP）调度副本。' : 'AP 发送下一个副本。';
        });
        const result = await createAITranslator()([{id: 0, source: definition, contextLabel: 'Replication chapter'}, {id: 1, source: usage}], {
            fileName: 'context.epub', enableAIContext: true, batchTranslation: true,
        });
        expect(result).toEqual(['累积协议（AP）调度副本。', 'AP 发送下一个副本。']);
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
        expect(mocks.translateText).toHaveBeenCalledTimes(2);
        expect(mocks.translateText.mock.calls.every(call => call[2].enableNativeBatch === false && call[2].enableAIContext === true)).toBe(true);
        expect(JSON.parse(mocks.translateText.mock.calls[1][2].discourseContext).evidence).toContainEqual(expect.objectContaining({
            kind: 'previous_machine', source: definition, translation: '累积协议（AP）调度副本。',
        }));
    });

    it('deduplicates slot batches within each chapter without joining identical sources across chapters', async () => {
        mocks.defaultService = 'openai';
        const repeated = [
            {id: 0, source: 'AP', contextLabel: 'Chapter one'}, {id: 1, source: 'AP'},
            {id: 2, source: 'AP', contextLabel: 'Chapter two'}, {id: 3, source: 'AP'},
        ];
        mocks.translateTextBatch.mockResolvedValue(['第一章译法', '第二章译法']);
        await expect(createAITranslator()(repeated, {fileName: 'chapters.epub'}))
            .resolves.toEqual(['第一章译法', '第一章译法', '第二章译法', '第二章译法']);
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateTextBatch.mock.calls[0][0]).toEqual(['AP', 'AP']);
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
        expect(mocks.translateText.mock.calls.every(call => call[2].enableNativeBatch === false)).toBe(true);
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

    it.each(['resolve', 'reject'])('retains an in-flight echoed batch fallback on %s and stops starting later single requests after a peer failure', async completion => {
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
        await new Promise(resolve => setTimeout(resolve, 0));
        if (completion === 'resolve') singles[0].resolve('late translation');
        else singles[0].reject(new Error('late failure'));
        batches[2].resolve(translated(segments.slice(32, 48).map(segment => segment.source)));
        await outcome;
        expect(mocks.translateText).toHaveBeenCalledOnce();
        expect(committed.mock.calls.map(call => call[0].id).sort((left, right) => left - right))
            .toEqual([...(completion === 'resolve' ? [0] : []), ...Array.from({length: 16}, (_, index) => index + 32)]);
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
        batches[2].reject(new Error('late'));
        // 同伴失败会立即停止等待，测试 sleep 即使永不完成也不拖延错误反馈。
        await outcome;
        releaseSleep();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
        expect(mocks.translateText).not.toHaveBeenCalled();
    });
});

describe('document incremental translation and resume', () => {
    const segments = Array.from({length: 18}, (_, id) => ({id, source: `Paragraph ${id}`}));

    it.each(['microsoft', 'openai'])('服务 %s 并发失败后收齐成功内容，换服务或模型只请求失败及尚未派发段落', async service => {
        mocks.defaultService = service;
        const entries: Array<{resolve: () => void; reject: (error: Error) => void}> = [];
        const translate = (source: string | string[]) => new Promise((resolve, reject) => entries.push({
            resolve: () => resolve(Array.isArray(source) ? source.map(value => `保留 ${value}`) : `保留 ${source}`), reject,
        }));
        mocks.translateText.mockImplementation(translate);
        mocks.translateTextBatch.mockImplementation(translate);
        const initial = Array<string>(8).fill('');
        const progress: number[] = [];
        const onFailure = vi.fn();
        let ended = false;
        const running = translateDocumentSegments(segments.slice(0, 8), {
            fileName: 'recover.pdf', batchLimits: {items: 1}, modelOverride: 'old-model',
            onSegment: ({id, translation}) => {initial[id] = translation;},
            onProgress: ({completed}) => progress.push(completed),
            onFailure,
        });
        const outcome = running.catch(error => {ended = true; return error;});
        await vi.waitFor(() => expect(entries).toHaveLength(3));
        entries[1].reject(new Error('503 unavailable'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(ended).toBe(false);
        expect(onFailure).toHaveBeenCalledOnce();
        expect(onFailure).toHaveBeenCalledWith({id: 1, reason: '第 2 段文档翻译失败：503 unavailable'});
        entries[2].resolve(); entries[0].resolve();
        expect(await outcome).toMatchObject({message: '第 2 段文档翻译失败：503 unavailable'});
        expect(entries).toHaveLength(3);
        expect(onFailure).toHaveBeenCalledOnce();
        expect(progress).toEqual([0, 1, 2]);
        expect(initial).toEqual(['保留 Paragraph 0', '', '保留 Paragraph 2', '', '', '', '', '']);

        initial[0] = '人工校订';
        mocks.translateText.mockClear().mockImplementation(async source => `补译 ${source}`);
        mocks.translateTextBatch.mockClear();
        const resumeProgress: number[] = [];
        const resumed = await translateDocumentSegments(segments.slice(0, 8), {
            fileName: 'recover.pdf', serviceOverride: 'openai', modelOverride: 'replacement-model', initialTranslations: initial,
            onProgress: ({completed}) => resumeProgress.push(completed),
        });
        expect(mocks.translateText.mock.calls.map(call => call[0])).toEqual([1, 3, 4, 5, 6, 7].map(id => `Paragraph ${id}`));
        expect(mocks.translateText.mock.calls.every(call => call[2].serviceOverride === 'openai' && call[2].modelOverride === 'replacement-model')).toBe(true);
        expect(mocks.translateTextBatch).not.toHaveBeenCalled();
        expect(resumed[0]).toBe('人工校订'); expect(resumed[2]).toBe('保留 Paragraph 2');
        expect(resumeProgress).toEqual([2, 3, 4, 5, 6, 7, 8]);
        expect(initial.filter(Boolean)).toHaveLength(2);
    });

    it.each(['microsoft', 'openai'])('服务 %s 忽略 Abort 时暂停仍立即退出，并阻止退出后的成功及失败回调', async service => {
        mocks.defaultService = service;
        const entries: Array<{resolve: (value: string | string[]) => void; reject: (error: Error) => void}> = [];
        const hanging = () => new Promise((resolve, reject) => entries.push({resolve, reject}));
        mocks.translateText.mockImplementation(hanging); mocks.translateTextBatch.mockImplementation(hanging);
        const controller = new AbortController();
        const onSegment = vi.fn(), onProgress = vi.fn(), onFailure = vi.fn();
        const running = translateDocumentSegments(segments.slice(0, 8), {fileName: 'pause.pdf', batchLimits: {items: 1}, signal: controller.signal, onSegment, onProgress, onFailure});
        const outcome = expect(running).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(entries).toHaveLength(3));
        controller.abort();
        await outcome;
        entries[0].resolve(service === 'microsoft' ? ['迟到'] : '迟到');
        entries[1].reject(new Error('late failure'));
        entries[2].resolve(service === 'microsoft' ? ['迟到'] : '迟到');
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(entries).toHaveLength(3);
        expect(onSegment).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
        expect(onProgress).toHaveBeenCalledOnce();
        expect(onProgress).toHaveBeenCalledWith({completed: 0, total: 8});
    });

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

describe('document discourse boundaries', () => {
    it('adds a source-backed late definition and its settled translation to the next AI paragraph without extra model calls', async () => {
        mocks.defaultService = 'openai';
        const filler = Array.from({length: 30}, (_, id) => ({id, source: `Unrelated filler paragraph ${id}: ${'background '.repeat(16)}`}));
        const definition = 'Accumulation protocol (AP) schedules the replicas.';
        const usage = 'AP retries replication after a timeout.';
        const requests: Array<{source: string; pageContext: string; discourseContext?: string}> = [];
        mocks.translateText.mockImplementation(async (source: string, _context: string, options: {pageContext: string; discourseContext?: string}) => {
            requests.push({source, ...options});
            return source === definition ? '累积协议（AP）调度副本。' : `译 ${source}`;
        });
        const segments = [...filler, {id: 30, source: definition, contextLabel: 'Replication chapter'}, {id: 31, source: usage}];
        await translateDocumentSegments(segments, {fileName: 'long.epub', enableAIContext: true,
            initialTranslations: filler.map(segment => `已有译文 ${segment.id}`)});
        expect(requests).toHaveLength(2);
        expect(requests[1].pageContext).not.toContain(definition);
        expect(requests[1].discourseContext).toContain(definition);
        expect(requests[1].discourseContext).toContain('累积协议');
        expect(JSON.parse(requests[1].discourseContext!).evidence).toEqual(expect.arrayContaining([
            expect.objectContaining({kind: 'previous_machine', blockId: '30', position: 'Replication chapter · 段落 31', source: definition, translation: '累积协议（AP）调度副本。'}),
        ]));
    });

    it('marks only explicitly edited session translations as confirmed and does not carry them to the next file or language', async () => {
        mocks.defaultService = 'openai';
        const definition = 'Aurora is the replication coordinator.';
        const segments = [{id: 0, source: definition}, {id: 1, source: 'Aurora restarts the replicas.'}];
        mocks.translateText.mockResolvedValue('译后文');
        await translateDocumentSegments(segments, {fileName: 'characters.epub', materialId: 'file-a', enableAIContext: true, sourceLanguage: 'en', targetLanguage: 'zh-Hans',
            initialTranslations: ['用户确认：曙光是复制协调器。'], confirmedTranslationIds: [0]});
        const confirmed = JSON.parse(mocks.translateText.mock.calls[0][2].discourseContext);
        expect(confirmed.evidence).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'user_confirmed', source: definition, translation: '用户确认：曙光是复制协调器。'})]));
        mocks.translateText.mockClear();
        await translateDocumentSegments(segments, {fileName: 'characters.epub', materialId: 'file-a', enableAIContext: true, targetLanguage: 'fr', initialTranslations: ['历史机器参考']});
        expect(JSON.parse(mocks.translateText.mock.calls[0][2].discourseContext).evidence.some((item: {kind: string}) => item.kind === 'user_confirmed')).toBe(false);
        mocks.translateText.mockClear();
        await translateDocumentSegments([{id: 0, source: 'Borealis is the next coordinator.'}], {fileName: 'other.epub', materialId: 'file-b', enableAIContext: true});
        expect(mocks.translateText.mock.calls[0][2].discourseContext).not.toContain('Aurora');
    });

    it('preserves 64 confirmed seeds for later paragraphs without promoting or admitting machine history into their full budget', async () => {
        mocks.defaultService = 'openai';
        const segments = [
            {id: 0, source: 'Aurora means the former replication coordinator.'},
            {id: 1, source: 'Aurora is the lead scientist.'},
            ...Array.from({length: 63}, (_, index) => ({id: index + 2, source: `UniqueToken${index + 2} is a confirmed item.`})),
            {id: 65, source: 'Aurora returned to the laboratory.'},
            {id: 66, source: 'Aurora publishes her conclusion.'},
        ];
        const confirmedIds = Array.from({length: 64}, (_, index) => index + 1);
        const machineHistory = '机器历史：晨曦是旧协调器。';
        const confirmedName = '用户确认：极光是首席科学家。';
        const initial = [machineHistory, confirmedName, ...Array.from({length: 63}, (_, index) => `确认译文 ${index + 2}`)];
        mocks.translateText.mockImplementation(async (source: string) => source === segments[65].source ? '极光返回实验室。' : '极光发表她的结论。');
        const result = await translateDocumentSegments(segments, {
            fileName: 'confirmed-manual.epub', materialId: 'confirmed-manual-v1', enableAIContext: true,
            initialTranslations: initial, confirmedTranslationIds: confirmedIds,
        });
        expect(mocks.translateText.mock.calls.map(call => call[0])).toEqual([segments[65].source, segments[66].source]);
        expect(result.slice(0, 65)).toEqual(initial);
        expect(result.slice(65)).toEqual(['极光返回实验室。', '极光发表她的结论。']);
        for (const call of mocks.translateText.mock.calls) {
            const data = JSON.parse(call[2].discourseContext) as {evidence: Array<{kind: string; blockId: string; translation?: string}>};
            expect(data.evidence).toContainEqual(expect.objectContaining({kind: 'user_confirmed', blockId: '1', translation: confirmedName}));
            expect(data.evidence.filter(item => item.kind === 'user_confirmed').every(item => confirmedIds.includes(Number(item.blockId)))).toBe(true);
            expect(data.evidence.some(item => item.translation === machineHistory)).toBe(false);
            expect(data.evidence.some(item => item.kind === 'user_confirmed' && item.blockId === '65')).toBe(false);
            expect(call[2].discourseContext.length).toBeLessThanOrEqual(2400);
        }
    });

    it.each([
        ['repeated chapter label', 'Chapter one', 'Chapter one'],
        ['Chinese PDF page positions', '第 1 页', '第 2 页'],
        ['English PDF page positions', 'Page 1', 'Page 2'],
    ])('preserves character evidence across %s', async (_case, firstLabel, nextLabel) => {
        mocks.defaultService = 'openai';
        const definition = 'Aurora is the lead scientist.';
        mocks.translateText.mockResolvedValue('她返回实验室。');
        await translateDocumentSegments([{id: 0, source: definition, contextLabel: firstLabel}, {id: 1, source: 'Aurora returned to the laboratory.', contextLabel: nextLabel}], {
            fileName: 'characters.pdf', enableAIContext: true, initialTranslations: ['曙光是首席科学家。'], confirmedTranslationIds: [0],
        });
        const reference = JSON.parse(mocks.translateText.mock.calls[0][2].discourseContext);
        expect(reference.evidence).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'user_confirmed', source: definition, translation: '曙光是首席科学家。'})]));
        expect(reference.position).toBe(`${nextLabel} · 段落 2`);
    });

    it('moves the bounded reference window to a late chapter beyond 256 paragraphs and 64,000 source characters', async () => {
        mocks.defaultService = 'openai';
        const filler = Array.from({length: 300}, (_, id) => ({id, source: `Background ${id}: ${'unrelated '.repeat(52)}`}));
        const definition = 'Adaptive routing (AR) balances the replicas.';
        const usage = 'AR retries the replicas after a timeout.';
        mocks.translateText.mockImplementation(async (source: string) => source === definition ? '自适应路由（AR）均衡副本。' : '后文译文');
        await translateDocumentSegments([...filler, {id: 300, source: definition, contextLabel: 'Late chapter'}, {id: 301, source: usage}], {
            fileName: 'book.epub', enableAIContext: true, initialTranslations: filler.map(() => '此前已翻译'),
        });
        expect(mocks.translateText).toHaveBeenCalledTimes(2);
        const reference = JSON.parse(mocks.translateText.mock.calls[1][2].discourseContext);
        expect(reference.position).toBe('段落 302');
        expect(reference.evidence).toEqual(expect.arrayContaining([
            expect.objectContaining({kind: 'previous_machine', blockId: '300', source: definition, translation: '自适应路由（AR）均衡副本。'}),
        ]));
        expect(mocks.translateText.mock.calls[1][2].discourseContext.length).toBeLessThanOrEqual(2400);
    });

    it('cancels an enabled discourse request without submitting its late translation or starting the next paragraph', async () => {
        mocks.defaultService = 'openai';
        const controller = new AbortController();
        const onSegment = vi.fn();
        mocks.translateText.mockImplementation(async () => {controller.abort(); return '过期译文';});
        await expect(translateDocumentSegments([{id: 0, source: 'Aurora is the coordinator.'}, {id: 1, source: 'Aurora restarts.'}], {
            fileName: 'canceled.epub', enableAIContext: true, signal: controller.signal, onSegment,
        })).rejects.toMatchObject({name: 'AbortError'});
        expect(onSegment).not.toHaveBeenCalled();
        expect(mocks.translateText).toHaveBeenCalledOnce();
    });

    it('keeps identical abbreviations in different native chapters separate while deduplicating within a chapter', async () => {
        mocks.defaultService = 'openai';
        let calls = 0;
        mocks.translateText.mockImplementation(async (source: string) => source === 'AP' ? `译法 ${++calls}` : `译 ${source}`);
        const segments = [
            {id: 0, source: 'Weather', contextLabel: 'Chapter one'},
            {id: 1, source: 'AP'},
            {id: 2, source: 'AP'},
            {id: 3, source: 'Networking', contextLabel: 'Chapter two'},
            {id: 4, source: 'AP'},
        ];
        const result = await translateDocumentSegments(segments, {fileName: 'contexts.epub'});
        expect(calls).toBe(2);
        expect(result[1]).toBe(result[2]);
        expect(result[4]).not.toBe(result[1]);
    });

    it('does not copy a previously edited abbreviation into another section with the same title', async () => {
        mocks.translateTextBatch.mockImplementation(async (sources: string[]) => sources.map(source => `另一章 ${source}`));
        const result = await translateDocumentSegments([
            {id: 0, source: 'Introduction', contextLabel: 'Same chapter title'},
            {id: 1, source: 'AP'},
            {id: 2, source: 'Introduction', contextLabel: 'Same chapter title', role: 'heading'},
            {id: 3, source: 'AP'},
        ], {fileName: 'different-senses.epub', initialTranslations: ['简介', '人工确认：气压', '', ''], confirmedTranslationIds: [1]});
        expect(mocks.translateTextBatch).toHaveBeenCalledWith(['Introduction', 'AP'], 'different-senses.epub', expect.any(Object));
        expect(result[1]).toBe('人工确认：气压');
        expect(result[3]).toBe('另一章 AP');
    });

    it('keeps the disabled context request shape and three-worker dispatch', async () => {
        mocks.defaultService = 'openai';
        const releases: Array<() => void> = [];
        mocks.translateText.mockImplementation((source: string) => new Promise<string>(resolve => releases.push(() => resolve(`译 ${source}`))));
        const task = translateDocumentSegments([{id: 0, source: 'One'}, {id: 1, source: 'Two'}, {id: 2, source: 'Three'}], {fileName: 'disabled.txt', enableAIContext: false});
        await vi.waitFor(() => expect(releases).toHaveLength(3));
        for (const call of mocks.translateText.mock.calls) {
            expect(call[2]).toHaveProperty('enableAIContext', false);
            expect(call[2]).not.toHaveProperty('discourseContext');
        }
        releases.forEach(release => release());
        await task;
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
    const onFailure = vi.fn();
    await expect(translate([{id: 0, source: 'Source text'}], {fileName: 'sample.txt', onFailure})).rejects.toBe(error);
    expect(onFailure).not.toHaveBeenCalled();
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

    it.each([true, false])('visits a stable priority queue once with batch support %s', async batch => {
        mocks.defaultService = batch ? 'microsoft' : 'openai';
        mocks.translateTextBatch.mockImplementation(echo);
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        const many = Array.from({length: 1_024}, (_, id) => ({id, source: `Source ${id}`}));
        let visits = 0;
        const key = {};
        const prioritize = vi.fn((pending: readonly typeof many[number][]) => {visits += pending.length; return [...pending].reverse();});
        const result = await translateDocumentSegments(many, {fileName: 'large.txt', prioritize, priorityKey: () => key});
        expect(prioritize).toHaveBeenCalledOnce();
        expect(visits).toBe(many.length);
        expect(result).toEqual(many.map(segment => `译 ${segment.source}`));
        expect((batch ? mocks.translateTextBatch : mocks.translateText).mock.calls[0][0]).toEqual(batch
            ? many.slice(-16).reverse().map(segment => segment.source) : many.at(-1)!.source);
    });

    it('rebuilds only unclaimed positions when the priority key changes, retaining duplicate occurrences', async () => {
        mocks.translateTextBatch.mockImplementation(echo);
        const repeated = ['First', 'Repeat', 'Middle', 'Last', 'Repeat'].map((source, id) => ({id, source}));
        let focus = 0;
        const pendingIds: number[][] = [], committed: number[] = [];
        const result = await translateDocumentSegments(repeated, {
            fileName: 'paper.pdf', batchLimits: {items: 1}, batchConcurrency: 1,
            priorityKey: () => focus,
            prioritize: pending => {
                pendingIds.push(pending.map(segment => segment.id));
                return [...pending].sort((left, right) => Math.abs(left.id - focus) - Math.abs(right.id - focus));
            },
            onSegment: ({id}) => {committed.push(id); if (id === 0) focus = 4;},
        });
        expect(pendingIds).toEqual([[0, 1, 4, 2, 3], [1, 4, 2, 3]]);
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0])).toEqual([['First'], ['Repeat'], ['Last'], ['Middle']]);
        expect(committed).toEqual([0, 1, 4, 3, 2]);
        expect(result).toEqual(repeated.map(segment => `译 ${segment.source}`));
    });

    it('keeps claimed batches isolated from a priority change while other requests are in flight', async () => {
        const releases: Array<{sources: string[]; release(): void}> = [];
        mocks.translateTextBatch.mockImplementation((sources: string[]) => new Promise<string[]>(resolve => {
            releases.push({sources, release: () => resolve(sources.map(source => `译 ${source}`))});
        }));
        let focus = 0;
        const prioritize = vi.fn((pending: readonly typeof segments[number][]) => [...pending].sort((left, right) => Math.abs(left.id - focus) - Math.abs(right.id - focus)));
        const running = translateDocumentSegments(segments, {fileName: 'concurrent.pdf', batchLimits: {items: 1}, prioritize, priorityKey: () => focus});
        await vi.waitFor(() => expect(releases).toHaveLength(3));
        focus = 5; releases[1].release();
        await vi.waitFor(() => expect(releases).toHaveLength(4));
        expect(releases[3].sources).toEqual(['Source 5']);
        releases[0].release(); releases[2].release();
        await vi.waitFor(() => expect(releases).toHaveLength(6));
        releases.slice(3).forEach(request => request.release());
        expect(await running).toEqual(segments.map(segment => `译 ${segment.source}`));
        expect(prioritize).toHaveBeenCalledTimes(2);
        expect(releases.flatMap(request => request.sources).sort()).toEqual(segments.map(segment => segment.source));
    });

    it('cancels a stable queue without late commits and recreates priority order on resume', async () => {
        let finish!: (value: string[]) => void;
        mocks.translateTextBatch.mockImplementationOnce(() => new Promise<string[]>(resolve => {finish = resolve;}));
        const controller = new AbortController();
        const committed = vi.fn();
        const prioritize = vi.fn((pending: readonly typeof segments[number][]) => [...pending].reverse());
        const options = {fileName: 'resume.txt', batchLimits: {items: 1}, batchConcurrency: 1, prioritize, priorityKey: () => 'unchanged'};
        const running = translateDocumentSegments(segments, {...options, signal: controller.signal, onSegment: committed});
        const aborted = expect(running).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(mocks.translateTextBatch).toHaveBeenCalledOnce());
        controller.abort(); await aborted; finish(['late']);
        await Promise.resolve(); await Promise.resolve();
        expect(committed).not.toHaveBeenCalled();
        mocks.translateTextBatch.mockReset().mockImplementation(echo);
        const result = await translateDocumentSegments(segments, {...options, initialTranslations: ['', 'saved'], onSegment: committed});
        expect(prioritize).toHaveBeenCalledTimes(2);
        expect(mocks.translateTextBatch.mock.calls.map(call => call[0])).toEqual([['Source 5'], ['Source 4'], ['Source 3'], ['Source 2'], ['Source 0']]);
        expect(result).toEqual(segments.map(segment => segment.id === 1 ? 'saved' : `译 ${segment.source}`));
    });

    it('does not evaluate priority keys without a prioritizer and still validates keyed ordering', async () => {
        mocks.translateTextBatch.mockImplementation(echo);
        const priorityKey = vi.fn(() => 'stable');
        await translateDocumentSegments(segments, {fileName: 'plain.txt', priorityKey});
        expect(priorityKey).not.toHaveBeenCalled();
        const prioritize = vi.fn((pending: readonly typeof segments[number][]) => pending.slice(1));
        const result = await translateDocumentSegments(segments, {fileName: 'invalid.txt', batchLimits: {items: 1}, prioritize, priorityKey});
        expect(prioritize).toHaveBeenCalledOnce();
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

        // 一批失败后仍保留其余在途成功结果，但不再认领新片段。
        mocks.translateTextBatch.mockReset();
        const pending: Array<{resolve: (value: string[]) => void; reject: (error: Error) => void; sources: string[]}> = [];
        mocks.translateTextBatch.mockImplementation((sources: string[]) => new Promise<string[]>((resolve, reject) => pending.push({resolve, reject, sources})));
        const committed: number[] = [];
        const failing = translateDocumentSegments(segments, {fileName: 'paper.pdf', batchLimits: {items: 1}, onSegment: ({id}) => committed.push(id)});
        const outcome = expect(failing).rejects.toThrow('第 1 段文档翻译失败：quota exceeded');
        await vi.waitFor(() => expect(pending).toHaveLength(3));
        pending[0].reject(new Error('quota exceeded'));
        pending[1].resolve(['late']); pending[2].reject(new Error('also late'));
        await outcome;
        expect(committed).toEqual([1]); expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
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
    const rateLimit = (retryAfterMs: number) => new TranslationRequestError(serializeTranslationError({message: '429 limited', kind: 'rate-limit', retryable: true, retryAfterMs}));

    it('automatically finishes a limited batch after more than two minutes of backoff without discarding completed text', async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) mocks.translateTextBatch.mockRejectedValueOnce(new Error('429 rate limited'));
        mocks.translateTextBatch.mockResolvedValueOnce(['新译文']);
        const {waits, sleep} = sleeper();
        expect(await translateDocumentSegments(segments, {fileName: 'long.pdf', initialTranslations: ['人工校订', ''],
            useCache: false, retryBackoff: {maxWaitMs: 600_000, sleep}})).toEqual(['人工校订', '新译文']);
        expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
        expect(waits.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(120_000);
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(9);
        for (const call of mocks.translateTextBatch.mock.calls) {
            expect(call[0]).toEqual(['Second']); expect(call[2].useCache).toBe(false);
        }
    });

    it.each([
        {kind: 'rate-limit', retryable: true},
        {kind: 'rate-limit', retryable: false, statusCode: 429},
        {kind: 'provider', retryable: false, code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE'},
        {kind: 'timeout', retryable: false, code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE'},
    ])('honors a ninety-second service cooldown before automatically retrying: %j', async error => {
        mocks.translateTextBatch.mockRejectedValueOnce(new TranslationRequestError(serializeTranslationError({...error, message: 'temporarily limited', retryAfterMs: 90_000})))
            .mockResolvedValueOnce(['译一', '译二']);
        const {waits, sleep} = sleeper();
        expect(await translateDocumentSegments(segments, {fileName: 'hint.pdf', retryBackoff: {maxWaitMs: 600_000, sleep}})).toEqual(['译一', '译二']);
        expect(waits).toEqual([90_000]); expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
    });

    it.each([0, -1, Infinity, NaN, undefined])('does not reinterpret a permanently unavailable pool without a valid positive cooldown: %j', async retryAfterMs => {
        mocks.translateTextBatch.mockRejectedValue(new TranslationRequestError(serializeTranslationError({message: 'pool unavailable', retryable: false,
            code: 'FREE_TRANSLATION_TEMPORARILY_UNAVAILABLE', retryAfterMs})));
        const {waits, sleep} = sleeper();
        await expect(translateDocumentSegments(segments, {fileName: 'permanent.pdf', retryBackoff: {maxWaitMs: 600_000, sleep}})).rejects.toThrow('pool unavailable');
        expect(waits).toEqual([]); expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
    });

    it.each([
        {kind: 'provider', retryable: false, retryAfterMs: 90_000},
        {kind: 'rate-limit', retryable: false, retryAfterMs: 90_000},
        {kind: 'authentication', retryable: false, statusCode: 429, retryAfterMs: 90_000},
    ])('keeps unrelated explicitly permanent errors terminal even if they carry a cooldown: %j', async error => {
        mocks.translateTextBatch.mockRejectedValue(new TranslationRequestError(serializeTranslationError({...error, message: 'permanent service failure'})));
        const {waits, sleep} = sleeper();
        await expect(translateDocumentSegments(segments, {fileName: 'permanent.pdf', retryBackoff: {maxWaitMs: 600_000, sleep}})).rejects.toThrow('permanent service failure');
        expect(waits).toEqual([]); expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
    });

    it('does not shorten a service cooldown to fit the remaining retry budget', async () => {
        mocks.translateTextBatch.mockRejectedValueOnce(rateLimit(2_000)).mockRejectedValueOnce(rateLimit(90_000));
        const {waits, sleep} = sleeper();
        await expect(translateDocumentSegments(segments, {fileName: 'budget.pdf', retryBackoff: {maxWaitMs: 90_000, sleep}})).rejects.toThrow('429 limited');
        expect(waits).toEqual([2000]); expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
    });

    it('does not shorten Retry-After to fit an absolute deadline after time was spent in the request', async () => {
        vi.useFakeTimers();
        try {
            mocks.translateTextBatch.mockImplementation(() => new Promise((_resolve, reject) => setTimeout(() => reject(rateLimit(1000)), 500)));
            const sleep = vi.fn(), waiting = vi.fn();
            const task = translateDocumentSegments(segments, {fileName: 'hint-deadline.pdf',
                retryBackoff: {maxWaitMs: 600_000, maxDurationMs: 1000, sleep}, onRetryStateChange: waiting});
            const outcome = expect(task).rejects.toThrow('429 limited');
            await vi.advanceTimersByTimeAsync(500); await outcome;
            expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
            expect(mocks.translateTextBatch.mock.calls[0][2]).toMatchObject({timeout: 1000, maxRetries: 0});
            expect(sleep).not.toHaveBeenCalled(); expect(waiting).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });

    it('keeps a claimed batch absolute deadline while a later batch extends shared service cooling', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let outcome: Promise<unknown> | undefined;
        try {
            const paragraphs = Array.from({length: 4}, (_, id) => ({id, source: `Paragraph ${id}`}));
            const calls = new Map<string, number>();
            const pending = new Map<string, {resolve(value: string[]): void; reject(error: Error): void}>();
            mocks.translateTextBatch.mockImplementation(([source]: string[]) => {
                const attempt = (calls.get(source) ?? 0) + 1; calls.set(source, attempt);
                if (source === 'Paragraph 0' && attempt === 1) return Promise.reject(rateLimit(8000));
                if (source === 'Paragraph 3') return Promise.reject(rateLimit(4000));
                return new Promise((resolve, reject) => pending.set(source, {resolve, reject}));
            });
            const waiting: number[] = [], committed = vi.fn();
            const task = translateDocumentSegments(paragraphs, {fileName: 'shared-deadline.pdf', batchLimits: {items: 1}, onSegment: committed,
                signal: controller.signal, onRetryStateChange: state => waiting.push(state.waiting), retryBackoff: {maxWaitMs: 600_000, maxDurationMs: 10_000}});
            outcome = task.catch(error => error);
            await vi.advanceTimersByTimeAsync(2000);
            pending.get('Paragraph 1')!.resolve(['第一份在途结果']);
            await vi.advanceTimersByTimeAsync(6000);
            expect(calls.get('Paragraph 0')).toBe(2); expect(calls.get('Paragraph 3')).toBe(1);
            pending.get('Paragraph 2')!.resolve(['第二份在途结果']);
            await vi.advanceTimersByTimeAsync(100);
            pending.get('Paragraph 0')!.reject(rateLimit(1000));
            await vi.advanceTimersByTimeAsync(1900); expect(await outcome).toMatchObject({message: expect.stringContaining('429 limited')});
            expect(calls.get('Paragraph 0')).toBe(2); expect(calls.get('Paragraph 3')).toBe(1);
            expect(committed.mock.calls.map(call => call[0].id)).toEqual([1, 2]);
            expect(waiting.at(-1)).toBe(0); expect(vi.getTimerCount()).toBe(0);
            expect(mocks.translateTextBatch.mock.calls.every(call => call[2].maxRetries === 0)).toBe(true);
        } finally {controller.abort(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();}
    });

    it.each(['AI_MULTI_SEGMENT_RESPONSE_INVALID', 'UNTRANSLATED_RESPONSE'])('backs off a limited single request after %s fallback, preserving cache policy and echo handling', async code => {
        const translate = createDocumentSegmentTranslator({waitUntilReady: mocks.waitUntilReady, getDefaultService: () => 'openai',
            supportsBatch: () => false, supportsAIMultiSegment: () => true, translateText: mocks.translateText, translateTextBatch: mocks.translateTextBatch});
        mocks.translateTextBatch.mockRejectedValueOnce(Object.assign(new Error('fallback'), {code}));
        mocks.translateText.mockRejectedValueOnce(rateLimit(90_000)).mockResolvedValueOnce('译一')
            .mockRejectedValueOnce(Object.assign(new Error('echo'), {code: 'UNTRANSLATED_RESPONSE'}));
        const committed = vi.fn(), {waits, sleep} = sleeper();
        expect(await translate(segments, {fileName: 'fallback.pdf', useCache: false, onSegment: committed,
            retryBackoff: {maxWaitMs: 600_000, sleep}})).toEqual(['译一', 'Second']);
        expect(waits).toEqual([90_000]); expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateText.mock.calls.map(call => call[0])).toEqual(['First', 'First', 'Second']);
        expect(committed).toHaveBeenCalledTimes(2);
        for (const call of mocks.translateText.mock.calls) expect(call[2]).toMatchObject({useCache: false, enableNativeBatch: false});
    });

    it('holds new batches and shorter retries behind the longest service cooldown while committing in-flight success', async () => {
        const paragraphs = Array.from({length: 5}, (_, id) => ({id, source: `Paragraph ${id}`}));
        const requests: Array<{resolve: (value: string[]) => void; reject: (error: Error) => void}> = [];
        mocks.translateTextBatch.mockImplementation((sources: string[]) => requests.length < 3
            ? new Promise((resolve, reject) => requests.push({resolve, reject})) : Promise.resolve(sources.map(source => `译 ${source}`)));
        const sleeps: Array<{delay: number; resolve: () => void}> = [];
        const committed = vi.fn(), waiting: number[] = [];
        const task = translateDocumentSegments(paragraphs, {fileName: 'shared.pdf', batchLimits: {items: 1}, onSegment: committed,
            retryBackoff: {maxWaitMs: 600_000, sleep: delay => new Promise(resolve => sleeps.push({delay, resolve}))},
            onRetryStateChange: state => waiting.push(state.waiting)});
        await vi.waitFor(() => expect(requests).toHaveLength(3));
        requests[0].reject(rateLimit(90_000));
        await vi.waitFor(() => expect(sleeps).toHaveLength(1));
        requests[1].resolve(['已发成功']);
        await vi.waitFor(() => expect(committed).toHaveBeenCalledWith({id: 1, translation: '已发成功'}));
        requests[2].reject(rateLimit(120_000));
        await vi.waitFor(() => expect(sleeps).toHaveLength(2));
        expect(sleeps.map(entry => entry.delay)).toEqual([90_000, 120_000]);
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
        sleeps[0].resolve(); await new Promise(resolve => setTimeout(resolve, 0));
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3); expect(waiting.at(-1)).toBe(3);
        sleeps[1].resolve();
        expect(await task).toEqual(['译 Paragraph 0', '已发成功', '译 Paragraph 2', '译 Paragraph 3', '译 Paragraph 4']);
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(7); expect(committed).toHaveBeenCalledTimes(5);
        expect(waiting.at(-1)).toBe(0);
    });

    it.each(['abort', 'fatal'])('releases shared cooldowns on %s without dispatching queued work or committing late results', async ending => {
        const paragraphs = Array.from({length: 5}, (_, id) => ({id, source: `Paragraph ${id}`}));
        const requests: Array<{resolve: (value: string[]) => void; reject: (error: Error) => void}> = [];
        mocks.translateTextBatch.mockImplementation(() => new Promise((resolve, reject) => requests.push({resolve, reject})));
        const controller = new AbortController(), committed = vi.fn(), failed = vi.fn(), waiting: number[] = [];
        let releaseSleep!: () => void;
        const task = translateDocumentSegments(paragraphs, {fileName: 'cancel-shared.pdf', batchLimits: {items: 1}, signal: controller.signal,
            onSegment: committed, onFailure: failed, onRetryStateChange: state => waiting.push(state.waiting),
            retryBackoff: {maxWaitMs: 600_000, sleep: () => new Promise(resolve => {releaseSleep = resolve;})}});
        const outcome = ending === 'abort' ? expect(task).rejects.toMatchObject({name: 'AbortError'}) : expect(task).rejects.toThrow('401 unauthorized');
        await vi.waitFor(() => expect(requests).toHaveLength(3));
        requests[0].reject(rateLimit(90_000));
        await vi.waitFor(() => expect(releaseSleep).toBeTypeOf('function'));
        requests[1].resolve(['保留已发成功']);
        await vi.waitFor(() => expect(waiting.at(-1)).toBe(2));
        if (ending === 'abort') controller.abort(); else requests[2].reject(new Error('401 unauthorized'));
        await outcome;
        releaseSleep(); requests[2].resolve(['迟到']); await new Promise(resolve => setTimeout(resolve, 0));
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
        expect(committed).toHaveBeenCalledOnce(); expect(committed).toHaveBeenCalledWith({id: 1, translation: '保留已发成功'});
        expect(waiting.at(-1)).toBe(0); expect(failed).toHaveBeenCalledTimes(ending === 'abort' ? 0 : 1);
    });

    it('counts shared cooling against a request budget and stops instead of retrying early when its remaining budget is insufficient', async () => {
        const requests: Array<{resolve: (value: string[]) => void; reject: (error: Error) => void}> = [];
        mocks.translateTextBatch.mockImplementation(() => new Promise((resolve, reject) => requests.push({resolve, reject})));
        const sleeps: Array<() => void> = [], committed = vi.fn(), waiting: number[] = [];
        const task = translateDocumentSegments([...segments, {id: 2, source: 'Third'}], {fileName: 'shared-budget.pdf', batchLimits: {items: 1},
            onSegment: committed, onRetryStateChange: state => waiting.push(state.waiting),
            retryBackoff: {maxWaitMs: 6000, sleep: () => new Promise(resolve => sleeps.push(resolve))}});
        const outcome = expect(task).rejects.toThrow('429 limited');
        await vi.waitFor(() => expect(requests).toHaveLength(3));
        requests[0].reject(rateLimit(4000)); requests[1].reject(rateLimit(6000)); requests[2].resolve(['保留已发成功']);
        await vi.waitFor(() => expect(sleeps).toHaveLength(2));
        sleeps[0](); await outcome; sleeps[1]();
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
        expect(committed).toHaveBeenCalledOnce(); expect(committed).toHaveBeenCalledWith({id: 2, translation: '保留已发成功'});
        expect(waiting.at(-1)).toBe(0);
    });

    it('charges only a peer cooldown remaining after overlapping real timer waits, so a late limit can still recover within budget', async () => {
        vi.useFakeTimers();
        try {
            const requests: Array<{resolve: (value: string[]) => void; reject: (error: Error) => void}> = [];
            mocks.translateTextBatch.mockImplementation((sources: string[]) => requests.length < 3
                ? new Promise((resolve, reject) => requests.push({resolve, reject})) : Promise.resolve(sources.map(source => `译 ${source}`)));
            const task = translateDocumentSegments([...segments, {id: 2, source: 'Third'}], {fileName: 'remaining-window.pdf', batchLimits: {items: 1},
                retryBackoff: {maxWaitMs: 100_000}});
            await vi.advanceTimersByTimeAsync(0); expect(requests).toHaveLength(3);
            requests[0].reject(rateLimit(90_000)); requests[2].resolve(['已发成功']);
            await vi.advanceTimersByTimeAsync(80_000);
            requests[1].reject(rateLimit(20_000));
            await vi.advanceTimersByTimeAsync(10_000);
            expect(mocks.translateTextBatch).toHaveBeenCalledTimes(3);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await task).toEqual(['译 First', '译 Second', '已发成功']);
            expect(mocks.translateTextBatch).toHaveBeenCalledTimes(5); expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });

    it('reports the number of concurrent retry waits, including their end, without resetting progress on peer success', async () => {
        mocks.defaultService = 'openai';
        const paragraphs = [...segments, {id: 2, source: 'Third'}];
        const calls = new Map<string, number>();
        let releaseThird!: () => void;
        mocks.translateText.mockImplementation((source: string) => {
            const attempt = (calls.get(source) ?? 0) + 1; calls.set(source, attempt);
            if (source === 'Third') return new Promise(resolve => {releaseThird = () => resolve('译三');});
            return attempt === 1 ? Promise.reject(new Error('429 busy')) : Promise.resolve(`译 ${source}`);
        });
        const sleeps: Array<() => void> = [];
        const waiting: number[] = [], progress: number[] = [];
        const task = translateDocumentSegments(paragraphs, {fileName: 'wait.pdf',
            retryBackoff: {maxWaitMs: 120_000, sleep: () => new Promise(resolve => sleeps.push(resolve))},
            onRetryStateChange: state => waiting.push(state.waiting), onProgress: state => progress.push(state.completed),
        });
        await vi.waitFor(() => expect(sleeps).toHaveLength(2));
        expect(waiting).toEqual([1, 2]);
        releaseThird();
        await vi.waitFor(() => expect(progress).toEqual([0, 1]));
        expect(waiting).toEqual([1, 2]);
        sleeps[0]();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(progress).toEqual([0, 1]);
        expect(waiting).toEqual([1, 2]);
        sleeps[1](); await task;
        expect(waiting).toEqual([1, 2, 1, 0]);
        expect(progress).toEqual([0, 1, 2, 3]);
    });

    it('clears waiting state immediately on Abort even when a custom sleep ignores its signal', async () => {
        mocks.translateTextBatch.mockRejectedValue(new Error('429 busy'));
        let releaseSleep!: () => void;
        const waiting: number[] = [];
        const controller = new AbortController();
        const running = translateDocumentSegments(segments, {fileName: 'wait.pdf', signal: controller.signal,
            retryBackoff: {maxWaitMs: 2000, sleep: () => new Promise(resolve => {releaseSleep = resolve;})},
            onRetryStateChange: state => waiting.push(state.waiting),
        });
        const outcome = expect(running).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(waiting).toEqual([1]));
        controller.abort(); await outcome;
        expect(waiting).toEqual([1, 0]);
        releaseSleep(); await new Promise(resolve => setTimeout(resolve, 0));
        expect(waiting).toEqual([1, 0]);
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
    });

    it('cancels from the retry notice without starting a timer or leaving a waiting state behind', async () => {
        vi.useFakeTimers();
        try {
            mocks.translateTextBatch.mockRejectedValue(new Error('busy'));
            const controller = new AbortController();
            const waiting: number[] = [];
            await expect(translateDocumentSegments(segments, {fileName: 'wait.pdf', signal: controller.signal,
                retryBackoff: {maxWaitMs: 2000}, onRetry: () => controller.abort(), onRetryStateChange: state => waiting.push(state.waiting),
            })).rejects.toMatchObject({name: 'AbortError'});
            expect(waiting).toEqual([1, 0]);
            expect(vi.getTimerCount()).toBe(0);
            expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        } finally {vi.useRealTimers();}
    });

    it('preserves progress and reports a failed retry wait instead of dispatching another request', async () => {
        mocks.translateTextBatch.mockRejectedValue(new Error('busy'));
        const waiting: number[] = [], progress: number[] = [];
        await expect(translateDocumentSegments(segments, {fileName: 'wait.pdf', initialTranslations: ['已有译文', ''],
            retryBackoff: {maxWaitMs: 2000, sleep: async () => {throw new Error('retry wait interrupted');}},
            onRetryStateChange: state => waiting.push(state.waiting), onProgress: state => progress.push(state.completed),
        })).rejects.toThrow('第 2 段文档翻译失败：retry wait interrupted');
        expect(waiting).toEqual([1, 0]); expect(progress).toEqual([1]);
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
    });

    it('does not reissue a batch when a peer failure arrives as its retry wait resolves', async () => {
        const requests: Array<{reject: (error: Error) => void}> = [];
        mocks.translateTextBatch.mockImplementation((sources: string[]) => new Promise((resolve, reject) => {
            if (requests.length >= 2) {resolve(sources.map(source => `译 ${source}`)); return;}
            requests.push({reject});
        }));
        let releaseSleep!: () => void;
        const waiting: number[] = [], failures = vi.fn(), committed = vi.fn();
        const running = translateDocumentSegments(segments, {fileName: 'wait.pdf', batchLimits: {items: 1},
            retryBackoff: {maxWaitMs: 2000, sleep: () => new Promise(resolve => {releaseSleep = resolve;})},
            onRetryStateChange: state => waiting.push(state.waiting), onFailure: failures, onSegment: committed,
        });
        const outcome = expect(running).rejects.toThrow('第 2 段文档翻译失败：401 unauthorized');
        await vi.waitFor(() => expect(requests).toHaveLength(2));
        requests[0].reject(new Error('429 busy'));
        await vi.waitFor(() => expect(waiting).toEqual([1]));
        requests[1].reject(new Error('401 unauthorized'));
        await Promise.resolve();
        releaseSleep();
        await outcome;
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
        expect(waiting).toEqual([1, 0]);
        expect(failures).toHaveBeenCalledOnce(); expect(committed).not.toHaveBeenCalled();
    });

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

    it('caps exponential waits at sixty seconds, spends at most the budget and then fails with the last reason', async () => {
        mocks.translateTextBatch.mockRejectedValue(new Error('service unavailable'));
        const {waits, sleep} = sleeper();
        await expect(translateDocumentSegments(segments, {fileName: 'paper.pdf', retryBackoff: {maxWaitMs: 120_000, sleep}})).rejects.toThrow('第 1 段文档翻译失败：service unavailable');
        expect(waits).toEqual([2000, 4000, 8000, 16000, 32000, 58000]); expect(waits.reduce((sum, value) => sum + value, 0)).toBe(120_000);
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(7);
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

    it('显式重译在原文回显的逐段补译及后续批次中继续跳过缓存', async () => {
        mocks.translateTextBatch.mockRejectedValueOnce(echo()).mockImplementation(async sources => sources.map((source: string) => `译 ${source}`));
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        const result = await translateDocumentSegments(segments, {fileName: 'retry.pdf', useCache: false,
            batchLimits: {items: 2}, batchConcurrency: 1});
        expect(result).toEqual(segments.map(({source}) => `译 ${source}`));
        expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2);
        expect(mocks.translateText).toHaveBeenCalledTimes(2);
        for (const call of [...mocks.translateTextBatch.mock.calls, ...mocks.translateText.mock.calls]) {
            expect(call[2]).toMatchObject({useCache: false});
        }
    });

    it('keeps an empty echo fallback unfinished so a replacement service can translate it', async () => {
        mocks.translateTextBatch.mockRejectedValue(echo());
        mocks.translateText.mockResolvedValueOnce('延迟').mockResolvedValueOnce('  ');
        const initial = Array<string>(4).fill('');
        const progress: number[] = [];
        await expect(translateDocumentSegments(segments, {fileName: 'table.pdf', batchConcurrency: 1,
            onSegment: ({id, translation}) => {initial[id] = translation;}, onProgress: ({completed}) => progress.push(completed),
        })).rejects.toThrow('第 2 段文档翻译失败：翻译服务返回空译文');
        expect(initial).toEqual(['延迟', '', '', '']);
        expect(progress).toEqual([0, 1]);
        mocks.translateTextBatch.mockReset().mockResolvedValue(['阿耳戈斯', '秒', '表格之后是一个完整的句子。']);
        expect(await translateDocumentSegments(segments, {fileName: 'table.pdf', initialTranslations: initial})).toEqual(['延迟', '阿耳戈斯', '秒', '表格之后是一个完整的句子。']);
        expect(mocks.translateTextBatch.mock.calls[0][0]).toEqual(['ARGUS', 'Seconds', 'A full sentence follows the table.']);
    });

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
        mocks.translateText.mockImplementation(async (source: string) => {if (source === 'ARGUS' || source === 'Seconds') throw echo(); return '延迟';});
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

describe('document book translation recovery', () => {
    const segments = [{id: 0, source: 'First paragraph'}, {id: 1, source: 'Second paragraph'}];
    const fallbackError = (kind: string) => Object.assign(new Error(kind === 'echo' ? 'untranslated source' : 'invalid AI slots'), {
        code: kind === 'echo' ? 'UNTRANSLATED_RESPONSE' : 'AI_MULTI_SEGMENT_RESPONSE_INVALID',
    });
    const createTranslator = () => createDocumentSegmentTranslator({
        waitUntilReady: mocks.waitUntilReady,
        getDefaultService: () => mocks.defaultService,
        supportsBatch: service => service === 'microsoft',
        supportsAIMultiSegment: service => service === 'openai',
        translateText: mocks.translateText,
        translateTextBatch: mocks.translateTextBatch,
    });

    it.each(['echo', 'slots'].flatMap(kind => ['timeout', 'rate-limit', 'empty'].map(failure => [kind, failure])))
    ('recovers a %s batch fallback after a temporary %s without losing completed paragraphs', async (kind, failure) => {
        mocks.defaultService = kind === 'echo' ? 'microsoft' : 'openai';
        mocks.translateTextBatch.mockRejectedValue(fallbackError(kind));
        let attempts = 0;
        mocks.translateText.mockImplementation(async (source: string) => {
            if (source === segments[1].source && ++attempts === 1) {
                if (failure === 'empty') return '  ';
                throw new TranslationRequestError(serializeTranslationError({
                    message: failure === 'timeout' ? 'request timed out' : '429 temporarily limited', kind: failure, retryable: true,
                }));
            }
            return `译 ${source}`;
        });
        const waits: number[] = [], progress: number[] = [];
        const committed = vi.fn();
        expect(await createTranslator()(segments, {fileName: 'book.epub', batchConcurrency: 1,
            retryBackoff: {maxWaitMs: 2000, sleep: async delay => {waits.push(delay);}},
            onSegment: committed, onProgress: state => progress.push(state.completed),
        })).toEqual(segments.map(segment => `译 ${segment.source}`));
        expect(waits).toEqual([2000]); expect(progress).toEqual([0, 1, 2]);
        expect(mocks.translateTextBatch).toHaveBeenCalledOnce();
        expect(mocks.translateText.mock.calls.map(call => call[0])).toEqual([segments[0].source, segments[1].source, segments[1].source]);
        expect(committed.mock.calls.map(call => call[0].id)).toEqual([0, 1]);
        expect([...mocks.translateTextBatch.mock.calls, ...mocks.translateText.mock.calls].every(call => call[2].maxRetries === 0)).toBe(true);
    });

    it.each(['echo', 'slots'])('cancels the %s fallback retry without starting another request', async kind => {
        mocks.defaultService = kind === 'echo' ? 'microsoft' : 'openai';
        mocks.translateTextBatch.mockRejectedValue(fallbackError(kind));
        mocks.translateText.mockRejectedValue(new Error('429 busy'));
        const controller = new AbortController(), waiting: number[] = [];
        const committed = vi.fn();
        let sleepStarted = false;
        const running = createTranslator()(segments, {fileName: 'book.epub', batchConcurrency: 1, signal: controller.signal,
            retryBackoff: {maxWaitMs: 2000, sleep: async () => {sleepStarted = true; controller.abort();}},
            onRetryStateChange: state => waiting.push(state.waiting), onSegment: committed,
        });
        const result = await running.catch(error => error);
        expect(sleepStarted).toBe(true);
        expect(result).toMatchObject({name: 'AbortError'});
        expect(waiting).toEqual([1, 0]);
        expect(mocks.translateText).toHaveBeenCalledOnce(); expect(committed).not.toHaveBeenCalled();
    });

    it.each(['echo', 'slots'])('stops the %s fallback retry when a peer fails and preserves peer success', async kind => {
        mocks.defaultService = kind === 'echo' ? 'microsoft' : 'openai';
        const paragraphs = [...segments, {id: 2, source: 'Third paragraph'}];
        const batches: Array<{resolve(value: string[]): void; reject(error: Error): void}> = [];
        mocks.translateTextBatch.mockImplementation(() => new Promise((resolve, reject) => {batches.push({resolve, reject});}));
        mocks.translateText.mockRejectedValue(new Error('429 busy'));
        let releaseSleep: (() => void) | undefined;
        const waiting: number[] = [], committed = vi.fn();
        const running = createTranslator()(paragraphs, {fileName: 'book.epub', batchLimits: {items: 1},
            retryBackoff: {maxWaitMs: 2000, sleep: () => new Promise(resolve => {releaseSleep = resolve;})},
            onRetryStateChange: state => waiting.push(state.waiting), onSegment: committed,
        });
        const outcome = running.catch(error => error);
        await vi.waitFor(() => expect(batches).toHaveLength(3));
        batches[0].reject(fallbackError(kind));
        await vi.waitFor(() => expect(mocks.translateText).toHaveBeenCalledOnce());
        await Promise.resolve();
        // 旧实现在回退的第一次暂时性故障就结束；收齐同伴后仍可由明确断言报告该回归。
        batches[1].reject(new Error('401 unauthorized')); batches[2].resolve(['保留译文']);
        const result = await outcome;
        releaseSleep?.();
        expect(waiting).toEqual([1, 0]);
        expect(result).toMatchObject({message: '第 2 段文档翻译失败：401 unauthorized'});
        expect(mocks.translateText).toHaveBeenCalledOnce();
        expect(committed).toHaveBeenCalledWith({id: 2, translation: '保留译文'});
    });

    it.each(['batch', 'single'].flatMap(mode => [undefined, 3].map(maxRetries => ({mode, maxRetries}))))
    ('owns retry policy for $mode requests even when maxRetries is $maxRetries', async ({mode, maxRetries}) => {
        mocks.translateTextBatch.mockImplementation(async sources => sources.map((source: string) => `译 ${source}`));
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        await createTranslator()(segments, {fileName: 'book.epub', batchTranslation: mode === 'batch', maxRetries,
            retryBackoff: {maxWaitMs: 2000, sleep: async () => {}},
        });
        const calls = mode === 'batch' ? mocks.translateTextBatch.mock.calls : mocks.translateText.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(call => call[2].maxRetries === 0)).toBe(true);
    });

    it.each(['batch', 'single'])('preserves the caller retry policy for %s requests without document backoff', async mode => {
        mocks.translateTextBatch.mockImplementation(async sources => sources.map((source: string) => `译 ${source}`));
        mocks.translateText.mockImplementation(async source => `译 ${source}`);
        await createTranslator()(segments, {fileName: 'book.epub', batchTranslation: mode === 'batch', maxRetries: 4});
        const calls = mode === 'batch' ? mocks.translateTextBatch.mock.calls : mocks.translateText.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(call => call[2].maxRetries === 4)).toBe(true);
    });

    it.each(['batch', 'single', 'echo', 'slots'])('ends a stalled %s request at the document deadline and ignores late settlement', async mode => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let release: (() => void) | undefined;
        let observed: {signal?: AbortSignal; timeout?: number} | undefined;
        let outcome: Promise<void> | undefined;
        try {
            mocks.defaultService = mode === 'slots' ? 'openai' : 'microsoft';
            const hang = (value: string | string[], _context: string, options: {signal?: AbortSignal; timeout?: number}) => {
                observed = options;
                return new Promise((resolve, reject) => {
                    release = () => mode === 'single' ? reject(new Error('late rejection')) : resolve(Array.isArray(value) ? ['迟到译文'] : '迟到译文');
                });
            };
            mocks.translateTextBatch.mockImplementation(mode === 'echo' || mode === 'slots'
                ? async () => {throw fallbackError(mode);} : hang);
            mocks.translateText.mockImplementation(hang);
            const committed = vi.fn(), progress = vi.fn();
            let ended = false, failure: unknown;
            outcome = createTranslator()(segments.slice(0, 1), {fileName: 'book.epub', batchTranslation: mode !== 'single', signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 1000}, onSegment: committed, onProgress: progress,
            }).then(() => {ended = true;}, error => {ended = true; failure = error;});
            await vi.advanceTimersByTimeAsync(0);
            expect(observed?.timeout).toBe(1000);
            expect(observed?.signal).not.toBe(controller.signal);
            await vi.advanceTimersByTimeAsync(999); expect(ended).toBe(false);
            await vi.advanceTimersByTimeAsync(1); expect(ended).toBe(true); await outcome;
            expect(serializeTranslationError(failure)).toMatchObject({kind: 'timeout', retryable: true});
            expect(observed?.signal?.aborted).toBe(true);
            expect(controller.signal.aborted).toBe(false);
            release?.(); await vi.advanceTimersByTimeAsync(0);
            expect(committed).not.toHaveBeenCalled();
            expect(progress).toHaveBeenCalledOnce();
            expect(mocks.translateTextBatch).toHaveBeenCalledTimes(mode === 'single' ? 0 : 1);
            expect(mocks.translateText).toHaveBeenCalledTimes(mode === 'batch' ? 0 : 1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            controller.abort(); release?.(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();
        }
    });

    it.each(['batch', 'single', 'echo', 'slots'])('keeps user cancellation distinct from the deadline during a %s request', async mode => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let release: (() => void) | undefined;
        let outcome: Promise<void> | undefined;
        try {
            mocks.defaultService = mode === 'slots' ? 'openai' : 'microsoft';
            const hang = (value: string | string[]) => new Promise(resolve => {release = () => resolve(Array.isArray(value) ? ['迟到译文'] : '迟到译文');});
            mocks.translateTextBatch.mockImplementation(mode === 'echo' || mode === 'slots'
                ? async () => {throw fallbackError(mode);} : hang);
            mocks.translateText.mockImplementation(hang);
            const committed = vi.fn(), failed = vi.fn();
            let failure: unknown;
            outcome = createTranslator()(segments.slice(0, 1), {fileName: 'book.epub', batchTranslation: mode !== 'single', signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 1000}, onSegment: committed, onFailure: failed,
            }).then(() => {}, error => {failure = error;});
            await vi.advanceTimersByTimeAsync(100);
            controller.abort(); await outcome;
            release?.(); await vi.advanceTimersByTimeAsync(0);
            expect(failure).toMatchObject({name: 'AbortError'});
            expect(committed).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            controller.abort(); release?.(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();
        }
    });

    it('counts request time and retry waiting against the same deadline instead of renewing the request budget', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let outcome: Promise<void> | undefined;
        try {
            const timeouts: Array<number | undefined> = [];
            mocks.translateTextBatch.mockImplementation((_sources: string[], _context: string, options: {timeout?: number}) => {
                timeouts.push(options.timeout);
                return timeouts.length === 1
                    ? new Promise((_resolve, reject) => setTimeout(() => reject(new Error('429 busy')), 300))
                    : new Promise(() => {});
            });
            const waits: number[] = [];
            let ended = false, failure: unknown;
            outcome = createTranslator()(segments.slice(0, 1), {fileName: 'book.epub', signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 3000}, onRetry: state => waits.push(state.delayMs),
            }).then(() => {ended = true;}, error => {ended = true; failure = error;});
            await vi.advanceTimersByTimeAsync(2300);
            expect(timeouts).toEqual([3000, 700]); expect(waits).toEqual([2000]);
            await vi.advanceTimersByTimeAsync(699); expect(ended).toBe(false);
            await vi.advanceTimersByTimeAsync(1); expect(ended).toBe(true); await outcome;
            expect(serializeTranslationError(failure)).toMatchObject({kind: 'timeout', retryable: true});
            expect(mocks.translateTextBatch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
        } finally {controller.abort(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();}
    });

    it.each(['echo', 'slots'])('shares the original %s batch deadline across every scalar fallback paragraph', async mode => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let release: (() => void) | undefined;
        let outcome: Promise<void> | undefined;
        try {
            mocks.defaultService = mode === 'slots' ? 'openai' : 'microsoft';
            mocks.translateTextBatch.mockImplementation(() => new Promise((_resolve, reject) => setTimeout(() => reject(fallbackError(mode)), 300)));
            const timeouts: Array<number | undefined> = [];
            mocks.translateText.mockImplementation((source: string, _context: string, options: {timeout?: number}) => {
                timeouts.push(options.timeout);
                return source === segments[0].source ? new Promise(resolve => setTimeout(() => resolve('第一段译文'), 300))
                    : new Promise(resolve => {release = () => resolve('迟到的第二段译文');});
            });
            const committed = vi.fn();
            let ended = false, failure: unknown;
            outcome = createTranslator()(segments, {fileName: 'book.epub', batchConcurrency: 1, signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 1000}, onSegment: committed,
            }).then(() => {ended = true;}, error => {ended = true; failure = error;});
            await vi.advanceTimersByTimeAsync(600); expect(timeouts).toEqual([700, 400]);
            await vi.advanceTimersByTimeAsync(399); expect(ended).toBe(false);
            await vi.advanceTimersByTimeAsync(1); expect(ended).toBe(true); await outcome;
            expect(serializeTranslationError(failure)).toMatchObject({kind: 'timeout', retryable: true});
            release?.(); await vi.advanceTimersByTimeAsync(0);
            expect(committed).toHaveBeenCalledOnce(); expect(committed).toHaveBeenCalledWith({id: 0, translation: '第一段译文'});
            expect(mocks.translateText).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
        } finally {controller.abort(); release?.(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();}
    });

    it('gives each newly claimed batch its own deadline after earlier batches complete', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let outcome: Promise<void> | undefined;
        try {
            const timeouts: Array<number | undefined> = [];
            mocks.translateTextBatch.mockImplementation((_sources: string[], _context: string, options: {timeout?: number}) => {
                timeouts.push(options.timeout);
                return timeouts.length === 1 ? new Promise(resolve => setTimeout(() => resolve(['第一段译文']), 500)) : new Promise(() => {});
            });
            const committed = vi.fn(); let ended = false;
            outcome = createTranslator()(segments, {fileName: 'book.epub', batchConcurrency: 1, batchLimits: {items: 1}, signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 1000}, onSegment: committed,
            }).then(() => {ended = true;}, () => {ended = true;});
            await vi.advanceTimersByTimeAsync(1000); expect(ended).toBe(false); expect(timeouts).toEqual([1000, 1000]);
            await vi.advanceTimersByTimeAsync(500); expect(ended).toBe(true); await outcome;
            expect(committed).toHaveBeenCalledOnce(); expect(committed).toHaveBeenCalledWith({id: 0, translation: '第一段译文'});
            expect(vi.getTimerCount()).toBe(0);
        } finally {controller.abort(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();}
    });

    it('does not start the next fallback paragraph when committing the previous result consumes the deadline', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(0);
            mocks.translateTextBatch.mockRejectedValue(fallbackError('echo'));
            mocks.translateText.mockResolvedValue('第一段译文');
            const committed = vi.fn(() => vi.setSystemTime(1000));
            const failure = await createTranslator()(segments, {fileName: 'book.epub', batchConcurrency: 1,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 1000}, onSegment: committed,
            }).catch(error => error);
            expect(serializeTranslationError(failure)).toMatchObject({kind: 'timeout', retryable: true});
            expect(mocks.translateText).toHaveBeenCalledOnce();
            expect(committed).toHaveBeenCalledWith({id: 0, translation: '第一段译文'});
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });

    it('honors cancellation triggered while choosing the next reading position before dispatch', async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            await expect(createTranslator()(segments, {fileName: 'book.epub', signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 1000},
                prioritize: pending => {controller.abort(); return pending;},
            })).rejects.toMatchObject({name: 'AbortError'});
            expect(mocks.translateTextBatch).not.toHaveBeenCalled(); expect(mocks.translateText).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });

    it('handles cancellation while the per-attempt cancellation listener is being installed without dispatch or timer leaks', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const register = controller.signal.addEventListener.bind(controller.signal);
        let listeners = 0;
        const installed = vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
            register(type, listener, options);
            if (type === 'abort' && ++listeners === 2) controller.abort();
        });
        try {
            await expect(createTranslator()(segments, {fileName: 'book.epub', signal: controller.signal,
                retryBackoff: {maxWaitMs: 600_000, maxDurationMs: 1000},
            })).rejects.toMatchObject({name: 'AbortError'});
            expect(mocks.translateTextBatch).not.toHaveBeenCalled(); expect(mocks.translateText).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {installed.mockRestore(); vi.useRealTimers();}
    });

    it('clears the deadline timer after success without an external cancellation signal', async () => {
        vi.useFakeTimers();
        try {
            mocks.translateTextBatch.mockResolvedValue(['第一段译文', '第二段译文']);
            await expect(createTranslator()(segments, {fileName: 'book.epub', retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 1000}}))
                .resolves.toEqual(['第一段译文', '第二段译文']);
            expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });

    it('does not send another request after retry waiting reaches the absolute deadline', async () => {
        vi.useFakeTimers();
        try {
            mocks.translateTextBatch.mockRejectedValue(new Error('429 busy'));
            const waiting: number[] = [], waits: number[] = [];
            let ended = false, failure: unknown;
            const outcome = createTranslator()(segments.slice(0, 1), {fileName: 'book.epub',
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 1000},
                onRetry: retry => waits.push(retry.delayMs), onRetryStateChange: state => waiting.push(state.waiting),
            }).then(() => {ended = true;}, error => {ended = true; failure = error;});
            await vi.advanceTimersByTimeAsync(999); expect(ended).toBe(false);
            await vi.advanceTimersByTimeAsync(1); expect(ended).toBe(true); await outcome;
            expect(serializeTranslationError(failure)).toMatchObject({kind: 'timeout', retryable: true});
            expect(waits).toEqual([1000]); expect(waiting).toEqual([1, 0]);
            expect(mocks.translateTextBatch).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
        } finally {vi.useRealTimers();}
    });
});

describe('document service timeout compatibility', () => {
    const segments = [{id: 0, source: 'Book paragraph'}];
    const createTranslator = (getRequestTimeout: (service: string, batch: boolean) => number) => createDocumentSegmentTranslator({
        waitUntilReady: mocks.waitUntilReady,
        getDefaultService: () => mocks.defaultService,
        getRequestTimeout,
        supportsBatch: service => service === 'microsoft',
        translateText: mocks.translateText,
        translateTextBatch: mocks.translateTextBatch,
    });

    it.each(['batch', 'single'])('rejects a successful %s settlement at the attempt deadline before its timer fires', async mode => {
        vi.useFakeTimers();
        const controller = new AbortController();
        try {
            vi.setSystemTime(0);
            const getRequestTimeout = vi.fn(() => 250);
            const committed = vi.fn(), aborted = vi.fn();
            let observed: {timeout?: number; signal?: AbortSignal} | undefined;
            let settlement: {now: number; timers: number; aborted: boolean | undefined} | undefined;
            const translate = (source: string | string[], _context: string, options: {timeout?: number; signal?: AbortSignal}) => new Promise(resolve => {
                observed = options;
                options.signal?.addEventListener('abort', aborted, {once: true});
                const attemptDeadlineAt = Date.now() + options.timeout!;
                // 只移动系统时钟，不执行超时回调，让成功结算后的截止检查负责拒收。
                vi.setSystemTime(attemptDeadlineAt);
                settlement = {now: Date.now(), timers: vi.getTimerCount(), aborted: options.signal?.aborted};
                resolve(Array.isArray(source) ? ['边界译文'] : '边界译文');
            });
            mocks.translateTextBatch.mockImplementation(translate); mocks.translateText.mockImplementation(translate);
            const failure = await createTranslator(getRequestTimeout)(segments, {fileName: 'book.epub', batchTranslation: mode === 'batch', signal: controller.signal,
                retryBackoff: {maxWaitMs: 0, maxDurationMs: 1000}, onSegment: committed,
            }).catch(error => error);
            expect(settlement).toEqual({now: 250, timers: 1, aborted: false});
            expect(observed?.timeout).toBe(250);
            expect(serializeTranslationError(failure)).toMatchObject({kind: 'timeout', retryable: true});
            expect(observed?.signal).not.toBe(controller.signal); expect(observed?.signal?.aborted).toBe(true);
            expect(aborted).toHaveBeenCalledOnce(); expect(controller.signal.aborted).toBe(false);
            expect(committed).not.toHaveBeenCalled();
            expect(mocks.translateTextBatch).toHaveBeenCalledTimes(mode === 'batch' ? 1 : 0);
            expect(mocks.translateText).toHaveBeenCalledTimes(mode === 'single' ? 1 : 0);
            expect(vi.getTimerCount()).toBe(0);
        } finally {controller.abort(); vi.useRealTimers();}
    });

    it.each(['batch', 'single'])('keeps each %s attempt within the frozen service timeout while spending the overall recovery budget', async mode => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let outcome: Promise<void> | undefined;
        try {
            let configuredTimeout = 45;
            const getRequestTimeout = vi.fn(() => configuredTimeout);
            const timeouts: Array<number | undefined> = [], signals: Array<AbortSignal | undefined> = [];
            const hang = (_source: string | string[], _context: string, options: {timeout?: number; signal?: AbortSignal; serviceOverride?: string}) => {
                timeouts.push(options.timeout); signals.push(options.signal);
                configuredTimeout = 999; mocks.defaultService = 'openai';
                expect(options.serviceOverride).toBe('microsoft');
                return new Promise(() => {});
            };
            mocks.translateTextBatch.mockImplementation(hang); mocks.translateText.mockImplementation(hang);
            let ended = false, failure: unknown;
            outcome = createTranslator(getRequestTimeout)(segments, {fileName: 'book.epub', batchTranslation: mode === 'batch', signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 120, sleep: async () => {}},
            }).then(() => {ended = true;}, error => {ended = true; failure = error;});
            await vi.advanceTimersByTimeAsync(44); expect(timeouts).toEqual([45]); expect(ended).toBe(false);
            await vi.advanceTimersByTimeAsync(1); expect(timeouts).toEqual([45, 45]); expect(signals[0]?.aborted).toBe(true);
            await vi.advanceTimersByTimeAsync(45); expect(timeouts).toEqual([45, 45, 30]); expect(ended).toBe(false);
            await vi.advanceTimersByTimeAsync(30); expect(ended).toBe(true); await outcome;
            expect(serializeTranslationError(failure)).toMatchObject({kind: 'timeout', retryable: true});
            expect(signals.every(signal => signal?.aborted)).toBe(true);
            expect(getRequestTimeout).toHaveBeenCalledTimes(2);
            expect(getRequestTimeout).toHaveBeenCalledWith('microsoft', false); expect(getRequestTimeout).toHaveBeenCalledWith('microsoft', true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {controller.abort(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();}
    });

    it.each(['batch', 'single'])('preserves a user configured %s request timeout longer than the document recovery default', async mode => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let outcome: Promise<void> | undefined;
        try {
            let configuredTimeout = 600;
            const getRequestTimeout = vi.fn(() => configuredTimeout);
            const timeouts: Array<number | undefined> = [];
            const translate = (source: string | string[], _context: string, options: {timeout?: number}) => {
                timeouts.push(options.timeout); configuredTimeout = 10;
                return new Promise(resolve => setTimeout(() => resolve(Array.isArray(source) ? ['正常译文'] : '正常译文'), 500));
            };
            mocks.translateTextBatch.mockImplementation(translate); mocks.translateText.mockImplementation(translate);
            let ended = false, result: unknown;
            outcome = createTranslator(getRequestTimeout)(segments, {fileName: 'book.epub', batchTranslation: mode === 'batch', signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 120},
            }).then(value => {ended = true; result = value;}, error => {ended = true; result = error;});
            await vi.advanceTimersByTimeAsync(120); expect(ended).toBe(false); expect(timeouts).toEqual([600]);
            await vi.advanceTimersByTimeAsync(380); expect(ended).toBe(true); await outcome;
            expect(result).toEqual(['正常译文']); expect(getRequestTimeout).toHaveBeenCalledTimes(2);
            expect(getRequestTimeout).toHaveBeenCalledWith('microsoft', false); expect(getRequestTimeout).toHaveBeenCalledWith('microsoft', true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {controller.abort(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();}
    });

    it('keeps the original batch deadline when fallback singles have a longer service timeout', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        let release: (() => void) | undefined;
        let outcome: Promise<void> | undefined;
        try {
            const getRequestTimeout = vi.fn((_service: string, batch: boolean) => batch ? 45 : 300);
            const batchTimeouts: Array<number | undefined> = [], singleTimeouts: Array<number | undefined> = [];
            mocks.translateTextBatch.mockImplementation((_sources: string[], _context: string, options: {timeout?: number}) => {
                batchTimeouts.push(options.timeout);
                return new Promise((_resolve, reject) => setTimeout(() => reject(Object.assign(new Error('echo'), {code: 'UNTRANSLATED_RESPONSE'})), 20));
            });
            mocks.translateText.mockImplementation((_source: string, _context: string, options: {timeout?: number}) => {
                singleTimeouts.push(options.timeout);
                return new Promise(resolve => {release = () => resolve('迟到译文');});
            });
            const committed = vi.fn(); let ended = false, failure: unknown;
            outcome = createTranslator(getRequestTimeout)(segments, {fileName: 'book.epub', signal: controller.signal,
                retryBackoff: {maxWaitMs: 120_000, maxDurationMs: 120}, onSegment: committed,
            }).then(() => {ended = true;}, error => {ended = true; failure = error;});
            await vi.advanceTimersByTimeAsync(20); expect(batchTimeouts).toEqual([45]); expect(singleTimeouts).toEqual([100]);
            await vi.advanceTimersByTimeAsync(99); expect(ended).toBe(false);
            await vi.advanceTimersByTimeAsync(1); expect(ended).toBe(true); await outcome;
            expect(serializeTranslationError(failure)).toMatchObject({kind: 'timeout', retryable: true});
            release?.(); await vi.advanceTimersByTimeAsync(0); expect(committed).not.toHaveBeenCalled();
            expect(getRequestTimeout).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
        } finally {controller.abort(); release?.(); await vi.advanceTimersByTimeAsync(0); await outcome; vi.useRealTimers();}
    });

    it.each(['batch', 'single'])('leaves the existing %s client timeout selection untouched when document backoff is absent', async mode => {
        const getRequestTimeout = vi.fn(() => 45);
        mocks.translateTextBatch.mockResolvedValue(['正常译文']); mocks.translateText.mockResolvedValue('正常译文');
        expect(await createTranslator(getRequestTimeout)(segments, {fileName: 'book.epub', batchTranslation: mode === 'batch', maxRetries: 2}))
            .toEqual(['正常译文']);
        const calls = mode === 'batch' ? mocks.translateTextBatch.mock.calls : mocks.translateText.mock.calls;
        expect(calls).toHaveLength(1); expect(calls[0][2].timeout).toBeUndefined(); expect(calls[0][2].maxRetries).toBe(2);
    });
});

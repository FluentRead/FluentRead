import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
    createDocumentFileLoadGuard,
    createDocumentSegmentTranslator,
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

    it('对 AI 服务使用逐段翻译，避免把数组隐式拼成一个请求', async () => {
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

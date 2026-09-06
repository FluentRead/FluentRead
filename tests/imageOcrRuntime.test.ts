import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {recognize, ensureLanguages, clearModels, removeFiles, createRuntime, tesseractCreateWorker} = vi.hoisted(() => ({
    clearModels: vi.fn(async (remove: () => Promise<void>) => remove()), removeFiles: vi.fn(async () => {}), recognize: vi.fn(), ensureLanguages: vi.fn(), createRuntime: vi.fn(), tesseractCreateWorker: vi.fn(),
}));
vi.mock('@/src/features/image-translation/services/ocrWorkerRuntime', () => ({
    createOcrWorkerRuntime: createRuntime,
}));
vi.mock('@/src/features/image-translation/services/ocrModelCache', () => ({removeOcrModelFiles: removeFiles}));
vi.mock('tesseract.js', () => ({createWorker: tesseractCreateWorker, PSM: {SPARSE_TEXT: 11, SINGLE_BLOCK: 6}}));

const blockResult = () => ({data: {blocks: [{paragraphs: [{lines: [{
    text: 'hello', bbox: {x0: 10, y0: 10, x1: 50, y1: 30},
}]}]}]}});

describe('图片 OCR 处理与结果缓存', () => {
    let recognizeImage: typeof import('@/src/features/image-translation/services/ocrRuntime')['recognizeImage'];
    let dimensions: {width: number; height: number};
    let sources: Array<{src: string; onload: (() => void) | null; onerror: (() => void) | null}>;
    let canvas: {width: number; height: number; getContext: ReturnType<typeof vi.fn>; toDataURL: ReturnType<typeof vi.fn>};
    let context: {drawImage: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; fillStyle: string; imageSmoothingEnabled: boolean; imageSmoothingQuality: string};
    let onImageCreated: (() => void) | undefined;

    it('清除语言包后丢弃 OCR 结果并重新识别', async () => {
        await recognizeImage('same', 'en');
        await recognizeImage('same', 'en');
        expect(recognize).toHaveBeenCalledTimes(1);
        const {removeImageOcrLanguages} = await import('@/src/features/image-translation/services/ocrRuntime');
        await removeImageOcrLanguages(['eng']);
        expect(removeFiles).toHaveBeenCalledWith(['eng']);
        await recognizeImage('same', 'en');
        expect(recognize).toHaveBeenCalledTimes(2);
    });
    beforeEach(async () => {
        vi.resetModules();
        recognize.mockReset().mockResolvedValue(blockResult());
        ensureLanguages.mockReset().mockResolvedValue(undefined);
        createRuntime.mockReset().mockReturnValue({recognize, ensureLanguages, clearModels});
        tesseractCreateWorker.mockReset().mockResolvedValue({});
        onImageCreated = undefined;
        dimensions = {width: 100, height: 100};
        sources = [];
        context = {drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', imageSmoothingEnabled: false, imageSmoothingQuality: 'low'};
        canvas = {width: 0, height: 0, getContext: vi.fn(() => context), toDataURL: vi.fn(() => 'scaled-image')};
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});
        vi.stubGlobal('Image', class {
            naturalWidth = dimensions.width;
            naturalHeight = dimensions.height;
            width = dimensions.width;
            height = dimensions.height;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            currentSrc = '';
            constructor() { sources.push(this); onImageCreated?.(); }
            get src() { return this.currentSrc; }
            set src(value: string) {
                this.currentSrc = value;
                if (value && value !== 'pending') {
                    queueMicrotask(() => value === 'broken' ? this.onerror?.() : this.onload?.());
                }
            }
        });
        ({recognizeImage} = await import('@/src/features/image-translation/services/ocrRuntime'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('同图同语言复用完成的 OCR，并隔离调用方修改', async () => {
        const first = await recognizeImage('same', 'en');
        first[0].text = 'mutated';
        first[0].bbox.x0 = 99;
        const cached = await recognizeImage('same', 'en');
        expect(cached).toEqual([{text: 'hello', bbox: {x0: 10, y0: 10, x1: 50, y1: 30}}]);
        cached[0].text = 'changed again';
        expect((await recognizeImage('same', 'en'))[0].text).toBe('hello');
        expect(recognize).toHaveBeenCalledOnce();
        expect(sources).toHaveLength(1);
        expect(document.createElement).not.toHaveBeenCalled();
        expect(sources[0]).toMatchObject({src: '', onload: null, onerror: null});
    });

    it('扩展 Worker 使用本地资源目录并复用语言下载边界及取消信号', async () => {
        vi.stubGlobal('chrome', {runtime: {getURL: (path: string) => `chrome-extension://test${path}`}});
        await createRuntime.mock.calls[0][0].createWorker('jpn+eng');
        expect(tesseractCreateWorker).toHaveBeenCalledWith('jpn+eng', 1, {
            workerPath: 'chrome-extension://test/fluent-read-ocr/worker/worker.min.js',
            corePath: 'chrome-extension://test/fluent-read-ocr/core',
            cachePath: 'fluent-read-image-ocr', workerBlobURL: false,
        });
        const {downloadImageOcrLanguages} = await import('@/src/features/image-translation/services/ocrRuntime');
        const controller = new AbortController();
        await downloadImageOcrLanguages(['jpn', 'eng'], controller.signal);
        expect(ensureLanguages).toHaveBeenCalledWith(['jpn', 'eng'], controller.signal);
        ensureLanguages.mockRejectedValueOnce(new Error('download failed'));
        await expect(downloadImageOcrLanguages(['eng'])).rejects.toThrow('download failed');
    });

    it('同图并发完成覆盖缓存时回收旧字节计数，后续缓存不被重复计费误淘汰', async () => {
        const shared = 'a'.repeat(3 * 1024 * 1024);
        await Promise.all([recognizeImage(shared, 'en'), recognizeImage(shared, 'en')]);
        await recognizeImage('b'.repeat(2 * 1024 * 1024), 'en');
        await recognizeImage(shared, 'en');
        expect(recognize).toHaveBeenCalledTimes(3);
    });

    it('不同 OCR 语言分别缓存，第四张图片淘汰最近最少使用的结果', async () => {
        await recognizeImage('one', 'en');
        await recognizeImage('one', 'ja');
        await recognizeImage('two', 'en');
        await recognizeImage('one', 'en');
        await recognizeImage('three', 'en');
        await recognizeImage('one', 'en');
        expect(recognize).toHaveBeenCalledTimes(4);
        await recognizeImage('one', 'ja');
        expect(recognize).toHaveBeenCalledTimes(5);
        expect(recognize).toHaveBeenLastCalledWith('one', 'jpn+eng', undefined);
    });

    it('单图和总输入字节预算限制缓存，不长期保留巨型 data URL', async () => {
        const huge = 'x'.repeat(6 * 1024 * 1024);
        await recognizeImage(huge, 'en');
        await recognizeImage(huge, 'en');
        expect(recognize).toHaveBeenCalledTimes(2);
        recognize.mockClear();
        const first = 'a'.repeat(4 * 1024 * 1024);
        const second = 'b'.repeat(4 * 1024 * 1024);
        await recognizeImage(first, 'en');
        await recognizeImage(second, 'en');
        await recognizeImage(first, 'en');
        expect(recognize).toHaveBeenCalledTimes(3);
    });

    it('大图只降采样识别并映回原始坐标，编码后释放临时画布', async () => {
        dimensions = {width: 8000, height: 1000};
        const lines = await recognizeImage('large', 'en');
        expect(context.drawImage).toHaveBeenCalledWith(sources[0], 0, 0, 4096, 512);
        expect(context.imageSmoothingEnabled).toBe(true);
        expect(context.imageSmoothingQuality).toBe('high');
        expect(recognize).toHaveBeenCalledWith('scaled-image', 'eng', undefined);
        expect(lines).toEqual([{text: 'hello', bbox: {x0: 19, y0: 19, x1: 98, y1: 59}}]);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(sources[0].src).toBe('');
        expect(context.fillRect).not.toHaveBeenCalled();
    });

    it('圈选小图放大加边后映回坐标，与普通图片分开缓存且不重复识别', async () => {
        await recognizeImage('same', 'en');
        const lines = await recognizeImage('same', 'en', undefined, {profile: 'area'});
        expect(context.drawImage).toHaveBeenCalledWith(sources[1], 10, 10, 200, 200);
        expect(context.fillRect).toHaveBeenCalledWith(0, 0, 220, 220);
        expect(context.fillStyle).toBe('#ffffff');
        expect(lines).toEqual([{text: 'hello', bbox: {x0: 0, y0: 0, x1: 20, y1: 10}}]);
        await expect(recognizeImage('same', 'en', undefined, {profile: 'area'})).resolves.toEqual(lines);
        await expect(recognizeImage('same', 'en', undefined, {profile: 'image'})).resolves.toEqual([
            {text: 'hello', bbox: {x0: 10, y0: 10, x1: 50, y1: 30}},
        ]);
        expect(recognize).toHaveBeenCalledTimes(2);
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(sources.every(source => source.src === '')).toBe(true);
    });

    it('圈选稀疏模式空结果才以单块模式重试一次，普通图片保留单次识别', async () => {
        recognize.mockResolvedValueOnce({data: {blocks: []}});
        await expect(recognizeImage('area', 'en', undefined, {profile: 'area'})).resolves.toHaveLength(1);
        expect(recognize).toHaveBeenNthCalledWith(1, 'scaled-image', 'eng', undefined);
        expect(recognize).toHaveBeenNthCalledWith(2, 'scaled-image', 'eng', undefined, 6);
        recognize.mockResolvedValue({data: {blocks: []}});
        await expect(recognizeImage('blank', 'en', undefined, {profile: 'area'})).resolves.toEqual([]);
        expect(recognize).toHaveBeenCalledTimes(4);
        await recognizeImage('blank', 'en', undefined, {profile: 'area'});
        expect(recognize).toHaveBeenCalledTimes(4);
        await expect(recognizeImage('normal', 'en')).resolves.toEqual([]);
        expect(recognize).toHaveBeenCalledTimes(5);
    });

    it('圈选第二次识别取消或失败不写缓存，重试重新识别', async () => {
        const controller = new AbortController();
        recognize.mockResolvedValueOnce({data: {blocks: []}}).mockImplementationOnce(async () => {
            controller.abort();
            return blockResult();
        });
        await expect(recognizeImage('retry-area', 'en', controller.signal, {profile: 'area'}))
            .rejects.toMatchObject({name: 'AbortError'});
        recognize.mockResolvedValueOnce({data: {blocks: []}}).mockRejectedValueOnce(new Error('retry failed'));
        await expect(recognizeImage('retry-area', 'en', undefined, {profile: 'area'})).rejects.toThrow('retry failed');
        await expect(recognizeImage('retry-area', 'en', undefined, {profile: 'area'})).resolves.toHaveLength(1);
        expect(recognize).toHaveBeenCalledTimes(5);
    });

    it('解码无事件时按时失败并清理来源、监听器和计时器，可以随后重试', async () => {
        vi.useFakeTimers();
        const pending = recognizeImage('pending', 'en');
        const rejection = expect(pending).rejects.toThrow('图片解码超时');
        await vi.advanceTimersByTimeAsync(15_000);
        await rejection;
        expect(sources[0]).toMatchObject({src: '', onload: null, onerror: null});
        expect(vi.getTimerCount()).toBe(0);
        expect(recognize).not.toHaveBeenCalled();
        vi.useRealTimers();
        const retry = recognizeImage('pending', 'en');
        sources[1].onload?.();
        await expect(retry).resolves.toHaveLength(1);
    });

    it('解码完成与准备继续之间取消，释放解码源并不启动 OCR', async () => {
        const controller = new AbortController();
        const pending = recognizeImage('pending', 'en', controller.signal);
        sources[0].onload?.();
        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(sources[0].src).toBe('');
        expect(recognize).not.toHaveBeenCalled();
    });

    it('创建解码对象期间或编码完成时取消，不赋予来源或启动后续 OCR', async () => {
        const constructing = new AbortController();
        onImageCreated = () => constructing.abort();
        await expect(recognizeImage('never-started', 'en', constructing.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(sources[0]).toMatchObject({src: '', onload: null, onerror: null});
        onImageCreated = undefined;
        const encoding = new AbortController();
        canvas.toDataURL.mockImplementationOnce(() => { encoding.abort(); return 'encoded'; });
        await expect(recognizeImage('encoded-abort', 'en', encoding.signal, {profile: 'area'}))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(sources[1].src).toBe('');
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(recognize).not.toHaveBeenCalled();
    });

    it.each(['context', 'drawing', 'encoding'])('画布%s失败也释放画布像素与解码源', async stage => {
        dimensions = {width: 8000, height: 1000};
        if (stage === 'context') canvas.getContext.mockReturnValueOnce(null);
        if (stage === 'drawing') context.drawImage.mockImplementationOnce(() => { throw new Error('draw failed'); });
        if (stage === 'encoding') canvas.toDataURL.mockImplementationOnce(() => { throw new Error('encode failed'); });
        await expect(recognizeImage('canvas-failure', 'en')).rejects.toThrow();
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(sources[0].src).toBe('');
        expect(recognize).not.toHaveBeenCalled();
        await expect(recognizeImage('canvas-failure', 'en')).resolves.toHaveLength(1);
    });

    it('预取消请求不读取缓存或解码，取消解码会移除图片监听器', async () => {
        await recognizeImage('cached', 'en');
        const controller = new AbortController();
        controller.abort();
        await expect(recognizeImage('cached', 'en', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(sources).toHaveLength(1);
        const pendingController = new AbortController();
        const pending = recognizeImage('pending', 'en', pendingController.signal);
        pendingController.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(sources[1]).toMatchObject({src: '', onload: null, onerror: null});
        expect(recognize).toHaveBeenCalledOnce();
    });

    it('识别取消后即使底层迟到成功也不写缓存', async () => {
        const controller = new AbortController();
        recognize.mockImplementationOnce(async () => {
            controller.abort();
            return blockResult();
        });
        await expect(recognizeImage('cancelled', 'en', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        await recognizeImage('cancelled', 'en');
        expect(recognize).toHaveBeenCalledTimes(2);
    });

    it('解码失败、非法尺寸、Canvas 不可用和识别失败均可明确失败后重试', async () => {
        await expect(recognizeImage('broken', 'en')).rejects.toThrow('图片数据无法解码');
        expect(sources[0]).toMatchObject({src: '', onload: null, onerror: null});
        dimensions = {width: 0, height: 0};
        await expect(recognizeImage('invalid', 'en')).rejects.toThrow('图片尺寸无效');
        dimensions = {width: 8000, height: 1000};
        canvas.getContext.mockReturnValueOnce(null);
        await expect(recognizeImage('no-canvas', 'en')).rejects.toThrow('浏览器不支持图片处理');
        dimensions = {width: 100, height: 100};
        recognize.mockRejectedValueOnce(new Error('engine failed'));
        await expect(recognizeImage('retry', 'en')).rejects.toThrow('engine failed');
        await expect(recognizeImage('retry', 'en')).resolves.toHaveLength(1);
        expect(recognize).toHaveBeenCalledTimes(2);
    });
});

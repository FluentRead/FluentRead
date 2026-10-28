import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {getEventListeners} from 'node:events';
import {
    createOcrWorkerRuntime,
    type OcrWorkerPort,
} from '@/src/features/image-translation/services/ocrWorkerRuntime';

type RecognitionResult = {worker: string; image: string};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return {promise, resolve, reject};
}

function createWorker(name: string): OcrWorkerPort<RecognitionResult> {
    return {
        setParameters: vi.fn(async () => undefined),
        recognize: vi.fn(async image => ({worker: name, image})),
        terminate: vi.fn(async () => undefined),
    };
}

describe('OCR worker runtime', () => {
    it('逐包准备和自动语言切换复用一个 Worker，识别参数在重新初始化后重新设置', async () => {
        const worker = {...createWorker('shared'), reinitialize: vi.fn(async (_languages: string) => undefined)};
        const factory = vi.fn(async () => worker);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        for (const languages of [['chi_sim'], ['chi_tra'], ['eng'], ['jpn', 'jpn_vert']]) await runtime.ensureLanguages(languages);
        await runtime.recognize('auto', 'chi_sim+chi_tra+eng+jpn+jpn_vert', undefined, 12);
        await runtime.recognize('english', 'eng');
        await runtime.recognize('english-again', 'eng');
        expect(factory).toHaveBeenCalledOnce();
        expect(worker.reinitialize.mock.calls.map(call => call[0])).toEqual([
            'chi_tra', 'eng', 'jpn+jpn_vert', 'chi_sim+chi_tra+eng+jpn+jpn_vert', 'eng',
        ]);
        expect(worker.setParameters).toHaveBeenCalledTimes(2);
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('语言重新初始化必须等待当前识别结束，不交叉覆盖任务参数', async () => {
        const worker = {...createWorker('shared'), reinitialize: vi.fn(async () => undefined)};
        const gate = deferred<RecognitionResult>();
        vi.mocked(worker.recognize).mockReturnValueOnce(gate.promise);
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        const first = runtime.recognize('first', 'eng');
        await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
        const next = runtime.recognize('next', 'chi_sim+eng');
        await Promise.resolve(); expect(worker.reinitialize).not.toHaveBeenCalled();
        gate.resolve({worker: 'shared', image: 'first'}); await first; await next;
        expect(worker.reinitialize).toHaveBeenCalledWith('chi_sim+eng');
        expect(worker.setParameters).toHaveBeenCalledTimes(2);
    });

    it('累计模型超过五个时重建，避免反复切换语言无限积累模型内存', async () => {
        const first = {...createWorker('first'), reinitialize: vi.fn(async () => undefined)};
        const next = {...createWorker('next'), reinitialize: vi.fn(async () => undefined)};
        const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        await runtime.ensureLanguages(['chi_sim', 'chi_tra', 'eng', 'jpn', 'jpn_vert']);
        await runtime.recognize('english', 'eng');
        await runtime.ensureLanguages(['fra']);
        expect(first.reinitialize).toHaveBeenCalledOnce();
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledTimes(2);
        await runtime.ensureLanguages(['fra', 'eng']);
        expect(next.reinitialize).toHaveBeenCalledWith('fra+eng');
        await runtime.clearModels(async () => {});
        expect(next.terminate).toHaveBeenCalledOnce();
    });

    it('再次准备已加载模型不切换识别语言或重设参数', async () => {
        const worker = {...createWorker('shared'), reinitialize: vi.fn(async (_languages: string) => undefined)};
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        await runtime.recognize('first', 'chi_sim+eng');
        await runtime.ensureLanguages(['eng']);
        await runtime.ensureLanguages(['chi_sim', 'eng']);
        await runtime.recognize('next', 'chi_sim+eng');
        expect(worker.reinitialize).not.toHaveBeenCalled();
        expect(worker.setParameters).toHaveBeenCalledOnce();
    });

    it('语言重新初始化失败释放不可用 Worker，下一次调用重新创建并保留真实错误', async () => {
        const first = {...createWorker('first'), reinitialize: vi.fn(async () => {throw new Error('model failed');})};
        vi.mocked(first.terminate).mockRejectedValueOnce(new Error('already stopped'));
        const next = createWorker('next');
        const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        await runtime.recognize('first', 'eng');
        await expect(runtime.ensureLanguages(['jpn'])).rejects.toThrow('model failed');
        await expect(runtime.recognize('retry', 'jpn')).resolves.toEqual({worker: 'next', image: 'retry'});
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it.each(['resolve', 'reject'] as const)('取消语言重新初始化后，迟到的 %s 不覆盖或销毁后续 Worker', async outcome => {
        const gate = deferred<unknown>();
        const first = {...createWorker('first'), reinitialize: vi.fn(() => gate.promise)};
        const next = createWorker('next');
        const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        await runtime.recognize('first', 'eng');
        const controller = new AbortController();
        const switching = runtime.recognize('cancelled', 'jpn', controller.signal);
        const rejection = expect(switching).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(first.reinitialize).toHaveBeenCalledOnce());
        controller.abort(); await rejection;
        await runtime.recognize('next', 'fra');
        if (outcome === 'resolve') gate.resolve(undefined); else gate.reject(new Error('late model error'));
        await Promise.resolve(); await Promise.resolve();
        await runtime.recognize('again', 'fra');
        expect(factory).toHaveBeenCalledTimes(2);
        expect(next.terminate).not.toHaveBeenCalled();
        expect(next.setParameters).toHaveBeenCalledOnce();
    });

    it('真实百分比仅属于当前任务，丢弃非法、重复、倒退和迟到进度，展示错误不影响识别', async () => {
        const worker = createWorker('eng');
        const pending = deferred<RecognitionResult>();
        vi.mocked(worker.recognize).mockReturnValueOnce(pending.promise);
        let report!: (value: number, jobId: string) => void;
        const runtime = createOcrWorkerRuntime({sparseTextMode: 11, createWorker: async (_languages, notify) => {
            report = notify; report(0.5, 'initializing'); return worker;
        }});
        const onProgress = vi.fn((percent: number) => {if (percent === 30) throw new Error('detached UI');});
        const active = runtime.recognize('first', 'eng', undefined, undefined, onProgress);
        await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
        const jobId = vi.mocked(worker.recognize).mock.calls[0][3]!;
        report(0.5, 'another-job');
        for (const value of [NaN, Infinity, -1, 2]) report(value, jobId);
        for (const value of [0, 0.301, 0.3015, 0.2, 0.99, 1]) report(value, jobId);
        expect(onProgress.mock.calls.map(call => call[0])).toEqual([0, 30, 99, 100]);
        pending.resolve({worker:'eng', image:'first'}); await active;
        report(1, jobId); expect(onProgress).toHaveBeenCalledTimes(4);
        vi.mocked(worker.recognize).mockImplementation(async (image, _options, _output, nextJob) => {
            report(0.5, jobId); report(0.5, nextJob!); return {worker:'eng', image};
        });
        await runtime.recognize('next', 'eng');
        expect(onProgress).toHaveBeenCalledTimes(4);
    });

    it('取消中的 Worker 不能再发布百分比', async () => {
        const worker = createWorker('eng'); const pending = deferred<RecognitionResult>();
        vi.mocked(worker.recognize).mockReturnValueOnce(pending.promise);
        let report!: (value: number, jobId: string) => void;
        const runtime = createOcrWorkerRuntime({sparseTextMode:11,createWorker:async (_languages, notify)=>{report=notify;return worker;}});
        const controller = new AbortController(); const onProgress = vi.fn();
        const active = runtime.recognize('first','eng',controller.signal,undefined,onProgress);
        const rejected = expect(active).rejects.toMatchObject({name:'AbortError'});
        await vi.waitFor(()=>expect(worker.recognize).toHaveBeenCalledOnce());
        const jobId = vi.mocked(worker.recognize).mock.calls[0][3]!;
        report(0.1,jobId); controller.abort(); report(0.9,jobId);
        await rejected; report(1,jobId);
        expect(onProgress).toHaveBeenCalledOnce(); expect(onProgress).toHaveBeenCalledWith(10);
        pending.resolve({worker:'eng',image:'first'});
    });

    it('复用同语言 Worker 和稀疏文本参数，连续识别不重复跨 Worker 初始化', async () => {
        const worker = createWorker('eng');
        const factory = vi.fn(async () => worker);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});

        await expect(runtime.recognize('first', 'eng')).resolves.toEqual({worker: 'eng', image: 'first'});
        await expect(runtime.recognize('second', 'eng')).resolves.toEqual({worker: 'eng', image: 'second'});

        expect(factory).toHaveBeenCalledOnce();
        expect(worker.setParameters).toHaveBeenCalledOnce();
        expect(worker.setParameters).toHaveBeenLastCalledWith({
            tessedit_pageseg_mode: 11,
            preserve_interword_spaces: '1',
            debug_file: '/dev/null',
        });
        expect(worker.recognize).toHaveBeenLastCalledWith('second', {}, {blocks: true}, 'fluent-read-ocr-2');
    });

    it('等待正在进行的识别结束后才终止 Worker 并切换语言', async () => {
        const firstRecognition = deferred<RecognitionResult>();
        const english = createWorker('eng');
        const japanese = createWorker('jpn');
        vi.mocked(english.recognize).mockReturnValueOnce(firstRecognition.promise);
        const factory = vi.fn(async languages => languages === 'eng' ? english : japanese);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 'sparse'});

        const recognizing = runtime.recognize('active', 'eng');
        await vi.waitFor(() => expect(english.recognize).toHaveBeenCalledOnce());
        const switching = runtime.recognize('next', 'jpn');

        await Promise.resolve();
        expect(english.terminate).not.toHaveBeenCalled();
        expect(factory).toHaveBeenCalledTimes(1);

        firstRecognition.resolve({worker: 'eng', image: 'active'});
        await expect(recognizing).resolves.toEqual({worker: 'eng', image: 'active'});
        await expect(switching).resolves.toEqual({worker: 'jpn', image: 'next'});
        expect(english.terminate).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenLastCalledWith('jpn', expect.any(Function));
    });

    it('圈选单块重试和普通图片参数串行切换，同模式连续任务复用参数', async () => {
        const active = deferred<RecognitionResult>();
        const worker = createWorker('eng');
        vi.mocked(worker.recognize).mockReturnValueOnce(active.promise);
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        const first = runtime.recognize('image', 'eng');
        await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
        const area = runtime.recognize('area-retry', 'eng', undefined, 6);
        expect(worker.setParameters).toHaveBeenCalledTimes(1);
        active.resolve({worker: 'eng', image: 'image'});
        await first;
        await area;
        await runtime.recognize('area-next', 'eng', undefined, 6);
        expect(worker.setParameters).toHaveBeenCalledTimes(2);
        await runtime.recognize('normal-image', 'eng');
        expect(vi.mocked(worker.setParameters).mock.calls.map(([parameters]) => parameters.tessedit_pageseg_mode))
            .toEqual([11, 6, 11]);
        expect(worker.terminate).not.toHaveBeenCalled();
    });

    it('模式切换失败后重新应用原模式，避免部分设置污染后续图片识别', async () => {
        const worker = createWorker('eng');
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        await runtime.recognize('image', 'eng');
        vi.mocked(worker.setParameters).mockRejectedValueOnce(new Error('mode failed'));
        await expect(runtime.recognize('area', 'eng', undefined, 6)).rejects.toThrow('mode failed');
        await runtime.recognize('image-again', 'eng');
        expect(worker.setParameters).toHaveBeenCalledTimes(3);
        expect(worker.setParameters).toHaveBeenLastCalledWith({tessedit_pageseg_mode: 11, preserve_interword_spaces: '1', debug_file: '/dev/null'});
        expect(worker.recognize).toHaveBeenCalledTimes(2);
    });

    it('串行化同 Worker 的并发识别，防止参数与识别调用交叉', async () => {
        const firstRecognition = deferred<RecognitionResult>();
        const worker = createWorker('eng');
        vi.mocked(worker.recognize).mockReturnValueOnce(firstRecognition.promise);
        const runtime = createOcrWorkerRuntime({
            createWorker: vi.fn(async () => worker),
            sparseTextMode: 11,
        });

        const first = runtime.recognize('first', 'eng');
        await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
        const second = runtime.recognize('second', 'eng');
        await Promise.resolve();
        expect(worker.setParameters).toHaveBeenCalledOnce();

        firstRecognition.resolve({worker: 'eng', image: 'first'});
        await expect(first).resolves.toEqual({worker: 'eng', image: 'first'});
        await expect(second).resolves.toEqual({worker: 'eng', image: 'second'});
        expect(worker.setParameters).toHaveBeenCalledOnce();
    });

    it('下载语言包也等待识别结束，并忽略旧 Worker 的终止异常', async () => {
        const recognition = deferred<RecognitionResult>();
        const english = createWorker('eng');
        const packs = createWorker('packs');
        vi.mocked(english.recognize).mockReturnValueOnce(recognition.promise);
        vi.mocked(english.terminate).mockRejectedValueOnce(new Error('already closed'));
        const runtime = createOcrWorkerRuntime({
            createWorker: vi.fn(async languages => languages === 'eng' ? english : packs),
            sparseTextMode: 11,
        });

        const active = runtime.recognize('active', 'eng');
        await vi.waitFor(() => expect(english.recognize).toHaveBeenCalledOnce());
        const downloading = runtime.ensureLanguages(['chi_sim', 'eng']);
        expect(english.terminate).not.toHaveBeenCalled();

        recognition.resolve({worker: 'eng', image: 'active'});
        await active;
        await expect(downloading).resolves.toBeUndefined();
        expect(english.terminate).toHaveBeenCalledOnce();
    });

    it('空语言列表不创建 Worker', async () => {
        const factory = vi.fn(async () => createWorker('unused'));
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});

        await expect(runtime.ensureLanguages([])).resolves.toBeUndefined();
        expect(factory).not.toHaveBeenCalled();
    });

    it('拒绝分号或路径片段语言标识，避免生成 ./;.traineddata', async () => {
        const factory = vi.fn(async () => createWorker('invalid'));
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});

        await expect(runtime.ensureLanguages(['eng;chi_sim' as never])).rejects.toThrow('语言包配置无效');
        await expect(runtime.recognize('image', 'eng;chi_sim')).rejects.toThrow('语言包配置无效');
        expect(factory).not.toHaveBeenCalled();
    });

    it('规范化重复语言并保持稳定顺序，避免重复下载同一语言包', async () => {
        const worker = createWorker('eng+chi_sim');
        const factory = vi.fn(async (languages: string) => {
            expect(languages).toBe('eng+chi_sim');
            return worker;
        });
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});

        await runtime.ensureLanguages(['eng', 'eng', 'chi_sim']);
        expect(factory).toHaveBeenCalledOnce();
    });

    it('排队取消立即完成本地清理，且模型清除和后续识别仍按序执行', async () => {
        const activeResult = deferred<RecognitionResult>();
        const nextResult = deferred<RecognitionResult>();
        const removal = deferred<void>();
        const first = createWorker('first'); const next = createWorker('next');
        vi.mocked(first.recognize).mockReturnValueOnce(activeResult.promise);
        vi.mocked(next.recognize).mockReturnValueOnce(nextResult.promise);
        let report!: (value: number, jobId: string) => void;
        const factory = vi.fn().mockImplementationOnce(async (_language, notify) => {report = notify; return first;})
            .mockImplementationOnce(async (_language, notify) => {report = notify; return next;});
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        const firstProgress = vi.fn(); const cancelledProgress = vi.fn(); const nextProgress = vi.fn();
        const active = runtime.recognize('active', 'eng', undefined, undefined, firstProgress);
        void active.catch(() => undefined);
        try {
        await vi.waitFor(() => expect(first.recognize).toHaveBeenCalledOnce());
        const oldJob = vi.mocked(first.recognize).mock.calls[0][3]!;
        report(0.25, oldJob);
        const controller = new AbortController();
        const removed = vi.spyOn(controller.signal, 'removeEventListener');
        const stopped = runtime.recognize('discarded image', 'jpn', controller.signal, undefined, cancelledProgress);
        const rejected = expect(stopped).rejects.toMatchObject({name: 'AbortError'});
        const remove = vi.fn(() => removal.promise);
        const clearing = runtime.clearModels(remove);
        const fresh = runtime.recognize('fresh', 'eng', undefined, undefined, nextProgress);
        void clearing.catch(() => undefined); void fresh.catch(() => undefined);
        controller.abort(); await rejected;
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(first.terminate).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(factory).toHaveBeenCalledTimes(1);
        activeResult.resolve({worker: 'first', image: 'active'}); await active;
        await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
        expect(factory).toHaveBeenCalledTimes(1);
        removal.resolve(); await clearing;
        await vi.waitFor(() => expect(next.recognize).toHaveBeenCalledOnce());
        const nextJob = vi.mocked(next.recognize).mock.calls[0][3]!;
        report(0.9, oldJob); report(0.5, nextJob);
        expect(firstProgress).toHaveBeenCalledTimes(1);
        expect(cancelledProgress).not.toHaveBeenCalled();
        expect(nextProgress).toHaveBeenCalledOnce(); expect(nextProgress).toHaveBeenCalledWith(50);
        nextResult.resolve({worker: 'next', image: 'fresh'});
        await expect(fresh).resolves.toEqual({worker: 'next', image: 'fresh'});
        expect(first.terminate).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledTimes(2);
        } finally {
            activeResult.resolve({worker: 'first', image: 'active'});
            removal.resolve(); nextResult.resolve({worker: 'next', image: 'fresh'});
            runtime.dispose();
        }
    });

    it('排队请求立即取消，不终止仍在识别的 Worker，也不让后续请求插队', async () => {
        const recognition = deferred<RecognitionResult>();
        const worker = createWorker('active');
        vi.mocked(worker.recognize).mockReturnValueOnce(recognition.promise);
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        const active = runtime.recognize('first', 'eng');
        await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());

        const controller = new AbortController();
        const cancelled = runtime.recognize('cancelled', 'jpn', controller.signal);
        const last = runtime.recognize('last', 'eng');
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(worker.recognize).toHaveBeenCalledOnce();

        recognition.resolve({worker: 'active', image: 'first'});
        await active;
        await expect(last).resolves.toEqual({worker: 'active', image: 'last'});
        expect(worker.recognize).toHaveBeenCalledTimes(2);
        expect(worker.recognize).not.toHaveBeenCalledWith('cancelled', expect.anything(), expect.anything());
    });

    it('排队中的语言预下载取消不销毁活跃识别任务', async () => {
        const recognition = deferred<RecognitionResult>();
        const worker = createWorker('eng');
        vi.mocked(worker.recognize).mockReturnValueOnce(recognition.promise);
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        const active = runtime.recognize('first', 'eng');
        await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalledOnce());
        const controller = new AbortController();
        const download = runtime.ensureLanguages(['jpn'], controller.signal);
        controller.abort();

        await expect(download).rejects.toMatchObject({name: 'AbortError'});
        expect(worker.terminate).not.toHaveBeenCalled();
        recognition.resolve({worker: 'eng', image: 'first'});
        await active;
        await runtime.recognize('last', 'eng');
        expect(worker.setParameters).toHaveBeenCalledOnce();
    });

    it('参数设置失败可重试，只有成功初始化才会复用参数', async () => {
        const worker = createWorker('eng');
        vi.mocked(worker.setParameters).mockRejectedValueOnce(new Error('setup failed'));
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        await expect(runtime.recognize('failed', 'eng')).rejects.toThrow('setup failed');
        await runtime.recognize('retry', 'eng');
        await runtime.recognize('again', 'eng');
        expect(worker.setParameters).toHaveBeenCalledTimes(2);
        expect(worker.recognize).toHaveBeenCalledTimes(2);
    });

    it('取消挂起的参数初始化会释放旧 Worker，新请求重新初始化', async () => {
        const parameters = deferred<unknown>();
        const first = createWorker('first');
        const next = createWorker('next');
        vi.mocked(first.setParameters).mockReturnValueOnce(parameters.promise);
        const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        const controller = new AbortController();
        const pending = runtime.recognize('cancelled', 'eng', controller.signal);
        await vi.waitFor(() => expect(first.setParameters).toHaveBeenCalledOnce());
        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await runtime.recognize('retry', 'eng');
        parameters.resolve(undefined);
        expect(first.recognize).not.toHaveBeenCalled();
        expect(next.setParameters).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(first.terminate).toHaveBeenCalledOnce());
    });

    it('创建失败后清理状态，后续请求可以重试', async () => {
        const worker = createWorker('eng');
        const factory = vi.fn()
            .mockRejectedValueOnce(new Error('download failed'))
            .mockResolvedValueOnce(worker);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});

        await expect(runtime.recognize('first', 'eng')).rejects.toThrow('download failed');
        await expect(runtime.recognize('retry', 'eng')).resolves.toEqual({worker: 'eng', image: 'retry'});
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it('上一项识别失败后仍执行队列中的下一项', async () => {
        const worker = createWorker('eng');
        vi.mocked(worker.recognize)
            .mockRejectedValueOnce(new Error('recognize failed'))
            .mockResolvedValueOnce({worker: 'eng', image: 'second'});
        const runtime = createOcrWorkerRuntime({
            createWorker: vi.fn(async () => worker),
            sparseTextMode: 11,
        });

        const first = runtime.recognize('first', 'eng');
        const second = runtime.recognize('second', 'eng');
        await expect(first).rejects.toThrow('recognize failed');
        await expect(second).resolves.toEqual({worker: 'eng', image: 'second'});
    });

    it('连续失败后队列仍依次执行，识别和参数不会交叉', async () => {
        const worker = createWorker('eng');
        vi.mocked(worker.recognize).mockRejectedValueOnce(new Error('first failure'))
            .mockRejectedValueOnce(new Error('second failure'))
            .mockResolvedValueOnce({worker: 'eng', image: 'third'});
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        const first = runtime.recognize('first', 'eng');
        const second = runtime.recognize('second', 'eng');
        const third = runtime.recognize('third', 'eng');
        const failure1 = expect(first).rejects.toThrow('first failure');
        const failure2 = expect(second).rejects.toThrow('second failure');
        await Promise.all([failure1, failure2]);
        await expect(third).resolves.toEqual({worker: 'eng', image: 'third'});
        expect(vi.mocked(worker.recognize).mock.calls.map(call => call[0])).toEqual(['first', 'second', 'third']);
        expect(worker.setParameters).toHaveBeenCalledOnce();
        runtime.dispose();
    });

    it('取得串行槽后、启动微任务前取消，后续任务仍可运行', async () => {
        const worker = createWorker('eng');
        const factory = vi.fn(async () => worker);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        const controller = new AbortController();
        const aborted = runtime.recognize('cancelled', 'eng', controller.signal);
        controller.abort();
        await expect(aborted).rejects.toMatchObject({name: 'AbortError'});
        expect(factory).not.toHaveBeenCalled();
        await expect(runtime.recognize('next', 'eng')).resolves.toEqual({worker: 'eng', image: 'next'});
        runtime.dispose();
    });

    it('取消永不结束的识别会终止旧 Worker，并允许下一请求使用新 Worker', async () => {
        const never = deferred<RecognitionResult>();
        const stuckWorker = createWorker('stuck');
        const recoveredWorker = createWorker('recovered');
        vi.mocked(stuckWorker.recognize).mockReturnValueOnce(never.promise);
        const factory = vi.fn()
            .mockResolvedValueOnce(stuckWorker)
            .mockResolvedValueOnce(recoveredWorker);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        const controller = new AbortController();

        const stuck = runtime.recognize('first', 'eng', controller.signal);
        await vi.waitFor(() => expect(stuckWorker.recognize).toHaveBeenCalledOnce());
        controller.abort();

        await expect(stuck).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(stuckWorker.terminate).toHaveBeenCalledOnce());
        await expect(runtime.recognize('second', 'eng')).resolves.toEqual({
            worker: 'recovered',
            image: 'second',
        });
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it('预取消的识别与语言准备不会创建 Worker', async () => {
        const factory = vi.fn(async () => createWorker('unused'));
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        const controller = new AbortController();
        controller.abort();

        await expect(runtime.recognize('image', 'eng', controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        await expect(runtime.ensureLanguages(['eng'], controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(factory).not.toHaveBeenCalled();
    });

    it('Worker 创建期间发生取消时命中 runAbortable 入口并终止刚创建的 Worker', async () => {
        const worker = createWorker('creating');
        const controller = new AbortController();
        const runtime = createOcrWorkerRuntime({
            createWorker: vi.fn(() => {
                controller.abort();
                return Promise.resolve(worker);
            }),
            sparseTextMode: 11,
        });

        await expect(runtime.recognize('image', 'eng', controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    });

    it('取消语言切换时不让迟到的 getWorker 覆盖新 Worker 所有权', async () => {
        const oldTermination = deferred<unknown>();
        const nextCreation = deferred<OcrWorkerPort<RecognitionResult>>();
        const nextRecognition = deferred<RecognitionResult>();
        const staleCreation = deferred<OcrWorkerPort<RecognitionResult>>();
        const initialWorker = createWorker('initial');
        const nextWorker = createWorker('next');
        const staleWorker = createWorker('stale');
        vi.mocked(initialWorker.terminate).mockReturnValue(oldTermination.promise);
        vi.mocked(nextWorker.recognize).mockReturnValue(nextRecognition.promise);
        const factory = vi.fn((languages: string) => {
            if (languages === 'eng') return Promise.resolve(initialWorker);
            if (languages === 'fra') return nextCreation.promise;
            return staleCreation.promise;
        });
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});

        await runtime.recognize('seed', 'eng');
        const switchingController = new AbortController();
        const switching = runtime.recognize('switching', 'jpn', switchingController.signal);
        await vi.waitFor(() => expect(initialWorker.terminate).toHaveBeenCalledOnce());

        switchingController.abort();
        await expect(switching).rejects.toMatchObject({name: 'AbortError'});

        const nextController = new AbortController();
        const next = runtime.recognize('next', 'fra', nextController.signal);
        await vi.waitFor(() => expect(factory).toHaveBeenCalledWith('fra', expect.any(Function)));

        oldTermination.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();
        nextCreation.resolve(nextWorker);
        await vi.waitFor(() => expect(nextWorker.recognize).toHaveBeenCalledOnce());

        nextController.abort();
        await expect(next).rejects.toMatchObject({name: 'AbortError'});
        staleCreation.resolve(staleWorker);
        nextRecognition.resolve({worker: 'next', image: 'late'});
        await Promise.resolve();
        await Promise.resolve();

        expect(factory).not.toHaveBeenCalledWith('jpn', expect.any(Function));
        await vi.waitFor(() => expect(nextWorker.terminate).toHaveBeenCalledOnce());
        expect(staleWorker.terminate).not.toHaveBeenCalled();
    });

    it('操作已完成后忽略迟到的自定义 abort 回调', async () => {
        const worker = createWorker('settled');
        let abortListener: (() => void) | undefined;
        const signal = {
            aborted: false,
            addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
                abortListener = typeof listener === 'function'
                    ? () => listener(new Event('abort'))
                    : () => listener.handleEvent(new Event('abort'));
            },
            removeEventListener: vi.fn(),
        } as unknown as AbortSignal;
        const runtime = createOcrWorkerRuntime({
            createWorker: vi.fn(async () => worker),
            sparseTextMode: 11,
        });

        await expect(runtime.recognize('image', 'eng', signal))
            .resolves.toEqual({worker: 'settled', image: 'image'});
        abortListener?.();
        expect(worker.terminate).not.toHaveBeenCalled();
    });
});

it('模型清除等待识别结束、释放 Worker，失败后仍可重新创建', async () => {
 const worker=createWorker('eng'); const pending=deferred<RecognitionResult>();
 vi.mocked(worker.recognize).mockReturnValueOnce(pending.promise);
 const factory=vi.fn(async()=>worker); const runtime=createOcrWorkerRuntime({createWorker:factory,sparseTextMode:11});
 const active=runtime.recognize('active','eng'); await vi.waitFor(()=>expect(worker.recognize).toHaveBeenCalled());
 const remove=vi.fn(async()=>{}); const clearing=runtime.clearModels(remove);
 expect(remove).not.toHaveBeenCalled(); pending.resolve({worker:'eng',image:'active'}); await active; await clearing;
 expect(worker.terminate).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce();
 await runtime.clearModels(remove); await runtime.recognize('again','eng'); expect(factory).toHaveBeenCalledTimes(2);
 await expect(runtime.clearModels(async()=>{throw new Error('disk')})).rejects.toThrow('disk');
 await runtime.recognize('recover','eng'); expect(factory).toHaveBeenCalledTimes(3);
});

describe('OCR 模型有界驻留与页面销毁', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('navigator', {deviceMemory: 8});
    });
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each([[4, 60_000], [8, 180_000], [undefined, 120_000]])('设备内存 %s GB：短暂停顿复用，完整空闲 %s 毫秒后释放并可重新加载', async (memory, idleMs) => {
        vi.stubGlobal('navigator', {deviceMemory: memory});
        const worker = createWorker('warm');
        const factory = vi.fn(async () => worker);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        await runtime.recognize('first', 'eng');
        await vi.advanceTimersByTimeAsync(idleMs! - 1);
        expect(worker.terminate).not.toHaveBeenCalled();
        await runtime.recognize('again', 'eng');
        await vi.advanceTimersByTimeAsync(idleMs! - 1);
        expect(worker.terminate).not.toHaveBeenCalled();
        expect(factory).toHaveBeenCalledOnce();
        expect(worker.setParameters).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(worker.terminate).toHaveBeenCalledOnce();
        await runtime.recognize('cold', 'eng');
        expect(factory).toHaveBeenCalledTimes(2);
        expect(worker.setParameters).toHaveBeenCalledTimes(2);
        runtime.dispose(); runtime.dispose();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(worker.terminate).toHaveBeenCalledTimes(2);
    });

    it('准备与复核已加载语言都延续暖驻期限，预下载不会无限保留内存', async () => {
        const worker = createWorker('prepared');
        const factory = vi.fn(async () => worker);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        await runtime.ensureLanguages(['eng']);
        await vi.advanceTimersByTimeAsync(179_999);
        await runtime.ensureLanguages(['eng']);
        expect(factory).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(179_999);
        expect(worker.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it('迟到的旧空闲回调不能终止已开始的识别或覆盖新暖驻计时器', async () => {
        const worker = createWorker('active');
        const timer = vi.spyOn(globalThis, 'setTimeout');
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        await runtime.recognize('first', 'eng');
        const oldIdle = timer.mock.calls[0][0] as () => void;
        const recognition = deferred<RecognitionResult>();
        vi.mocked(worker.recognize).mockReturnValueOnce(recognition.promise);
        const active = runtime.recognize('active', 'eng');
        await vi.advanceTimersByTimeAsync(0);
        oldIdle();
        expect(worker.terminate).not.toHaveBeenCalled();
        recognition.resolve({worker: 'active', image: 'active'}); await active;
        oldIdle();
        expect(worker.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(worker.terminate).toHaveBeenCalledOnce();
        timer.mockRestore();
    });

    it('识别、排队和模型校验期间不按空闲时间释放，最后一项完成才开始暖驻', async () => {
        const worker = createWorker('active');
        const creation = deferred<OcrWorkerPort<RecognitionResult>>();
        const recognition = deferred<RecognitionResult>();
        vi.mocked(worker.recognize).mockReturnValueOnce(recognition.promise);
        const factory = vi.fn(() => creation.promise);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        const preparing = runtime.ensureLanguages(['eng']);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(worker.terminate).not.toHaveBeenCalled();
        creation.resolve(worker); await preparing;
        await vi.advanceTimersByTimeAsync(179_999);
        const active = runtime.recognize('active', 'eng');
        const queued = runtime.recognize('queued', 'eng');
        const checking = runtime.ensureLanguages(['eng']);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(worker.recognize).toHaveBeenCalledOnce();
        expect(worker.terminate).not.toHaveBeenCalled();
        recognition.resolve({worker: 'active', image: 'active'});
        await Promise.all([active, queued, checking]);
        expect(factory).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(179_999);
        expect(worker.terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it('显式销毁立即取消无外部 signal 的挂起识别及旧队列，不允许迟到结果复活 Worker', async () => {
        const worker = createWorker('closing');
        const recognition = deferred<RecognitionResult>();
        vi.mocked(worker.recognize).mockReturnValueOnce(recognition.promise);
        const factory = vi.fn(async () => worker);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        const active = runtime.recognize('active', 'eng');
        await vi.advanceTimersByTimeAsync(0);
        expect(worker.recognize).toHaveBeenCalledOnce();
        const queued = runtime.recognize('queued', 'jpn');
        const preparing = runtime.ensureLanguages(['fra']);
        const remove = vi.fn(async () => {});
        const clearing = runtime.clearModels(remove);
        const rejections = [active, queued, preparing, clearing].map(operation => expect(operation).rejects.toMatchObject({name: 'AbortError'}));
        runtime.dispose();
        await Promise.all(rejections);
        await expect(runtime.recognize('after-close', 'eng')).rejects.toMatchObject({name: 'AbortError'});
        await expect(runtime.ensureLanguages(['eng'])).rejects.toMatchObject({name: 'AbortError'});
        await expect(runtime.clearModels(remove)).rejects.toMatchObject({name: 'AbortError'});
        recognition.resolve({worker: 'closing', image: 'late'});
        await vi.advanceTimersByTimeAsync(300_000);
        expect(remove).not.toHaveBeenCalled();
        expect(factory).toHaveBeenCalledOnce();
        expect(worker.recognize).toHaveBeenCalledOnce();
        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it('销毁尚在加载的模型时立即结束等待，迟到创建只会被释放，不执行参数或识别', async () => {
        const worker = createWorker('late');
        const creation = deferred<OcrWorkerPort<RecognitionResult>>();
        const factory = vi.fn(() => creation.promise);
        const runtime = createOcrWorkerRuntime({createWorker: factory, sparseTextMode: 11});
        const pending = runtime.ensureLanguages(['eng']);
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(0);
        expect(factory).toHaveBeenCalledOnce();
        runtime.dispose(); await rejected;
        creation.resolve(worker);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.setParameters).not.toHaveBeenCalled();
        expect(worker.recognize).not.toHaveBeenCalled();
    });

    it('销毁清理队列时不等待底层终止完成，也不在迟到终止后继续删除模型', async () => {
        const worker = createWorker('removing');
        const termination = deferred<unknown>();
        const runtime = createOcrWorkerRuntime({createWorker: async () => worker, sparseTextMode: 11});
        await runtime.ensureLanguages(['eng']);
        vi.mocked(worker.terminate).mockReturnValueOnce(termination.promise);
        const remove = vi.fn(async () => {});
        const pending = runtime.clearModels(remove);
        const rejected = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(0);
        expect(worker.terminate).toHaveBeenCalledOnce();
        runtime.dispose(); await rejected;
        termination.resolve(undefined);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(remove).not.toHaveBeenCalled();
        expect(worker.terminate).toHaveBeenCalledOnce();
    });
});

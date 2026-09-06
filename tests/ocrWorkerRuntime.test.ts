import {describe, expect, it, vi} from 'vitest';
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
        });
        expect(worker.recognize).toHaveBeenLastCalledWith('second', {}, {blocks: true});
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
        expect(factory).toHaveBeenLastCalledWith('jpn');
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
        expect(worker.setParameters).toHaveBeenLastCalledWith({tessedit_pageseg_mode: 11, preserve_interword_spaces: '1'});
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
        await vi.waitFor(() => expect(factory).toHaveBeenCalledWith('fra'));

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

        expect(factory).not.toHaveBeenCalledWith('jpn');
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

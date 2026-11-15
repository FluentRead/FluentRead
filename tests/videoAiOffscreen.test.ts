import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
const budgetMocks = vi.hoisted(() => ({run: vi.fn()}));
vi.mock('@/src/shared/onnx/resources', async original => ({
    ...await original<typeof import('@/src/shared/onnx/resources')>(),
    withLocalInferenceBudget: budgetMocks.run,
}));
import {createLocalInferenceBudget} from '@/src/shared/onnx/resources';
import * as modelCache from '@/src/features/video-subtitle/offscreen/modelCache';
import {removeLocalVideoTranscriptionModel, cancelLocalVideoTranscription, prepareLocalVideoTranscriptionModel, transcribeLocalVideoAudio} from '@/src/features/video-subtitle/offscreen/transcription';
import {sharedDirectoryFixture} from './helpers/sharedVideoModelDirectory';
import {moveVideoAiModelToSharedDirectory, getVideoAiModelFileUrl, VIDEO_AI_Q4_MODEL_FILES} from '@/src/features/video-subtitle/offscreen/modelCache';

class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    messages: any[] = [];
    constructor() { FakeWorker.instances.push(this); }
    postMessage(message: any, transfer: Transferable[] = []): void {
        (this as any).lastMessage = transfer.length
            ? structuredClone(message, {transfer})
            : structuredClone(message);
        this.messages.push((this as any).lastMessage);
    }
    terminate(): void { this.terminated = true; }
    reply(response: Record<string, unknown>): void { this.onmessage?.({data: response} as MessageEvent); }
    fail(message = 'worker failed'): void { this.onerror?.({message} as ErrorEvent); }
}

it.each(['tiny', 'base'] as const)('serializes shared migration with inference and releases the loaded %s worker only when needed', async loaded => {
    const f = sharedDirectoryFixture(); f.setStored(f.handle); installWorker();
    const moveLocalVideoTranscriptionModelToShared = (model: unknown) => moveVideoAiModelToSharedDirectory(model, undefined, removeLocalVideoTranscriptionModel);
    const local = new Map(VIDEO_AI_Q4_MODEL_FILES.map(file => [getVideoAiModelFileUrl('tiny', file), 'local bytes']));
    vi.stubGlobal('caches', {open: async () => ({
        keys: async () => [...local.keys()].map(url => new Request(url)),
        match: async (url: string) => local.has(url) ? new Response(local.get(url)) : undefined,
        delete: async (request: Request) => local.delete(request.url),
    })});
    const pending = transcribeLocalVideoAudio({streamId: 'shared-migration', audioPcm16Base64: 'AAAAAA==', model: loaded});
    await drain();
    await expect(moveLocalVideoTranscriptionModelToShared('tiny')).rejects.toThrow('正在使用');
    const worker = FakeWorker.instances.at(-1)!;
    worker.reply({requestId: (worker as any).lastMessage.requestId, success: true, model: loaded, text: 'ready', segments: []});
    await pending;
    const migrating = moveLocalVideoTranscriptionModelToShared('tiny');
    await migrating;
    expect(local.size).toBe(0); expect(worker.terminated).toBe(loaded === 'tiny');
    await expect(moveLocalVideoTranscriptionModelToShared('tiny')).rejects.toThrow('不完整');
    await cancelLocalVideoTranscription('shared-migration');
});

beforeEach(() => {
    // 保留真实预算的排队和释放语义，用单槽位模拟其他本地推理占满共享预算。
    budgetMocks.run.mockReset().mockImplementation(createLocalInferenceBudget(1));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
    FakeWorker.instances = [];
});

function installWorker(): void {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {location: {href: 'chrome-extension://test/offscreen.html'}, setTimeout, clearTimeout});
    vi.stubGlobal('navigator', {});
}
const audio = 'AAAAAA==';
const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const drain = async (): Promise<void> => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {resolve = done;});
    return {promise, resolve};
};

function requestVideoWorker(kind: 'transcribe' | 'prepare', streamId: string, model: 'tiny' | 'base' = 'tiny') {
    return kind === 'transcribe'
        ? transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model})
        : prepareLocalVideoTranscriptionModel(model, {keepWarm: true, streamId});
}

function completeWorker(worker: FakeWorker, model: 'tiny' | 'base' | 'small' = 'tiny'): void {
    worker.reply({requestId: worker.messages.at(-1).requestId, success: true, text: 'budget result', segments: [], model, backend: 'wasm'});
}

describe('video AI offscreen queue', () => {
    it('keeps completion from discarding a queued warm preparation, then cancels only that queued stream', async () => {
        vi.useFakeTimers();installWorker();const download=deferred();
        const cache=vi.spyOn(modelCache,'cacheVideoAiQ4ModelFiles').mockReturnValueOnce(download.promise);
        try {
            const storing=prepareLocalVideoTranscriptionModel('tiny');await drain();
            const other=prepareLocalVideoTranscriptionModel('small',{keepWarm:true,streamId:'queued-other'});
            const pending=prepareLocalVideoTranscriptionModel('base',{keepWarm:true,streamId:'queued-target'}),failed=expect(pending).rejects.toThrow('已取消');
            await cancelLocalVideoTranscription('queued-target','complete');await drain();expect(FakeWorker.instances).toHaveLength(0);
            await cancelLocalVideoTranscription('queued-target');await failed;
            download.resolve();await storing;await drain();const worker=FakeWorker.instances[0];
            expect(worker.messages[0]).toMatchObject({type:'prepare',model:'small'});completeWorker(worker,'small');await other;
            await cancelLocalVideoTranscription('queued-other');expect(vi.getTimerCount()).toBe(0);
        } finally {download.resolve();cache.mockRestore();}
    });
    it.each([[0, 'cancel-before-resolve'], [16, 'cancel-before-resolve'], [0, 'resolve-then-cancel'], [16, 'resolve-then-cancel']] as const)('rejects a cancelled legacy decode with %i samples / %s without reading channels or settling a restarted stream', async (sampleCount, order) => {
        vi.useFakeTimers(); installWorker();
        let finishDecode!: (value: {numberOfChannels: number; sampleRate: number; getChannelData(): Float32Array}) => void;
        const decoded = new Promise<{numberOfChannels: number; sampleRate: number; getChannelData(): Float32Array}>(resolve => {finishDecode = resolve;});
        const close = vi.fn(async () => {if(sampleCount===16)throw new Error('native decoder already closed');}), decodeAudioData = vi.fn(() => decoded);
        vi.stubGlobal('window', {location: {href: 'chrome-extension://test/offscreen.html'}, setTimeout, clearTimeout,
            AudioContext: class {state = 'running'; close = close; decodeAudioData = decodeAudioData;}});
        const streamId = 'cancelled-legacy-decoder';
        const first = transcribeLocalVideoAudio({streamId, audioBase64: audio, model: 'tiny'});
        const rejected = expect(first).rejects.toThrow('本地视频 AI 字幕已取消');
        await drain(); expect(decodeAudioData).toHaveBeenCalledOnce();
        const getChannelData = vi.fn(() => new Float32Array(sampleCount));
        const result = {numberOfChannels: 1, sampleRate: 16_000, getChannelData};
        if (order === 'resolve-then-cancel') finishDecode(result);
        await cancelLocalVideoTranscription(streamId); expect(close).toHaveBeenCalledOnce();
        const next = transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model: 'tiny'});
        if (order === 'cancel-before-resolve') finishDecode(result);
        await rejected; await drain();
        expect(FakeWorker.instances).toHaveLength(1);
        const worker = FakeWorker.instances[0];
        expect(worker.messages).toHaveLength(1);
        // 合法旧 Worker 可省略可选片段与模型；文本仍必须经过真实 parser。
        worker.reply({requestId: worker.messages[0].requestId, success: true, text: 'new stream'});
        await expect(next).resolves.toMatchObject({text: 'new stream', segments: [], model: 'tiny'});
        await cancelLocalVideoTranscription(streamId); expect(vi.getTimerCount()).toBe(0);
        expect(getChannelData).not.toHaveBeenCalled();
    });
    it.each([0, 16])('keeps the caller cancellation guard when legacy %i-sample decode completes just before cancellation', async sampleCount => {
        vi.useFakeTimers(); installWorker();
        const streamId = 'cancel-between-decode-and-caller';
        let cancellation!: Promise<void>;
        const getChannelData = vi.fn(() => {
            // 解码本身仍归当前流；在它返回之后、调用方的 await continuation 之前取消。
            queueMicrotask(() => {cancellation = cancelLocalVideoTranscription(streamId);});
            return new Float32Array(sampleCount);
        });
        const close = vi.fn(async () => undefined);
        vi.stubGlobal('window', {location: {href: 'chrome-extension://test/offscreen.html'}, setTimeout, clearTimeout,
            AudioContext: class {state = 'running'; close = close;
                decodeAudioData = async () => ({numberOfChannels: 1, sampleRate: 16_000, getChannelData});}});
        await expect(transcribeLocalVideoAudio({streamId, audioBase64: audio, model: 'tiny'}))
            .rejects.toThrow('本地视频 AI 字幕已取消');
        await cancellation; await drain();
        expect(getChannelData).toHaveBeenCalledOnce();
        expect(FakeWorker.instances).toHaveLength(0); expect(close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a malformed correlated result without CPU retry and keeps unrelated or late replies from settling the next request', async () => {
        vi.useFakeTimers(); installWorker();
        const streamId = 'typed-worker-reply';
        const first = transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model: 'tiny'});
        const rejected = expect(first).rejects.toThrow('消息格式无效');
        await drain();
        const worker = FakeWorker.instances[0], firstId = worker.messages.at(-1).requestId;
        worker.reply({requestId: firstId, success: true, text: null, retryWithCpu: true});
        await rejected; await drain();
        expect(FakeWorker.instances).toHaveLength(1); expect(worker.terminated).toBe(false);
        const next = transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model: 'tiny'});
        let settled = false; void next.then(() => {settled = true;});
        await drain();
        for (const requestId of ['invalid', 0, firstId, worker.messages.at(-1).requestId + 1])
            worker.reply({requestId, success: true, text: 'stale'});
        await drain(); expect(settled).toBe(false);
        completeWorker(worker); await expect(next).resolves.toMatchObject({text: 'budget result'});
        await cancelLocalVideoTranscription(streamId); expect(vi.getTimerCount()).toBe(0);
    });
    it.each([
        [4, 60_000], [8, 180_000], [undefined, 120_000],
    ])('设备内存%s时跨越30秒复用Whisper，并在%s毫秒连续空闲后回收', async (memory, idleMs) => {
        vi.useFakeTimers();installWorker();vi.stubGlobal('navigator', {deviceMemory: memory});
        const streamId = 'adaptive-video-idle';
        const first = transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model: 'tiny'});
        await drain();
        const worker = FakeWorker.instances[0];
        completeWorker(worker);await first;await drain();
        await vi.advanceTimersByTimeAsync(40_000);
        expect(worker.terminated).toBe(false);
        const next = transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model: 'tiny'});
        await drain();
        expect(FakeWorker.instances).toHaveLength(1);
        expect(worker.messages).toHaveLength(2);
        completeWorker(worker);await next;await drain();
        await vi.advanceTimersByTimeAsync(idleMs - 1);
        expect(worker.terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(worker.terminated).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        await cancelLocalVideoTranscription(streamId);
    });

    it.each([
        ['official', 'huggingface.co'], ['mirror', 'modelscope.cn'], ['arbitrary-url', 'modelscope.cn'],
    ])('cache preparation keeps preference %s through the queue and reuses every other cached file', async (preference, host) => {
        vi.useFakeTimers(); installWorker();
        vi.stubGlobal('navigator', {language: 'zh-CN'});
        const put = vi.fn(async (_url: string, response: Response) => {await response.arrayBuffer();});
        vi.stubGlobal('caches', {open: async () => ({match: async (url: string) => url.endsWith('/config.json') ? undefined : new Response(null), put})});
        const fetcher = vi.fn(async (_url: string) => new Response('{}', {headers: {'Content-Length': '2', 'Content-Type': 'application/json'}}));
        vi.stubGlobal('fetch', fetcher);
        const reports: import('@/src/core/download/progress').DownloadProgress[] = [];
        await expect(prepareLocalVideoTranscriptionModel('small', {preference, onProgress: progress => reports.push(progress)})).resolves.toMatchObject({model: 'small', dtype: 'q4'});
        await drain();
        expect(fetcher).toHaveBeenCalledOnce();
        expect(new URL(fetcher.mock.calls[0][0]).hostname).toBe(host);
        expect(put).toHaveBeenCalledOnce();
        expect(put.mock.calls[0][0]).toBe('https://modelscope.cn/models/onnx-community/whisper-small/resolve/master/config.json');
        expect(reports.some(progress => progress.transfer?.state === 'connecting')).toBe(true);
        expect(reports.some(progress => progress.transfer?.state === 'receiving')).toBe(true);
    });
    it('Small automatic recognition survives a 76.55-second first attempt without a duplicate Worker', async () => {
        vi.useFakeTimers();installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 'small-long-first', audioPcm16Base64: audio, model: 'small'});
        await drain();
        const worker = FakeWorker.instances[0];
        await vi.advanceTimersByTimeAsync(76_551);
        expect(FakeWorker.instances).toHaveLength(1);
        expect(worker.terminated).toBe(false);
        completeWorker(worker, 'small');
        await expect(pending).resolves.toMatchObject({model: 'small'});
        await cancelLocalVideoTranscription('small-long-first');
    });
    it('Small remains bounded to one 90-second primary and one remaining CPU retry', async () => {
        vi.useFakeTimers();installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 'small-total-budget', audioPcm16Base64: audio, model: 'small'});
        const checked = expect(pending).rejects.toThrow('超过 90 秒');
        await drain();
        await vi.advanceTimersByTimeAsync(90_000);
        expect(FakeWorker.instances).toHaveLength(2);
        expect(FakeWorker.instances[0].terminated).toBe(true);
        expect(FakeWorker.instances[1].messages[0].device).toBe('wasm');
        await vi.advanceTimersByTimeAsync(90_000);
        await checked;
        expect(FakeWorker.instances[1].terminated).toBe(true);
        await cancelLocalVideoTranscription('small-total-budget');
    });
    it('Small prepare survives the previous two-minute bound and its loaded Worker can be deleted', async () => {
        vi.useFakeTimers();installWorker();
        const preparing = prepareLocalVideoTranscriptionModel('small', {keepWarm: true, streamId: 'small-warm'});
        await drain();
        const worker = FakeWorker.instances[0];
        expect(worker.messages[0]).toMatchObject({model: 'small', type: 'prepare'});
        await vi.advanceTimersByTimeAsync(120_001);
        expect(worker.terminated).toBe(false);
        expect(FakeWorker.instances).toHaveLength(1);
        worker.reply({requestId: worker.messages.at(-1).requestId, success: true, model: 'small', backend: 'wasm', dtype: 'q4', encoderDtype: 'fp32', decoderDtype: 'q4'});
        await expect(preparing).resolves.toMatchObject({model: 'small', encoderDtype: 'fp32', decoderDtype: 'q4'});await drain();
        vi.stubGlobal('caches', {open: async () => ({keys: async () => []})});
        await removeLocalVideoTranscriptionModel('small');
        expect(worker.terminated).toBe(true);
        await cancelLocalVideoTranscription('small-warm');
    });
    it('reuses one worker and resolves a successful transcription', async () => {
        installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 's', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        expect(FakeWorker.instances).toHaveLength(1);
        const worker = FakeWorker.instances[0];
        expect((worker as any).lastMessage.languageSessionKey).toBe('s');
        const requestId = (worker as any).lastMessage.requestId;
        worker.reply({requestId, success: true, text: 'hello', segments: [{startMs: 0, endMs: 500, text: 'hello'}], model: 'tiny', inferenceMs: 10,
            detectedLanguage: 'ja', languageConfidence: .82, languageDetectionMs: 3, encoderReuse: true});
        await expect(pending).resolves.toMatchObject({text: 'hello', model: 'tiny',
            detectedLanguage: 'ja', languageConfidence: .82, languageDetectionMs: 3, encoderReuse: true});
        const second = transcribeLocalVideoAudio({streamId: 's', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        expect(FakeWorker.instances).toHaveLength(1);
        FakeWorker.instances[0].reply({requestId: (FakeWorker.instances[0] as any).lastMessage.requestId, success: true, text: '', segments: [], model: 'tiny'});
        await expect(second).resolves.not.toHaveProperty('detectedLanguage');
        await cancelLocalVideoTranscription('s');
    });
    it('cancel rejects active work and terminates only the worker', async () => {
        installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 'cancel-me', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        await cancelLocalVideoTranscription('cancel-me');
        await expect(pending).rejects.toThrow('取消');
        expect(FakeWorker.instances[0].terminated).toBe(true);
    });
    it('new pending work replaces stale pending work with skipped result', async () => {
        installWorker();
        const first = transcribeLocalVideoAudio({streamId: 'queue', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        const second = transcribeLocalVideoAudio({streamId: 'queue', audioPcm16Base64: audio, model: 'tiny'});
        const third = transcribeLocalVideoAudio({streamId: 'queue', audioPcm16Base64: audio, model: 'tiny'});
        await expect(second).resolves.toMatchObject({skipped: true});
        await cancelLocalVideoTranscription('queue');
        await expect(first).rejects.toThrow('取消');
        await expect(third).resolves.toMatchObject({skipped: true});
    });
    it('rejects another stream while one stream is active', async () => {
        installWorker();
        const first = transcribeLocalVideoAudio({streamId: 'one', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        await expect(transcribeLocalVideoAudio({streamId: 'two', audioPcm16Base64: audio, model: 'tiny'})).rejects.toThrow('另一个标签页');
        await cancelLocalVideoTranscription('one');
        await expect(first).rejects.toThrow('取消');
    });
    it('deduplicates prepare requests by model and stream', async () => {
        installWorker();
        const first = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'warm'});
        const second = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'warm'});
        await tick();
        expect(first).toBe(second);
        const worker = FakeWorker.instances[0];
        worker.reply({requestId: (worker as any).lastMessage.requestId, success: true, model: 'tiny', backend: 'wasm', dtype: 'q4'});
        await expect(first).resolves.toMatchObject({model: 'tiny', backend: 'wasm'});
        await cancelLocalVideoTranscription('warm');
    });

    it('rebuilds a WASM worker once after a worker failure and ignores the stale worker error', async () => {
        installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 'fallback', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        const first = FakeWorker.instances[0];
        first.fail('GPU worker failed');
        await tick();
        expect(FakeWorker.instances).toHaveLength(2);
        const replacement = FakeWorker.instances[1];
        expect((replacement as any).lastMessage.device).toBe('wasm');
        expect((replacement as any).lastMessage.audio.byteLength).toBeGreaterThan(0);
        first.fail('late stale error');
        replacement.reply({requestId: (replacement as any).lastMessage.requestId, success: true, text: 'cpu', segments: [], model: 'tiny', backend: 'wasm'});
        await expect(pending).resolves.toMatchObject({text: 'cpu', backend: 'wasm'});
        expect(replacement.terminated).toBe(false);
        await cancelLocalVideoTranscription('fallback');
    });

    it('reserves the remaining request budget for one WASM retry after timeout', async () => {
        vi.useFakeTimers();
        installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 'timeout-fallback', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        vi.advanceTimersByTime(16_001);
        await tick();
        expect(FakeWorker.instances).toHaveLength(2);
        const replacement = FakeWorker.instances[1];
        expect((replacement as any).lastMessage.device).toBe('wasm');
        replacement.reply({requestId: (replacement as any).lastMessage.requestId, success: true, text: 'cpu-timeout', segments: [], model: 'tiny'});
        await expect(pending).resolves.toMatchObject({text: 'cpu-timeout'});
        await cancelLocalVideoTranscription('timeout-fallback');
    });

    it.each([undefined, 'GPU inference failed'])('retries explicit GPU fallback messages on a fresh worker (%s)', async (error) => {
        installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 'gpu-message', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        const first = FakeWorker.instances[0];
        const firstMessage = (first as any).lastMessage;
        const originalAudio = Array.from(firstMessage.audio);
        first.reply({requestId: firstMessage.requestId, success: false, retryWithCpu: true, error});
        await tick();
        expect(first.terminated).toBe(true);
        expect(FakeWorker.instances).toHaveLength(2);
        const replacement = FakeWorker.instances[1];
        const retry = (replacement as any).lastMessage;
        expect(retry.device).toBe('wasm');
        expect(Array.from(retry.audio)).toEqual(originalAudio);
        first.reply({requestId: firstMessage.requestId, success: true, text: 'stale'});
        replacement.reply({requestId: retry.requestId, success: true, text: 'cpu', segments: [], model: 'tiny', backend: 'wasm'});
        await expect(pending).resolves.toMatchObject({text: 'cpu', backend: 'wasm'});
        await cancelLocalVideoTranscription('gpu-message');
    });

    it('does not retry after the total deadline and releases stream ownership', async () => {
        vi.useFakeTimers();
        installWorker();
        const startedAt = Date.now();
        const pending = transcribeLocalVideoAudio({streamId: 'expired', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        vi.setSystemTime(startedAt + 32_000);
        FakeWorker.instances[0].fail('late GPU failure');
        await expect(pending).rejects.toThrow('late GPU failure');
        expect(FakeWorker.instances).toHaveLength(1);
        expect(FakeWorker.instances[0].terminated).toBe(true);
        const recovered = transcribeLocalVideoAudio({streamId: 'next-owner', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        const replacement = FakeWorker.instances[1];
        replacement.reply({requestId: (replacement as any).lastMessage.requestId, success: true, text: 'recovered', segments: []});
        await expect(recovered).resolves.toMatchObject({text: 'recovered'});
        await cancelLocalVideoTranscription('next-owner');
    });

    it('does not restart a cancelled stream between worker error and the fallback microtask', async () => {
        installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 'cancel-between', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        const first = FakeWorker.instances[0];
        first.fail('GPU worker failed');
        await cancelLocalVideoTranscription('cancel-between');
        await expect(pending).rejects.toThrow('取消');
        expect(FakeWorker.instances).toHaveLength(1);
    });
});

describe('video AI shared inference budget and worker generation', () => {
    it.each(['transcribe', 'prepare'] as const)('%s waits for shared capacity before creating a worker or starting its timeout', async kind => {
        vi.useFakeTimers();
        installWorker();
        const busy = deferred(), occupying = budgetMocks.run(() => busy.promise);
        const streamId = `budget-${kind}`, pending = requestVideoWorker(kind, streamId);
        await drain();
        expect(budgetMocks.run).toHaveBeenCalledTimes(2);
        expect(FakeWorker.instances).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(5000);
        expect(FakeWorker.instances).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);

        busy.resolve();await occupying;await drain();
        expect(FakeWorker.instances).toHaveLength(1);
        const worker = FakeWorker.instances[0], message = worker.messages[0];
        expect(message).toMatchObject({type: kind, model: 'tiny'});
        expect(worker.messages).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(1);
        if (kind === 'transcribe') {
            expect(message.languageSessionKey).toBe(streamId);
            expect(message.audio).toBeInstanceOf(Float32Array);
            expect(message.audio.byteLength).toBeGreaterThan(0);
        }
        completeWorker(worker);await expect(pending).resolves.toMatchObject({model: 'tiny', backend: 'wasm'});
        const probe = vi.fn(async () => 'capacity released');
        await expect(budgetMocks.run(probe)).resolves.toBe('capacity released');
        expect(probe).toHaveBeenCalledOnce();
        await cancelLocalVideoTranscription(streamId);
        expect(worker.terminated).toBe(true);expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['transcribe', 'prepare'] as const)('cancelled %s waiting on capacity never creates a worker, and the next model can start', async kind => {
        installWorker();
        const busy = deferred(), occupying = budgetMocks.run(() => busy.promise);
        const oldStream = `old-${kind}`, freshStream = `new-${kind}`;
        const stale = requestVideoWorker(kind, oldStream);
        const cancelled = expect(stale).rejects.toThrow('本地视频 AI 字幕已取消');
        await drain();
        expect(budgetMocks.run).toHaveBeenCalledTimes(2);
        expect(FakeWorker.instances).toHaveLength(0);
        // 此时还没有 Worker：取消也必须增加世代，拦截已经进入预算队列的闭包。
        await cancelLocalVideoTranscription(oldStream);
        const fresh = requestVideoWorker(kind, freshStream, 'base');
        await drain();expect(FakeWorker.instances).toHaveLength(0);

        busy.resolve();await occupying;await cancelled;await drain();
        expect(FakeWorker.instances).toHaveLength(1);
        expect(budgetMocks.run).toHaveBeenCalledTimes(3);
        const worker = FakeWorker.instances[0];
        expect(worker.messages).toHaveLength(1);
        expect(worker.messages[0]).toMatchObject({type: kind, model: 'base'});
        expect(worker.messages[0].device).toBeUndefined();
        if (kind === 'transcribe') expect(worker.messages[0].languageSessionKey).toBe(freshStream);
        completeWorker(worker, 'base');await expect(fresh).resolves.toMatchObject({model: 'base'});
        expect(worker.messages).toHaveLength(1);
        await cancelLocalVideoTranscription(freshStream);
    });

    it('cancel and model change invalidate a queued request against an already warm worker', async () => {
        installWorker();
        const streamId = 'model-change-budget';
        const warm = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId});
        await drain();
        const original = FakeWorker.instances[0];
        completeWorker(original);await warm;
        const firstRequestId = original.messages[0].requestId;

        const busy = deferred(), occupying = budgetMocks.run(() => busy.promise);
        const stale = transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model: 'tiny'});
        const cancelled = expect(stale).rejects.toThrow('本地视频 AI 字幕已取消');
        await drain();
        expect(original.messages).toHaveLength(1);
        expect(budgetMocks.run).toHaveBeenCalledTimes(3);
        await cancelLocalVideoTranscription(streamId);
        expect(original.terminated).toBe(true);
        const changed = prepareLocalVideoTranscriptionModel('base', {keepWarm: true, streamId});
        await drain();expect(FakeWorker.instances).toHaveLength(1);

        busy.resolve();await occupying;await cancelled;await drain();
        expect(FakeWorker.instances).toHaveLength(2);
        const replacement = FakeWorker.instances[1];
        expect(original.messages).toHaveLength(1);
        expect(replacement.messages).toHaveLength(1);
        expect(replacement.messages[0]).toMatchObject({type: 'prepare', model: 'base', requestId: firstRequestId + 1});
        expect(budgetMocks.run).toHaveBeenCalledTimes(4);
        completeWorker(replacement, 'base');await expect(changed).resolves.toMatchObject({model: 'base'});
        expect(replacement.terminated).toBe(false);
        await cancelLocalVideoTranscription(streamId);
    });

    it('model switching waits for capacity, then advances generation without rejecting subsequent requests', async () => {
        installWorker();
        const streamId = 'switch-generation';
        const warm = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId});
        await drain();
        const original = FakeWorker.instances[0];
        completeWorker(original);await warm;

        const busy = deferred(), occupying = budgetMocks.run(() => busy.promise);
        const changed = prepareLocalVideoTranscriptionModel('base', {keepWarm: true, streamId});
        await drain();
        expect(FakeWorker.instances).toHaveLength(1);
        expect(original.terminated).toBe(false);expect(original.messages).toHaveLength(1);
        busy.resolve();await occupying;await drain();
        expect(original.terminated).toBe(true);
        expect(FakeWorker.instances).toHaveLength(2);
        const replacement = FakeWorker.instances[1];
        expect(replacement.messages[0]).toMatchObject({type: 'prepare', model: 'base'});

        const followup = transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model: 'base'});
        expect(replacement.messages).toHaveLength(1);
        completeWorker(replacement, 'base');await changed;await drain();
        expect(FakeWorker.instances).toHaveLength(2);
        expect(replacement.messages).toHaveLength(2);
        expect(replacement.messages[1]).toMatchObject({type: 'transcribe', model: 'base', languageSessionKey: streamId});
        expect(budgetMocks.run).toHaveBeenCalledTimes(4);
        completeWorker(replacement, 'base');await expect(followup).resolves.toMatchObject({model: 'base'});
        expect(replacement.terminated).toBe(false);
        await cancelLocalVideoTranscription(streamId);
    });

    it('cancel invalidates a CPU retry waiting on shared capacity and releases it for a new model', async () => {
        installWorker();
        const streamId = 'retry-budget';
        const stale = transcribeLocalVideoAudio({streamId, audioPcm16Base64: audio, model: 'tiny'});
        const cancelled = expect(stale).rejects.toThrow('本地视频 AI 字幕已取消');
        await drain();
        const original = FakeWorker.instances[0];
        // 活跃请求尚占预算；失败释放后由另一类推理先取得槽位，CPU 重试必须排队。
        const busy = deferred(), occupying = budgetMocks.run(() => busy.promise);
        original.fail('GPU failure before budget wait');
        await drain();
        expect(original.terminated).toBe(true);
        expect(budgetMocks.run).toHaveBeenCalledTimes(3);
        expect(FakeWorker.instances).toHaveLength(1);
        await cancelLocalVideoTranscription(streamId);
        const fresh = transcribeLocalVideoAudio({streamId: 'new-after-retry', audioPcm16Base64: audio, model: 'base'});
        busy.resolve();await occupying;await cancelled;await drain();

        expect(FakeWorker.instances).toHaveLength(2);
        const replacement = FakeWorker.instances[1];
        expect(replacement.messages).toHaveLength(1);
        expect(replacement.messages[0]).toMatchObject({type: 'transcribe', model: 'base', languageSessionKey: 'new-after-retry'});
        expect(replacement.messages[0].device).toBeUndefined();
        expect(budgetMocks.run).toHaveBeenCalledTimes(4);
        completeWorker(replacement, 'base');await expect(fresh).resolves.toMatchObject({model: 'base'});
        await cancelLocalVideoTranscription('new-after-retry');
    });
});

it('删除模型拒绝活跃工作并在失败后恢复可用状态', async () => {
 installWorker(); let release!:()=>void;
 vi.stubGlobal('caches',{open:()=>new Promise<any>(resolve=>{release=()=>resolve({keys:async()=>[]})})});
 await expect(removeLocalVideoTranscriptionModel('bad')).rejects.toThrow('无效');
 const clearing=removeLocalVideoTranscriptionModel('tiny');
 await expect(removeLocalVideoTranscriptionModel('base')).rejects.toThrow('正在');
 await expect(prepareLocalVideoTranscriptionModel('tiny')).rejects.toThrow('清除');
 await expect(transcribeLocalVideoAudio({streamId:'busy',audioPcm16Base64:audio,model:'tiny'})).rejects.toThrow('清除');
 release(); await clearing;
 vi.stubGlobal('caches',{open:async()=>{throw new Error('disk')}});
 await expect(removeLocalVideoTranscriptionModel('tiny')).rejects.toThrow('disk');
 vi.stubGlobal('caches',{open:async()=>({keys:async()=>[]})});
 const pending=transcribeLocalVideoAudio({streamId:'loaded',audioPcm16Base64:audio,model:'tiny'}); await tick();
 await expect(removeLocalVideoTranscriptionModel('tiny')).rejects.toThrow('正在');
 const worker=FakeWorker.instances[0]; worker.reply({requestId:(worker as any).lastMessage.requestId,success:true,text:'hello',segments:[],model:'tiny'});await pending;
 await removeLocalVideoTranscriptionModel('tiny');expect(worker.terminated).toBe(true);
 await cancelLocalVideoTranscription('loaded');
});


describe('模型预热的有界首音频租期', () => {
    async function warm(streamId?: string, model: 'tiny' | 'base' = 'tiny'): Promise<FakeWorker> {
        const preparing = prepareLocalVideoTranscriptionModel(model, {keepWarm: true, streamId});
        await drain();
        const worker = FakeWorker.instances.at(-1)!;
        completeWorker(worker, model);
        await preparing;
        await drain();
        return worker;
    }

    it('等音频40秒仍复用已准备的Worker，首窗完成后恢复120秒空闲释放', async () => {
        vi.useFakeTimers();installWorker();
        const worker = await warm('lease-40s', 'base');
        await vi.advanceTimersByTimeAsync(40_000);
        expect(worker.terminated).toBe(false);
        const nonzeroPcm = Buffer.from(new Int16Array(16_000).fill(1310).buffer).toString('base64');
        const first = transcribeLocalVideoAudio({streamId: 'lease-40s', model: 'base', audioPcm16Base64: nonzeroPcm});
        await drain();
        expect(FakeWorker.instances).toHaveLength(1);
        expect(worker.messages).toHaveLength(2);
        expect(worker.messages[1].audio[0]).toBeGreaterThan(0);
        completeWorker(worker, 'base');await first;await drain();
        await vi.advanceTimersByTimeAsync(119_999);
        expect(worker.terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(worker.terminated).toBe(true);
        await cancelLocalVideoTranscription('lease-40s');
    });

    it('租期从prepare成功算起，无首音频90秒后一定释放', async () => {
        vi.useFakeTimers();installWorker();
        const preparing = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'lease-deadline'});
        await drain();
        const worker = FakeWorker.instances[0];
        await vi.advanceTimersByTimeAsync(10_000);
        completeWorker(worker);await preparing;await drain();
        await vi.advanceTimersByTimeAsync(89_999);
        expect(worker.terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(worker.terminated).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        await cancelLocalVideoTranscription('lease-deadline');
    });

    it('同owner重复prepare不会续租，陌生转写/prepare/取消也不延长租期', async () => {
        vi.useFakeTimers();installWorker();
        const worker = await warm('lease-no-renew');
        await vi.advanceTimersByTimeAsync(40_000);
        await expect(transcribeLocalVideoAudio({streamId: 'stranger', model: 'tiny', audioPcm16Base64: audio})).rejects.toThrow('另一个标签页');
        await expect(prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'stranger'})).rejects.toThrow('另一个标签页');
        await cancelLocalVideoTranscription('stranger');
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(40_000);
        expect(await warm('lease-no-renew')).toBe(worker);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(worker.terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(worker.terminated).toBe(true);
        await cancelLocalVideoTranscription('lease-no-renew');
    });

    it('陌生stream拒绝不能取消已消费租期后的120秒释放timer', async () => {
        vi.useFakeTimers();installWorker();
        const worker = await warm('lease-foreign-idle');
        const first = transcribeLocalVideoAudio({streamId: 'lease-foreign-idle', model: 'tiny', audioPcm16Base64: audio});
        await drain();completeWorker(worker);await first;await drain();
        await vi.advanceTimersByTimeAsync(110_000);
        await expect(transcribeLocalVideoAudio({streamId: 'foreign-idle', audioPcm16Base64: audio})).rejects.toThrow('另一个标签页');
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(worker.terminated).toBe(true);
        await cancelLocalVideoTranscription('lease-foreign-idle');
    });

    it('首窗提交即消费租期，prepare期间排队的首窗也不能获得新90秒租期', async () => {
        vi.useFakeTimers();installWorker();
        const preparing = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'lease-queued-first'});
        await drain();
        const worker = FakeWorker.instances[0];
        const first = transcribeLocalVideoAudio({streamId: 'lease-queued-first', model: 'tiny', audioPcm16Base64: audio});
        completeWorker(worker);await preparing;await drain();
        expect(worker.messages).toHaveLength(2);
        completeWorker(worker);await first;await drain();
        await warm('lease-queued-first');
        // 已发生首音频的会话即使再次prepare，也只维持设备对应的通常空闲期。
        await vi.advanceTimersByTimeAsync(120_000);
        expect(worker.terminated).toBe(true);
        await cancelLocalVideoTranscription('lease-queued-first');
    });

    it.each(['cancel', 'complete'] as const)('owner %s及时结束租期，complete保留通常120秒交接时间', async reason => {
        vi.useFakeTimers();installWorker();
        const worker = await warm(`lease-${reason}`);
        await vi.advanceTimersByTimeAsync(40_000);
        await cancelLocalVideoTranscription(`lease-${reason}`, reason);
        if (reason === 'cancel') {
            expect(worker.terminated).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } else {
            expect(worker.terminated).toBe(false);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(worker.terminated).toBe(true);
        }
    });

    it('owner重复prepare失败会结束已有租期，保留Worker仅到通常120秒', async () => {
        vi.useFakeTimers();installWorker();
        const worker = await warm('lease-failed');
        await vi.advanceTimersByTimeAsync(20_000);
        const failing = prepareLocalVideoTranscriptionModel('tiny', {keepWarm: true, streamId: 'lease-failed'});
        await drain();
        worker.reply({requestId: worker.messages.at(-1).requestId, success: false, error: 'prepare failed'});
        await expect(failing).rejects.toThrow('prepare failed');await drain();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(worker.terminated).toBe(true);
        await cancelLocalVideoTranscription('lease-failed');
    });

    it('首窗失败同样消费租期，不把错误会话保温到90秒', async () => {
        vi.useFakeTimers();installWorker();
        const worker = await warm('lease-invalid-pcm');
        await expect(transcribeLocalVideoAudio({streamId: 'lease-invalid-pcm', audioPcm16Base64: 'AA=='})).rejects.toThrow('PCM');
        await drain();await vi.advanceTimersByTimeAsync(120_000);
        expect(worker.terminated).toBe(true);
        await cancelLocalVideoTranscription('lease-invalid-pcm');
    });

    it('换模型释放旧租期与Worker，新模型的首次租期独立计算', async () => {
        vi.useFakeTimers();installWorker();
        const previous = await warm('lease-model');
        await vi.advanceTimersByTimeAsync(10_000);
        const next = await warm('lease-model', 'base');
        expect(previous.terminated).toBe(true);
        expect(next).not.toBe(previous);
        await vi.advanceTimersByTimeAsync(89_999);
        expect(next.terminated).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(next.terminated).toBe(true);
        await cancelLocalVideoTranscription('lease-model');
    });

    it.each(['tiny', 'base'] as const)('删除%s模型结束首窗租期，未删除的Worker仍按120秒释放', async removedModel => {
        vi.useFakeTimers();installWorker();
        vi.stubGlobal('caches', {open: async () => ({keys: async () => []})});
        const worker = await warm('lease-remove');
        await removeLocalVideoTranscriptionModel(removedModel);
        if (removedModel === 'tiny') expect(worker.terminated).toBe(true);
        else {
            expect(worker.terminated).toBe(false);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(worker.terminated).toBe(true);
        }
        expect(vi.getTimerCount()).toBe(0);
        await cancelLocalVideoTranscription('lease-remove');
    });

    it('无owner预热使用通常120秒，纯缓存准备不会创建Worker或首窗租期', async () => {
        vi.useFakeTimers();installWorker();
        const worker = await warm();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(worker.terminated).toBe(true);
        vi.stubGlobal('caches', {open: async () => ({match: async () => new Response(null)})});
        await expect(prepareLocalVideoTranscriptionModel('tiny', {streamId: 'not-warm-owner'})).resolves.toMatchObject({dtype: 'q4'});
        await drain();
        expect(FakeWorker.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(vi.getTimerCount()).toBe(0);
    });
});

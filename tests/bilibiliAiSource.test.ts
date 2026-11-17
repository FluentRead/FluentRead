import {beforeEach, describe, expect, it, vi} from 'vitest';
import {BilibiliAiSource, type BilibiliAiPorts} from '@/src/features/video-subtitle/content/bilibiliAiSource';
import type {VideoAiFullCaptureOptions} from '@/src/features/video-subtitle/content/video-ai/fullCapture';
const harness = vi.hoisted(() => ({options: null as VideoAiFullCaptureOptions | null, start: vi.fn(), cancel: vi.fn(), destroy: vi.fn()}));
vi.mock('@/src/features/video-subtitle/content/video-ai/fullCapture', () => ({VideoAiFullCaptureController: class {
    constructor(options: VideoAiFullCaptureOptions) {harness.options = options;}
    start = harness.start; cancel = harness.cancel; destroy = harness.destroy; getSessionId = () => 1;
}}));
beforeEach(() => {harness.start.mockReset(); harness.cancel.mockReset(); harness.destroy.mockReset();});
function fixture() {
    const send = vi.fn(async (_message: unknown): Promise<unknown> => ({success: true, models: ['small']}));
    const ports: BilibiliAiPorts = {send, getVideo: () => null, getAudio: async () => new Float32Array(), getModel: () => 'small',
        getLanguage: () => 'en', getProvider: () => 'browser', getNativeBaseUrl: () => 'http://127.0.0.1:8000', changed: vi.fn()};
    const source = new BilibiliAiSource(ports); source.sync('one');
    return {source, send, ports, options: harness.options!};
}
describe('B 站 AI 字幕会话', () => {
    it('自带字幕标记到达时取消自动模型检查，保留后续手动生成', async () => {
        const f = fixture(); let resolve!: (value: unknown) => void;
        f.send.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        const pending = f.source.start(true); f.source.stopAutomatic();
        resolve({success: true, models: ['small']}); await pending;
        expect(harness.start).not.toHaveBeenCalled(); expect(f.source.status).toBe('idle');
        f.send.mockResolvedValue({success: true, models: ['small']});
        await f.source.start(); const cancellations = harness.cancel.mock.calls.length;
        f.source.stopAutomatic(); expect(harness.cancel).toHaveBeenCalledTimes(cancellations);
        expect(f.source.status).toBe('running');
    });
    it('仅使用已下载模型，自动尝试去重且手动停止后不会自动重启', async () => {
        const f = fixture();
        await f.source.start(true); expect(harness.start).toHaveBeenCalledOnce();
        await f.source.start(true); expect(f.send).toHaveBeenCalledOnce();
        f.source.stop(); await f.source.start(true); expect(harness.start).toHaveBeenCalledOnce();
        await f.source.start(); expect(harness.start).toHaveBeenCalledTimes(2);
        f.source.sync('two'); expect(f.source.status).toBe('idle');
        await f.source.start(true); expect(harness.start).toHaveBeenCalledTimes(3);
        f.source.destroy(); expect(harness.destroy).toHaveBeenCalledOnce();
    });
    it('缺模型时明确提示设置，状态读取失败可重试，均不下载模型', async () => {
        const f = fixture(); f.send.mockResolvedValueOnce({success: true, models: []});
        await f.source.start(true); expect(f.source.error).toContain('下载');
        await f.source.start(true); expect(f.send).toHaveBeenCalledOnce();
        f.send.mockRejectedValueOnce(new Error('offline'));
        await f.source.start(); expect(f.source.error).toContain('无法读取');
        await f.source.start(); expect(harness.start).toHaveBeenCalledOnce();
        expect(f.send.mock.calls.every(([message]) => (message as {type: string}).type === 'fluentReadGetLocalVideoModelState')).toBe(true);
    });
    it.each(['switch', 'stop', 'destroy'] as const)('检查模型期间 %s 会隔离迟到结果', async action => {
        const f = fixture(); let resolve!: (value: unknown) => void;
        f.send.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        const pending = f.source.start(); await f.source.start();
        if (action === 'switch') f.source.sync('two'); else if (action === 'stop') f.source.stop(); else f.source.destroy();
        resolve({success: true, models: ['small']}); await pending;
        expect(harness.start).not.toHaveBeenCalled();
    });
    it('隔离迟到的检查错误，未绑定或销毁后不能开始', async () => {
        const f = fixture(); let reject!: (error: Error) => void;
        f.send.mockImplementationOnce(() => new Promise((_done, fail) => {reject = fail;}));
        const pending = f.source.start(); f.source.sync(''); reject(new Error('late')); await pending;
        expect(f.source.error).toBe(''); await f.source.start(); expect(harness.start).not.toHaveBeenCalled();
        f.source.destroy(); f.source.sync('three'); await f.source.start(); expect(f.options.isSupported()).toBe(false);
    });
    it('冻结后台身份，传递 PCM，发布进度，完成后释放后台资源', async () => {
        const f = fixture(); await f.source.start(); expect(f.options.isSupported()).toBe(true);
        f.options.onSessionStart!(1);
        f.options.onProgress!({phase: 'transcribing', progress: .5, capturedMs: 1, durationMs: 1, transcribedMs: 0, windowIndex: 0, windowCount: 1});
        expect(f.source.progress).toBe(.5);
        const chunk = {pcm: new Float32Array([.1]), sessionId: 1, startMs: 0, durationMs: 1, audioDurationMs: 1, playbackRate: 1, sequence: 1};
        f.send.mockResolvedValueOnce({success: true, text: 'hello'});
        expect(await f.options.transcribe(chunk)).toMatchObject({text: 'hello'});
        expect(f.send.mock.calls.at(-1)![0]).toMatchObject({type: 'fluentReadTranscribeLocalVideoAudio', sourceLanguage: 'en', model: 'small', provider: 'browser'});
        const cues = [{startMs: 0, durationMs: 1000, text: 'hello', availableAtMs: 0, spokenEndMs: 1000}];
        f.options.onCuesProgress!(cues, 1); expect(f.source.cues).toEqual(cues);
        await f.options.onTranscriptionComplete(cues, 1);
        f.send.mockResolvedValueOnce({success: true});
        f.options.onProgress!({phase: 'ready', progress: 1, capturedMs: 1, durationMs: 1, transcribedMs: 1, windowIndex: 1, windowCount: 1});
        expect(f.source.status).toBe('ready'); await f.source.start(); expect(harness.start).toHaveBeenCalledOnce();
        expect(f.send.mock.calls.at(-1)![0]).toMatchObject({type: 'fluentReadCancelLocalVideoTranscription', reason: 'complete'});
        f.options.onStateChange();
        f.options.onError(new Error('audio unavailable')); expect(f.source.cues).toEqual([]); expect(f.source.error).toBe('audio unavailable');
        f.source.destroy(); expect(await f.options.transcribe(chunk)).toEqual({skipped: true});
    });
    it('未创建会话不转写，推理失败保留错误，取消传输失败不掩盖清理', async () => {
        const f = fixture();
        const chunk = {pcm: new Float32Array([.1]), sessionId: 1, startMs: 0, durationMs: 1, audioDurationMs: 1, playbackRate: 1, sequence: 1};
        expect(await f.options.transcribe(chunk)).toEqual({skipped: true});
        f.options.onInvalidate!('cancel', 1); expect(f.send).not.toHaveBeenCalled();
        f.options.onSessionStart!(1);
        f.send.mockResolvedValueOnce({success: false, error: 'worker failed'});
        await expect(f.options.transcribe(chunk)).rejects.toThrow('worker failed');
        f.send.mockResolvedValueOnce({success: false, error: ''});
        await expect(f.options.transcribe(chunk)).rejects.toThrow('本地识别失败');
        f.send.mockRejectedValueOnce(new Error('disconnected')); f.options.onInvalidate!('cancel', 1); await Promise.resolve();
    });
    it('尊重本机识别方式且不请求浏览器模型下载', async () => {
        const f = fixture(); f.ports.getProvider = () => 'native-qwen';
        await f.source.start(); expect(f.send).not.toHaveBeenCalled();
        f.options.onSessionStart!(1);
        f.send.mockResolvedValueOnce({success: true}); f.options.onInvalidate!('cancel', 1);
        expect(f.send.mock.calls[0][0]).toMatchObject({model: 'Qwen/Qwen3-ASR-1.7B', provider: 'native-qwen'});
        f.source.sync('one'); expect(f.source.status).toBe('running');
    });
});

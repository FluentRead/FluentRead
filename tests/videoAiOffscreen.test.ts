import {afterEach, describe, expect, it, vi} from 'vitest';
import {removeLocalVideoTranscriptionModel, cancelLocalVideoTranscription, prepareLocalVideoTranscriptionModel, transcribeLocalVideoAudio} from '@/src/features/video-subtitle/offscreen/transcription';

class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    constructor() { FakeWorker.instances.push(this); }
    postMessage(message: any): void { (this as any).lastMessage = message; }
    terminate(): void { this.terminated = true; }
    reply(response: Record<string, unknown>): void { this.onmessage?.({data: response} as MessageEvent); }
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    FakeWorker.instances = [];
});

function installWorker(): void {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', {location: {href: 'chrome-extension://test/offscreen.html'}, setTimeout, clearTimeout});
}
const audio = 'AAAAAA==';
const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('video AI offscreen queue', () => {
    it('reuses one worker and resolves a successful transcription', async () => {
        installWorker();
        const pending = transcribeLocalVideoAudio({streamId: 's', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        expect(FakeWorker.instances).toHaveLength(1);
        const worker = FakeWorker.instances[0];
        expect((worker as any).lastMessage.languageSessionKey).toBe('s');
        const requestId = (worker as any).lastMessage.requestId;
        worker.reply({requestId, success: true, text: 'hello', segments: [{startMs: 0, endMs: 500, text: 'hello'}], model: 'tiny', inferenceMs: 10});
        await expect(pending).resolves.toMatchObject({text: 'hello', model: 'tiny'});
        const second = transcribeLocalVideoAudio({streamId: 's', audioPcm16Base64: audio, model: 'tiny'});
        await tick();
        expect(FakeWorker.instances).toHaveLength(1);
        FakeWorker.instances[0].reply({requestId: (FakeWorker.instances[0] as any).lastMessage.requestId, success: true, text: '', segments: [], model: 'tiny'});
        await second;
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
});

/**
 * @file tests/mangaDetectionFailure.test.ts
 * 文件职责：验证 Paddle 检测异常不会被当成漫画空白页。
 * 主要内容：对真实安装依赖的检测及 OCR 编排使用无模型平台和张量替身，并验证客户端取消与单次 CPU 回退。
 * 模块边界：不下载、初始化或运行模型，不声称覆盖真实 GPU、浏览器画布或扩展打包。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BaseDetectionService} from '../node_modules/ppu-paddle-ocr/core/base-detection.service.js';
import {BasePaddleOcrService} from '../node_modules/ppu-paddle-ocr/core/base-paddle-ocr.service.js';
import {createMangaInferenceClient} from '@/src/features/image-translation/services/mangaInferenceClient';
import type {MangaInferenceMessage, MangaInferenceResponse} from '@/src/features/image-translation/services/mangaInferenceClient';

type Outcome = 'empty' | 'preprocess' | 'postprocess' | 'missing-output' | 'device';
class Tensor { dispose() {} }
class TestPaddleService extends BasePaddleOcrService {
    protected async initSessions(): Promise<void> {throw new Error('unexpected model initialization');}
}
const image = {width: 1, height: 1, getContext: () => ({getImageData: () => ({data: new Uint8Array([255, 255, 255, 255])})})};

async function recognize(outcome: Outcome) {
    const expected = new Error(`${outcome} failure`);
    const session = {outputNames: ['output'], run: async () => {
        if (outcome === 'device') throw expected;
        return outcome === 'missing-output' ? {} : {output: {data: new Float32Array([0])}};
    }};
    const platform = {isCanvas: () => true, canvas: {}, ort: {Tensor}};
    const detector = new BaseDetectionService(platform as never, session as never) as any;
    detector.preprocessDetection = async () => {
        if (outcome === 'preprocess') throw expected;
        return {tensor: new Float32Array(3), width: 1, height: 1};
    };
    detector.postprocessDetection = () => { if (outcome === 'postprocess') throw expected; return []; };
    const service = new TestPaddleService(platform as never, {}) as any;
    service.detector = detector;
    service.recognitor = {run: () => {throw new Error('unexpected recognition call');}};
    return service.recognize(image, {flatten: true, noCache: true});
}

class MockWorker {
    onmessage: ((event: MessageEvent<MangaInferenceResponse>) => void) | null = null;
    onerror = null;
    terminated = false;
    constructor(private readonly outcome: Outcome, private readonly onPosted?: () => void) {}
    postMessage(message: MangaInferenceMessage) {
        this.onPosted?.();
        void recognize(this.outcome).then(
            result => this.onmessage?.({data: {requestId: message.requestId, success: true, result}} as MessageEvent<MangaInferenceResponse>),
            error => this.onmessage?.({data: {requestId: message.requestId, success: false, error: error.message}} as MessageEvent<MangaInferenceResponse>),
        );
    }
    terminate() {this.terminated = true;}
}

beforeEach(() => {
    vi.stubGlobal('navigator', {hardwareConcurrency: 2, deviceMemory: 4});
    vi.stubGlobal('self', {location: {href: 'https://extension.test/offscreen/index.html'}});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('漫画检测失败不伪装为空白', () => {
    it('真实无框结果仍是成功的空白页', async () => {
        await expect(recognize('empty')).resolves.toEqual({text: '', results: [], confidence: 0});
    });
    it.each(['preprocess', 'postprocess', 'device'] as const)('保留 %s 原错误', async outcome => {
        await expect(recognize(outcome)).rejects.toThrow(`${outcome} failure`);
    });
    it('缺少输出张量时报告失败', async () => {
        await expect(recognize('missing-output')).rejects.toThrow('Text detection failed (output tensor is null)');
    });
    it('检测失败触发一次 CPU 回退，真实空页仍可成功', async () => {
        const workers: MockWorker[] = [];
        const client = createMangaInferenceClient(() => {
            const worker = new MockWorker(workers.length ? 'empty' : 'preprocess');workers.push(worker);return worker as unknown as Worker;
        });
        try {
            await expect(client.request({type: 'recognize', image: 'fixture'})).resolves.toEqual({text: '', results: [], confidence: 0});
            expect(workers).toHaveLength(2);expect(workers[0].terminated).toBe(true);
        } finally {client.dispose();}
    });
    it('CPU 重试仍失败时保留错误，不再当作空白或进行第三次尝试', async () => {
        const workers: MockWorker[] = [];
        const client = createMangaInferenceClient(() => {const worker = new MockWorker('device');workers.push(worker);return worker as unknown as Worker;});
        try {
            await expect(client.request({type: 'recognize', image: 'fixture'})).rejects.toThrow('device failure');
            expect(workers).toHaveLength(2);expect(workers.every(worker => worker.terminated)).toBe(true);
        } finally {client.dispose();}
    });
    it('请求取消时优先返回 AbortError，不因为检测错误启动 CPU 回退', async () => {
        const workers: MockWorker[] = [];
        const controller = new AbortController();
        const client = createMangaInferenceClient(() => {const worker = new MockWorker('device', () => controller.abort());workers.push(worker);return worker as unknown as Worker;});
        try {
            const result = client.request({type: 'recognize', image: 'fixture'}, controller.signal);
            await expect(result).rejects.toMatchObject({name: 'AbortError'});
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(workers).toHaveLength(1);
        } finally {client.dispose();}
    });
});

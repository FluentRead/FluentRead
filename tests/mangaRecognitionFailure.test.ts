/**
 * @file tests/mangaRecognitionFailure.test.ts
 * 文件职责：验证 Paddle 文本识别的内部异常不会被伪装为空白或部分结果。
 * 主要内容：调用真实依赖的识别和 OCR 编排，以无模型画布、张量和会话替身区分有效空结果、异常及逐框模式。
 * 模块边界：不加载模型、不访问网络，也不代表真实浏览器或设备故障测试。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BaseRecognitionService} from '../node_modules/ppu-paddle-ocr/core/base-recognition.service.js';
import {BasePaddleOcrService} from '../node_modules/ppu-paddle-ocr/core/base-paddle-ocr.service.js';

type Outcome = 'empty' | 'success' | 'crop' | 'preprocess' | 'missing-output' | 'decode' | 'device' | 'second-box';
const box = {x: 0, y: 0, width: 10, height: 10};
const image = {width: 100, height: 100, getContext: () => ({getImageData: () => ({data: new Uint8Array(40_000)})})};
class Tensor { dispose() {} }
class TestPaddleService extends BasePaddleOcrService {
    protected async initSessions(): Promise<void> {throw new Error('unexpected model initialization');}
}

function createRecognition(outcome: Outcome, debug = false) {
    const expected = new Error(`${outcome} failure`);
    let crops = 0;
    const session = {inputMetadata: [{shape: [-1]}], run: async () => {
        if (outcome === 'device') throw expected;
        if (outcome === 'missing-output') return {};
        if (outcome === 'decode') return {output: {dims: [1, 1, 3], data: null}};
        return {output: {dims: [1, 1, 3], data: new Float32Array(outcome === 'empty' ? [1, 0, 0] : [0, .99, 0])}};
    }};
    const platform = {
        isCanvas: () => true,
        ort: {Tensor},
        canvas: {
            getToolkit: () => ({crop: () => {
                crops++;
                if (outcome === 'crop' || (outcome === 'second-box' && crops === 2)) throw expected;
                return {width: 10, height: 10};
            }}),
            createProcessor: () => ({
                resize() {if (outcome === 'preprocess') throw expected;return this;},
                toCanvas: () => ({getContext: () => ({getImageData: () => ({data: new Uint8ClampedArray(48 * 48 * 4)})})}),
            }),
        },
    };
    const recognition = new BaseRecognitionService(platform as never, session as never,
        {minimumConfidence: .65}, {debug, debugFolder: ''}, 'canvas-native');
    return {expected, recognition, platform};
}

beforeEach(() => {vi.spyOn(console, 'error').mockImplementation(() => {});});
afterEach(() => {vi.restoreAllMocks();});

describe('漫画识别失败不伪装为空白或部分文字', () => {
    it('没有检测框、或有框但没有可信文字，均保留成功空结果', async () => {
        const {recognition} = createRecognition('empty');
        await expect(recognition.run(image as never, [], ['', 'A', '<unk>'], 'per-box')).resolves.toEqual([]);
        await expect(recognition.run(image as never, [box], ['', 'A', '<unk>'], 'per-box')).resolves.toEqual([]);
    });
    it('有效模型输出仍返回识别文字', async () => {
        const {recognition} = createRecognition('success');
        await expect(recognition.run(image as never, [box], ['', 'A', '<unk>'], 'per-box'))
            .resolves.toMatchObject([{text: 'A', box}]);
    });
    it.each(['crop', 'preprocess', 'device'] as const)('保留 %s 原错误对象', async outcome => {
        const {expected, recognition} = createRecognition(outcome);
        await expect(recognition.run(image as never, [box], ['', 'A', '<unk>'], 'per-box')).rejects.toBe(expected);
    });
    it('会话成功但缺失输出张量时报告错误', async () => {
        const {recognition} = createRecognition('missing-output');
        await expect(recognition.run(image as never, [box], ['', 'A', '<unk>'], 'per-box'))
            .rejects.toThrow('Recognition output tensor');
    });
    it('输出张量无法解码时报告错误', async () => {
        const {recognition} = createRecognition('decode');
        await expect(recognition.run(image as never, [box], ['', 'A', '<unk>'], 'per-box')).rejects.toBeInstanceOf(TypeError);
    });
    it('调试逐框模式的后续框失败时不返回不完整文字', async () => {
        const {expected, recognition} = createRecognition('second-box', true);
        await expect(recognition.run(image as never, [box, {...box, x: 20}], ['', 'A', '<unk>'], 'per-box')).rejects.toBe(expected);
    });
    it('真实 OCR 编排把识别错误向上传播，而非报告空白页', async () => {
        const {expected, recognition, platform} = createRecognition('preprocess');
        const service = new TestPaddleService(platform as never, {}) as any;
        service.detector = {run: async () => [box]};
        service.recognitor = recognition;
        await expect(service.recognize(image, {flatten: true, noCache: true, strategy: 'per-box'})).rejects.toBe(expected);
    });
});

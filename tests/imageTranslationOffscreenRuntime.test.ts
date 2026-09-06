import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({recognize: vi.fn(), inpaint: vi.fn(), background: vi.fn(), draw: vi.fn()}));
vi.mock('@/src/features/image-translation/services/ocrRuntime', () => ({recognizeImage: mocks.recognize}));
vi.mock('@/src/features/image-translation/services/inpainting', () => ({inpaintTextRegions: mocks.inpaint}));
vi.mock('@/src/features/image-translation/services/rendering', () => ({
    getImageTextBackgroundColor: mocks.background, drawTranslatedImageText: mocks.draw,
}));

import {
    translateAreaInOffscreen,
    translateImageInOffscreen,
    translateImageTextsInExtension,
} from '@/src/features/image-translation/services/offscreenRuntime';

interface ImageOptions {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    mode?: 'load' | 'error' | 'pending' | 'throw';
}

const imageOptions: ImageOptions[] = [];
const images: TestImage[] = [];
class TestImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
    private value = '';
    private options: ImageOptions;
    constructor() {
        this.options = imageOptions.shift() || {};
        this.width = this.options.width ?? 32;
        this.height = this.options.height ?? 16;
        this.naturalWidth = this.options.naturalWidth ?? this.width;
        this.naturalHeight = this.options.naturalHeight ?? this.height;
        images.push(this);
    }
    get src() { return this.value; }
    set src(value: string) {
        this.value = value;
        if (!value || this.options.mode === 'pending') return;
        if (this.options.mode === 'throw') throw new Error('source rejected');
        queueMicrotask(() => this.options.mode === 'error' ? this.onerror?.() : this.onload?.());
    }
}

const canvases: ReturnType<typeof createCanvasStub>[] = [];
let nullContext = false;
function createCanvasStub() {
    const canvas = {
        width: 0,
        height: 0,
        context: {
            drawImage: vi.fn(),
            getImageData: vi.fn(() => ({data: new Uint8ClampedArray(canvas.width * canvas.height * 4)})),
            putImageData: vi.fn(),
        },
        getContext: vi.fn(() => nullContext ? null : canvas.context),
        toDataURL: vi.fn(() => 'data:image/png;base64,translated'),
    };
    return canvas;
}

function makeCanvas() {
    const canvas = createCanvasStub();
    canvases.push(canvas);
    return canvas;
}

const sendMessage = vi.fn();
const runtime: {sendMessage: typeof sendMessage; lastError?: {message: string}} = {sendMessage};
const lines = [{text: 'Hello', bbox: {x0: 3, y0: 3, x1: 29, y1: 13}}];
const selection = {left: 0, top: 0, width: 20, height: 10, viewportWidth: 40, viewportHeight: 20};

async function flushMicrotasks() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); }

beforeEach(() => {
    vi.resetAllMocks();
    imageOptions.length = 0;
    images.length = 0;
    canvases.length = 0;
    nullContext = false;
    runtime.lastError = undefined;
    mocks.recognize.mockResolvedValue(lines);
    mocks.inpaint.mockImplementation(pixels => new Uint8ClampedArray(pixels));
    mocks.background.mockReturnValue('rgb(240,240,240)');
    sendMessage.mockImplementation((message, callback) => {
        callback(message.type === 'fluentReadImageTranslateTexts' ? {success: true, translations: ['你好']} : undefined);
    });
    vi.stubGlobal('Image', TestImage);
    vi.stubGlobal('document', {createElement: vi.fn(() => makeCanvas())});
    vi.stubGlobal('chrome', {runtime});
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Offscreen 图片完整操作生命周期', () => {
    it.each([false, true])('OCR 百分比只在请求仍有效时发出，带取消信号=%s', async withSignal => {
        const controller = new AbortController(); let notify!: (percent: number) => void;
        mocks.recognize.mockImplementationOnce(async (_image, _source, _signal, options) => {
            notify = options.onProgress; notify(37); return lines;
        });
        await translateImageInOffscreen('image','en','Page',withSignal ? controller.signal : undefined,'progress');
        expect(sendMessage).toHaveBeenCalledWith({type:'fluentReadImageProgress',requestId:'progress',stage:'recognizing',progress:37},expect.any(Function));
        if (withSignal) {
            const calls = sendMessage.mock.calls.length; controller.abort(); notify(98);
            expect(sendMessage).toHaveBeenCalledTimes(calls);
        }
    });

    it('预检和渲染复用同一次解码，阶段通知、完整译文与原尺寸一致并释放资源', async () => {
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const result = await translateImageInOffscreen('original-image', 'en', 'Page', controller.signal, 'image-1');
        expect(result).toEqual({image: 'data:image/png;base64,translated', lines: [{...lines[0], text: '你好', backgroundColor: 'rgb(240,240,240)'}]});
        expect(images).toHaveLength(1);
        expect(mocks.recognize).toHaveBeenCalledWith('original-image', 'en', controller.signal, {onProgress:expect.any(Function)});
        expect(canvases[0].context.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 32, 16);
        expect(mocks.background).toHaveBeenCalledOnce();
        expect(sendMessage.mock.calls.filter(([message]) => message.type === 'fluentReadImageProgress').map(([message]) => message.stage))
            .toEqual(['recognizing', 'translating', 'rendering']);
        expect(images[0].src).toBe('');
        expect(images[0].onload).toBeNull();
        expect(images[0].onerror).toBeNull();
        expect(canvases[0].width).toBe(0);
        expect(canvases[0].height).toBe(0);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it.each([[4097, 4096], [8193, 1]])('超预算 %i×%i 图片在 OCR 和翻译前失败', async (width, height) => {
        imageOptions.push({width, height});
        await expect(translateImageInOffscreen('oversized', 'en', 'Page', undefined, 'large')).rejects.toThrow('图片过大');
        expect(mocks.recognize).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(canvases).toHaveLength(0);
        expect(images[0].src).toBe('');
    });

    it('允许预算边界图像继续 OCR，natural 尺寸不可用时使用已解码尺寸', async () => {
        imageOptions.push({width: 4096, height: 4096});
        mocks.recognize.mockRejectedValueOnce(new Error('OCR reached'));
        await expect(translateImageInOffscreen('boundary', 'en', '')).rejects.toThrow('OCR reached');
        expect(mocks.recognize).toHaveBeenCalledOnce();
        imageOptions.push({naturalWidth: 0, naturalHeight: 0});
        await expect(translateImageInOffscreen('fallback-size', 'en', '')).resolves.toHaveProperty('image');
    });

    it.each([[0, 16], [32, 0], [NaN, 16], [32, 1.5]])('拒绝无效尺寸 %s×%s 并释放图像', async (width, height) => {
        imageOptions.push({width, height});
        await expect(translateImageInOffscreen('invalid', 'en', '')).rejects.toThrow('图片尺寸无效');
        expect(images[0].src).toBe('');
        expect(mocks.recognize).not.toHaveBeenCalled();
    });

    it('已取消请求不开始解码，解码中取消会清理监听并忽略迟到事件', async () => {
        const preCancelled = new AbortController();
        preCancelled.abort();
        await expect(translateImageInOffscreen('unused', 'en', '', preCancelled.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(images).toHaveLength(0);

        imageOptions.push({mode: 'pending'});
        const controller = new AbortController();
        const operation = translateImageInOffscreen('pending', 'en', '', controller.signal);
        const rejection = expect(operation).rejects.toMatchObject({name: 'AbortError'});
        const lateLoad = images[0].onload!;
        const lateError = images[0].onerror!;
        controller.abort();
        lateLoad();
        lateError();
        await rejection;
        expect(images[0].src).toBe('');
        expect(images[0].onload).toBeNull();
        expect(images[0].onerror).toBeNull();
        expect(mocks.recognize).not.toHaveBeenCalled();
    });

    it('解码没有事件时按预算超时，清除计时器并终止图片加载', async () => {
        vi.useFakeTimers();
        imageOptions.push({mode: 'pending'});
        const operation = translateImageInOffscreen('pending', 'en', '');
        const rejection = expect(operation).rejects.toThrow('图片解码超时');
        await vi.advanceTimersByTimeAsync(30_000);
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
        expect(images[0].src).toBe('');
        expect(images[0].onload).toBeNull();
    });

    it.each(['error', 'throw'] as const)('解码 %s 路径失败也会清理图像', async mode => {
        imageOptions.push({mode});
        await expect(translateImageInOffscreen('broken', 'en', '')).rejects.toThrow('图片数据无法解码');
        expect(images[0].src).toBe('');
        expect(images[0].onerror).toBeNull();
    });

    it('没有识别结果或没有变化的译文时停止，避免无效 Canvas 分配', async () => {
        mocks.recognize.mockResolvedValueOnce([]);
        await expect(translateImageInOffscreen('empty', 'en', '')).rejects.toThrow('没有识别到图片文字');
        expect(sendMessage).not.toHaveBeenCalled();
        sendMessage.mockImplementation((_, callback) => callback({success: true, translations: ['Hello']}));
        await expect(translateImageInOffscreen('unchanged', 'en', '')).rejects.toThrow('没有需要翻译的文字');
        expect(canvases).toHaveLength(0);
        expect(images.every(image => image.src === '')).toBe(true);
    });

    it('OCR 返回时已取消，不再发送翻译请求', async () => {
        const controller = new AbortController();
        mocks.recognize.mockImplementation(async () => {controller.abort(); return lines;});
        await expect(translateImageInOffscreen('image', 'en', '', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).not.toHaveBeenCalled();
        expect(images[0].src).toBe('');
    });

    it('翻译等待中取消通知后台，迟到译文不会生成图片', async () => {
        const controller = new AbortController();
        let complete!: (result: unknown) => void;
        sendMessage.mockImplementation((message, callback) => {
            if (message.type === 'fluentReadImageTranslateTexts') complete = callback;
            else callback();
        });
        const operation = translateImageInOffscreen('image', 'en', '', controller.signal, 'cancel-text');
        const rejection = expect(operation).rejects.toMatchObject({name: 'AbortError'});
        await flushMicrotasks();
        controller.abort();
        complete({success: true, translations: ['迟到的译文']});
        await rejection;
        expect(sendMessage.mock.calls.filter(([message]) => message.type === 'fluentReadImageCancel')).toEqual([
            [{type: 'fluentReadImageCancel', requestId: 'cancel-text'}, expect.any(Function)],
        ]);
        expect(canvases).toHaveLength(0);
        expect(images[0].src).toBe('');
    });

    it.each(['render-stage', 'pixel-read', 'inpainting', 'draw-event', 'encoding'] as const)(
        '取消发生在 %s 时不返回生成结果并释放 Canvas', async stage => {
            const controller = new AbortController();
            if (stage === 'render-stage') sendMessage.mockImplementation((message, callback) => {
                if (message.stage === 'rendering') controller.abort();
                callback({success: true, translations: ['你好']});
            });
            if (stage === 'inpainting') mocks.inpaint.mockImplementation(pixels => {controller.abort(); return pixels;});
            if (stage === 'draw-event') mocks.draw.mockImplementation(() => {setTimeout(() => controller.abort(), 0);});
            if (stage === 'pixel-read' || stage === 'encoding') vi.stubGlobal('document', {createElement: () => {
                const canvas = makeCanvas();
                if (stage === 'pixel-read') canvas.context.getImageData.mockImplementation(() => {
                    controller.abort(); return {data: new Uint8ClampedArray(32 * 16 * 4)};
                });
                else canvas.toDataURL.mockImplementation(() => {controller.abort(); return 'cancelled-image';});
                return canvas;
            }});
            await expect(translateImageInOffscreen('image', 'en', '', controller.signal, 'cancel-render')).rejects.toMatchObject({name: 'AbortError'});
            expect(images[0].src).toBe('');
            expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
            if (stage !== 'encoding') expect(canvases.every(canvas => canvas.toDataURL.mock.calls.length === 0)).toBe(true);
        },
    );

    it('Canvas 不可用时仍清理原图和分配的画布', async () => {
        nullContext = true;
        await expect(translateImageInOffscreen('image', 'en', '')).rejects.toThrow('浏览器不支持图片处理');
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
    });

    it('进度消息发送失败不阻断主链，编码失败也会释放资源', async () => {
        sendMessage.mockImplementation((message, callback) => {
            if (message.type === 'fluentReadImageProgress') throw new Error('page closed');
            callback({success: true, translations: ['你好']});
        });
        vi.stubGlobal('document', {createElement: () => {
            const canvas = makeCanvas();
            canvas.toDataURL.mockImplementation(() => {throw new Error('encode failed');});
            return canvas;
        }});
        await expect(translateImageInOffscreen('image', 'en', '', undefined, 'progress')).rejects.toThrow('encode failed');
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
    });
});

describe('Offscreen 圈选裁剪生命周期', () => {
    it('圈选只裁剪和本地OCR，保留原图原文且从不重绘或调用图片翻译RPC', async () => {
        imageOptions.push({width: 40, height: 20, naturalWidth: 0, naturalHeight: 0}, {width: 20, height: 10});
        await expect(translateAreaInOffscreen('screenshot', 'en', '', selection)).resolves.toHaveProperty('image');
        expect(images).toHaveLength(1);
        expect(mocks.recognize).toHaveBeenCalledWith('data:image/png;base64,translated', 'en', undefined, {profile: 'area'});
        expect(mocks.inpaint).not.toHaveBeenCalled();
        expect(mocks.draw).not.toHaveBeenCalled();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(canvases[0].context.drawImage).toHaveBeenCalledWith(images[0], 0, 0, 20, 10, 0, 0, 20, 10);
        expect(images.every(image => image.src === '')).toBe(true);
        expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    });

    it('无OCR结果与识别中取消均不返回迟到文本', async () => {
        mocks.recognize.mockResolvedValueOnce([]);
        await expect(translateAreaInOffscreen('image', 'en', '', selection)).rejects.toThrow('没有识别到圈选区域文字');
        const controller = new AbortController();
        mocks.recognize.mockImplementationOnce(async () => {controller.abort(); return lines;});
        await expect(translateAreaInOffscreen('image', 'en', '', selection, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it('裁剪 Canvas 不可用时释放截图且不开始 OCR', async () => {
        nullContext = true;
        await expect(translateAreaInOffscreen('image', 'en', '', selection)).rejects.toThrow('浏览器不支持区域截图处理');
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
        expect(mocks.recognize).not.toHaveBeenCalled();
    });

    it('裁剪画布创建异常也会释放已解码截图', async () => {
        vi.stubGlobal('document', {createElement: () => {throw new Error('canvas allocation failed');}});
        await expect(translateAreaInOffscreen('image', 'en', '', selection)).rejects.toThrow('canvas allocation failed');
        expect(images[0].src).toBe('');
        expect(mocks.recognize).not.toHaveBeenCalled();
    });

    it.each(['draw', 'encode'] as const)('裁剪 %s 时取消不继续识别', async stage => {
        const controller = new AbortController();
        vi.stubGlobal('document', {createElement: () => {
            const canvas = makeCanvas();
            if (stage === 'draw') canvas.context.drawImage.mockImplementation(() => controller.abort());
            else canvas.toDataURL.mockImplementation(() => {controller.abort(); return 'cancelled-crop';});
            return canvas;
        }});
        await expect(translateAreaInOffscreen('image', 'en', '', selection, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.recognize).not.toHaveBeenCalled();
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
    });
});

describe('Offscreen 图片文本 RPC 预算', () => {
    it('没有请求 ID 时生成独立请求标识，已取消请求只通知取消', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(translateImageTextsInExtension(['text'], '', undefined, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'fluentReadImageCancel', requestId: expect.stringContaining('legacy-image-text-')}), expect.any(Function));
    });

    it('后台没有回调时本地预算超时并通知取消，迟到回调不重复完成', async () => {
        vi.useFakeTimers();
        let complete!: (result: unknown) => void;
        sendMessage.mockImplementation((message, callback) => {
            if (message.type === 'fluentReadImageTranslateTexts') complete = callback;
            else callback();
        });
        const operation = translateImageTextsInExtension(['text'], '', 'timeout');
        const rejection = expect(operation).rejects.toThrow('图片文字翻译超时');
        await vi.advanceTimersByTimeAsync(120_000);
        complete({success: true, translations: ['迟到']});
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
        expect(sendMessage.mock.calls.filter(([message]) => message.type === 'fluentReadImageCancel')).toHaveLength(1);
    });

    it('runtime 错误、同步发送异常和取消通知失败均不留下挂起请求', async () => {
        runtime.lastError = {message: 'runtime error'};
        await expect(translateImageTextsInExtension(['text'], '', 'runtime')).rejects.toThrow('runtime error');
        runtime.lastError = undefined;
        sendMessage.mockImplementation(() => {throw new Error('context destroyed');});
        await expect(translateImageTextsInExtension(['text'], '', 'throw')).rejects.toThrow('context destroyed');
        const controller = new AbortController();
        controller.abort();
        await expect(translateImageTextsInExtension(['text'], '', 'abort', controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });

    it.each([undefined, {success: false, error: 'provider failed'}, {success: true, translations: null}])(
        '拒绝不完整响应 %j', async response => {
            sendMessage.mockImplementation((_, callback) => callback(response));
            await expect(translateImageTextsInExtension(['text'], '', 'response')).rejects.toThrow(response?.error || '图片文字翻译失败');
        },
    );
});

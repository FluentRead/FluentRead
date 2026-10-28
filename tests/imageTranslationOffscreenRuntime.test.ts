import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mangaMaskBoxes} from '@/src/features/image-translation/mangaPatchResult';

const mocks = vi.hoisted(() => ({recognize: vi.fn(), inpaint: vi.fn(), background: vi.fn(), draw: vi.fn(), mangaRecognize:vi.fn(), repair:vi.fn(), mangaDraw:vi.fn(), sampleManga:vi.fn(), alphaProtection:vi.fn(), encode:vi.fn()}));
vi.mock('@/src/features/image-translation/services/mangaAlphaProtection',()=>({planMangaAlphaProtection:mocks.alphaProtection}));
vi.mock('@/src/features/image-translation/services/imageEncoding',()=>({encodeImageCanvas:mocks.encode}));
vi.mock('@/src/features/image-translation/services/mangaOcr',()=>({mangaOcrRuntime:{recognize:mocks.mangaRecognize}}));
vi.mock('@/src/features/image-translation/services/mangaInpainting',()=>({mangaInpaintingRuntime:{repair:mocks.repair}}));
vi.mock('@/src/features/image-translation/services/mangaRendering',()=>({drawMangaTranslations:mocks.mangaDraw,sampleMangaBackgrounds:mocks.sampleManga}));
vi.mock('@/src/features/image-translation/services/ocrRuntime', () => ({recognizeImage: mocks.recognize}));
vi.mock('@/src/features/image-translation/services/inpainting', () => ({inpaintTextRegions: mocks.inpaint}));
vi.mock('@/src/features/image-translation/services/rendering', () => ({
    getImageTextBackgroundColor: mocks.background, drawTranslatedImageText: mocks.draw,
}));

import {
    cropAreaInOffscreen,
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
    mocks.encode.mockResolvedValue('data:image/png;base64,translated');
    mocks.sampleManga.mockReturnValue([{color:'rgb(255,255,255)',uniform:false}]);
    imageOptions.length = 0;
    images.length = 0;
    canvases.length = 0;
    nullContext = false;
    runtime.lastError = undefined;
    mocks.recognize.mockResolvedValue(lines);
    mocks.inpaint.mockImplementation((pixels, _width, _height, _lines, inPlace) => inPlace ? pixels : new Uint8ClampedArray(pixels));
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
    it.each(['ru-RU', 'ko'])('漫画 %s 采用已有 Tesseract，清字、排版和局部结果仍使用漫画链路', async sourceLanguage => {
        if (sourceLanguage === 'ko') imageOptions.push({naturalWidth: 0, naturalHeight: 0});
        const controller = new AbortController();
        mocks.repair.mockImplementationOnce(async pixels => pixels);
        const result = await translateImageInOffscreen('manga', sourceLanguage, 'Page', controller.signal, 'language-manga', true, 'paddle');
        expect(mocks.recognize).toHaveBeenCalledWith('manga', sourceLanguage, controller.signal, expect.objectContaining({decodedImage: images[0]}));
        expect(mocks.mangaRecognize).not.toHaveBeenCalled();expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
        expect(mocks.repair).toHaveBeenCalledOnce();expect(mocks.mangaDraw).toHaveBeenCalledOnce();
        expect(mocks.repair.mock.calls[0][3][0]).toMatchObject({fontSize: 10, sourceBoxes: [lines[0].bbox]});
        expect(result.image).toBe('');expect(result.mangaPatches).toMatchObject({width: 32, height: 16});
        expect(result.lines[0]).toMatchObject({sourceText: 'Hello', text: '你好'});
        expect(images[0].src).toBe('');expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
    });
    it('单图选择 PaddleOCR 只替换识别引擎，仍返回完整译图与文本，不启动漫画修补', async () => {
        mocks.mangaRecognize.mockResolvedValue(lines);
        const result=await translateImageInOffscreen('image','en','Page',undefined,'single-paddle',false,'paddle');
        expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.mangaRecognize).toHaveBeenCalled();
        expect(result.image).toBe('data:image/png;base64,translated');expect(result.mangaPatches).toBeUndefined();
        expect(result.lines[0].sourceText).toBe('Hello');expect(mocks.repair).not.toHaveBeenCalled();
    });

    it('漫画整段识别走专用模型与局部修补，保留对照并报告准备阶段',async()=>{
        const regions=[{...lines[0],fontSize:10,sourceBoxes:[lines[0].bbox]}];
        mocks.mangaRecognize.mockImplementationOnce(async(_image,_language,_w,_h,_signal,progress)=>{progress('preparing',23);progress('recognizing');return regions;});
        mocks.repair.mockImplementationOnce(async(pixels,_w,_h,_lines,_signal,onPreparing,onRepair)=>{onPreparing();onPreparing(undefined,true);onRepair(1,2);return pixels;});
        const result=await translateImageInOffscreen('manga','en','Page',undefined,'manga-page',true);
        expect(mocks.recognize).not.toHaveBeenCalled();expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
        expect(mocks.mangaDraw).toHaveBeenCalledWith(canvases[0].context,expect.any(Uint8ClampedArray),32,16,[expect.objectContaining({text:'你好',sourceBoxes:regions[0].sourceBoxes})],true,[{color:'rgb(255,255,255)',uniform:false}],undefined);
        expect(mocks.sampleManga.mock.invocationCallOrder[0]).toBeLessThan(mocks.repair.mock.invocationCallOrder[0]);
        expect(mocks.repair.mock.calls[0][7]).toBe(mocks.mangaDraw.mock.calls[0][6]);
        expect(result.lines[0]).toMatchObject({text:'你好',sourceText:'Hello'});
        expect(mocks.encode).toHaveBeenCalledWith(canvases[1],undefined);
        expect(result.image).toBe(''); expect(result.mangaPatches).toMatchObject({width:32,height:16,patches:[{x:1,y:1,width:30,height:14}]});
        expect(canvases[1].context.drawImage).toHaveBeenCalledWith(canvases[0],1,1,30,14,0,0,30,14);expect(canvases[0].toDataURL).not.toHaveBeenCalled();
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageProgress').map(([m])=>m.stage)).toEqual(['preparing','recognizing','translating','cleaning','preparing','initializing','cleaning','rendering']);
        expect(sendMessage).toHaveBeenCalledWith({type:'fluentReadImageProgress',requestId:'manga-page',stage:'cleaning',progress:50},expect.any(Function));
        expect(images[0].src).toBe('');expect(canvases[0].width).toBe(0);
    });
    it('漫画在原像素拷回前冻结同一保护计划，修补与所有绘字共用而不重新推断',async()=>{
        mocks.mangaRecognize.mockResolvedValue([{...lines[0],fontSize:10}]);
        const protection=Object.freeze({originalPixels:true});
        let source:Uint8ClampedArray|undefined;
        mocks.alphaProtection.mockImplementationOnce((pixels,width,height,regions)=>{
            expect([width,height]).toEqual([32,16]);expect(regions[0].text).toBe('你好');
            expect(pixels[0]).toBe(0);source=pixels;return protection;
        });
        mocks.repair.mockImplementationOnce(async(pixels,_w,_h,_regions,_signal,_preparing,_repair,_backgrounds,options)=>{
            expect(pixels).toBe(source);expect(options.protection).toBe(protection);
            return new Uint8ClampedArray(pixels.length).fill(31);
        });
        await translateImageInOffscreen('manga','en','Page',undefined,'shared-protection',true);
        expect(mocks.alphaProtection).toHaveBeenCalledOnce();
        expect(mocks.alphaProtection.mock.invocationCallOrder[0]).toBeLessThan(mocks.repair.mock.invocationCallOrder[0]);
        expect(mocks.mangaDraw.mock.calls[0][1]).toBe(source);expect(source![0]).toBe(31);
        expect(mocks.mangaDraw.mock.calls[0][7]).toBe(protection);
    });
    it('保护计划失败时不启动模型或发布部分译图，并清理原图和画布',async()=>{
        mocks.mangaRecognize.mockResolvedValue([{...lines[0],fontSize:10}]);
        mocks.alphaProtection.mockImplementationOnce(()=>{throw new Error('透明孔保护超出预算');});
        await expect(translateImageInOffscreen('manga','en','Page',undefined,'protection-failed',true)).rejects.toThrow('透明孔保护超出预算');
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(mocks.encode).not.toHaveBeenCalled();
        expect(images[0].src).toBe('');expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
    });
    it('漫画修补完成后取消，不能编码或返回迟到译图',async()=>{
        const controller=new AbortController();mocks.mangaRecognize.mockResolvedValue([{...lines[0],fontSize:10}]);
        mocks.repair.mockImplementationOnce(async pixels=>{controller.abort();return pixels;});
        await expect(translateImageInOffscreen('manga','en','',controller.signal,'cancel-manga',true)).rejects.toThrow('已取消');
        expect(canvases[0].toDataURL).not.toHaveBeenCalled();expect(images[0].src).toBe('');
    });
    it.each([true,false])('漫画独占ImageData启用均匀复用，仅独立修补结果需要拷回：%s',async reuse=>{
        mocks.mangaRecognize.mockResolvedValue([{...lines[0],fontSize:10}]);
        const input=new Uint8ClampedArray(32*16*4).fill(91),set=vi.spyOn(input,'set');
        vi.stubGlobal('document',{createElement:vi.fn(()=>{
            const canvas=makeCanvas();if(canvases.length===1)canvas.context.getImageData.mockReturnValue({data:input});return canvas;
        })});
        mocks.sampleManga.mockReturnValue([{color:'rgb(255,255,255)',uniform:reuse}]);
        mocks.repair.mockImplementationOnce(async(pixels,_w,_h,_regions,_signal,_preparing,_repair,backgrounds,options)=>{
            expect(pixels).toBe(input);expect(backgrounds[0].uniform).toBe(reuse);expect(options).toEqual({reuseUniformPixels:true,protection:undefined});
            if(reuse)return pixels;const result=new Uint8ClampedArray(pixels);result[0]=173;return result;
        });
        await translateImageInOffscreen('manga','en','',undefined,'owned-pixels',true);
        expect(set).toHaveBeenCalledTimes(reuse?0:1);expect(input[0]).toBe(reuse?91:173);
        expect(mocks.mangaDraw.mock.calls[0][1]).toBe(input);
        expect(canvases[0].context.putImageData).toHaveBeenCalledOnce();expect(canvases[0].context.putImageData).toHaveBeenCalledWith({data:input},0,0);
        expect(mocks.encode).toHaveBeenCalledOnce();expect(images[0].src).toBe('');expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
    });
    it.each([false, true])('漫画进度按请求所有权投递，解码宽高可安全回退，带信号=%s', async withSignal => {
        imageOptions.push({naturalWidth: 0, naturalHeight: 0});
        const controller = new AbortController();let notify!: (stage: string, progress?: number) => void;
        mocks.mangaRecognize.mockImplementationOnce(async (_image, _language, width, height, _signal, progress) => {
            expect([width, height]).toEqual([32, 16]);notify = progress;notify('recognizing', 37);
            return [{...lines[0], fontSize: 10}];
        });
        mocks.repair.mockImplementationOnce(async pixels => pixels);
        await translateImageInOffscreen('manga', 'en', '', withSignal ? controller.signal : undefined, 'manga-progress', true);
        const calls = sendMessage.mock.calls.length;controller.abort();notify('recognizing', 98);
        expect(sendMessage).toHaveBeenCalledTimes(calls + (withSignal ? 0 : 1));
    });
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
        expect(result).toEqual({image: 'data:image/png;base64,translated', lines: [{...lines[0], text: '你好', sourceText: 'Hello', backgroundColor: 'transparent'}]});
        expect(images).toHaveLength(1);
        expect(mocks.recognize).toHaveBeenCalledWith('original-image', 'en', controller.signal, {decodedImage:images[0], includeMangaNumericConfidence:true, onProgress:expect.any(Function)});
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

    it('竖排区域只留最小边距，普通横排不按段落总高外扩 (#654)', async () => {
        imageOptions.push({width: 900, height: 700});
        mocks.recognize.mockResolvedValueOnce([
            {text: '第三話', bbox: {x0: 60, y0: 50, x1: 320, y1: 90}},
            {text: '今日は本当に楽しかったね。', bbox: {x0: 598, y0: 101, x1: 762, y1: 290}, vertical: true},
        ]);
        sendMessage.mockImplementation((message, callback) => {
            callback(message.type === 'fluentReadImageTranslateTexts' ? {success: true, translations: ['第三话', '今天真的很开心。']} : undefined);
        });
        const result = await translateImageInOffscreen('manga', 'ja', 'Page');
        expect(result.lines[1]).toMatchObject({text: '今天真的很开心。', vertical: true});
        expect(mocks.draw).toHaveBeenNthCalledWith(1, expect.anything(), '第三话', 58, 43, 264, 54, 'rgb(240,240,240)', 48, 'left');
        expect(mocks.draw).toHaveBeenNthCalledWith(2, expect.anything(), '今天真的很开心。', 595, 99, 170, 193, 'rgb(240,240,240)', Infinity, 'center');
    });

    it.each(['tesseract', 'paddle'] as const)('%s 普通图片将跨行说明整段送翻译，擦除和字号保持源行粒度', async engine => {
        imageOptions.push({width: 390, height: 300});
        const source = [
            {text: 'Calculate the best filament grouping to minimize', bbox: {x0: 61, y0: 78, x1: 325, y1: 90}},
            {text: 'filament waste. Need to manually place filaments on the', bbox: {x0: 61, y0: 92, x1: 367, y1: 104}},
            {text: 'printer based on slicing results.', bbox: {x0: 62, y0: 106, x1: 227, y1: 118}},
        ];
        mocks.recognize.mockResolvedValue(source); mocks.mangaRecognize.mockResolvedValue(source);
        const result = await translateImageInOffscreen('bambu', 'en', 'Bambu', undefined, 'paragraph', false, engine);
        const request = sendMessage.mock.calls.find(([m]) => m.type === 'fluentReadImageTranslateTexts')![0];
        expect(request.texts).toEqual([source.map(line => line.text).join(' ')]);
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].sourceText).toBe(request.texts[0]);
        expect(mocks.inpaint.mock.calls[0][3][0].sourceBoxes).toEqual(source.map(line => line.bbox));
        expect(mocks.draw).toHaveBeenCalledWith(expect.anything(), '你好', 59, 76, 310, 44, 'rgb(240,240,240)', 12 * 1.2, 'left');
        if (engine === 'paddle') expect(mocks.mangaRecognize.mock.calls[0][7]).toBe('image');
    });

    it('Paddle 单图竖排列整段翻译一次，清字仍仅传入原始列框', async () => {
        imageOptions.push({width: 240, height: 200});
        const right = {text: '今日は', bbox: {x0: 90, y0: 20, x1: 102, y1: 120}, vertical: true as const};
        const left = {text: '楽しかった。', bbox: {x0: 76, y0: 21, x1: 88, y1: 120}, vertical: true as const};
        mocks.mangaRecognize.mockResolvedValue([left, right]);
        sendMessage.mockImplementation((message, callback) => callback(message.type === 'fluentReadImageTranslateTexts'
            ? {success: true, translations: ['今天玩得很开心。']} : undefined));
        const result = await translateImageInOffscreen('vertical', 'ja', 'Page', undefined, 'vertical-image', false, 'paddle');
        expect(sendMessage.mock.calls.find(([message]) => message.type === 'fluentReadImageTranslateTexts')![0].texts)
            .toEqual(['今日は楽しかった。']);
        expect(mocks.inpaint.mock.calls[0][3][0]).toMatchObject({sourceBoxes: [right.bbox, left.bbox], fontSize: 12, vertical: true});
        expect(result.lines).toMatchObject([{text: '今天玩得很开心。', sourceText: '今日は楽しかった。'}]);
        expect(mocks.repair).not.toHaveBeenCalled();
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

    it.each([{translations: []}, {translations: ['   ']}])('空缺译文保留原文供核对，不擦除文字或绘制空白 %j', async ({translations}) => {
        sendMessage.mockImplementation((_, callback) => callback({success: true, translations}));
        const result = await translateImageInOffscreen('unchanged', 'en', '');
        expect(result.lines).toEqual([{...lines[0], sourceText: 'Hello', backgroundColor: 'transparent'}]);
        expect(canvases).toHaveLength(0);
    });

    it('无文字明确失败，原样译文仍返回可复制原文且不分配 Canvas', async () => {
        mocks.recognize.mockResolvedValueOnce([]);
        await expect(translateImageInOffscreen('empty', 'en', '')).rejects.toThrow('没有识别到图片文字');
        expect(sendMessage).not.toHaveBeenCalled();
        sendMessage.mockImplementation((_, callback) => callback({success: true, translations: ['Hello']}));
        await expect(translateImageInOffscreen('unchanged', 'en', '')).resolves.toEqual({image: 'unchanged', lines: [{...lines[0], sourceText: 'Hello', backgroundColor: 'transparent'}]});
        expect(canvases).toHaveLength(0);
        expect(images.every(image => image.src === '')).toBe(true);
    });

    it('漫画没有检测到文字时保留原图，不发送翻译请求，也不创建译图或修补', async () => {
        mocks.mangaRecognize.mockResolvedValueOnce([]);
        await expect(translateImageInOffscreen('no-text','ja','',undefined,undefined,true)).resolves.toEqual({image:'no-text',lines:[]});
        expect(sendMessage).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);expect(mocks.repair).not.toHaveBeenCalled();
        expect(images[0].src).toBe('');
    });
    it.each([false, true])('漫画已识别但译文无需变化时只返回轻量结果，尺寸回退=%s', async fallback => {
        if (fallback) imageOptions.push({naturalWidth: 0, naturalHeight: 0});
        mocks.mangaRecognize.mockResolvedValueOnce(lines);
        sendMessage.mockImplementation((message, callback) => callback(message.type === 'fluentReadImageTranslateTexts' ? {success: true, translations: ['Hello']} : undefined));
        const result = await translateImageInOffscreen('same-text', 'en', '', undefined, 'unchanged', true);
        expect(result).toMatchObject({image: '', mangaPatches: {width: 32, height: 16, patches: []}, lines: [{sourceText: 'Hello', text: 'Hello'}]});
        expect(canvases).toHaveLength(0);expect(mocks.repair).not.toHaveBeenCalled();expect(images[0].src).toBe('');
    });
    it('漫画局部画布无法创建上下文时不返回半成品并释放所有图像', async () => {
        mocks.mangaRecognize.mockResolvedValueOnce(lines);mocks.repair.mockImplementationOnce(async pixels => pixels);
        vi.stubGlobal('document', {createElement: () => {
            const canvas = makeCanvas();if (canvases.length === 2) canvas.getContext.mockReturnValue(null);return canvas;
        }});
        await expect(translateImageInOffscreen('patch-failed', 'en', '', undefined, 'patch-failed', true)).rejects.toThrow('浏览器不支持图片处理');
        expect(canvases).toHaveLength(2);expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
        expect(images[0].src).toBe('');expect(mocks.encode).not.toHaveBeenCalled();
    });
    it('文字翻译失败原因穿过 Offscreen 文本客户端', async () => {
        sendMessage.mockImplementation((_message,callback)=>callback({success:false,error:'model not ready',errorCode:'notDownloaded'}));
        await expect(translateImageTextsInExtension(['Hello'],'Page','model-error')).rejects.toMatchObject({errorCode:'notDownloaded'});
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
            if (stage === 'encoding') mocks.encode.mockImplementationOnce(async () => {controller.abort(); return 'cancelled-image';});
            if (stage === 'pixel-read') vi.stubGlobal('document', {createElement: () => {
                const canvas = makeCanvas();
                canvas.context.getImageData.mockImplementation(() => {
                    controller.abort(); return {data: new Uint8ClampedArray(32 * 16 * 4)};
                });
                return canvas;
            }});
            await expect(translateImageInOffscreen('image', 'en', '', controller.signal, 'cancel-render')).rejects.toMatchObject({name: 'AbortError'});
            expect(images[0].src).toBe('');
            expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
            if (stage !== 'encoding') expect(mocks.encode).not.toHaveBeenCalled();
            expect(canvases.every(canvas => canvas.toDataURL.mock.calls.length === 0)).toBe(true);
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
        mocks.encode.mockRejectedValueOnce(new Error('encode failed'));
        await expect(translateImageInOffscreen('image', 'en', '', undefined, 'progress')).rejects.toThrow('encode failed');
        expect(images[0].src).toBe('');
        expect(canvases[0].width).toBe(0);
    });

    it('普通图片复用独占像素，等待异步编码时保留画布，完成后释放', async () => {
        let finish!: (value: string) => void;
        let started!: () => void;
        const encoding = new Promise<void>(resolve => {started = resolve;});
        mocks.encode.mockImplementationOnce(() => new Promise<string>(resolve => {finish = resolve; started();}));
        const operation = translateImageInOffscreen('image', 'en', '');
        await encoding;
        const canvas = canvases[0];
        const source = canvas.context.getImageData.mock.results[0].value;
        expect(mocks.inpaint).toHaveBeenCalledWith(source.data, 32, 16, expect.any(Array), true);
        expect(canvas.context.putImageData).toHaveBeenCalledWith(source, 0, 0);
        expect(canvas.width).toBe(32);
        expect(mocks.encode).toHaveBeenCalledWith(canvas, undefined);
        expect(canvas.toDataURL).not.toHaveBeenCalled();
        finish('encoded-image');
        await expect(operation).resolves.toHaveProperty('image', 'encoded-image');
        expect([canvas.width, canvas.height]).toEqual([0, 0]);
    });
});

describe('Offscreen 圈选裁剪生命周期', () => {
    it.each([false, true])('圈选 OCR=%s 等待可取消的异步 PNG，不同步压缩或提前开始识别', async withOcr => {
        imageOptions.push({width: 40, height: 20});
        let complete!: (image: string) => void;
        mocks.encode.mockImplementationOnce(() => new Promise<string>(resolve => {complete = resolve;}));
        const controller = new AbortController();
        const operation = withOcr ? translateAreaInOffscreen('image', 'en', '', selection, controller.signal)
            : cropAreaInOffscreen('image', selection, controller.signal);
        const outcome = operation.then(result => ({result}), error => ({error}));
        await flushMicrotasks();
        expect(mocks.encode).toHaveBeenCalledWith(canvases[0], controller.signal);
        expect(canvases[0].toDataURL).not.toHaveBeenCalled();
        expect([canvases[0].width, canvases[0].height]).toEqual([20, 10]);
        expect(images[0].src).toBe('');
        expect(mocks.recognize).not.toHaveBeenCalled();
        controller.abort(); complete('late-encoded-crop');
        expect(await outcome).toMatchObject({error: {name: 'AbortError'}});
        expect(mocks.recognize).not.toHaveBeenCalled();
        expect([canvases[0].width, canvases[0].height]).toEqual([0, 0]);
    });
    it('crop-only 不调用 OCR，并在取消时释放图像与画布', async () => {
        imageOptions.push({width: 40, height: 20, naturalWidth: 40, naturalHeight: 20});
        const result = await cropAreaInOffscreen('image', selection);
        expect(result).toEqual({image: 'data:image/png;base64,translated', lines: []});
        expect(mocks.recognize).not.toHaveBeenCalled();
        const controller = new AbortController(); controller.abort();
        await expect(cropAreaInOffscreen('image', selection, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
    });
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
            else mocks.encode.mockImplementationOnce(async () => {controller.abort(); return 'cancelled-crop';});
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

describe('漫画数字证据：保留源文且不发送或重绘独立数字',()=>{
    const numeric={text:'12:34',bbox:{x0:3,y0:7,x1:27,y1:13},numericConfidence:96};
    it.each(['ru','ko'])('纯数字 %s 返回阅读行和空 patches，不访问翻译服务或画布',async language=>{
        mocks.recognize.mockResolvedValueOnce([numeric]);
        const result=await translateImageInOffscreen('numbers',language,'Page',undefined,'numbers-only',true,'paddle');
        expect(mocks.recognize).toHaveBeenCalledWith('numbers',language,undefined,expect.objectContaining({includeMangaNumericConfidence:true}));
        expect(result).toEqual({image:'',mangaPatches:{width:32,height:16,patches:[]},lines:[{text:'12:34',sourceText:'12:34',bbox:numeric.bbox,fontSize:6,sourceBoxes:[numeric.bbox],backgroundColor:'transparent'}]});
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);
    });
    it('数字与正文相邻时独立保留，provider 和清字只接收文字行，返回顺序对应原行',async()=>{
        const label={text:'안녕',bbox:{x0:3,y0:1,x1:24,y1:5}};
        mocks.recognize.mockResolvedValueOnce([label,numeric]);mocks.repair.mockImplementationOnce(async pixels=>pixels);
        const result=await translateImageInOffscreen('mixed','ko','Page',undefined,'numeric-mixed',true,'paddle');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['안녕']);
        expect(result.lines.map(line=>[line.sourceText,line.text])).toEqual([['안녕','你好'],['12:34','12:34']]);
        expect(result.lines[0]).toMatchObject({renderSkipped:true});
        expect(result.mangaPatches?.patches).toEqual([]);
        expect(mocks.repair).not.toHaveBeenCalled();
        expect(mocks.mangaDraw).not.toHaveBeenCalled();
    });
    it('数字在文字之前仍按原顺序返回，多个数字均不送 provider',async()=>{
        const first={...numeric,text:'09:15',bbox:{x0:3,y0:0,x1:15,y1:3}};
        const label={text:'안녕',bbox:{x0:3,y0:5,x1:24,y1:8}};
        mocks.recognize.mockResolvedValueOnce([first,label,numeric]);mocks.repair.mockImplementationOnce(async pixels=>pixels);
        const result=await translateImageInOffscreen('ordered','ko','Page',undefined,'numeric-order',true,'paddle');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['안녕']);
        expect(result.lines.map(line=>line.sourceText)).toEqual(['09:15','안녕','12:34']);
    });
    it('取消后不返回数字阅读结果，也不启动网络和修补',async()=>{
        const controller=new AbortController();mocks.recognize.mockImplementationOnce(async()=>{controller.abort();return [numeric];});
        await expect(translateImageInOffscreen('cancel-numbers','ko','Page',controller.signal,'cancel-numbers',true,'paddle')).rejects.toThrow('已取消');
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);expect(mocks.repair).not.toHaveBeenCalled();
    });
});


describe('漫画数字保护的绘制边界',()=>{
    it.each(['ru','ja'])('%s 的相邻修补框与数字相交时只返回可读译文',async language=>{
        const text={text:language==='ru'?'Привет':'こんにちは',bbox:{x0:2,y0:2,x1:11,y1:6},fontSize:4,sourceBoxes:[{x0:2,y0:2,x1:11,y1:6}]};
        const number={text:'12:34',bbox:{x0:12,y0:2,x1:27,y1:6},fontSize:4,sourceBoxes:[{x0:12,y0:2,x1:27,y1:6}]};
        if(language==='ru') mocks.recognize.mockResolvedValueOnce([{...text},{...number,numericConfidence:97}]);
        else mocks.mangaRecognize.mockResolvedValueOnce([text,number]);
        const result=await translateImageInOffscreen('collision',language,'Page',undefined,'collision',true);
        expect(result.lines.map(line=>line.sourceText)).toEqual(expect.arrayContaining([text.text,number.text]));
        expect(result.lines.find(line=>line.sourceText===text.text)).toMatchObject({text:'你好',renderSkipped:true});
        expect(result.mangaPatches?.patches).toEqual([]);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
        expect(sendMessage.mock.calls.filter(([message])=>message.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual([text.text]);
    });
    it('间距足够时只绘制非数字区域',async()=>{
        imageOptions.push({width:100,height:80});
        const text={text:'안녕',bbox:{x0:2,y0:2,x1:25,y1:10}};
        const number={text:'12:34',bbox:{x0:50,y0:40,x1:80,y1:50},numericConfidence:98};
        mocks.recognize.mockResolvedValueOnce([text,number]);mocks.repair.mockImplementationOnce(async pixels=>pixels);
        const result=await translateImageInOffscreen('separate','ko','Page',undefined,'separate',true);
        expect(mocks.repair.mock.calls[0][3]).toHaveLength(1);
        expect(mocks.mangaDraw.mock.calls[0][4][0].text).toBe('你好');
        expect(result.lines.every(line=>!line.renderSkipped)).toBe(true);
    });
});


it('相邻数字与远处正文同时存在时，模拟修补像素只触及远处正文',async()=>{
    imageOptions.push({width:100,height:80});
    const close={text:'Привет',bbox:{x0:2,y0:2,x1:19,y1:10}};
    const numeric={text:'12:34',bbox:{x0:20,y0:2,x1:40,y1:10},numericConfidence:98};
    const distant={text:'Пока',bbox:{x0:4,y0:50,x1:35,y1:60}};
    mocks.recognize.mockResolvedValueOnce([close,numeric,distant]);
    sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['你好','再见']}:undefined));
    let raster:Uint8ClampedArray|undefined;
    mocks.repair.mockImplementationOnce(async(pixels,width,height,regions)=>{
        raster=pixels;for(const region of regions)for(const b of mangaMaskBoxes(region,width,height))
            for(let y=b.y0;y<b.y1;y++)for(let x=b.x0;x<b.x1;x++)pixels[(y*width+x)*4]=255;
        return pixels;
    });
    const result=await translateImageInOffscreen('pixel-conflict','ru','Page',undefined,'pixels',true);
    expect(result.lines.find(line=>line.sourceText===close.text)).toMatchObject({renderSkipped:true});
    expect(result.lines.find(line=>line.sourceText===distant.text)).not.toHaveProperty('renderSkipped');
    expect(raster).toBeDefined();
    for(let y=numeric.bbox.y0;y<numeric.bbox.y1;y++)for(let x=numeric.bbox.x0;x<numeric.bbox.x1;x++)
        expect(raster![(y*100+x)*4]).toBe(0);
    expect(raster![(55*100+10)*4]).toBe(255);
});


describe('漫画与普通图片数值保护',()=>{
    const box={x0:50,y0:40,x1:80,y1:50};
    it('密集数值重复框不提前耗尽预算，远处真实修补仍不触及数字像素',async()=>{
        const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
        const numbers=Array.from({length:600},(_,i)=>({text:'90%',confidence:.99,
            box:{x:100+(i%30)*20,y:100+Math.floor(i/30)*20,width:10,height:10}}));
        const regions=collectMangaRegions({results:numbers,numericEvidence:numbers},'en',1000,1000,'manga');
        expect(regions).toHaveLength(600);expect(regions.some(line=>line.guardOnly)).toBe(false);
        const bbox={x0:2,y0:2,x1:10,y1:10};
        const label={text:'Hello',bbox,fontSize:8,sourceBoxes:Array.from({length:900},()=>({...bbox}))};
        imageOptions.push({width:1000,height:1000});mocks.mangaRecognize.mockResolvedValueOnce([label,...regions]);
        let pixels:Uint8ClampedArray|undefined;
        vi.stubGlobal('document',{createElement:vi.fn(()=>{const canvas=makeCanvas();canvas.context.getImageData.mockImplementation(()=>{
            pixels=new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255);pixels[(5*1000+5)*4]=0;pixels[(105*1000+105)*4]=0;return {data:pixels};
        });return canvas;})});
        const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/mangaInpainting')>('@/src/features/image-translation/services/mangaInpainting');
        mocks.repair.mockImplementationOnce(async(data,width,height,translated)=>{
            for(const region of translated){const patch=actual.createMangaPatch(data,width,height,region);
                actual.applyMangaPatch(data,width,region,patch,new Float32Array(patch.patch.width*patch.patch.height*3).fill(1));}
            return data;
        });
        const result=await translateImageInOffscreen('dense','en','Page',undefined,'dense-numbers',true,'paddle');
        expect(result.lines[0]).toMatchObject({sourceText:'Hello',text:'你好'});expect(result.lines[0]).not.toHaveProperty('renderSkipped');
        expect(mocks.repair).toHaveBeenCalledOnce();expect(pixels![(5*1000+5)*4]).toBe(255);
        expect(pixels![(105*1000+105)*4]).toBe(0);
    });
    it('保护比较预算耗尽时即使数字并不邻近也保守跳过绘制并返回阅读译文',async()=>{
        imageOptions.push({width:100,height:80});
        const bbox={x0:2,y0:2,x1:10,y1:10};
        const text={text:'Hello',bbox,fontSize:8,sourceBoxes:Array.from({length:1001},()=>({...bbox}))};
        const numbers=Array.from({length:1000},()=>({text:'90%',bbox:{x0:80,y0:60,x1:90,y1:70},fontSize:10}));
        mocks.mangaRecognize.mockResolvedValueOnce([text,...numbers]);
        const result=await translateImageInOffscreen('budget','en','Page',undefined,'numeric-budget',true,'paddle');
        expect(result.lines[0]).toMatchObject({sourceText:'Hello',text:'你好',renderSkipped:true});
        expect(result.mangaPatches?.patches).toEqual([]);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
    });
    it.each(['90%','９０％','3.14','3,14','1,000','1,000,000','1 000','90 %','1,234.50','€1.234,56','1.234,50 €','3,14%','38,5°C','−20','1/2','38°C'])('单图从 Tesseract 原始单词结果提取 %s 并保护原值',async text=>{
        const {normalizeOcrLineViews}=await import('@/src/features/image-translation/core');
        const raw=[{paragraphs:[{lines:[{text,bbox:box,confidence:99,words:[{text,bbox:box,confidence:99}]}]}]}];
        const recognized=normalizeOcrLineViews(raw).manga;
        expect(recognized).toMatchObject([{text,bbox:box,numericConfidence:99}]);
        imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce(recognized);
        const result=await translateImageInOffscreen('numbers','ja','Page',undefined,'image-raw',false,'tesseract');
        expect(result.lines.map(line=>line.text)).toEqual([text]);expect(result.image).toBe('numbers');
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();
    });
    it.each(['42','08:45','$19.99','90%','９０％','3.14','3,14','1,000','1,000,000','1 000','90 %','1,234.50','€1.234,56','1.234,50 €','3,14%','38,5°C','−20','1/2','38°C'])('单图 Paddle 数值 %s 只读原文，不发翻译和画布',async text=>{
        const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
        const recognized=collectMangaRegions({results:[{text,confidence:.99,box:{x:50,y:40,width:30,height:10}}]},'ja',100,80,'image');
        imageOptions.push({width:100,height:80});mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        const result=await translateImageInOffscreen('numbers','ja','Page',undefined,'image-paddle',false,'paddle');
        expect(result.lines.map(line=>[line.sourceText,line.text])).toEqual([[text,text]]);
        expect(result.image).toBe('numbers');
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);
    });
    it.each(['1','７','42','08:45','$19.99','90%','９０％','3.14','3,14','1,000','1,000,000','1 000','90 %','1,234.50','€1.234,56','1.234,50 €','3,14%','38,5°C','−20','1/2','38°C'])('单图 Tesseract 数值 %s 只读原文，不发翻译和画布',async text=>{
        imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce([{text,bbox:box,numericConfidence:99}]);
        const result=await translateImageInOffscreen('numbers','ja','Page',undefined,'image-tesseract',false,'tesseract');
        expect(result.lines.map(line=>[line.sourceText,line.text])).toEqual([[text,text]]);
        expect(result.image).toBe('numbers');
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.inpaint).not.toHaveBeenCalled();expect(mocks.draw).not.toHaveBeenCalled();expect(canvases).toHaveLength(0);
    });
    it.each(['paddle','tesseract'] as const)('单图 %s 将邻近冲突对白保留为阅读译文，只对远处正文执行真实修补',async engine=>{
        const close={text:'Close',bbox:{x0:2,y0:2,x1:19,y1:10}};
        const numeric={text:'90%',bbox:{x0:20,y0:2,x1:40,y1:10}};
        const distant={text:'Away',bbox:{x0:4,y0:50,x1:35,y1:60}};
        imageOptions.push({width:100,height:80});
        if(engine==='tesseract')mocks.recognize.mockResolvedValueOnce([close,{...numeric,numericConfidence:99},distant]);
        else {
            const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
            const items=[close,numeric,distant].map(({text,bbox})=>({text,confidence:.99,box:{x:bbox.x0,y:bbox.y0,width:bbox.x1-bbox.x0,height:bbox.y1-bbox.y0}}));
            mocks.mangaRecognize.mockResolvedValueOnce(collectMangaRegions({results:items},'en',100,80,'image'));
        }
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
        const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/inpainting')>('@/src/features/image-translation/services/inpainting');
        let pixels:Uint8ClampedArray|undefined;let original:Uint8ClampedArray|undefined;
        vi.stubGlobal('document',{createElement:vi.fn(()=>{
            const canvas=makeCanvas();canvas.context.getImageData.mockImplementation(()=>{
                pixels=new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255);
                for(let y=2;y<10;y++)for(let x=20;x<40;x++)pixels[(y*100+x)*4]=0;
                for(let y=50;y<60;y++)for(let x=4;x<35;x++)pixels[(y*100+x)*4]=0;
                original=pixels.slice();return {data:pixels};
            });return canvas;
        })});
        mocks.inpaint.mockImplementation(actual.inpaintTextRegions);
        const result=await translateImageInOffscreen('mixed','en','Page',undefined,'collision',false,engine);
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['Close','Away']);
        expect(result.lines.find(line=>line.sourceText==='90%')).toMatchObject({text:'90%'});
        expect(result.lines.find(line=>line.sourceText==='Close')).toMatchObject({text:'近',renderSkipped:true});
        expect(result.lines.find(line=>line.sourceText==='Away')).toMatchObject({text:'远'});
        expect(mocks.inpaint.mock.calls[0][3]).toHaveLength(1);expect(mocks.inpaint.mock.calls[0][3][0].text).toBe('远');
        expect(mocks.draw).toHaveBeenCalledOnce();expect(pixels).toBeDefined();
        for(let y=2;y<10;y++)for(let x=20;x<40;x++) {const i=(y*100+x)*4;expect(pixels!.slice(i,i+4)).toEqual(original!.slice(i,i+4));}
        expect(pixels![(55*100+10)*4]).not.toBe(original![(55*100+10)*4]);
    });
});


describe('低置信数值物理保护',()=>{
    it('Tesseract 混排行低分数值词被过滤时，保留物理框并阻止邻近文字擦图',async()=>{
        const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
        const label={x0:2,y0:2,x1:19,y1:10},number={x0:20,y0:2,x1:40,y1:10};
        const raw=[{text:'SALE 90%',bbox:{x0:2,y0:2,x1:40,y1:10},confidence:99,
            words:[{text:'SALE',bbox:label,confidence:99},{text:'90%',bbox:number,confidence:20}]},
            {text:'Away',bbox:{x0:4,y0:50,x1:35,y1:60},confidence:99}];
        const blocks=[{paragraphs:[{lines:raw}]}],parsed=normalizeOcrLineViews(blocks).manga;
        const recognized=[...parsed,...collectRawNumericGuards(blocks,parsed)];
        expect(recognized.filter(line=>line.guardOnly)).toEqual([{text:'',bbox:number,guardOnly:true}]);
        imageOptions.push({width:100,height:80});mocks.recognize.mockResolvedValueOnce(recognized);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['促销','远']}:undefined));
        const result=await translateImageInOffscreen('mixed-word','en','Page',undefined,'mixed-word',false,'tesseract');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['SALE','Away']);
        expect(result.lines.map(line=>line.sourceText)).toEqual(['SALE','Away']);
        expect(result.lines[0]).toMatchObject({text:'促销',renderSkipped:true});expect(result.lines[1]).not.toHaveProperty('renderSkipped');
        expect(mocks.inpaint.mock.calls[0][3]).toHaveLength(1);expect(mocks.inpaint.mock.calls[0][3][0].text).toBe('远');
    });
    it.each(['paddle-manga-low','paddle-manga-missing','paddle-image-low','paddle-image-missing','paddle-image-single','tesseract-manga-low','tesseract-manga-missing','tesseract-image-below-threshold'] as const)('%s 仅保护疑似数值，保留远处译文且不向服务发送数字',async scenario=>{
        const manga=scenario.includes('manga'),engine=scenario.startsWith('paddle')?'paddle':'tesseract';
        const sourceLanguage=engine==='tesseract'&&manga?'ko':'en';
        const close={text:sourceLanguage==='ko'?'안녕':'Close',bbox:{x0:2,y0:2,x1:19,y1:10}};
        const number={text:scenario.endsWith('single')?'1':'90%',bbox:{x0:20,y0:2,x1:40,y1:10}};
        const distant={text:sourceLanguage==='ko'?'다음':'Away',bbox:{x0:4,y0:50,x1:35,y1:60}};
        imageOptions.push({width:100,height:80});
        if(engine==='paddle'){
            const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
            const items=[close,number,distant].map(({text,bbox},i)=>({text,confidence:i===1?(scenario.endsWith('missing')?undefined!:scenario.endsWith('single')?.99:.89):.99,box:{x:bbox.x0,y:bbox.y0,width:bbox.x1-bbox.x0,height:bbox.y1-bbox.y0}}));
            const recognized=collectMangaRegions({results:items},sourceLanguage,100,80,manga?'manga':'image');
            expect(recognized.filter(line=>!line.guardOnly).map(line=>line.text)).toEqual([close.text,distant.text]);
            expect(recognized.some(line=>line.guardOnly)).toBe(true);mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        }else {
            const {normalizeOcrLineViews,collectRawNumericGuards}=await import('@/src/features/image-translation/core');
            const numberConfidence=scenario.endsWith('missing')?undefined:scenario.endsWith('threshold')?20:89;
            const raw=[close,number,distant].map(({text,bbox},i)=>({text,bbox,confidence:i===1?numberConfidence:99,words:[{text,bbox,confidence:i===1?numberConfidence:99}]}));
            const blocks=[{paragraphs:[{lines:raw}]}];
            const recognized=[...normalizeOcrLineViews(blocks).manga,...collectRawNumericGuards(blocks)];
            mocks.recognize.mockResolvedValueOnce(recognized);
        }
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
        let pixels:Uint8ClampedArray|undefined;let original:Uint8ClampedArray|undefined;
        vi.stubGlobal('document',{createElement:vi.fn(()=>{
            const canvas=makeCanvas();canvas.context.getImageData.mockImplementation(()=>{
                pixels=new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255);
                pixels[(5*100+20)*4]=0;
                for(let y=50;y<60;y++)for(let x=4;x<35;x++)pixels[(y*100+x)*4]=0;
                original=pixels.slice();return {data:pixels};
            });return canvas;
        })});
        if(manga){
            const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/mangaInpainting')>('@/src/features/image-translation/services/mangaInpainting');
            mocks.repair.mockImplementationOnce(async(pixels,width,height,regions)=>{
                for(const region of regions){const patch=actual.createMangaPatch(pixels,width,height,region);const white=new Float32Array(patch.patch.width*patch.patch.height*3).fill(1);actual.applyMangaPatch(pixels,width,region,patch,white);}return pixels;
            });
        }else {
            const actual=await vi.importActual<typeof import('@/src/features/image-translation/services/inpainting')>('@/src/features/image-translation/services/inpainting');
            mocks.inpaint.mockImplementation(actual.inpaintTextRegions);
        }
        const result=await translateImageInOffscreen('mixed',sourceLanguage,'Page',undefined,'numeric-negative',manga,engine);
        expect(result.lines.map(line=>line.sourceText)).toEqual([close.text,distant.text]);
        expect(result.lines[0]).toMatchObject({renderSkipped:true});
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual([close.text,distant.text]);
        expect(pixels).toBeDefined();
        expect(pixels![(5*100+20)*4]).toBe(original![(5*100+20)*4]);
        expect(pixels![(55*100+10)*4]).not.toBe(original![(55*100+10)*4]);
    });
    it('低分数字形态的绘画噪声只参与保护，但会保守跳过邻近译文',async()=>{
        const {collectMangaRegions}=await import('@/src/features/image-translation/services/mangaBubbles');
        const close={text:'Close',confidence:.99,box:{x:2,y:2,width:17,height:8}};
        const artifact={text:'90%',confidence:.2,box:{x:20,y:2,width:20,height:8}};
        const far={text:'Away',confidence:.99,box:{x:4,y:50,width:31,height:10}};
        const recognized=collectMangaRegions({results:[close,artifact,far]},'en',100,80,'image');
        imageOptions.push({width:100,height:80});mocks.mangaRecognize.mockResolvedValueOnce(recognized);
        sendMessage.mockImplementation((message,callback)=>callback(message.type==='fluentReadImageTranslateTexts'?{success:true,translations:['近','远']}:undefined));
        const result=await translateImageInOffscreen('art-noise','en','Page',undefined,'art-noise',false,'paddle');
        expect(result.lines.map(line=>line.sourceText)).toEqual(['Close','Away']);
        expect(result.lines[0]).toMatchObject({text:'近',renderSkipped:true});
        expect(result.lines[1]).not.toHaveProperty('renderSkipped');
        expect(sendMessage.mock.calls.filter(([m])=>m.type==='fluentReadImageTranslateTexts')[0][0].texts).toEqual(['Close','Away']);
    });
    it.each(['invalid','too-many'] as const)('保护框 %s 时明确报错，不请求翻译或发布部分图片',async problem=>{
        imageOptions.push({width:100,height:80});
        const label={text:'Hello',bbox:{x0:1,y0:1,x1:10,y1:8},fontSize:7};
        const guards=problem==='invalid'?[{text:'',bbox:{x0:NaN,y0:1,x1:10,y1:8},guardOnly:true}]
            :Array.from({length:4097},(_,i)=>({text:'',bbox:{x0:i/100,y0:10,x1:i/100+.5,y1:11},guardOnly:true}));
        mocks.mangaRecognize.mockResolvedValueOnce([label,...guards]);
        await expect(translateImageInOffscreen('guard-error','en','Page',undefined,'guard-error',true,'paddle'))
            .rejects.toThrow(problem==='invalid'?'图片数字保护位置无效':'图片数字保护区域过于复杂');
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);
        expect(mocks.repair).not.toHaveBeenCalled();expect(mocks.mangaDraw).not.toHaveBeenCalled();
    });
    it('完全位于原图外的疑似框不阻止正文翻译',async()=>{
        const label={text:'Hello',bbox:{x0:2,y0:2,x1:10,y1:8},fontSize:6};
        const outside={text:'',bbox:{x0:200,y0:200,x1:210,y1:210},guardOnly:true};
        imageOptions.push({width:100,height:80});mocks.mangaRecognize.mockResolvedValueOnce([label,outside]);
        mocks.repair.mockImplementationOnce(async pixels=>pixels);
        const result=await translateImageInOffscreen('outside-guard','en','Page',undefined,'outside-guard',true,'paddle');
        expect(result.lines).toHaveLength(1);expect(result.lines[0]).not.toHaveProperty('renderSkipped');
        expect(mocks.repair).toHaveBeenCalledOnce();
    });
    it('含疑似数值的识别结果在取消后不发翻译也不发布图像',async()=>{
        const controller=new AbortController();
        mocks.mangaRecognize.mockImplementationOnce(async()=>{controller.abort();return [{text:'',bbox:{x0:1,y0:1,x1:10,y1:8},guardOnly:true}];});
        await expect(translateImageInOffscreen('guard-cancel','en','Page',controller.signal,'guard-cancel',true,'paddle')).rejects.toMatchObject({name:'AbortError'});
        expect(sendMessage.mock.calls.some(([m])=>m.type==='fluentReadImageTranslateTexts')).toBe(false);expect(mocks.repair).not.toHaveBeenCalled();
    });
});

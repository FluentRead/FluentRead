import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createSharedOcrTasks} from '@/src/features/image-translation/services/sharedOcrTasks';

const {recognize, ensureLanguages, clearModels, disposeWorker, removeFiles, createRuntime, tesseractCreateWorker, prefetchModels} = vi.hoisted(() => ({
    clearModels: vi.fn(async (remove: () => Promise<void>) => remove()), removeFiles: vi.fn(async () => {}), recognize: vi.fn(), ensureLanguages: vi.fn(), createRuntime: vi.fn(), tesseractCreateWorker: vi.fn(),
    prefetchModels: vi.fn(async () => {}),
    disposeWorker: vi.fn(),
}));
vi.mock('@/src/features/image-translation/services/ocrModelDownload', () => ({prefetchOcrModelFiles: prefetchModels}));
// Keep the production cancellable encoder; control only Canvas and FileReader.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=';
const ENCODED_PNG = `data:image/png;base64,${PNG_BASE64}`;
vi.mock('@/src/features/image-translation/services/ocrWorkerRuntime', () => ({
    createOcrWorkerRuntime: createRuntime,
}));
vi.mock('@/src/features/image-translation/services/ocrModelCache', () => ({removeOcrModelFiles: removeFiles}));
vi.mock('tesseract.js', () => ({createWorker: tesseractCreateWorker, PSM: {SPARSE_TEXT: 11, SPARSE_TEXT_OSD: 12, SINGLE_BLOCK: 6}}));

const blockResult = () => ({data: {blocks: [{paragraphs: [{lines: [{
    text: 'hello', bbox: {x0: 10, y0: 10, x1: 50, y1: 30},
}]}]}]}});

describe('图片 OCR 处理与结果缓存', () => {
    let recognizeImage: typeof import('@/src/features/image-translation/services/ocrRuntime')['recognizeImage'];
    let dimensions: {width: number; height: number};
    let sources: Array<{src: string; onload: (() => void) | null; onerror: (() => void) | null}>;
    let canvas: {width: number; height: number; getContext: ReturnType<typeof vi.fn>; toDataURL: ReturnType<typeof vi.fn>; toBlob: ReturnType<typeof vi.fn>};
    let pngBlob: Blob;
    let encodedSizes: Array<{width: number; height: number}>;
    let readers: Array<{result: string | null; readyState: number; onload: (() => void) | null; onerror: (() => void) | null; readAsDataURL: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>}>;
    let sourcePixels: Uint8ClampedArray;
    let context: {drawImage: ReturnType<typeof vi.fn>; getImageData: ReturnType<typeof vi.fn>; putImageData: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>; fillStyle: string; imageSmoothingEnabled: boolean; imageSmoothingQuality: string};
    let onImageCreated: (() => void) | undefined;

    it.each(['invalid','too-many'] as const)('只读圈选忽略 %s 的低分数字噪声，正常返回正文',async problem=>{
        const word={text:'HELLO',bbox:{x0:30,y0:30,x1:90,y1:50},confidence:99};
        const noisy=problem==='invalid'?[{text:'90%',bbox:{x0:NaN,y0:20,x1:30,y1:30},confidence:20}]
            :Array.from({length:4097},()=>({text:'90%',bbox:{x0:10,y0:10,x1:20,y1:20},confidence:20}));
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[word,...noisy]}]}]}});
        const lines=await recognizeImage('area-noise','en',undefined,{profile:'area'});
        expect(lines.map(line=>line.text)).toEqual(['HELLO']);expect(recognize).toHaveBeenCalledOnce();
    });
    it.each([20,99])('Tesseract 混排行数字词置信 %i 仍保留独立防擦框',async confidence=>{
        const word={x0:20,y0:10,x1:40,y1:20},label={x0:2,y0:10,x1:19,y1:20};
        const raw={text:'SALE 90%',bbox:{x0:2,y0:10,x1:40,y1:20},confidence:99,
            words:[{text:'SALE',bbox:label,confidence:99},{text:'90%',bbox:word,confidence}]};
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[raw]}]}]}});
        const lines=await recognizeImage('mixed-raw','en',undefined,{includeMangaNumericConfidence:true});
        expect(lines.filter(line=>line.guardOnly)).toEqual([{text:'',bbox:word,guardOnly:true}]);
        expect(lines.some(line=>!line.guardOnly&&line.text.startsWith('SALE'))).toBe(true);
        expect(recognize).toHaveBeenCalledOnce();
    });
    it('混排行数值词坐标非法时明确失败，不发布潜在破坏图片',async()=>{
        const raw={text:'SALE 90%',bbox:{x0:2,y0:10,x1:40,y1:20},confidence:99,
            words:[{text:'SALE',bbox:{x0:2,y0:10,x1:19,y1:20},confidence:99},{text:'90%',bbox:{x0:NaN,y0:10,x1:40,y1:20},confidence:20}]};
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[raw]}]}]}});
        await expect(recognizeImage('mixed-invalid','en',undefined,{includeMangaNumericConfidence:true})).rejects.toThrow('图片数字保护位置无效');
    });
    it('首轮低分数字在回退识别后仍作为防擦框保留，缓存复用不泄漏到普通视图',async()=>{
        const first={x0:10,y0:10,x1:30,y1:20},second={x0:50,y0:10,x1:70,y1:20};
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[{text:'90%',bbox:first,confidence:20}]}]}]}});
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[{text:'HELLO',bbox:{x0:10,y0:50,x1:50,y1:60},confidence:99},
            {text:'3,14',bbox:second,confidence:30}]}]}]}});
        const manga=await recognizeImage('guard-fallback','ko',undefined,{includeMangaNumericConfidence:true});
        expect(recognize).toHaveBeenCalledTimes(2);
        expect(manga.filter(line=>line.guardOnly).map(line=>line.bbox)).toEqual([second,first]);
        const normal=await recognizeImage('guard-fallback','ko');
        expect(normal.some(line=>line.guardOnly)).toBe(false);expect(recognize).toHaveBeenCalledTimes(2);
        manga.find(line=>line.guardOnly)!.bbox.x0=999;
        expect((await recognizeImage('guard-fallback','ko',undefined,{includeMangaNumericConfidence:true})).filter(line=>line.guardOnly).map(line=>line.bbox)).toEqual([second,first]);
    });
    it('首次与回退的数值保护框合计超预算时报告错误而不缓存部分结果',async()=>{
        const make=(base:number)=>Array.from({length:2050},(_,i)=>{const x=(base+i)%90,y=Math.floor((base+i)/90);
            return {text:'90%',bbox:{x0:x,y0:y,x1:x+.5,y1:y+.5},confidence:20};});
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:make(0)}]}]}})
            .mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[{text:'HELLO',bbox:{x0:1,y0:50,x1:20,y1:60},confidence:99},...make(2050)]}]}]}});
        await expect(recognizeImage('guard-fallback-limit','en',undefined,{includeMangaNumericConfidence:true})).rejects.toThrow('保护区域过于复杂');
        expect(recognize).toHaveBeenCalledTimes(2);
        expect(await recognizeImage('guard-fallback-limit','en')).toEqual([{text:'hello',bbox:{x0:10,y0:10,x1:50,y1:30}}]);
        expect(recognize).toHaveBeenCalledTimes(3);
    });
    it('首次与回退中相同坐标只保留一个保护框',async()=>{
        const bbox={x0:10,y0:10,x1:30,y1:20},number={text:'90%',bbox,confidence:20};
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[number]}]}]}})
            .mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[{text:'HELLO',bbox:{x0:1,y0:50,x1:20,y1:60},confidence:99},number]}]}]}});
        const result=await recognizeImage('guard-fallback-duplicate','en',undefined,{includeMangaNumericConfidence:true});
        expect(result.filter(line=>line.guardOnly)).toEqual([{text:'',bbox,guardOnly:true}]);
    });
    it.each([false,true])('共享 OCR 一方取消时防擦框仍随有效视图与缓存返回，取消保护视图=%s',async cancelProtected=>{
        const bbox={x0:10,y0:10,x1:30,y1:20};
        const result={data:{blocks:[{paragraphs:[{lines:[{text:'HELLO',bbox:{x0:10,y0:50,x1:50,y1:60},confidence:99},
            {text:'90%',bbox,confidence:20}]}]}]}};
        let complete!:(value:typeof result)=>void;let underlying!:AbortSignal;
        recognize.mockImplementationOnce((_image,_languages,signal)=>{underlying=signal;return new Promise(resolve=>{complete=resolve;});});
        const controller=new AbortController();
        const ordinary=recognizeImage('shared-low-guard','ko',cancelProtected?undefined:controller.signal);
        const protectedView=recognizeImage('shared-low-guard','ko',cancelProtected?controller.signal:undefined,{includeMangaNumericConfidence:true});
        const rejected=expect(cancelProtected?protectedView:ordinary).rejects.toMatchObject({name:'AbortError'});
        await vi.waitFor(()=>expect(recognize).toHaveBeenCalledOnce());controller.abort();await rejected;expect(underlying.aborted).toBe(false);
        complete(result);const remaining=await(cancelProtected?ordinary:protectedView);
        expect(remaining.some(line=>line.guardOnly)).toBe(!cancelProtected);
        const cached=await recognizeImage('shared-low-guard','ko',undefined,{includeMangaNumericConfidence:true});
        expect(cached.filter(line=>line.guardOnly)).toEqual([{text:'',bbox,guardOnly:true}]);
        expect((await recognizeImage('shared-low-guard','ko')).some(line=>line.guardOnly)).toBe(false);
        expect(recognize).toHaveBeenCalledOnce();
    });

    it.each([false,true])('漫画数字证据与普通调用共享同一 OCR 缓存且普通返回不泄漏置信：漫画先=%s', async mangaFirst => {
        const bbox={x0:10,y0:10,x1:50,y1:30};
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[{text:'12:34',bbox,words:[{text:'12:34',bbox,confidence:96}]}]}]}]}});
        const options=mangaFirst?{includeMangaNumericConfidence:true}:undefined;
        const first=await recognizeImage('shared-numeric','ko',undefined,options);
        const second=await recognizeImage('shared-numeric','ko',undefined,mangaFirst?undefined:{includeMangaNumericConfidence:true});
        const [manga,ordinary]=mangaFirst?[first,second]:[second,first];
        expect(recognize).toHaveBeenCalledOnce();expect(manga[0]).toMatchObject({text:'12:34',bbox,numericConfidence:96});
        expect(ordinary).toEqual([{text:'12:34',bbox}]);
        (manga[0] as any).numericConfidence=1;
        expect((await recognizeImage('shared-numeric','ko',undefined,{includeMangaNumericConfidence:true}))[0]).toMatchObject({numericConfidence:96});
    });
    it.each([false,true])('竖排数字与对白仅漫画视图分开且复用识别，漫画先=%s', async mangaFirst=>{
        const numericBox={x0:70,y0:10,x1:90,y1:70},textBox={x0:45,y0:10,x1:65,y1:70};
        const make=(text:string,bbox:typeof numericBox)=>({text,bbox,baseline:{x0:bbox.x0+10,y0:bbox.y0,x1:bbox.x0+11,y1:bbox.y1},words:[{text,bbox,confidence:98}]});
        recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[make('12:34',numericBox),make('안녕하세요',textBox)]}]}]}});
        const options={includeMangaNumericConfidence:true};
        const first=await recognizeImage('vertical-mixed','ko',undefined,mangaFirst?options:{});
        const second=await recognizeImage('vertical-mixed','ko',undefined,mangaFirst?{}:options);
        const [manga,ordinary]=mangaFirst?[first,second]:[second,first];
        expect(recognize).toHaveBeenCalledOnce();expect(ordinary).toHaveLength(1);
        expect(manga).toHaveLength(2);expect(manga[0]).toMatchObject({text:'12:34',numericConfidence:98});
        expect(manga[1].text).toBe('안녕하세요');
    });
    it('漫画数字证据随降采样坐标回映，不改变原始置信', async()=>{
        const bbox={x0:10,y0:10,x1:50,y1:30};recognize.mockResolvedValueOnce({data:{blocks:[{paragraphs:[{lines:[{text:'12:34',bbox,words:[{text:'12:34',bbox,confidence:94}]}]}]}]}});
        const decoded={naturalWidth:2048,naturalHeight:8192,src:'borrowed'} as HTMLImageElement;
        expect(await recognizeImage('data:image/jpeg;base64,numeric','ru',undefined,{decodedImage:decoded,includeMangaNumericConfidence:true})).toEqual([{text:'12:34',bbox:{x0:20,y0:20,x1:100,y1:60},numericConfidence:94}]);
    });
    it('把任务进度回调传入 OCR Worker，缓存命中不重放旧识别进度', async () => {
        const onProgress = vi.fn();
        recognize.mockImplementationOnce(async (_image, _languages, _signal, _mode, progress) => {progress(42);return blockResult();});
        await recognizeImage('progress', 'en', undefined, {onProgress});
        expect(onProgress).toHaveBeenCalledOnce(); expect(onProgress).toHaveBeenCalledWith(42);
        await recognizeImage('progress', 'en', undefined, {onProgress});
        expect(onProgress).toHaveBeenCalledOnce();
    });
    it.each(['avif', 'webp', 'svg+xml', 'gif'])('浏览器已解码的 %s 以原尺寸 PNG 送入 OCR，不把不支持的编码交给内核', async format => {
        const decoded = {naturalWidth: 900, naturalHeight: 2595, src: 'owned'} as HTMLImageElement;
        const lines = await recognizeImage(`data:image/${format};base64,example`, 'ru', undefined, {decodedImage: decoded});
        expect(context.drawImage).toHaveBeenCalledWith(decoded, 0, 0, 900, 2595);
        expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
        expect(canvas.toDataURL).not.toHaveBeenCalled();
        expect(encodedSizes).toEqual([{width: 900, height: 2595}]);
        expect(readers).toHaveLength(1);
        expect(readers[0].readAsDataURL).toHaveBeenCalledWith(pngBlob);
        expect(pngBlob.type).toBe('image/png');
        expect(new Uint8Array(await pngBlob.arrayBuffer())).toEqual(Uint8Array.from(atob(PNG_BASE64), byte => byte.charCodeAt(0)));
        expect(readers[0]).toMatchObject({readyState: 2, onload: null, onerror: null});
        expect(recognize).toHaveBeenCalledWith(ENCODED_PNG, 'rus+eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(lines).toEqual([{text: 'hello', bbox: {x0: 10, y0: 10, x1: 50, y1: 30}}]);
        expect(decoded.src).toBe('owned');expect(sources).toHaveLength(0);
        expect(canvas.width).toBe(0);expect(canvas.height).toBe(0);
    });
    it.each([
        'data:image/jpeg;base64,exif-rotated',
        'data:image/jpg;base64,exif-rotated',
        'DATA:IMAGE/JPEG;BASE64,exif-rotated',
        'data:image/jpeg;charset=binary;base64,exif-rotated',
        'data:image/JPG;CHARSET=binary;base64,exif-rotated',
    ])('JPEG 编码 %s 使用浏览器已完成方向纠正的自然尺寸 PNG，保持文字坐标和源所有权', async input => {
        // 浏览器已根据 EXIF 将横向编码像素转为纵向图；显示尺寸不应影响 OCR 的原图坐标。
        const decoded = {naturalWidth: 600, naturalHeight: 900, width: 120, height: 180, src: 'borrowed-jpeg'} as HTMLImageElement;
        const lines = await recognizeImage(input, 'en', undefined, {decodedImage: decoded});
        expect(context.drawImage).toHaveBeenCalledWith(decoded, 0, 0, 600, 900);
        expect(encodedSizes).toEqual([{width: 600, height: 900}]);
        expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
        expect(recognize).toHaveBeenCalledWith(ENCODED_PNG, 'eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(lines).toEqual([{text: 'hello', bbox: {x0: 10, y0: 10, x1: 50, y1: 30}}]);
        expect(decoded.src).toBe('borrowed-jpeg');
        expect(sources).toHaveLength(0);
        expect(canvas).toMatchObject({width: 0, height: 0});
    });
    it('JPEG 自行解码后使用自然尺寸 PNG，并在 Worker 识别前释放自有源', async () => {
        dimensions = {width: 600, height: 900};
        recognize.mockImplementationOnce(async () => {
            expect(sources[0].src).toBe('');
            expect(canvas).toMatchObject({width: 0, height: 0});
            return blockResult();
        });
        await recognizeImage('data:image/jpeg;base64,owned-exif-jpeg', 'en');
        expect(context.drawImage).toHaveBeenCalledWith(sources[0], 0, 0, 600, 900);
        expect(encodedSizes).toEqual([{width: 600, height: 900}]);
        expect(recognize).toHaveBeenCalledWith(ENCODED_PNG, 'eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(sources[0]).toMatchObject({src: '', onload: null, onerror: null});
    });
    it('降采样的 JPEG 坐标映回浏览器纠正方向后的自然尺寸，不再次旋转或使用显示尺寸', async () => {
        const decoded = {naturalWidth: 2048, naturalHeight: 8192, width: 256, height: 1024, src: 'large-jpeg'} as HTMLImageElement;
        const lines = await recognizeImage('data:image/jpeg;base64,large-exif-jpeg', 'en', undefined, {decodedImage: decoded});
        expect(context.drawImage).toHaveBeenCalledWith(decoded, 0, 0, 1024, 4096);
        expect(encodedSizes).toEqual([{width: 1024, height: 4096}]);
        expect(lines).toEqual([{text: 'hello', bbox: {x0: 20, y0: 20, x1: 100, y1: 60}}]);
        expect(decoded.src).toBe('large-jpeg');
    });
    it.each([
        'data:image/png;base64,example',
        'DATA:IMAGE/PNG;BASE64,example',
        'data:image/png;charset=binary;base64,example',
    ])('原尺寸不透明 PNG 编码 %s 检查透明通道后仍直接复用，不增加 PNG 编码', async input => {
        await recognizeImage(input, 'ko');
        expect(recognize).toHaveBeenCalledWith(input, 'kor+eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(context.drawImage).toHaveBeenCalledWith(sources[0], 0, 0, 100, 100);
        expect(document.createElement).toHaveBeenCalledOnce();
        expect(context.getImageData).toHaveBeenCalledWith(0, 0, 100, 100);
        expect(context.putImageData).not.toHaveBeenCalled();
        expect(canvas.toDataURL).not.toHaveBeenCalled();
        expect(canvas.toBlob).not.toHaveBeenCalled(); expect(readers).toHaveLength(0);
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(sources[0].src).toBe('');
    });
    it.each(['png', 'webp', 'gif', 'avif'].flatMap(format => [false, true].map(white => ({format, white}))))(
        '透明 $format 的白字=$white 仅在识别像素上合成对比底色，再以无损 PNG 识别', async ({format, white}) => {
            sourcePixels = white
                ? new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 128])
                : new Uint8ClampedArray([200, 180, 170, 0, 0, 0, 0, 255, 0, 0, 0, 128]);
            const originalPixels = new Uint8ClampedArray(sourcePixels);
            const decoded = {naturalWidth: 512, naturalHeight: 256, src: 'borrowed-transparent', pixels: sourcePixels} as unknown as HTMLImageElement;
            const lines = await recognizeImage(`data:image/${format};base64,transparent-${white}`, 'en', undefined, {decodedImage: decoded});
            expect(context.drawImage).toHaveBeenCalledWith(decoded, 0, 0, 512, 256);
            expect(context.getImageData).toHaveBeenCalledWith(0, 0, 512, 256);
            const imageData = context.getImageData.mock.results[0].value;
            expect(context.putImageData).toHaveBeenCalledWith(imageData, 0, 0);
            expect([...imageData.data]).toEqual(white
                ? [0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255]
                : [255, 255, 255, 255, 0, 0, 0, 255, 127, 127, 127, 255]);
            expect(sourcePixels).toEqual(originalPixels);
            expect(imageData.data).not.toBe(sourcePixels);
            expect(encodedSizes).toEqual([{width: 512, height: 256}]);
            expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
            expect(canvas.toDataURL).not.toHaveBeenCalled();
            expect(recognize).toHaveBeenCalledWith(ENCODED_PNG, 'eng', expect.any(AbortSignal), undefined, expect.any(Function));
            expect(lines).toEqual([{text: 'hello', bbox: {x0: 10, y0: 10, x1: 50, y1: 30}}]);
            expect(decoded.src).toBe('borrowed-transparent');
            expect(sources).toHaveLength(0);
            expect(canvas).toMatchObject({width: 0, height: 0});
        },
    );
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
    it('离屏页面销毁出口终止 OCR Worker 并释放完成结果', async () => {
        await recognizeImage('completed-before-close', 'en');
        const {disposeImageOcrWorker} = await import('@/src/features/image-translation/services/ocrRuntime');
        disposeImageOcrWorker();
        expect(disposeWorker).toHaveBeenCalledOnce();
    });
    beforeEach(async () => {
        vi.resetModules();
        recognize.mockReset().mockResolvedValue(blockResult());
        ensureLanguages.mockReset().mockResolvedValue(undefined);
        disposeWorker.mockReset();
        createRuntime.mockReset().mockReturnValue({recognize, ensureLanguages, clearModels, dispose: disposeWorker});
        tesseractCreateWorker.mockReset().mockResolvedValue({});
        onImageCreated = undefined;
        dimensions = {width: 100, height: 100};
        sources = [];
        sourcePixels = new Uint8ClampedArray([10, 20, 30, 255]);
        context = {drawImage: vi.fn(), getImageData: vi.fn(() => ({data: new Uint8ClampedArray(sourcePixels), width: canvas.width, height: canvas.height})),
            putImageData: vi.fn(), fillRect: vi.fn(), fillStyle: '', imageSmoothingEnabled: false, imageSmoothingQuality: 'low'};
        pngBlob = new Blob([Uint8Array.from(atob(PNG_BASE64), byte => byte.charCodeAt(0))], {type: 'image/png'});
        encodedSizes = []; readers = [];
        canvas = {width: 0, height: 0, getContext: vi.fn(() => context), toDataURL: vi.fn(() => ENCODED_PNG),
            toBlob: vi.fn((callback: BlobCallback) => {
                encodedSizes.push({width: canvas.width, height: canvas.height});
                queueMicrotask(() => callback(pngBlob));
            })};
        vi.stubGlobal('FileReader', class {
            result: string | null = null;
            readyState = 0;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            constructor() {readers.push(this);}
            readAsDataURL = vi.fn((blob: Blob) => {
                expect(blob).toBe(pngBlob);
                this.readyState = 1;
                queueMicrotask(() => {
                    if (this.readyState !== 1) return;
                    this.result = ENCODED_PNG; this.readyState = 2; this.onload?.();
                });
            });
            abort = vi.fn(() => {this.readyState = 2;});
        });
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
        ({recognizeImageText: recognizeImage} = await import('@/src/features/image-translation/ocr'));
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
        expect(document.createElement).toHaveBeenCalledOnce();
        expect(context.getImageData).toHaveBeenCalledOnce();
        expect(canvas.toBlob).not.toHaveBeenCalled();
        expect(sources[0]).toMatchObject({src: '', onload: null, onerror: null});
    });

    it('整图借用预检解码结果，不重复解码或释放调用方仍需绘制的图像', async () => {
        const decodedImage = {naturalWidth: 100, naturalHeight: 100, src: 'original'} as HTMLImageElement;
        await recognizeImage('original', 'en', undefined, {decodedImage});
        expect(sources).toHaveLength(0);
        expect(decodedImage.src).toBe('original');
        await expect(recognizeImage('invalid-borrowed', 'en', undefined, {
            decodedImage: {naturalWidth: 0, naturalHeight: 0} as HTMLImageElement,
        })).rejects.toThrow('图片尺寸无效');
    });

    it('同图并发共享一次识别，一方取消不终止另一方，完成结果各自复制', async () => {
        let complete!: (value: ReturnType<typeof blockResult>) => void;
        let notify!: (percent: number) => void;
        let sharedSignal!: AbortSignal;
        recognize.mockImplementationOnce((_image, _languages, signal, _mode, progress) => {
            sharedSignal = signal; notify = progress;
            return new Promise(resolve => {complete = resolve;});
        });
        const controller = new AbortController(); const progress = vi.fn();
        const first = recognizeImage('shared', 'en', controller.signal);
        const rejected = expect(first).rejects.toMatchObject({name: 'AbortError'});
        const second = recognizeImage('shared', 'en', undefined, {onProgress: progress});
        await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
        notify(42); controller.abort(); await rejected;
        expect(sharedSignal.aborted).toBe(false);
        complete(blockResult()); const lines = await second;
        lines[0].text = 'changed';
        expect((await recognizeImage('shared', 'en'))[0].text).toBe('hello');
        expect(progress).toHaveBeenCalledWith(42);
        expect(sources).toHaveLength(1);
    });

    it.each([false, true])('普通和漫画并发时取消一个订阅仍共享识别，取消漫画=%s', async cancelManga => {
        const bbox = {x0: 10, y0: 10, x1: 50, y1: 30};
        const result = {data: {blocks: [{paragraphs: [{lines: [{text: '12:34', bbox, words: [{text: '12:34', bbox, confidence: 96}]}]}]}]}};
        let complete!: (value: typeof result) => void;
        let underlying!: AbortSignal;
        recognize.mockImplementationOnce((_image, _languages, signal) => {underlying = signal; return new Promise(resolve => {complete = resolve;});});
        const controller = new AbortController();
        const ordinary = recognizeImage('cross-view', 'ko', cancelManga ? undefined : controller.signal);
        const manga = recognizeImage('cross-view', 'ko', cancelManga ? controller.signal : undefined, {includeMangaNumericConfidence: true});
        const cancelled = expect(cancelManga ? manga : ordinary).rejects.toMatchObject({name: 'AbortError'});
        await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());
        controller.abort(); await cancelled; expect(underlying.aborted).toBe(false);
        complete(result);
        const remaining = await (cancelManga ? ordinary : manga);
        if (cancelManga) expect(remaining).toEqual([{text: '12:34', bbox}]);
        else expect(remaining).toEqual([{text: '12:34', bbox, numericConfidence: 96}]);
        expect(await recognizeImage('cross-view', 'ko')).toEqual([{text: '12:34', bbox}]);
        expect(await recognizeImage('cross-view', 'ko', undefined, {includeMangaNumericConfidence: true})).toEqual([{text: '12:34', bbox, numericConfidence: 96}]);
        expect(recognize).toHaveBeenCalledOnce();
    });

    it('扩展 Worker 使用本地资源目录并复用语言下载边界及取消信号', async () => {
        vi.stubGlobal('chrome', {runtime: {getURL: (path: string) => `chrome-extension://test${path}`}});
        const onProgress = vi.fn();
        await createRuntime.mock.calls[0][0].createWorker('jpn+eng', onProgress);
        expect(tesseractCreateWorker).toHaveBeenCalledWith(['jpn', 'eng'], 1, {
            workerPath: 'chrome-extension://test/fluent-read-ocr/worker/worker.min.js',
            corePath: 'chrome-extension://test/fluent-read-ocr/core/tesseract-core-simd-lstm.wasm.js',
            cachePath: 'fluent-read-image-ocr', workerBlobURL: false, errorHandler: expect.any(Function), logger: expect.any(Function),
        }, {tessedit_load_sublangs: ''});
        const logger = tesseractCreateWorker.mock.calls[0][2].logger;
        // SDK 的错误通知不能从消息回调另抛一次；具体失败仍由对应任务 Promise 传回。
        expect(() => tesseractCreateWorker.mock.calls[0][2].errorHandler(new Error('recognition failed'))).not.toThrow();
        logger({status:'loading language', progress:0.2, userJobId:'load'});
        logger({status:'recognizing text', progress:0.4, userJobId:'recognize'});
        expect(onProgress).toHaveBeenCalledOnce(); expect(onProgress).toHaveBeenCalledWith(0.4, 'recognize');
        const {downloadImageOcrLanguages} = await import('@/src/features/image-translation/services/ocrRuntime');
        const controller = new AbortController();
        const onDownloadProgress = vi.fn();
        await downloadImageOcrLanguages(['jpn', 'eng'], controller.signal, onDownloadProgress);
        // 日文包附带竖排模型，一次下载写入同一缓存，避免首次识别竖排漫画时再联网。
        expect(ensureLanguages).toHaveBeenCalledWith(['jpn', 'jpn_vert', 'eng'], controller.signal);
        // 先带进度地预取同一组模型，再交给 Tesseract 加载；顺序不能反过来。
        expect(prefetchModels).toHaveBeenCalledWith(['jpn', 'jpn_vert', 'eng'], {signal: controller.signal, onProgress: onDownloadProgress});
        expect(prefetchModels.mock.invocationCallOrder[0]).toBeLessThan(ensureLanguages.mock.invocationCallOrder[0]);
        ensureLanguages.mockRejectedValueOnce(new Error('download failed'));
        await expect(downloadImageOcrLanguages(['eng'])).rejects.toThrow('download failed');
    });

    it('同图并发只识别一次，后续缓存不被重复计费误淘汰', async () => {
        const shared = 'a'.repeat(3 * 1024 * 1024);
        await Promise.all([recognizeImage(shared, 'en'), recognizeImage(shared, 'en')]);
        await recognizeImage('b'.repeat(2 * 1024 * 1024), 'en');
        await recognizeImage(shared, 'en');
        expect(recognize).toHaveBeenCalledTimes(2);
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
        expect(recognize).toHaveBeenLastCalledWith('one', 'jpn+jpn_vert+eng', expect.any(AbortSignal), 12, expect.any(Function));
    });

    it('日文与自动源语言加载竖排模型并启用方向检测，其他语言保持稀疏模式 (#654)', async () => {
        await recognizeImage('manga', 'auto');
        expect(recognize).toHaveBeenLastCalledWith('manga', 'chi_sim+chi_tra+eng+jpn+jpn_vert', expect.any(AbortSignal), 12, expect.any(Function));
        await recognizeImage('manga', 'zh-CN');
        expect(recognize).toHaveBeenLastCalledWith('manga', 'chi_sim+eng', expect.any(AbortSignal), undefined, expect.any(Function));
        recognize.mockResolvedValueOnce({data: {blocks: []}});
        await recognizeImage('bubble', 'ja', undefined, {profile: 'area'});
        expect(recognize).toHaveBeenNthCalledWith(3, ENCODED_PNG, 'jpn+jpn_vert+eng', expect.any(AbortSignal), 12, expect.any(Function));
        expect(recognize).toHaveBeenNthCalledWith(4, ENCODED_PNG, 'jpn+jpn_vert+eng', expect.any(AbortSignal), 6);
        const {removeImageOcrLanguages} = await import('@/src/features/image-translation/services/ocrRuntime');
        await removeImageOcrLanguages(['jpn']);
        expect(removeFiles).toHaveBeenLastCalledWith(['jpn', 'jpn_vert']);
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
        expect(recognize).toHaveBeenCalledWith(ENCODED_PNG, 'eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(lines).toEqual([{text: 'hello', bbox: {x0: 19, y0: 19, x1: 98, y1: 59}}]);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
        expect(sources[0].src).toBe('');
        expect(context.fillRect).not.toHaveBeenCalled();
    });

    it.each([false, true])('圈选借用解码图=%s 在异步编码中保留画布、释放自有解码图，取消不启动 Worker', async borrowed => {
        const controller = new AbortController();
        const decoded = {naturalWidth: 100, naturalHeight: 100, src: 'borrowed-image'} as HTMLImageElement;
        let complete!: BlobCallback;
        canvas.toBlob.mockImplementationOnce((callback: BlobCallback) => {complete = callback;});
        const operation = recognizeImage('encode-pending', 'en', controller.signal, {profile: 'area',
            ...(borrowed ? {decodedImage: decoded} : {})});
        const outcome = operation.then(result => ({result}), error => ({error}));
        await vi.waitFor(() => expect(canvas.toBlob).toHaveBeenCalledOnce());
        expect(canvas.toDataURL).not.toHaveBeenCalled();
        expect(canvas).toMatchObject({width: 220, height: 220});
        expect(recognize).not.toHaveBeenCalled();
        if (borrowed) expect(decoded.src).toBe('borrowed-image'); else expect(sources[0].src).toBe('');
        controller.abort(); complete(pngBlob);
        expect(await outcome).toMatchObject({error: {name: 'AbortError'}});
        await vi.waitFor(() => expect(canvas).toMatchObject({width: 0, height: 0}));
        expect(recognize).not.toHaveBeenCalled();
        expect(readers).toHaveLength(0);
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(decoded.src).toBe('borrowed-image');
    });

    it.each([false, true])('JPEG 借用解码图=%s 编码取消后丢弃迟到 PNG 并清理像素，同图可重新识别', async borrowed => {
        dimensions = {width: 600, height: 900};
        const input = `data:image/jpeg;base64,cancelled-exif-${borrowed}`;
        const controller = new AbortController();
        const decoded = {naturalWidth: 600, naturalHeight: 900, src: 'borrowed-jpeg'} as HTMLImageElement;
        const options = borrowed ? {decodedImage: decoded} : {};
        let complete!: BlobCallback;
        canvas.toBlob.mockImplementationOnce((callback: BlobCallback) => {complete = callback;});
        const operation = recognizeImage(input, 'en', controller.signal, options);
        const outcome = operation.then(result => ({result}), error => ({error}));
        await vi.waitFor(() => expect(canvas.toBlob).toHaveBeenCalledOnce());
        expect(canvas).toMatchObject({width: 600, height: 900});
        expect(recognize).not.toHaveBeenCalled();
        if (borrowed) expect(decoded.src).toBe('borrowed-jpeg'); else expect(sources[0].src).toBe('');
        controller.abort();
        complete(pngBlob);
        expect(await outcome).toMatchObject({error: {name: 'AbortError'}});
        await vi.waitFor(() => expect(canvas).toMatchObject({width: 0, height: 0}));
        expect(readers).toHaveLength(0);
        expect(recognize).not.toHaveBeenCalled();
        await expect(recognizeImage(input, 'en', undefined, options)).resolves.toEqual([
            {text: 'hello', bbox: {x0: 10, y0: 10, x1: 50, y1: 30}},
        ]);
        expect(recognize).toHaveBeenCalledOnce();
        expect(recognize).toHaveBeenCalledWith(ENCODED_PNG, 'eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(readers).toHaveLength(1);
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(decoded.src).toBe('borrowed-jpeg');
        if (!borrowed) expect(sources.every(source => source.src === '')).toBe(true);
    });

    it.each([false, true])('透明 PNG 借用解码图=%s 编码取消后释放识别像素，保留源并支持重新识别', async borrowed => {
        dimensions = {width: 512, height: 256};
        sourcePixels = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]);
        const unchangedPixels = new Uint8ClampedArray(sourcePixels);
        const input = `data:image/png;base64,cancelled-transparent-${borrowed}`;
        const controller = new AbortController();
        const decoded = {naturalWidth: 512, naturalHeight: 256, src: 'borrowed-transparent'} as HTMLImageElement;
        const options = borrowed ? {decodedImage: decoded} : {};
        let complete!: BlobCallback;
        canvas.toBlob.mockImplementationOnce((callback: BlobCallback) => {complete = callback;});
        const operation = recognizeImage(input, 'en', controller.signal, options);
        const outcome = operation.then(result => ({result}), error => ({error}));
        await vi.waitFor(() => expect(canvas.toBlob).toHaveBeenCalledOnce());
        expect(context.putImageData).toHaveBeenCalledOnce();
        expect(canvas).toMatchObject({width: 512, height: 256});
        expect(recognize).not.toHaveBeenCalled();
        expect(sourcePixels).toEqual(unchangedPixels);
        if (borrowed) expect(decoded.src).toBe('borrowed-transparent'); else expect(sources[0].src).toBe('');
        controller.abort(); complete(pngBlob);
        expect(await outcome).toMatchObject({error: {name: 'AbortError'}});
        await vi.waitFor(() => expect(canvas).toMatchObject({width: 0, height: 0}));
        expect(readers).toHaveLength(0);
        expect(recognize).not.toHaveBeenCalled();
        await expect(recognizeImage(input, 'en', undefined, options)).resolves.toHaveLength(1);
        expect(recognize).toHaveBeenCalledOnce();
        expect(recognize).toHaveBeenCalledWith(ENCODED_PNG, 'eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(sourcePixels).toEqual(unchangedPixels);
        expect(decoded.src).toBe('borrowed-transparent');
        expect(canvas).toMatchObject({width: 0, height: 0});
        if (!borrowed) expect(sources.every(source => source.src === '')).toBe(true);
    });

    it('透明 PNG 像素读取完成时取消，不编码或进入 Worker，借出的源像素仍可重试', async () => {
        sourcePixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]);
        const originalPixels = new Uint8ClampedArray(sourcePixels);
        const controller = new AbortController();
        const decoded = {naturalWidth: 512, naturalHeight: 256, src: 'borrowed-transparent'} as HTMLImageElement;
        const readPixels = context.getImageData.getMockImplementation()!;
        context.getImageData.mockImplementationOnce(() => {controller.abort(); return readPixels();});
        await expect(recognizeImage('data:image/png;base64,pixel-abort', 'en', controller.signal, {decodedImage: decoded}))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(canvas.toBlob).not.toHaveBeenCalled();
        expect(recognize).not.toHaveBeenCalled();
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(decoded.src).toBe('borrowed-transparent');
        expect(sourcePixels).toEqual(originalPixels);
        await expect(recognizeImage('data:image/png;base64,pixel-abort', 'en', undefined, {decodedImage: decoded})).resolves.toHaveLength(1);
        expect(recognize).toHaveBeenCalledOnce();
    });

    it.each(['pixels', 'writeback', 'encoding'])('透明 PNG %s 失败释放识别画布而保留借出的源，重试重新准备像素', async stage => {
        sourcePixels = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]);
        const originalPixels = new Uint8ClampedArray(sourcePixels);
        const decoded = {naturalWidth: 512, naturalHeight: 256, src: 'borrowed-transparent'} as HTMLImageElement;
        if (stage === 'pixels') context.getImageData.mockImplementationOnce(() => {throw new Error('pixel read failed');});
        if (stage === 'writeback') context.putImageData.mockImplementationOnce(() => {throw new Error('pixel write failed');});
        if (stage === 'encoding') canvas.toBlob.mockImplementationOnce(() => {throw new Error('encode failed');});
        await expect(recognizeImage('data:image/png;base64,pixel-failure', 'en', undefined, {decodedImage: decoded})).rejects.toThrow();
        expect(recognize).not.toHaveBeenCalled();
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(decoded.src).toBe('borrowed-transparent');
        expect(sourcePixels).toEqual(originalPixels);
        await expect(recognizeImage('data:image/png;base64,pixel-failure', 'en', undefined, {decodedImage: decoded})).resolves.toHaveLength(1);
        expect(recognize).toHaveBeenCalledOnce();
        expect(recognize).toHaveBeenCalledWith(ENCODED_PNG, 'eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(sourcePixels).toEqual(originalPixels);
        expect(decoded.src).toBe('borrowed-transparent');
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

    it('圈选和小图片空结果重试一次且不缓存空结果，大图仍只识别一次', async () => {
        recognize.mockResolvedValueOnce({data: {blocks: []}});
        await expect(recognizeImage('area', 'en', undefined, {profile: 'area'})).resolves.toHaveLength(1);
        expect(recognize).toHaveBeenNthCalledWith(1, ENCODED_PNG, 'eng', expect.any(AbortSignal), undefined, expect.any(Function));
        expect(recognize).toHaveBeenNthCalledWith(2, ENCODED_PNG, 'eng', expect.any(AbortSignal), 6);
        recognize.mockResolvedValue({data: {blocks: []}});
        await expect(recognizeImage('blank', 'en', undefined, {profile: 'area'})).resolves.toEqual([]);
        expect(recognize).toHaveBeenCalledTimes(4);
        await recognizeImage('blank', 'en', undefined, {profile: 'area'});
        expect(recognize).toHaveBeenCalledTimes(6);
        await expect(recognizeImage('normal', 'en')).resolves.toEqual([]);
        expect(recognize).toHaveBeenCalledTimes(8);
        dimensions = {width: 1200, height: 800};
        await expect(recognizeImage('large-empty', 'en')).resolves.toEqual([]);
        expect(recognize).toHaveBeenCalledTimes(9);
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

    it('借用图片已完成准备但尚未进入 Worker 时取消，不启动识别且后续可以重试', async () => {
        const controller = new AbortController();
        const decodedImage = {naturalWidth: 100, naturalHeight: 100, src: 'borrowed'} as HTMLImageElement;
        const pending = recognizeImage('prepared-before-worker', 'en', controller.signal, {decodedImage});
        // 借用位图无需异步解码；准备已经完成，Worker 消息在下一个 Promise 续体才会发出。
        controller.abort();
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        await Promise.resolve();
        expect(recognize).not.toHaveBeenCalled();
        expect(decodedImage.src).toBe('borrowed');
        expect(sources).toHaveLength(0);
        await expect(recognizeImage('prepared-before-worker', 'en', undefined, {decodedImage})).resolves.toHaveLength(1);
        expect(recognize).toHaveBeenCalledOnce();
    });

    it('创建解码对象期间或编码完成时取消，不赋予来源或启动后续 OCR', async () => {
        const constructing = new AbortController();
        onImageCreated = () => constructing.abort();
        await expect(recognizeImage('never-started', 'en', constructing.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(sources[0]).toMatchObject({src: '', onload: null, onerror: null});
        onImageCreated = undefined;
        const encoding = new AbortController();
        canvas.toBlob.mockImplementationOnce((callback: BlobCallback) => {encoding.abort(); callback(pngBlob);});
        await expect(recognizeImage('encoded-abort', 'en', encoding.signal, {profile: 'area'}))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(sources[1].src).toBe('');
        expect(canvas).toMatchObject({width: 0, height: 0});
        expect(recognize).not.toHaveBeenCalled();
    });

    it.each(['context', 'drawing', 'pixels', 'writeback', 'encoding'])('画布%s失败也释放画布像素与解码源', async stage => {
        dimensions = {width: 8000, height: 1000};
        if (stage === 'context') canvas.getContext.mockReturnValueOnce(null);
        if (stage === 'drawing') context.drawImage.mockImplementationOnce(() => { throw new Error('draw failed'); });
        if (stage === 'pixels') context.getImageData.mockImplementationOnce(() => {throw new Error('pixel read failed');});
        if (stage === 'writeback') {
            sourcePixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 0]);
            context.putImageData.mockImplementationOnce(() => {throw new Error('pixel write failed');});
        }
        if (stage === 'encoding') canvas.toBlob.mockImplementationOnce(() => {throw new Error('encode failed');});
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

describe('同图在途识别的订阅和取消', () => {
    it('完成后迟到的自定义取消回调不重复结算，也不影响下一次同图任务', async () => {
        const tasks = createSharedOcrTasks<string>(); let cancel!: () => void;
        const signal = {aborted: false, addEventListener: (_type: string, callback: () => void) => {cancel = callback;}, removeEventListener: vi.fn()} as unknown as AbortSignal;
        await expect(tasks.run('same', async () => 'done', signal)).resolves.toBe('done');
        let complete!: (value: string) => void;
        const next = tasks.run('same', () => new Promise(resolve => {complete = resolve;}));
        cancel(); complete('next');
        await expect(next).resolves.toBe('next');
        expect(signal.removeEventListener).toHaveBeenCalledOnce();
    });
    it('共享真实进度，后加入者收到最近进度，展示回调异常不影响其他调用方', async () => {
        const tasks = createSharedOcrTasks<string>();
        let complete!: (value: string) => void; let notify!: (value: number) => void;
        const operation = vi.fn((_signal, progress) => {
            notify = progress; return new Promise<string>(resolve => {complete = resolve;});
        });
        const first = tasks.run('same', operation, undefined, () => {throw new Error('detached');});
        notify(30); const progress = vi.fn();
        const second = tasks.run('same', operation, undefined, progress);
        expect(progress).toHaveBeenCalledWith(30);
        notify(40); complete('done');
        expect(await Promise.all([first, second])).toEqual(['done', 'done']);
        expect(operation).toHaveBeenCalledOnce();
        expect(progress).toHaveBeenLastCalledWith(40);
    });

    it('最后一个订阅取消才终止任务，重试不会被旧进度和迟到结果清掉', async () => {
        const tasks = createSharedOcrTasks<string>();
        const controllers = [new AbortController(), new AbortController()];
        let sharedSignal!: AbortSignal; let complete!: (value: string) => void; let notify!: (value: number) => void;
        const firstOperation = vi.fn((signal, progress) => {
            sharedSignal = signal; notify = progress; return new Promise<string>(resolve => {complete = resolve;});
        });
        const progress = vi.fn();
        const first = tasks.run('same', firstOperation, controllers[0].signal, progress);
        const second = tasks.run('same', firstOperation, controllers[1].signal);
        const firstRejected = expect(first).rejects.toMatchObject({name: 'AbortError'});
        const secondRejected = expect(second).rejects.toMatchObject({name: 'AbortError'});
        controllers[0].abort(); await firstRejected; expect(sharedSignal.aborted).toBe(false);
        controllers[1].abort(); await secondRejected; expect(sharedSignal.aborted).toBe(true);
        notify(99); expect(progress).not.toHaveBeenCalled();
        let retryComplete!: (value: string) => void;
        const retryOperation = vi.fn(() => new Promise<string>(resolve => {retryComplete = resolve;}));
        const retry = tasks.run('same', retryOperation);
        complete('stale'); await Promise.resolve(); await Promise.resolve();
        const joined = tasks.run('same', retryOperation);
        retryComplete('fresh');
        expect(await Promise.all([retry, joined])).toEqual(['fresh', 'fresh']);
        expect(retryOperation).toHaveBeenCalledOnce();
    });

    it('预取消不执行，失败向所有订阅传播并允许重试，包括 undefined 拒绝原因', async () => {
        const tasks = createSharedOcrTasks<string>(); const controller = new AbortController(); controller.abort();
        const operation = vi.fn(async () => 'unexpected');
        await expect(tasks.run('cancelled', operation, controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(operation).not.toHaveBeenCalled();
        const fail = () => Promise.reject(undefined);
        const first = tasks.run('failed', fail); const second = tasks.run('failed', fail);
        expect(await Promise.allSettled([first, second])).toEqual([
            {status: 'rejected', reason: undefined}, {status: 'rejected', reason: undefined},
        ]);
        await expect(tasks.run('failed', async () => 'retry')).resolves.toBe('retry');
    });
});

/**
 * @file tests/documentPageRecognizer.test.ts
 * 文件职责：验证文档页面组合根为扫描版 PDF 组装的页面识别器：渲染页面、调用文字识别、把识别框换算回页面坐标。
 * 主要内容：识别引擎按页面的源语言与取消信号被调用；识别框按页面与光栅的宽高分别换算，避免像素取整造成纵向偏移；渲染或识别失败原样抛出；没有识别结果时返回空列表。
 * 模块边界：页面渲染与识别引擎均由模块桩替代，不启动浏览器、不加载 PDF.js 或 Tesseract；识别结果如何重建段落由 pdfOcr 测试覆盖。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({render: vi.fn(), recognize: vi.fn()}));

vi.mock('@/src/services/config/store', () => ({config: {service: 'microsoft'}, configReady: Promise.resolve()}));
vi.mock('@/src/core/config/catalog', () => ({services: {microsoft: 'microsoft', freeTranslation: 'freeTranslation'}}));
vi.mock('@/src/services/translation/client', () => ({translateText: vi.fn(), translateTextBatch: vi.fn()}));
vi.mock('@/src/features/document-translation/ui/pdfPreview', () => ({rasterizePdfReadingPages: vi.fn(), rasterizePdfTranslationPage: vi.fn(), renderPdfPageImage: mocks.render}));
vi.mock('@/src/features/image-translation/ocr', () => ({recognizeImageText: mocks.recognize}));

import {createPdfPageRecognizer} from '@/src/app/document-translation/runtime';

describe('scanned PDF page recogniser', () => {
    beforeEach(() => {mocks.render.mockReset(); mocks.recognize.mockReset();});

    it('renders the page, recognises it in the source language and maps boxes back to page points', async () => {
        mocks.render.mockResolvedValue({image: 'data:image/png;base64,AAAA', width: 1200, height: 1600, graphics: [], regions: []});
        mocks.recognize.mockResolvedValue([{text: 'Recognised line', bbox: {x0: 120, y0: 200, x1: 1080, y1: 240}}]);
        const signal = new AbortController().signal;
        const bytes = new Uint8Array([1, 2]);
        const {lines, graphics} = await createPdfPageRecognizer('zh-Hans')({bytes, pageNumber: 3, width: 600, height: 800, signal});
        expect(mocks.render).toHaveBeenCalledWith(bytes, 3, 600, signal);
        expect(mocks.recognize).toHaveBeenCalledWith('data:image/png;base64,AAAA', 'zh-Hans', signal, {profile: 'document'});
        expect(graphics).toEqual([]);
        expect(lines).toEqual([{text: 'Recognised line', x: 60, y: 100, width: 480, height: 20}]);
    });

    it('accounts for independently rounded raster dimensions and stops before OCR after render cancellation', async () => {
        mocks.render.mockResolvedValue({image: 'data:', width: 1200, height: 1599, graphics: [], regions: []});
        mocks.recognize.mockResolvedValue([{text: 'Edge', bbox: {x0: 120, y0: 1599, x1: 1080, y1: 1599}, baseline: 1500, fontSize: 40}]);
        const input = {bytes: new Uint8Array([1]), pageNumber: 1, width: 600, height: 800};
        const {lines: [line]} = await createPdfPageRecognizer('en')(input);
        expect(line.y).toBe(800);
        expect(line.baseline).toBeCloseTo(1500 * 800 / 1599);
        expect(line.fontSize).toBeCloseTo(40 * 800 / 1599);
        const controller = new AbortController(); controller.abort();
        await expect(createPdfPageRecognizer('en')({...input, signal: controller.signal})).rejects.toMatchObject({name: 'AbortError'});
        expect(mocks.recognize).toHaveBeenCalledOnce();
    });

    it('returns no lines for a blank page and passes failures through', async () => {
        mocks.render.mockResolvedValue({image: 'data:', width: 600, height: 800, graphics: [], regions: []});
        mocks.recognize.mockResolvedValue([]);
        expect(await createPdfPageRecognizer('auto')({bytes: new Uint8Array(), pageNumber: 1, width: 600, height: 800})).toEqual({lines: [], graphics: [], regions: []});
        mocks.recognize.mockRejectedValue(new Error('language pack unavailable'));
        await expect(createPdfPageRecognizer('auto')({bytes: new Uint8Array(), pageNumber: 1, width: 600, height: 800})).rejects.toThrow('language pack unavailable');
        mocks.render.mockRejectedValue(new Error('render failed'));
        await expect(createPdfPageRecognizer('auto')({bytes: new Uint8Array(), pageNumber: 1, width: 600, height: 800})).rejects.toThrow('render failed');
    });

    it('carries uncertain script boxes into page coordinates without turning them into source text', async () => {
        mocks.render.mockResolvedValue({image: 'data:', width: 1200, height: 1600, graphics: [], regions: []});
        mocks.recognize.mockResolvedValue([{text: '', bbox: {x0: 120, y0: 200, x1: 140, y1: 220}, documentReview: true}]);
        expect(await createPdfPageRecognizer('en')({bytes: new Uint8Array([1]), pageNumber: 1, width: 600, height: 800}))
            .toEqual({lines: [{text: '', x: 60, y: 100, width: 10, height: 10, needsReview: true}], graphics: [], regions: []});
    });
    it('maps graphic boundaries and table rules using the same independent pixel axes as text', async () => {
        mocks.render.mockResolvedValue({image:'data:',width:1200,height:1599,graphics:[{x:120,y:200,width:600,height:300,rules:[{kind:'path',x:120,y:200,width:600,height:0}]}],regions:[]});
        mocks.recognize.mockResolvedValue([]);
        const result=await createPdfPageRecognizer('en')({bytes:new Uint8Array([1]),pageNumber:1,width:600,height:800});
        expect(result.graphics[0].x).toBe(60);expect(result.graphics[0].y).toBeCloseTo(200*800/1599);
        expect(result.graphics[0].rules[0]).toEqual({kind:'path',x:60,y:200*(800/1599),width:300,height:0});
        expect(result.lines).toEqual([]);
    });

    it('rechecks a grid with sparse document layout, offsets lines and preserves an unprocessed region for review',async()=>{
        mocks.render.mockResolvedValue({image:'full',width:1200,height:1600,graphics:[],regions:[{graphicIndex:0,image:'crop',x:100,y:200},{graphicIndex:1,x:300,y:400}]});
        mocks.recognize.mockResolvedValueOnce([]).mockResolvedValueOnce([{text:'Cell',bbox:{x0:10,y0:20,x1:70,y1:40},baseline:35,fontSize:20}]);
        const result=await createPdfPageRecognizer('en')({bytes:new Uint8Array([1]),pageNumber:1,width:600,height:800});
        expect(mocks.recognize).toHaveBeenLastCalledWith('crop','en',undefined,{profile:'document',documentLayout:'sparse'});
        expect(result.regions).toEqual([{graphicIndex:0,lines:[{text:'Cell',x:55,y:110,width:30,height:10,baseline:117.5,fontSize:10}]},{graphicIndex:1}]);
    });
    it('bypasses completed and in-flight OCR reuse for both the current page and its table crops',async()=>{
        mocks.render.mockResolvedValue({image:'full',width:600,height:800,graphics:[],regions:[{graphicIndex:0,image:'crop',x:0,y:0}]});mocks.recognize.mockResolvedValue([]);
        await createPdfPageRecognizer('en')({bytes:new Uint8Array([1]),pageNumber:1,width:600,height:800,useCache:false});
        expect(mocks.recognize.mock.calls.map(call=>call[3])).toEqual([{profile:'document',useCache:false},{profile:'document',documentLayout:'sparse',useCache:false}]);
    });
    it('rejects a late cancelled regional result instead of publishing a partial page',async()=>{
        const controller=new AbortController();
        mocks.render.mockResolvedValue({image:'full',width:600,height:800,graphics:[],regions:[{graphicIndex:0,image:'crop',x:0,y:0}]});
        mocks.recognize.mockResolvedValueOnce([]).mockImplementationOnce(async()=>{controller.abort();return [];});
        await expect(createPdfPageRecognizer('en')({bytes:new Uint8Array([1]),pageNumber:1,width:600,height:800,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    });
});

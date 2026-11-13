/**
 * @file tests/pdfSourcePreview.test.ts
 * 文件职责：验证原文校订裁剪的原始字节、显示坐标、有界尺寸和取消清理。
 * 主要内容：完整原页渲染由端口替代，校订预览只读原图并在成功、失败和取消时释放画布。
 * 模块边界：不调用 OCR；实际旋转扫描件和预览截图由真实浏览器验证。
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ParsedDocument} from '@/src/features/document-translation/core/document';
import {createPdfSourcePreview} from '@/src/features/document-translation/ui/pdfSourcePreview';
const ports=vi.hoisted(()=>({render:vi.fn(),encode:vi.fn()}));
vi.mock('@/src/features/document-translation/ui/pdfPreview',()=>({renderPdfSourceCanvas:ports.render,canvasToImageBytes:ports.encode}));
const source=()=>({width:2500,height:3333});
const doc=()=>({fileName:'scan.pdf',format:'pdf',segments:[],binary:{kind:'pdf',bytes:new Uint8Array([7,8]),pages:[{pageNumber:1,width:600,height:800,sourceRotation:90,ocrRecognized:true,blocks:[{segmentIndex:-1,x:20,y:40,width:250,height:12,lines:[{text:'123'}]}]}]}} as unknown as ParsedDocument);
let canvas:any,context:any;
beforeEach(()=>{context={drawImage:vi.fn()};canvas={width:0,height:0,getContext:vi.fn(()=>context)};vi.stubGlobal('document',{createElement:vi.fn(()=>canvas)});ports.render.mockReset().mockResolvedValue(source());ports.encode.mockReset().mockResolvedValue(new Uint8Array([4,5]));});
afterEach(()=>vi.unstubAllGlobals());
describe('PDF source crop',()=>{
    it('renders original PDF bytes and crops in upright page coordinates without editing the document',async()=>{
        const original=doc(),before=structuredClone(original),image=source();ports.render.mockResolvedValue(image);
        ports.encode.mockImplementation(async()=>{expect(canvas.width).toBe(1075);expect(canvas.height).toBe(83);return new Uint8Array([4,5]);});
        const signal=new AbortController().signal;
        expect(await createPdfSourcePreview(original,1,0,signal)).toEqual(new Uint8Array([4,5]));
        expect(ports.render).toHaveBeenCalledWith(original.binary?.bytes,1,600,signal,true);
        expect(context.drawImage).toHaveBeenCalledWith(image,16*2500/600,36*3333/800,258*2500/600,20*3333/800,0,0,1075,83);
        expect(original).toEqual(before);expect(image).toEqual({width:0,height:0});expect(canvas.width+canvas.height).toBe(0);
    });
    it('clips page edges and limits megapixels and long edges',async()=>{
        const original=doc(),page=(original.binary as any).pages[0];Object.assign(page.blocks[0],{x:0,y:0,width:600,height:800});
        ports.encode.mockImplementation(async()=>{expect(canvas.width*canvas.height).toBeLessThanOrEqual(3_000_000);expect(Math.max(canvas.width,canvas.height)).toBeLessThanOrEqual(2048);return new Uint8Array();});
        await createPdfSourcePreview(original,1,0);expect(context.drawImage.mock.calls[0].slice(1,5)).toEqual([0,0,2500,3333]);
    });
    it.each([undefined,NaN,0,-30])('rejects a nonexistent or invalid crop before rendering (%s)',async width=>{
        const original=doc();if(width===undefined)(original.binary as any).pages[0].blocks=[];else Object.assign((original.binary as any).pages[0].blocks[0],{width,x:NaN});
        await expect(createPdfSourcePreview(original,1,0)).rejects.toThrow('位置无效');expect(ports.render).not.toHaveBeenCalled();
    });
    it('rejects zero height and out-of-page rectangles',async()=>{
        const original=doc();Object.assign((original.binary as any).pages[0].blocks[0],{y:900});
        await expect(createPdfSourcePreview(original,1,0)).rejects.toThrow('位置无效');
        Object.assign((original.binary as any).pages[0].blocks[0],{y:40,x:900});await expect(createPdfSourcePreview(original,1,0)).rejects.toThrow('位置无效');
    });
    it('releases the source on cancellation immediately after rendering',async()=>{
        const controller=new AbortController(),image=source();ports.render.mockImplementation(async()=>{controller.abort();return image;});
        await expect(createPdfSourcePreview(doc(),1,0,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(image.width).toBe(0);expect(ports.encode).not.toHaveBeenCalled();
        await expect(createPdfSourcePreview(doc(),1,0,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(ports.render).toHaveBeenCalledOnce();
    });
    it.each(['context','encode','draw','create'])('cleans up after %s failure',async failure=>{
        const image=source();ports.render.mockResolvedValue(image);
        if(failure==='context')canvas.getContext.mockReturnValue(null);
        if(failure==='encode')ports.encode.mockRejectedValue(new Error('encoding failed'));
        if(failure==='draw')context.drawImage.mockImplementation(()=>{throw new Error('draw failed');});
        if(failure==='create')vi.mocked(document.createElement).mockImplementation(()=>{throw new Error('create failed');});
        await expect(createPdfSourcePreview(doc(),1,0)).rejects.toThrow();expect(image.width+image.height).toBe(0);expect(canvas.width+canvas.height).toBe(0);
    });
});

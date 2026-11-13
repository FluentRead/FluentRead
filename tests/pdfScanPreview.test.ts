import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {readPdfScanGraphics, cropPdfScanRegions} from '@/src/features/document-translation/ui/pdfScanPreview';

describe('PDF scan graphics canvas lifecycle', () => {
    let canvas: HTMLCanvasElement, context: any, dimensions: number[][];
    beforeEach(() => {
        dimensions = [];
        context = {drawImage: vi.fn(), fillRect:vi.fn(), fillStyle:'', getImageData: vi.fn((_x, _y, width, height) => {
            dimensions.push([width, height]);
            const data = new Uint8ClampedArray(width * height * 4).fill(255);
            if (width >= 200 && height >= 200) for (let row = 20; row < 100; row++) for (let col = 20; col < 100; col++) data.set([0,0,0,255], (row * width + col) * 4);
            return {data};
        })};
        canvas = {width: 0, height: 0, getContext: vi.fn(() => context),toDataURL:vi.fn(()=> 'data:image/png;base64,AQID')} as unknown as HTMLCanvasElement;
        vi.stubGlobal('document', {createElement: vi.fn(() => canvas)});
    });
    afterEach(() => vi.unstubAllGlobals());

    it('bounds the preview and maps independent axes back to the original raster', async () => {
        const result = await readPdfScanGraphics({width: 2480, height: 3508} as HTMLCanvasElement, 595);
        const [width,height] = dimensions[0];
        expect(width * height).toBeLessThanOrEqual(1_800_000); expect(Math.max(width,height)).toBeLessThanOrEqual(1600);
        expect(result[0].x).toBeCloseTo(20 * 2480 / width); expect(result[0].y).toBeCloseTo(20 * 3508 / height);
        expect(result[0].width).toBeCloseTo(80 * 2480 / width); expect(result[0].height).toBeCloseTo(80 * 3508 / height);
        expect(canvas).toMatchObject({width: 0, height: 0}); expect(context.getImageData).toHaveBeenCalledOnce();
    });
    it('does not upscale a small scan and releases an empty result', async () => {
        expect(await readPdfScanGraphics({width: 100, height: 90} as HTMLCanvasElement, 100)).toEqual([]);
        expect(dimensions).toEqual([[100,90]]); expect(canvas.width).toBe(0);
    });
    it('maps table rule coordinates along with their graphic bounds', async () => {
        context.getImageData.mockImplementation((_x: number,_y: number,width: number,height: number) => {
            const data = new Uint8ClampedArray(width * height * 4).fill(255);
            for (const row of [20,60,100]) for (let col=20;col<=180;col++) data.set([0,0,0,255],(row*width+col)*4);
            for (const col of [20,100,180]) for(let row=20;row<=100;row++) data.set([0,0,0,255],(row*width+col)*4);
            return {data};
        });
        const result=await readPdfScanGraphics({width:300,height:250} as HTMLCanvasElement,300);
        expect(result[0].rules).toContainEqual({kind:'path',x:20,y:60,width:161,height:0});
        expect(result[0].rules).toContainEqual({kind:'path',x:100,y:20,width:0,height:81});
        expect(canvas.width).toBe(0);
    });
    it.each(['context','pixels'] as const)('cleans up after %s failure', async stage => {
        if (stage === 'context') (canvas.getContext as any).mockReturnValue(null); else context.getImageData.mockImplementation(() => {throw new Error('pixels unavailable');});
        await expect(readPdfScanGraphics({width:100,height:100} as HTMLCanvasElement, 100)).rejects.toThrow(stage === 'context' ? 'Canvas' : 'pixels unavailable');
        expect(canvas).toMatchObject({width:0,height:0});
    });
    it.each([true,false])('cancels before work=%s and never publishes late regions', async before => {
        const controller = new AbortController(); if (before) controller.abort();
        const work = readPdfScanGraphics({width:2480,height:3508} as HTMLCanvasElement,595,controller.signal);
        if (!before) controller.abort();
        await expect(work).rejects.toMatchObject({name:'AbortError'}); expect(canvas).toMatchObject({width:0,height:0});
        expect(document.createElement).toHaveBeenCalledTimes(before ? 0 : 1);
    });

    it('crops only grid candidates, removes rules on a disposable copy and bounds total crop pixels', () => {
        const source={width:300,height:200} as HTMLCanvasElement;
        const candidate={x:10,y:20,width:200,height:100,rules:[{kind:'path' as const,x:10,y:20,width:200,height:0},{kind:'path' as const,x:10,y:20,width:0,height:100}]};
        const regions=cropPdfScanRegions(source,[{...candidate,rules:[]},candidate,candidate,candidate],300);
        expect(regions).toEqual([{graphicIndex:1,x:8,y:18,image:'data:image/png;base64,AQID'},{graphicIndex:2,x:8,y:18,image:'data:image/png;base64,AQID'},{graphicIndex:3,x:8,y:18}]);
        expect(context.drawImage).toHaveBeenCalledWith(source,8,18,204,104,0,0,204,104);
        expect(context.fillRect).toHaveBeenCalledWith(2,1,200,2);expect(context.fillRect).toHaveBeenCalledWith(1,2,2,100);
        expect(source).toEqual({width:300,height:200});expect(canvas).toMatchObject({width:0,height:0});
    });

    it.each(['context','encoding','cancel'] as const)('releases temporary crop canvas after %s failure',stage=>{
        const controller=new AbortController();
        if(stage==='context')(canvas.getContext as any).mockReturnValue(null);
        if(stage==='encoding')(canvas.toDataURL as any).mockImplementation(()=>{throw new Error('encoding failed');});
        if(stage==='cancel')(canvas.toDataURL as any).mockImplementation(()=>{controller.abort();return 'data:';});
        expect(()=>cropPdfScanRegions({width:300,height:200} as HTMLCanvasElement,[{x:10,y:20,width:100,height:80,rules:[{kind:'path',x:10,y:20,width:100,height:0}]}],300,controller.signal)).toThrow();
        expect(canvas).toMatchObject({width:0,height:0});
    });
    it('returns no crop for an ordinary figure and rejects pre-cancelled work before allocation',()=>{
        const source={width:300,height:200} as HTMLCanvasElement;
        expect(cropPdfScanRegions(source,[{x:10,y:20,width:100,height:80,rules:[]}],300)).toEqual([]);
        const controller=new AbortController();controller.abort();
        expect(()=>cropPdfScanRegions(source,[],300,controller.signal)).toThrow();expect(document.createElement).not.toHaveBeenCalled();
    });
});

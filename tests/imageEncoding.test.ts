import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {encodeImageCanvas,encodeReadingImageCanvas,readingImageEncodingBusy} from '@/src/features/image-translation/services/imageEncoding';

const readers: Reader[] = [];
class Reader {
    onload: (()=>void)|null = null;
    onerror: (()=>void)|null = null;
    readyState = 0;
    result: string|ArrayBuffer|null = null;
    abort = vi.fn(()=>{this.readyState=2;});
    readAsDataURL = vi.fn(()=>{this.readyState=1;});
    constructor() {readers.push(this);}
    complete(result: string|ArrayBuffer|null) {this.result=result;this.readyState=2;this.onload?.();}
}
function canvas() {
    let callback!: BlobCallback;
    const toBlob=vi.fn((notify:BlobCallback)=>{callback=notify;});
    return {canvas:{toBlob} as unknown as HTMLCanvasElement,toBlob,encoded:(blob:Blob|null=new Blob(['png']))=>callback(blob)};
}
beforeEach(()=>{vi.useFakeTimers();readers.length=0;vi.stubGlobal('FileReader',Reader);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('图片与 OCR 共用异步无损编码',()=>{
    it('物理编码回调重复或观察者抛错不会重复完成，正常结果仍可读取',async()=>{
        const image=canvas(),physical=vi.fn(()=>{throw Error('observer failed');});
        const result=encodeImageCanvas(image.canvas,undefined,{timeoutMs:30000,message:'timeout',onPhysicalSettled:physical});
        image.encoded();readers[0].complete('ok');expect(await result).toBe('ok');image.encoded();
        expect(physical).toHaveBeenCalledOnce();expect(readers).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['abort','timeout'] as const)('阅读编码 %s 后等待立即结束，但真实回调前无法再次编码或绕过重挂',async action=>{
        const image=canvas(),signal=new AbortController(),result=encodeReadingImageCanvas(image.canvas,signal.signal);
        const stopped=expect(result).rejects.toBeInstanceOf(Error);
        if(action==='abort')signal.abort();else await vi.advanceTimersByTimeAsync(30_000);
        await stopped;expect(readingImageEncodingBusy()).toBe(true);
        for(let i=0;i<3;i++){
            const next=canvas();await expect(encodeReadingImageCanvas(next.canvas,new AbortController().signal)).rejects.toMatchObject({code:'READING_ENCODER_BUSY'});
            expect(next.toBlob).not.toHaveBeenCalled();
        }
        image.encoded();expect(readers).toHaveLength(0);expect(readingImageEncodingBusy()).toBe(false);
        const next=canvas(),retry=encodeReadingImageCanvas(next.canvas,new AbortController().signal);next.encoded();readers[0].complete('ok');
        expect(await retry).toBe('ok');expect(readingImageEncodingBusy()).toBe(false);
    });
    it('阅读编码同步失败和预取消均不占用物理槽',async()=>{
        const image=canvas(),signal=new AbortController();signal.abort();
        await expect(encodeReadingImageCanvas(image.canvas,signal.signal)).rejects.toMatchObject({name:'AbortError'});expect(readingImageEncodingBusy()).toBe(false);
        image.toBlob.mockImplementation(()=>{throw new Error('failed');});
        await expect(encodeReadingImageCanvas(image.canvas,new AbortController().signal)).rejects.toThrow('failed');expect(readingImageEncodingBusy()).toBe(false);
    });
    it.each(['blob','reader'])('调用者的 %s 编码预算与超时文案在开始时冻结',async phase=>{
        const image=canvas(),budget={timeoutMs:100,message:'图片读取超时'};
        const outcome=encodeImageCanvas(image.canvas,undefined,budget).then(result=>({result}),error=>({error}));
        budget.timeoutMs=30000;budget.message='迟到改动';
        if(phase==='reader')image.encoded();
        await vi.advanceTimersByTimeAsync(99);expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);expect(await outcome).toMatchObject({error:{message:'图片读取超时'}});
        if(phase==='blob'){image.encoded();expect(readers).toHaveLength(0);}else expect(readers[0].abort).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('沿用 PNG data URL，不同步压缩且完成后释放读取事件与超时',async()=>{
        const image=canvas(),result=encodeImageCanvas(image.canvas);
        expect(image.toBlob).toHaveBeenCalledWith(expect.any(Function),'image/png');
        image.encoded();readers[0].complete('data:image/png;base64,test');
        expect(await result).toBe('data:image/png;base64,test');expect(readers[0].onload).toBeNull();
        expect(readers[0].abort).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });
    it('预取消不开始压缩，编码中取消立即结束并忽略迟到 Blob',async()=>{
        const controller=new AbortController();controller.abort();const image=canvas();
        await expect(encodeImageCanvas(image.canvas,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(image.toBlob).not.toHaveBeenCalled();
        const active=new AbortController(),result=encodeImageCanvas(image.canvas,active.signal);
        const stopped=expect(result).rejects.toMatchObject({name:'AbortError'});active.abort();await stopped;
        image.encoded();expect(readers).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
    });
    it('读取中取消释放读取器并阻止迟到事件重新完成',async()=>{
        const image=canvas(),controller=new AbortController(),result=encodeImageCanvas(image.canvas,controller.signal);
        image.encoded();const late=readers[0].onerror!;
        const stopped=expect(result).rejects.toMatchObject({name:'AbortError'});controller.abort();await stopped;
        expect(readers[0].abort).toHaveBeenCalledOnce();expect(readers[0].onerror).toBeNull();late();expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['blob','reader'])('在 %s 阶段超时会释放资源且丢弃迟到结果',async phase=>{
        const image=canvas(),result=encodeImageCanvas(image.canvas);if(phase==='reader')image.encoded();
        const failed=expect(result).rejects.toThrow('超时');await vi.advanceTimersByTimeAsync(30000);await failed;
        if(phase==='blob'){image.encoded();expect(readers).toHaveLength(0);}
        else expect(readers[0].abort).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['null','invalid-result','read-error','constructor','read-throw','encode-throw'])('处理 %s 故障，释放超时并允许下一张重试',async failure=>{
        const image=canvas();
        if(failure==='constructor')vi.stubGlobal('FileReader',class{constructor(){throw new Error('constructor');}});
        if(failure==='encode-throw')image.toBlob.mockImplementation(()=>{throw new Error('encode');});
        const result=encodeImageCanvas(image.canvas),failed=expect(result).rejects.toBeInstanceOf(Error);
        if(failure==='read-throw')vi.stubGlobal('FileReader',class extends Reader{constructor(){super();this.readAsDataURL.mockImplementation(()=>{throw new Error('read');});}});
        if(failure!=='encode-throw')image.encoded(failure==='null'?null:undefined);
        if(failure==='invalid-result')readers[0].complete(new ArrayBuffer(1));
        if(failure==='read-error')readers[0].onerror?.();
        await failed;expect(vi.getTimerCount()).toBe(0);
        vi.stubGlobal('FileReader',Reader);const retry=canvas(),retried=encodeImageCanvas(retry.canvas);retry.encoded();readers.at(-1)!.complete('ok');expect(await retried).toBe('ok');
    });
});

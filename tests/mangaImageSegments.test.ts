import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createMangaImageSegments} from '@/src/features/image-translation/content/mangaImageSegments';
import {composeMangaPage} from '@/src/features/image-translation/content/mangaCompositor';
import {encodeImageCanvas} from '@/src/features/image-translation/services/imageEncoding';
import {createMangaReadingSnapshots} from '@/src/features/image-translation/content/mangaReadingSnapshots';
vi.mock('@/src/features/image-translation/content/mangaCompositor', () => ({composeMangaPage: vi.fn()}));
vi.mock('@/src/features/image-translation/services/imageEncoding', () => ({encodeImageCanvas: vi.fn()}));
const flush = async () => {for (let i=0;i<20;i++) await Promise.resolve();};

function fixture(lightCacheLimits?:{pages:number;bytes:number}) {
    vi.mocked(encodeImageCanvas).mockImplementation(async canvas=>`data:image/png;base64,${canvas.width}x${canvas.height}`);
    const {document}=parseHTML('<html><body><div id="reader"><img src="https://cdn.example/chapter.webp"></div></body></html>');
    const image=document.querySelector('img')! as {-readonly [K in keyof HTMLImageElement]: HTMLImageElement[K]};
    Object.defineProperties(image,{complete:{value:true,writable:true},naturalWidth:{value:800,writable:true},naturalHeight:{value:15744,writable:true}});
    const rect={left:20,top:0,width:400,height:7872,right:420,bottom:7872};image.getBoundingClientRect=()=>rect as DOMRect;
    const style={display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible',objectFit:'fill',paddingTop:'0',paddingLeft:'0',paddingRight:'0',paddingBottom:'0',borderTopWidth:'0',borderLeftWidth:'0',borderRightWidth:'0',borderBottomWidth:'0'};
    class Rect {right:number;bottom:number;constructor(public left:number,public top:number,public width:number,public height:number){this.right=left+width;this.bottom=top+height;}}
    const decoded: FakeImage[]=[],canvases: HTMLCanvasElement[]=[],draws: unknown[][]=[];
    class FakeImage {src='';naturalWidth=800;naturalHeight=15744;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;constructor(){decoded.push(this);}}
    let taint=false,missing=false,drawError=false;
    const create=document.createElement.bind(document);
    vi.spyOn(document,'createElement').mockImplementation(((tag:string)=>{
        const element=create(tag);
        if(tag==='canvas') {
            const canvas=element as HTMLCanvasElement;canvases.push(canvas);let source:unknown;
            canvas.getContext=vi.fn(()=>missing?null:{
                drawImage:(...args:unknown[])=>{draws.push(args);source=args[0];if(drawError)throw new Error('draw failed');},
                getImageData:()=>{if(taint&&source===image)throw new DOMException('tainted','SecurityError');return {data:new Uint8ClampedArray(4)};},
            }) as typeof canvas.getContext;
            canvas.toDataURL=vi.fn(()=>`data:image/png;base64,${canvas.width}x${canvas.height}`);
        }
        return element;
    }) as typeof document.createElement);
    vi.stubGlobal('document',document);vi.stubGlobal('window',{innerWidth:1280,innerHeight:900});vi.stubGlobal('DOMRect',Rect);vi.stubGlobal('Image',FakeImage);vi.stubGlobal('getComputedStyle',()=>style);
    document.elementFromPoint=()=>image;
    const ports={enabled:vi.fn(()=>true),configurationIdentity:vi.fn(()=>'config'),cacheEnabled:vi.fn(()=>true),imageIdentity:vi.fn((img:HTMLImageElement)=>img.src),readSource:vi.fn().mockResolvedValue('data:image/webp;base64,source'),translate:vi.fn().mockResolvedValue({mangaPatches:{width:800,height:2560,patches:[{x:1,y:1,width:1,height:1,image:'data:image/png;base64,AQ=='}]},lines:[{text:'译文',bbox:{x0:1,y0:1,x1:2,y1:2},backgroundColor:'#fff'}]})};
    const composed:HTMLCanvasElement[]=[];
    vi.mocked(composeMangaPage).mockImplementation(async()=>{const c=document.createElement('canvas') as HTMLCanvasElement;c.width=800;c.height=2560;composed.push(c);return c;});
    const readingSnapshots=createMangaReadingSnapshots();
    const runtime=createMangaImageSegments({...ports,readingSnapshots,lightCacheLimits});
    const segments=()=>runtime.prepare([image]).get(image)!;
    return {document,image,rect,style,decoded,canvases,draws,ports,composed,runtime,segments,readingSnapshots,taint:()=>{taint=true;},missing:()=>{missing=true;},drawError:()=>{drawError=true;}};
}
afterEach(()=>{vi.restoreAllMocks();vi.resetAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('超长漫画图片的稳定分段与原始分辨率',()=>{
    it('不同长图段挤出轻缓存时仍可读旧活动段，释放后回收文字',async()=>{
        const f=fixture({pages:1,bytes:1024*1024}),segments=f.segments();f.rect.top=-1024;f.rect.bottom-=1024;
        await f.runtime.translate(segments[1]);expect(f.readingSnapshots.stats().entries).toBe(0);
        f.rect.top=-2048;await f.runtime.translate(segments[2]);expect(f.readingSnapshots.stats().entries).toBe(1);
        f.rect.top=-1024;expect((await f.runtime.readLines(segments[1],new AbortController().signal)).status).toBe('ready');
        expect(f.ports.translate).toHaveBeenCalledTimes(2);f.runtime.release(segments[1]);expect(f.readingSnapshots.stats().entries).toBe(0);f.runtime.dispose();
    });
    it('覆盖首尾且保持自然宽度，每段有上下文；未进入队列不读取整图或创建画布',()=>{
        const f=fixture(),segments=f.segments();expect(segments).toHaveLength(8);
        expect(segments[0]).toMatchObject({top:0,height:2048,width:800,contextTop:0,contextHeight:2304});
        expect(segments[1]).toMatchObject({top:2048,height:2048,contextTop:1792,contextHeight:2560});
        expect(segments.at(-1)!.top+segments.at(-1)!.height).toBe(15744);
        expect(f.runtime.prepare([f.image]).get(f.image)).toBe(segments);expect(f.canvases).toHaveLength(0);expect(f.ports.readSource).not.toHaveBeenCalled();
        const bounds=f.runtime.bounds(segments[1]);expect(bounds).toMatchObject({left:20,top:1024,width:400,height:1024});
        expect(f.runtime.pixels(segments[1])).toBe(800*2560);f.runtime.dispose();
    });
    it('读取上下文而只覆盖核心段，滚动缩放保持定位，暂停和返页复用不改原图',async()=>{
        const f=fixture(),original=f.image.outerHTML,segment=f.segments()[1];
        f.rect.top=-1024;f.rect.bottom-=1024;await f.runtime.translate(segment);
        expect(f.draws[0]).toEqual([f.image,0,1792,800,2560,0,0,800,2560]);
        expect(f.ports.translate.mock.calls[0][0]).toBe('data:image/png;base64,800x2560');
        const output=f.canvases.at(-1)!;expect(output.width).toBe(800);expect(output.height).toBe(2048);expect(output.style.top).toBe('0px');
        expect(f.draws.at(-1)!.slice(1)).toEqual([0,256,800,2048,0,0,800,2048]);expect(f.composed[0].width).toBe(0);
        expect(f.document.getElementById('fluent-read-manga-segment-container')).not.toBeNull();
        f.runtime.restore(segment);expect(output.isConnected).toBe(false);expect(f.runtime.reuse(segment)).toBe(true);expect(output.isConnected).toBe(true);
        f.rect.top=-1100;f.runtime.update();expect(output.style.top).toBe('-76px');
        f.runtime.release(segment);expect(output.width).toBe(0);await f.runtime.translate(segment);expect(f.ports.translate).toHaveBeenCalledOnce();
        expect(f.image.outerHTML).toBe(original);f.runtime.dispose();expect(f.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);
        expect(f.runtime.prepare([f.image]).size).toBe(0);expect(f.runtime.identity(segment)).toBeNull();
    });
    it('按需读取指定可见片段，不重新加载图片或翻译，换源后拒绝旧片段',async()=>{
        const f=fixture(),segment=f.segments()[1];f.rect.top=-1024;f.rect.bottom-=1024;
        await f.runtime.translate(segment);const reads=f.ports.readSource.mock.calls.length;
        expect(f.runtime.readingVisible(segment)).toBe(true);
        expect(await f.runtime.readLines(segment,new AbortController().signal)).toMatchObject({status:'ready',lines:[{text:'译文'}]});
        expect(f.ports.readSource).toHaveBeenCalledTimes(reads);expect(f.ports.translate).toHaveBeenCalledOnce();
        f.image.src='https://cdn.example/other.webp';
        expect(await f.runtime.readLines(segment,new AbortController().signal)).toEqual({status:'stale'});f.runtime.dispose();
    });
    it('宽长图按像素预算减小段高，尾段不遗漏小于一行的像素',()=>{
        const f=fixture();f.image.naturalWidth=4096;f.image.naturalHeight=15001;
        const segments=f.segments();expect(segments.every(s=>f.runtime.pixels(s)<=6_000_000)).toBe(true);expect(segments.at(-1)!.top+segments.at(-1)!.height).toBe(15001);f.runtime.dispose();
    });
    it.each(['loading','narrow','wide','short','tall','pixels','border','padding','cover','contain-mismatch'])('不可靠尺寸或显示方式保留现有图片路径 %s',mode=>{
        const f=fixture();
        if(mode==='loading')Object.assign(f.image,{complete:false});if(mode==='narrow')f.image.naturalWidth=79;if(mode==='wide')f.image.naturalWidth=4097;
        if(mode==='short')f.image.naturalHeight=4096;if(mode==='tall')f.image.naturalHeight=100001;if(mode==='pixels'){f.image.naturalWidth=4096;f.image.naturalHeight=50000;}
        if(mode==='border')f.style.borderTopWidth='1px';if(mode==='padding')f.style.paddingLeft='2px';if(mode==='cover')f.style.objectFit='cover';
        if(mode==='contain-mismatch'){f.style.objectFit='contain';f.rect.height=100;}
        expect(f.runtime.prepare([f.image]).size).toBe(0);expect(f.canvases).toHaveLength(0);f.runtime.dispose();
    });
    it('默认和 contain 自然比例可以分段，正文来源、尺寸或重载变化使旧键失效',()=>{
        const f=fixture();f.style.objectFit='';const first=f.segments()[0],identity=f.runtime.identity(first);f.style.objectFit='contain';expect(f.runtime.identity(first)).toBe(identity);
        f.ports.imageIdentity.mockReturnValue('reloaded');expect(f.runtime.identity(first)).toBeNull();const second=f.segments()[0];expect(second).not.toBe(first);
        f.image.naturalHeight=16000;expect(f.runtime.identity(second)).toBeNull();const third=f.segments()[0];expect(third).not.toBe(second);
        f.runtime.prepare([]);expect(f.runtime.identity(third)).toBeNull();f.runtime.resetCache();f.runtime.dispose();
    });
    it('受污染原图只读取当前授权来源，完整解码后仅绘制该段并立即释放解码资源',async()=>{
        const f=fixture(),segment=f.segments()[2];f.rect.top=-2048;f.taint();const task=f.runtime.translate(segment);await flush();
        expect(f.ports.readSource).toHaveBeenCalledWith(f.image,expect.any(AbortSignal));expect(f.decoded).toHaveLength(1);f.decoded[0].onload!();await task;
        expect(f.decoded[0].src).toBe('');expect(f.ports.translate.mock.calls[0][0]).toBe('data:image/png;base64,800x2560');expect(f.image.src).toBe('https://cdn.example/chapter.webp');f.runtime.dispose();
    });
    it('取消解码后迟到的已排队 load 和 error 不重新分配快照或启动 OCR',async()=>{
        const f=fixture(),segment=f.segments()[0];f.taint();const task=f.runtime.translate(segment);await flush();
        const lateLoad=f.decoded[0].onload!,lateError=f.decoded[0].onerror!;f.runtime.restore(segment);await task;
        lateLoad();lateError();await flush();expect(f.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(f.ports.translate).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it.each(['load','timeout','size','source','pause','remove','decode-draw'])('远程解码失败或任务失效不发送旧 OCR %s',async mode=>{
        vi.useFakeTimers();const f=fixture(),segment=f.segments()[0];f.taint();const task=f.runtime.translate(segment);const checked=['load','timeout','size','decode-draw'].includes(mode)?expect(task).rejects.toThrow():task;
        await flush();const image=f.decoded[0];
        if(mode==='load')image.onerror!();else if(mode==='timeout')await vi.advanceTimersByTimeAsync(15000);
        else if(mode==='pause')f.runtime.restore(segment);
        else {if(mode==='size')image.naturalWidth=801;if(mode==='source')f.image.src='https://cdn.example/replaced';if(mode==='remove'){f.image.remove();f.runtime.update();}if(mode==='decode-draw')f.drawError();image.onload?.();}
        await checked;expect(image.src).toBe('');expect(f.ports.translate).not.toHaveBeenCalled();f.runtime.dispose();expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['context','draw','read','abort','late-read','source-during-read'])('快照或来源读取边界保留原图，不复活取消结果 %s',async mode=>{
        const f=fixture(),segment=f.segments()[0];
        if(mode==='context')f.missing();if(mode==='draw')f.drawError();
        if(['read','abort','late-read','source-during-read'].includes(mode)) {
            f.taint();
            if(mode==='read')f.ports.readSource.mockRejectedValue(new Error('read failed'));
            if(mode==='abort')f.ports.readSource.mockImplementation(async(_image,signal)=>{f.runtime.restore(segment);signal.throwIfAborted();});
            if(mode==='late-read')f.ports.readSource.mockImplementation(async()=>{f.runtime.restore(segment);return 'data:image/png;base64,AQ==';});
            if(mode==='source-during-read')f.ports.readSource.mockImplementation(async()=>{f.image.src='https://cdn.example/new';return 'data:image/png;base64,AQ==';});
        }
        const task=f.runtime.translate(segment);
        if(['abort','late-read','source-during-read'].includes(mode))await task;else await expect(task).rejects.toThrow();
        expect(f.ports.translate).not.toHaveBeenCalled();expect(f.decoded).toHaveLength(0);f.runtime.dispose();
    });
});

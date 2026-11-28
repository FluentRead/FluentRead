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
                getImageData:()=>{if(taint&&source&&typeof source==='object'&&'tagName' in source&&source.tagName==='IMG')throw new DOMException('tainted','SecurityError');return {data:new Uint8ClampedArray(4)};},
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
    it.each(['','fill'])('默认或 fill 的准备与身份检查不读取未使用的矩形：%s',fit=>{
        const f=fixture();f.style.objectFit=fit;
        const rect=vi.spyOn(f.image,'getBoundingClientRect'),segments=f.segments();
        for(const segment of segments)expect(f.runtime.identity(segment)).not.toBeNull();
        expect(rect).not.toHaveBeenCalled();
        for(const segment of segments)f.runtime.bounds(segment);
        expect(rect).toHaveBeenCalledTimes(segments.length);f.runtime.dispose();
    });
    it('contain 准备和每次身份检查仍核对实时宽高比',()=>{
        const f=fixture();f.style.objectFit='contain';
        const rect=vi.spyOn(f.image,'getBoundingClientRect'),segments=f.segments();
        expect(rect).toHaveBeenCalledOnce();
        expect(f.runtime.identity(segments[0])).not.toBeNull();f.runtime.bounds(segments[0]);
        f.rect.height=100;
        expect(f.runtime.identity(segments[1])).toBeNull();expect(rect).toHaveBeenCalledTimes(4);f.runtime.dispose();
    });
    it.each(['','fill','contain'])('只在实际使用几何的端口传播矩形异常：%s',fit=>{
        const f=fixture();f.style.objectFit=fit;
        const rect=vi.spyOn(f.image,'getBoundingClientRect').mockImplementation(()=>{throw new Error('layout failed');});
        if(fit==='contain')expect(()=>f.segments()).toThrow('layout failed');
        else {
            const segment=f.segments()[0];expect(f.runtime.identity(segment)).not.toBeNull();
            expect(rect).not.toHaveBeenCalled();expect(()=>f.runtime.bounds(segment)).toThrow('layout failed');
        }
        f.runtime.dispose();
    });
    it('objectFit 改变后重新校验，不缓存旧显示方式或宽高比',()=>{
        const f=fixture(),segment=f.segments()[0],rect=vi.spyOn(f.image,'getBoundingClientRect');
        f.style.objectFit='contain';f.rect.height=100;expect(f.runtime.identity(segment)).toBeNull();
        f.rect.height=7872;expect(f.runtime.identity(segment)).not.toBeNull();expect(rect).toHaveBeenCalledTimes(2);
        f.style.objectFit='cover';expect(f.runtime.identity(segment)).toBeNull();expect(rect).toHaveBeenCalledTimes(2);
        f.style.objectFit='fill';expect(f.runtime.identity(segment)).not.toBeNull();expect(rect).toHaveBeenCalledTimes(2);
        vi.stubGlobal('getComputedStyle',()=>{throw new Error('style failed');});
        expect(()=>f.runtime.identity(segment)).toThrow('style failed');f.runtime.dispose();
    });
    it('身份端口同步改变几何或样式后，下一段仍读取新状态',()=>{
        const f=fixture(),segments=f.segments();
        f.ports.imageIdentity.mockImplementationOnce(image=>{f.rect.top=-100;f.style.borderTopWidth='2px';return image.src;});
        expect(f.runtime.identity(segments[0])).not.toBeNull();expect(f.runtime.bounds(segments[0]).top).toBe(-100);
        expect(f.runtime.identity(segments[1])).toBeNull();f.runtime.dispose();
    });
    it('配置端口同步换图后，下一段不再沿用旧来源',()=>{
        const f=fixture(),segments=f.segments();
        f.ports.configurationIdentity.mockImplementationOnce(()=>{f.image.src='https://cdn.example/new';return 'config';});
        expect(f.runtime.identity(segments[0])).not.toBeNull();expect(f.runtime.identity(segments[1])).toBeNull();f.runtime.dispose();
    });
    it('读取上下文而只覆盖核心段，滚动缩放保持定位，暂停和返页复用不改原图',async()=>{
        const f=fixture(),original=f.image.outerHTML,segment=f.segments()[1];
        f.rect.top=-1024;f.rect.bottom-=1024;await f.runtime.translate(segment);
        expect(f.draws[0]).toEqual([f.image,0,1792,800,2560,0,0,800,2560]);
        expect(f.ports.translate.mock.calls[0][0]).toBe('data:image/png;base64,800x2560');
        expect(f.ports.translate).toHaveBeenCalledWith('data:image/png;base64,800x2560',expect.any(AbortSignal),{x:0,y:256,width:800,height:2048});
        expect(Object.isFrozen(f.ports.translate.mock.calls[0][2])).toBe(true);
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
    it('受污染原图只读取当前授权来源，同长图多段复用单条解码缓存并立即释放 img.src，换图和卸载关闭位图',async()=>{
        const bitmaps: Array<{width:number;height:number;close:ReturnType<typeof vi.fn>}>=[];
        vi.stubGlobal('createImageBitmap',vi.fn(async(img:HTMLImageElement)=>{
            const bmp={width:img.naturalWidth,height:img.naturalHeight,close:vi.fn()};bitmaps.push(bmp);return bmp;
        }));
        const f=fixture(),segments=f.segments();f.rect.top=-2048;f.taint();
        const task=f.runtime.translate(segments[2]);await flush();
        expect(f.ports.readSource).toHaveBeenCalledWith(f.image,expect.any(AbortSignal));expect(f.decoded).toHaveLength(1);
        f.decoded[0].onload!();await task;
        // ImageBitmap 捕获后立即释放临时 HTMLImageElement 的 data URL。
        expect(f.decoded[0].src).toBe('');expect(bitmaps).toHaveLength(1);
        // 第二段直接复用已缓存的 ImageBitmap，不重复 readSource 或新建 Image 解码。
        f.rect.top=-3072;await f.runtime.translate(segments[3]);
        expect(f.ports.readSource).toHaveBeenCalledOnce();expect(f.decoded).toHaveLength(1);
        expect(f.ports.translate.mock.calls[0][0]).toBe('data:image/png;base64,800x2560');expect(f.image.src).toBe('https://cdn.example/chapter.webp');
        // 换图或卸载立即关闭位图。
        f.runtime.dispose();expect(bitmaps[0].close).toHaveBeenCalledOnce();
    });
    it('createImageBitmap 异步完成期间取消或换源立即关闭迟到位图且不缓存',async()=>{
        let resolveBitmap!:(bmp:{width:number;height:number;close:ReturnType<typeof vi.fn>})=>void;
        vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(resolve=>{resolveBitmap=resolve;})));
        const f=fixture(),segments=f.segments();f.taint();
        const task=f.runtime.translate(segments[0]);await flush();
        f.decoded[0].onload!();await flush();
        f.image.src='https://cdn.example/changed.webp';
        const lateBmp={width:800,height:15744,close:vi.fn()};
        resolveBitmap(lateBmp);await task;
        expect(lateBmp.close).toHaveBeenCalledOnce();
        expect(f.ports.translate).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it('并发读取同一受污染长图去重 readSource，单等待者取消不中断其余段，换源或换图立即驱逐旧缓存',async()=>{
        const f=fixture(),segments=f.segments();f.taint();
        let resolveSource!:(value:string)=>void;
        f.ports.readSource.mockImplementationOnce(()=>new Promise<string>(resolve=>{resolveSource=resolve;}));
        const first=f.runtime.translate(segments[0]),second=f.runtime.translate(segments[1]);
        await flush();
        expect(f.ports.readSource).toHaveBeenCalledOnce();
        // 取消首个等待者后，第二个等待者仍复用同一次 readSource 完成解码。
        f.runtime.restore(segments[0]);await first;
        resolveSource('data:image/webp;base64,shared');await flush();
        expect(f.decoded).toHaveLength(1);f.decoded[0].onload!();await second;
        expect(f.decoded[0].src).toBe('');expect(f.ports.translate).toHaveBeenCalledOnce();
        // 同长图再次翻译复用单条缓存，不重复调用 readSource。
        const third=f.runtime.translate(segments[2]);await flush();
        expect(f.ports.readSource).toHaveBeenCalledOnce();
        f.decoded[1].onload!();await third;
        // 换到另一条长图时驱逐旧缓存。
        const other=f.document.createElement('img') as {-readonly [K in keyof HTMLImageElement]: HTMLImageElement[K]};
        other.src='https://cdn.example/chapter-2.webp';
        Object.defineProperties(other,{complete:{value:true,writable:true},naturalWidth:{value:800,writable:true},naturalHeight:{value:15744,writable:true}});
        other.getBoundingClientRect=f.image.getBoundingClientRect;f.document.getElementById('reader')!.append(other);
        const otherSegments=f.runtime.prepare([f.image,other]).get(other)!;
        const otherTask=f.runtime.translate(otherSegments[0]);await flush();
        expect(f.ports.readSource).toHaveBeenCalledTimes(2);
        f.decoded[2].onload!();await otherTask;
        // prepare 中原图移除后立即驱逐该解码缓存。
        f.runtime.prepare([]);
        // 并发读取失败时所有等待者均拒绝且不污染缓存。
        const refreshed=f.segments();
        let rejectSource!:(error:Error)=>void;
        f.ports.readSource.mockImplementationOnce(()=>new Promise<string>((_resolve,reject)=>{rejectSource=reject;}));
        const failA=f.runtime.translate(refreshed[0]),failB=f.runtime.translate(refreshed[1]);
        await flush();
        rejectSource(new Error('network down'));
        await expect(failA).rejects.toThrow('network down');
        await expect(failB).rejects.toThrow('network down');
        // resetCache 取消在途读取并清空缓存。
        f.ports.readSource.mockImplementationOnce(()=>new Promise<string>(()=>{/* pending */}));
        const pending=f.runtime.translate(refreshed[0]);await flush();
        f.runtime.resetCache();await pending;
        f.runtime.dispose();
    });
    it('withFrame 帧级缓存将同一长图多段的样式、身份与矩形查询收敛为 O(1)，嵌套调用安全复用并在结束释放',async()=>{
        const f=fixture();f.style.objectFit='contain';
        const styleSpy=vi.fn(()=>f.style);vi.stubGlobal('getComputedStyle',styleSpy);
        const rectSpy=vi.spyOn(f.image,'getBoundingClientRect');
        const segments=f.segments();
        styleSpy.mockClear();rectSpy.mockClear();
        f.runtime.withFrame(()=>{
            f.runtime.withFrame(()=>{
                for(const segment of segments){
                    expect(f.runtime.identity(segment)).not.toBeNull();
                    f.runtime.bounds(segment);
                }
            });
        });
        expect(styleSpy).toHaveBeenCalledOnce();expect(rectSpy).toHaveBeenCalledOnce();
        // 离开帧缓存后立即恢复实时查询。
        f.rect.height=100;expect(f.runtime.identity(segments[0])).toBeNull();
        f.runtime.dispose();
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
    it('并发加载两条受污染长图期间 dispose/resetCache 中止全部在途加载且不泄漏位图，引用计数防止提前关闭在用位图',async()=>{
        const bitmaps: Array<{id:string;width:number;height:number;closed:boolean;close:ReturnType<typeof vi.fn>}>=[];
        const pendingBitmaps: Array<(bmp: {id:string;width:number;height:number;closed:boolean;close:ReturnType<typeof vi.fn>})=>void>=[];
        vi.stubGlobal('createImageBitmap',vi.fn(()=>new Promise(resolve=>{
            pendingBitmaps.push(bmp=>{bitmaps.push(bmp);resolve(bmp);});
        })));
        const makeBitmap=(id:string)=>{
            const bmp={id,width:800,height:15744,closed:false,close:vi.fn(()=>{bmp.closed=true;})};
            return bmp;
        };
        const f=fixture();f.taint();
        const other=f.document.createElement('img') as {-readonly [K in keyof HTMLImageElement]: HTMLImageElement[K]};
        other.src='https://cdn.example/chapter-b.webp';
        Object.defineProperties(other,{complete:{value:true,writable:true},naturalWidth:{value:800,writable:true},naturalHeight:{value:15744,writable:true}});
        other.getBoundingClientRect=f.image.getBoundingClientRect;f.document.getElementById('reader')!.append(other);
        const prepared=f.runtime.prepare([f.image,other]);
        const segA=prepared.get(f.image)!,segB=prepared.get(other)!;
        // 1. 两条不同长图同时在途 readSource，resetCache 必须中止全部 pendingStrips 并在迟到完成时立刻关闭位图。
        const resolvers: Array<(value:string)=>void>=[];
        f.ports.readSource.mockImplementation(()=>new Promise<string>(resolve=>{resolvers.push(resolve);}));
        const taskA1=f.runtime.translate(segA[0]),taskB1=f.runtime.translate(segB[0]);
        await flush();
        expect(resolvers).toHaveLength(2);
        resolvers[0]('data:image/webp;base64,a1');resolvers[1]('data:image/webp;base64,b1');
        await flush();
        expect(f.decoded).toHaveLength(2);
        f.decoded[0].onload!();f.decoded[1].onload!();
        await flush();
        expect(pendingBitmaps).toHaveLength(2);
        const lateA1=makeBitmap('lateA1'),lateB1=makeBitmap('lateB1');
        // 等待 decodeImageData 收尾后再触发 resetCache，精准命中 .then(strip => ...) 的中止清理分支，确保两张位图关闭且不入缓存。
        pendingBitmaps[0](lateA1);pendingBitmaps[1](lateB1);
        await Promise.resolve();await Promise.resolve();
        f.runtime.resetCache();
        await Promise.all([taskA1,taskB1]);
        await flush();
        expect(lateA1.close).toHaveBeenCalledOnce();
        expect(lateB1.close).toHaveBeenCalledOnce();
        // 2. 两条长图并发读取，A 正在使用缓存（users=1）时 B 进入并驱逐 A，A 的位图不得在 draw 期间被关闭（无 InvalidStateError），A 结束后自动关闭。
        const prepared2=f.runtime.prepare([f.image,other]);
        const segA2=prepared2.get(f.image)!,segB2=prepared2.get(other)!;
        resolvers.length=0;pendingBitmaps.length=0;f.decoded.length=0;
        f.ports.readSource.mockReset().mockResolvedValue('data:image/webp;base64,default');
        const activeA=makeBitmap('activeA'),activeB=makeBitmap('activeB');
        // 先让 A 完整进入 decodedStrip 缓存。
        f.ports.readSource.mockResolvedValueOnce('data:image/webp;base64,a2');
        const warmA=f.runtime.translate(segA2[0]);await flush();
        f.decoded[0].onload!();await flush();
        pendingBitmaps[0](activeA);await warmA;
        expect(activeA.closed).toBe(false);
        // 先启动 A[1]（同步命中缓存并 users++），在 A[1] 恢复 draw 前启动 B[0]（同步 evictDecodedStrip 将 A 标为 evicted，因 users=1 暂不关闭）。
        let resolveB!: (value:string)=>void;
        f.ports.readSource.mockImplementationOnce(()=>new Promise<string>(resolve=>{resolveB=resolve;}));
        const useA=f.runtime.translate(segA2[1]);
        const useB=f.runtime.translate(segB2[0]);
        expect(activeA.closed).toBe(false);
        await useA;
        // A[1] draw 成功完成后，因 A 已被 B 驱逐且 users 归零，activeA 恰好关闭一次。
        expect(activeA.close).toHaveBeenCalledOnce();
        resolveB('data:image/webp;base64,b2');await flush();
        f.decoded[1].onload!();await flush();
        pendingBitmaps[1](activeB);
        await useB;
        expect(activeB.closed).toBe(false);
        // 3. 在途加载期间 dispose()，迟到 resolve 的位图立即关闭且不进入缓存。
        const third=f.document.createElement('img') as {-readonly [K in keyof HTMLImageElement]: HTMLImageElement[K]};
        third.src='https://cdn.example/chapter-c.webp';
        Object.defineProperties(third,{complete:{value:true,writable:true},naturalWidth:{value:800,writable:true},naturalHeight:{value:15744,writable:true}});
        third.getBoundingClientRect=f.image.getBoundingClientRect;f.document.getElementById('reader')!.append(third);
        const segC=f.runtime.prepare([f.image,other,third]).get(third)!;
        pendingBitmaps.length=0;f.decoded.length=0;
        f.ports.readSource.mockResolvedValueOnce('data:image/webp;base64,c');
        const taskC=f.runtime.translate(segC[0]);await flush();
        f.decoded[0].onload!();await flush();
        const lateC=makeBitmap('lateC');
        pendingBitmaps[0](lateC);
        await Promise.resolve();await Promise.resolve();
        f.runtime.dispose();
        await taskC;await flush();
        expect(lateC.close).toHaveBeenCalledOnce();
        expect(activeB.close).toHaveBeenCalledOnce();
    });
    it('capture 绘制失败时只驱逐仍是当前 decodedStrip 的缓存，不误删已被其他长图替换的缓存',async()=>{
        const bitmaps: Array<{width:number;height:number;close:ReturnType<typeof vi.fn>}>=[];
        vi.stubGlobal('createImageBitmap',vi.fn(async(img:HTMLImageElement)=>{
            const bmp={width:img.naturalWidth,height:img.naturalHeight,close:vi.fn()};bitmaps.push(bmp);return bmp;
        }));
        const f=fixture();f.taint();
        const other=f.document.createElement('img') as {-readonly [K in keyof HTMLImageElement]: HTMLImageElement[K]};
        other.src='https://cdn.example/chapter-b2.webp';
        Object.defineProperties(other,{complete:{value:true,writable:true},naturalWidth:{value:800,writable:true},naturalHeight:{value:15744,writable:true}});
        other.getBoundingClientRect=f.image.getBoundingClientRect;f.document.getElementById('reader')!.append(other);
        const prepared=f.runtime.prepare([f.image,other]);
        const segA=prepared.get(f.image)!;
        // 先加载 A 进入 decodedStrip，再篡改缓存 bitmap 尺寸使 draw(strip.bitmap) 抛错，验证当前 decodedStrip 被驱逐并关闭。
        const warmA=f.runtime.translate(segA[0]);await flush();f.decoded[0].onload!();await warmA;
        bitmaps[0].width=801;
        const failA=f.runtime.translate(segA[1]);
        await expect(failA).rejects.toThrow('漫画图片来源已更换');
        expect(bitmaps[0].close).toHaveBeenCalledOnce();
        // 再测试 strip 已被 B 替换时 A 的 draw 抛错不误删 B：用无 createImageBitmap 的异步 decodeImageData 路径覆盖。
        vi.stubGlobal('createImageBitmap',undefined);
        const f2=fixture();f2.taint();
        const other2=f2.document.createElement('img') as {-readonly [K in keyof HTMLImageElement]: HTMLImageElement[K]};
        other2.src='https://cdn.example/chapter-b3.webp';
        Object.defineProperties(other2,{complete:{value:true,writable:true},naturalWidth:{value:800,writable:true},naturalHeight:{value:15744,writable:true}});
        other2.getBoundingClientRect=f2.image.getBoundingClientRect;f2.document.getElementById('reader')!.append(other2);
        const p2=f2.runtime.prepare([f2.image,other2]);
        const sA=p2.get(f2.image)!,sB=p2.get(other2)!;
        const tA=f2.runtime.translate(sA[0]);await flush();
        // sA 进入 decodeImageData 等待 onload；此时 sB 完成并把 decodedStrip 换成 B。
        const tB=f2.runtime.translate(sB[0]);await flush();
        f2.decoded[1].onload!();await tB;
        // sA 的 decodeImageData 失败，此时 decodedStrip 是 B，不应误驱逐 B。
        f2.decoded[0].onerror!();await expect(tA).rejects.toThrow('漫画图片无法读取');
        const tB2=f2.runtime.translate(sB[1]);await flush();
        expect(f2.ports.readSource).toHaveBeenCalledTimes(2);
        f2.decoded[2].onload!();await tB2;
        f.runtime.dispose();f2.runtime.dispose();
    });
});

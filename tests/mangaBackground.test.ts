import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createMangaBackground} from '@/src/features/image-translation/content/mangaBackground';
import {composeMangaPage} from '@/src/features/image-translation/content/mangaCompositor';
import {encodeImageCanvas} from '@/src/features/image-translation/services/imageEncoding';
import * as canvasModule from '@/src/features/image-translation/content/mangaCanvas';
import {createMangaReadingSnapshots} from '@/src/features/image-translation/content/mangaReadingSnapshots';
vi.mock('@/src/features/image-translation/content/mangaCompositor', () => ({composeMangaPage: vi.fn()}));
vi.mock('@/src/features/image-translation/services/imageEncoding', () => ({encodeImageCanvas: vi.fn()}));
const flush = async () => {for (let n=0;n<20;n++) await Promise.resolve();};

function fixture(acceptsInteractionLayer?: (element: HTMLElement, hit: Element) => boolean) {
    vi.mocked(encodeImageCanvas).mockResolvedValue('data:image/png;base64,AQ==');
    const {document}=parseHTML('<html><body><div id="page-1" style="background-image:url(blob:https://palcy.jp/page-1)"></div></body></html>');
    const element=document.getElementById('page-1')! as HTMLElement;
    // linkedom 不实现 priority；用真实属性文本保存它，以覆盖 raw attribute 恢复及宿主写入。
    const actualStyle=element.style;
    Object.defineProperty(element,'style',{value:new Proxy(actualStyle,{
        get(target,property){
            if(property==='getPropertyPriority')return(name:string)=>/\s*!important\s*$/.test(actualStyle.getPropertyValue(name)||'')?'important':'';
            if(property==='getPropertyValue')return(name:string)=>(actualStyle.getPropertyValue(name)||'').replace(/\s*!important\s*$/,'');
            if(property==='setProperty')return(name:string,value:string,priority='')=>actualStyle.setProperty(name,`${value}${priority?' !important':''}`);
            const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
        },
    })});
    const rect={left:0,top:0,right:640,bottom:900,width:640,height:900};element.getBoundingClientRect=()=>rect as DOMRect;
    const style={display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible',
        backgroundSize:'contain',backgroundRepeat:'no-repeat',backgroundOrigin:'padding-box',backgroundImage:'url("blob:https://palcy.jp/page-1")',backgroundPosition:'100% 50%',
        paddingTop:'0px',paddingRight:'0px',paddingBottom:'0px',paddingLeft:'0px',borderTopWidth:'0px',borderRightWidth:'0px',borderBottomWidth:'0px',borderLeftWidth:'0px'};
    class Rect {right:number;bottom:number;constructor(public left:number, public top:number, public width:number, public height:number) {this.right=left+width;this.bottom=top+height;}}
    const images: FakeImage[]=[];let autoDecode=true;
    class FakeImage {
        private source='';naturalWidth=713;naturalHeight=1024;
        get src(){return this.source;}
        set src(value:string){this.source=value;if(autoDecode&&value.includes('fluent-read-translated-'))queueMicrotask(()=>this.onload?.());}
        onload:(()=>void)|null=null;onerror:(()=>void)|null=null;
        constructor(){images.push(this);}
    }
    const canvases:HTMLCanvasElement[]=[],outputs:HTMLCanvasElement[]=[];
    const encodeBlob=vi.fn((callback:BlobCallback)=>callback(new Blob(['translated'],{type:'image/png'})));
    let urls=0;
    const createUrl=vi.spyOn(URL,'createObjectURL').mockImplementation(()=>`blob:https://palcy.jp/fluent-read-translated-${++urls}`);
    const revokeUrl=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
    let tainted=false, missing=false, denyPresentation=false;
    const create=document.createElement.bind(document);
    vi.spyOn(document,'createElement').mockImplementation(((tag:string)=>{
        const value=create(tag);
        if(tag==='canvas') {
            const canvas=value as HTMLCanvasElement;canvases.push(canvas);
            canvas.getContext=vi.fn(()=>missing?null:{drawImage:vi.fn(),getImageData:()=>{if(tainted)throw new DOMException('tainted','SecurityError');return {data:new Uint8ClampedArray(256).fill(1)};}}) as typeof canvas.getContext;
            canvas.toDataURL=vi.fn(()=>'data:image/png;base64,AQ==');
            canvas.toBlob=encodeBlob;
        }
        return value;
    }) as typeof document.createElement);
    vi.stubGlobal('document',document);vi.stubGlobal('window',{location:{origin:'https://palcy.jp'},innerWidth:1280,innerHeight:900});
    vi.stubGlobal('Image',FakeImage);vi.stubGlobal('DOMRect',Rect);vi.stubGlobal('getComputedStyle',(target:Element)=>{
        const inline=(target as HTMLElement).style.getPropertyValue('background-image')||'';
        return {...style,backgroundImage:!denyPresentation&&inline.includes('fluent-read-translated-')?inline:style.backgroundImage};
    });
    document.elementFromPoint=()=>element;
    const ports={enabled:vi.fn(()=>true),configurationIdentity:vi.fn(()=>'config'),cacheEnabled:vi.fn(()=>true),readingSnapshots:createMangaReadingSnapshots(),ready:vi.fn(),acceptsInteractionLayer,
        translate:vi.fn().mockResolvedValue({mangaPatches:{width:713,height:1024,patches:[{x:0,y:0,width:1,height:1,image:'data:image/png;base64,AQ=='}]},lines:[{text:'译文',bbox:{x0:0,y0:0,x1:1,y1:1},backgroundColor:'#fff'}]})};
    vi.mocked(composeMangaPage).mockImplementation(async()=>{const output=document.createElement('canvas') as HTMLCanvasElement;output.width=713;output.height=1024;outputs.push(output);return output;});
    const originalCreate=canvasModule.createMangaCanvas;
    type BackgroundPorts=Parameters<typeof canvasModule.createMangaCanvas<HTMLElement>>[0];
    let bindings!:BackgroundPorts;
    vi.spyOn(canvasModule,'createMangaCanvas').mockImplementationOnce(received=>{
        bindings=received as BackgroundPorts;return originalCreate(received);
    });
    const runtime=createMangaBackground(ports);
    const ready=async()=>{expect(runtime.identity(element)).toBeNull();images.at(-1)!.onload!();await flush();expect(runtime.identity(element)).not.toBeNull();};
    const translate=async()=>{const task=runtime.translate(element);images.at(-1)!.onload!();await task;};
    return {document,element,rect,style,images,canvases,outputs,ports,runtime,ready,translate,encodeBlob,createUrl,revokeUrl,bindings:()=>bindings,
        taint:()=>{tainted=true;},missing:()=>{missing=true;},denyPresentation:()=>{denyPresentation=true;},pauseDecode:()=>{autoDecode=false;}};
}
function presentation(f:ReturnType<typeof fixture>,signal=new AbortController().signal) {
    const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.width=713;canvas.height=1024;
    return f.bindings().source!.presentation!(f.element,canvas,signal);
}
afterEach(()=>{vi.restoreAllMocks();vi.resetAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('公开背景漫画正文接入既有连续翻译',()=>{
    it('只读背景身份与边界在未准备、换源、断连和卸载后均保守拒绝且不发起探测',async()=>{
        const f=fixture(),source=f.bindings().source!;
        expect(source.readingBounds!(f.element)).toBeNull();expect(source.readingIdentity!(f.element)).toBeNull();expect(f.images).toHaveLength(0);
        await f.ready();expect(source.readingBounds!(f.element)).not.toBeNull();const count=f.images.length;
        f.style.backgroundImage='url("blob:https://palcy.jp/other")';expect(source.readingBounds!(f.element)).toBeNull();expect(source.readingIdentity!(f.element)).toBeNull();
        f.element.remove();expect(source.readingIdentity!(f.element)).toBeNull();f.runtime.dispose();expect(source.readingIdentity!(f.element)).toBeNull();
        expect(f.images).toHaveLength(count);
    });
    it('按需阅读未准备或来源变更时只读拒绝，不触发 Image 探测或归还宿主样式',async()=>{
        const f=fixture();expect(await f.runtime.readLines(f.element,new AbortController().signal)).toEqual({status:'unavailable'});expect(f.images).toHaveLength(0);
        await f.ready();await f.translate();const count=f.images.length;
        expect((await f.runtime.readLines(f.element,new AbortController().signal)).status).toBe('ready');
        f.element.style.setProperty('background-image','url(blob:https://palcy.jp/new-page)','important');f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';
        const prior=f.element.getAttribute('style');
        expect(await f.runtime.readLines(f.element,new AbortController().signal)).toEqual({status:'stale'});
        expect(f.images).toHaveLength(count);expect(f.element.getAttribute('style')).toBe(prior);expect(f.revokeUrl).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it('串行探测附近页，译图留在原背景绘制层，归还原属性并释放对象地址',async()=>{
        const f=fixture(),original=f.element.outerHTML;
        const other=f.element.cloneNode() as HTMLElement;other.id='page-2';other.getBoundingClientRect=()=>f.rect as DOMRect;f.document.body.append(other);
        expect(f.runtime.identity(f.element)).toBeNull();expect(f.runtime.identity(other)).toBeNull();expect(f.images).toHaveLength(1);
        f.images[0].onload!();await flush();expect(f.images[0].src).toBe('');expect(f.ports.ready).toHaveBeenCalledOnce();
        expect(f.runtime.identity(f.element)).not.toBeNull();expect(f.runtime.identity(other)).toBeNull();expect(f.images).toHaveLength(2);
        f.runtime.prepare([f.element]);expect(f.images[1].src).toBe('');await flush();expect(f.ports.ready).toHaveBeenCalledOnce();
        await f.translate();expect(f.ports.translate).toHaveBeenCalledOnce();expect(f.runtime.pixels(f.element)).toBe(713*1024);
        const output=f.outputs[0];expect(output.isConnected).toBe(false);expect(output.width).toBe(0);
        expect(f.element.style.backgroundImage).toContain('fluent-read-translated-1');expect(f.element.style.getPropertyPriority('background-image')).toBe('important');
        expect(f.document.getElementById('fluent-read-manga-background-container')).toBeNull();
        f.runtime.restore(f.element);expect(f.element.outerHTML).toBe(original);expect(f.runtime.reuse(f.element)).toBe(true);expect(f.ports.translate).toHaveBeenCalledOnce();
        f.runtime.release(f.element);await f.translate();expect(f.ports.translate).toHaveBeenCalledOnce();
        f.runtime.dispose();expect(f.canvases.every(c=>c.width===0&&c.height===0)).toBe(true);expect(f.runtime.identity(f.element)).toBeNull();
        expect(f.createUrl).toHaveBeenCalledTimes(2);expect(f.revokeUrl).toHaveBeenCalledTimes(2);
    });
    it('contain 在左右和上下留白时按真实绘制范围定位，调整窗口不重复识别',async()=>{
        const f=fixture();await f.ready();const identity=f.runtime.identity(f.element),bounds=f.runtime.bounds(f.element);
        expect(bounds.width).toBeCloseTo(713*900/1024);expect(bounds.left).toBeCloseTo(640-bounds.width);expect(bounds.top).toBe(0);
        await f.translate();expect(f.element.style.backgroundImage).toContain('fluent-read-translated-1');
        f.style.backgroundPosition='0px 50%';f.rect.width=f.rect.right=400;
        f.runtime.update();expect(f.runtime.identity(f.element)).toBe(identity);expect(f.runtime.bounds(f.element).left).toBe(0);
        expect(f.runtime.bounds(f.element).top).toBeCloseTo((900-1024*400/713)/2);expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it.each([
        ['backgroundImage','none'],['backgroundImage','url(https://palcy.jp/chapter.png)'],['backgroundImage','url(blob:https://other.test/page)'],
        ['backgroundImage','url(blob:https://palcy.jp/page),url(blob:https://palcy.jp/other)'],['backgroundSize','cover'],['backgroundRepeat','repeat'],
        ['backgroundOrigin','content-box'],['paddingLeft','4px'],['borderTopWidth','1px'],['backgroundPosition','50%'],['backgroundPosition','120% 50%'],['backgroundPosition','4px 50%'],
    ])('无法精确定位或非同源 blob 的来源不宣告可处理 %s=%s',(key,value)=>{
        const f=fixture();Object.assign(f.style,{[key]:value});expect(f.runtime.identity(f.element)).toBeNull();expect(f.images).toHaveLength(0);f.runtime.dispose();
    });
    it.each(['small','huge','wide','tall','taint','context','load','timeout'])('探测失败保留原文，不循环请求和保留解码位图 %s',async mode=>{
        vi.useFakeTimers();const f=fixture();f.runtime.identity(f.element);const image=f.images[0];
        if(mode==='small')image.naturalWidth=1;if(mode==='huge'){image.naturalWidth=5000;image.naturalHeight=5000;}
        if(mode==='wide')image.naturalWidth=9000;if(mode==='tall')image.naturalHeight=9000;
        if(mode==='taint')f.taint();if(mode==='context')f.missing();
        if(mode==='load')image.onerror!();else if(mode==='timeout')await vi.advanceTimersByTimeAsync(15000);else image.onload!();
        await flush();expect(image.src).toBe('');expect(f.runtime.identity(f.element)).toBeNull();expect(f.images).toHaveLength(1);expect(f.ports.ready).toHaveBeenCalledOnce();
        await f.runtime.translate(f.element);expect(f.ports.translate).not.toHaveBeenCalled();f.runtime.dispose();expect(vi.getTimerCount()).toBe(0);
    });
    it('离屏或不足正文尺寸时不探测，断开节点也不能进入翻译',()=>{
        const f=fixture();f.rect.left=3000;expect(f.runtime.identity(f.element)).toBeNull();f.rect.left=0;f.rect.right=-1280;expect(f.runtime.identity(f.element)).toBeNull();
        f.rect.right=640;f.rect.top=2000;expect(f.runtime.identity(f.element)).toBeNull();f.rect.top=0;f.rect.bottom=-900;expect(f.runtime.identity(f.element)).toBeNull();
        f.rect.bottom=900;f.rect.width=1;expect(f.runtime.identity(f.element)).toBeNull();f.rect.width=640;f.rect.height=1;expect(f.runtime.identity(f.element)).toBeNull();
        f.element.remove();expect(f.runtime.identity(f.element)).toBeNull();expect(f.images).toHaveLength(0);f.runtime.dispose();
    });
    it.each(['source','style','remove','reset','dispose'])('在途探测被更换或移除时取消，旧回调不复活 %s',async mode=>{
        const f=fixture();f.runtime.identity(f.element);const load=f.images[0].onload!;
        if(mode==='source'){f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';f.runtime.identity(f.element);}
        if(mode==='style'){f.style.backgroundSize='cover';f.runtime.identity(f.element);}
        if(mode==='remove')f.runtime.prepare([]);if(mode==='reset')f.runtime.resetCache();if(mode==='dispose')f.runtime.dispose();
        expect(f.images[0].src).toBe('');load();await flush();expect(f.ports.ready).not.toHaveBeenCalled();
        if(mode==='source') {
            const other=f.element.cloneNode() as HTMLElement;other.getBoundingClientRect=()=>f.rect as DOMRect;f.document.body.append(other);
            f.runtime.identity(other);expect(f.images).toHaveLength(2); // 旧探测收尾不得清掉同节点的新探测所有权。
            f.images[1].onload!();await flush();expect(f.runtime.identity(f.element)).toContain('new-page');
        }
        f.runtime.dispose();
    });
    it.each(['load','timeout','context','changed','pause','source','reset','dispose'])('完整快照失败或失去任务所有权时不发送旧 OCR %s',async mode=>{
        vi.useFakeTimers();const f=fixture();await f.ready();const task=f.runtime.translate(f.element),image=f.images.at(-1)!;
        const checked=['load','timeout','context','changed'].includes(mode)?expect(task).rejects.toThrow():task;
        if(mode==='load')image.onerror!();
        else if(mode==='timeout')await vi.advanceTimersByTimeAsync(15000);
        else if(mode==='context'){f.missing();image.onload!();}
        else if(mode==='changed'){image.naturalWidth=999;image.onload!();}
        else {
            if(mode==='pause')f.runtime.restore(f.element);
            if(mode==='source'){f.style.backgroundImage='url(blob:https://palcy.jp/replaced)';f.runtime.update();}
            if(mode==='reset')f.runtime.resetCache();if(mode==='dispose')f.runtime.dispose();
            image.onload?.();
        }
        await checked;
        expect(image.src).toBe('');expect(f.ports.translate).not.toHaveBeenCalled();expect(f.element.style.backgroundImage).toContain('page-1');
        f.runtime.dispose();expect(vi.getTimerCount()).toBe(0);
    });
});

describe('背景译图单属性所有权与有界编码',()=>{
    it('可见时才借用原背景层，逻辑来源不变且重复显示不编码、不改子内容和底色',async()=>{
        const f=fixture();f.element.style.backgroundColor='rgb(20, 30, 40)';
        const button=f.document.createElement('button');button.textContent='原站操作';f.element.append(button);
        const clicked=vi.fn();button.addEventListener('click',clicked);
        const original=f.element.outerHTML;await f.ready();const id=f.runtime.identity(f.element),images=f.images.length;
        const handle=await presentation(f);expect(f.element.outerHTML).toBe(original);expect(f.encodeBlob).toHaveBeenCalledOnce();expect(f.images).toHaveLength(images+1);
        expect(f.encodeBlob).toHaveBeenCalledWith(expect.any(Function),'image/png');
        expect(handle.show()).toBe(true);const owned=f.element.getAttribute('style');expect(handle.show()).toBe(true);
        expect(f.element.getAttribute('style')).toBe(owned);expect(f.runtime.identity(f.element)).toBe(id);expect(f.images).toHaveLength(images+1);
        expect(f.element.style.backgroundColor).toBe('rgb(20, 30, 40)');expect(button.textContent).toBe('原站操作');button.click();expect(clicked).toHaveBeenCalledOnce();
        expect(f.bindings().acceptsInteractionLayer!(f.element,button)).toBe(true);
        expect(f.bindings().acceptsInteractionLayer!(f.element,f.document.body)).toBe(false);
        handle.hide();handle.hide();expect(f.element.outerHTML).toBe(original);expect(handle.show()).toBe(true);
        handle.dispose();handle.dispose();expect(f.element.outerHTML).toBe(original);expect(handle.show()).toBe(false);
        expect(f.revokeUrl).toHaveBeenCalledOnce();expect(f.revokeUrl).toHaveBeenCalledWith('blob:https://palcy.jp/fluent-read-translated-1');
        expect(f.encodeBlob).toHaveBeenCalledOnce();expect(f.canvases).toHaveLength(2);f.runtime.dispose();
    });
    it('自定义交互层原端口仍可接受宿主之外的翻页层',()=>{
        const accepted=vi.fn(()=>true),f=fixture(accepted);
        expect(f.bindings().acceptsInteractionLayer!(f.element,f.document.body)).toBe(true);expect(accepted).toHaveBeenCalledWith(f.element,f.document.body);f.runtime.dispose();
    });
    it.each([null,'','background: #234 url(blob:https://palcy.jp/page-1) no-repeat; color: red;',
        'background-image: url(blob:https://palcy.jp/page-1) !important; background-color: rgba(1,2,3,.5);'])('未被宿主改写时准确归还原始style=%s',async raw=>{
        const f=fixture();if(raw===null)f.element.removeAttribute('style');else f.element.setAttribute('style',raw);
        await f.ready();const handle=await presentation(f);expect(handle.show()).toBe(true);handle.hide();
        expect(f.element.getAttribute('style')).toBe(raw);handle.dispose();f.runtime.dispose();
    });
    it.each(['inline','stylesheet'] as const)('宿主写其他longhand后只归还仍拥有的图片，不覆盖新颜色或旧优先级 %s',async source=>{
        const f=fixture();if(source==='stylesheet')f.element.removeAttribute('style');else f.element.style.setProperty('background-image','url(blob:https://palcy.jp/page-1)','important');
        await f.ready();const handle=await presentation(f);expect(handle.show()).toBe(true);
        f.element.style.setProperty('color','purple','important');handle.hide();
        expect(f.element.style.getPropertyValue('color')).toBe('purple');expect(f.element.style.getPropertyPriority('color')).toBe('important');
        expect(f.element.style.getPropertyValue('background-image')).toBe(source==='inline'?'url(blob:https://palcy.jp/page-1)':'');
        expect(f.element.style.getPropertyPriority('background-image')).toBe(source==='inline'?'important':'');handle.dispose();f.runtime.dispose();
    });
    it.each(['class','layout'] as const)('宿主%s接管先归还，原来源身份不变，显式复用可重新借用',async change=>{
        const f=fixture();await f.ready();const id=f.runtime.identity(f.element),handle=await presentation(f);expect(handle.show()).toBe(true);
        if(change==='class')f.element.className='new-reader-state';else f.element.style.setProperty('background-position','0% 50%');
        expect(f.runtime.identity(f.element)).toBe(id);expect(f.element.style.backgroundImage).not.toContain('fluent-read-translated-');
        expect(handle.show()).toBe(false);expect(handle.show()).toBe(true);handle.dispose();
        if(change==='class')expect(f.element.className).toBe('new-reader-state');else expect(f.element.style.getPropertyValue('background-position')).toBe('0% 50%');f.runtime.dispose();
    });
    it('宿主改URL后保留新值、撤销旧地址并走新来源探测，旧句柄不能复活',async()=>{
        const f=fixture();await f.ready();const handle=await presentation(f);expect(handle.show()).toBe(true);
        f.element.style.setProperty('background-image','url(blob:https://palcy.jp/new-page)','important');f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';
        expect(f.runtime.identity(f.element)).toBeNull();expect(f.images).toHaveLength(3);expect(handle.show()).toBe(false);
        expect(f.element.style.getPropertyValue('background-image')).toBe('url(blob:https://palcy.jp/new-page)');expect(f.element.style.getPropertyPriority('background-image')).toBe('important');
        expect(f.revokeUrl).toHaveBeenCalledOnce();handle.dispose();f.runtime.dispose();expect(f.revokeUrl).toHaveBeenCalledOnce();
    });
    it.each(['inline','stylesheet'] as const)('宿主仅改derived URL优先级时归还原图、保留新优先级和其他style %s',async source=>{
        const f=fixture();if(source==='stylesheet')f.element.removeAttribute('style');else f.element.style.setProperty('background-image','url(blob:https://palcy.jp/page-1)','important');
        await f.ready();const identity=f.runtime.identity(f.element),handle=await presentation(f);expect(handle.show()).toBe(true);
        const hostValue=f.element.style.getPropertyValue('background-image');f.element.style.setProperty('background-image',hostValue);f.element.style.setProperty('color','purple','important');
        expect(f.runtime.identity(f.element)).toBe(identity);expect(f.element.style.getPropertyValue('background-image')).toContain('blob:https://palcy.jp/page-1');
        expect(f.element.style.getPropertyValue('background-image')).not.toContain('fluent-read-translated-');expect(f.element.style.getPropertyPriority('background-image')).toBe('');
        expect(f.element.style.getPropertyValue('color')).toBe('purple');expect(f.element.style.getPropertyPriority('color')).toBe('important');
        expect(f.images).toHaveLength(2);handle.dispose();expect(f.revokeUrl).toHaveBeenCalledOnce();expect(f.runtime.identity(f.element)).toBe(identity);f.runtime.dispose();
    });
    it('优先级接管后直接release也不留下已撤销地址，返回页复用原source的压缩缓存',async()=>{
        const f=fixture();await f.ready();await f.translate();const identity=f.runtime.identity(f.element);
        f.element.style.setProperty('background-image',f.element.style.getPropertyValue('background-image'));
        f.runtime.release(f.element);expect(f.revokeUrl).toHaveBeenCalledOnce();
        expect(f.element.style.getPropertyValue('background-image')).toContain('blob:https://palcy.jp/page-1');expect(f.element.style.getPropertyPriority('background-image')).toBe('');
        expect(f.runtime.identity(f.element)).toBe(identity);await f.translate();expect(f.ports.translate).toHaveBeenCalledOnce();
        expect(f.element.style.backgroundImage).toContain('fluent-read-translated-2');f.runtime.dispose();
    });
    it.each(['invalid','url','removed','disposed','replaced'] as const)('已经准备的输出在%s后不能借用过期来源',async change=>{
        const f=fixture();await f.ready();const handle=await presentation(f);
        if(change==='invalid')f.style.backgroundSize='cover';
        if(change==='url')f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';
        if(change==='removed')f.element.remove();if(change==='disposed')f.runtime.dispose();
        if(change==='replaced'){f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';f.runtime.identity(f.element);}
        expect(handle.show()).toBe(false);handle.dispose();f.runtime.dispose();
    });
    it('原生样式优先级使呈现未生效时归还，不宣告显示成功',async()=>{
        const f=fixture();await f.ready();const original=f.element.outerHTML,handle=await presentation(f);f.denyPresentation();
        expect(handle.show()).toBe(false);expect(f.element.outerHTML).toBe(original);handle.dispose();f.runtime.dispose();
    });
    it('同来源新的准备句柄取代旧句柄，旧资源只释放一次',async()=>{
        const f=fixture();await f.ready();const first=await presentation(f);expect(first.show()).toBe(true);const second=await presentation(f);
        expect(first.show()).toBe(false);expect(second.show()).toBe(true);first.dispose();second.dispose();expect(f.revokeUrl).toHaveBeenCalledTimes(2);f.runtime.dispose();
    });
    it.each(['not-ready','width','height'] as const)('编码前拒绝不属于当前来源的%s尺寸',async change=>{
        const f=fixture();if(change!=='not-ready')await f.ready();
        const canvas=f.document.createElement('canvas') as HTMLCanvasElement;canvas.width=change==='width'?714:713;canvas.height=change==='height'?1025:1024;
        await expect(f.bindings().source!.presentation!(f.element,canvas,new AbortController().signal)).rejects.toThrow('背景译图尺寸无效');
        expect(f.encodeBlob).not.toHaveBeenCalled();expect(f.createUrl).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it.each(['null','empty','oversize','throw'] as const)('编码%s不修改宿主、不创建URL',async failure=>{
        const f=fixture();await f.ready();const original=f.element.outerHTML;
        if(failure==='throw')f.encodeBlob.mockImplementationOnce(()=>{throw new Error('native encode failed');});
        else f.encodeBlob.mockImplementationOnce(callback=>{const blob=new Blob(failure==='empty'?[]:['PNG']);if(failure==='oversize')Object.defineProperty(blob,'size',{value:64*1024*1024+1});callback(failure==='null'?null:blob);});
        await expect(presentation(f)).rejects.toThrow(failure==='throw'?'native encode failed':'背景译图数据无效');
        expect(f.createUrl).not.toHaveBeenCalled();expect(f.element.outerHTML).toBe(original);f.runtime.dispose();
    });
    it('编码接受64MiB边界但不分配该大小测试数据，不再读回像素或新建Canvas',async()=>{
        const f=fixture();await f.ready();const original=f.document.createElement('canvas') as HTMLCanvasElement;original.width=713;original.height=1024;
        const canvasCount=f.canvases.length,context=vi.spyOn(original,'getContext');
        f.encodeBlob.mockImplementationOnce(callback=>{const blob=new Blob(['PNG']);Object.defineProperty(blob,'size',{value:64*1024*1024});callback(blob);});
        const handle=await f.bindings().source!.presentation!(f.element,original,new AbortController().signal);
        expect(context).not.toHaveBeenCalled();expect(f.canvases).toHaveLength(canvasCount);expect(f.createUrl).toHaveBeenCalledOnce();handle.dispose();f.runtime.dispose();
    });
    it('已取消的准备不编码；在途编码取消后迟到回调不创建或借用URL',async()=>{
        const f=fixture();await f.ready();const before=new AbortController();before.abort();await expect(presentation(f,before.signal)).rejects.toMatchObject({name:'AbortError'});expect(f.encodeBlob).not.toHaveBeenCalled();
        let callback!:BlobCallback;f.encodeBlob.mockImplementationOnce(value=>{callback=value;});
        const controller=new AbortController(),task=presentation(f,controller.signal);const rejected=expect(task).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;
        callback(new Blob(['late']));expect(f.createUrl).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it('30秒编码超时清理监听，迟到结果无URL和宿主写入',async()=>{
        vi.useFakeTimers();const f=fixture();await f.ready();const original=f.element.outerHTML;let callback!:BlobCallback;
        f.encodeBlob.mockImplementationOnce(value=>{callback=value;});const task=presentation(f),rejected=expect(task).rejects.toThrow('背景译图编码超时');
        await vi.advanceTimersByTimeAsync(30000);await rejected;callback(new Blob(['late']));expect(f.createUrl).not.toHaveBeenCalled();expect(f.element.outerHTML).toBe(original);f.runtime.dispose();expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['abort','url','invalid','page','removed','disposed'] as const)('编码成功与返回之间发生%s时不发布旧输出',async change=>{
        const f=fixture();await f.ready();const controller=new AbortController();
        f.encodeBlob.mockImplementationOnce(callback=>{
            callback(new Blob(['PNG']));
            if(change==='abort')controller.abort();if(change==='url')f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';
            if(change==='invalid')f.style.backgroundRepeat='repeat';
            if(change==='page'){f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';f.runtime.identity(f.element);}
            if(change==='removed')f.element.remove();if(change==='disposed')f.runtime.dispose();
        });
        await expect(presentation(f,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(f.createUrl).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it('编码器重复回调不能创建额外URL，销毁保持幂等',async()=>{
        const f=fixture();await f.ready();let callback!:BlobCallback;f.encodeBlob.mockImplementationOnce(value=>{callback=value;value(new Blob(['PNG']));});
        const handle=await presentation(f);callback(new Blob(['duplicate']));expect(f.createUrl).toHaveBeenCalledOnce();handle.dispose();f.runtime.dispose();expect(f.revokeUrl).toHaveBeenCalledOnce();
    });
    it('公开Image加载和尺寸校验成功之前不归还准备结果或替换背景，成功后释放解码Image',async()=>{
        const f=fixture();await f.ready();f.pauseDecode();const original=f.element.outerHTML;let ready=false;
        const task=presentation(f).then(handle=>{ready=true;return handle;});await flush();
        const decoded=f.images.at(-1)!;expect(decoded.src).toContain('fluent-read-translated-');expect(ready).toBe(false);expect(f.element.outerHTML).toBe(original);
        decoded.onload!();const handle=await task;expect(decoded.src).toBe('');expect(decoded.onload).toBeNull();expect(decoded.onerror).toBeNull();
        expect(f.element.outerHTML).toBe(original);expect(handle.show()).toBe(true);handle.dispose();expect(f.revokeUrl).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it.each(['load','width','height','timeout'] as const)('新译图加载%s失败保留原图并一次撤销地址，迟到成功不复活',async failure=>{
        vi.useFakeTimers();const f=fixture();await f.ready();f.pauseDecode();const original=f.element.outerHTML;
        const task=presentation(f),rejected=expect(task).rejects.toThrow(failure==='timeout'?'背景图片加载超时':failure==='load'?'背景图片无法读取':'背景译图尺寸无效');await flush();
        const decoded=f.images.at(-1)!,late=decoded.onload!;
        if(failure==='load')decoded.onerror!();else if(failure==='timeout')await vi.advanceTimersByTimeAsync(15000);else {if(failure==='width')decoded.naturalWidth++;else decoded.naturalHeight++;decoded.onload!();}
        await rejected;expect(decoded.src).toBe('');expect(decoded.onload).toBeNull();expect(decoded.onerror).toBeNull();
        late();expect(f.element.outerHTML).toBe(original);expect(f.revokeUrl).toHaveBeenCalledOnce();f.runtime.dispose();expect(vi.getTimerCount()).toBe(0);
    });
    it('新对象地址创建后立即取消时也撤销一次，尚未启动Image加载',async()=>{
        const f=fixture();await f.ready();const controller=new AbortController();
        f.createUrl.mockImplementationOnce(()=>{controller.abort();return 'blob:https://palcy.jp/fluent-read-translated-aborted';});
        await expect(presentation(f,controller.signal)).rejects.toMatchObject({name:'AbortError'});
        expect(f.images).toHaveLength(1);expect(f.revokeUrl).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('在途译图加载取消会清空Image，迟到onload不再借背景或重复撤销地址',async()=>{
        vi.useFakeTimers();const f=fixture();await f.ready();f.pauseDecode();const original=f.element.outerHTML,controller=new AbortController();
        const task=presentation(f,controller.signal),rejected=expect(task).rejects.toMatchObject({name:'AbortError'});await flush();
        const decoded=f.images.at(-1)!,late=decoded.onload!;controller.abort();await rejected;
        expect(decoded.src).toBe('');late();expect(f.element.outerHTML).toBe(original);expect(f.revokeUrl).toHaveBeenCalledOnce();f.runtime.dispose();expect(vi.getTimerCount()).toBe(0);
    });
    it.each(['abort','url','invalid','page','removed','disposed'] as const)('公开Image成功后发现%s也不发布，归还地址和宿主',async change=>{
        const f=fixture();await f.ready();f.pauseDecode();const original=f.element.outerHTML,controller=new AbortController();
        const task=presentation(f,controller.signal),rejected=expect(task).rejects.toMatchObject({name:'AbortError'});await flush();const decoded=f.images.at(-1)!;
        decoded.onload!();if(change==='abort')controller.abort();if(change==='url')f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';
        if(change==='invalid')f.style.backgroundRepeat='repeat';
        if(change==='page'){f.style.backgroundImage='url(blob:https://palcy.jp/new-page)';f.runtime.identity(f.element);}
        if(change==='removed')f.element.remove();if(change==='disposed')f.runtime.dispose();
        await rejected;expect(decoded.src).toBe('');expect(f.element.outerHTML).toBe(original);expect(f.revokeUrl).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('对象地址创建本身失败时保留原错误，不借用样式也不撤销未创建资源',async()=>{
        const f=fixture();await f.ready();const failure=new Error('object URL denied'),original=f.element.outerHTML;
        f.createUrl.mockImplementationOnce(()=>{throw failure;});await expect(presentation(f)).rejects.toBe(failure);
        expect(f.revokeUrl).not.toHaveBeenCalled();expect(f.element.outerHTML).toBe(original);f.runtime.dispose();
    });
    it('无字和翻译失败不编码译图或借用原背景',async()=>{
        const f=fixture();await f.ready();const original=f.element.outerHTML;
        f.ports.translate.mockResolvedValueOnce({mangaPatches:{width:713,height:1024,patches:[]},lines:[]});await f.translate();
        expect(f.encodeBlob).not.toHaveBeenCalled();expect(f.createUrl).not.toHaveBeenCalled();expect(f.element.outerHTML).toBe(original);
        f.runtime.release(f.element);f.ports.cacheEnabled.mockReturnValue(false);f.ports.translate.mockRejectedValueOnce(new Error('translation failed'));
        await expect(f.translate()).rejects.toThrow('translation failed');expect(f.encodeBlob).not.toHaveBeenCalled();expect(f.element.outerHTML).toBe(original);f.runtime.dispose();
    });
    it.each(['hidden','offscreen','disabled','occluded'] as const)('实际可见性%s会归还背景，复显复用原输出且不再编码',async reason=>{
        const f=fixture();await f.ready();const original=f.element.outerHTML;await f.translate();expect(f.element.style.backgroundImage).toContain('fluent-read-translated-');
        if(reason==='hidden')Object.defineProperty(f.document,'hidden',{configurable:true,value:true});
        if(reason==='offscreen'){f.rect.left=2000;f.rect.right=2640;}
        if(reason==='disabled')f.ports.enabled.mockReturnValue(false);if(reason==='occluded')f.document.elementFromPoint=()=>f.document.createElement('div');
        f.runtime.update();expect(f.element.outerHTML).toBe(original);
        if(reason==='hidden')Object.defineProperty(f.document,'hidden',{configurable:true,value:false});
        if(reason==='offscreen'){f.rect.left=0;f.rect.right=640;}if(reason==='disabled')f.ports.enabled.mockReturnValue(true);if(reason==='occluded')f.document.elementFromPoint=()=>f.element;
        f.runtime.update();expect(f.element.style.backgroundImage).toContain('fluent-read-translated-');expect(f.encodeBlob).toHaveBeenCalledOnce();f.runtime.dispose();expect(f.element.outerHTML).toBe(original);
    });
});

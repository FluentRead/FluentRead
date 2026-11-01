import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createMangaCanvas} from '@/src/features/image-translation/content/mangaCanvas';
import {composeMangaPage} from '@/src/features/image-translation/content/mangaCompositor';
import {encodeImageCanvas} from '@/src/features/image-translation/services/imageEncoding';
import {createMangaReader} from '@/src/features/image-translation/content/mangaReader';
import {createMangaReadingSnapshots} from '@/src/features/image-translation/content/mangaReadingSnapshots';
vi.mock('@/src/features/image-translation/content/mangaCompositor', () => ({composeMangaPage: vi.fn()}));
vi.mock('@/src/features/image-translation/services/imageEncoding', () => {
    const encodeImageCanvas=vi.fn();return {encodeImageCanvas,encodeReadingImageCanvas:(canvas:HTMLCanvasElement,signal:AbortSignal)=>encodeImageCanvas(canvas,signal),readingImageEncodingBusy:()=>false};
});
const compose = vi.mocked(composeMangaPage);
const encode = vi.mocked(encodeImageCanvas);
const packet = {width: 400, height: 300, patches: [{x: 0, y: 0, width: 1, height: 1, image: 'data:image/png;base64,AQ=='}]};
const result = {mangaPatches: packet, lines: [{text: '译文', bbox: {x0: 0, y0: 0, x1: 1, y1: 1}, backgroundColor: '#fff'}]};
const deferred = <T,>() => {let resolve!: (value: T) => void, reject!: (error: Error) => void;const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};};
const flush = async () => {for (let n = 0; n < 30; n++) await Promise.resolve();};
const restoreAnimationPorts: Array<() => void> = [];

function fixture(recovery?: Parameters<typeof createMangaCanvas>[0]['recovery'], readingSnapshots = createMangaReadingSnapshots(),lightCacheLimits?:{pages:number;bytes:number}) {
    encode.mockResolvedValue('data:image/png;base64,AQ==');
    const {document, window} = parseHTML('<html><body><div id="reader"></div></body></html>');
    const prototype = window.Element.prototype, animationPort = Object.getOwnPropertyDescriptor(prototype, 'getAnimations');
    Object.defineProperty(prototype, 'getAnimations', {configurable: true, value: () => []});
    restoreAnimationPorts.push(() => {if (animationPort) Object.defineProperty(prototype, 'getAnimations', animationPort);else Reflect.deleteProperty(prototype, 'getAnimations');});
    const create = document.createElement.bind(document);
    const snapshots: HTMLCanvasElement[] = [], outputs: HTMLCanvasElement[] = [], roots: ShadowRoot[] = [];
    // linkedom 缺少浏览器 CSSStyleDeclaration priority，保留其序列化并补齐原生单属性契约。
    const decorateStyle = (element: HTMLElement) => {
        const actual = element.style, priorities = new Map<string, string>();
        Object.defineProperty(element, 'style', {value: new Proxy(actual, {
            get(target, property) {
                if (property === 'getPropertyPriority') return (name: string) => priorities.get(name) || '';
                if (property === 'getPropertyValue') return (name: string) => actual.getPropertyValue(name) || '';
                if (property === 'setProperty') return (name: string, value: string, priority = '') => {priorities.set(name, priority);actual.setProperty(name, value);};
                if (property === 'removeProperty') return (name: string) => {priorities.delete(name);return actual.removeProperty(name);};
                const value = Reflect.get(target, property);return typeof value === 'function' ? value.bind(target) : value;
            },
            set(target, property, value) {if (property === 'cssText') priorities.clear();else priorities.delete(String(property));return Reflect.set(target, property, value);},
        })});
    };
    let missingCaptureContext = false;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        const element = create(tag);
        if (tag === 'div') {const attach = element.attachShadow.bind(element);element.attachShadow = options => {const root = attach(options);roots.push(root);return root;};}
        if (tag === 'canvas') {
            const canvas = element as HTMLCanvasElement;
            decorateStyle(canvas);
            let drawn: HTMLCanvasElement | null = null;
            canvas.getContext = vi.fn(() => missingCaptureContext && canvas.width > 8 ? null : {
                drawImage: (source: HTMLCanvasElement) => {drawn = source;canvas.dataset.content = source.dataset.content || 'A';},
                getImageData: () => {
                    if (drawn?.dataset.tainted === 'true') throw new DOMException('tainted', 'SecurityError');
                    return {data: new Uint8ClampedArray(256).fill(Number(drawn?.dataset.pixel ?? 1))};
                },
            }) as typeof canvas.getContext;
            canvas.toDataURL = vi.fn(() => 'data:image/png;base64,AQ==');
            snapshots.push(canvas);
        }
        return element;
    }) as typeof document.createElement);
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    canvas.width = 400;canvas.height = 300;canvas.dataset.pixel = '1';
    canvas.style.setProperty('--reader-page', 'source');document.getElementById('reader')!.append(canvas);
    const bounds = {left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300};
    canvas.getBoundingClientRect = () => bounds as DOMRect;
    const styles = new Map<Element, Record<string, string>>();
    const hit = vi.fn(() => canvas as Element | null);
    document.elementFromPoint = hit;
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {innerWidth: 1280, innerHeight: 900});
    // 同时覆盖不具备 WebCrypto 的 HTTP 内容环境；原生 digest 由专门用例验证。
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('getComputedStyle', (element: Element) => ({display: 'block', visibility: 'visible', opacity: (element as HTMLElement).style.opacity || '1', overflowX: 'visible', overflowY: 'visible', ...styles.get(element)}));
    compose.mockImplementation(async () => {const output = document.createElement('canvas') as HTMLCanvasElement;output.width = 400;output.height = 300;outputs.push(output);return output;});
    const ports = {enabled: vi.fn(() => true), configurationIdentity: vi.fn(() => 'config-1'), cacheEnabled: vi.fn(() => true), recovery, acceptsInteractionLayer:vi.fn((_canvas:HTMLCanvasElement,_hit:Element)=>false), translate: vi.fn().mockResolvedValue(result)};
    const runtime = createMangaCanvas({...ports, readingSnapshots,lightCacheLimits});
    return {document, window, canvas, bounds, styles, hit, snapshots, outputs, roots, ports, runtime, readingSnapshots,
        missingContext: () => {missingCaptureContext = true;}};
}

describe('漫画画布按需阅读快照',()=>{
    it('未注入阅读存储的旧调用方仍可翻译，轻缓存淘汰不会引入失败',async()=>{
        const f=fixture(),runtime=createMangaCanvas({...f.ports,lightCacheLimits:{pages:1,bytes:1024*1024}});
        const second=f.document.createElement('canvas') as HTMLCanvasElement;second.width=400;second.height=300;second.dataset.pixel='1';
        second.getBoundingClientRect=f.canvas.getBoundingClientRect;f.document.getElementById('reader')!.append(second);
        await runtime.translate(f.canvas);await expect(runtime.translate(second)).resolves.toBeUndefined();
        expect((await runtime.readLines(f.canvas,new AbortController().signal)).status).toBe('unavailable');runtime.dispose();f.runtime.dispose();
    });
    it('自定义载体没有可验证边界时不公开阅读目标',async()=>{
        const f=fixture(),source={identity:()=> 'surface',readingIdentity:vi.fn(()=> 'surface'),readingBounds:()=>null,
            bounds:()=>f.bounds as DOMRect,capture:async(_canvas:HTMLCanvasElement,target:HTMLCanvasElement)=>{target.width=400;target.height=300;}};
        const runtime=createMangaCanvas({...f.ports,source});expect(runtime.readingIdentity(f.canvas)).toBeNull();
        await runtime.translate(f.canvas);expect(runtime.readingIdentity(f.canvas)).not.toBeNull();expect(runtime.readingVisible(f.canvas)).toBe(false);
        source.readingIdentity.mockImplementation(()=>{throw Error('source unavailable');});
        expect((await runtime.readLines(f.canvas,new AbortController().signal)).status).toBe('stale');
        runtime.dispose();f.runtime.dispose();
    });
    it('自身译层命中时继续检查下层，缺少下层目标则拒绝',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);
        const host=f.document.getElementById('fluent-read-manga-canvas-container')!;f.hit.mockReturnValue(host);
        Object.assign(f.document,{elementsFromPoint:()=>[host,f.canvas]});expect(f.runtime.readingVisible(f.canvas)).toBe(true);
        Object.assign(f.document,{elementsFromPoint:()=>[host]});expect(f.runtime.readingVisible(f.canvas)).toBe(false);f.runtime.dispose();
    });
    it('浏览器无法检查译层之下的命中目标时保守拒绝',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);const host=f.document.getElementById('fluent-read-manga-canvas-container')!;
        f.hit.mockReturnValue(host);Reflect.deleteProperty(f.document,'elementsFromPoint');expect(f.runtime.readingVisible(f.canvas)).toBe(false);f.runtime.dispose();
    });
    it('可信阅读宿主的子节点不会被误判为网页遮挡',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);const host=f.document.createElement('div'),child=f.document.createElement('button');
        host.append(child);f.document.body.append(host);f.hit.mockReturnValue(child);
        Object.assign(f.document,{elementsFromPoint:()=>[child,host,f.canvas]});expect(f.runtime.readingVisible(f.canvas,undefined,host)).toBe(true);f.runtime.dispose();
    });
    it('译图提交阶段出错时清理已分配的临时文字，不泄漏活动预算',async()=>{
        const f=fixture();f.ports.cacheEnabled.mockReturnValue(false);const original=globalThis.getComputedStyle;let failed=false;
        vi.stubGlobal('getComputedStyle',(element:Element)=>{if(!failed){failed=true;throw Error('render failure');}return original(element);});
        await expect(f.runtime.translate(f.canvas)).rejects.toThrow('render failure');expect(f.readingSnapshots.stats().entries).toBe(0);
        vi.stubGlobal('getComputedStyle',original);f.runtime.dispose();
    });
    it('提交出错且文字存储释放异常时仍归还译图状态',async()=>{
        const f=fixture();f.ports.cacheEnabled.mockReturnValue(false);const remove=vi.spyOn(f.readingSnapshots,'remove').mockImplementation(()=>{throw Error('remove failure');});
        const original=globalThis.getComputedStyle;let failed=false;
        vi.stubGlobal('getComputedStyle',(element:Element)=>{if(!failed){failed=true;throw Error('render failure');}return original(element);});
        await expect(f.runtime.translate(f.canvas)).rejects.toThrow('render failure');expect(remove).toHaveBeenCalledOnce();
        vi.stubGlobal('getComputedStyle',original);remove.mockRestore();f.runtime.dispose();
    });
    it('关闭、隐藏或来源身份异常时不得读取已完成结果',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);f.ports.enabled.mockReturnValue(false);
        expect(f.runtime.readingVisible(f.canvas)).toBe(false);expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe('stale');
        f.ports.enabled.mockReturnValue(true);Object.defineProperty(f.document,'hidden',{configurable:true,value:true});expect(f.runtime.readingVisible(f.canvas)).toBe(false);
        Object.defineProperty(f.document,'hidden',{configurable:true,value:false});f.ports.configurationIdentity.mockImplementationOnce(()=>{throw Error('config unavailable');});
        expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe('stale');f.runtime.dispose();
    });
    it.each(['invalid','overBudget'] as const)('已有缓存内的 %s 阅读数据安全拒绝，不截断',async mode=>{
        const f=fixture(),bad={...result.lines[0],bbox:{x0:2,y0:0,x1:1,y1:1}};
        f.ports.translate.mockResolvedValueOnce({...result,lines:mode==='invalid'?[bad]:Array.from({length:513},()=>result.lines[0])});
        await f.runtime.translate(f.canvas);expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe(mode==='invalid'?'error':'overBudget');f.runtime.dispose();
    });
    it('读取编码报错时若已经取消，状态保留取消而非伪报故障',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);const abort=new AbortController();
        encode.mockImplementationOnce(()=>{abort.abort();throw Error('late encoding failure');});
        expect(await f.runtime.readLines(f.canvas,abort.signal)).toEqual({status:'cancelled'});f.runtime.dispose();
    });
    it('清理时才发生取消，仍保留清理前判定的编码错误',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);const abort=new AbortController(),pending=deferred<string>();
        encode.mockReturnValueOnce(pending.promise);const reading=f.runtime.readLines(f.canvas,abort.signal);await flush();
        const snapshot=f.snapshots.at(-1)!;let width=snapshot.width;
        Object.defineProperty(snapshot,'width',{configurable:true,get:()=>width,set:(value:number)=>{width=value;if(value===0)abort.abort();}});
        pending.reject(Error('encoding failure'));expect(await reading).toEqual({status:'error'});expect(abort.signal.aborted).toBe(true);f.runtime.dispose();
    });
    it('等待编码期间取消后异步拒绝，仍只报告取消并清理快照',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);const abort=new AbortController(),pending=deferred<string>();
        encode.mockReturnValueOnce(pending.promise);const read=f.runtime.readLines(f.canvas,abort.signal);await flush();
        abort.abort();pending.reject(Error('encoding rejected after abort'));
        expect(await read).toEqual({status:'cancelled'});f.runtime.dispose();
    });
    it.each(['cancel','config'] as const)('完整摘要期间 %s 不会返回迟到的旧结果',async change=>{
        const f=fixture();await f.runtime.translate(f.canvas);const pending=deferred<ArrayBuffer>();
        vi.stubGlobal('crypto',{subtle:{digest:vi.fn(()=>pending.promise)}});
        const abort=new AbortController(),read=f.runtime.readLines(f.canvas,abort.signal);await flush();
        if(change==='cancel')abort.abort();else f.ports.configurationIdentity.mockReturnValue('new-config');
        pending.resolve(new Uint8Array(32).buffer);expect(await read).toEqual({status:change==='cancel'?'cancelled':'stale'});f.runtime.dispose();
    });
    it('已编码图片过大时停止摘要，明确报告超预算',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);const digest=vi.fn();vi.stubGlobal('crypto',{subtle:{digest}});
        encode.mockResolvedValueOnce('a'.repeat(32*1024*1024+1));
        expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'overBudget'});expect(digest).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it.each(['no-key','invalid'] as const)('轻缓存淘汰时快照 %s 明确失败但不会影响译图',async mode=>{
        const snapshots=createMangaReadingSnapshots();if(mode==='no-key')vi.spyOn(snapshots,'allocateKey').mockReturnValue(undefined);
        else vi.spyOn(snapshots,'put').mockReturnValue('invalid');
        const f=fixture(undefined,snapshots,{pages:1,bytes:1024*1024});const second=f.document.createElement('canvas') as HTMLCanvasElement;
        second.width=400;second.height=300;second.dataset.pixel='1';second.getBoundingClientRect=f.canvas.getBoundingClientRect;f.document.getElementById('reader')!.append(second);
        await f.runtime.translate(f.canvas);await expect(f.runtime.translate(second)).resolves.toBeUndefined();
        expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe(mode==='no-key'?'overBudget':'error');f.runtime.dispose();
    });
    it('观察版本仅表示当前已完成的载体，释放后无法复用',async()=>{
        const f=fixture();expect(f.runtime.readingVersion(f.canvas)).toBeUndefined();await f.runtime.translate(f.canvas);
        const version=f.runtime.readingVersion(f.canvas);expect(version).toBeDefined();f.runtime.release(f.canvas);
        expect(f.runtime.readingVersion(f.canvas)).toBeUndefined();await f.runtime.translate(f.canvas);
        expect(f.runtime.readingVersion(f.canvas)).not.toBe(version);f.runtime.dispose();
    });
    it('缓存无空间或快照端口抛错不影响译图，阅读结果分别报告可用与错误',async()=>{
        const f=fixture(undefined,createMangaReadingSnapshots(),{pages:0,bytes:1024*1024});await f.runtime.translate(f.canvas);
        expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe('ready');f.runtime.dispose();
        const broken=createMangaReadingSnapshots();vi.spyOn(broken,'put').mockImplementation(()=>{throw Error('snapshot error');});
        const g=fixture(undefined,broken,{pages:0,bytes:1024*1024});await expect(g.runtime.translate(g.canvas)).resolves.toBeUndefined();
        expect((await g.runtime.readLines(g.canvas,new AbortController().signal)).status).toBe('error');g.runtime.dispose();
    });
    it('读取预取消以及样式查询失败均安全退出',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);const abort=new AbortController();abort.abort();
        expect(await f.runtime.readLines(f.canvas,abort.signal)).toEqual({status:'cancelled'});
        const style=globalThis.getComputedStyle;vi.stubGlobal('getComputedStyle',()=>{throw Error('style unavailable');});
        expect(f.runtime.readingVisible(f.canvas)).toBe(false);vi.stubGlobal('getComputedStyle',style);f.runtime.dispose();
    });
    it('读取只保留祖先裁切后仍可见的区域；离屏或祖先隐藏均拒绝',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);const parent=f.document.getElementById('reader')!;
        const bounds={left:600,right:700,top:0,bottom:200,width:100,height:200};parent.getBoundingClientRect=()=>bounds as DOMRect;
        f.styles.set(parent,{overflowX:'hidden',overflowY:'hidden'});expect(f.runtime.readingVisible(f.canvas)).toBe(false);
        Object.assign(bounds,{left:150,right:450,top:100,bottom:250});expect(f.runtime.readingVisible(f.canvas)).toBe(true);
        Object.assign(bounds,{top:400,bottom:500});expect(f.runtime.readingVisible(f.canvas)).toBe(false);
        f.styles.set(parent,{display:'none'});expect(f.runtime.readingVisible(f.canvas)).toBe(false);f.runtime.dispose();
    });
    it('未完成和失败页面分别报告等待与错误，不启动额外请求',async()=>{
        const f=fixture(),pending=deferred<typeof result>();f.ports.translate.mockReturnValueOnce(pending.promise);
        const task=f.runtime.translate(f.canvas);await flush();expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'pending'});
        pending.reject(Error('recognition failed'));await expect(task).rejects.toThrow('recognition failed');
        expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'error'});expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('空结果和无效识别行被明确区分，异常快照读取不会影响显示',async()=>{
        const f=fixture();f.ports.cacheEnabled.mockReturnValue(false);f.ports.translate.mockResolvedValueOnce({...result,lines:[]});
        await f.runtime.translate(f.canvas);expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'empty'});f.runtime.release(f.canvas);
        f.ports.translate.mockResolvedValueOnce({...result,lines:[{...result.lines[0],bbox:{x0:9,y0:0,x1:1,y1:1}}]});
        await f.runtime.translate(f.canvas);expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'error'});f.runtime.dispose();
        const other=fixture();other.ports.cacheEnabled.mockReturnValue(false);await other.runtime.translate(other.canvas);
        vi.spyOn(other.readingSnapshots,'get').mockImplementation(()=>{throw Error('bad storage');});
        expect(await other.runtime.readLines(other.canvas,new AbortController().signal)).toEqual({status:'error'});other.runtime.dispose();
    });
    it('无可用快照身份时明确报告预算耗尽，不影响已完成译图',async()=>{
        const snapshots=createMangaReadingSnapshots();vi.spyOn(snapshots,'allocateKey').mockReturnValue(undefined);
        const f=fixture(undefined,snapshots);f.ports.cacheEnabled.mockReturnValue(false);await f.runtime.translate(f.canvas);
        expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'overBudget'});
        expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('两个相同像素画布分别持有身份，轻缓存淘汰活动页时有界转移并可释放',async()=>{
        const snapshots=createMangaReadingSnapshots(),f=fixture(undefined,snapshots,{pages:1,bytes:1024*1024});
        const second=f.document.createElement('canvas') as HTMLCanvasElement;second.width=400;second.height=300;
        second.dataset.pixel='1';second.getBoundingClientRect=f.canvas.getBoundingClientRect;f.document.getElementById('reader')!.append(second);
        await f.runtime.translate(f.canvas);expect(snapshots.stats().entries).toBe(0);
        await f.runtime.translate(second);expect(snapshots.stats().entries).toBe(1);
        expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe('ready');
        expect((await f.runtime.readLines(second,new AbortController().signal)).status).toBe('ready');expect(f.ports.translate).toHaveBeenCalledTimes(2);
        f.runtime.release(f.canvas);expect(snapshots.stats().entries).toBe(0);f.runtime.dispose();
    });
    it.each(['overBudget','throws'] as const)('活动文字转移 %s 不影响译图并明确报告',async failure=>{
        const snapshots=createMangaReadingSnapshots(failure==='overBudget'?{maxBytes:64}:{});
        if(failure==='throws')vi.spyOn(snapshots,'put').mockImplementation(()=>{throw Error('broken snapshot');});
        const f=fixture(undefined,snapshots,{pages:1,bytes:1024*1024});
        const second=f.document.createElement('canvas') as HTMLCanvasElement;second.width=400;second.height=300;
        second.dataset.pixel='2';second.getBoundingClientRect=f.canvas.getBoundingClientRect;f.document.getElementById('reader')!.append(second);
        await f.runtime.translate(f.canvas);await expect(f.runtime.translate(second)).resolves.toBeUndefined();
        expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe(failure==='throws'?'error':'overBudget');
        expect((await f.runtime.readLines(second,new AbortController().signal)).status).toBe('ready');expect(f.ports.translate).toHaveBeenCalledTimes(2);f.runtime.dispose();
    });
    it('已释放的页面在缓存淘汰时不产生文字副本',async()=>{
        const snapshots=createMangaReadingSnapshots(),f=fixture(undefined,snapshots,{pages:1,bytes:1024*1024});
        const second=f.document.createElement('canvas') as HTMLCanvasElement;second.width=400;second.height=300;
        second.dataset.pixel='1';second.getBoundingClientRect=f.canvas.getBoundingClientRect;f.document.getElementById('reader')!.append(second);
        await f.runtime.translate(f.canvas);f.runtime.release(f.canvas);await f.runtime.translate(second);
        expect(snapshots.stats().entries).toBe(0);expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'unavailable'});f.runtime.dispose();
    });
    it('画布遮挡检查只豁免实际持有的阅读层，网页伪造标记仍遮挡',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);
        const fake=f.document.createElement('div');fake.setAttribute('data-fluent-read-ui','');f.document.body.append(fake);
        f.hit.mockReturnValue(fake);Object.assign(f.document,{elementsFromPoint:()=>[fake,f.canvas]});
        expect(f.runtime.readingVisible(f.canvas)).toBe(false);
        expect(f.runtime.readingVisible(f.canvas,undefined,fake)).toBe(true);f.runtime.dispose();
    });
    it('自定义载体未提供明确纯查询身份时拒绝，不回退到可能触发副作用的 identity',async()=>{
        const f=fixture(),identity=vi.fn(()=>null);
        const source={identity,capture:vi.fn(),bounds:vi.fn(()=>f.bounds as DOMRect)};
        const runtime=createMangaCanvas({...f.ports,source,readingSnapshots:f.readingSnapshots});
        expect(await runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'unavailable'});
        expect(runtime.readingIdentity(f.canvas)).toBeNull();
        expect(identity).not.toHaveBeenCalled();runtime.dispose();f.runtime.dispose();
    });
    it('缓存关闭仍能读取活动页的有界文字，停止会话后释放；不重新翻译',async()=>{
        const f=fixture();f.ports.cacheEnabled.mockReturnValue(false);await f.runtime.translate(f.canvas);
        const read=await f.runtime.readLines(f.canvas,new AbortController().signal);
        expect(read).toEqual({status:'ready',lines:result.lines});expect(f.ports.translate).toHaveBeenCalledOnce();
        f.runtime.release(f.canvas);expect(f.readingSnapshots.stats().entries).toBe(0);
        expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'unavailable'});f.runtime.dispose();
    });
    it('缓存关闭时暂停立即释放临时文字，返页不悄悄重新识别',async()=>{
        const f=fixture();f.ports.cacheEnabled.mockReturnValue(false);await f.runtime.translate(f.canvas);
        expect(f.readingSnapshots.stats().entries).toBe(1);f.runtime.restore(f.canvas);
        expect(f.readingSnapshots.stats().entries).toBe(0);expect(f.runtime.reuse(f.canvas)).toBe(true);
        expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'unavailable'});
        expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('画布重新校验期间旧文字不可读，同摘要验证后可复用且不识别',async()=>{
        const f=fixture();f.ports.cacheEnabled.mockReturnValue(false);await f.runtime.translate(f.canvas);
        f.runtime.invalidate(f.canvas);expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).not.toBe('ready');
        await f.runtime.translate(f.canvas);expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe('ready');
        expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('原生画布完整摘要变化时拒绝旧文字，即便 8×8 指纹不变',async()=>{
        const f=fixture();encode.mockImplementation(async canvas=>`data:image/png;base64,${btoa(canvas.dataset.content || 'A')}`);
        await f.runtime.translate(f.canvas);f.canvas.dataset.content='B';
        expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'stale'});
        expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('完整摘要期间取消、来源变化或释放不能返回迟到文字',async()=>{
        for(const action of ['cancel','config','release'] as const){
            const f=fixture();await f.runtime.translate(f.canvas);const wait=deferred<string>();encode.mockReturnValueOnce(wait.promise);
            const controller=new AbortController(),read=f.runtime.readLines(f.canvas,controller.signal);await flush();
            if(action==='cancel')controller.abort();else if(action==='config')f.ports.configurationIdentity.mockReturnValue('config-2');else f.runtime.release(f.canvas);
            wait.resolve('data:image/png;base64,AQ==');expect((await read).status).not.toBe('ready');f.runtime.dispose();vi.clearAllMocks();
        }
    });
    it('新来源文字超预算不会从旧状态复活，旧活动项被释放',async()=>{
        const f=fixture();f.ports.cacheEnabled.mockReturnValue(false);
        encode.mockImplementation(async canvas=>`data:image/png;base64,${btoa(canvas.dataset.content || 'A')}`);
        await f.runtime.translate(f.canvas);expect((await f.runtime.readLines(f.canvas,new AbortController().signal)).status).toBe('ready');
        f.runtime.invalidate(f.canvas);f.canvas.dataset.content='B';
        f.ports.translate.mockResolvedValueOnce({...result,lines:Array.from({length:513},()=>result.lines[0])});
        await f.runtime.translate(f.canvas);
        expect(await f.runtime.readLines(f.canvas,new AbortController().signal)).toEqual({status:'overBudget'});
        expect(f.readingSnapshots.stats().entries).toBe(0);f.runtime.dispose();
    });
});

function readerFor(f: ReturnType<typeof fixture>) {
    const outer = f.document.createElement('div');outer.className = 'images-container';
    outer.innerHTML = '<div class="view-container"><div class="image-container"></div></div>';
    outer.querySelector('.image-container')!.append(f.canvas);f.document.body.append(outer);
    vi.stubGlobal('Element', f.window.Element);
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal('MutationObserver', class {observe() {} disconnect() {}});
    const callbacks = new Map<number, FrameRequestCallback>();let sequence = 0;
    vi.stubGlobal('window', {innerWidth: 1280, innerHeight: 900, location: {href: 'https://manga.bilibili.com/mc30124/595886'},
        requestAnimationFrame: (callback: FrameRequestCallback) => {callbacks.set(++sequence, callback);return sequence;},
        cancelAnimationFrame: (id: number) => callbacks.delete(id), addEventListener: vi.fn(), removeEventListener: vi.fn()});
    encode.mockImplementation(async canvas => `data:image/png;base64,${btoa(canvas.dataset.content || 'A')}`);
    const reader = createMangaReader({enabled: () => true, identity: () => 'unused-image', translate: vi.fn(), restore: vi.fn(), release: vi.fn(), failed: () => false, changed: vi.fn(), canvas: f.runtime});
    return reader;
}
afterEach(() => {while (restoreAnimationPorts.length) restoreAnimationPorts.pop()!();vi.restoreAllMocks();vi.resetAllMocks();vi.unstubAllGlobals();});

function presentationFixture() {
    const f=fixture();f.runtime.dispose();
    const handle={show:vi.fn(()=>true),hide:vi.fn(),dispose:vi.fn()};
    const presentation=vi.fn(async(_element:HTMLCanvasElement,_surface:HTMLCanvasElement,_signal:AbortSignal)=>handle);
    const source={identity:vi.fn(()=>'source-1'),bounds:()=>f.bounds as DOMRect,
        capture:vi.fn(async(_element:HTMLCanvasElement,target:HTMLCanvasElement)=>{target.width=400;target.height=300;}),presentation};
    const runtime=createMangaCanvas({...f.ports,source});
    return {...f,handle,presentation,source,runtime};
}

describe('宿主原绘制层的异步展示资源',()=>{
    it('准备成功才发布，释放合成画布，暂停保留资源且缓存复显不重编码或重识别',async()=>{
        const f=presentationFixture(),original=f.canvas.outerHTML;await f.runtime.translate(f.canvas);
        expect(f.presentation).toHaveBeenCalledOnce();expect(f.presentation.mock.calls[0]).toEqual([f.canvas,f.outputs[0],expect.any(AbortSignal)]);
        expect(f.outputs[0].width).toBe(0);expect(f.outputs[0].height).toBe(0);expect(f.outputs[0].isConnected).toBe(false);
        expect(f.roots).toHaveLength(0);expect(f.handle.show).toHaveBeenCalledOnce();expect(f.canvas.outerHTML).toBe(original);
        f.runtime.restore(f.canvas);expect(f.handle.hide).toHaveBeenCalledOnce();expect(f.handle.dispose).not.toHaveBeenCalled();
        expect(f.runtime.reuse(f.canvas)).toBe(true);expect(f.handle.show).toHaveBeenCalledTimes(2);
        await f.runtime.translate(f.canvas);expect(f.presentation).toHaveBeenCalledOnce();expect(f.ports.translate).toHaveBeenCalledOnce();
        f.runtime.release(f.canvas);expect(f.handle.dispose).toHaveBeenCalledOnce();f.runtime.dispose();expect(f.handle.dispose).toHaveBeenCalledOnce();
    });
    it.each(['offscreen','hidden','disabled','occluded'])('只有展示资源而无fixed Canvas时仍执行 %s 可见性与恢复判断',async mode=>{
        const f=presentationFixture();await f.runtime.translate(f.canvas);
        if(mode==='offscreen')Object.assign(f.bounds,{left:1500,right:1900});
        if(mode==='hidden')Object.defineProperty(f.document,'hidden',{configurable:true,value:true});
        if(mode==='disabled')f.ports.enabled.mockReturnValue(false);
        if(mode==='occluded')f.hit.mockReturnValue(f.document.createElement('dialog'));
        f.runtime.update();expect(f.handle.hide).toHaveBeenCalledOnce();expect(f.handle.dispose).not.toHaveBeenCalled();
        Object.assign(f.bounds,{left:100,right:500});Object.defineProperty(f.document,'hidden',{configurable:true,value:false});
        f.ports.enabled.mockReturnValue(true);f.hit.mockReturnValue(f.canvas);f.runtime.update();
        expect(f.handle.show).toHaveBeenCalledTimes(2);expect(f.presentation).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('展示所有权被拒绝后停止自动再借用，显式复显仍复用同一资源',async()=>{
        const f=presentationFixture();f.handle.show.mockReturnValueOnce(false);await f.runtime.translate(f.canvas);
        expect(f.handle.hide).toHaveBeenCalledOnce();expect(f.runtime.failed(f.canvas)).toBe(false);
        f.runtime.update();f.runtime.update();expect(f.handle.show).toHaveBeenCalledOnce();
        expect(f.runtime.reuse(f.canvas)).toBe(true);expect(f.handle.show).toHaveBeenCalledTimes(2);expect(f.presentation).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it.each(['source','configuration','remove','reset','dispose'])('已发布资源在 %s 后永久释放一次',async mode=>{
        const f=presentationFixture();await f.runtime.translate(f.canvas);
        if(mode==='source')f.source.identity.mockReturnValue('source-2');
        if(mode==='configuration')f.ports.configurationIdentity.mockReturnValue('config-2');
        if(mode==='remove')f.canvas.remove();
        if(mode==='reset')f.runtime.resetCache();
        if(mode==='dispose')f.runtime.dispose();
        f.runtime.update();expect(f.handle.dispose).toHaveBeenCalledOnce();f.runtime.dispose();expect(f.handle.dispose).toHaveBeenCalledOnce();
    });
    it.each(['pause','release','dispose','configuration','source','remove','disabled'])('异步编码期间 %s，迟到资源不展示并归还，合成画布清零',async mode=>{
        const f=presentationFixture(),pending=deferred<typeof f.handle>();f.presentation.mockReturnValueOnce(pending.promise);
        const task=f.runtime.translate(f.canvas);await flush();expect(f.presentation).toHaveBeenCalledOnce();expect(f.handle.show).not.toHaveBeenCalled();
        const signal=f.presentation.mock.calls[0][2];
        if(mode==='pause')f.runtime.restore(f.canvas);
        if(mode==='release')f.runtime.release(f.canvas);
        if(mode==='dispose')f.runtime.dispose();
        if(mode==='configuration')f.ports.configurationIdentity.mockReturnValue('config-2');
        if(mode==='source')f.source.identity.mockReturnValue('source-2');
        if(mode==='remove')f.canvas.remove();
        if(mode==='disabled')f.ports.enabled.mockReturnValue(false);
        if(['pause','release','dispose'].includes(mode))expect(signal.aborted).toBe(true);
        pending.resolve(f.handle);await task;
        expect(f.handle.show).not.toHaveBeenCalled();expect(f.handle.dispose).toHaveBeenCalledOnce();expect(f.outputs[0].width).toBe(0);
        f.runtime.dispose();expect(f.handle.dispose).toHaveBeenCalledOnce();
    });
    it('编码拒绝按原失败流程暴露，不伪造完成或泄露临时画布',async()=>{
        const f=presentationFixture();f.presentation.mockRejectedValueOnce(new Error('encoding failed'));
        await expect(f.runtime.translate(f.canvas)).rejects.toThrow('encoding failed');
        expect(f.runtime.failed(f.canvas)).toBe(true);expect(f.runtime.reuse(f.canvas)).toBe(false);
        expect(f.outputs[0].width).toBe(0);expect(f.handle.show).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it('发布回调意外失败也释放已转交的资源，不保留已失败的显示句柄',async()=>{
        const f=presentationFixture();f.handle.show.mockImplementationOnce(()=>{throw new Error('presentation failed');});
        await expect(f.runtime.translate(f.canvas)).rejects.toThrow('presentation failed');
        expect(f.handle.dispose).toHaveBeenCalledOnce();expect(f.runtime.failed(f.canvas)).toBe(true);f.runtime.dispose();expect(f.handle.dispose).toHaveBeenCalledOnce();
    });
    it('无文字页不创建空背景展示资源，缓存复用仍不重识别',async()=>{
        const f=presentationFixture();f.ports.translate.mockResolvedValue({lines:[]});
        await f.runtime.translate(f.canvas);expect(f.presentation).not.toHaveBeenCalled();expect(f.runtime.reuse(f.canvas)).toBe(true);
        f.runtime.release(f.canvas);await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledOnce();expect(f.presentation).not.toHaveBeenCalled();f.runtime.dispose();
    });
});

describe('公开可读漫画画布的任务与显示所有权', () => {
    it('画布、背景和分段共用的错误反馈只从可信动作请求原会话重试，关闭不伪造成功或循环识别', async () => {
        const recovery={retry:vi.fn(()=>false),openSettings:vi.fn(async()=>{}),translateUi:(text:string)=>`本地化:${text}`};
        const f=fixture(recovery);f.ports.translate.mockRejectedValueOnce(Object.assign(new Error('provider detail'),{errorCode:'language'}));
        await expect(f.runtime.translate(f.canvas)).rejects.toThrow('provider detail');
        const root=f.roots[0],feedback=root.querySelector<HTMLElement>('.fr-image-feedback')!;
        const retry=feedback.querySelector<HTMLButtonElement>('.fluent-read-image-translation-button')!;
        const click=(target:Element,trusted=true)=>{const event=new f.window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:trusted});target.dispatchEvent(event);};
        expect(feedback.hidden).toBe(false);expect(feedback.style.left).toBe('108px');expect(feedback.style.top).toBe('58px');
        expect(feedback.textContent).toContain('本地化:图片文字已识别');expect(feedback.querySelector('details')!.textContent).toContain('provider detail');
        click(retry,false);expect(recovery.retry).not.toHaveBeenCalled();click(retry);expect(recovery.retry).toHaveBeenCalledWith(f.canvas);expect(retry.disabled).toBe(false);
        recovery.retry.mockReturnValue(true);click(retry);expect(retry.disabled).toBe(true);
        click(feedback.querySelector('.fr-image-model-settings')!);await flush();expect(recovery.openSettings).toHaveBeenCalledWith('settings-services');
        f.runtime.refreshLanguage();expect(feedback.querySelector('.fluent-read-image-translation-button')!.textContent).toBe('本地化:重试');
        click(feedback.querySelector('.fr-image-dismiss')!);expect(feedback.isConnected).toBe(false);
        expect(f.runtime.failed(f.canvas)).toBe(true);expect(f.runtime.reuse(f.canvas)).toBe(false);f.runtime.update();
        expect(root.querySelector('.fr-image-feedback')).toBeNull();expect(f.ports.translate).toHaveBeenCalledOnce();
        await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledTimes(2);expect(f.runtime.failed(f.canvas)).toBe(false);
        expect(root.querySelectorAll('style')).toHaveLength(1);f.runtime.refreshLanguage();f.runtime.dispose();
    });
    it('共享错误恢复跟随可见裁切，离屏、隐藏和宿主遮挡时撤下，不能把自己当作宿主遮挡', async () => {
        const f=fixture({retry:vi.fn(()=>false),openSettings:async()=>{}});f.ports.translate.mockRejectedValueOnce('offline');
        await expect(f.runtime.translate(f.canvas)).rejects.toBe('offline');
        const feedback=f.roots[0].querySelector<HTMLElement>('.fr-image-feedback')!,host=f.document.getElementById('fluent-read-manga-canvas-container')!;
        Object.assign(f.bounds,{left:-100,top:-50,right:300,bottom:250});f.runtime.update();
        expect(feedback.style.left).toBe('8px');expect(feedback.style.top).toBe('8px');expect(feedback.hidden).toBe(false);
        f.hit.mockReturnValue(host);f.document.elementsFromPoint=()=>[host,f.canvas];f.runtime.update();expect(feedback.hidden).toBe(false);
        f.document.elementsFromPoint=()=>[host];f.runtime.update();expect(feedback.hidden).toBe(true);
        f.document.elementsFromPoint=undefined as unknown as typeof document.elementsFromPoint;f.runtime.update();expect(feedback.hidden).toBe(true);
        const dialog=f.document.createElement('div');f.hit.mockReturnValue(dialog);f.runtime.update();expect(feedback.hidden).toBe(true);
        f.hit.mockReturnValue(f.canvas);Object.defineProperty(f.document,'hidden',{configurable:true,value:true});f.runtime.update();expect(feedback.hidden).toBe(true);
        Object.defineProperty(f.document,'hidden',{configurable:true,value:false});Object.assign(f.bounds,{left:1500,right:1900});f.runtime.update();expect(feedback.hidden).toBe(true);
        Object.assign(f.bounds,{left:100,right:500});f.runtime.update();expect(feedback.hidden).toBe(false);f.runtime.dispose();
    });
    it.each(['pause','invalidate','redraw','reset','remove','dispose'])('错误提示在 %s 清理，旧错误与迟到设置失败不会重新出现', async change => {
        const pending=deferred<void>(),settings=vi.fn(()=>pending.promise),retry=vi.fn(()=>false),f=fixture({retry,openSettings:settings});
        f.ports.translate.mockRejectedValueOnce(new Error('offline'));await expect(f.runtime.translate(f.canvas)).rejects.toThrow('offline');
        const root=f.roots[0],feedback=root.querySelector<HTMLElement>('.fr-image-feedback')!;
        const click=(target:Element)=>{const event=new f.window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:true});target.dispatchEvent(event);};
        click(feedback.querySelector('.fr-image-service-settings')!);await flush();
        if(change==='pause')f.runtime.restore(f.canvas);
        if(change==='invalidate')f.runtime.invalidate(f.canvas);
        if(change==='redraw'){f.canvas.dataset.pixel='2';f.runtime.update();}
        if(change==='reset')f.runtime.resetCache();
        if(change==='remove'){f.canvas.remove();f.runtime.update();}
        if(change==='dispose')f.runtime.dispose();
        pending.reject(new Error('late settings failure'));await flush();
        expect(feedback.isConnected).toBe(false);expect(root.querySelector('.fr-image-feedback')).toBeNull();
        click(feedback.querySelector('.fluent-read-image-translation-button')!);expect(retry).not.toHaveBeenCalled();
        expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it.each(['pause','redraw','configuration','reset','remove','dispose','disable'])('在途识别于 %s 失效后拒绝，不创建迟到错误恢复提示', async change => {
        const pending=deferred<typeof result>(),f=fixture({retry:vi.fn(()=>false),openSettings:async()=>{}});
        f.ports.translate.mockReturnValueOnce(pending.promise);const task=f.runtime.translate(f.canvas);await flush();
        if(change==='pause')f.runtime.restore(f.canvas);
        if(change==='redraw')f.canvas.dataset.pixel='2';
        if(change==='configuration')f.ports.configurationIdentity.mockReturnValue('new settings');
        if(change==='reset')f.runtime.resetCache();
        if(change==='remove')f.canvas.remove();
        if(change==='dispose')f.runtime.dispose();
        if(change==='disable')f.ports.enabled.mockReturnValue(false);
        pending.reject(new Error('late OCR failure'));await task;
        expect(f.runtime.failed(f.canvas)).toBe(false);expect(f.roots).toHaveLength(0);expect(f.canvas.style.opacity).not.toBe('0');f.runtime.dispose();
    });
    it.each([new Error('settings offline'),'settings offline'])('打开设置失败保留真实错误详情，状态失效的恢复动作不能绕过会话 %s', async cause => {
        const openSettings=vi.fn().mockRejectedValueOnce(cause).mockRejectedValueOnce(new Error('later settings failure'));
        const retry=vi.fn(()=>false),f=fixture({retry,openSettings});f.ports.translate.mockRejectedValueOnce(new Error('provider failed'));
        await expect(f.runtime.translate(f.canvas)).rejects.toThrow('provider failed');
        const feedback=f.roots[0].querySelector<HTMLElement>('.fr-image-feedback')!;
        const click=(target:Element)=>{const event=new f.window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:true});target.dispatchEvent(event);};
        f.ports.enabled.mockReturnValue(false);click(feedback.querySelector('.fluent-read-image-translation-button')!);click(feedback.querySelector('.fr-image-service-settings')!);await flush();
        expect(retry).not.toHaveBeenCalled();expect(openSettings).not.toHaveBeenCalled();
        f.ports.enabled.mockReturnValue(true);click(feedback.querySelector('.fr-image-service-settings')!);await flush();
        expect(feedback.textContent).toContain('无法打开设置');expect(feedback.querySelector('details')!.textContent).toContain('settings offline');
        // 关闭后已经在途的设置异常也不能重新挂载提示。
        await f.runtime.translate(f.canvas);f.ports.translate.mockRejectedValueOnce(new Error('new failure'));f.ports.cacheEnabled.mockReturnValue(false);
        f.runtime.release(f.canvas);await expect(f.runtime.translate(f.canvas)).rejects.toThrow('new failure');
        const next=f.roots[0].querySelector<HTMLElement>('.fr-image-feedback')!;
        click(next.querySelector('.fr-image-service-settings')!);click(next.querySelector('.fr-image-dismiss')!);await flush();
        expect(f.roots[0].querySelector('.fr-image-feedback')).toBeNull();expect(f.runtime.failed(f.canvas)).toBe(true);f.runtime.dispose();
    });
    it('错误详情的设置请求排队后改变来源配置，微任务不能打开旧页面的设置', async () => {
        const openSettings=vi.fn(async()=>{}),f=fixture({retry:vi.fn(()=>false),openSettings});
        f.ports.translate.mockRejectedValueOnce(new Error('provider failed'));await expect(f.runtime.translate(f.canvas)).rejects.toThrow();
        const button=f.roots[0].querySelector('.fr-image-service-settings')!,event=new f.window.Event('click',{bubbles:true});
        Object.defineProperty(event,'isTrusted',{value:true});button.dispatchEvent(event);
        f.ports.configurationIdentity.mockReturnValue('new model');await flush();expect(openSettings).not.toHaveBeenCalled();
        f.runtime.update();expect(button.isConnected).toBe(false);f.runtime.dispose();
    });
    it.each(['toggle', 'retry'])('显式%s在旧采样点未变时隐藏旧译层并翻译新原图', async action => {
        const f = fixture(), reader = readerFor(f);
        f.canvas.dataset.content = 'A';reader.toggle();await flush();
        expect(f.ports.translate).toHaveBeenCalledOnce();
        const output = f.outputs[0], identity = f.runtime.identity(f.canvas);
        if (action === 'toggle') reader.toggle();
        f.canvas.dataset.content = 'B';expect(f.runtime.identity(f.canvas)).toBe(identity);
        if (action === 'toggle') reader.toggle();
        else expect(reader.retry(f.canvas)).toBe(true);
        expect(output.isConnected).toBe(false);
        await flush();
        expect(f.ports.translate).toHaveBeenCalledTimes(2);
        expect(f.ports.translate.mock.calls[1][0]).toBe(`data:image/png;base64,${btoa('B')}`);
        expect(f.outputs[1].isConnected).toBe(true);
        reader.dispose();f.runtime.dispose();
    });

    it.each([true, false])('同源显式操作只验证一次并复用已完成译层，不重复模型与合成，缓存开关%s', async cache => {
        const f = fixture();f.ports.cacheEnabled.mockReturnValue(cache);
        const reader = readerFor(f);reader.toggle();await flush();
        const output = f.outputs[0];expect(output.isConnected).toBe(true);expect(encode).toHaveBeenCalledTimes(2);
        for (const action of ['toggle', 'retry']) {
            const before = encode.mock.calls.length;
            if (action === 'toggle') {reader.toggle();reader.toggle();}
            else expect(reader.retry(f.canvas)).toBe(true);
            expect(output.isConnected).toBe(false);expect(f.runtime.reuse(f.canvas)).toBe(false);
            await flush();expect(output.isConnected).toBe(true);expect(encode).toHaveBeenCalledTimes(before + 1);
            expect(f.ports.translate).toHaveBeenCalledOnce();expect(compose).toHaveBeenCalledOnce();
        }
        const count = encode.mock.calls.length;
        for (let i = 0; i < 20; i++) {f.runtime.identity(f.canvas);f.runtime.update();}
        expect(encode).toHaveBeenCalledTimes(count);
        reader.dispose();f.runtime.dispose();
    });

    it('开启只标记当前及附近画布，远页不保留且无预译时不额外编码', async () => {
        const f = fixture(), reader = readerFor(f), invalidate = vi.spyOn(f.runtime, 'invalidate');
        for (let index = 1; index <= 3; index++) {
            const canvas = f.document.createElement('canvas') as HTMLCanvasElement;canvas.width = 400;canvas.height = 300;
            canvas.getBoundingClientRect = () => ({left: 0, top: index * 1000, right: 400, bottom: index * 1000 + 300, width: 400, height: 300}) as DOMRect;
            f.canvas.parentElement!.append(canvas);
        }
        reader.toggle();await flush();
        expect(invalidate).toHaveBeenCalledTimes(3);expect(invalidate).toHaveBeenNthCalledWith(1, f.canvas);
        expect(f.ports.translate).toHaveBeenCalledOnce();expect(encode).toHaveBeenCalledTimes(2);
        expect(reader.status()).toMatchObject({pageCount: 4, completed: 1});reader.dispose();f.runtime.dispose();
    });

    it('初始编码与合成复用同一不可变快照，发布前发现未采样重绘则丢弃译层且不写缓存', async () => {
        const f = fixture({retry: vi.fn(() => false), openSettings: async () => {}});
        encode.mockImplementation(async canvas => `data:image/png;base64,${btoa(canvas.dataset.content || 'A')}`);
        const captured: string[] = [], originalCompose = compose.getMockImplementation()!;
        compose.mockImplementation(async (...args) => {captured.push((args[0] as HTMLCanvasElement).dataset.content!);return originalCompose(...args);});
        f.canvas.dataset.content = 'A';
        f.ports.translate.mockImplementationOnce(async () => {f.canvas.dataset.content = 'B';return result;});
        await expect(f.runtime.translate(f.canvas)).rejects.toThrow('画布内容已变化');
        expect(f.ports.translate.mock.calls[0][0]).toBe(`data:image/png;base64,${btoa('A')}`);
        expect(captured).toEqual(['A']);expect(encode.mock.calls[0][0]).toBe(compose.mock.calls[0][0]);
        expect(encode.mock.calls[1][0]).toBe(encode.mock.calls[0][0]);
        expect(f.outputs[0].width).toBe(0);expect(f.outputs[0].isConnected).toBe(false);expect(f.runtime.failed(f.canvas)).toBe(true);
        const feedback = f.roots[0].querySelector<HTMLElement>('.fr-image-feedback')!;
        expect(feedback.hidden).toBe(false);expect(feedback.textContent).toContain('画布内容已变化');
        expect(f.runtime.reuse(f.canvas)).toBe(false);
        f.canvas.dataset.content = 'A';await f.runtime.translate(f.canvas);
        expect(f.ports.translate).toHaveBeenCalledTimes(2);expect(f.outputs[1].isConnected).toBe(true);
        expect(feedback.isConnected).toBe(false);expect(f.roots[0].querySelector('.fr-image-feedback')).toBeNull();f.runtime.dispose();
    });

    it('A→B→C显式代次丢弃忽略取消的B编码，迟到完成不能覆盖C或恢复旧译层', async () => {
        const f = fixture();encode.mockImplementation(async canvas => `data:image/png;base64,${btoa(canvas.dataset.content || 'A')}`);
        await f.runtime.translate(f.canvas);const old = f.outputs[0], pending = deferred<string>();
        f.canvas.dataset.content = 'B';f.runtime.invalidate(f.canvas);encode.mockReturnValueOnce(pending.promise);
        const b = f.runtime.translate(f.canvas);await flush();expect(old.isConnected).toBe(false);
        f.canvas.dataset.content = 'C';f.runtime.invalidate(f.canvas);await f.runtime.translate(f.canvas);
        const current = f.outputs[1];expect(current.isConnected).toBe(true);
        pending.resolve(`data:image/png;base64,${btoa('B')}`);await b;
        expect(current.isConnected).toBe(true);expect(f.ports.translate.mock.calls.map(call => call[0])).toEqual([
            `data:image/png;base64,${btoa('A')}`, `data:image/png;base64,${btoa('C')}`,
        ]);expect(old.width).toBe(0);f.runtime.dispose();
    });

    it('关闭后再次开启取消在途识别但保留串行槽，迟到旧结果不合成且随后只翻译新来源', async () => {
        const f = fixture(), reader = readerFor(f), pending = deferred<typeof result>();
        f.canvas.dataset.content = 'A';f.ports.translate.mockReturnValueOnce(pending.promise);
        reader.toggle();await flush();expect(f.ports.translate).toHaveBeenCalledOnce();
        f.canvas.dataset.content = 'B';reader.toggle();reader.toggle();await flush();
        expect(f.ports.translate.mock.calls[0][1].aborted).toBe(true);
        expect(f.ports.translate).toHaveBeenCalledOnce();expect(compose).not.toHaveBeenCalled();
        pending.resolve(result);await flush();
        expect(f.ports.translate.mock.calls.map(call => call[0])).toEqual([
            `data:image/png;base64,${btoa('A')}`, `data:image/png;base64,${btoa('B')}`,
        ]);
        expect(compose).toHaveBeenCalledOnce();expect(f.outputs[0].isConnected).toBe(true);
        expect(reader.status()).toMatchObject({completed: 1, errors: 0, pending: false});
        reader.dispose();f.runtime.dispose();
    });

    it.each(['initial', 'publication'])('异步原生摘要%s阶段取消后不识别、不发布或缓存迟到结果', async phase => {
        const f = fixture(), pending = deferred<ArrayBuffer>(), digest = vi.fn();
        if (phase === 'publication') digest.mockResolvedValueOnce(new Uint8Array(32).buffer);
        digest.mockReturnValueOnce(pending.promise).mockResolvedValue(new Uint8Array(32).buffer);
        vi.stubGlobal('crypto', {subtle: {digest}});
        const task = f.runtime.translate(f.canvas);await flush();
        expect(digest).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2);
        f.runtime.invalidate(f.canvas);pending.resolve(new Uint8Array(32).buffer);await task;
        expect(f.runtime.failed(f.canvas)).toBe(false);
        if (phase === 'initial') expect(f.ports.translate).not.toHaveBeenCalled();
        else {expect(f.outputs[0].width).toBe(0);expect(f.outputs[0].isConnected).toBe(false);}
        await f.runtime.translate(f.canvas);
        expect(f.ports.translate).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2);f.runtime.dispose();
    });

    it('WebCrypto不可用仍以完整来源区分缓存，源注入适配器不进入原生验证合同', async () => {
        const f = fixture();vi.stubGlobal('crypto', undefined);await f.runtime.translate(f.canvas);
        f.runtime.invalidate(f.canvas);await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledOnce();
        const source = createMangaCanvas({...f.ports, source: {identity: () => 'url-load-revision', bounds: () => f.bounds as DOMRect,
            capture: async (_element, target) => {target.width = 400;target.height = 300;}}});
        await source.translate(f.canvas);source.invalidate(f.canvas);expect(source.reuse(f.canvas)).toBe(true);
        source.dispose();source.invalidate(f.canvas);f.runtime.dispose();f.runtime.invalidate(f.canvas);
    });

    it('注入来源校验锚点与身份，成功裁切后复用压缩缓存，空身份不抓取', async () => {
        const f = fixture(), identity = vi.fn<() => string | null>(() => 'segment-1'), anchor = vi.fn(() => f.canvas);
        const source = createMangaCanvas({...f.ports, source: {identity, anchor, bounds: () => f.bounds as DOMRect,
            capture: async (_element, target) => {target.width = 400;target.height = 300;},
            viewport: () => ({x: 0, y: 50, width: 400, height: 200})}});
        await source.translate(f.canvas);
        expect(anchor).toHaveBeenCalledWith(f.canvas);expect(f.outputs[0].width).toBe(0);
        source.release(f.canvas);await source.translate(f.canvas);
        expect(f.ports.translate).toHaveBeenCalledOnce();expect(compose).toHaveBeenCalledTimes(2);
        expect(source.reuse(f.canvas)).toBe(true);source.release(f.canvas);identity.mockReturnValue(null);
        await source.translate(f.canvas);expect(source.identity(f.canvas)).toBeNull();
        expect(f.ports.translate).toHaveBeenCalledOnce();source.dispose();f.runtime.dispose();
    });

    it.each(['source', 'publication'])('异步编码%s阶段取消后不启动识别或发布译层', async phase => {
        const f = fixture(), pending = deferred<string>();
        const runtime = phase === 'source' ? createMangaCanvas({...f.ports, source: {
            identity: () => 'background-1', bounds: () => f.bounds as DOMRect,
            capture: async (_element, target) => {target.width = 400;target.height = 300;},
        }}) : f.runtime;
        if (phase === 'publication') encode.mockResolvedValueOnce('data:image/png;base64,AQ==');
        encode.mockReturnValueOnce(pending.promise);
        const task = runtime.translate(f.canvas);await flush();runtime.restore(f.canvas);
        pending.resolve('data:image/png;base64,AQ==');await task;
        expect(runtime.failed(f.canvas)).toBe(false);
        if (phase === 'source') expect(f.ports.translate).not.toHaveBeenCalled();
        else expect(f.outputs[0].width).toBe(0);
        expect(f.outputs.every(output => !output.isConnected)).toBe(true);runtime.dispose();f.runtime.dispose();
    });

    it('无文字完成页在显式验证期间也不复用且不合成空译层', async () => {
        const f = fixture();f.ports.translate.mockResolvedValue({lines: []});
        await f.runtime.translate(f.canvas);f.runtime.invalidate(f.canvas);await f.runtime.translate(f.canvas);
        expect(f.ports.translate).toHaveBeenCalledOnce();expect(compose).not.toHaveBeenCalled();
        expect(f.runtime.reuse(f.canvas)).toBe(true);f.runtime.dispose();
    });


    it.each(['context','draw'])('分段输出裁切失败释放上下文和合成画布，并保留原文 %s',async mode=>{
        const f=fixture();
        const runtime=createMangaCanvas({...f.ports,source:{identity:()=> 'crop',bounds:()=>f.bounds as DOMRect,capture:async(_element,target)=>{target.width=400;target.height=300;},viewport:()=>({x:0,y:50,width:400,height:200})}});
        compose.mockImplementation(async()=>{
            const output=f.document.createElement('canvas') as HTMLCanvasElement;output.width=400;output.height=300;f.outputs.push(output);
            if(mode==='context')f.missingContext();
            else {
                const create=f.document.createElement.bind(f.document);
                vi.spyOn(f.document,'createElement').mockImplementation(((tag:string)=>{const value=create(tag);if(tag==='canvas')(value as HTMLCanvasElement).getContext=(()=>({drawImage:()=>{throw new Error('crop failed');}})) as unknown as typeof output.getContext;return value;}) as typeof f.document.createElement);
            }
            return output;
        });
        await expect(runtime.translate(f.canvas)).rejects.toThrow();expect(runtime.failed(f.canvas)).toBe(true);expect(f.outputs[0].width).toBe(0);
        runtime.dispose();f.runtime.dispose();
    });
    it('异步快照即使忽略取消，完成后也不能发送已暂停任务的 OCR',async()=>{
        const f=fixture(),capture=deferred<void>();
        const runtime=createMangaCanvas({...f.ports,source:{identity:()=> 'public-source',bounds:()=>f.bounds as DOMRect,capture:()=>capture.promise}});
        const task=runtime.translate(f.canvas);runtime.restore(f.canvas);capture.resolve();await task;
        expect(f.ports.translate).not.toHaveBeenCalled();runtime.dispose();f.runtime.dispose();
    });
    it.each(['redraw','configuration','remove','pause','reset','dispose','disable'])('异步编码迟到后复核所有权，不识别已失效快照 %s',async mode=>{
        const f=fixture(),pending=deferred<string>();encode.mockReturnValue(pending.promise);
        const task=f.runtime.translate(f.canvas);await flush();
        const [snapshot,signal]=encode.mock.calls[0];
        expect(snapshot).not.toBe(f.canvas);expect(snapshot.width).toBe(400);expect(snapshot.height).toBe(300);
        expect(snapshot.toDataURL).not.toHaveBeenCalled();expect(f.ports.translate).not.toHaveBeenCalled();
        if(mode==='redraw'){f.canvas.dataset.pixel='2';f.runtime.update();}
        if(mode==='configuration'){f.ports.configurationIdentity.mockReturnValue('config-2');f.runtime.update();}
        if(mode==='remove'){f.canvas.remove();f.runtime.update();}
        if(mode==='pause')f.runtime.restore(f.canvas);
        if(mode==='reset')f.runtime.resetCache();
        if(mode==='dispose')f.runtime.dispose();
        if(mode==='disable')f.ports.enabled.mockReturnValue(false);
        pending.resolve('data:image/png;base64,late');await task;
        expect(f.ports.translate).not.toHaveBeenCalled();expect(compose).not.toHaveBeenCalled();
        expect(snapshot.width).toBe(0);expect(snapshot.height).toBe(0);expect(f.runtime.failed(f.canvas)).toBe(false);
        if(mode!=='disable')expect(signal?.aborted).toBe(true);f.runtime.dispose();
    });
    it('编码中取消的拒绝不记录旧失败，完整快照及时释放',async()=>{
        const f=fixture(),pending=deferred<string>();encode.mockReturnValue(pending.promise);
        const task=f.runtime.translate(f.canvas);await flush();const [snapshot,signal]=encode.mock.calls[0];
        f.runtime.restore(f.canvas);expect(signal?.aborted).toBe(true);
        pending.reject(new DOMException('已取消','AbortError'));await task;
        expect(f.ports.translate).not.toHaveBeenCalled();expect(f.runtime.failed(f.canvas)).toBe(false);
        expect(snapshot.width).toBe(0);f.runtime.dispose();
    });
    it('当前编码失败保留原文并允许下一次重试',async()=>{
        const f=fixture();encode.mockRejectedValueOnce(new Error('图片数据读取失败'));
        await expect(f.runtime.translate(f.canvas)).rejects.toThrow('图片数据读取失败');
        expect(f.runtime.failed(f.canvas)).toBe(true);expect(f.ports.translate).not.toHaveBeenCalled();
        await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledOnce();
        expect(f.ports.translate.mock.calls[0][0]).toBe('data:image/png;base64,AQ==');f.runtime.dispose();
    });
    it('识别重绘和配置变化，受污染或空画布不阻止后一张正常正文', () => {
        const f = fixture(), first = f.runtime.identity(f.canvas);
        expect(first).not.toBeNull();expect(f.runtime.identity(f.canvas)).toBe(first);
        f.canvas.dataset.pixel = '2';expect(f.runtime.identity(f.canvas)).not.toBe(first);
        const second = f.runtime.identity(f.canvas);f.ports.configurationIdentity.mockReturnValue('config-2');expect(f.runtime.identity(f.canvas)).not.toBe(second);
        f.canvas.dataset.tainted = 'true';expect(f.runtime.identity(f.canvas)).toBeNull();
        delete f.canvas.dataset.tainted;expect(f.runtime.identity(f.canvas)).not.toBeNull();
        f.canvas.dataset.pixel = '0';expect(f.runtime.identity(f.canvas)).toBeNull();f.runtime.dispose();
    });
    it.each([[79,300],[400,39],[8193,100],[100,8193],[5000,5000]])('像素尺寸边界拒绝不可处理画布 %sx%s', (width,height) => {
        const f = fixture();f.canvas.width = width;f.canvas.height = height;expect(f.runtime.identity(f.canvas)).toBeNull();f.runtime.dispose();
    });
    it('独立快照经现有端口翻译，仅在译层显示时隐藏原绘制，暂停归还宿主且重复开启不重跑模型', async () => {
        const f = fixture(), original = f.canvas.outerHTML;
        await f.runtime.translate(f.canvas);
        expect(f.ports.translate).toHaveBeenCalledOnce();expect(compose.mock.calls[0][0]).not.toBe(f.canvas);
        expect((compose.mock.calls[0][0] as HTMLCanvasElement).width).toBe(0);
        const output = f.outputs[0];expect(output.style.display).toBe('block');expect(output.style.pointerEvents).toBe('none');expect(output.style.left).toBe('100px');
        const host = f.document.getElementById('fluent-read-manga-canvas-container')!;
        expect(host.shadowRoot).toBeNull();
        // 外层也是插件所有的 UI，必须抵抗宿主全局强制隐藏和点击规则；真实计算样式由浏览器夹具验证。
        expect(host.style.cssText).toMatch(/all:\s*initial\s*!important/);
        expect(host.style.cssText).toMatch(/display:\s*block\s*!important/);
        expect(host.style.cssText).toMatch(/pointer-events:\s*none\s*!important/);
        expect(f.canvas.style.opacity).toBe('0');expect(f.canvas.style.getPropertyPriority('opacity')).toBe('important');expect(f.runtime.failed(f.canvas)).toBe(false);
        f.runtime.restore(f.canvas);expect(output.isConnected).toBe(false);expect(f.canvas.outerHTML).toBe(original);
        expect(f.runtime.reuse(f.canvas)).toBe(true);expect(output.isConnected).toBe(true);
        await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledOnce();
        f.runtime.dispose();expect(output.width).toBe(0);expect(f.document.getElementById('fluent-read-manga-canvas-container')).toBeNull();
        expect(f.canvas.outerHTML).toBe(original);expect(f.runtime.identity(f.canvas)).toBeNull();
    });
    it('离屏释放位图后，有界压缩结果可重建而不重新 OCR；关闭缓存后重跑', async () => {
        const f = fixture();await f.runtime.translate(f.canvas);f.runtime.release(f.canvas);expect(f.outputs[0].width).toBe(0);
        await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledOnce();expect(compose).toHaveBeenCalledTimes(2);
        f.runtime.release(f.canvas);f.ports.cacheEnabled.mockReturnValue(false);await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledTimes(2);
        f.runtime.resetCache();await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledTimes(3);f.runtime.dispose();
    });
    it('无文字页保留完成标记，恢复和压缩缓存复用不创建空译图', async () => {
        const f = fixture();f.ports.translate.mockResolvedValue({lines: []});
        await f.runtime.translate(f.canvas);expect(f.runtime.reuse(f.canvas)).toBe(true);expect(compose).not.toHaveBeenCalled();
        f.runtime.release(f.canvas);await f.runtime.translate(f.canvas);expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it.each(['redraw','configuration','remove','pause','reset','dispose','disable'])('在途请求失去所有权后取消或丢弃迟到结果 %s', async mode => {
        const f = fixture(), pending = deferred<typeof result>();f.ports.translate.mockReturnValue(pending.promise);
        const task = f.runtime.translate(f.canvas);await flush();const signal = f.ports.translate.mock.calls[0][1] as AbortSignal;
        if (mode === 'redraw') {f.canvas.dataset.pixel = '2';f.runtime.update();}
        if (mode === 'configuration') {f.ports.configurationIdentity.mockReturnValue('config-2');f.runtime.update();}
        if (mode === 'remove') {f.canvas.remove();f.runtime.update();}
        if (mode === 'pause') f.runtime.restore(f.canvas);
        if (mode === 'reset') f.runtime.resetCache();
        if (mode === 'dispose') f.runtime.dispose();
        if (mode === 'disable') f.ports.enabled.mockReturnValue(false);
        pending.resolve(result);await task;expect(compose).not.toHaveBeenCalled();expect(f.outputs).toHaveLength(0);
        if (mode !== 'disable') expect(signal.aborted).toBe(true);f.runtime.dispose();
    });
    it('合成期间取消仍释放迟到画布，失败只记录当前任务，原画布保持可读', async () => {
        const f = fixture(), pending = deferred<HTMLCanvasElement>();compose.mockReturnValue(pending.promise);
        const task = f.runtime.translate(f.canvas);await flush();f.runtime.restore(f.canvas);
        const output = f.document.createElement('canvas') as HTMLCanvasElement;output.width = 400;output.height = 300;
        pending.resolve(output);await task;expect(output.width).toBe(0);expect(output.isConnected).toBe(false);
        f.runtime.resetCache();f.ports.translate.mockRejectedValue(new Error('OCR unavailable'));await expect(f.runtime.translate(f.canvas)).rejects.toThrow('OCR unavailable');
        expect(f.runtime.failed(f.canvas)).toBe(true);expect(f.runtime.reuse(f.canvas)).toBe(false);f.runtime.dispose();
    });
    it('取消后客户端拒绝不发布旧失败', async () => {
        const f = fixture(), pending = deferred<typeof result>();f.ports.translate.mockReturnValue(pending.promise);
        const task = f.runtime.translate(f.canvas);await flush();f.runtime.release(f.canvas);pending.reject(new Error('cancelled'));await task;
        expect(f.runtime.failed(f.canvas)).toBe(false);f.runtime.release(f.canvas);f.runtime.restore(f.canvas);f.runtime.dispose();
    });
    it('缺少浏览器处理能力或有效结果时保留原文并允许显式重试', async () => {
        const f = fixture();f.missingContext();await expect(f.runtime.translate(f.canvas)).rejects.toThrow('不支持');expect(f.runtime.failed(f.canvas)).toBe(true);f.runtime.dispose();
        const second = fixture();second.ports.translate.mockResolvedValue({lines: result.lines});await expect(second.runtime.translate(second.canvas)).rejects.toThrow('数据无效');second.runtime.dispose();
    });
    it('缺少采样上下文时不宣布画布可读，也不启动翻译', async () => {
        const f = fixture();f.runtime.identity(f.canvas);vi.mocked(f.snapshots[1].getContext).mockReturnValue(null);
        expect(f.runtime.identity(f.canvas)).toBeNull();await f.runtime.translate(f.canvas);expect(f.ports.translate).not.toHaveBeenCalled();f.runtime.dispose();
    });
    it('禁用或离开 DOM 时不读取完整像素、不启动翻译', async () => {
        const f = fixture();f.ports.enabled.mockReturnValue(false);await f.runtime.translate(f.canvas);expect(f.ports.translate).not.toHaveBeenCalled();
        f.ports.enabled.mockReturnValue(true);f.canvas.remove();await f.runtime.translate(f.canvas);expect(f.ports.translate).not.toHaveBeenCalled();
        f.canvas.width = 1;await f.runtime.translate(f.canvas);expect(f.runtime.reuse(f.canvas)).toBe(false);f.runtime.dispose();
    });
    it('祖先裁切、滚动、隐藏与宿主弹窗控制显示范围，不穿透覆盖物', async () => {
        const f = fixture(), parent = f.canvas.parentElement!;
        Reflect.deleteProperty(f.ports,'acceptsInteractionLayer');
        parent.getBoundingClientRect = () => ({left:150,right:450,top:75,bottom:325}) as DOMRect;
        f.styles.set(parent,{overflowX:'hidden',overflowY:'auto'});await f.runtime.translate(f.canvas);
        const output = f.outputs[0];expect(output.style.clipPath).toBe('inset(25px 50px 25px 50px)');
        f.bounds.top = -400;f.bounds.bottom = -100;f.runtime.update();expect(output.style.display).toBe('none');
        f.bounds.top = 50;f.bounds.bottom = 350;f.hit.mockReturnValue(parent);f.runtime.update();expect(output.style.display).toBe('block');
        f.hit.mockReturnValue(f.document.body.appendChild(f.document.createElement('dialog')));f.runtime.update();expect(output.style.display).toBe('none');
        f.hit.mockReturnValue(null);f.runtime.update();expect(output.style.display).toBe('none');
        f.hit.mockReturnValue(f.canvas);f.styles.set(parent,{opacity:'0'});f.runtime.update();expect(output.style.display).toBe('none');
        f.styles.set(parent,{display:'none'});f.runtime.update();expect(output.style.display).toBe('none');
        f.styles.set(parent,{visibility:'hidden'});f.runtime.update();expect(output.style.display).toBe('none');
        f.styles.set(parent,{visibility:'collapse'});f.runtime.update();expect(output.style.display).toBe('none');
        f.styles.clear();Object.defineProperty(f.document,'hidden',{configurable:true,value:true});f.runtime.update();expect(output.style.display).toBe('none');
        Object.defineProperty(f.document,'hidden',{value:false});f.ports.enabled.mockReturnValue(false);f.runtime.update();expect(output.style.display).toBe('none');f.runtime.dispose();
    });
    it('仅已适配的透明翻页层允许正文译图，其他覆盖物仍隐藏译图且不接管点击', async () => {
        const f=fixture(),nav=f.document.createElement('div');nav.id='xCVLeftNav';f.document.body.append(nav);f.hit.mockReturnValue(nav);
        f.ports.acceptsInteractionLayer.mockImplementation((_canvas,hit)=>hit===nav);await f.runtime.translate(f.canvas);
        expect(f.outputs[0].style.display).toBe('block');expect(f.outputs[0].style.pointerEvents).toBe('none');
        f.hit.mockReturnValue(f.document.createElement('dialog'));f.runtime.update();expect(f.outputs[0].style.display).toBe('none');f.runtime.dispose();
    });
    it('发布前不隐藏原绘制，译层挂载后才交接，重复update不把自己的opacity0当宿主隐藏', async () => {
        const f=fixture(),pending=deferred<HTMLCanvasElement>();compose.mockReturnValueOnce(pending.promise);
        const original=f.canvas.outerHTML,task=f.runtime.translate(f.canvas);await flush();
        expect(f.canvas.outerHTML).toBe(original);
        const output=f.document.createElement('canvas') as HTMLCanvasElement;output.width=400;output.height=300;
        pending.resolve(output);await task;
        expect(output.isConnected).toBe(true);expect(f.canvas.style.opacity).toBe('0');
        for(let i=0;i<3;i++)f.runtime.update();
        expect(output.style.display).toBe('block');expect(f.canvas.style.opacity).toBe('0');
        f.runtime.restore(f.canvas);expect(f.canvas.outerHTML).toBe(original);f.runtime.dispose();
    });
    it('简单Canvas译层沿用源本身透明度，恢复只归还inline而不回写computed值', async () => {
        const f=fixture(),parent=f.canvas.parentElement!;
        f.canvas.style.setProperty('opacity','.5','important');f.styles.set(parent,{opacity:'1'});
        f.canvas.dataset.pixel='123';const content=f.canvas.dataset.pixel;
        await f.runtime.translate(f.canvas);const output=f.outputs[0];
        expect(output.style.opacity).toBe('.5');expect(f.canvas.style.opacity).toBe('0');
        f.runtime.update();expect(output.style.opacity).toBe('.5');
        expect(f.canvas.dataset.pixel).toBe(content);expect([f.canvas.width,f.canvas.height]).toEqual([400,300]);
        f.runtime.restore(f.canvas);expect(f.canvas.style.opacity).toBe('.5');expect(f.canvas.style.getPropertyPriority('opacity')).toBe('important');
        expect(f.runtime.reuse(f.canvas)).toBe(true);expect(f.ports.translate).toHaveBeenCalledOnce();f.runtime.dispose();
    });
    it('计算样式端口未给透明度时沿用不透明默认值，不将缺值写回原样式',async()=>{
        const f=fixture();f.styles.set(f.canvas,{opacity:''});await f.runtime.translate(f.canvas);
        expect(f.outputs[0].style.opacity).toBe('1');f.runtime.restore(f.canvas);expect(f.canvas.style.opacity).toBeUndefined();f.runtime.dispose();
    });
    it.each(['restore','invalidate','source','remove','reset','dispose','disabled','hidden','offscreen','occluded','detached-output','class'] as const)('原生Canvas撤层%s归还原绘制且没有迟到租约',async change=>{
        const f=fixture(),original=f.canvas.outerHTML;await f.runtime.translate(f.canvas);const output=f.outputs[0];
        expect(f.canvas.style.opacity).toBe('0');
        if(change==='restore')f.runtime.restore(f.canvas);
        else if(change==='invalidate')f.runtime.invalidate(f.canvas);
        else if(change==='reset')f.runtime.resetCache();
        else if(change==='dispose')f.runtime.dispose();
        else {
            if(change==='source')f.canvas.dataset.pixel='2';
            if(change==='remove')f.canvas.remove();
            if(change==='disabled')f.ports.enabled.mockReturnValue(false);
            if(change==='hidden')Object.defineProperty(f.document,'hidden',{value:true,configurable:true});
            if(change==='offscreen'){f.bounds.top=1000;f.bounds.bottom=1300;}
            if(change==='occluded')f.hit.mockReturnValue(null);
            if(change==='detached-output')output.remove();
            if(change==='class'){f.canvas.className='host-hidden';f.styles.set(f.canvas,{opacity:'0'});}
            f.runtime.update();
        }
        expect(f.canvas.style.opacity).not.toBe('0');expect(f.canvas.style.getPropertyPriority('transition-property')).not.toBe('important');
        if(change==='restore')expect(f.canvas.outerHTML).toBe(original);
        if(change==='class')expect(output.isConnected).toBe(false);
        f.runtime.dispose();expect(f.canvas.style.opacity).not.toBe('0');
    });
    it.each([{value:'.3',priority:''},{value:'0',priority:''},{value:'.8',priority:'important'}])('宿主改写opacity=$value/$priority时撤层且不覆盖新值',async ({value,priority})=>{
        const f=fixture();f.canvas.style.setProperty('opacity','.7');await f.runtime.translate(f.canvas);
        f.canvas.style.setProperty('opacity',value,priority);f.runtime.update();
        expect(f.outputs[0].isConnected).toBe(false);expect(f.canvas.style.opacity).toBe(value);expect(f.canvas.style.getPropertyPriority('opacity')).toBe(priority);
        f.runtime.dispose();expect(f.canvas.style.opacity).toBe(value);expect(f.canvas.style.getPropertyPriority('opacity')).toBe(priority);
    });
    it.each(['transition-property','transition-duration','transition-timing-function','transition-delay','transition-behavior','remove-duration'] as const)('宿主改写canonical过渡%s保留其新值，借用仅归还transition-property',async property=>{
        const f=fixture(),values=[['transition','opacity 2s ease 1s'],['transition-property','opacity'],['transition-duration','2s'],['transition-timing-function','ease'],['transition-delay','1s'],['transition-behavior','allow-discrete']];
        for(const [key,value]of values)f.canvas.style.setProperty(key,value,'important');
        await f.runtime.translate(f.canvas);
        const key=property==='remove-duration'?'transition-duration':property;
        const replacement:Record<string,string>={'transition':'opacity 4s linear','transition-property':'transform','transition-duration':'8s','transition-timing-function':'linear','transition-delay':'3s','transition-behavior':'normal'};
        const expected=property==='remove-duration'?'':replacement[key];
        if(property==='remove-duration')f.canvas.style.removeProperty(key);else f.canvas.style.setProperty(key,expected,'important');
        f.runtime.update();expect(f.outputs[0].isConnected).toBe(false);
        for(const [name,value]of values)expect(f.canvas.style.getPropertyValue(name)).toBe(name===key?expected:value);
        expect(f.canvas.style.opacity).toBeUndefined();f.runtime.dispose();
    });
    it.each([false,true])('原无style属性时恢复只移除自己的声明，保留宿主新增样式=%s',async hostWrite=>{
        const f=fixture();f.canvas.style.cssText='';f.canvas.removeAttribute('style');await f.runtime.translate(f.canvas);
        if(hostWrite)f.canvas.style.setProperty('border','2px solid blue');
        f.runtime.restore(f.canvas);expect(f.canvas.hasAttribute('style')).toBe(hostWrite);
        if(hostWrite)expect(f.canvas.style.border).toBe('2px solid blue');
        f.runtime.dispose();
    });
    it('归还租约后重新识别失败或无字时不隐藏源，自定义background/segment source也不借用宿主样式',async()=>{
        const f=fixture();await f.runtime.translate(f.canvas);f.ports.configurationIdentity.mockReturnValue('config-2');
        const pending=deferred<typeof result>();f.ports.translate.mockReturnValueOnce(pending.promise);
        const retry=f.runtime.translate(f.canvas);await flush();expect(f.canvas.style.opacity).not.toBe('0');
        pending.reject(new Error('failed'));await expect(retry).rejects.toThrow('failed');expect(f.canvas.style.opacity).not.toBe('0');
        f.ports.translate.mockResolvedValue({...result,lines:[]});await f.runtime.translate(f.canvas);expect(f.canvas.style.opacity).not.toBe('0');
        const original=f.canvas.outerHTML;f.ports.translate.mockResolvedValue(result);
        const custom=createMangaCanvas({...f.ports,source:{identity:()=> 'shared-image',bounds:()=>f.bounds as DOMRect,capture:async(_element,target)=>{target.width=400;target.height=300;}}});
        await custom.translate(f.canvas);expect(f.canvas.outerHTML).toBe(original);custom.restore(f.canvas);custom.dispose();f.runtime.dispose();
    });
    it.each([
        ['backgroundImage','url(page.png)'],['backgroundColor','rgb(255, 255, 255)'],['backgroundColor','rgba(0, 0, 0, 0.5)'],
        ['boxShadow','0 0 2px red'],['borderTopWidth','1px'],['borderRightWidth','2px'],['borderBottomWidth','1px'],['borderLeftWidth','1px'],
        ['paddingTop','1px'],['paddingRight','1px'],['paddingBottom','1px'],['paddingLeft','1px'],
        ['borderTopLeftRadius','4px'],['borderTopRightRadius','4px'],['borderBottomLeftRadius','4px'],['borderBottomRightRadius','4px'],
        ['objectFit','contain'],['objectFit','cover'],['outlineStyle','solid'],
    ])('源Canvas复杂绘制%s=%s保留原叠层，不隐藏宿主也不继承其opacity',async(property,value)=>{
        const f=fixture();f.styles.set(f.canvas,{[property]:value,outlineWidth:'2px',opacity:'.6'});
        const original=f.canvas.getAttribute('style');await f.runtime.translate(f.canvas);
        expect(f.canvas.getAttribute('style')).toBe(original);expect(f.outputs[0].style.display).toBe('block');expect(f.outputs[0].style.opacity).toBe('1');
        f.runtime.restore(f.canvas);expect(f.canvas.getAttribute('style')).toBe(original);f.runtime.dispose();
    });
    it.each(['source','ancestor'] as const)('所有%s几何、混合或滤镜guard动态复核；恢复简单样式后才重新借用',async level=>{
        const f=fixture(),target=level==='source'?f.canvas:f.canvas.parentElement!;
        await f.runtime.translate(f.canvas);
        for(const [property,value] of Object.entries({transform:'matrix(1,0,0,1,1,0)',translate:'1px',rotate:'1deg',scale:'2',filter:'blur(1px)',backdropFilter:'blur(1px)',maskImage:'url(mask.png)',webkitMaskImage:'url(mask.png)',clipPath:'circle(50%)',perspective:'10px',zoom:'2',clip:'rect(0, 10px, 10px, 0)',mixBlendMode:'multiply'})){
            f.styles.set(target,{[property]:value});f.runtime.update();
            expect(f.canvas.style.opacity,property).not.toBe('0');expect(f.outputs[0].style.display,property).toBe('block');expect(f.outputs[0].style.opacity,property).toBe('1');
            f.styles.delete(target);f.runtime.update();expect(f.canvas.style.opacity,property).toBe('0');
        }
        f.runtime.dispose();
    });
    it('不透明默认CSS可借用，祖先半透明与有背景的分组恢复旧叠层而不复制opacity乘积',async()=>{
        const f=fixture(),parent=f.canvas.parentElement!;
        f.styles.set(f.canvas,{transform:'none',translate:'none',rotate:'none',scale:'none',filter:'none',backdropFilter:'none',maskImage:'none',webkitMaskImage:'none',clipPath:'none',perspective:'none',zoom:'normal',clip:'auto',mixBlendMode:'normal',objectFit:'fill',outlineStyle:'solid',outlineWidth:'0px',backgroundImage:'none',boxShadow:'none',backgroundColor:'rgba(0, 0, 0, 0.0)',paddingTop:'0px',borderTopWidth:'0px'});
        f.styles.set(parent,{backgroundColor:'rgb(128, 64, 0)',opacity:'1'});await f.runtime.translate(f.canvas);
        expect(f.canvas.style.opacity).toBe('0');expect(f.outputs[0].style.opacity).toBe('1');
        f.styles.set(parent,{backgroundColor:'rgb(128, 64, 0)',opacity:'.4'});f.runtime.update();
        expect(f.canvas.style.opacity).not.toBe('0');expect(f.outputs[0].style.display).toBe('block');expect(f.outputs[0].style.opacity).toBe('1');
        f.styles.set(parent,{opacity:'1',zoom:'1'});f.styles.set(f.canvas,{backgroundColor:'transparent',outlineStyle:'none'});f.runtime.update();expect(f.canvas.style.opacity).toBe('0');f.runtime.dispose();
    });
    it.each(['source','ancestor'] as const)('%s动画运行、待启动或API缺失时不借用；暂停和结束动画不改变源像素合同',async level=>{
        const f=fixture(),target=level==='source'?f.canvas:f.canvas.parentElement!;
        await f.runtime.translate(f.canvas);
        for(const animation of [{pending:false,playState:'running'},{pending:true,playState:'idle'}]){
            Object.defineProperty(target,'getAnimations',{configurable:true,value:()=>[animation]});f.runtime.update();expect(f.canvas.style.opacity).not.toBe('0');expect(f.outputs[0].style.display).toBe('block');
        }
        Object.defineProperty(target,'getAnimations',{configurable:true,value:undefined});f.runtime.update();expect(f.canvas.style.opacity).not.toBe('0');
        for(const playState of ['paused','finished']){
            Object.defineProperty(target,'getAnimations',{configurable:true,value:()=>[{pending:false,playState}]});f.runtime.update();expect(f.canvas.style.opacity).toBe('0');
        }
        f.runtime.dispose();
    });
    it.each([null,'','width:400px;height:300px','opacity:.5;transition-property:opacity;transition-duration:2s'])('没有宿主inline改写时精确归还原style属性%s，不保留CSSOM重序列化',async original=>{
        const f=fixture();if(original===null)f.canvas.removeAttribute('style');else f.canvas.setAttribute('style',original);
        await f.runtime.translate(f.canvas);expect(f.canvas.style.opacity).toBe('0');f.runtime.restore(f.canvas);
        expect(f.canvas.getAttribute('style')).toBe(original);f.runtime.dispose();
    });
});


describe('漫画载体的未绘制提示',()=>{
    it.each(['canvas','background'] as const)('%s 在完成、缓存恢复和释放时正确维护提示',async kind=>{
        const f=fixture({retry:()=>false,openSettings:async()=>{},translateUi:text=>`本地化:${text}`});
        f.ports.translate.mockResolvedValueOnce({mangaPatches:{...packet,patches:[]},lines:[{...result.lines[0],renderSkipped:true}]});
        const source=kind==='background'?{identity:()=> 'background',bounds:()=>f.bounds as DOMRect,capture:async(_element:HTMLCanvasElement,target:HTMLCanvasElement)=>{target.width=400;target.height=300;}}:undefined;
        const runtime=kind==='canvas'?f.runtime:createMangaCanvas({...f.ports,readingSnapshots:f.readingSnapshots,source});
        await runtime.translate(f.canvas);
        const warning=()=>f.roots.flatMap(root=>Array.from(root.querySelectorAll<HTMLElement>('.fr-manga-render-warning'))).at(-1);
        expect(warning()?.textContent).toBe('本地化:未绘制');expect(warning()?.title).toBe('本地化:部分译文未绘制，请查看漫画文字');expect(warning()?.hidden).toBe(false);
        if(kind==='canvas'){
            expect(runtime.reuse(f.canvas)).toBe(true);
            expect(f.roots.at(-1)?.lastElementChild).toBe(warning());
        }
        runtime.restore(f.canvas);expect(warning()).toBeUndefined();
        expect(runtime.reuse(f.canvas)).toBe(true);expect(warning()?.hidden).toBe(false);
        expect(f.ports.translate).toHaveBeenCalledOnce();runtime.release(f.canvas);expect(warning()).toBeUndefined();
        runtime.dispose();if(kind==='background')f.runtime.dispose();
    });
});


it('已绘制的画布重复复用后提示仍在画布之上',async()=>{
    const f=fixture();f.ports.translate.mockResolvedValueOnce({...result,lines:[{...result.lines[0],renderSkipped:true}]});
    await f.runtime.translate(f.canvas);expect(f.outputs).toHaveLength(1);
    expect(f.runtime.reuse(f.canvas)).toBe(true);
    const root=f.roots.at(-1)!;expect(root.lastElementChild?.className).toBe('fr-manga-render-warning');
    expect(root.lastElementChild?.previousElementSibling).toBe(f.outputs[0]);f.runtime.dispose();
});


it('纯数字结果显示原图未改动的完成提示，恢复时清理',async()=>{
    const f=fixture();f.ports.translate.mockResolvedValueOnce({mangaPatches:{...packet,patches:[]},lines:[{text:'12:34',bbox:{x0:1,y0:1,x1:20,y1:8},backgroundColor:'transparent'}]});
    await f.runtime.translate(f.canvas);const warning=f.roots.at(-1)?.querySelector('.fr-manga-render-warning');
    expect(warning?.textContent).toBe('已识别');expect(warning?.getAttribute('aria-label')).toBe('已识别文字，原图未改动');expect(warning?.hasAttribute('hidden')).toBe(false);
    f.runtime.restore(f.canvas);expect(warning?.isConnected).toBe(false);f.runtime.dispose();
});


it('未绘制提示隔离点击、指针和按键，避免触发宿主翻页',async()=>{
    const f=fixture();f.ports.translate.mockResolvedValueOnce({...result,lines:[{...result.lines[0],renderSkipped:true}]});
    await f.runtime.translate(f.canvas);const warning=f.roots.at(-1)!.querySelector('.fr-manga-render-warning')!;
    const outside=vi.fn();warning.parentNode!.addEventListener('click',outside);
    for(const type of ['click','pointerdown','keydown','keyup','touchstart','touchmove','touchend','touchcancel']){
        const listener=vi.fn();warning.parentNode!.addEventListener(type,listener);
        const event=new f.window.Event(type,{bubbles:true,cancelable:true});warning.dispatchEvent(event);
        expect(listener).not.toHaveBeenCalled();expect(event.defaultPrevented).toBe(false);
    }
    expect(outside).not.toHaveBeenCalled();f.runtime.dispose();
});


it('可信警示动作打开文字并隔离未可信点击；更新语言和来源后清理旧提示',async()=>{
    const f=fixture({retry:()=>false,openSettings:async()=>{},translateUi:text=>`L:${text}`});
    const openReading=vi.fn();const runtime=createMangaCanvas({...f.ports,openReading});
    f.ports.translate.mockResolvedValue({...result,lines:[{...result.lines[0],renderSkipped:true}]});
    await runtime.translate(f.canvas);const warning=f.roots.at(-1)!.querySelector<HTMLElement>('.fr-manga-render-warning')!;
    const click=(trusted:boolean)=>{const event=new f.window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:trusted});warning.dispatchEvent(event);};
    click(false);expect(openReading).not.toHaveBeenCalled();click(true);expect(openReading).toHaveBeenCalledOnce();
    runtime.refreshLanguage();expect(warning.title).toBe('L:部分译文未绘制，请查看漫画文字');
    f.canvas.dataset.pixel='2';await runtime.translate(f.canvas);expect(warning.isConnected).toBe(false);
    runtime.invalidate(f.canvas);expect(f.roots.at(-1)!.querySelector('.fr-manga-render-warning')).toBeNull();
    runtime.dispose();f.runtime.dispose();
});


it('未配置本地化端口时完成提示的语言刷新保留可访问说明',async()=>{
    const f=fixture();f.ports.translate.mockResolvedValueOnce({mangaPatches:{...packet,patches:[]},lines:[{...result.lines[0]}]});
    await f.runtime.translate(f.canvas);f.runtime.refreshLanguage();
    const warning=f.roots.at(-1)!.querySelector<HTMLElement>('.fr-manga-render-warning')!;
    expect(warning.textContent).toBe('已识别');expect(warning.title).toBe('已识别文字，原图未改动');
    f.runtime.dispose();
});

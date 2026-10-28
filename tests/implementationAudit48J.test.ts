/**
 * @file tests/implementationAudit48J.test.ts
 * 文件职责：审查第 48 批 J 的分享卡片公共算法、渲染与真实客户端工作台生命周期。
 * 主要内容：受控 Canvas/剪贴板/配置/Shadow UI 端口，执行真实生产函数和 SFC 客户端模板，核对水合、外部配置、迟到编码、关闭和导出归属。
 * 模块边界：不访问账号、私有组件状态或复制生产逻辑；Canvas 操作证明不等同于真实 PNG 像素/浏览器证明。
 */
import {parseHTML} from 'linkedom';
import {computed, createRenderer, markRaw, nextTick, reactive, ref, type App} from 'vue';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {normalizeShareCardPreferences, SHARE_CARD_THEMES} from '@/src/core/config/shareCard';
import {cardGraphemes, cardSourceDomain, cleanCardText, validateCardExcerpt, wrapCardText} from '@/src/features/share-card/core';
import {renderShareCard} from '@/src/features/share-card/render';
import {canCopyCardImage, copyCardImage, shareCardFilename} from '@/src/features/share-card/export';

const ports = vi.hoisted(() => ({config: null as any, ready: Promise.resolve(), patch: vi.fn(), create: vi.fn(), notice: vi.fn(), send: vi.fn(), brandOverride: null as {value: string | undefined} | null}));
vi.mock('@/src/services/config/store', () => ({get config() {return ports.config;}, get configReady() {return ports.ready;}, requestConfigPatch: ports.patch}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: ports.send}}}));
vi.mock('@/src/platform/shadow-ui', () => ({createVueShadowUi: ports.create}));
vi.mock('@/src/features/page-notice/public', () => ({showPageNotice: ports.notice}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key === 'common.brand' ? ports.brandOverride?.value ?? translate(key, normalizeUiLanguage(ports.config.uiLanguage)) : key, language: computed(() => normalizeUiLanguage(ports.config.uiLanguage))})}));
let app: App | undefined;
let runtime: typeof import('@/src/features/share-card/public') | undefined;
const resources: Array<() => void> = [];
registerAllUiLanguageBundles();
function deferred<T>() {let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject};}
async function settle() {for(let i=0;i<12;i++){await Promise.resolve();await nextTick();}}
beforeEach(() => {
    ports.brandOverride = ref(undefined);
    ports.config = reactive({on: true, uiLanguage:'en', shareCard:normalizeShareCardPreferences()}); ports.ready = Promise.resolve();
    ports.patch.mockReset().mockImplementation(async ({shareCard}) => {ports.config.shareCard = shareCard;});
    ports.create.mockReset();ports.notice.mockReset();ports.send.mockReset();
});
afterEach(async () => {app?.unmount();app=undefined;runtime?.unmountShareCard();runtime=undefined;await settle();resources.splice(0).forEach(fn=>fn());vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

function canvasPort(doc?: Document) {
    const canvases: any[] = [], painted: any[] = [], operations: any[] = [], encodings: Array<(value: Blob | null) => void> = [];
    let delayed=false, unavailable=false, nullBlob=false, throwBlob=false, fallback=false;
    function create() {
        const canvas: any=doc ? doc.createElement('canvas') : {width:300,height:150};
        const context: any={font:'',direction:'ltr',textAlign:'left', measureText(text:string){operations.push(['measure',text]);return {width:Array.from(text).length * Number(this.font.match(/([\d.]+)px/)?.[1] || 11)*.6};},
            fillText(text:string,x:number,y:number){painted.push({text,x,y,font:this.font,direction:this.direction,align:this.textAlign});},
            createLinearGradient(...args:any[]){operations.push(['linear',...args]);return {addColorStop(...values:any[]){operations.push(['stop',...values]);}};},
            createRadialGradient(...args:any[]){operations.push(['radial',...args]);return {addColorStop(...values:any[]){operations.push(['stop',...values]);}};}};
        for(const key of ['scale','save','restore','beginPath','moveTo','lineTo','bezierCurveTo','closePath','arc','rect','fill','stroke','fillRect','strokeRect']) context[key]=(...args:any[])=>operations.push([key,...args]);
        context.roundRect=fallback ? undefined : (...args:any[])=>operations.push(['roundRect',...args]);
        canvas.getContext=()=>unavailable ? null : context;
        canvas.toBlob=(fn:(value:Blob|null)=>void,type:string)=>{operations.push(['toBlob',type]); if(throwBlob)throw Error('controlled encoding failure');if(delayed)encodings.push(fn);else fn(nullBlob?null:new Blob(['controlled-png'],{type}));};
        canvases.push(canvas);return canvas;
    }
    if (!doc) vi.stubGlobal('document',{createElement:create});
    return {create,canvases,painted,operations,encodings,delay(){delayed=true;},unavailable(){unavailable=true;},nullBlob(){nullBlob=true;},throwBlob(){throwBlob=true;},fallback(){fallback=true;}};
}

describe('audit48 J original public pure rules', () => {
 it('keeps literal content, clean control boundaries, safe URL domain and explicit validation',()=>{
  expect(cleanCardText(' \x00A\r\nB\rC\x7f\t ')).toBe('A\nB\nC');
  expect(cardSourceDomain('https://user:synthetic@www.example.test/private?token=synthetic#x')).toBe('example.test');
  for(const url of ['file:///private/path','javascript:alert(1)','data:text/html,<svg>','broken'])expect(cardSourceDomain(url)).toBe('');
  expect(validateCardExcerpt({original:'x',translation:'\x00',source:''})).toBe('empty');
  expect(validateCardExcerpt({original:'\x00',translation:'x',source:''})).toBe('empty');
  expect(validateCardExcerpt({original:'a'.repeat(2999),translation:'b',source:''})).toBeNull();
  expect(validateCardExcerpt({original:'a'.repeat(3000),translation:'b',source:''})).toBe('long');
 });
 it('retains graphemes, explicit empty paragraphs, oversized glyph and old-environment code points',()=>{
  expect(cardGraphemes('e\u0301👨‍👩‍👧‍👦🇨🇳')).toEqual(['e\u0301','👨‍👩‍👧‍👦','🇨🇳']);
  expect(wrapCardText('\nA\n\nB\n',2,s=>s.length)).toEqual(['A','','B']);
  expect(wrapCardText('a  b',1,s=>s.length)).toEqual(['a','b']);
  expect(wrapCardText('first\n    alphabet',8,s=>s.length)).toEqual(['first','    alph','abet']);
  expect(wrapCardText('🙂',0,s=>s.length)).toEqual(['🙂']);
  expect(wrapCardText('a\u00a0b',1,s=>s.length)).toEqual(['a','b']);
  const saved=Intl.Segmenter;Object.defineProperty(Intl,'Segmenter',{value:undefined,configurable:true});resources.push(()=>Object.defineProperty(Intl,'Segmenter',{value:saved,configurable:true}));
  expect(cardGraphemes('a🙂')).toEqual(['a','🙂']);expect(wrapCardText('abcdefgh',3,s=>s.length)).toEqual(['abc','def','gh']);
 });
 it('wraps repeated whole words without repeated grapheme work',()=>{
  let calls=0;const lines=wrapCardText('alphabet '.repeat(200),15,s=>{calls++;return s.length;});
  expect(lines).toEqual(Array(200).fill('alphabet'));expect(calls).toBeLessThan(1000);
 });
});

describe('audit48 J complete rendering through controlled Canvas port',()=>{
 it('caps the source footer at whole graphemes within the existing UTF16 budget',async()=>{
  const port=canvasPort();
  for(const [source,expected] of [['a'.repeat(159)+'🙂','a'.repeat(159)],['a'.repeat(151)+'👨‍👩‍👧‍👦','a'.repeat(151)],['a'.repeat(149)+'👨‍👩‍👧‍👦','a'.repeat(149)+'👨‍👩‍👧‍👦']]){
   port.painted.length=0;await renderShareCard({original:'x',translation:'y',source},normalizeShareCardPreferences({showBrand:false}));expect(port.painted.slice(2).map(x=>x.text).join('')).toBe(expected);
  }
 });
 it.each(SHARE_CARD_THEMES)('renders %s with columns/alignment/footer and exact literal text',async theme=>{
  const port=canvasPort();const result=await renderShareCard({original:'123 مرحبا',translation:'<svg>',source:'example.test'},normalizeShareCardPreferences({theme,fontSize:'large'}));
  expect(result.width).toBe(960);expect(result.height).toBeGreaterThanOrEqual(450);expect(result.blob.type).toBe('image/png');
  expect(port.painted.map(x=>x.text)).toEqual(['123 مرحبا','<svg>','example.test','流畅阅读']);
  expect(port.painted[0].direction).toBe('rtl');expect(port.painted[0].align).toBe(theme==='sky'||theme==='sunset'?'center':'right');
  expect(port.operations.filter(x=>x[0]==='save')).toHaveLength(1);expect(port.operations.filter(x=>x[0]==='restore')).toHaveLength(1);
 });
 it('keeps fallback panel, translated order, source-only and no footer square contracts',async()=>{
  const port=canvasPort();port.fallback();
  await renderShareCard({original:'original',translation:'translation',source:'source\nsecond'},normalizeShareCardPreferences({theme:'pearl',translationFirst:true,fontSize:'small',showBrand:false}));
  expect(port.operations.some(x=>x[0]==='rect')).toBe(true);expect(port.painted.map(x=>x.text)).toEqual(['translation','original','source','second']);
  port.painted.length=0;const out=await renderShareCard({original:'123',translation:'456',source:'secret'},normalizeShareCardPreferences({format:'square',showSource:false,showBrand:false}));
  expect(out.height).toBe(out.width);expect(port.painted.map(x=>x.text)).toEqual(['123','456']);
 });
 it('rejects empty and length/height/square overflow without truncation or encoding',async()=>{
  const port=canvasPort();
  for(const [value,prefs,reason] of [
   [{original:'',translation:'x',source:''},{},'empty'],[{original:'x',translation:'x'.repeat(3000),source:''},{},'long'],
   [{original:'x\n'.repeat(100),translation:'x',source:''},{},'long'],
   [{original:'字'.repeat(600),translation:'文'.repeat(600),source:''},{format:'square'},'square'],
  ] as const) await expect(renderShareCard(value,normalizeShareCardPreferences(prefs))).rejects.toMatchObject({reason});
  expect(port.operations.some(x=>x[0]==='toBlob')).toBe(false);
 });
 it('shrinks square font to a fitting size and cleans null or throwing encoder resources',async()=>{
  const port=canvasPort();await renderShareCard({original:'x\n'.repeat(9),translation:'y\n'.repeat(3),source:''},normalizeShareCardPreferences({format:'square',fontSize:'large'}));
  expect(port.painted[0].font).not.toContain('32px');
  port.nullBlob();await expect(renderShareCard({original:'x',translation:'y',source:''},normalizeShareCardPreferences())).rejects.toMatchObject({reason:'canvas'});
  expect(port.canvases.at(-1).width).toBe(0);
  port.throwBlob();await expect(renderShareCard({original:'x',translation:'y',source:''},normalizeShareCardPreferences())).rejects.toThrow('controlled encoding failure');expect(port.canvases.at(-1).height).toBe(0);
  port.unavailable();await expect(renderShareCard({original:'x',translation:'y',source:''},normalizeShareCardPreferences())).rejects.toMatchObject({reason:'canvas'});
 });
 it('aborts before allocation and during pending encoding, detaches abort listener and ignores late callback',async()=>{
  const port=canvasPort(),early=new AbortController();early.abort();await expect(renderShareCard({original:'x',translation:'y',source:''},normalizeShareCardPreferences(),early.signal)).rejects.toMatchObject({name:'AbortError'});expect(port.canvases).toHaveLength(0);
  port.delay();const ctl=new AbortController(),remove=vi.spyOn(ctl.signal,'removeEventListener');
  const output=renderShareCard({original:'x',translation:'y',source:''},normalizeShareCardPreferences(),ctl.signal);const rejected=expect(output).rejects.toMatchObject({name:'AbortError'});ctl.abort();await rejected;
  expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(port.canvases[0].width).toBe(0);port.encodings[0](new Blob(['late']));await settle();expect(port.canvases[0].height).toBe(0);
 });
 it('detaches cancellation after successful encoding with an active signal',async()=>{
  canvasPort();const ctl=new AbortController(),remove=vi.spyOn(ctl.signal,'removeEventListener');const output=await renderShareCard({original:'x',translation:'y',source:''},normalizeShareCardPreferences(),ctl.signal);expect(output.width).toBe(960);expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));ctl.abort();expect(output.canvas.width).toBe(960);
 });
});

describe('audit48 J export public port',()=>{
 it('only writes supplied PNG once per call and reports capability/rejection',async()=>{
  vi.stubGlobal('navigator',{});vi.stubGlobal('ClipboardItem',undefined);const blob=new Blob(['port'],{type:'image/png'});
  expect(canCopyCardImage()).toBe(false);await expect(copyCardImage(blob)).rejects.toThrow('clipboard-unavailable');
  vi.stubGlobal('ClipboardItem',class {constructor(public items:any){}});expect(canCopyCardImage()).toBe(false);
  const write=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{write}});await copyCardImage(blob);expect(write).toHaveBeenCalledOnce();expect(write.mock.calls[0][0][0].items['image/png']).toBe(blob);
  write.mockRejectedValue(Error('denied'));await expect(copyCardImage(blob)).rejects.toThrow('denied');vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));expect(shareCardFilename()).toBe('FluentRead-2026-10-06.png');
 });
});

async function client(copyAvailable=true) {
 vi.useFakeTimers();
 const parsed=parseHTML('<html><body><p id="host">Original host &lt;script&gt;literal&lt;/script&gt;</p><div id="mount"></div></body></html>');
 const doc=parsed.document as unknown as Document,win=parsed.window;
 vi.stubGlobal('document',doc);vi.stubGlobal('window',win);for(const key of ['Node','Element','HTMLElement','SVGElement'])vi.stubGlobal(key,(win as any)[key]);
 vi.stubGlobal('location',{href:'https://user:synthetic@www.example.test/private?key=synthetic#private'});
 const write=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:copyAvailable?{write}:{}});vi.stubGlobal('ClipboardItem',copyAvailable?class {constructor(public items:any){}}:undefined);
 const urls=new Set<string>(), revoked:string[]=[], created:Blob[]=[], downloads:any[]=[];
 vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{created.push(blob as Blob);const url=`blob:controlled-${created.length}`;urls.add(url);return url;});
 vi.spyOn(URL,'revokeObjectURL').mockImplementation(url=>{revoked.push(url);urls.delete(url);});
 const port=canvasPort(doc), nativeCreate=doc.createElement.bind(doc);
 vi.spyOn(doc,'createElement').mockImplementation(((tag:string,...args:any[])=>{
  if(tag==='canvas') return port.create();
  const node:any=nativeCreate(tag,...args);
  if(tag==='dialog') {node.open=false;node.showModal=vi.fn(()=>{node.open=true;});node.close=()=>{if(node.open){node.open=false;node.dispatchEvent(new win.Event('close'));}};}
  if(tag==='a') node.click=()=>{downloads.push({href:node.href,download:node.download});};
  return node;
 }) as any);
 // Canvas creation uses the original document factory, while production document.createElement uses the controlled port.
 const savedPortCreate=port.create;
 port.create=()=>{const restore=(doc.createElement as any).getMockImplementation();(doc.createElement as any).mockImplementation(nativeCreate);try{return savedPortCreate();}finally{(doc.createElement as any).mockImplementation(restore);}};
 const handlers=new WeakMap<Element,Record<string,any>>();
 const renderer=createRenderer<any,any>({createElement:tag=>markRaw(doc.createElement(tag)),createText:text=>doc.createTextNode(text),createComment:text=>doc.createComment(text),
 insert:(node,parent,anchor)=>parent.insertBefore(node,anchor||null),remove:node=>node.remove(),setText:(node,text)=>{node.nodeValue=text;},setElementText:(node,text)=>{node.textContent=text;},parentNode:node=>node.parentNode,nextSibling:node=>node.nextSibling,setScopeId:(node,id)=>node.setAttribute(id,''),
 patchProp(node,key,_old,value){
  if(key.startsWith('on')){const bucket=handlers.get(node)||{};bucket[key]=value;handlers.set(node,bucket);}
  else if(key==='style'){if(typeof value==='string')node.setAttribute('style',value);else Object.assign(node.style,value||{});}
  else if(key==='value'||key==='checked')node[key]=value;
  else if(key.startsWith('aria-'))node.setAttribute(key,String(value));
  else if(value===false||value==null)node.removeAttribute(key);else node.setAttribute(key,value===true?'':String(value));
 },insertStaticContent(html,parent,anchor){const box=nativeCreate('div');box.innerHTML=html;const first=box.firstChild!,last=box.lastChild!;while(box.firstChild)parent.insertBefore(box.firstChild,anchor||null);return [first,last];}});
 const component=(await import('@/src/features/share-card/ui/ShareCardStudio.vue')).default;
 expect((component as any).render).toBeTypeOf('function');app=renderer.createApp(component);const studio=app.mount(doc.querySelector('#mount')!) as unknown as {open(value:any):Promise<void>;close():void};
 function event(selector:string,key='onClick',extra:any={}){const target=doc.querySelector(selector)!;expect(target).toBeTruthy();const fn=handlers.get(target)?.[key];expect(fn).toBeTypeOf('function');return fn({target,currentTarget:target,stopPropagation(){},preventDefault(){},...extra});}
 function input(selector:string,value:string,index=0){const target:any=doc.querySelectorAll(selector)[index]!;target.value=value;target.dispatchEvent(new win.Event('input',{bubbles:true}));}
 async function paint(){await settle();await vi.advanceTimersByTimeAsync(100);await settle();}
 const source={original:'literal <img src=x onerror=alert(1)>',translation:'字面内容',source:'example.test'};
 return {doc,win,studio,port,write,urls,revoked,created,downloads,event,input,paint,source};
}

describe('audit48 J actual ShareCardStudio client template and public runtime',()=>{
 it('品牌通过实际工作台传入，语言和同语言资源迟到均重绘而保留摘录',async()=>{
  ports.config.uiLanguage='zh-CN';const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();
  const first=ctx.port.canvases.at(-1),firstSize=[first.width,first.height],originalText=ctx.source.original;
  expect(ctx.port.painted.at(-1).text).toBe('流畅阅读');expect(ctx.port.painted.map(x=>x.text).join(' ')).toContain(originalText);
  ports.brandOverride!.value='流畅阅读';ports.config.uiLanguage='en-US';await ctx.paint();
  expect(ctx.port.painted.at(-1).text).toBe('流畅阅读');
  const beforeResource=ctx.port.canvases.length;
  ports.brandOverride!.value='FluentRead';await ctx.paint();
  expect(ctx.port.canvases.length).toBeGreaterThan(beforeResource);expect(ctx.port.painted.at(-1).text).toBe('FluentRead');
  const foreign=ctx.port.canvases.at(-1);expect([foreign.width,foreign.height]).toEqual(firstSize);
  expect(ctx.port.painted.map(x=>x.text).join(' ')).toContain(originalText);
  ports.brandOverride!.value=undefined;ports.config.uiLanguage='zh-CN';await ctx.paint();
  expect(ctx.port.painted.at(-1).text).toBe('流畅阅读');
  ctx.studio.close();await settle();expect(ctx.urls.size).toBe(0);
 });
 it('waits for config hydration before opening with persisted appearance and preserves the host',async()=>{
  const ready=deferred<void>();ports.ready=ready.promise;const ctx=await client();const opened=ctx.studio.open(ctx.source);await settle();
  expect(ctx.doc.querySelector('dialog')?.hasAttribute('open')).toBe(false);expect(ctx.doc.querySelector('[data-theme]')).toBeNull();
  ports.config.shareCard=normalizeShareCardPreferences({theme:'linen',fontSize:'large'});ready.resolve();await opened;await ctx.paint();
  expect(ctx.doc.querySelector('[data-theme="linen"]')?.getAttribute('aria-pressed')).toBe('true');expect(ctx.doc.querySelector('#host')?.textContent).toBe('Original host <script>literal</script>');
  expect(ctx.port.painted.map(x=>x.text).join(' ')).toContain(ctx.source.original);expect(ctx.doc.querySelector('img')).toBeNull();
 });
 it('cancels a pending open on close or component removal before hydration',async()=>{
  const ready=deferred<void>();ports.ready=ready.promise;const ctx=await client();const opened=ctx.studio.open(ctx.source);ctx.studio.close();ready.resolve();await opened;await ctx.paint();expect(ctx.doc.querySelector('[data-theme]')).toBeNull();expect(ctx.created).toHaveLength(0);
  const next=deferred<void>();ports.ready=next.promise;const second=ctx.studio.open(ctx.source);app!.unmount();app=undefined;next.resolve();await second;await settle();expect(ctx.created).toHaveLength(0);
 });
 it('applies external appearance updates and merges queued edits against latest authority',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();const gate=deferred<void>();
  ports.patch.mockImplementationOnce(async ()=>{await gate.promise;ports.config.shareCard=normalizeShareCardPreferences({theme:'sky',showBrand:false,translationFirst:true});});
  ctx.event('[data-theme="sky"]');await settle();ctx.event('[data-theme="moss"]');
  ports.config.shareCard=normalizeShareCardPreferences({theme:'prism',showBrand:false,translationFirst:true});await settle();
  expect(ctx.doc.querySelector('[data-theme="moss"]')?.getAttribute('aria-pressed')).toBe('true');
  // The controlled store sends its first authoritative reply; the second queued patch must read that latest snapshot.
  gate.resolve();await settle();await ctx.paint();expect(ports.patch.mock.calls.at(-1)![0].shareCard).toMatchObject({theme:'moss',showBrand:false,translationFirst:true});
  ports.config.shareCard=normalizeShareCardPreferences({theme:'blueprint',fontSize:'small',showSource:false});await ctx.paint();expect(ctx.doc.querySelector('[data-theme="blueprint"]')?.getAttribute('aria-pressed')).toBe('true');expect(ctx.doc.querySelector('.fr-card-source')).toBeNull();
 });
 it('edits through actual textarea/switch/size/format controls, rejects invalid content and renders retry',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();
  ctx.event('[data-font-size="small"]');ctx.event('[data-format="square"]');ctx.event('[data-setting="showBrand"]','onChange',{target:{checked:false}});ctx.event('.fr-card-edit','onToggle',{target:{open:true}});await ctx.paint();
  expect(ctx.doc.querySelector('[data-font-size="small"]')?.getAttribute('aria-pressed')).toBe('true');expect(ctx.doc.querySelector('[data-format="square"]')?.getAttribute('aria-pressed')).toBe('true');
  ctx.input('textarea','');await ctx.paint();expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent).toContain('shareCard.error.empty');expect(ctx.doc.querySelector('.fr-card-primary')?.hasAttribute('disabled')).toBe(true);
  ctx.input('textarea','recovered');await ctx.paint();expect(ctx.doc.querySelector('canvas')?.getAttribute('role')).toBe('img');expect(ctx.doc.querySelector('.fr-card-primary')?.hasAttribute('disabled')).toBe(false);
  ctx.event('.fr-card-close');await settle();expect(ctx.urls.size).toBe(0);expect(ctx.doc.querySelector('textarea')).toBeNull();
 });
 it('releases previous Canvas/URL and aborts late encoding after edit, close and reopen',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();const original=ctx.port.canvases[0];ctx.port.delay();
  ctx.input('textarea','first edit');await ctx.paint();expect(ctx.doc.querySelector('.fr-card-primary')?.hasAttribute('disabled')).toBe(true);
  const stale=ctx.port.canvases.at(-1);ctx.input('textarea','second edit');await ctx.paint();expect(stale.width).toBe(0);
  const newest=ctx.port.canvases.at(-1);ctx.port.encodings[0](new Blob(['stale']));await settle();expect(ctx.created).toHaveLength(1);
  ctx.port.encodings[1](new Blob(['new']));await settle();expect(original.width).toBe(0);expect(ctx.revoked).toEqual(['blob:controlled-1']);expect(ctx.urls.size).toBe(1);
  ctx.input('textarea','late after close');await ctx.paint();const late=ctx.port.canvases.at(-1);ctx.event('dialog','onCancel');await settle();expect(newest.width).toBe(0);expect(late.width).toBe(0);expect(ctx.urls.size).toBe(0);
  await ctx.studio.open({...ctx.source,original:'reopened'});await ctx.paint();ctx.port.encodings[2](new Blob(['late close']));await settle();expect(ctx.urls.size).toBe(0);
  ctx.port.encodings[3](new Blob(['current']));await settle();expect(ctx.urls.size).toBe(1);app!.unmount();app=undefined;await settle();expect(ctx.urls.size).toBe(0);await vi.runOnlyPendingTimersAsync();expect(vi.getTimerCount()).toBe(0);
 });
 it('locks synchronous double save/copy and ignores copy completion after reopen',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();
  const save=ctx.event('.fr-card-primary');ctx.event('.fr-card-primary');await save;expect(ctx.downloads).toHaveLength(1);expect(ctx.downloads[0].href).toBe('blob:controlled-1');expect(ctx.doc.querySelector('a')).toBeNull();
  await vi.advanceTimersByTimeAsync(200);ctx.event('.fr-card-primary');expect(ctx.downloads).toHaveLength(1);await vi.advanceTimersByTimeAsync(200);await settle();
  const copy=deferred<void>();ctx.write.mockReturnValueOnce(copy.promise);const first=ctx.event('[data-action="copy"]');ctx.event('[data-action="copy"]');expect(ctx.write).toHaveBeenCalledOnce();
  ctx.studio.close();await ctx.studio.open({...ctx.source,original:'next'});await ctx.paint();copy.resolve();await first;await settle();expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent || '').not.toContain('shareCard.copied');
  await ctx.event('[data-action="copy"]');await settle();expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent).toContain('shareCard.copied');
  ctx.write.mockRejectedValueOnce(Error('denied'));await ctx.event('[data-action="copy"]');await settle();expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent).toContain('shareCard.copyFailed');expect(ctx.downloads).toHaveLength(1);
 });
 it('shows clipboard fallback and preference/save/render failures with retry controls',async()=>{
  const ctx=await client(false);await ctx.studio.open(ctx.source);await ctx.paint();expect(ctx.doc.querySelector('[data-action="copy"]')?.hasAttribute('disabled')).toBe(true);expect(ctx.doc.querySelector('.fr-card-fallback')?.textContent).toContain('shareCard.copyUnavailable');
  ports.patch.mockRejectedValueOnce(Error('controlled rejection'));ctx.event('[data-theme="sky"]');await settle();expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent).toContain('shareCard.preferenceFailed');await ctx.paint();
  const create=(ctx.doc.createElement as any).getMockImplementation();vi.spyOn(ctx.doc,'createElement').mockImplementation(((tag:string)=>{const node:any=create(tag);if(tag==='a')node.click=()=>{throw Error('blocked download');};return node;}) as any);
  await ctx.event('.fr-card-primary');await settle();expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent).toContain('shareCard.saveFailed');expect(ctx.doc.querySelector('a')).toBeNull();
 });
 it('下载节点清理失败时真实组件仍反馈成功并允许再次保存',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();
  const create=(ctx.doc.createElement as any).getMockImplementation();let first=true;const remove=vi.fn(()=>{throw Error('remove failed');});
  vi.spyOn(ctx.doc,'createElement').mockImplementation(((tag:string)=>{const node:any=create(tag);if(tag==='a'&&first){first=false;const click=node.click;node.click=()=>{click();node.remove=remove;};}return node;}) as any);
  await ctx.event('.fr-card-primary');await settle();
  expect(remove).toHaveBeenCalledOnce();expect(ctx.downloads).toHaveLength(1);expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent).toContain('shareCard.saved');
  await vi.advanceTimersByTimeAsync(401);await ctx.event('.fr-card-primary');await settle();expect(ctx.downloads).toHaveLength(2);
 });
 it('opens through public runtime with actual client, safe source and late disable/invalidation cleanup',async()=>{
  const ctx=await client();runtime=await import('@/src/features/share-card/public');
  ports.create.mockImplementation(async (_context,options)=>{expect(options.mode).toBe('closed');return {mounted:{instance:ctx.studio},remove(){app?.unmount();app=undefined;}};});
  const context:any={isInvalid:false};runtime.mountShareCard(context);runtime.mountShareCard(context);expect(runtime.isShareCardMounted()).toBe(true);await runtime.openShareCard(ctx.source);await ctx.paint();expect(ctx.doc.querySelector('.fr-card-source input')?.getAttribute('value')|| (ctx.doc.querySelector('.fr-card-source input') as any)?.value).toBe('example.test');
  runtime.unmountShareCard();expect(ctx.urls.size).toBe(0);expect(runtime.isShareCardMounted()).toBe(false);
 });
 it.each(['disabled','invalid','unmounted'])('drops late public shadow creation after %s',async mode=>{
  const ctx=await client();runtime=await import('@/src/features/share-card/public');const context:any={isInvalid:false};const gate=deferred<any>(),remove=vi.fn(),open=vi.fn();ports.create.mockReturnValueOnce(gate.promise);runtime.mountShareCard(context);const task=runtime.openShareCard(ctx.source);
  if(mode==='disabled')ports.config.on=false;else if(mode==='invalid')context.isInvalid=true;else runtime.unmountShareCard();
  gate.resolve({mounted:{instance:{open}},remove});await task;expect(open).not.toHaveBeenCalled();expect(remove).toHaveBeenCalledOnce();expect(ports.notice).not.toHaveBeenCalled();
 });
 it('handles empty/stopped public requests, creation failure, reusable UI and missing instance',async()=>{
  const ctx=await client();runtime=await import('@/src/features/share-card/public');await runtime.openShareCard(ctx.source);expect(ports.create).not.toHaveBeenCalled();runtime.mountShareCard({isInvalid:true} as any);expect(runtime.isShareCardMounted()).toBe(false);runtime.mountShareCard({isInvalid:false} as any);
  await runtime.openShareCard({...ctx.source,original:' '});await runtime.openShareCard({...ctx.source,translation:' '});ports.config.on=false;await runtime.openShareCard(ctx.source);expect(ports.create).not.toHaveBeenCalled();ports.config.on=true;
  ports.create.mockRejectedValueOnce(Error('creation'));await runtime.openShareCard(ctx.source);expect(ports.notice).toHaveBeenCalledOnce();ports.create.mockResolvedValueOnce({remove:vi.fn()});await runtime.openShareCard(ctx.source);await runtime.openShareCard(ctx.source);expect(ports.create).toHaveBeenCalledTimes(2);
 });
});

describe('audit48 J public lifecycle races and remaining real template actions',()=>{
 it('isolates the actual template pointer, wheel and keyboard handlers from the host',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();
  for(const [selector,key] of [['.fr-card-root','onPointerdown'],['.fr-card-root','onPointerup'],['.fr-card-root','onClick'],['.fr-card-root','onWheelPassive'],['dialog','onKeydown'],['dialog','onPointerdown'],['dialog','onClick']]){
   const stopPropagation=vi.fn();ctx.event(selector,key,{stopPropagation});expect(stopPropagation).toHaveBeenCalledOnce();
  }
  expect(ctx.doc.querySelector('#host')?.textContent).toBe('Original host <script>literal</script>');expect(ctx.doc.querySelector('[data-theme="coral"]')?.getAttribute('aria-pressed')).toBe('true');
 });
 it('edits source/translation literally and reports generic encoding errors',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();
  ctx.input('.fr-card-source input','javascript:literal <script>');ctx.input('textarea','replacement <svg>',1);await ctx.paint();
  expect(ctx.port.painted.map(x=>x.text).join(' ')).toContain('javascript:literal <script>');expect(ctx.doc.querySelector('script')).toBeNull();
  expect(ctx.port.painted.map(x=>x.text).join(' ')).toContain('replacement <svg>');
  ctx.port.throwBlob();ctx.input('textarea','forces encoder failure');await ctx.paint();expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent).toContain('shareCard.error.canvas');expect(ctx.port.canvases.at(-1).width).toBe(0);
 });
 it('replaces an open studio and frees an already-resolved encoding discarded before its continuation',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();await ctx.studio.open({...ctx.source,original:'latest opening'});await ctx.paint();expect(ctx.port.canvases[0].width).toBe(0);
  ctx.port.delay();ctx.input('textarea','pending bitmap');await ctx.paint();const bitmap=ctx.port.canvases.at(-1);ctx.port.encodings[0](new Blob(['resolved']));ctx.studio.close();await settle();expect(bitmap.width).toBe(0);expect(ctx.urls.size).toBe(0);expect(ctx.created).toHaveLength(2);
 });
 it('does not show a modal when closed between hydration and template nextTick',async()=>{
  const ctx=await client();const opening=ctx.studio.open(ctx.source);await Promise.resolve();ctx.studio.close();await opening;await ctx.paint();expect(ctx.created).toHaveLength(0);expect(ctx.doc.querySelector('[data-theme]')).toBeNull();
 });
 it('keeps preference/copy rejection from changing a later studio session',async()=>{
  const ctx=await client();await ctx.studio.open(ctx.source);await ctx.paint();const pref=deferred<void>(),copy=deferred<void>();ports.patch.mockReturnValueOnce(pref.promise);ctx.event('[data-theme="sky"]');await settle();ctx.write.mockReturnValueOnce(copy.promise);await ctx.paint();const copying=ctx.event('[data-action="copy"]');ctx.studio.close();await ctx.studio.open(ctx.source);pref.reject(Error('late preference'));copy.reject(Error('late clipboard'));await copying;await settle();await ctx.paint();
  expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent||'').not.toContain('shareCard.preferenceFailed');expect(ctx.doc.querySelector('.fr-card-feedback')?.textContent||'').not.toContain('shareCard.copyFailed');
 });
 it('skips creation when the context invalidates after mounting but before an open',async()=>{
  await client();runtime=await import('@/src/features/share-card/public');const context:any={isInvalid:false};runtime.mountShareCard(context);context.isInvalid=true;await runtime.openShareCard({original:'x',translation:'y'});expect(ports.create).not.toHaveBeenCalled();expect(ports.notice).not.toHaveBeenCalled();
 });
});

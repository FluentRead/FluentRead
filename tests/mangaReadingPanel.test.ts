import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import type {MangaReadingCandidate, MangaReadingResult} from '@/src/features/image-translation/content/mangaReadingCoordinator';
import type {MangaReadingLine} from '@/src/features/image-translation/content/mangaReadingSnapshots';
import {translateLegacyText} from '@/src/core/i18n';
import {mangaReadingLegacyMessages} from '@/src/core/i18n/messages/manga';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
const vue = createRequire(import.meta.url)('vue') as typeof import('vue');
let component: any, dispose: (() => void) | undefined;
beforeAll(async () => {component = (await import('@/src/features/image-translation/ui/MangaReadingPanel.vue')).default;});
afterEach(() => {dispose?.();dispose = undefined;});
interface Node {tag:string; text:string; props:Record<string,any>;children:Node[];parent:Node|null;isConnected:boolean;focus:ReturnType<typeof vi.fn>;getRootNode:()=>{activeElement:Node|null};contains:(value:Node)=>boolean}
let active:Node|null = null;
const node = (tag:string,text=''):Node => {
  const value:Node = {tag,text,props:{},children:[],parent:null,isConnected:true,focus:vi.fn(() => {active = value;}),getRootNode:()=>({get activeElement(){return active;}}),contains:(child) => {for(let current:Node|null=child;current;current=current.parent)if(current===value)return true;return false;}};
  return value;
};
function focusedTrigger() {
  const trigger=node('trigger'), document={get activeElement(){return active;},body:node('body'),documentElement:node('html')};
  Object.assign(trigger,{ownerDocument:document,getRootNode:()=>document,matches:()=>false,getClientRects:()=>[{}]});active=trigger;return trigger;
}
function find(root:Node,predicate:(node:Node)=>boolean):Node|undefined {if(predicate(root))return root;for(const child of root.children){const result=find(child,predicate);if(result)return result;}}
function deferred<T>() {let resolve!:(value:T)=>void, reject!:(reason:unknown)=>void;const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const trusted = {isTrusted:true} as MouseEvent;
const line = (text:string,sourceText?:string):MangaReadingLine => ({text,bbox:{x0:0,y0:0,x1:10,y1:10},...(sourceText===undefined?{}:{sourceText})});
const targets:MangaReadingCandidate[] = [
  {kind:'image',ordinal:1,token:{}}, {kind:'canvas',ordinal:2,token:{}},
  {kind:'background',ordinal:3,token:{}}, {kind:'segment',ordinal:4,token:{},segment:{top:2048,height:1024}},
];
async function mount(theme:'light'|'dark' = 'light') {
  active=null;
  const props = {theme,onOpened:vi.fn(),onClosed:vi.fn(),list:vi.fn(()=>({status:'ready',items:targets} as const)),read:vi.fn(async (_token:object,_signal:AbortSignal):Promise<MangaReadingResult>=>({status:'ready',lines:[line('译文','原文')]})),observe:vi.fn((_token:object,_invalid:()=>void):(()=>void)|undefined=>()=>{}),copy:vi.fn(async (_text:string)=>{}),translate:vi.fn((text:string)=>text)};
  const remove=(value:Node)=>{if(value.parent){const i=value.parent.children.indexOf(value);if(i>=0)value.parent.children.splice(i,1);value.parent=null;}};
  const renderer=vue.createRenderer<Node,Node>({patchProp:(value,key,_old,next)=>{value.props[key]=next;},insert:(value,parent,anchor)=>{remove(value);const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,value);value.parent=parent;},remove,createElement:tag=>node(tag),createText:text=>node('#text',text),createComment:text=>node('#comment',text),setText:(value,text)=>{value.text=text;},setElementText:(value,text)=>{value.text=text;value.children=[];},parentNode:value=>value.parent,nextSibling:value=>value.parent?.children[value.parent.children.indexOf(value)+1]??null,querySelector:()=>null,setScopeId:()=>{},insertStaticContent:()=>{throw Error('unexpected static content');}});
  let instance:any, panel:any;const root=node('root');const app=renderer.createApp({setup:()=>()=>vue.h(component,{...props,ref:(value:any)=>{if(value){instance=value;panel=value.$.setupState;}}})});
  app.provide(vue.ssrContextKey,{modules:new Set()});app.mount(root);dispose=()=>app.unmount();await vue.nextTick();
  const get=(predicate:(node:Node)=>boolean)=>find(root,predicate), button=(text:string)=>get(value=>value.tag==='button' && value.text===text);
  const tick=async()=>{await vue.nextTick();await Promise.resolve();await vue.nextTick();};
  return {props,instance,panel,root,get,button,tick};
}

describe('standalone manga reading panel prototype',()=>{
  it('requires an explicit trusted open and exposes distinguishable candidates without reading them',async()=>{
    const h=await mount();expect(h.props.list).not.toHaveBeenCalled();expect(await h.instance.open({isTrusted:false})).toBe(false);expect(h.props.list).not.toHaveBeenCalled();
    await h.instance.open(trusted,focusedTrigger());await h.tick();expect(h.props.onOpened).toHaveBeenCalledOnce();expect(h.props.list).toHaveBeenCalledOnce();expect(h.props.read).not.toHaveBeenCalled();
    for(const text of ['图片 1','画布 2','背景图片 3','长图片段 4 · 像素位置 2048–3072'])expect(h.button(text)).toBeDefined();
    expect(h.get(n=>n.props.role==='dialog')?.props['aria-label']).toBe('漫画文字');expect(active).toBe(h.get(n=>n.props.role==='dialog'));
  });
  it.each(targets)('reads the original token for $kind only after user selection',async item=>{
    const h=await mount();await h.instance.open(trusted);const button=h.get(n=>n.tag==='button' && n.text.startsWith(({image:'图片',canvas:'画布',background:'背景图片',segment:'长图片段'} as const)[item.kind]))!;
    button.props.onClick({isTrusted:false});expect(h.props.read).not.toHaveBeenCalled();button.props.onClick(trusted);await h.tick();
    expect(h.props.read.mock.calls[0][0]).toBe(item.token);expect(h.panel.status).toBe('ready');expect(h.get(n=>n.tag==='pre'&&n.text==='译文')).toBeDefined();
    expect(h.get(n=>n.text==='此片段可能包含相邻片段的文字') !== undefined).toBe(item.kind==='segment');
    expect(h.get(n=>n.text==='画布文字来自最近完成的翻译快照，画面变化可能尚未同步') !== undefined).toBe(item.kind==='canvas');
  });
  it('shows and copies the warning with uncertain alternative numbers',async()=>{
    const h=await mount();h.props.read.mockResolvedValueOnce({status:'ready',lines:[{...line('08:45'),numericUncertain:true},{...line('12:34'),numericUncertain:true}]});
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();
    expect(h.get(n=>n.text==='数字识别可能有误，请对照原图')).toBeDefined();
    h.button('复制全部')!.props.onClick(trusted);await h.tick();
    expect(h.props.copy).toHaveBeenCalledWith('08:45\n数字识别可能有误，请对照原图\n\n12:34\n数字识别可能有误，请对照原图');
  });
  it('identifies translations withheld from the image',async()=>{
    const h=await mount();h.props.read.mockResolvedValueOnce({status:'ready',lines:[{...line('译文'),renderSkipped:true}]});
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();
    expect(h.get(n=>n.text==='为保护数字，此译文未绘制到图片')).toBeDefined();
  });
  it('rejects oversize content completely and paginates complete lines without truncation',async()=>{
    const h=await mount();h.props.read.mockResolvedValueOnce({status:'ready',lines:[line('x'.repeat(16001))]}).mockResolvedValueOnce({status:'ready',lines:Array.from({length:40},(_,i)=>line(`行 ${i}`))});
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();expect(h.panel.status).toBe('overBudget');expect(h.get(n=>n.tag==='pre')).toBeUndefined();
    h.button('选择其他页面')!.props.onClick(trusted);await h.tick();h.button('图片 1')!.props.onClick(trusted);await h.tick();expect(h.panel.pages).toHaveLength(2);expect(h.panel.pages.flat().map((x:MangaReadingLine)=>x.text)).toEqual(Array.from({length:40},(_,i)=>`行 ${i}`));
    h.button('下一部分')!.props.onClick(trusted);await h.tick();h.button('复制当前部分')!.props.onClick(trusted);await h.tick();expect(h.props.copy.mock.calls[0][0]).toBe(Array.from({length:8},(_,i)=>`行 ${i+32}`).join('\n\n'));
    h.button('复制全部')!.props.onClick(trusted);await h.tick();expect(h.props.copy.mock.calls[1][0]).toBe(Array.from({length:40},(_,i)=>`行 ${i}`).join('\n\n'));
  });
  it.each(['empty','pending','error','unavailable','stale','cancelled','overBudget'] as const)('displays %s without starting another read',async status=>{
    const h=await mount();h.props.read.mockResolvedValueOnce({status});await h.instance.open(trusted);h.button('画布 2')!.props.onClick(trusted);await h.tick();expect(h.panel.status).toBe(status);expect(h.props.read).toHaveBeenCalledOnce();expect(h.get(n=>n.props.role==='status')).toBeDefined();
  });
  it.each(['close','invalidate','unmount'] as const)('aborts and ignores late read after %s',async action=>{
    const h=await mount(), pending=deferred<MangaReadingResult>();h.props.read.mockReturnValueOnce(pending.promise);await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);const signal=h.props.read.mock.calls[0][1];
    if(action==='unmount'){dispose?.();dispose=undefined;}else h.instance[action]();expect(signal.aborted).toBe(true);pending.resolve({status:'ready',lines:[line('迟到内容')]});await h.tick();expect(h.get(n=>n.text==='迟到内容')).toBeUndefined();
  });
  it('does not let an older selection overwrite a newer selection',async()=>{
    const h=await mount(), first=deferred<MangaReadingResult>(), second=deferred<MangaReadingResult>();h.props.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);const signal=h.props.read.mock.calls[0][1];await h.tick();h.button('选择其他页面')!.props.onClick(trusted);await h.tick();h.button('画布 2')!.props.onClick(trusted);expect(signal.aborted).toBe(true);
    first.resolve({status:'ready',lines:[line('旧')]});second.resolve({status:'ready',lines:[line('新')]});await h.tick();expect(h.get(n=>n.text==='旧')).toBeUndefined();expect(h.get(n=>n.text==='新')).toBeDefined();
  });
  it('compares and copies only from a trusted action, retaining failed-copy feedback and ignoring late results after close',async()=>{
    const h=await mount();await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();h.button('原文对照')!.props.onClick();await h.tick();expect(h.get(n=>n.tag==='pre'&&n.text==='原文')).toBeDefined();
    h.button('复制全部')!.props.onClick({isTrusted:false});expect(h.props.copy).not.toHaveBeenCalled();h.props.copy.mockRejectedValueOnce(Error('denied'));h.button('复制全部')!.props.onClick(trusted);await h.tick();expect(h.props.copy).toHaveBeenCalledWith('原文\n译文');expect(h.panel.feedback).toContain('复制失败');
    const wait=deferred<void>();h.props.copy.mockReturnValueOnce(wait.promise);h.button('复制全部')!.props.onClick(trusted);h.instance.close();wait.resolve();await h.tick();expect(h.panel.feedback).toBe('');
  });
  it('restores focus only to a connected visible trigger while panel owns focus',async()=>{
    const h=await mount(), trigger=focusedTrigger(),focus=trigger.focus;await h.instance.open(trusted,trigger);h.instance.close();expect(h.props.onClosed).toHaveBeenCalledOnce();expect(focus).toHaveBeenCalledOnce();
    active=trigger;await h.instance.open(trusted,trigger);active=node('outside');h.instance.close();expect(focus).toHaveBeenCalledOnce();
    active=trigger;await h.instance.open(trusted,{...trigger,isConnected:false});h.instance.close();expect(focus).toHaveBeenCalledOnce();
  });
  it('does not steal focus if focus moves away while opening',async()=>{
    const h=await mount(),trigger=focusedTrigger(),outside=node('outside');
    const opening=h.instance.open(trusted,trigger);active=outside;await opening;await h.tick();
    expect(active===outside).toBe(true);expect(h.get(n=>n.props.role==='dialog')).toBeDefined();
  });
  it('checks document focus separately when opening from a shadow root',async()=>{
    const h=await mount(),trigger=node('trigger'),outside=node('outside'),host=node('host');active=trigger;
    const document={activeElement:host,body:node('body'),documentElement:node('html')};Object.assign(host,{getRootNode:()=>document});
    const sourceRoot:{host:Node;activeElement:Node|null}={host,activeElement:trigger};Object.assign(trigger,{ownerDocument:document,getRootNode:()=>sourceRoot});
    const opening=h.instance.open(trusted,trigger);document.activeElement=outside;sourceRoot.activeElement=null;active=outside;await opening;await h.tick();
    expect(active===outside).toBe(true);expect(h.get(n=>n.props.role==='dialog')).toBeDefined();
  });
  it.each(['iframe','closed shadow host','other control'])('does not focus the panel when %s already owns focus',async kind=>{
    const h=await mount(),trigger=node('trigger'),outside=node(kind),host=node('trigger-host'),body=node('body');active=outside;
    const document={activeElement:outside,body,documentElement:node('html')};
    Object.assign(trigger,{ownerDocument:document,getRootNode:()=>({activeElement:null,host})});
    await h.instance.open(trusted,trigger);await h.tick();expect(active===outside).toBe(true);expect(h.get(n=>n.props.role==='dialog')).toBeDefined();
  });
  it('does not assume focus ownership when the entry trigger is unavailable',async()=>{
    const h=await mount(),outside=node('outside');active=outside;await h.instance.open(trusted);await h.tick();
    expect(active===outside).toBe(true);expect(h.get(n=>n.props.role==='dialog')).toBeDefined();
  });
  it.each([1,2])('focuses the panel from the entry through %s closed shadow roots',async depth=>{
    const h=await mount(),trigger=node('trigger'),body=node('body'),outerHost=node('outer-host');active=trigger;
    const document={activeElement:outerHost,body,documentElement:node('html')};Object.assign(outerHost,{getRootNode:()=>document});
    let host=outerHost;
    if(depth===2){const innerHost=node('inner-host'),outerRoot={host:outerHost,activeElement:innerHost};Object.assign(innerHost,{getRootNode:()=>outerRoot});host=innerHost;}
    const sourceRoot={host,activeElement:trigger};Object.assign(trigger,{ownerDocument:document,getRootNode:()=>sourceRoot});
    await h.instance.open(trusted,trigger);await h.tick();expect(active===h.get(n=>n.props.role==='dialog')).toBe(true);
  });
  it('focuses the panel when the document has no focused control',async()=>{
    const h=await mount(),trigger=node('trigger'),body=node('body'),host=node('host');active=body;
    Object.assign(body,{matches:()=>false});
    const document={activeElement:body,body,documentElement:node('html')};Object.assign(host,{getRootNode:()=>document});
    const sourceRoot={host,activeElement:null};Object.assign(trigger,{ownerDocument:document,getRootNode:()=>sourceRoot});
    await h.instance.open(trusted,trigger);await h.tick();expect(active===h.get(n=>n.props.role==='dialog')).toBe(true);
  });
  it('preserves external document focus that changes while the entry root remains unfocused',async()=>{
    const h=await mount(),trigger=node('trigger'),body=node('body'),outside=node('outside'),host=node('host');active=body;
    Object.assign(body,{matches:()=>false});const document={activeElement:body,body,documentElement:node('html')};
    Object.assign(host,{getRootNode:()=>document});const sourceRoot={host,activeElement:null};Object.assign(trigger,{ownerDocument:document,getRootNode:()=>sourceRoot});
    const opening=h.instance.open(trusted,trigger);document.activeElement=outside;active=outside;await opening;await h.tick();
    expect(sourceRoot.activeElement).toBeNull();expect(active===outside).toBe(true);
  });
  it('does not treat a focused shadow descendant of body as an unfocused document',async()=>{
    const h=await mount(),trigger=node('trigger'),body=node('body'),host=node('host');active=body;
    Object.assign(body,{matches:(selector:string)=>selector===':focus-within'});
    const document={activeElement:body,body,documentElement:node('html')};Object.assign(host,{getRootNode:()=>document});
    const sourceRoot={host,activeElement:null};Object.assign(trigger,{ownerDocument:document,getRootNode:()=>sourceRoot});
    await h.instance.open(trusted,trigger);await h.tick();expect(active===body).toBe(true);
  });
  it('does not focus the panel if the entry disconnects while opening',async()=>{
    const h=await mount(),trigger=node('trigger'),body=node('body'),host=node('host');active=body;
    Object.assign(body,{matches:()=>false});const document={activeElement:body,body,documentElement:node('html')};
    Object.assign(host,{getRootNode:()=>document});const sourceRoot={host,activeElement:null};Object.assign(trigger,{ownerDocument:document,getRootNode:()=>sourceRoot});
    const opening=h.instance.open(trusted,trigger);trigger.isConnected=false;await opening;await h.tick();expect(active===body).toBe(true);
  });
  it.each([1,2])('preserves focus changes %s open shadow roots deep while opening',async depth=>{
    const h=await mount(),trigger=node('trigger'),host=node('host'),foreignHost=node('foreign-host'),first=node('first'),second=node('second');active=trigger;
    const document={activeElement:host,body:node('body'),documentElement:node('html')};Object.assign(host,{getRootNode:()=>document});
    const sourceRoot={host,activeElement:trigger};Object.assign(host,{shadowRoot:sourceRoot});Object.assign(trigger,{ownerDocument:document,getRootNode:()=>sourceRoot});
    const leafRoot={activeElement:first};let shadowRoot:object=leafRoot;
    if(depth===2){const nestedHost=node('nested');Object.assign(nestedHost,{shadowRoot:leafRoot});shadowRoot={activeElement:nestedHost};}
    Object.assign(foreignHost,{shadowRoot});
    const opening=h.instance.open(trusted,trigger);sourceRoot.activeElement=foreignHost;leafRoot.activeElement=second;active=second;await opening;await h.tick();
    expect(active===second).toBe(true);expect(h.get(n=>n.props.role==='dialog')).toBeDefined();
  });
  it('localizes labels and empty state without triggering a read',async()=>{
    const h=await mount();h.props.translate.mockImplementation(text=>({'漫画文字':'Manga text','图片':'Image','当前没有可查看的页面':'No visible pages'} as Record<string,string>)[text]??text);
    await h.instance.open(trusted);await h.tick();expect(h.get(n=>n.props.role==='dialog')?.props['aria-label']).toBe('Manga text');expect(h.button('Image 1')).toBeDefined();
    h.props.list.mockReturnValueOnce({status:'ready',items:[]});h.panel.refresh();await h.tick();expect(h.get(n=>n.text==='No visible pages')).toBeDefined();expect(h.props.read).not.toHaveBeenCalled();
  });
  it('handles keyboard Escape and restores the invoking control',async()=>{
    const h=await mount(), trigger=focusedTrigger(),focus=trigger.focus;
    await h.instance.open(trusted,trigger);const stopPropagation=vi.fn(),preventDefault=vi.fn();
    h.get(n=>n.props.role==='dialog')!.props.onKeydown({key:'ArrowDown',isTrusted:true,stopPropagation,preventDefault});
    expect(stopPropagation).toHaveBeenCalledOnce();expect(preventDefault).not.toHaveBeenCalled();stopPropagation.mockClear();
    h.get(n=>n.props.role==='dialog')!.props.onKeydown({key:'Escape',isTrusted:true,stopPropagation,preventDefault});await h.tick();
    expect(stopPropagation).toHaveBeenCalledOnce();expect(preventDefault).toHaveBeenCalledOnce();expect(focus).toHaveBeenCalledOnce();expect(h.get(n=>n.props.role==='dialog')).toBeUndefined();
  });
  it('isolates bubbling touch gestures without cancelling native scrolling',async()=>{
    const h=await mount();await h.instance.open(trusted);await h.tick();const dialog=h.get(n=>n.props.role==='dialog')!;
    for(const name of ['onTouchstartPassive','onTouchmovePassive','onTouchendPassive','onTouchcancelPassive']) {
      const stopPropagation=vi.fn(),preventDefault=vi.fn();expect(dialog.props[name]).toBeTypeOf('function');
      dialog.props[name]({stopPropagation,preventDefault});expect(stopPropagation).toHaveBeenCalledOnce();expect(preventDefault).not.toHaveBeenCalled();
    }
  });
  it('moves keyboard focus from the selected candidate to the result and back to the list',async()=>{
    const h=await mount();await h.instance.open(trusted);await h.tick();const candidate=h.button('图片 1')!;active=candidate;
    candidate.props.onClick({isTrusted:true,currentTarget:candidate});await h.tick();const back=h.button('选择其他页面')!;expect(active).toBe(back);
    back.props.onClick({isTrusted:true,currentTarget:back});await h.tick();expect(active).toBe(h.button('图片 1'));
  });
  it('does not steal focus when a selection is closed, invalidated or focus moves before the next tick',async()=>{
    for(const action of ['close','invalidate','outside'] as const) {
      const h=await mount();await h.instance.open(trusted);await h.tick();const candidate=h.button('图片 1')!;active=candidate;
      candidate.props.onClick({isTrusted:true,currentTarget:candidate});const outside=node('outside');
      if(action==='outside')active=outside;else h.instance[action]();await h.tick();expect(active).not.toBe(h.button('选择其他页面'));if(action==='outside')expect(active).toBe(outside);
      dispose?.();dispose=undefined;
    }
  });
  it('uses a layer above the image translation root without assuming the shadow host creates a stacking context',()=>{
    const panel=readFileSync(resolve('src/features/image-translation/ui/MangaReadingPanel.vue'),'utf8');
    const overlay=readFileSync(resolve('src/features/image-translation/content/runtime.ts'),'utf8');
    const panelLayer=Number(panel.match(/\.fr-manga-reading \{[^}]*z-index:(\d+)/)?.[1]);
    const imageLayer=Number(overlay.match(/z-index: (\d+) !important/)?.[1]);
    expect(panelLayer).toBeGreaterThan(imageLayer);
  });
  it('uses readable snapshot guidance colors in explicit and system dark themes',()=>{
    const panel=readFileSync(resolve('src/features/image-translation/ui/MangaReadingPanel.vue'),'utf8');
    expect(panel).toMatch(/\[data-theme=dark\] :is\(\.fr-manga-reading-source,\.fr-manga-reading-context\) \{color:#c1b1c5\}/);
    expect(panel).toMatch(/@media \(prefers-color-scheme:dark\)[\s\S]*\[data-theme=auto\] :is\(\.fr-manga-reading-source,\.fr-manga-reading-context\) \{color:#c1b1c5\}/);
  });
  it('keeps source text and guidance readable against each panel background',()=>{
    const panel=readFileSync(resolve('src/features/image-translation/ui/MangaReadingPanel.vue'),'utf8');
    const luminance=(hex:string)=>{const rgb=hex.match(/[\da-f]{2}/gi)!.map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
    const contrast=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
    const source=panel.match(/\.fr-manga-reading-source \{color:#([\da-f]{6})\}/i)?.[1];
    const context=panel.match(/\.fr-manga-reading-context \{[^}]*color:#([\da-f]{6})/i)?.[1];
    const dark=panel.match(/\[data-theme=dark\] :is\(\.fr-manga-reading-source,\.fr-manga-reading-context\) \{color:#([\da-f]{6})\}/i)?.[1];
    expect(source).toBeDefined();expect(context).toBeDefined();expect(dark).toBeDefined();
    expect(contrast(source!,'ffffff')).toBeGreaterThanOrEqual(4.5);expect(contrast(context!,'ffffff')).toBeGreaterThanOrEqual(4.5);expect(contrast(dark!,'2b2630')).toBeGreaterThanOrEqual(4.5);
  });
  it('reports a list budget failure without listing or reading a partial selection',async()=>{
    const h=await mount();h.props.list.mockReturnValueOnce({status:'overBudget'} as any);await h.instance.open(trusted);await h.tick();
    expect(h.panel.status).toBe('overBudget');expect(h.button('图片 1')).toBeUndefined();expect(h.props.read).not.toHaveBeenCalled();
  });
  it.each(['overBudget','error'] as const)('allows a manual recheck after list %s without reading',async failure=>{
    const h=await mount();
    if(failure==='error') h.props.list.mockImplementationOnce(()=>{throw Error('temporary error');});
    else h.props.list.mockReturnValueOnce({status:'overBudget'} as any);
    await h.instance.open(trusted);await h.tick();expect(h.panel.status).toBe(failure);expect(h.props.read).not.toHaveBeenCalled();
    const retry=h.button('重新查看可见页面')!;expect(retry).toBeDefined();active=retry;retry.props.onClick({isTrusted:true,currentTarget:retry});await h.tick();
    expect(h.button('图片 1')).toBeDefined();expect(active).toBe(h.button('图片 1'));expect(h.props.list).toHaveBeenCalledTimes(2);expect(h.props.read).not.toHaveBeenCalled();
  });
  it('allows an explicit recheck after an empty list without starting a read',async()=>{
    const h=await mount();h.props.list.mockReturnValueOnce({status:'ready',items:[]});await h.instance.open(trusted);await h.tick();
    expect(h.panel.status).toBe('noCandidates');expect(h.props.list).toHaveBeenCalledOnce();h.button('重新查看可见页面')!.props.onClick(trusted);await h.tick();
    expect(h.button('图片 1')).toBeDefined();expect(h.props.list).toHaveBeenCalledTimes(2);expect(h.props.read).not.toHaveBeenCalled();
  });
  it('moves focus to a newly available candidate after a recheck, and retains the recheck button when still empty',async()=>{
    const h=await mount();h.props.list.mockReturnValueOnce({status:'ready',items:[]}).mockReturnValueOnce({status:'ready',items:[]});
    await h.instance.open(trusted);await h.tick();let retry=h.button('重新查看可见页面')!;active=retry;
    retry.props.onClick({isTrusted:true,currentTarget:retry});await h.tick();expect(active).toBe(h.button('重新查看可见页面'));
    retry=h.button('重新查看可见页面')!;active=retry;retry.props.onClick({isTrusted:true,currentTarget:retry});await h.tick();
    expect(active).toBe(h.button('图片 1'));expect(h.props.read).not.toHaveBeenCalled();
  });
  it.each(['outside','close'] as const)('does not steal focus from a recheck after %s',async action=>{
    const h=await mount();h.props.list.mockReturnValueOnce({status:'ready',items:[]});await h.instance.open(trusted);await h.tick();
    const retry=h.button('重新查看可见页面')!,outside=node('outside');active=retry;retry.props.onClick({isTrusted:true,currentTarget:retry});
    if(action==='outside')active=outside;else h.instance.close();await h.tick();expect(active).not.toBe(h.button('图片 1'));if(action==='outside')expect(active).toBe(outside);
  });
  it('moves focus to the remaining enabled page button at both boundaries',async()=>{
    const h=await mount();h.props.read.mockResolvedValueOnce({status:'ready',lines:Array.from({length:40},(_,i)=>line(`行 ${i}`))});
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();let next=h.button('下一部分')!;active=next;
    next.props.onClick({isTrusted:true,currentTarget:next});await h.tick();let previous=h.button('上一部分')!;expect(active).toBe(previous);
    previous.props.onClick({isTrusted:true,currentTarget:previous});await h.tick();next=h.button('下一部分')!;expect(active).toBe(next);
  });
  it.each(['outside','close','newer'] as const)('does not steal focus after paging when %s wins',async action=>{
    const h=await mount();h.props.read.mockResolvedValueOnce({status:'ready',lines:Array.from({length:40},(_,i)=>line(`行 ${i}`))});
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();const next=h.button('下一部分')!,outside=node('outside');active=next;
    next.props.onClick({isTrusted:true,currentTarget:next});if(action==='outside')active=outside;else if(action==='close')h.instance.close();else h.panel.compare=true;
    await h.tick();expect(active).not.toBe(h.button('上一部分'));if(action==='outside')expect(active).toBe(outside);
  });
  it('rejects more than the total line budget instead of rendering a truncated result',async()=>{
    const h=await mount();h.props.read.mockResolvedValueOnce({status:'ready',lines:Array.from({length:513},()=>line('a'))});
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();expect(h.panel.status).toBe('overBudget');expect(h.get(n=>n.tag==='pre')).toBeUndefined();
  });
  it('releases observation and exposes no partial text when a result exceeds the character budget',async()=>{
    const h=await mount(),stop=vi.fn();h.props.observe.mockReturnValueOnce(stop);
    h.props.read.mockResolvedValueOnce({status:'ready',lines:[line('x'.repeat(50000))]});
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();
    expect(h.panel.status).toBe('overBudget');expect(stop).toHaveBeenCalledOnce();expect(h.get(n=>n.tag==='pre')).toBeUndefined();expect(h.props.copy).not.toHaveBeenCalled();
  });
  it('shows a read failure but ignores a late failure after the panel closes',async()=>{
    const h=await mount(),pending=deferred<MangaReadingResult>();h.props.read.mockRejectedValueOnce(Error('failed')).mockReturnValueOnce(pending.promise);
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();expect(h.panel.status).toBe('error');
    h.button('选择其他页面')!.props.onClick(trusted);await h.tick();h.button('图片 1')!.props.onClick(trusted);h.instance.close();pending.reject(Error('late'));await h.tick();
    expect(h.get(n=>n.props.role==='dialog')).toBeUndefined();expect(h.props.observe).not.toHaveBeenCalled();
  });
  it('does not let the completion of an earlier copy overwrite a later copy',async()=>{
    const h=await mount(), first=deferred<void>(),second=deferred<void>();h.props.copy.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();h.button('复制全部')!.props.onClick(trusted);h.button('复制当前部分')!.props.onClick(trusted);
    second.resolve();await h.tick();expect(h.panel.feedback).toBe('已复制');first.reject(Error('late failure'));await h.tick();expect(h.panel.feedback).toBe('已复制');
  });
  it('publishes a result only after observation and closes on invalidation',async()=>{
    const h=await mount(), stop=vi.fn();let invalid!:()=>void;h.props.observe.mockImplementation((_token,callback)=>{invalid=callback;return stop;});
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();expect(h.props.observe.mock.calls[0][0]).toBe(targets[0].token);
    expect(h.get(n=>n.text==='译文')).toBeDefined();invalid();await h.tick();expect(stop).toHaveBeenCalledOnce();expect(h.get(n=>n.props.role==='dialog')).toBeUndefined();expect(h.props.onClosed).toHaveBeenCalledOnce();
  });
  it('discards content when observation is unavailable or invalidates synchronously',async()=>{
    const h=await mount();h.props.observe.mockReturnValueOnce(undefined);await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();expect(h.panel.status).toBe('stale');expect(h.get(n=>n.text==='译文')).toBeUndefined();
    h.button('选择其他页面')!.props.onClick(trusted);await h.tick();const stop=vi.fn();h.props.observe.mockImplementationOnce((_token,invalid)=>{invalid();return stop;});h.button('图片 1')!.props.onClick(trusted);await h.tick();
    expect(stop).toHaveBeenCalledOnce();expect(h.get(n=>n.text==='译文')).toBeUndefined();expect(h.get(n=>n.props.role==='dialog')).toBeUndefined();
  });
  it('releases the observed target on replacement, closing and unmount',async()=>{
    const h=await mount(), first=vi.fn(),second=vi.fn(),third=vi.fn();h.props.observe.mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();h.button('选择其他页面')!.props.onClick(trusted);await h.tick();expect(first).toHaveBeenCalledOnce();
    h.button('画布 2')!.props.onClick(trusted);await h.tick();h.instance.close();expect(second).toHaveBeenCalledOnce();
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();dispose?.();dispose=undefined;expect(third).toHaveBeenCalledOnce();
  });
  it.each(['compare','page'] as const)('clears and invalidates copy feedback when %s changes while copying',async mode=>{
    const h=await mount(), pending=deferred<void>();h.props.read.mockResolvedValueOnce({status:'ready',lines:Array.from({length:40},(_,i)=>line(`译 ${i}`,`原 ${i}`))});h.props.copy.mockReturnValueOnce(pending.promise);
    await h.instance.open(trusted);h.button('图片 1')!.props.onClick(trusted);await h.tick();h.button('复制全部')!.props.onClick(trusted);
    h.button(mode==='compare'?'原文对照':'下一部分')!.props.onClick(trusted);pending.resolve();await h.tick();expect(h.panel.feedback).toBe('');
  });
  it.each(['light','dark'] as const)('uses the injected resolved %s theme',async theme=>{
    const h=await mount(theme);await h.instance.open(trusted);await h.tick();expect(h.get(n=>n.props.role==='dialog')?.props['data-theme']).toBe(theme);
  });
  it('provides real runtime translations for every panel phrase in all six non-Chinese languages',()=>{
    registerAllUiLanguageBundles();const keys=Object.keys(mangaReadingLegacyMessages['en-US']);expect(keys.length).toBeGreaterThan(20);
    for (const language of ['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES'] as const) {
      expect(Object.keys(mangaReadingLegacyMessages[language]).sort()).toEqual([...keys].sort());
      for(const source of keys) {const translated=translateLegacyText(source,language);expect(translated.trim(),`${language}: ${source}`).not.toBe('');expect(translated,`${language}: ${source}`).not.toBe(source);}
    }
  });
  it.each(['en-US','ja-JP','ko-KR','fr-FR','ru-RU','es-ES'] as const)('renders the real %s dialog and candidate labels',async language=>{
    registerAllUiLanguageBundles();const h=await mount();h.props.translate.mockImplementation(text=>translateLegacyText(text,language));
    await h.instance.open(trusted);await h.tick();expect(h.get(n=>n.props.role==='dialog')?.props['aria-label']).toBe(translateLegacyText('漫画文字',language));
    expect(h.button(`${translateLegacyText('图片',language)} 1`)).toBeDefined();expect(h.props.read).not.toHaveBeenCalled();
  });
});

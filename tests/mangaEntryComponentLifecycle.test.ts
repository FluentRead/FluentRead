import {createRequire} from 'node:module';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import type {MangaTranslationStatus} from '@/src/features/image-translation/content/mangaSession';
import type {MangaReadingList,MangaReadingResult} from '@/src/features/image-translation/content/mangaReadingCoordinator';

// Execute the actual SFC setup and template with Vue's renderer; native browser evidence covers DOM and CSS.
vi.mock('@/src/ui/i18n', () => ({useUiI18n:() => ({translateLegacy:(text: string) => text})}));
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
let component: any, unmount: (() => void) | undefined;
beforeAll(async () => {
  component = (await import('@/src/features/image-translation/ui/MangaEntry.vue')).default;
  expect(component.render).toBeTypeOf('function');
});
afterEach(() => {unmount?.(); unmount = undefined; vi.useRealTimers();vi.unstubAllGlobals();});

interface HostNode {
  tag: string; children: HostNode[]; props: Record<string, any>; text: string; parent: HostNode | null;
  matches: (selector: string) => boolean; blur: () => void;focus: () => void;getRootNode:()=>{activeElement:null};contains:()=>boolean;
}
const node = (tag: string, text = ''): HostNode => ({tag,text,children:[],props:{},parent:null,matches:() => false,blur:() => undefined,focus:()=>undefined,getRootNode:()=>({activeElement:null}),contains:()=>false});
function find(root: HostNode, predicate: (value: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) {const value = find(child,predicate); if (value) return value;}
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function mountEntry(toolsDisplay?: 'hover' | 'always', dockPosition?: {side: 'left' | 'right'; verticalPosition: number | null}) {
  const props = runtime.reactive({
    status:{available:true, active:false, pending:false, errors:0} as MangaTranslationStatus,
    page:{site:'fixture', route:'/chapter/1'},
    settings:{sourceLanguage:undefined as string | undefined, promptEnabled:true, floatingBallVisible:false, downloadConfirmed:false, animations:true, ...(toolsDisplay === undefined ? {} : {toolsDisplay})},
    dockPosition,
    toggle:vi.fn(), inspectResources:vi.fn(async () => false), persist:vi.fn(async (_patch: Record<string, unknown>) => undefined), openSettings:vi.fn(),
    startAreaTranslation:vi.fn(async () => true), onPeekOriginal:undefined as ((peeking:boolean)=>void) | undefined, readManga:undefined as ((event:MouseEvent)=>void) | undefined, readingOpen:false,readingState:undefined as {open:boolean} | undefined,readingChanged:vi.fn(),
    reading:undefined as {list:()=>MangaReadingList;read:(token:object,signal:AbortSignal)=>Promise<MangaReadingResult>;observe:(token:object,invalid:()=>void)=>(()=>void)|undefined;copy:(text:string)=>Promise<void>;theme:'light'|'dark'|'auto'}|undefined,
  });
  const remove = (value: HostNode) => {if (value.parent) {const at = value.parent.children.indexOf(value); if (at >= 0) value.parent.children.splice(at,1); value.parent = null;}};
  const renderer = runtime.createRenderer<HostNode, HostNode>({
    patchProp:(value,key,_previous,next) => {value.props[key] = next;},
    insert:(value,parent,anchor) => {remove(value); const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at,0,value); value.parent=parent;}, remove,
    createElement:tag => node(tag), createText:text => node('#text',text), createComment:text => node('#comment',text),
    setText:(value,text) => {value.text=text;}, setElementText:(value,text) => {value.text=text; value.children=[];}, parentNode:value => value.parent,
    nextSibling:value => value.parent?.children[value.parent.children.indexOf(value)+1] ?? null,
    querySelector:()=>null, setScopeId:()=>undefined, insertStaticContent:()=>{throw new Error('Unexpected static HTML insertion');},
  });
  let panel: any, exposed: {open: () => Promise<void>;openReading:(event:Event,from?:HTMLElement|null)=>Promise<boolean>};
  const app = renderer.createApp({setup:()=>()=>runtime.h(component,{...props,ref:(instance:any)=>{if(instance){panel=instance.$.setupState;exposed=instance;}}})});
  app.provide(runtime.ssrContextKey,{modules:new Set<string>()}); app.config.warnHandler=()=>undefined;
  const root = node('root'); app.mount(root); unmount = () => app.unmount(); await runtime.nextTick();
  const dispose = () => {unmount?.(); unmount = undefined;};
  return {panel, exposed:exposed!, props, tick:runtime.nextTick, dispose, root, find:(predicate: (value: HostNode) => boolean) => find(root,predicate)};
}
function launcher(panel: any) {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let focused = false;
  const button = panel.launcher;
  button.matches = vi.fn(() => focused); button.blur = vi.fn(() => {focused=false;});
  return {button, focus:() => {focused=true;}};
}

describe('actual manga entry resource consent and lifecycle', () => {
  it.each((['check','confirm'] as const).flatMap(phase => (['route','route-return','language','language-return','fallback','fallback-return','active','active-return','availability'] as const).map(change => [phase,change] as const)))('does not start after %s resolves in the same turn as %s changes',async (phase,change)=>{
    const {panel,props,tick}=await mountEntry(), pending=deferred<any>();
    if(phase==='check')props.inspectResources.mockReturnValueOnce(pending.promise);
    else {await panel.start();props.persist.mockReturnValueOnce(pending.promise);}
    const work=phase==='check'?panel.start():panel.confirm();await tick();pending.resolve(phase==='check'?true:undefined);
    if(change==='route'||change==='route-return'){props.page.route='/chapter/2';if(change==='route-return')props.page.route='/chapter/1';}
    else if(change==='language'||change==='language-return'){props.settings.sourceLanguage='ru';if(change==='language-return')props.settings.sourceLanguage=undefined;}
    else if(change==='fallback'||change==='fallback-return'){props.status.areaFallback=true;if(change==='fallback-return')props.status.areaFallback=undefined;}
    else if(change==='active'||change==='active-return'){props.status.active=true;if(change==='active-return')props.status.active=false;}
    else {props.status.available=false;props.status.available=true;}
    await work;await tick();expect(props.toggle,`${phase} ${change}`).not.toHaveBeenCalled();expect(panel.consent).toBe(false);
  });
  it.each(['check','confirm'] as const)('does not expose a stale %s error after resolving the same turn as a route change',async phase=>{
    const {panel,props,tick}=await mountEntry(),pending=deferred<any>();
    if(phase==='check')props.inspectResources.mockReturnValueOnce(pending.promise);else {await panel.start();props.persist.mockReturnValueOnce(pending.promise);}
    const work=phase==='check'?panel.start():panel.confirm();await tick();pending.reject(new Error('旧页面失败'));props.page.route='/chapter/2';
    await work;await tick();expect(props.toggle).not.toHaveBeenCalled();expect(panel.error).toBe('');expect(panel.consent).toBe(false);
  });
  it.each(['check','confirm'] as const)('does not start after %s resolves in the same turn as unmount',async phase=>{
    const {panel,props,dispose,tick}=await mountEntry(),pending=deferred<any>();
    if(phase==='check')props.inspectResources.mockReturnValueOnce(pending.promise);
    else {await panel.start();props.persist.mockReturnValueOnce(pending.promise);}
    const work=phase==='check'?panel.start():panel.confirm();await tick();pending.resolve(phase==='check'?true:undefined);dispose();await work;expect(props.toggle).not.toHaveBeenCalled();
  });
  it.each(['pause','route'] as const)('mounts one actual reading panel and closes its observation on %s',async reason=>{
    const {props,exposed,tick,find}=await mountEntry();const token={},stop=vi.fn(),list=vi.fn(()=>({status:'ready' as const,items:[{token,kind:'image' as const,ordinal:1}]})),
      read=vi.fn(async()=>({status:'ready' as const,lines:[{text:'translated',bbox:{x0:0,y0:0,x1:10,y1:10}}]}));
    props.reading={list,read,observe:()=>stop,copy:vi.fn(async()=>{}),theme:'auto'};props.status.active=true;await tick();
    expect(list).not.toHaveBeenCalled();expect(await exposed.openReading({isTrusted:true} as Event)).toBe(true);await tick();await tick();
    expect(read).toHaveBeenCalledOnce();expect(props.readingChanged).toHaveBeenCalledWith(true);
    if(reason==='pause')props.status.active=false;else props.page.route='/chapter/2';await tick();expect(stop).toHaveBeenCalledOnce();expect(props.readingChanged).toHaveBeenCalledWith(false);expect(find(value=>value.props.role==='dialog')).toBeUndefined();
  });
  it.each(['list','pending'] as const)('closes %s on transition to area fallback and ignores late results',async phase=>{
    const {props,exposed,tick,find}=await mountEntry(), token={}, pending=deferred<MangaReadingResult>(), read=vi.fn((_token:object,_signal:AbortSignal)=>pending.promise),observe=vi.fn(()=>()=>{});
    props.reading={list:()=>({status:'ready',items:[{token,kind:'image',ordinal:1},{token:{},kind:'canvas',ordinal:2}]}),read,observe,copy:vi.fn(async()=>{}),theme:'auto'};
    props.status.active=true;await tick();await exposed.openReading({isTrusted:true} as Event);await tick();
    if(phase==='pending'){find(value=>value.tag==='button'&&value.text==='图片 1')!.props.onClick({isTrusted:true});await tick();}
    props.status.areaFallback=true;await tick();expect(find(value=>value.props.role==='dialog')).toBeUndefined();
    if(phase==='pending'){expect(read.mock.calls[0][1].aborted).toBe(true);pending.resolve({status:'ready',lines:[{text:'late',bbox:{x0:0,y0:0,x1:1,y1:1}}]});await tick();await tick();expect(observe).not.toHaveBeenCalled();expect(find(value=>value.text==='late')).toBeUndefined();}
    expect(props.readingChanged).toHaveBeenLastCalledWith(false);
  });
  it('exposes a secondary reading action only when enabled and active without toggling manga', async () => {
    const {props,tick,find} = await mountEntry();const read=vi.fn();props.readManga=read;await tick();
    expect(find(value => value.props.class?.includes('fr-manga-reading-launcher'))).toBeUndefined();
    props.status.active=true;await tick();const button=find(value => value.props.class?.includes('fr-manga-reading-launcher'))!;
    expect(button.props['aria-label']).toBe('查看漫画文字');expect(button.props['aria-expanded']).toBe(false);
    expect(find(value => value.tag === 'svg' && value.parent === button)?.props['aria-hidden']).toBe('true');
    const event={stopPropagation:vi.fn()};button.props.onClick(event);expect(event.stopPropagation).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledWith(event);expect(props.toggle).not.toHaveBeenCalled();
    props.readingOpen=true;await tick();expect(button.props['aria-expanded']).toBe(true);expect(button.props['aria-label']).toBe('关闭漫画文字');expect(button.props.class).toContain('is-expanded');
    props.status.areaFallback=true;await tick();expect(find(value => value.props.class?.includes('fr-manga-reading-launcher'))).toBeUndefined();
  });
  it('keeps the secondary action visible while it has keyboard focus or the panel is open', async () => {
    const {panel,props,tick} = await mountEntry('hover');vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    props.readManga=vi.fn();props.status.active=true;await tick();panel.launcher.matches=()=>false;panel.readingLauncher.matches=()=>true;
    panel.reveal();vi.advanceTimersByTime(3000);expect(panel.expanded).toBe(true);expect(vi.getTimerCount()).toBe(0);
    panel.readingLauncher.matches=()=>false;panel.retract({relatedTarget:panel.readingLauncher});expect(panel.expanded).toBe(true);
    props.readingOpen=true;panel.retract();await tick();expect(panel.readingLauncher.props.class).toContain('is-expanded');
  });
  it('enables the reading control after a touch pointer, while mouse leaves it unchanged',async()=>{
    vi.stubGlobal('navigator',{maxTouchPoints:0});vi.stubGlobal('window',{matchMedia:()=>({matches:false})});
    const {props,tick,find,exposed}=await mountEntry('hover');props.readManga=vi.fn();props.status.active=true;await tick();
    const launcher=find(value=>value.props.class?.split(/\s+/).includes('fr-manga-launcher'))!;
    const reader=find(value=>value.props.class?.includes('fr-manga-reading-launcher'))!;
    launcher.props.onPointerdown({pointerType:'mouse'});await tick();expect(reader.props.class).not.toContain('is-touch');
    launcher.props.onPointerdown({pointerType:'touch'});await tick();expect(reader.props.class).toContain('is-touch');
    reader.props.onKeydown({key:'Escape',stopPropagation:vi.fn()});await tick();expect(reader.props.class).toContain('is-touch');
    props.readingState={open:true};await tick();expect(reader.props['aria-expanded']).toBe(true);expect(reader.props['aria-label']).toBe('关闭漫画文字');
    props.readingState.open=false;await tick();expect(reader.props['aria-label']).toBe('查看漫画文字');
    expect(await exposed.openReading({isTrusted:true} as Event)).toBe(false);
    props.status.areaFallback=true;await tick();expect(await exposed.openReading({isTrusted:true} as Event)).toBe(false);
    props.status.areaFallback=false;props.status.available=false;await tick();expect(await exposed.openReading({isTrusted:true} as Event)).toBe(false);
  });
  it('detects a coarse pointer even when touch point count is zero',async()=>{
    vi.stubGlobal('navigator',{maxTouchPoints:0});vi.stubGlobal('window',{matchMedia:()=>({matches:true})});
    const {props,tick,find}=await mountEntry('hover');props.readManga=vi.fn();props.status.active=true;await tick();
    expect(find(value=>value.props.class?.includes('fr-manga-reading-launcher'))!.props.class).toContain('is-touch');
  });
  it('keeps the secondary action reachable on touch after hover mode times out without pausing the session',async()=>{
    vi.stubGlobal('navigator',{maxTouchPoints:1});const {panel,props,tick,find}=await mountEntry('hover');vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const read=vi.fn();props.readManga=read;props.status.active=true;await tick();panel.reveal();vi.advanceTimersByTime(3000);await tick();
    const button=find(value=>value.props.class?.includes('fr-manga-reading-launcher'))!;expect(panel.expanded).toBe(false);expect(button.props.class).toContain('is-touch');
    const event={stopPropagation:vi.fn()};button.props.onClick(event);expect(read).toHaveBeenCalledOnce();expect(props.toggle).not.toHaveBeenCalled();
  });
  it.each([
    ['ru', '俄语和英语', '16 MB'],
    ['ko', '韩语和英语', '13 MB'],
    ['ar', '阿拉伯语和英语', '4.6 MB'],
    ['he', '希伯来语和英语', '3.5 MB'],
  ])('shows the actual %s resource disclosure and closes it after a source change', async (language, languages, size) => {
    const {props,tick,find} = await mountEntry();
    props.settings.sourceLanguage = language; await tick();
    find(value => value.props.class?.split(/\s+/).includes('fr-manga-launcher'))!.props.onClick({detail:0});
    await tick(); await tick();
    expect(find(value => value.tag === 'p' && value.text.includes(languages))?.text).toContain(size);
    expect(props.inspectResources).toHaveBeenCalledOnce();
    props.settings.sourceLanguage = 'en'; await tick();
    expect(find(value => value.props.role === 'dialog')).toBeUndefined(); expect(props.toggle).not.toHaveBeenCalled();
  });
  it('routes an area-only manga launcher through the area entry, displays failure and retries without model consent', async () => {
    const {props,tick,find} = await mountEntry();
    props.status.areaFallback = true; await tick();
    const button = find(value => value.props.class?.split(/\s+/).includes('fr-manga-launcher'))!;
    expect(button.props['aria-label']).toBe('圈选漫画翻译');
    props.startAreaTranslation.mockResolvedValueOnce(false); button.props.onClick({detail:0}); await tick(); await tick();
    expect(find(value => value.props.role === 'alert')?.text).toContain('启用圈选翻译');
    props.startAreaTranslation.mockRejectedValueOnce(new Error('area entry failed'));
    await find(value => value.props.class === 'fr-manga-primary')!.props.onClick(); await tick();
    expect(find(value => value.props.role === 'alert')?.text).toBe('area entry failed');
    props.startAreaTranslation.mockRejectedValueOnce('area message disconnected');
    await find(value => value.props.class === 'fr-manga-primary')!.props.onClick(); await tick();
    expect(find(value => value.props.role === 'alert')?.text).toBe('area message disconnected');
    await find(value => value.props.class === 'fr-manga-primary')!.props.onClick(); await tick();
    expect(find(value => value.props.role === 'dialog')).toBeUndefined();
    expect(props.inspectResources).not.toHaveBeenCalled(); expect(props.persist).not.toHaveBeenCalled(); expect(props.toggle).not.toHaveBeenCalled();
  });
  it.each(['success','failure'])('ignores a late area launch %s after the reader navigates and allows the new page to launch', async outcome => {
    const {props,tick,find} = await mountEntry(), pending = deferred<boolean>();
    props.status.areaFallback = true; props.startAreaTranslation.mockReturnValueOnce(pending.promise); await tick();
    find(value => value.props.class?.split(/\s+/).includes('fr-manga-launcher'))!.props.onClick({detail:0}); await tick();
    props.page.route = '/chapter/2'; await tick();if(outcome==='success')pending.resolve(true);else pending.reject('late area failure');await tick(); await tick();
    expect(find(value => value.props.role === 'dialog')).toBeUndefined();
    find(value => value.props.class?.split(/\s+/).includes('fr-manga-launcher'))!.props.onClick({detail:0}); await tick(); await tick();
    expect(props.startAreaTranslation).toHaveBeenCalledTimes(2); expect(find(value => value.props.role === 'dialog')).toBeUndefined();
  });
  it('renders accessible busy, error and completed states, and connects every launcher event to its intended action', async () => {
    const {panel,props,tick,find} = await mountEntry(), {button} = launcher(panel), check = deferred<boolean>();
    props.inspectResources.mockReturnValueOnce(check.promise);
    button.props.onMouseenter(); expect(panel.expanded).toBe(true); button.props.onMouseleave(); expect(panel.expanded).toBe(false);
    button.props.onPointermove({pointerType:'mouse'}); button.props.onFocusout(); button.props.onFocusin(); expect(panel.expanded).toBe(true);
    const stopPropagation = vi.fn(); button.props.onKeydown({key:'Enter',stopPropagation}); expect(panel.expanded).toBe(true);
    button.props.onKeydown({key:'Escape',stopPropagation}); expect(panel.expanded).toBe(false); expect(stopPropagation).toHaveBeenCalledOnce();
    const preventDefault = vi.fn(); button.props.onContextmenu({preventDefault}); expect(preventDefault).toHaveBeenCalledOnce(); expect(props.openSettings).toHaveBeenCalledOnce();
    button.props.onClick({detail:1}); await tick(); expect(button.props['aria-busy']).toBe(true); expect(button.props['aria-pressed']).toBe(false);
    expect(find(value => value.props.class === 'fr-manga-spinner')).toBeDefined(); check.resolve(true); await tick();
    props.status.errors = 1; await tick(); expect(find(value => value.props.class === 'fr-manga-badge fr-manga-error-badge')?.text).toBe('!');
    props.status.errors = 0; props.status.active = true; props.status.completed = 1; await tick();
    expect(button.props['aria-label']).toBe('暂停并显示原图'); expect(button.props['aria-pressed']).toBe(true); expect(find(value => value.props.class === 'fr-manga-badge')?.text).toBe('✓');
  });
  it('connects consent, close, later, retry and settings controls in the actual dialog template', async () => {
    const {panel,props,tick,find} = await mountEntry();
    const control = (className: string) => find(value => value.props.class === className)!;
    await panel.start(); await tick(); expect(find(value => value.props.role === 'dialog')?.props['aria-label']).toBe('漫画翻译');
    control('fr-manga-later').props.onClick(); await tick(); expect(panel.visible).toBe(false);
    await panel.start(); await tick(); control('fr-manga-close').props.onClick(); await tick(); expect(panel.visible).toBe(false);
    await panel.start(); await tick(); const stopPropagation = vi.fn(); find(value => value.props.role === 'dialog')!.props.onKeydown({key:'Escape',stopPropagation}); await tick(); expect(panel.visible).toBe(false);
    await panel.start(); await tick(); props.persist.mockRejectedValueOnce(new Error('保存失败'));
    await control('fr-manga-primary').props.onClick(); await tick(); expect(find(value => value.props.role === 'alert')?.text).toBe('保存失败');
    const footer = find(value => value.tag === 'footer')!; footer.children.find(value => value.tag === 'button')!.props.onClick(); expect(props.openSettings).toHaveBeenCalledOnce();
    await control('fr-manga-primary').props.onClick(); await tick(); expect(props.toggle).toHaveBeenCalledOnce();
    props.inspectResources.mockRejectedValueOnce(new Error('检查失败')); await panel.start(); await tick(); expect(find(value => value.props.role === 'alert')?.text).toBe('检查失败');
    props.inspectResources.mockResolvedValueOnce(true); await control('fr-manga-primary').props.onClick(); await tick(); expect(panel.visible).toBe(false); expect(props.toggle).toHaveBeenCalledTimes(2);
  });
  it('stays idle until explicitly opened, uses the existing floating ball when visible, and reports progress without opening a dialog', async () => {
    const {panel,props,tick} = await mountEntry();
    expect(panel.standalone).toBe(true); expect(panel.visible).toBe(false); expect(panel.actionLabel).toBe('开启连续翻译');
    expect(props.inspectResources).not.toHaveBeenCalled(); expect(props.persist).not.toHaveBeenCalled(); expect(props.toggle).not.toHaveBeenCalled();
    props.settings.floatingBallVisible = true; await tick(); expect(panel.standalone).toBe(false);
    props.settings.floatingBallVisible = false; props.settings.promptEnabled = false; await tick(); expect(panel.standalone).toBe(false);
    props.status.pending = true; await tick(); expect(panel.buttonTitle).toContain('正在处理当前漫画页'); expect(panel.visible).toBe(false);
    props.status.message = '识别文字'; await tick(); expect(panel.buttonTitle).toContain('识别文字');
    props.status.pending = false; props.status.errors = 1; await tick(); expect(panel.buttonTitle).toContain('部分页面未完成');
    props.status.active = true; await tick(); expect(panel.actionLabel).toBe('暂停并显示原图');
  });
  it('shows missing resources only after an explicit open and closing consent neither persists nor starts translation', async () => {
    const {panel,exposed,props} = await mountEntry(); await exposed.open();
    expect(props.inspectResources).toHaveBeenCalledOnce(); expect(panel.consent).toBe(true); expect(panel.visible).toBe(true); expect(panel.busy).toBe(false);
    panel.close(); expect(panel.visible).toBe(false); expect(props.persist).not.toHaveBeenCalled(); expect(props.toggle).not.toHaveBeenCalled();
  });
  it('deduplicates resource checks, shows busy immediately, and starts once when resources are already ready', async () => {
    const {panel,props} = await mountEntry(), check = deferred<boolean>(); props.inspectResources.mockReturnValue(check.promise);
    const task = panel.start(); await panel.start();
    expect(panel.busy).toBe(true); expect(panel.buttonTitle).toContain('正在检查阅读资源'); expect(props.inspectResources).toHaveBeenCalledOnce();
    check.resolve(true); await task; expect(props.toggle).toHaveBeenCalledOnce(); expect(panel.busy).toBe(false); expect(panel.visible).toBe(false);
  });
  it.each(['active','confirmed'] as const)('toggles immediately without rechecking resources when %s', async mode => {
    const {panel,props} = await mountEntry();
    if (mode === 'active') props.status.active = true; else props.settings.downloadConfirmed = true;
    await panel.start(); expect(props.toggle).toHaveBeenCalledOnce(); expect(props.inspectResources).not.toHaveBeenCalled(); expect(props.persist).not.toHaveBeenCalled();
  });
  it('refuses start or consent persistence when the manga reader is unavailable, and ignores confirmation without consent', async () => {
    const {panel,props,tick} = await mountEntry(); await panel.confirm();
    props.status.available = false; await tick(); await panel.start(); await panel.confirm();
    expect(panel.standalone).toBe(false); expect(props.inspectResources).not.toHaveBeenCalled(); expect(props.persist).not.toHaveBeenCalled(); expect(props.toggle).not.toHaveBeenCalled();
  });
  it.each([new Error('资源检查失败'), '资源检查失败'])('shows a failed check, then clears its error on a successful explicit retry: %s', async cause => {
    const {panel,props} = await mountEntry(); props.inspectResources.mockRejectedValueOnce(cause).mockResolvedValueOnce(true);
    await panel.start(); expect(panel.error).toBe('资源检查失败'); expect(panel.visible).toBe(true); expect(panel.busy).toBe(false);
    await panel.start(); expect(panel.error).toBe(''); expect(panel.visible).toBe(false); expect(props.toggle).toHaveBeenCalledOnce();
  });
  it('persists the existing consent setting once before starting, and refuses overlapping confirms or starts', async () => {
    const {panel,props} = await mountEntry(), save = deferred<undefined>(); await panel.start(); props.persist.mockReturnValue(save.promise);
    const task = panel.confirm(); await panel.confirm(); await panel.start();
    expect(panel.busy).toBe(true); expect(props.persist.mock.calls).toEqual([[{imageTranslationMangaDownloadConfirmed:true}]]); expect(props.toggle).not.toHaveBeenCalled();
    save.resolve(undefined); await task; expect(props.toggle).toHaveBeenCalledOnce(); expect(panel.visible).toBe(false); expect(panel.busy).toBe(false);
  });
  it.each([new Error('保存失败'), '保存失败'])('keeps consent after a failed save and retries only on demand: %s', async cause => {
    const {panel,props} = await mountEntry(); await panel.start(); props.persist.mockRejectedValueOnce(cause);
    await panel.confirm(); expect(panel.error).toBe('保存失败'); expect(panel.consent).toBe(true); expect(panel.busy).toBe(false); expect(props.toggle).not.toHaveBeenCalled();
    await panel.confirm(); expect(props.persist).toHaveBeenCalledTimes(2); expect(props.toggle).toHaveBeenCalledOnce(); expect(panel.error).toBe('');
  });
  const staleCases = (['check','confirm'] as const).flatMap(phase => (['close','route','unavailable','unmount'] as const).map(reason => [phase,reason] as const));
  it.each(staleCases)('ignores a late %s success after %s', async (phase,reason) => {
    const {panel,props,tick,dispose} = await mountEntry(), check = deferred<boolean>(), save = deferred<undefined>();
    if (phase === 'confirm') await panel.start();
    if (phase === 'check') props.inspectResources.mockReturnValue(check.promise); else props.persist.mockReturnValue(save.promise);
    const task = phase === 'check' ? panel.start() : panel.confirm();
    if (reason === 'close') panel.close(); else if (reason === 'route') props.page.route = '/chapter/2'; else if (reason === 'unavailable') props.status.available = false; else dispose();
    await tick(); expect(panel.busy).toBe(false); expect(panel.visible).toBe(false);
    check.resolve(false); save.resolve(undefined); await task;
    expect(panel.consent).toBe(false); expect(panel.error).toBe(''); expect(props.toggle).not.toHaveBeenCalled();
  });
  it.each(staleCases)('ignores a late %s rejection after %s', async (phase,reason) => {
    const {panel,props,tick,dispose} = await mountEntry(), pending = deferred<any>();
    if (phase === 'confirm') await panel.start();
    if (phase === 'check') props.inspectResources.mockReturnValue(pending.promise); else props.persist.mockReturnValue(pending.promise);
    const task = phase === 'check' ? panel.start() : panel.confirm();
    if (reason === 'close') panel.close(); else if (reason === 'route') props.page.route = '/chapter/2'; else if (reason === 'unavailable') props.status.available = false; else dispose();
    await tick(); pending.reject(new Error('late')); await task;
    expect(panel.error).toBe(''); expect(panel.consent).toBe(false); expect(panel.busy).toBe(false); expect(props.toggle).not.toHaveBeenCalled();
  });
  it('an older check cannot clear a newer check or reopen its consent after close and retry', async () => {
    const {panel,props} = await mountEntry(), older = deferred<boolean>(), newer = deferred<boolean>();
    props.inspectResources.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = panel.start(); panel.close(); const second = panel.start(); older.resolve(false); await first;
    expect(panel.busy).toBe(true); expect(panel.consent).toBe(false); newer.resolve(true); await second; expect(props.toggle).toHaveBeenCalledOnce();
  });
});

describe('actual manga entry focus and idle lifecycle', () => {
  it('keeps one idle timer under repeated mouse movement and retracts at the last 2.5 second deadline', async () => {
    const {panel} = await mountEntry('hover'); launcher(panel);
    for (let i=0;i<100;i++) panel.pointerReveal({pointerType:'mouse'}); expect(vi.getTimerCount()).toBe(1); expect(panel.expanded).toBe(true);
    vi.advanceTimersByTime(2499); expect(panel.expanded).toBe(true); panel.reveal(); vi.advanceTimersByTime(2499); expect(panel.expanded).toBe(true);
    vi.advanceTimersByTime(1); expect(panel.expanded).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('touch and pen movement alone do not reopen the launcher, and mouse leave clears its timer', async () => {
    const {panel} = await mountEntry('hover'); launcher(panel); panel.pointerReveal({pointerType:'touch'}); panel.pointerReveal({pointerType:'pen'});
    expect(panel.expanded).toBe(false); expect(vi.getTimerCount()).toBe(0); panel.reveal(); panel.retract();
    expect(panel.expanded).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('keyboard focus prevents idle and mouse leave collapse, while Escape blurs and clears the launcher', async () => {
    const {panel} = await mountEntry('hover'), {button,focus} = launcher(panel); panel.reveal(); focus();
    vi.advanceTimersByTime(2500); expect(panel.expanded).toBe(true); panel.reveal(); panel.retract(); expect(panel.expanded).toBe(true); expect(vi.getTimerCount()).toBe(0);
    panel.collapseLauncher(); expect(button.blur).toHaveBeenCalledOnce(); expect(panel.expanded).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0,1])('activation preserves keyboard focus only for keyboard click detail=%s', async detail => {
    const {panel,props} = await mountEntry('hover'), {button,focus} = launcher(panel); focus(); panel.activate({detail});
    expect(props.inspectResources).toHaveBeenCalledOnce(); expect(button.blur).toHaveBeenCalledTimes(detail);
    expect(vi.getTimerCount()).toBe(detail); await runtime.nextTick();
  });
  it.each(['floating-ball','prompt','unmount'] as const)('clears idle timers when the standalone launcher leaves through %s', async reason => {
    const {panel,props,tick,dispose} = await mountEntry('hover'); launcher(panel); panel.reveal();
    if (reason === 'floating-ball') props.settings.floatingBallVisible = true; else if (reason === 'prompt') props.settings.promptEnabled = false; else dispose();
    await tick(); expect(vi.getTimerCount()).toBe(0);
    if (reason !== 'unmount') expect(panel.expanded).toBe(false);
  });
});

describe('actual manga entry persistent display lifecycle', () => {
  it.each(['always', undefined] as const)('keeps the rendered launcher expanded without idle timers for toolsDisplay=%s', async toolsDisplay => {
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const {panel,props,tick,find} = await mountEntry(toolsDisplay), button = panel.launcher;
    const expectExpanded = async () => {
      await tick(); expect(find(value => value === runtime.toRaw(button))?.props.class.split(/\s+/)).toContain('is-expanded'); expect(vi.getTimerCount()).toBe(0);
    };
    if (toolsDisplay === undefined) expect(Object.prototype.hasOwnProperty.call(props.settings, 'toolsDisplay')).toBe(false);
    else expect(props.settings.toolsDisplay).toBe('always');
    expect(panel.expanded).toBe(false); await expectExpanded();
    vi.advanceTimersByTime(60_000); await expectExpanded();
    button.props.onMouseenter(); await expectExpanded();
    for (let i=0;i<100;i++) button.props.onPointermove({pointerType:'mouse'});
    await expectExpanded(); vi.advanceTimersByTime(60_000); await expectExpanded();
    button.props.onMouseleave(); expect(panel.expanded).toBe(false); await expectExpanded();
    for (const pointerType of ['touch','pen']) {button.props.onPointermove({pointerType}); await expectExpanded();}
    vi.advanceTimersByTime(60_000); await expectExpanded();
    expect(props.inspectResources).not.toHaveBeenCalled(); expect(props.persist).not.toHaveBeenCalled(); expect(props.toggle).not.toHaveBeenCalled();
  });
  it.each(['always', undefined] as const)('keeps the rendered launcher expanded through keyboard and pointer activation for toolsDisplay=%s', async toolsDisplay => {
    const {panel,props,tick,find} = await mountEntry(toolsDisplay), {button,focus} = launcher(panel);
    const expectExpanded = async () => {
      await tick(); expect(find(value => value === runtime.toRaw(button))?.props.class.split(/\s+/)).toContain('is-expanded'); expect(vi.getTimerCount()).toBe(0);
    };
    props.settings.downloadConfirmed = true;
    focus(); button.props.onFocusin(); await expectExpanded();
    button.props.onMouseleave(); await expectExpanded();
    button.props.onClick({detail:0}); expect(button.blur).not.toHaveBeenCalled(); expect(props.toggle).toHaveBeenCalledOnce(); await expectExpanded();
    vi.advanceTimersByTime(60_000); await expectExpanded();
    button.props.onClick({detail:1}); expect(button.blur).toHaveBeenCalledOnce(); expect(props.toggle).toHaveBeenCalledTimes(2); await expectExpanded();
    button.props.onFocusout(); expect(panel.expanded).toBe(false); await expectExpanded();
    focus(); button.props.onFocusin(); await expectExpanded();
    const stopPropagation = vi.fn(); button.props.onKeydown({key:'Escape',stopPropagation});
    expect(stopPropagation).toHaveBeenCalledOnce(); expect(button.blur).toHaveBeenCalledTimes(2); expect(panel.expanded).toBe(false); await expectExpanded();
    vi.advanceTimersByTime(60_000); await expectExpanded();
    expect(props.inspectResources).not.toHaveBeenCalled(); expect(props.persist).not.toHaveBeenCalled();
  });
});

describe('manga entry telemetry, hold-to-peek original, and theme propagation', () => {
  it('surfaces live progress pill, error count badge, and contextual telemetry tooltip', async () => {
    const {panel,props,tick,find} = await mountEntry();
    props.status.active = true; props.status.pending = true; props.status.progress = 42.4; await tick();
    expect(find(value => value.props.class === 'fr-manga-progress-pill')?.text).toBe('42%');
    expect(panel.buttonTitle).toContain('42%');

    props.status.pageCount = 12; props.status.completed = 3; props.status.ahead = 2; await tick();
    expect(find(value => value.props.class === 'fr-manga-progress-pill')?.text).toBe('3/12');
    expect(panel.buttonTitle).toContain('已翻译 3/12 页');
    expect(panel.buttonTitle).toContain('已预译 2 页');

    props.status.pending = false; props.status.errors = 2; await tick();
    expect(find(value => value.props.class === 'fr-manga-badge fr-manga-error-badge')?.text).toBe('!2');

    props.status.errors = 0; props.status.completed = 12; await tick();
    expect(find(value => value.props.class === 'fr-manga-progress-pill')?.text).toBe('12/12');
    expect(find(value => value.props.class === 'fr-manga-badge')?.text).toBe('✓');
    expect(panel.buttonTitle).toContain('翻译完成 (12/12)');

    props.status.areaFallback = true; await tick();
    expect(find(value => value.props.class === 'fr-manga-progress-pill')).toBeUndefined();
  });

  it('exposes hold-to-peek original button only when active with completed pages and releases cleanly', async () => {
    const {panel,props,tick,find,dispose} = await mountEntry('hover');
    const peek = vi.fn();
    props.onPeekOriginal = peek;
    await tick();
    expect(find(value => value.props.class?.includes('fr-manga-peek-launcher'))).toBeUndefined();

    props.status.active = true; props.status.completed = 1; await tick();
    const peekBtn = find(value => value.props.class?.includes('fr-manga-peek-launcher'))!;
    expect(peekBtn.props['aria-label']).toBe('按住对照原图');
    expect(peekBtn.props['aria-pressed']).toBe(false);

    // Untrusted, non-primary, and right-click pointerdown are ignored
    peekBtn.props.onPointerdown({isTrusted: false, button: 0, pointerType: 'mouse', stopPropagation: vi.fn()});
    peekBtn.props.onPointerdown({isTrusted: true, button: 2, pointerType: 'mouse', stopPropagation: vi.fn()});
    peekBtn.props.onPointerdown({isTrusted: true, button: 0, isPrimary: false, pointerType: 'touch', stopPropagation: vi.fn()});
    expect(peek).not.toHaveBeenCalled();

    // Context menu on peek button is prevented
    const ctxPrevent = vi.fn();
    peekBtn.props.onContextmenu({preventDefault: ctxPrevent});
    expect(ctxPrevent).toHaveBeenCalledOnce();

    // Trusted primary pointerdown activates peek, repeated pointerdown is ignored, pointerup releases
    const stopPropagation = vi.fn();
    peekBtn.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation});
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(peek).toHaveBeenCalledWith(true);
    peekBtn.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation});
    expect(peek).toHaveBeenCalledTimes(1);
    await tick();
    expect(peekBtn.props['aria-pressed']).toBe(true);
    expect(peekBtn.props.class).toContain('is-peeking');

    // Holding peek longer than 2.5s idle timeout keeps dock expanded
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    panel.reveal();
    vi.advanceTimersByTime(3000);
    expect(panel.expanded).toBe(true);
    vi.useRealTimers();

    // Dock hover/focus bridge keeps dock expanded when moving to peek button
    panel.retract({relatedTarget: panel.dock}); expect(panel.expanded).toBe(true);
    panel.reveal(); panel.retract({relatedTarget: panel.peekLauncher}); expect(panel.expanded).toBe(true);
    peekBtn.props.onPointerup({stopPropagation: vi.fn()});
    expect(peek).toHaveBeenLastCalledWith(false);
    // Repeated stop is a no-op
    peekBtn.props.onPointercancel({stopPropagation: vi.fn()});
    expect(peek).toHaveBeenCalledTimes(2);

    // Keyboard Space/Enter hold-to-peek ignores other keys, untrusted and repeat events and releases on keyup
    const prevent = vi.fn();
    peekBtn.props.onKeydown({key: 'a', isTrusted: true, repeat: false, preventDefault: prevent});
    peekBtn.props.onKeydown({key: ' ', isTrusted: false, repeat: false, preventDefault: prevent});
    peekBtn.props.onKeydown({key: ' ', isTrusted: true, repeat: true, preventDefault: prevent});
    expect(peek).toHaveBeenCalledTimes(2);
    peekBtn.props.onKeydown({key: ' ', isTrusted: true, repeat: false, preventDefault: prevent});
    expect(peek).toHaveBeenLastCalledWith(true);
    peekBtn.props.onKeyup({key: 'a'});
    expect(peek).toHaveBeenCalledTimes(3);
    peekBtn.props.onKeyup({key: ' '});
    expect(peek).toHaveBeenLastCalledWith(false);
    peekBtn.props.onKeydown({key: 'Enter', isTrusted: true, repeat: false, preventDefault: prevent});
    expect(peek).toHaveBeenLastCalledWith(true);
    peekBtn.props.onKeyup({key: 'Enter'});
    expect(peek).toHaveBeenLastCalledWith(false);

    // Escape / blur / pointerleave release peek
    peekBtn.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'touch', stopPropagation: vi.fn()});
    await tick();
    expect(find(value => value.props.class?.split(/\s+/).includes('fr-manga-launcher'))!.props.class).toContain('is-touch');
    peekBtn.props.onBlur();
    expect(peek).toHaveBeenLastCalledWith(false);

    peekBtn.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation: vi.fn()});
    peekBtn.props.onPointerleave();
    expect(peek).toHaveBeenLastCalledWith(false);

    peekBtn.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation: vi.fn()});
    peekBtn.props.onKeydown({key: 'Escape', stopPropagation: vi.fn()});
    expect(peek).toHaveBeenLastCalledWith(false);

    // Deactivating, route change, standalone hide, and unmount all release active peek
    peekBtn.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation: vi.fn()});
    props.status.active = false; await tick();
    expect(peek).toHaveBeenLastCalledWith(false);

    props.status.active = true; await tick();
    find(value => value.props.class?.includes('fr-manga-peek-launcher'))!.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation: vi.fn()});
    props.page.route = '/chapter/2'; await tick();
    expect(peek).toHaveBeenLastCalledWith(false);

    find(value => value.props.class?.includes('fr-manga-peek-launcher'))!.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation: vi.fn()});
    props.settings.promptEnabled = false; await tick();
    expect(peek).toHaveBeenLastCalledWith(false);

    props.settings.promptEnabled = true; await tick();
    find(value => value.props.class?.includes('fr-manga-peek-launcher'))!.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation: vi.fn()});
    props.status.available = false; await tick();
    expect(peek).toHaveBeenLastCalledWith(false);

    props.status.available = true; await tick();
    find(value => value.props.class?.includes('fr-manga-peek-launcher'))!.props.onPointerdown({isTrusted: true, button: 0, pointerType: 'mouse', stopPropagation: vi.fn()});
    dispose();
    expect(peek).toHaveBeenLastCalledWith(false);
  });

  it('propagates data-theme to dock, backdrop, and modal, focuses dialog on open, and closes modal on backdrop click', async () => {
    const {panel,props,tick,find} = await mountEntry();
    const dockNode = find(value => value.props.class?.includes('fr-manga-dock'))!;
    expect(dockNode.props['data-theme']).toBe('auto');
    props.reading = {list: () => ({status: 'ready', items: []}), read: vi.fn(), observe: vi.fn(), copy: vi.fn(), theme: 'dark'};
    await tick();
    expect(dockNode.props['data-theme']).toBe('dark');
    await panel.start(); await tick(); await tick();
    const backdrop = find(value => value.props.class === 'fr-manga-backdrop')!;
    const dialog = find(value => value.props.role === 'dialog')!;
    const focusSpy = vi.spyOn(dialog, 'focus');
    expect(backdrop.props['data-theme']).toBe('dark');
    expect(dialog.props['data-theme']).toBe('dark');
    expect(dialog.props['aria-modal']).toBe('true');
    expect(dialog.props.tabindex).toBe('-1');
    backdrop.props.onClick(); await tick();
    expect(panel.visible).toBe(false);
    // Closing synchronously before nextTick does not focus stale dialog
    await panel.start(); panel.close(); await tick(); await tick();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('supports dragging the standalone dock to left/right edge, persists clamped vertical position, suppresses click, and handles cancel/blur/prop sync', async () => {
    const listeners = new Map<string, Set<EventListener>>();
    const win = {
      innerWidth: 1000,
      innerHeight: 800,
      matchMedia: () => ({matches: false}),
      addEventListener: vi.fn((type: string, fn: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: EventListener) => {
        listeners.get(type)?.delete(fn);
      }),
    };
    const emitWin = (type: string, event: any) => {
      for (const fn of Array.from(listeners.get(type) ?? [])) fn(event);
    };
    vi.stubGlobal('window', win);

    const {panel, props, tick, find} = await mountEntry('hover', {side: 'left', verticalPosition: 0.25});
    const dockNode = () => find(value => value.props.class?.includes('fr-manga-dock'))!;
    const launcherNode = () => find(value => value.props.class?.split(/\s+/).includes('fr-manga-launcher'))!;
    expect(dockNode().props['data-position']).toBe('left');
    expect(dockNode().props.style).toEqual({top: '25.0%'});

    // External dockPosition sync (right, null, invalid undefined)
    props.dockPosition!.side = 'right';
    props.dockPosition!.verticalPosition = null;
    await tick();
    expect(dockNode().props['data-position']).toBe('right');
    expect(dockNode().props.style).toBeUndefined();
    props.dockPosition = undefined;
    await tick();

    // Missing getBoundingClientRect guard
    launcherNode().props.onPointerdown({pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 1, clientX: 980, clientY: 400});
    expect(win.addEventListener).not.toHaveBeenCalled();

    // Invalid button / non-primary / non-finite coordinates ignored
    let captured = false;
    let rect = {left: 960, top: 380, width: 40, height: 40};
    Object.assign(panel.launcher, {
      getBoundingClientRect: () => rect,
      setPointerCapture: vi.fn(() => {captured = true;}),
      hasPointerCapture: vi.fn(() => captured),
      releasePointerCapture: vi.fn(() => {captured = false;}),
    });
    for (const bad of [
      {pointerType: 'mouse', button: 2, isPrimary: true, pointerId: 1, clientX: 980, clientY: 400},
      {pointerType: 'touch', button: 0, isPrimary: false, pointerId: 1, clientX: 980, clientY: 400},
      {pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 1, clientX: NaN, clientY: 400},
      {pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 1, clientX: 980, clientY: Infinity},
    ]) {
      launcherNode().props.onPointerdown(bad);
    }
    expect(win.addEventListener).not.toHaveBeenCalled();

    // Full drag to left edge + suppress subsequent click + persist rejection swallowed
    props.persist.mockRejectedValueOnce(new Error('storage busy'));
    launcherNode().props.onPointerdown({pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 7, clientX: 980, clientY: 400});
    // Overlapping pointerdown while dragging is ignored
    launcherNode().props.onPointerdown({pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 8, clientX: 980, clientY: 400});
    // Wrong pointerId move & within threshold move ignored
    emitWin('pointermove', {pointerId: 99, clientX: 100, clientY: 100});
    emitWin('pointermove', {pointerId: 7, clientX: 982, clientY: 402});
    await tick();
    expect(dockNode().props.class).not.toContain('is-dragging');
    // Move past threshold starts drag
    emitWin('pointermove', {pointerId: 7, clientX: 120, clientY: 200});
    await tick();
    expect(dockNode().props.class).toContain('is-dragging');
    expect(dockNode().props.style).toMatchObject({right: 'auto', transform: 'none'});
    expect(panel.launcher.setPointerCapture).toHaveBeenCalledWith(7);
    // Second move while already dragging updates coordinates
    emitWin('pointermove', {pointerId: 7, clientX: 80, clientY: 160});
    // Wrong pointerId pointerup ignored
    emitWin('pointerup', {pointerId: 99, clientX: 80, clientY: 160});
    emitWin('pointerup', {pointerId: 7, clientX: 80, clientY: 160});
    await tick();
    expect(dockNode().props['data-position']).toBe('left');
    expect(props.persist).toHaveBeenCalledWith({floatingBallPosition: 'left', floatingBallVerticalPosition: expect.any(Number)});
    expect(panel.launcher.releasePointerCapture).toHaveBeenCalledWith(7);
    // Post-drag click is suppressed once, then normal click works
    launcherNode().props.onClick({detail: 1});
    expect(props.inspectResources).not.toHaveBeenCalled();

    // Jump release (>6px without pointermove) snaps to right edge & handles zero-size rect fallback (36x36)
    rect = {left: 0, top: 100, width: 0, height: 0};
    launcherNode().props.onPointerdown({pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 11, clientX: 10, clientY: 110});
    emitWin('pointerup', {pointerId: 11, clientX: 920, clientY: 790});
    await tick();
    expect(dockNode().props['data-position']).toBe('right');
    expect(dockNode().props.style).toEqual({top: '94.0%'});
    // Clear suppressed click
    launcherNode().props.onClick({detail: 1});

    // Short tap (<6px) does not persist and allows click
    props.persist.mockClear();
    launcherNode().props.onPointerdown({pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 12, clientX: 970, clientY: 400});
    emitWin('pointerup', {pointerId: 12, clientX: 971, clientY: 401});
    await tick();
    expect(props.persist).not.toHaveBeenCalled();

    // pointercancel (wrong id ignored, matching id cancels), lostpointercapture (no event / matching id), and window blur cancel
    launcherNode().props.onLostpointercapture();
    launcherNode().props.onPointerdown({pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 13, clientX: 970, clientY: 400});
    emitWin('pointercancel', {pointerId: 99});
    emitWin('pointercancel', {pointerId: 13});
    launcherNode().props.onPointerdown({pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 14, clientX: 970, clientY: 400});
    emitWin('blur', {});
    launcherNode().props.onPointerdown({pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 15, clientX: 970, clientY: 400});
    launcherNode().props.onLostpointercapture();
    expect(listeners.get('pointermove')?.size ?? 0).toBe(0);
  });
});

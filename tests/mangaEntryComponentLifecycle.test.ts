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
async function mountEntry(toolsDisplay?: 'hover' | 'always') {
  const props = runtime.reactive({
    status:{available:true, active:false, pending:false, errors:0} as MangaTranslationStatus,
    page:{site:'fixture', route:'/chapter/1'},
    settings:{sourceLanguage:undefined as string | undefined, promptEnabled:true, floatingBallVisible:false, downloadConfirmed:false, animations:true, ...(toolsDisplay === undefined ? {} : {toolsDisplay})},
    toggle:vi.fn(), inspectResources:vi.fn(async () => false), persist:vi.fn(async (_patch: Record<string, unknown>) => undefined), openSettings:vi.fn(),
    startAreaTranslation:vi.fn(async () => true), readManga:undefined as ((event:MouseEvent)=>void) | undefined, readingOpen:false,readingChanged:vi.fn(),
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
    expect(list).not.toHaveBeenCalled();expect(await exposed.openReading({isTrusted:true} as Event)).toBe(true);await tick();
    find(value=>value.tag==='button'&&value.text==='图片 1')!.props.onClick({isTrusted:true});await tick();await tick();expect(read).toHaveBeenCalledOnce();expect(props.readingChanged).toHaveBeenCalledWith(true);
    if(reason==='pause')props.status.active=false;else props.page.route='/chapter/2';await tick();expect(stop).toHaveBeenCalledOnce();expect(props.readingChanged).toHaveBeenCalledWith(false);expect(find(value=>value.props.role==='dialog')).toBeUndefined();
  });
  it.each(['list','pending'] as const)('closes %s on transition to area fallback and ignores late results',async phase=>{
    const {props,exposed,tick,find}=await mountEntry(), token={}, pending=deferred<MangaReadingResult>(), read=vi.fn((_token:object,_signal:AbortSignal)=>pending.promise),observe=vi.fn(()=>()=>{});
    props.reading={list:()=>({status:'ready',items:[{token,kind:'image',ordinal:1}]}),read,observe,copy:vi.fn(async()=>{}),theme:'auto'};
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
  it('keeps the secondary action reachable on touch after hover mode times out without pausing the session',async()=>{
    vi.stubGlobal('navigator',{maxTouchPoints:1});const {panel,props,tick,find}=await mountEntry('hover');vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
    const read=vi.fn();props.readManga=read;props.status.active=true;await tick();panel.reveal();vi.advanceTimersByTime(3000);await tick();
    const button=find(value=>value.props.class?.includes('fr-manga-reading-launcher'))!;expect(panel.expanded).toBe(false);expect(button.props.class).toContain('is-touch');
    const event={stopPropagation:vi.fn()};button.props.onClick(event);expect(read).toHaveBeenCalledOnce();expect(props.toggle).not.toHaveBeenCalled();
  });
  it.each([['ru', '俄语和英语', '16 MB'], ['ko', '韩语和英语', '13 MB']])('shows the actual %s resource disclosure and closes it after a source change', async (language, languages, size) => {
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
  it('ignores a late area launch rejection after the reader navigates and allows the new page to launch', async () => {
    const {props,tick,find} = await mountEntry(), pending = deferred<boolean>();
    props.status.areaFallback = true; props.startAreaTranslation.mockReturnValueOnce(pending.promise); await tick();
    find(value => value.props.class?.split(/\s+/).includes('fr-manga-launcher'))!.props.onClick({detail:0}); await tick();
    props.page.route = '/chapter/2'; await tick(); pending.reject('late area failure'); await tick(); await tick();
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

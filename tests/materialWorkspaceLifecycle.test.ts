import {FixturePageError, materialPageFixture} from './helpers/materialPageFixture';
import * as runtime from 'vue';
import {parseHTML} from 'linkedom';
import MaterialWorkspace from '@/src/features/vocabulary/ui/MaterialWorkspace.vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';
import type {MaterialBackupOutcome} from '@/src/features/vocabulary/materialBackupRestore';
import type {MaterialImportStatus} from '@/src/features/vocabulary/materialImportPortClient';
import {translateLegacyText} from '@/src/core/i18n';
import {createHash} from 'node:crypto';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

const KEY = '__fluentreadMaterialUiTest';
const dispose: Array<() => unknown> = [];
afterEach(async () => {for (const close of dispose.splice(0).reverse()) await close(); delete (globalThis as any)[KEY]; vi.restoreAllMocks(); vi.unstubAllGlobals();vi.unstubAllEnvs();});
const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => {resolve=done;reject=fail;}); return {promise,resolve,reject};};
const record = (id = 'a'): MaterialRecord => ({id,identityKey:`article:https://example.test/${id}`,kind:'article',title:`Article ${id}`,source:{kind:'article',url:`https://example.test/${id}`},locator:{kind:'text',quote:'The original sentence.'},topics:['Design'],references:[{kind:'note',id:'note-1',note:'A personal thought.'}],createdAt:1,updatedAt:2,lastReadAt:2,archivedAt:null});
// Port calls resolve the current fixture, while the normal Vite SFC module retains source maps.
vi.mock('@/src/features/vocabulary/materialClient', () => Object.fromEntries([
  'materialList','materialCapture','materialUpdate','materialArchive','materialRestore',
  'materialRemoveReference','materialClear','materialExport','materialImport','materialGeneration',
  'workspaceMaterialCapture','workspaceMaterialUpdate','workspaceMaterialArchive','workspaceMaterialRestore','workspaceMaterialRemoveReference',
].map(name => [name, (...args: unknown[]) => (globalThis as any).__fluentreadMaterialUiTest.api[name.replace('workspaceMaterial','material')](...args)])));
vi.mock('@/src/features/vocabulary/materialBackupExportClient', () => ({receiveMaterialBackupExport: (...args: any[]) => (globalThis as any).__fluentreadMaterialUiTest.exportReceive(...args)}));
vi.mock('@/src/features/vocabulary/materialBackupBrowserSave', () => ({
  beginFirefoxMaterialBackup: (...args: any[]) => (globalThis as any).__fluentreadMaterialUiTest.browserSave(...args),
  beginFirefoxRecoveredMaterialBackup: (...args: any[]) => (globalThis as any).__fluentreadMaterialUiTest.recoverTemporary(...args),
  listFirefoxMaterialBackupLeftovers: (...args: any[]) => (globalThis as any).__fluentreadMaterialUiTest.listTemporary(...args),
  removeFirefoxMaterialBackupLeftover: (...args: any[]) => (globalThis as any).__fluentreadMaterialUiTest.removeTemporary(...args),
}));
vi.mock('@/src/features/vocabulary/materialBackupRestore', () => Object.fromEntries([
  'restoreLargeMaterialBackup','queryMaterialBackup','acknowledgeMaterialBackup','discardMaterialBackup',
].map(name => [name, (...args: unknown[]) => (globalThis as any).__fluentreadMaterialUiTest.backup[name](...args)])));
vi.mock('@/src/features/vocabulary/materialPageClient', async () => ({
  MaterialPageClientError: (await import('./helpers/materialPageFixture')).FixturePageError,
  requestMaterialPage: (...args: any[]) => (globalThis as any).__fluentreadMaterialUiTest.pages.page(...args),
  requestMaterialDetail: (...args: any[]) => (globalThis as any).__fluentreadMaterialUiTest.pages.detail(...args),
  requestMaterialTopics: (...args: any[]) => (globalThis as any).__fluentreadMaterialUiTest.pages.topics(...args),
}));
vi.mock('webextension-polyfill', () => ({default: {get runtime() {return (globalThis as any).__fluentreadMaterialUiTest.browser.runtime;}}}));
vi.mock('@/src/features/reading-assistant/public', () => ({getHarnessSession: (...args: unknown[]) => (globalThis as any).__fluentreadMaterialUiTest.getSession(...args), listLearningMemories: (...args: unknown[]) => (globalThis as any).__fluentreadMaterialUiTest.memories(...args)}));
vi.mock('@/src/features/reading-assistant/ui/answer/public', () => ({ReadingAnswer: {render: () => null}}));
vi.mock('@/src/ui/dateFormat', () => ({useRenderDateFormatter: () => () => '10/15'}));
async function mount(options: {shown?: import('vue').Ref<boolean>; list?: (...args: any[]) => Promise<MaterialRecord[]>; session?: (...args: any[]) => Promise<unknown>; update?: (...args: any[]) => Promise<MaterialRecord>; memories?: () => Promise<unknown[]>; getEntry?: (message: unknown) => Promise<unknown>; surface?: ReturnType<typeof parseHTML>} = {}) {
  let items = [record(),record('b')]; let listener: ((message: unknown) => void) | undefined;
  const api = {
    materialList:vi.fn(options.list || (async ({archived}: {archived:boolean}) => items.filter(item => Boolean(item.archivedAt) === archived).map(item => structuredClone(item)))),
    materialUpdate:vi.fn(options.update || (async (id: string, patch: any) => {const next={...items.find(item => item.id === id)!,...patch};items=items.map(item=>item.id===id?next:item);return next;})),
    materialCapture:vi.fn(async (input: any) => {const next={...items[0], references:input.referenceMode==='update-existing'?items[0].references.map(reference=>reference.id===input.reference.id?input.reference:reference):[...items[0].references,input.reference]};items[0]=next;return next;}),
    materialArchive:vi.fn(async (id:string) => {items=items.map(item=>item.id===id?{...item,archivedAt:3}:item);return record(id);}),
    materialRestore:vi.fn(async (id:string) => {items=items.map(item=>item.id===id?{...item,archivedAt:null}:item);return record(id);}),
    materialRemoveReference:vi.fn(async (id:string,kind:string,referenceId:string) => {items=items.map(item=>item.id===id?{...item,references:item.references.filter(reference=>reference.kind!==kind||reference.id!==referenceId)}:item);return record(id);}),
    materialClear:vi.fn(async()=>{items=[];return true;}),
    materialExport:vi.fn(async()=>({format:'fluentread-learning-materials',version:1,materials:items})),
    materialImport:vi.fn(async()=>({inserted:1,updated:0,skipped:0})),
    materialGeneration:vi.fn(async()=>0),
  };
  const exportReceive=vi.fn(async (_port:unknown, consume:(bytes:Uint8Array)=>Promise<void>)=>{await consume(new TextEncoder().encode('{}'));});
  const browserSave=vi.fn(async (_name:string):Promise<any>=>({status:'unavailable'}));
  const recoverTemporary=vi.fn(async (_name:string,_filename:string):Promise<any>=>({status:'unavailable'}));
  const listTemporary=vi.fn(async ():Promise<any>=>({items:[],truncated:false,failed:0}));
  const removeTemporary=vi.fn(async (_name:string)=>{});
  const exportPort={postMessage:vi.fn(),disconnect:vi.fn()};
  const removeListener = vi.fn();
  const cap={id:'00000000-0000-4000-8000-000000000000',token:'a'.repeat(64)};
  const backup={
    restoreLargeMaterialBackup:vi.fn(async(_file:Blob,_guard:unknown,options:{onCapability:(value:typeof cap)=>void}):Promise<MaterialBackupOutcome>=>{options.onCapability(cap);return {kind:'committed',result:{inserted:1,updated:0,skipped:0},capability:cap};}),
    queryMaterialBackup:vi.fn(async():Promise<MaterialImportStatus>=>({state:'committed',result:{inserted:1,updated:0,skipped:0}})),
    acknowledgeMaterialBackup:vi.fn(async()=>undefined),discardMaterialBackup:vi.fn(async():Promise<{state:'discarded'}|{state:'committed';result:{inserted:number;updated:number;skipped:number}}>=>({state:'discarded'})),
  };
  (globalThis as any)[KEY] = {api,pages:materialPageFixture(api),backup,exportReceive,browserSave,recoverTemporary,listTemporary,removeTemporary,getSession:options.session || (async()=>null),memories:options.memories || (async()=>[]),browser:{runtime:{connect:()=>exportPort,getURL:(p:string)=>`chrome-extension://fixture/${p}`,sendMessage:options.getEntry || (async()=>({success:true,data:null})),onMessage:{addListener:(value:typeof listener)=>{listener=value;},removeListener}}}};
  const {document, window} = options.surface || parseHTML('<html><body><main></main></body></html>');
  delete (window as any).showSaveFilePicker;
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  for (const key of ['Node','Element','HTMLElement','SVGElement']) vi.stubGlobal(key, (window as any)[key]);
  const component = MaterialWorkspace;
  const renderer = runtime.createRenderer<any,any>({
    createElement: (tag, ns) => runtime.markRaw(ns === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)),
    createText: text => document.createTextNode(text), createComment: text => document.createComment(text),
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
    setText: (node, text) => {node.nodeValue = text;}, setElementText: (node, text) => {node.textContent = text;},
    parentNode: node => node.parentNode, nextSibling: node => node.nextSibling, setScopeId: (node, id) => node.setAttribute(id, ''),
    patchProp(node, key, old, value) {
      if (/^on[A-Z]/u.test(key)) {const event = key.slice(2).toLowerCase(); if(old) node.removeEventListener(event,old); if(value) node.addEventListener(event,value);}
      else if(key === 'value') {node._value = value; if(node.tagName !== 'SELECT') node.value = value ?? '';}
      else if(key === 'style') Object.assign(node.style, value || {});
      else if(value == null || key === 'disabled' && value === false) node.removeAttribute(key);
      else node.setAttribute(key, String(value));
    },
    insertStaticContent(html, parent, anchor) {const box = document.createElement('div'); box.innerHTML = html; const first = box.firstChild!, last = box.lastChild!; while(box.firstChild) parent.insertBefore(box.firstChild, anchor || null); return [first,last];},
  });
  let panel: any; const openTab=vi.fn();
  const material=()=>runtime.h(component,{onOpenTab:openTab,ref:(instance:any)=>{if(instance) panel=instance.$.setupState;}});
  const otherPage={render:()=>runtime.h('div',{'data-material-test-other':''})};
  const app = renderer.createApp({render:()=>options.shown
    ? runtime.h(runtime.KeepAlive,null,{default:()=>options.shown!.value?material():runtime.h(otherPage)})
    : material()});
  app.mount(document.querySelector('main')!);
  let active=true; const unmount=()=>{if(active){active=false;app.unmount();}}; dispose.push(()=>{if(panel?.fallbackDownloadUrl)panel.releaseFallbackDownload();while(panel?.lateBackupWarning)panel.clearLateBackupWarning();while(panel?.lateBackupStatus)panel.clearLateBackupStatus();unmount();});
  const flush=async()=>{for(let i=0;i<15;i++){await Promise.resolve();await runtime.nextTick();}};
  await flush();
  return {panel,api,backup,cap,exportReceive,browserSave,recoverTemporary,listTemporary,removeTemporary,exportPort,flush,unmount,document,window,openTab,removeListener,notify:()=>listener?.({type:'fluentReadMaterialsChanged'})};
}
describe('material workspace action ownership',()=>{
  it.each(['export','edit'] as const)('applies a pending topic search after %s finishes',async operation=>{
    const items=Array.from({length:4},(_,index)=>({...record(String(index)),topics:Array.from({length:30},(_,n)=>`Topic ${index*30+n}`)}));
    const ui=await mount({list:async()=>items});const pages=(globalThis as any)[KEY].pages,topics=vi.spyOn(pages,'topics');
    if(operation==='edit'){await ui.panel.select('0');ui.panel.startEdit();ui.panel.draft.title='Updated';}
    const gate=deferred<void>();
    if(operation==='export'){
      ui.exportReceive.mockImplementationOnce(async(_port,consume)=>{await gate.promise;await consume(new TextEncoder().encode('{}'));});
      vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:topic-search');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
      vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
    }else ui.api.materialUpdate.mockImplementationOnce(async()=>{await gate.promise;return items[0];});
    vi.useFakeTimers();try {
      const field=ui.document.querySelector<HTMLInputElement>('input[aria-label="查找主题"]')!;
      await editField(ui,field,'Topic 119');const before=topics.mock.calls.length;
      const pending=operation==='export'?ui.panel.exportMaterials():ui.panel.saveEdit();await ui.flush();expect(ui.panel.busy).toBe(true);
      await vi.advanceTimersByTimeAsync(150);await ui.flush();expect(topics).toHaveBeenCalledTimes(before);
      gate.resolve();await pending;await ui.flush();
      expect(ui.panel.busy).toBe(false);expect(ui.panel.topics).toEqual(['Topic 119']);
      expect(topics.mock.calls.some(([request])=>(request as {search?:string}).search==='Topic 119')).toBe(true);
    }finally{vi.useRealTimers();}
  });
  it('does not retry a topic page that exceeds its content limit',async()=>{
    const items=Array.from({length:4},(_,index)=>({...record(String(index)),topics:Array.from({length:30},(_,n)=>`Topic ${index*30+n}`)}));
    const ui=await mount({list:async()=>items}),pages=(globalThis as any)[KEY].pages;
    const topics=vi.spyOn(pages,'topics').mockRejectedValueOnce(new FixturePageError('limit-exceeded','材料内容超出限制'));
    vi.useFakeTimers();try {
      ui.panel.showMoreTopics();await ui.flush();await vi.advanceTimersByTimeAsync(150);await ui.flush();
      expect(topics).toHaveBeenCalledTimes(1);expect(ui.panel.error).toBe('材料内容超出限制');
    }finally{vi.useRealTimers();}
  });
  it('retries the failed reference page at its original offset',async()=>{
    const item={...record(),references:Array.from({length:25},(_,index)=>({kind:'note' as const,id:`n-${index}`,note:`Note ${index}`}))};
    const ui=await mount({list:async()=>[item]});await ui.panel.select('a');await ui.flush();
    const pages=(globalThis as any)[KEY].pages;
    vi.spyOn(pages,'detail').mockRejectedValueOnce(new Error('Page unavailable'));
    await ui.panel.showMoreReferences();await ui.flush();expect(ui.panel.selected.references).toHaveLength(24);expect(ui.panel.detailError).toBe('Page unavailable');
    await activate(ui,namedButton(ui,'重试'));expect(ui.panel.selected.references).toHaveLength(25);expect(ui.panel.detailError).toBe('');
  });
  it('reopens the list once when detail becomes stale during a refresh',async()=>{
    const ui=await mount();await ui.panel.select('a');await ui.flush();
    const pages=(globalThis as any)[KEY].pages;
    vi.spyOn(pages,'detail').mockRejectedValueOnce(new FixturePageError('stale-operation','Changed'));
    await ui.panel.reload();await ui.flush();expect(ui.api.materialList).toHaveBeenCalledTimes(3);
    expect(ui.panel.selected.id).toBe('a');expect(ui.panel.detailError).toBe('');
  });
  it('preserves untouched long titles and comma topics and submits explicitly edited quoted topics',async()=>{
    const item={...record(),title:'h'.repeat(300),topics:['one,two','中文，主题','']};
    const ui=await mount({list:async()=>[item]});await ui.panel.select('a');ui.panel.startEdit();
    expect(ui.panel.draft.topics).toBe('"one,two", "中文，主题", ""');
    ui.panel.draft.url='https://changed.example.test/';await ui.panel.saveEdit();
    expect(ui.api.materialUpdate).toHaveBeenLastCalledWith('a',{source:{...item.source,url:'https://changed.example.test/'}});
    await ui.flush();ui.panel.startEdit();ui.panel.draft.topics='"one,two", "中文，主题", "say ""hi"""';await ui.panel.saveEdit();
    expect(ui.api.materialUpdate).toHaveBeenLastCalledWith('a',{topics:['one,two','中文，主题','say "hi"']});
  });
  it('keeps lightweight list, topic/search and exact selected source; persists editing and notes through real clients',async()=>{
    const ui=await mount(); expect(ui.panel.materials).toHaveLength(2);expect(ui.panel.selected).toBeUndefined();
    ui.panel.query='Article a'; await vi.waitFor(()=>expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['a']));
    ui.panel.query='';await vi.waitFor(()=>expect(ui.panel.materials).toHaveLength(2));await ui.panel.select('a'); expect(ui.panel.resume.href).toContain('https://example.test/a?__fluentread_material=a');
    ui.panel.startEdit(); ui.panel.draft.title='Reading design';ui.panel.draft.topics='Design, Language'; await ui.panel.saveEdit();
    expect(ui.api.materialUpdate).toHaveBeenCalledWith('a',expect.objectContaining({title:'Reading design',topics:['Design','Language']}));await ui.flush();expect(ui.panel.selected.title).toBe('Reading design');
    ui.panel.note='My understanding'; await ui.panel.saveNote(); expect(ui.api.materialCapture).toHaveBeenCalledWith(expect.objectContaining({reference:expect.objectContaining({kind:'note',note:'My understanding'})}));expect(ui.panel.note).toBe('');
    await ui.panel.removeNote({kind:'note',id:'note-1'});expect(ui.api.materialRemoveReference).toHaveBeenCalledWith('a','note','note-1');
  });
  it('archives without deleting learning records and restores from separate removed list',async()=>{
    const ui=await mount();await ui.panel.select('a');await ui.panel.archiveSelected();expect(ui.panel.selected).toBeUndefined();expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['b']);
    ui.panel.toggleArchive();await ui.flush();expect(ui.api.materialList).toHaveBeenLastCalledWith({archived:true});expect(ui.panel.archived).toBe(true);
    await ui.panel.select('a');await ui.panel.restoreSelected();expect(ui.api.materialRestore).toHaveBeenCalledWith('a');expect(ui.panel.materials).toEqual([]);
  });
  it('keeps independent material drafts across selection and clears only materials after explicit action',async()=>{
    const ui=await mount();await ui.panel.select('a');ui.panel.note='Unfinished thought';ui.panel.startEdit();ui.panel.draft.title='Unfinished title';
    await ui.panel.select('b');ui.panel.note='Another thought';await ui.panel.select('a');expect(ui.panel.note).toBe('Unfinished thought');expect(ui.panel.draft.title).toBe('Unfinished title');expect(ui.panel.editing).toBe(true);
    expect(ui.api.materialClear).not.toHaveBeenCalled();ui.panel.confirmClear=true;await ui.panel.clearMaterials();expect(ui.api.materialClear).toHaveBeenCalledTimes(1);expect(ui.panel.materials).toEqual([]);expect(ui.panel.selected).toBeUndefined();expect(ui.panel.confirmClear).toBe(false);
  });
  it.each(['note','material'] as const)('does not restore a successfully saved %s draft after returning to the list while pending',async(kind)=>{
    const ui=await mount();await ui.panel.select('a');
    const write=deferred<MaterialRecord>();
    if(kind==='note'){ui.panel.note='Saved thought';ui.api.materialCapture.mockReturnValueOnce(write.promise);}
    else {ui.panel.startEdit();ui.panel.draft.title='Saved title';ui.api.materialUpdate.mockReturnValueOnce(write.promise);}
    const saving=kind==='note'?ui.panel.saveNote():ui.panel.saveEdit();await ui.flush();expect(ui.panel.busy).toBe(true);
    ui.panel.backToList();expect(ui.panel.selected).toBeUndefined();
    write.resolve({...record(),title:kind==='material'?'Saved title':record().title});await saving;
    await ui.panel.select('a');expect(ui.panel.note).toBe('');expect(ui.panel.editing).toBe(false);
    if(kind==='note'){await ui.panel.saveNote();expect(ui.api.materialCapture).toHaveBeenCalledTimes(1);}
  });
  it.each(['note','material'] as const)('retains the pending %s draft on failure after returning to the list',async(kind)=>{
    const ui=await mount();await ui.panel.select('a');const write=deferred<MaterialRecord>();
    if(kind==='note'){ui.panel.note='Keep failed thought';ui.api.materialCapture.mockReturnValueOnce(write.promise);}
    else {ui.panel.startEdit();ui.panel.draft.title='Keep failed title';ui.api.materialUpdate.mockReturnValueOnce(write.promise);}
    const saving=kind==='note'?ui.panel.saveNote():ui.panel.saveEdit();await ui.flush();ui.panel.backToList();
    write.reject(new Error('Local write unavailable'));await saving;expect(ui.panel.error).toBe('Local write unavailable');await ui.flush();await ui.panel.select('a');
    if(kind==='note')expect(ui.panel.note).toBe('Keep failed thought');
    else {expect(ui.panel.editing).toBe(true);expect(ui.panel.draft.title).toBe('Keep failed title');}
  });
  it.each(['note','material'] as const)('preserves a newer cached %s draft when an earlier save completes',async(kind)=>{
    const ui=await mount();await ui.panel.select('a');const write=deferred<MaterialRecord>();
    if(kind==='note'){ui.panel.note='Submitted thought';ui.api.materialCapture.mockReturnValueOnce(write.promise);}
    else {ui.panel.startEdit();ui.panel.draft.title='Submitted title';ui.api.materialUpdate.mockReturnValueOnce(write.promise);}
    const saving=kind==='note'?ui.panel.saveNote():ui.panel.saveEdit();await ui.flush();
    // Exercise the owner boundary: a later draft update must not be cleared by the captured save.
    if(kind==='note')ui.panel.note='Newer thought';else ui.panel.draft.title='Newer title';
    ui.panel.backToList();write.resolve(record());await saving;await ui.flush();await ui.panel.select('a');
    if(kind==='note')expect(ui.panel.note).toBe('Newer thought');
    else {expect(ui.panel.editing).toBe(true);expect(ui.panel.draft.title).toBe('Newer title');}
  });
  it.each(['note','material'] as const)('does not clear a newer active %s draft when an earlier save completes',async(kind)=>{
    const ui=await mount();await ui.panel.select('a');const write=deferred<MaterialRecord>();
    if(kind==='note'){ui.panel.note='Submitted thought';ui.api.materialCapture.mockReturnValueOnce(write.promise);}
    else {ui.panel.startEdit();ui.panel.draft.title='Submitted title';ui.api.materialUpdate.mockReturnValueOnce(write.promise);}
    const saving=kind==='note'?ui.panel.saveNote():ui.panel.saveEdit();await ui.flush();
    if(kind==='note')ui.panel.note='Newer active thought';else ui.panel.draft.title='Newer active title';
    write.resolve(record());await saving;
    if(kind==='note')expect(ui.panel.note).toBe('Newer active thought');
    else {expect(ui.panel.editing).toBe(true);expect(ui.panel.draft.title).toBe('Newer active title');}
  });
  it.each(['note','material'] as const)('settles the saved %s draft when an archived response resets the selection',async(kind)=>{
    const ui=await mount();await ui.panel.select('a');const write=deferred<MaterialRecord>();
    if(kind==='note'){ui.panel.note='Archived saved thought';ui.api.materialCapture.mockReturnValueOnce(write.promise);}
    else {ui.panel.startEdit();ui.panel.draft.title='Archived saved title';ui.api.materialUpdate.mockReturnValueOnce(write.promise);}
    const saving=kind==='note'?ui.panel.saveNote():ui.panel.saveEdit();await ui.flush();
    const archived={...record(),archivedAt:5};ui.api.materialList.mockResolvedValueOnce([record('b')]);write.resolve(archived);await saving;await ui.flush();expect(ui.panel.selected).toBeUndefined();
    ui.api.materialList.mockResolvedValueOnce([archived]);ui.panel.toggleArchive();await ui.flush();await ui.panel.select('a');
    expect(ui.panel.note).toBe('');expect(ui.panel.editing).toBe(false);
  });
  it('reports import counts and refuses late file reads or note association after unload',async()=>{
    const ui=await mount();ui.api.materialImport.mockResolvedValueOnce({inserted:0,updated:0,skipped:3});
    const input={files:[{size:8,text:async()=>'{}'}],value:'backup.json'};
    await ui.panel.importMaterials({target:input});expect(input.value).toBe('');expect(ui.panel.feedback).toContain('没有恢复材料');expect(ui.panel.feedback).toContain('跳过 3');expect(ui.api.materialImport).toHaveBeenCalledWith({},expect.objectContaining({generation:0,capturedAt:expect.any(Number)}));
    await ui.panel.select('a');ui.panel.note='Keep until save';const gate=deferred<number>();ui.api.materialGeneration.mockReturnValueOnce(gate.promise);const saving=ui.panel.saveNote();ui.unmount();gate.resolve(0);await saving;expect(ui.api.materialCapture).not.toHaveBeenCalled();
  });
  it('does not import file bytes that resolve after the workspace has gone away',async()=>{
    const ui=await mount(),file=deferred<string>();const importing=ui.panel.importMaterials({target:{files:[{size:9,text:()=>file.promise}],value:'backup'}});await ui.flush();ui.unmount();file.resolve('{}');await importing;expect(ui.api.materialImport).not.toHaveBeenCalled();
  });
  it('uses update-existing for edited notes and explains invalid JSON without losing the list',async()=>{
    const ui=await mount();await ui.panel.select('a');ui.panel.editingNoteId='note-1';ui.panel.note='Edited note';await ui.panel.saveNote();
    expect(ui.api.materialCapture).toHaveBeenCalledWith(expect.objectContaining({referenceMode:'update-existing',reference:expect.objectContaining({id:'note-1',note:'Edited note'})}));
    await ui.panel.importMaterials({target:{files:[{size:9,text:async()=>'{broken'}],value:'invalid'}});expect(ui.panel.error).toBe('备份文件无法读取，请选择有效的材料 JSON 备份。');expect(ui.panel.materials).toHaveLength(2);expect(ui.api.materialImport).not.toHaveBeenCalled();
  });
  it('reconciles external archive broadcasts during note writes and refuses hidden archived note editing',async()=>{
    const ui=await mount();await ui.panel.select('a');const saving=deferred<MaterialRecord>();ui.api.materialCapture.mockReturnValueOnce(saving.promise);ui.panel.note='Concurrent note';const pending=ui.panel.saveNote();await ui.flush();
    ui.api.materialList.mockResolvedValueOnce([record('b')]);ui.notify();saving.resolve({...record(),archivedAt:5});await pending;await ui.flush();expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['b']);expect(ui.panel.selected).toBeUndefined();expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    ui.panel.archived=true;ui.panel.editNote({kind:'note',id:'note-1',note:'Hidden edit'});expect(ui.panel.editingNoteId).toBe('');
  });
  it('ignores stale refresh and record detail after switching, retries failures, and cleans subscriptions at unload',async()=>{
    const first=deferred<MaterialRecord[]>();const second=deferred<MaterialRecord[]>();let count=0;
    const ui=await mount({list:()=>++count===1?first.promise:second.promise});expect(ui.panel.loading).toBe(true);
    const reload=ui.panel.reload();second.resolve([record('b')]);await reload;first.resolve([record('a')]);await ui.flush();expect(ui.panel.materials[0].id).toBe('b');
    ui.api.materialList.mockRejectedValueOnce(new Error('read failed'));await ui.panel.reload();expect(ui.panel.error).toBe('read failed');expect(ui.panel.materials).toHaveLength(1);
    const third=deferred<MaterialRecord[]>();ui.api.materialList.mockReturnValueOnce(third.promise);const pending=ui.panel.reload();ui.unmount();third.resolve([]);await pending;expect(ui.panel.materials).toHaveLength(1);expect(ui.removeListener).toHaveBeenCalledTimes(1);
  });
  it('does not apply late sessions to another material or late mutations to an unmounted page',async()=>{
    const session=deferred<unknown>();const update=deferred<MaterialRecord>();const ui=await mount({session:()=>session.promise,update:()=>update.promise});
    ui.panel.materials=[{...record('a'),references:[{kind:'session',id:'s1'}]},record('b')];
    await ui.panel.select('a');await ui.panel.select('b');session.resolve({id:'s1',text:'Old source',turns:[]});await ui.flush();expect(ui.panel.resolved['session:s1']).toBeUndefined();
    ui.panel.startEdit();ui.panel.draft.title='Changed';const saving=ui.panel.saveEdit();expect(ui.panel.busy).toBe(true);ui.unmount();update.resolve({...record('b'),title:'Changed'});await saving;expect(ui.panel.materials.find((item:MaterialRecord)=>item.id==='b').title).toBe('Article b');
  });
});

function namedButton(ui: Awaited<ReturnType<typeof mount>>, name: string) {
  const target = [...ui.document.querySelectorAll('button')].find(button => button.textContent?.trim() === name);
  expect(target, `button ${name}`).toBeTruthy(); return target!;
}
async function activate(ui: Awaited<ReturnType<typeof mount>>, target: Element) {
  expect(target.hasAttribute('disabled')).toBe(false);
  target.dispatchEvent(new ui.window.Event('click', {bubbles:true})); await ui.flush();
}
async function editField(ui: Awaited<ReturnType<typeof mount>>, target: Element, value: string) {
  (target as HTMLInputElement).value=value;target.dispatchEvent(new ui.window.Event('input',{bubbles:true}));await ui.flush();
}
it.each(['unmount','different-material'] as const)('does not move focus from an obsolete material note after %s',async reason=>{
  const ui=await mount();await activate(ui,ui.document.querySelector('[data-material-id="a"]')!);
  const field=ui.document.querySelector<HTMLTextAreaElement>('#fr-material-note')!;
  const focus=vi.spyOn(field,'focus');
  namedButton(ui,'编辑').dispatchEvent(new ui.window.Event('click',{bubbles:true}));
  let replacementFocus: ReturnType<typeof vi.fn> | undefined;
  if(reason==='unmount'){
    ui.unmount();const replacement=ui.document.createElement('textarea');replacement.id='fr-material-note';replacementFocus=vi.fn();replacement.focus=replacementFocus;ui.document.body.append(replacement);
  }else ui.document.querySelector('[data-material-id="b"]')!.dispatchEvent(new ui.window.Event('click',{bubbles:true}));
  await ui.flush();expect(focus).not.toHaveBeenCalled();if(replacementFocus)expect(replacementFocus).not.toHaveBeenCalled();
});
it('uses the real material template to search, organize, cancel edits and save an edited note',async()=>{
  const ui=await mount();const search=ui.document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await editField(ui,search,'unmatched');await vi.waitFor(()=>expect(ui.document.body.textContent).toContain('清除筛选'));
  await activate(ui,namedButton(ui,'清除筛选'));await vi.waitFor(()=>expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(2));
  await activate(ui,ui.document.querySelector('[data-material-id="a"]')!);
  await activate(ui,namedButton(ui,'整理材料'));const title=ui.document.querySelector<HTMLInputElement>('.fr-material-editor input')!;
  await editField(ui,title,'A changed title');await editField(ui,ui.document.querySelector('input[list]')!,'Design, Language');await editField(ui,ui.document.querySelector('input[type="url"]')!,'https://changed.example.test/');await activate(ui,namedButton(ui,'取消'));expect(ui.api.materialUpdate).not.toHaveBeenCalled();
  await activate(ui,namedButton(ui,'编辑'));const note=ui.document.querySelector<HTMLTextAreaElement>('#fr-material-note')!;
  expect(note.value).toBe('A personal thought.');await editField(ui,note,'A revised personal thought.');
  note.closest('form')!.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await ui.flush();
  expect(ui.api.materialCapture).toHaveBeenCalledWith(expect.objectContaining({referenceMode:'update-existing',reference:expect.objectContaining({id:'note-1',note:'A revised personal thought.'})}));
  expect(ui.document.body.textContent).toContain('笔记已保存');await activate(ui,namedButton(ui,'编辑'));await activate(ui,namedButton(ui,'取消编辑'));expect(note.value).toBe('');await activate(ui,namedButton(ui,'编辑'));await activate(ui,namedButton(ui,'删除笔记'));expect(ui.api.materialRemoveReference).toHaveBeenCalledWith('a','note','note-1');expect(note.value).toBe('');await activate(ui,namedButton(ui,'材料列表'));expect(ui.document.querySelector('.fr-material-detail')).toBeNull();
});

it('renders document/video positions, mixed learning records and recoverable partial failures without dropping source quotes',async()=>{
  const getEntry=vi.fn().mockResolvedValueOnce({success:false}).mockResolvedValue({success:true,data:{term:'practice',translations:{en:{text:'reference'}},note:'Saved note'}});
  const memories=vi.fn().mockResolvedValue([{id:'memory-a',content:'A learning memory.'}]);
  const refs=[{kind:'vocabulary',id:'word-a',excerpt:'A saved original.'},{kind:'session',id:'session-a'},{kind:'session',id:'gone'},
    {kind:'memory',id:'memory-a'},{kind:'memory',id:'gone'},{kind:'note',id:'note-a',note:'A personal thought.'}] as MaterialRecord['references'];
  const documentRecord: MaterialRecord={...record(),kind:'document',source:{kind:'document',fingerprint:'doc-fingerprint'},locator:{kind:'document',page:3,section:'Overview',quote:'Document original'},references:refs};
  const video: MaterialRecord={...record('video'),kind:'video',source:{kind:'video',url:'https://www.youtube.com/watch?v=example'},locator:{kind:'video',startMs:65000,quote:'Video original'}};
  const session=vi.fn(async(id:string)=>id==='session-a'?{text:'Session source',turns:[{id:'turn-a',question:'Why?',answer:'Explanation'},{id:'turn-b',question:'',answer:''}]}:null);
  const ui=await mount({list:async()=>[documentRecord,video],getEntry,memories,session});
  await activate(ui,ui.document.querySelector('[data-material-id="a"]')!);
  expect(ui.document.body.textContent).toContain('第 3 页');expect(ui.document.body.textContent).toContain('Overview');
  expect(ui.document.body.textContent).toContain('Session source');expect(ui.document.body.textContent).toContain('A learning memory.');
  expect(ui.document.body.textContent).toContain('部分学习内容读取失败');expect(ui.document.body.textContent).toContain('原记录已删除或过期');
  await activate(ui,namedButton(ui,'重试'));expect(ui.document.body.textContent).not.toContain('部分学习内容读取失败');expect(ui.document.body.textContent).toContain('reference');expect(ui.document.body.textContent).toContain('Saved note');
  await activate(ui,namedButton(ui,'整理材料'));expect(ui.document.querySelector('input[type="url"]')).toBeNull();
  namedButton(ui,'保存').closest('form')!.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await ui.flush();expect(ui.api.materialUpdate).not.toHaveBeenCalled();expect(ui.document.body.textContent).toContain('材料没有需要保存的更改');
  await activate(ui,ui.document.querySelector('[data-material-id="video"]')!);expect(ui.document.body.textContent).toContain('上次看到 1:05');
});
it('paginates material and reference lists, resets the visible page for search, and navigates from an empty library',async()=>{
  const list=Array.from({length:35},(_,i)=>({...record(String(i)),topics:i%2?['Language']:['Design'],references:Array.from({length:25},(_,j)=>({kind:'note' as const,id:`note-${j}`,note:`Note ${j}`}))}));
  const ui=await mount({list:async()=>list});expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30);
  await activate(ui,namedButton(ui,'显示更多材料（30 / 35）'));expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(35);
  await editField(ui,ui.document.querySelector('input[type="search"]')!,'Article');await vi.waitFor(()=>expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30));
  await activate(ui,ui.document.querySelector('[data-material-id="0"]')!);expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(24);
  await activate(ui,namedButton(ui,'显示更多学习内容'));expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(25);
  await activate(ui,namedButton(ui,'清空全部材料'));expect(ui.api.materialClear).not.toHaveBeenCalled();await activate(ui,namedButton(ui,'取消'));expect(ui.api.materialClear).not.toHaveBeenCalled();
  ui.api.materialList.mockResolvedValue([]);await activate(ui,namedButton(ui,'清空全部材料'));await activate(ui,namedButton(ui,'确认清空'));expect(ui.document.body.textContent).toContain('从一段值得留下的原文开始');await activate(ui,namedButton(ui,'查看我的收藏'));expect(ui.openTab).toHaveBeenCalledWith('saved');
});
it('大备份恢复的状态和限制在所有界面语言都有实际译文',()=>{
  registerAllUiLanguageBundles();
  for(const message of ['正在导出材料备份…','材料备份已保存，包含来源、原句与个人笔记，请妥善保管。','已发起材料备份下载，包含来源、原句与个人笔记，请检查浏览器下载。','下载完成前请保持此页面打开。','取消导出','当前浏览器使用内存准备下载，大备份可能占用较多内存。','下载已发起，关闭页面可能中断下载。请先确认浏览器下载完成，再释放临时数据。','下载已完成，释放临时数据'])
    for(const language of ['en-US','es-ES','fr-FR','ja-JP','ko-KR','ru-RU'] as const)
      expect(translateLegacyText(message,language)).not.toBe(message);
  for(const message of ['查看材料备份临时文件','材料备份临时文件','可取回表示备份传输已完成且文件大小一致；请下载后检查备份。','正在读取临时文件…','部分临时文件无法读取，请重试。','只显示前 200 个临时文件，请处理后重新查看。','没有材料备份临时文件。','可取回','未完成','取回备份','删除临时文件','删除可能中断尚在运行的下载。确定删除这份临时文件？','确认删除临时文件','刷新临时文件','取消后无法清理材料备份临时文件。确认没有下载进行后，重载当前页面以释放占用，再在临时文件列表处理。','无法确认备份下载状态。请先检查浏览器下载，确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。','备份已下载，但临时文件未清理。确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。','备份未完成，临时文件清理失败。确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。','取消后无法清理已选择的文件，请检查保存位置是否留有不完整文件。','备份未完成且无法清理已选择的文件，请检查保存位置是否留有不完整文件。','取消后无法清理下载缓存，请检查浏览器下载。','知道了','临时文件读取失败，请重试。','临时文件删除失败，请重试。','未获得下载权限，无法取回备份。','当前浏览器无法取回临时备份。','备份下载完成，临时文件仍保留；确认后可删除。','已发起备份下载，临时文件仍保留；请确认下载完成后再处理。','关闭保存结果提示','此前开始的材料备份已保存，包含来源、原句与个人笔记，请妥善保管。','此前开始的材料备份下载已发起，包含来源、原句与个人笔记，请检查浏览器下载。','此前开始的临时备份下载已完成，临时文件仍保留；确认后可删除。','此前开始的临时备份下载已发起，临时文件仍保留；请确认下载完成后再处理。','此前开始的备份较大，恢复受设备空间、单份材料 128 MiB 和总计 20,000 个 128 KiB 分片的限制。请保留现有材料并妥善保存备份文件。','此前开始的材料备份导出已取消。','此前开始的临时备份取回已取消。','已取消取回备份。','取回备份失败，请重试。','请先确认上一份备份下载完成。','无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载','无法确认材料备份下载是否已开始，临时文件已保留，请检查浏览器下载','临时材料备份未完成或无法验证，不能取回','当前浏览器无法查看材料备份临时文件','当前浏览器无法清理材料备份临时文件','无法确认材料备份临时文件已删除','材料备份临时文件正在使用，请等待下载结束','材料备份临时文件正在使用','材料备份下载中断','材料备份已下载，但临时文件清理失败','创建备份时未能清理新建的空临时文件，请在临时文件列表检查。','材料备份下载监听不可用，请重试','材料备份下载接口不可用，请重试'])
    for(const language of ['en-US','es-ES','fr-FR','ja-JP','ko-KR','ru-RU'] as const)
      expect(translateLegacyText(message,language)).not.toBe(message);
  for(const language of ['en-US','es-ES','fr-FR','ja-JP','ko-KR','ru-RU'] as const){
    const previous=translateLegacyText('此前开始的备份较大，恢复受设备空间、单份材料 128 MiB 和总计 20,000 个 128 KiB 分片的限制。请保留现有材料并妥善保存备份文件。',language);
    expect(previous).toContain('128 MiB');expect(previous).toContain('20,000');expect(previous).toContain('128 KiB');
  }
  for (const message of ['备份较大，恢复受设备空间、单份材料 128 MiB 和总计 20,000 个 128 KiB 分片的限制。请保留现有材料并妥善保存备份文件。','正在读取并恢复材料备份…','取消恢复','上次恢复结果或暂存状态尚待确认。关闭此页面后将无法继续查询本次结果。','检查恢复结果','结束未完成恢复','无法确认材料是否已恢复，请先检查恢复结果。','已取消恢复。','恢复请求超时，请重试。','材料备份超出当前恢复容量，请保留原材料和备份文件。','材料记录超过恢复大小限制，请保留原材料和备份文件。','备份文件嵌套层级超过恢复限制，请保留原材料和备份文件。','备份版本字段超过恢复大小限制，请保留原材料和备份文件。','未完成的恢复已结束。','恢复尚未完成。可继续检查，或结束未完成的恢复。','暂时无法确认恢复状态，请检查材料列表后重试。','材料状态读取超时，请重试。','材料状态读取失败。','不再查询','请保持此页面打开，以便中断后查询结果。','恢复结果尚未确认，暂存可能仍在本机。请先检查材料列表，再决定是否重新恢复。','材料已恢复，但列表尚未刷新。可检查恢复结果后重试。']) {
    expect(translateLegacyText(message,'zh-CN')).toBe(message);
    for (const language of ['en-US','es-ES','fr-FR','ja-JP','ko-KR','ru-RU'] as const) {
      const translated=translateLegacyText(message,language);expect(translated).not.toBe(message);
      if(message.includes('20,000 个 128 KiB')){expect(translated).toContain('20,000');expect(translated).toContain('128 MiB');expect(translated).toContain('128 KiB');}
    }
  }
});
it('文件流超过小备份上限时提示恢复资源限制并完成保存',async()=>{
  const ui=await mount();let bytes=0;
  (ui.window as any).showSaveFilePicker=vi.fn(async()=>({createWritable:async()=>({write:async(chunk:Uint8Array)=>{bytes+=chunk.byteLength;},close:async()=>{},abort:async()=>{}})}));
  ui.exportReceive.mockImplementationOnce(async(_port,consume)=>{const chunk=new Uint8Array(24*1024);for(let i=0;i<854;i++)await consume(chunk);});
  await ui.panel.exportMaterials();expect(bytes).toBeGreaterThan(20*1024*1024);expect(ui.panel.feedback).toContain('材料备份已保存');expect(ui.panel.backupWarning).toContain('总计 20,000 个 128 KiB 分片');expect(ui.browserSave).not.toHaveBeenCalled();
});
it('starts Firefox permission in the user action and keeps the page open while the download completes',async()=>{
  const ui=await mount(),finished=deferred<'saved'>();
  const target={write:vi.fn(async()=>{}),commit:vi.fn(()=>finished.promise),abort:vi.fn(async()=>{})};
  ui.browserSave.mockResolvedValueOnce({status:'ready',target});
  const pending=ui.panel.exportMaterials();
  expect(ui.browserSave).toHaveBeenCalledOnce();
  await ui.flush();expect(ui.document.body.textContent).toContain('下载完成前请保持此页面打开。');expect(ui.panel.busy).toBe(true);
  finished.resolve('saved');await pending;await ui.flush();
  expect(target.write).toHaveBeenCalledOnce();expect(target.commit).toHaveBeenCalledOnce();
  expect(ui.panel.feedback).toContain('材料备份已保存');expect(ui.panel.exportKeepOpen).toBe(false);
});
it('cleans an authorized Firefox target if export was cancelled while permission was pending',async()=>{
  const ui=await mount(),permission=deferred<any>();
  const target={write:vi.fn(async()=>{}),commit:vi.fn(async()=> 'saved'),abort:vi.fn(async()=>{})};
  ui.browserSave.mockReturnValueOnce(permission.promise);
  const pending=ui.panel.exportMaterials();expect(ui.browserSave).toHaveBeenCalledOnce();
  ui.panel.exportController.abort();await pending;expect(ui.panel.busy).toBe(false);
  permission.resolve({status:'ready',target});await vi.waitFor(()=>expect(target.abort).toHaveBeenCalledOnce());
  expect(target.write).not.toHaveBeenCalled();expect(ui.exportReceive).not.toHaveBeenCalled();
  expect(ui.panel.error).toBe('已取消导出。');expect(ui.panel.exportKeepOpen).toBe(false);
});
it('keeps the small-download fallback when optional Firefox permission is denied',async()=>{
  const ui=await mount();ui.browserSave.mockResolvedValueOnce({status:'denied'});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:permission-denied');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
  await ui.panel.exportMaterials();expect(ui.panel.feedback).toContain('已发起材料备份下载');expect(ui.exportReceive).toHaveBeenCalledOnce();
});
it.each(['denied','unavailable'] as const)('exports an intact backup larger than 20 MiB with %s fallback',async status=>{
  const ui=await mount(),hash=createHash('sha256'),chunk=Uint8Array.from({length:24*1024},(_,i)=>i%251);ui.browserSave.mockResolvedValueOnce({status});
  ui.exportReceive.mockImplementationOnce(async(_port,consume)=>{for(let i=0;i<854;i++){hash.update(chunk);await consume(chunk);}});
  let blob:Blob|undefined;vi.spyOn(URL,'createObjectURL').mockImplementation(value=>{blob=value as Blob;return 'blob:large';});
  const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
  await ui.panel.exportMaterials();expect(blob?.size).toBeGreaterThan(20*1024*1024);
  expect(createHash('sha256').update(Buffer.from(await blob!.arrayBuffer())).digest('hex')).toBe(hash.digest('hex'));
  expect(ui.panel.feedback).toContain('已发起材料备份下载');expect(revoke).not.toHaveBeenCalled();
  await activate(ui,namedButton(ui,'下载已完成，释放临时数据'));expect(revoke).toHaveBeenCalledWith('blob:large');
});
it('exports through the rendered action, releases its download URL and reports a retryable storage failure',async()=>{
  const ui=await mount();const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:materials');const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  const downloads: string[]=[];vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){if(this.tagName==='A')downloads.push((this as HTMLAnchorElement).download);});
  await activate(ui,namedButton(ui,'导出材料备份'));expect(create).toHaveBeenCalledOnce();expect(revoke).not.toHaveBeenCalled();expect(downloads[0]).toMatch(/^fluentread-materials-.*\.json$/u);expect(ui.document.body.textContent).toContain('已发起材料备份下载');
  expect(namedButton(ui,'导出材料备份').hasAttribute('disabled')).toBe(true);await activate(ui,namedButton(ui,'下载已完成，释放临时数据'));expect(revoke).toHaveBeenCalledWith('blob:materials');
  ui.exportReceive.mockRejectedValueOnce(new Error('Export unavailable'));await activate(ui,namedButton(ui,'导出材料备份'));expect(ui.document.body.textContent).toContain('Export unavailable');expect(ui.panel.busy).toBe(false);
  await activate(ui,namedButton(ui,'导出材料备份'));expect(downloads).toHaveLength(2);
});
it('retains an unconfirmed fallback download through unmount and remount in the same document',async()=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>;
  const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:remount');const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
  await ui.panel.exportMaterials();expect(create).toHaveBeenCalledOnce();ui.unmount();expect(revoke).not.toHaveBeenCalled();
  const next=await mount({surface});expect(next.document.body.textContent).toContain('关闭页面可能中断下载');
  expect(namedButton(next,'导出材料备份').hasAttribute('disabled')).toBe(true);
  await activate(next,namedButton(next,'下载已完成，释放临时数据'));expect(revoke).toHaveBeenCalledWith('blob:remount');
  expect(namedButton(next,'导出材料备份').hasAttribute('disabled')).toBe(false);
});
it('loads temporary files only on request and requires explicit confirmation before deletion',async()=>{
  vi.stubEnv('BROWSER','firefox');const ui=await mount(),gate=deferred<any>();expect(ui.listTemporary).not.toHaveBeenCalled();
  const ready={name:'ready',createdAt:1700000000000,bytes:120,ready:true},partial={name:'partial',createdAt:1700000000001,bytes:13,ready:false};
  ui.listTemporary.mockReturnValueOnce(gate.promise);await activate(ui,namedButton(ui,'查看材料备份临时文件'));
  expect(ui.listTemporary).toHaveBeenCalledOnce();expect(ui.document.body.textContent).toContain('正在读取临时文件');
  gate.resolve({items:[ready,partial],truncated:true,failed:1});await ui.flush();
  expect(ui.document.body.textContent).toContain('可取回');expect(ui.document.body.textContent).toContain('未完成');
  expect(ui.document.body.textContent).toContain('部分临时文件无法读取');expect(ui.document.body.textContent).toContain('只显示前 200 个临时文件');
  expect([...ui.document.querySelectorAll('button')].filter(button=>button.textContent==='取回备份')).toHaveLength(1);
  await ui.panel.recoverTemporaryBackup(partial);expect(ui.recoverTemporary).not.toHaveBeenCalled();
  ui.panel.temporaryDelete=ready.name;await ui.flush();expect(ui.document.body.textContent).toContain('删除可能中断尚在运行的下载');expect(ui.removeTemporary).not.toHaveBeenCalled();
  ui.removeTemporary.mockRejectedValueOnce(Error('材料备份临时文件正在使用，请等待下载结束'));
  await activate(ui,namedButton(ui,'确认删除临时文件'));expect(ui.document.body.textContent).toContain('材料备份临时文件正在使用');
  await activate(ui,namedButton(ui,'确认删除临时文件'));expect(ui.removeTemporary).toHaveBeenCalledWith('ready');expect(ui.panel.temporaryItems).toEqual([partial]);
});
it('starts recovery permission in the click, cancels immediately, and cleans a late target',async()=>{
  vi.stubEnv('BROWSER','firefox');const ui=await mount(),permission=deferred<any>();
  const item={name:'ready',createdAt:1700000000000,bytes:120,ready:true};
  ui.listTemporary.mockResolvedValueOnce({items:[item],truncated:false,failed:0});await activate(ui,namedButton(ui,'查看材料备份临时文件'));
  const target={write:vi.fn(async()=>{}),commit:vi.fn(async()=> 'saved'),abort:vi.fn(async()=>{})};ui.recoverTemporary.mockReturnValueOnce(permission.promise);
  namedButton(ui,'取回备份').dispatchEvent(new ui.window.Event('click',{bubbles:true,cancelable:true}));
  expect(ui.recoverTemporary).toHaveBeenCalledWith('ready',expect.stringMatching(/\.json$/u));
  ui.panel.exportController.abort();await ui.flush();expect(ui.panel.busy).toBe(false);expect(ui.panel.temporaryError).toBe('已取消取回备份。');
  permission.resolve({status:'ready',target});await vi.waitFor(()=>expect(target.abort).toHaveBeenCalledOnce());expect(target.commit).not.toHaveBeenCalled();
});
it('retains a completed temporary file after successful recovery and rejects unavailable permission',async()=>{
  vi.stubEnv('BROWSER','firefox');const ui=await mount(),item={name:'ready',createdAt:1700000000000,bytes:120,ready:true};
  ui.listTemporary.mockResolvedValueOnce({items:[item],truncated:false,failed:0});await activate(ui,namedButton(ui,'查看材料备份临时文件'));
  ui.recoverTemporary.mockResolvedValueOnce({status:'denied'});await ui.panel.recoverTemporaryBackup(item);expect(ui.panel.temporaryError).toBe('未获得下载权限，无法取回备份。');
  ui.recoverTemporary.mockResolvedValueOnce({status:'unavailable'});await ui.panel.recoverTemporaryBackup(item);expect(ui.panel.temporaryError).toBe('当前浏览器无法取回临时备份。');
  const target={write:vi.fn(async()=>{}),commit:vi.fn(async()=> 'saved'),abort:vi.fn(async()=>{})};ui.recoverTemporary.mockResolvedValueOnce({status:'ready',target});
  await ui.panel.recoverTemporaryBackup(item);expect(target.commit).toHaveBeenCalledOnce();expect(ui.panel.feedback).toContain('临时文件仍保留');expect(ui.removeTemporary).not.toHaveBeenCalled();
});
it('shows a warning if a cancelled permission request later creates a target that cannot be cleaned',async()=>{
  const ui=await mount(),permission=deferred<any>();ui.browserSave.mockReturnValueOnce(permission.promise);
  const pending=ui.panel.exportMaterials();ui.panel.exportController.abort();await pending;expect(ui.panel.busy).toBe(false);
  permission.resolve({status:'ready',target:{write:async()=>{},commit:async()=> 'saved',abort:async()=>{throw Error('cleanup failed');}}});
  await vi.waitFor(()=>expect(ui.panel.lateBackupWarning).toContain('重载当前页面以释放占用'));
  expect(ui.panel.exportKeepOpen).toBe(false);
});
it('keeps buffered fallback and reports Firefox initialization cleanup failure',async()=>{
  const ui=await mount(),failure=Object.assign(Error('cleanup failed'),{name:'MaterialBackupInitializationCleanupError'});
  ui.browserSave.mockRejectedValueOnce(failure);vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:init-fallback');
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
  await ui.panel.exportMaterials();expect(ui.panel.feedback).toContain('已发起材料备份下载');
  expect(ui.panel.lateBackupWarning).toBe('创建备份时未能清理新建的空临时文件，请在临时文件列表检查。');
  expect(ui.exportReceive).toHaveBeenCalledOnce();
});
it('retains a late Firefox initialization cleanup warning through component unmount',async()=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,pending=deferred<any>();
  ui.browserSave.mockReturnValueOnce(pending.promise);const work=ui.panel.exportMaterials();ui.unmount();await work;
  pending.reject(Object.assign(Error('cleanup failed'),{name:'MaterialBackupInitializationCleanupError'}));
  await vi.waitFor(()=>expect(ui.panel.lateBackupWarning).toContain('新建的空临时文件'));
  const next=await mount({surface});expect(next.document.body.textContent).toContain('新建的空临时文件');
  await activate(next,namedButton(next,'知道了'));expect(next.panel.lateBackupWarning).toBe('');
});
it.each(['firefox','picker'] as const)('retains a late %s target cleanup failure until the component remounts',async kind=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,pending=deferred<any>();
  if(kind==='firefox')ui.browserSave.mockReturnValueOnce(pending.promise);
  else (ui.window as any).showSaveFilePicker=vi.fn(()=>pending.promise);
  const work=ui.panel.exportMaterials();ui.unmount();await work;
  if(kind==='firefox')pending.resolve({status:'ready',target:{write:async()=>{},commit:async()=> 'saved',abort:async()=>{throw Error('cleanup failed');}}});
  else pending.resolve({createWritable:async()=>({write:async()=>{},close:async()=>{},abort:async()=>{throw Error('cleanup failed');}})});
  await vi.waitFor(()=>expect(ui.panel.lateBackupWarning).toContain(kind==='firefox'?'临时文件':'保存位置'));
  const next=await mount({surface});
  expect(next.document.body.textContent).toContain(kind==='firefox'?'重载当前页面以释放占用':'请检查保存位置是否留有不完整文件');
  await activate(next,namedButton(next,'知道了'));expect(next.panel.lateBackupWarning).toBe('');
});
it.each([
  ['无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载','无法确认备份下载状态。请先检查浏览器下载，确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。'],
  ['无法确认材料备份下载是否已开始，临时文件已保留，请检查浏览器下载','无法确认备份下载状态。请先检查浏览器下载，确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。'],
])('explains how to release a retained lock after an unknown download state',async(message,expected)=>{
  const ui=await mount(),target={write:vi.fn(async()=>{}),commit:vi.fn(async()=>{throw Error(message);}),abort:vi.fn(async()=>{})};
  ui.browserSave.mockResolvedValueOnce({status:'ready',target});await ui.panel.exportMaterials();expect(ui.panel.error).toBe(expected);
});
it('explains how to release a retained lock after confirmed download cleanup fails',async()=>{
  const ui=await mount(),failure=Object.assign(Error('材料备份已下载，但临时文件清理失败'),{name:'MaterialBackupOpfsCleanupError'});
  ui.browserSave.mockResolvedValueOnce({status:'ready',target:{write:async()=>{},commit:async()=>{throw failure;},abort:async()=>{}}});
  await ui.panel.exportMaterials();expect(ui.panel.error).toBe('备份已下载，但临时文件未清理。确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。');
});
it('points Firefox export cleanup failures to temporary files but keeps picker errors tied to the save location',async()=>{
  const ui=await mount(),file={write:async()=>{throw Error('disk write failed');},close:async()=>{},abort:async()=>{throw Error('cleanup failed');}};
  const target={write:file.write,commit:async()=> 'saved',abort:file.abort};ui.browserSave.mockResolvedValueOnce({status:'ready',target});
  await ui.panel.exportMaterials();expect(ui.panel.error).toBe('备份未完成，临时文件清理失败。确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。');
  (ui.window as any).showSaveFilePicker=vi.fn(async()=>({createWritable:async()=>file}));
  await ui.panel.exportMaterials();expect(ui.panel.error).toBe('材料备份未完成，清理失败，请检查保存位置是否存在不完整文件');
});
it('points Firefox recovery cleanup failures to the temporary-file list',async()=>{
  vi.stubEnv('BROWSER','firefox');const ui=await mount(),item={name:'ready',createdAt:1700000000000,bytes:120,ready:true};
  ui.recoverTemporary.mockResolvedValueOnce({status:'ready',target:{write:async()=>{},commit:async()=>{throw Error('download failed');},abort:async()=>{throw Error('cleanup failed');}}});
  await ui.panel.recoverTemporaryBackup(item);expect(ui.panel.temporaryError).toBe('备份未完成，临时文件清理失败。确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。');
});
it.each(['export','recover'] as const)('retains an unknown Firefox %s outcome after unmount and shows it on remount',async operation=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,commit=deferred<'saved'>();
  const target={write:vi.fn(async()=>{}),commit:vi.fn(()=>commit.promise),abort:vi.fn(async()=>{})};
  const item={name:'ready',createdAt:1700000000000,bytes:120,ready:true};
  if(operation==='export')ui.browserSave.mockResolvedValueOnce({status:'ready',target});else ui.recoverTemporary.mockResolvedValueOnce({status:'ready',target});
  const work=operation==='export'?ui.panel.exportMaterials():ui.panel.recoverTemporaryBackup(item);
  await vi.waitFor(()=>expect(target.commit).toHaveBeenCalledOnce());ui.unmount();
  commit.reject(Error('无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载'));await work;
  const next=await mount({surface});expect(next.document.body.textContent).toContain('确认没有下载进行后重载当前页面以释放占用');
  await activate(next,namedButton(next,'知道了'));expect(next.panel.lateBackupWarning).toBe('');
});
it.each(['export','recover'] as const)('retains Firefox %s cleanup failure after unmount without claiming completion',async operation=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,commit=deferred<'saved'>();
  const target={write:vi.fn(async()=>{}),commit:vi.fn(()=>commit.promise),abort:vi.fn(async()=>{throw Error('cleanup failed');})};
  const item={name:'ready',createdAt:1700000000000,bytes:120,ready:true};
  if(operation==='export')ui.browserSave.mockResolvedValueOnce({status:'ready',target});else ui.recoverTemporary.mockResolvedValueOnce({status:'ready',target});
  const work=operation==='export'?ui.panel.exportMaterials():ui.panel.recoverTemporaryBackup(item);
  await vi.waitFor(()=>expect(target.commit).toHaveBeenCalledOnce());ui.unmount();commit.reject(Error('download failed'));await work;
  const next=await mount({surface});expect(next.document.body.textContent).toContain('备份未完成，临时文件清理失败');
  await activate(next,namedButton(next,'知道了'));
});
it('retains the confirmed-download cleanup warning after unmount',async()=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,commit=deferred<'saved'>();
  const target={write:vi.fn(async()=>{}),commit:vi.fn(()=>commit.promise),abort:vi.fn(async()=>{})};ui.browserSave.mockResolvedValueOnce({status:'ready',target});
  const work=ui.panel.exportMaterials();await vi.waitFor(()=>expect(target.commit).toHaveBeenCalledOnce());ui.unmount();
  commit.reject(Object.assign(Error('材料备份已下载，但临时文件清理失败'),{name:'MaterialBackupOpfsCleanupError'}));await work;
  const next=await mount({surface});expect(next.document.body.textContent).toContain('备份已下载，但临时文件未清理');
  await activate(next,namedButton(next,'知道了'));
});
it('retains a picker cleanup failure after unmount and points to the chosen save location',async()=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,close=deferred<void>();
  const file={write:vi.fn(async()=>{}),close:vi.fn(()=>close.promise),abort:vi.fn(async()=>{throw Error('cleanup failed');})};
  (ui.window as any).showSaveFilePicker=vi.fn(async()=>({createWritable:async()=>file}));
  const work=ui.panel.exportMaterials();await vi.waitFor(()=>expect(file.close).toHaveBeenCalledOnce());ui.unmount();close.reject(Error('save failed'));await work;
  const next=await mount({surface});expect(next.document.body.textContent).toContain('请检查保存位置是否留有不完整文件');
  await activate(next,namedButton(next,'知道了'));
});
it('does not turn a normal cancellation after unmount into a cleanup warning',async()=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,commit=deferred<'saved'>();
  const target={write:vi.fn(async()=>{}),commit:vi.fn(()=>commit.promise),abort:vi.fn(async()=>{})};ui.browserSave.mockResolvedValueOnce({status:'ready',target});
  const work=ui.panel.exportMaterials();await vi.waitFor(()=>expect(target.commit).toHaveBeenCalledOnce());ui.unmount();
  commit.reject(new DOMException('cancelled','AbortError'));await work;
  const next=await mount({surface});expect(next.panel.lateBackupWarning).toBe('');expect(next.panel.lateBackupStatus).toBe('此前开始的材料备份导出已取消。');
});
it('keeps distinct late cleanup warnings until each has been acknowledged',async()=>{
  const first=await mount(),surface={document:first.document,window:first.window} as ReturnType<typeof parseHTML>,commit=deferred<'saved'>();
  const target={write:async()=>{},commit:vi.fn(()=>commit.promise),abort:async()=>{}};first.browserSave.mockResolvedValueOnce({status:'ready',target});
  const firstWork=first.panel.exportMaterials();await vi.waitFor(()=>expect(target.commit).toHaveBeenCalledOnce());first.unmount();
  const second=await mount({surface}),close=deferred<void>(),file={write:async()=>{},close:vi.fn(()=>close.promise),abort:async()=>{throw Error('cleanup failed');}};
  (second.window as any).showSaveFilePicker=vi.fn(async()=>({createWritable:async()=>file}));const secondWork=second.panel.exportMaterials();
  await vi.waitFor(()=>expect(file.close).toHaveBeenCalledOnce());second.unmount();
  commit.reject(Error('无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载'));await firstWork;
  close.reject(Error('save failed'));await secondWork;
  const next=await mount({surface});expect(next.panel.lateBackupWarning).toContain('无法确认备份下载状态');
  await activate(next,namedButton(next,'知道了'));expect(next.panel.lateBackupWarning).toContain('保存位置');
  await activate(next,namedButton(next,'知道了'));expect(next.panel.lateBackupWarning).toBe('');
});
it('keeps separate warnings when distinct cancelled operations fail with the same message',async()=>{
  const first=await mount(),surface={document:first.document,window:first.window} as ReturnType<typeof parseHTML>,one=deferred<'saved'>();
  const target1={write:async()=>{},commit:vi.fn(()=>one.promise),abort:async()=>{}};first.browserSave.mockResolvedValueOnce({status:'ready',target:target1});
  const work1=first.panel.exportMaterials();await vi.waitFor(()=>expect(target1.commit).toHaveBeenCalledOnce());first.unmount();
  const second=await mount({surface}),two=deferred<'saved'>(),target2={write:async()=>{},commit:vi.fn(()=>two.promise),abort:async()=>{}};
  second.browserSave.mockResolvedValueOnce({status:'ready',target:target2});const work2=second.panel.exportMaterials();
  await vi.waitFor(()=>expect(target2.commit).toHaveBeenCalledOnce());second.unmount();
  one.reject(Error('无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载'));await work1;
  two.reject(Error('无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载'));await work2;
  const next=await mount({surface}),message=next.panel.lateBackupWarning;expect(message).toContain('无法确认备份下载状态');
  await activate(next,namedButton(next,'知道了'));expect(next.panel.lateBackupWarning).toBe(message);
  await activate(next,namedButton(next,'知道了'));expect(next.panel.lateBackupWarning).toBe('');
});
it.each(['firefox','picker'] as const)('reports a successful %s save that settles after unmount',async kind=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,done=deferred<void>();
  const commit=vi.fn(async()=>{await done.promise;return 'saved' as const;});
  if(kind==='firefox')ui.browserSave.mockResolvedValueOnce({status:'ready',target:{write:async()=>{},commit,abort:async()=>{}}});
  else (ui.window as any).showSaveFilePicker=vi.fn(async()=>({createWritable:async()=>({write:async()=>{},close:commit,abort:async()=>{}})}));
  const work=ui.panel.exportMaterials();await vi.waitFor(()=>expect(commit).toHaveBeenCalledOnce());ui.unmount();done.resolve();await work;
  const next=await mount({surface});expect(next.panel.lateBackupStatus).toBe('此前开始的材料备份已保存，包含来源、原句与个人笔记，请妥善保管。');
  await activate(next,next.document.querySelector('button[aria-label="关闭保存结果提示"]')!);expect(next.panel.lateBackupStatus).toBe('');
});
it.each(['saved','initiated'] as const)('reports the exact %s state of a recovered temporary backup after unmount',async state=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,done=deferred<'saved'|'initiated'>();
  const target={write:async()=>{},commit:vi.fn(()=>done.promise),abort:async()=>{}};ui.recoverTemporary.mockResolvedValueOnce({status:'ready',target});
  const work=ui.panel.recoverTemporaryBackup({name:'ready',createdAt:1,bytes:1,ready:true});await vi.waitFor(()=>expect(target.commit).toHaveBeenCalledOnce());ui.unmount();
  done.resolve(state);await work;const next=await mount({surface});
  expect(next.panel.lateBackupStatus).toBe(state==='saved'?'此前开始的临时备份下载已完成，临时文件仍保留；确认后可删除。':'此前开始的临时备份下载已发起，临时文件仍保留；请确认下载完成后再处理。');
  await activate(next,next.document.querySelector('button[aria-label="关闭保存结果提示"]')!);
});
it.each([false,true])('retains the fallback URL without a duplicate initiated result when unmounted during handoff (large=%s)',async large=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>;
  if(large)ui.exportReceive.mockImplementationOnce(async(_port,consume)=>{const chunk=new Uint8Array(24*1024);for(let i=0;i<854;i++)await consume(chunk);});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:late-handoff');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{queueMicrotask(()=>ui.unmount());});
  await ui.panel.exportMaterials();const next=await mount({surface});
  expect(next.panel.lateBackupStatus).toBe(large?'此前开始的备份较大，恢复受设备空间、单份材料 128 MiB 和总计 20,000 个 128 KiB 分片的限制。请保留现有材料并妥善保存备份文件。':'');
  expect(next.panel.fallbackDownloadUrl).toBe('blob:late-handoff');
  if(large)await activate(next,next.document.querySelector('button[aria-label="关闭保存结果提示"]')!);
  await activate(next,namedButton(next,'下载已完成，释放临时数据'));
});
it('reports an unmounted cancelled recovery as a neutral prior-operation status',async()=>{
  const ui=await mount(),surface={document:ui.document,window:ui.window} as ReturnType<typeof parseHTML>,done=deferred<'saved'>();
  const target={write:async()=>{},commit:vi.fn(()=>done.promise),abort:async()=>{}};ui.recoverTemporary.mockResolvedValueOnce({status:'ready',target});
  const work=ui.panel.recoverTemporaryBackup({name:'ready',createdAt:1,bytes:1,ready:true});await vi.waitFor(()=>expect(target.commit).toHaveBeenCalledOnce());ui.unmount();
  done.reject(new DOMException('cancelled','AbortError'));await work;const next=await mount({surface});
  expect(next.panel.lateBackupWarning).toBe('');expect(next.panel.lateBackupStatus).toBe('此前开始的临时备份取回已取消。');
  expect(next.document.querySelector('button[aria-label="关闭保存结果提示"]')?.closest('[role="status"]')?.textContent).toContain('已取消');
});
it.each(['running','failed'] as const)('labels a prior save that settles while a new export is %s',async current=>{
  const first=await mount(),surface={document:first.document,window:first.window} as ReturnType<typeof parseHTML>,old=deferred<'saved'>();
  const previous={write:async()=>{},commit:vi.fn(()=>old.promise),abort:async()=>{}};first.browserSave.mockResolvedValueOnce({status:'ready',target:previous});
  const oldWork=first.panel.exportMaterials();await vi.waitFor(()=>expect(previous.commit).toHaveBeenCalledOnce());first.unmount();
  const next=await mount({surface}),pending=deferred<'saved'>(),recent={write:async()=>{},commit:vi.fn(()=>pending.promise),abort:async()=>{}};
  next.browserSave.mockResolvedValueOnce({status:'ready',target:recent});const recentWork=next.panel.exportMaterials();await vi.waitFor(()=>expect(recent.commit).toHaveBeenCalledOnce());
  if(current==='failed'){pending.reject(Error('new export failed'));await recentWork;expect(next.panel.error).toBe('new export failed');}
  old.resolve('saved');await oldWork;await next.flush();
  expect(next.panel.lateBackupStatus).toBe('此前开始的材料备份已保存，包含来源、原句与个人笔记，请妥善保管。');
  if(current==='running'){expect(next.panel.busy).toBe(true);expect(next.panel.feedback).toBe('');pending.reject(Error('new export failed'));await recentWork;}
  expect(next.panel.error).toBe('new export failed');
});
it('ignores a late temporary-file scan after closing the panel or unmounting',async()=>{
  vi.stubEnv('BROWSER','firefox');const ui=await mount(),gate=deferred<any>();ui.listTemporary.mockReturnValueOnce(gate.promise);
  const work=ui.panel.openTemporaryBackups();ui.panel.closeTemporaryBackups();gate.resolve({items:[{name:'late',createdAt:1,bytes:1,ready:true}],truncated:false,failed:0});await work;
  expect(ui.panel.showTemporaryBackups).toBe(false);expect(ui.panel.temporaryItems).toEqual([]);
  ui.listTemporary.mockRejectedValueOnce(Error('unavailable'));await ui.panel.openTemporaryBackups();expect(ui.panel.temporaryError).toBe('unavailable');
  const pending=deferred<any>();ui.listTemporary.mockReturnValueOnce(pending.promise);const loading=ui.panel.openTemporaryBackups();ui.unmount();pending.resolve({items:[],truncated:false,failed:0});await loading;
});
it('validates a chosen backup before import and displays the actual restored counts through the template',async()=>{
  const ui=await mount();const input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!;const picker=vi.spyOn(input,'click').mockImplementation(()=>{});await activate(ui,namedButton(ui,'恢复材料备份'));expect(picker).toHaveBeenCalledOnce();
  Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024,text:vi.fn()}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();expect(ui.backup.restoreLargeMaterialBackup).toHaveBeenCalledOnce();expect(ui.api.materialImport).not.toHaveBeenCalled();expect(ui.backup.acknowledgeMaterialBackup).toHaveBeenCalledWith(ui.cap);
  Object.defineProperty(input,'files',{configurable:true,value:[{size:2,text:async()=>'{}'}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();expect(ui.api.materialImport).toHaveBeenCalledOnce();expect(ui.document.body.textContent).toContain('已恢复 1 份材料');
});
it('checks a lost commit acknowledgement with the original capability before releasing it',async()=>{
  const ui=await mount(),input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  ui.backup.restoreLargeMaterialBackup.mockImplementationOnce(async(_file,_guard,options)=>{options.onCapability(ui.cap);return {kind:'unknown',commitDispatched:true,capability:ui.cap};});
  Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
  expect(ui.document.body.textContent).toContain('无法确认材料是否已恢复');expect(namedButton(ui,'恢复材料备份').hasAttribute('disabled')).toBe(true);
  await activate(ui,namedButton(ui,'检查恢复结果'));
  expect(ui.backup.queryMaterialBackup).toHaveBeenCalledWith(ui.cap);expect(ui.backup.acknowledgeMaterialBackup).toHaveBeenCalledWith(ui.cap);
  expect(ui.document.body.textContent).toContain('已恢复 1 份材料');expect(ui.panel.pendingImport).toBeUndefined();
});
it('allows a user to end an uncommitted session without reporting a false commit',async()=>{
  const ui=await mount(),input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  ui.backup.restoreLargeMaterialBackup.mockImplementationOnce(async(_file,_guard,options)=>{options.onCapability(ui.cap);return {kind:'cancelled',cleanupPending:true,capability:ui.cap};});
  Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
  expect(ui.document.body.textContent).toContain('已取消恢复');await activate(ui,namedButton(ui,'结束未完成恢复'));
  expect(ui.backup.discardMaterialBackup).toHaveBeenCalledWith(ui.cap);expect(ui.document.body.textContent).toContain('未完成的恢复已结束');expect(ui.panel.pendingImport).toBeUndefined();
});
it('lets the user stop checking an expired or unavailable result without claiming a rollback',async()=>{
  const ui=await mount(),input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  ui.backup.restoreLargeMaterialBackup.mockImplementationOnce(async(_file,_guard,options)=>{options.onCapability(ui.cap);return {kind:'unknown',commitDispatched:true,capability:ui.cap};});
  ui.backup.queryMaterialBackup.mockRejectedValueOnce(new Error('unavailable'));
  ui.backup.discardMaterialBackup.mockRejectedValueOnce(new Error('unavailable'));
  Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
  await activate(ui,namedButton(ui,'检查恢复结果'));expect(ui.document.body.textContent).toContain('暂时无法确认恢复状态');
  await activate(ui,namedButton(ui,'结束未完成恢复'));expect(ui.backup.discardMaterialBackup).toHaveBeenCalledWith(ui.cap);
  await activate(ui,namedButton(ui,'不再查询'));expect(ui.panel.pendingImport).toBeUndefined();expect(ui.document.body.textContent).toContain('恢复结果尚未确认，暂存可能仍在本机');
});
it('explains a restore size limit and retains the existing materials',async()=>{
  const ui=await mount(),input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!;
  ui.backup.restoreLargeMaterialBackup.mockResolvedValueOnce({kind:'failed',cleanupPending:false,error:Object.assign(new Error('材料记录超过恢复大小限制'),{name:'MaterialBackupCapacityError'})});
  Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
  expect(ui.document.body.textContent).toContain('材料记录超过恢复大小限制，请保留原材料和备份文件');expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['a','b']);
  expect(ui.panel.pendingImport).toBeUndefined();expect(ui.api.materialImport).not.toHaveBeenCalled();
});
it('cancels while waiting for the read-only generation and never starts a restore later',async()=>{
  const ui=await mount(),input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!,generation=deferred<number>();ui.api.materialGeneration.mockReturnValueOnce(generation.promise);
  Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
  expect(ui.panel.busy).toBe(true);expect(ui.document.querySelector('.fr-materials')?.getAttribute('aria-busy')).toBe('true');expect(ui.document.body.textContent).toContain('请保持此页面打开');await activate(ui,namedButton(ui,'取消恢复'));expect(ui.panel.busy).toBe(false);
  generation.resolve(0);await ui.flush();expect(ui.backup.restoreLargeMaterialBackup).not.toHaveBeenCalled();
});
it('retains a confirmed commit if its list refresh is cancelled and ignores the late list',async()=>{
  const ui=await mount(),input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!,late=deferred<MaterialRecord[]>();ui.api.materialList.mockReturnValueOnce(late.promise);
  Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
  expect(ui.document.body.textContent).toContain('已恢复 1 份材料');expect(ui.panel.busy).toBe(true);
  await activate(ui,namedButton(ui,'取消恢复'));expect(ui.panel.busy).toBe(false);expect(ui.panel.pendingImport).toEqual(ui.cap);
  expect(ui.document.body.textContent).toContain('材料已恢复，但列表尚未刷新');expect(ui.backup.acknowledgeMaterialBackup).not.toHaveBeenCalled();
  late.resolve([record('late')]);await ui.flush();expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['a','b']);
  await activate(ui,namedButton(ui,'检查恢复结果'));expect(ui.backup.acknowledgeMaterialBackup).toHaveBeenCalledWith(ui.cap);expect(ui.panel.pendingImport).toBeUndefined();
});
it('times out a hung list refresh without losing a confirmed recovery receipt',async()=>{
  vi.useFakeTimers();try {
    const ui=await mount(),input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    ui.api.materialList.mockReturnValueOnce(new Promise(()=>{}));
    Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
    expect(ui.panel.busy).toBe(true);await vi.advanceTimersByTimeAsync(30_000);await ui.flush();
    expect(ui.panel.busy).toBe(false);expect(ui.panel.pendingImport).toEqual(ui.cap);expect(ui.document.body.textContent).toContain('材料已恢复，但列表尚未刷新');expect(ui.backup.acknowledgeMaterialBackup).not.toHaveBeenCalled();
  } finally {vi.useRealTimers();}
});
it('keeps source text visible when stored source or learning memories cannot be read, retries, and follows a broadcast refresh',async()=>{
  const damaged: MaterialRecord={...record(),source:{kind:'article',url:'not-a-url'},references:[{kind:'memory',id:'memory-a',excerpt:'A recoverable original.'}]};
  const memories=vi.fn().mockRejectedValueOnce(new Error('Memory unavailable')).mockResolvedValue([{id:'memory-a',content:'Restored memory.'}]);
  const ui=await mount({list:async()=>[damaged],memories});expect(ui.document.body.textContent).toContain('来源待恢复');await activate(ui,ui.document.querySelector('[data-material-id="a"]')!);
  expect(ui.document.body.textContent).toContain('A recoverable original.');expect(ui.document.body.textContent).toContain('部分学习内容读取失败');expect(ui.document.body.textContent).toContain('来源地址已失效');
  await activate(ui,namedButton(ui,'重试'));expect(ui.document.body.textContent).toContain('Restored memory.');expect(ui.document.body.textContent).not.toContain('部分学习内容读取失败');
  ui.api.materialList.mockResolvedValueOnce([record('new')]);ui.notify();await ui.flush();expect(ui.document.querySelector('[data-material-id="new"]')).toBeTruthy();expect(ui.document.querySelector('.fr-material-detail')).toBeNull();
});

describe('material workspace hidden accepted actions and focus ownership',()=>{
  async function visibility(ui:Awaited<ReturnType<typeof mount>>,shown:import('vue').Ref<boolean>,value:boolean){shown.value=value;await ui.flush();}

  it('continues accepted note generation and acknowledgement while hidden and does not restore the saved draft',async()=>{
    const shown=runtime.ref(true),ui=await mount({shown});await ui.panel.select('a');ui.panel.note='Accepted hidden note';
    const generation=deferred<number>(),write=deferred<MaterialRecord>();ui.api.materialGeneration.mockReturnValueOnce(generation.promise);ui.api.materialCapture.mockReturnValueOnce(write.promise);
    const saving=ui.panel.saveNote();expect(ui.panel.busy).toBe(true);await visibility(ui,shown,false);generation.resolve(3);await ui.flush();
    expect(ui.api.materialCapture).toHaveBeenCalledWith(expect.objectContaining({generation:3,reference:expect.objectContaining({note:'Accepted hidden note'})}));
    const updated={...record(),references:[{kind:'note' as const,id:'saved',note:'Accepted hidden note'}]};write.resolve(updated);await saving;
    expect(ui.panel.busy).toBe(false);expect(ui.panel.note).toBe('');expect(ui.panel.feedback).toContain('笔记已保存');
    ui.api.materialList.mockResolvedValue([updated,record('b')]);await visibility(ui,shown,true);expect(ui.panel.note).toBe('');expect(ui.panel.busy).toBe(false);
  });

  it('keeps a failed accepted note draft and clears busy while hidden, then permits retry after activation',async()=>{
    const shown=runtime.ref(true),ui=await mount({shown});await ui.panel.select('a');ui.panel.note='Retry this hidden note';
    const generation=deferred<number>();ui.api.materialGeneration.mockReturnValueOnce(generation.promise);ui.api.materialCapture.mockRejectedValueOnce(new Error('Hidden note write failed'));
    const saving=ui.panel.saveNote();await visibility(ui,shown,false);generation.resolve(0);await saving;
    expect(ui.panel.busy).toBe(false);expect(ui.panel.note).toBe('Retry this hidden note');expect(ui.panel.error).toBe('Hidden note write failed');
    await visibility(ui,shown,true);await ui.panel.saveNote();expect(ui.api.materialCapture).toHaveBeenCalledTimes(2);expect(ui.panel.note).toBe('');expect(ui.panel.busy).toBe(false);
  });

  it.each(['file-read','import-ack','followup-list'] as const)('finishes an accepted import hidden during %s without losing completion or busy cleanup',async stage=>{
    const shown=runtime.ref(true),ui=await mount({shown}),bytes=deferred<string>(),write=deferred<{inserted:number;updated:number;skipped:number}>(),listing=deferred<MaterialRecord[]>();
    const imported=[record('imported')],counts={inserted:2,updated:0,skipped:0};
    ui.api.materialImport.mockImplementationOnce(()=>stage==='import-ack'?write.promise:Promise.resolve(counts));
    ui.api.materialList.mockImplementationOnce(()=>stage==='followup-list'?listing.promise:Promise.resolve(imported));
    const importing=ui.panel.importMaterials({target:{files:[{size:2,text:()=>stage==='file-read'?bytes.promise:Promise.resolve('{}')}],value:'backup'}});await ui.flush();expect(ui.panel.busy).toBe(true);
    if(stage!=='file-read')expect(ui.api.materialImport).toHaveBeenCalledOnce();
    await visibility(ui,shown,false);
    if(stage==='file-read')bytes.resolve('{}');else if(stage==='import-ack')write.resolve(counts);else listing.resolve(imported);
    await importing;expect(ui.api.materialImport).toHaveBeenCalledOnce();expect(ui.panel.feedback).toContain('已恢复 2 份材料');expect(ui.panel.busy).toBe(false);
    ui.api.materialList.mockResolvedValue(imported);await visibility(ui,shown,true);expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['imported']);expect(ui.panel.busy).toBe(false);expect(ui.panel.feedback).toContain('已恢复 2 份材料');
  });

  it.each(['success','download-failure','storage-failure'] as const)('settles an accepted export after hiding with %s and preserves pending downloads',async outcome=>{
    const shown=runtime.ref(true),ui=await mount({shown}),exported=deferred<void>();ui.exportReceive.mockImplementationOnce(async(_port,consume)=>{await exported.promise;await consume(new TextEncoder().encode('{}'));});
    const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:hidden-materials'),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{}),downloads:Element[]=[];
    vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){if(this.tagName==='A'){downloads.push(this);if(outcome==='download-failure')throw new Error('Download failed');}});
    const exporting=ui.panel.exportMaterials();await visibility(ui,shown,false);
    if(outcome==='storage-failure')exported.reject(new Error('Export storage failed'));else exported.resolve();
    await exporting;expect(ui.panel.busy).toBe(false);
    if(outcome==='storage-failure'){expect(create).not.toHaveBeenCalled();expect(revoke).not.toHaveBeenCalled();expect(ui.panel.error).toBe('Export storage failed');}
    else {expect(create).toHaveBeenCalledOnce();expect(downloads).toHaveLength(1);if(outcome==='success'){expect(revoke).not.toHaveBeenCalled();expect(ui.panel.feedback).toContain('已发起材料备份下载');}else {expect(revoke).toHaveBeenCalledWith('blob:hidden-materials');expect(ui.panel.error).toBe('Download failed');}}
    await visibility(ui,shown,true);expect(ui.panel.busy).toBe(false);
    if(outcome==='success'){await activate(ui,namedButton(ui,'下载已完成，释放临时数据'));expect(revoke).toHaveBeenCalledWith('blob:hidden-materials');}
  });

  it('remembers a list read interrupted by accepted export and refreshes once after returning idle and visible',async()=>{
    const shown=runtime.ref(true),first=deferred<MaterialRecord[]>();let lists=0;
    const ui=await mount({shown,list:()=>++lists===1?first.promise:Promise.resolve([record('refreshed')])}),exported=deferred<void>();expect(ui.panel.loading).toBe(true);ui.exportReceive.mockImplementationOnce(async(_port,consume)=>{await exported.promise;await consume(new TextEncoder().encode('{}'));});
    vi.spyOn(ui.window,'setTimeout').mockImplementation((()=>1) as unknown as typeof window.setTimeout);
    const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:pending-list');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
    const exporting=ui.panel.exportMaterials();await visibility(ui,shown,false);first.resolve([record('obsolete')]);exported.resolve();await exporting;await ui.flush();
    expect(ui.panel.busy).toBe(false);expect(ui.api.materialList).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledOnce();
    await visibility(ui,shown,true);expect(ui.api.materialList).toHaveBeenCalledTimes(2);expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['refreshed']);
  });

  it.each(['success','failure'] as const)('preserves the export failure during automatic refresh %s until an explicit user refresh',async outcome=>{
    const ui=await mount(),interrupted=deferred<MaterialRecord[]>(),automatic=deferred<MaterialRecord[]>(),exported=deferred<void>();
    ui.api.materialList.mockReturnValueOnce(interrupted.promise).mockReturnValueOnce(automatic.promise).mockResolvedValueOnce([record('explicit')]);ui.exportReceive.mockImplementationOnce(async()=>exported.promise);
    const reloading=ui.panel.reload();await ui.flush();expect(ui.panel.loading).toBe(true);
    namedButton(ui,'导出材料备份').dispatchEvent(new ui.window.Event('click',{bubbles:true}));await ui.flush();expect(ui.panel.busy).toBe(true);
    exported.reject(new Error('Original export failure'));await ui.flush();expect(ui.api.materialList).toHaveBeenCalledTimes(3);
    const duringAutomatic=ui.document.querySelector('[role="alert"]')?.textContent||'';
    if(outcome==='success')automatic.resolve([record('automatic')]);else automatic.reject(new Error('Automatic refresh failure'));
    interrupted.resolve([record('obsolete')]);await reloading;await ui.flush();const afterAutomatic=ui.document.querySelector('[role="alert"]')?.textContent||'';
    expect(ui.panel.busy).toBe(false);expect(ui.panel.loading).toBe(false);
    ui.api.materialList.mockResolvedValue([record('explicit')]);
    await activate(ui,namedButton(ui,'刷新材料'));const afterExplicit=ui.document.querySelector('[role="alert"]')?.textContent||'';
    if(process.env.FLUENTREAD_MATERIAL_RECOVERY_METRICS==='1')console.info(`MATERIAL_EXPORT_RECOVERY ${JSON.stringify({outcome,duringAutomatic,afterAutomatic,afterExplicit,listRequests:ui.api.materialList.mock.calls.length})}`);
    expect(duringAutomatic).toContain('Original export failure');expect(afterAutomatic).toContain('Original export failure');expect(afterAutomatic).not.toContain('Automatic refresh failure');expect(afterExplicit).toBe('');
    expect(ui.api.materialList.mock.calls.length).toBeGreaterThanOrEqual(4);expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['explicit']);
  });

  it.each(['success','failure'] as const)('preserves a newer backup validation error after an already pending automatic refresh %s',async outcome=>{
    const ui=await mount(),automatic=deferred<MaterialRecord[]>();ui.api.materialList.mockReturnValueOnce(automatic.promise).mockResolvedValueOnce([record('retried')]);
    ui.notify();await ui.flush();expect(ui.panel.loading).toBe(true);expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    const input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!,read=vi.fn(async()=>'{');
    Object.defineProperty(input,'files',{configurable:true,value:[{size:2,text:read}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
    expect(ui.document.querySelector('[role="alert"]')?.textContent).toContain('备份文件无法读取');expect(read).toHaveBeenCalledOnce();expect(ui.api.materialImport).not.toHaveBeenCalled();
    if(outcome==='success')automatic.resolve([record('automatic')]);else automatic.reject(new Error('Automatic read failure after validation'));
    await ui.flush();const afterAutomatic=ui.document.querySelector('[role="alert"]')?.textContent||'';
    ui.api.materialList.mockResolvedValueOnce([record('retried')]);await activate(ui,namedButton(ui,'重试'));const afterExplicit=ui.document.querySelector('[role="alert"]')?.textContent||'';
    if(process.env.FLUENTREAD_MATERIAL_RECOVERY_METRICS==='1')console.info(`MATERIAL_VALIDATION_RECOVERY ${JSON.stringify({outcome,afterAutomatic,afterExplicit,listRequests:ui.api.materialList.mock.calls.length})}`);
    expect(afterAutomatic).toContain('备份文件无法读取');expect(afterAutomatic).not.toContain('Automatic read failure after validation');expect(afterExplicit).toBe('');expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['retried']);
  });

  it.each(['edit-note','start-edit','cancel-edit','back-to-list'] as const)('does not run the queued %s focus after KeepAlive deactivation',async action=>{
    const shown=runtime.ref(true),ui=await mount({shown});await ui.panel.select('a');await ui.flush();
    if(action==='cancel-edit'){ui.panel.startEdit();await ui.flush();}
    const focus=vi.spyOn(ui.window.HTMLElement.prototype,'focus').mockImplementation(()=>{});
    if(action==='edit-note')ui.panel.editNote(record().references[0]);else if(action==='start-edit')ui.panel.startEdit();else if(action==='cancel-edit')ui.panel.cancelEdit();else ui.panel.backToList();
    shown.value=false;await ui.flush();expect(focus).not.toHaveBeenCalled();
  });

  it('finishes an accepted material save across hide-show ABA without reclaiming old focus',async()=>{
    const shown=runtime.ref(true),ui=await mount({shown});await ui.panel.select('a');ui.panel.startEdit();await ui.flush();ui.panel.draft.title='Accepted title';
    const write=deferred<MaterialRecord>();ui.api.materialUpdate.mockReturnValueOnce(write.promise);const organize=namedButton(ui,'整理材料'),focus=vi.spyOn(organize,'focus').mockImplementation(()=>{});
    const saving=ui.panel.saveEdit();await visibility(ui,shown,false);await visibility(ui,shown,true);const updated={...record(),title:'Accepted title'};ui.api.materialList.mockResolvedValue([updated,record('b')]);write.resolve(updated);await saving;await ui.flush();
    expect(ui.panel.materials.find((item:MaterialRecord)=>item.id==='a').title).toBe('Accepted title');expect(ui.panel.editing).toBe(false);expect(ui.panel.busy).toBe(false);expect(focus).not.toHaveBeenCalled();
  });
});

describe('material workspace reference equality on reload',()=>{
  type Reference=MaterialRecord['references'][number];
  const sentinel:Reference={kind:'session',id:'reference-sentinel',createdAt:1};
  const snapshot=(references:Reference[],lastReadAt=2):MaterialRecord=>({...record('references'),references:references.map(reference=>({...reference})),lastReadAt});
  function sessionReader(){let revision=1;const session=vi.fn(async(id:string)=>({id,text:`Resolved ${id} revision ${revision}`,turns:[]}));return {session,next:()=>revision++};}
  function report(scenario:string,data:object){if(process.env.FLUENTREAD_MATERIAL_REFERENCE_METRICS==='1')console.info(`MATERIAL_REFERENCE_OPERATIONS ${JSON.stringify({scenario,...data})}`);}

  it.each([{name:'medium',count:200,excerpt:1000,note:1000},{name:'maximum',count:1000,excerpt:6000,note:12000}])('avoids reference JSON output for three timestamp-only refreshes of the $name legal fixture',async fixture=>{
    const references:Reference[]=Array.from({length:fixture.count},(_,index)=>({kind:'note',id:`REF-JSON-${index}`,excerpt:'x'.repeat(fixture.excerpt),note:'y'.repeat(fixture.note),createdAt:1,updatedAt:2}));
    const arrays=new WeakSet<object>();let time=2;const list=async()=>{const item=snapshot(references,++time);arrays.add(item.references);return [item];};
    const original=JSON.stringify;let calls=0,characters=0;
    const stringify=vi.spyOn(JSON,'stringify').mockImplementation((value,replacer,space)=>{const output=original(value,replacer as never,space);if(value&&typeof value==='object'&&arrays.has(runtime.toRaw(value))){calls++;characters+=output?.length||0;}return output;});
    try{
      const ui=await mount({list});const unselected=[] as Array<{calls:number;characters:number}>;
      for(let round=0;round<3;round++){const before={calls,characters};await ui.panel.reload();await ui.flush();unselected.push({calls:calls-before.calls,characters:characters-before.characters});stringify.mockClear();}
      await ui.panel.select('references');await ui.flush();ui.panel.startEdit();ui.panel.draft.title='Unsaved reference title';ui.panel.note='Unsaved reference note';const draft=ui.panel.draft;
      const selected=[] as Array<{calls:number;characters:number}>;
      for(let round=0;round<3;round++){const before={calls,characters};await ui.panel.reload();await ui.flush();selected.push({calls:calls-before.calls,characters:characters-before.characters});stringify.mockClear();}
      report(fixture.name,{referenceCount:fixture.count,excerptCharacters:fixture.excerpt,noteCharacters:fixture.note,refreshes:3,unselected,selected,totalSelectedCalls:selected.reduce((total,item)=>total+item.calls,0),totalSelectedOutputCharacters:selected.reduce((total,item)=>total+item.characters,0)});
      expect(ui.panel.selectedId).toBe('references');expect(ui.panel.draft).toBe(draft);expect(ui.panel.draft.title).toBe('Unsaved reference title');expect(ui.panel.note).toBe('Unsaved reference note');expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(24);
      expect(unselected).toEqual(Array.from({length:3},()=>({calls:0,characters:0})));expect(selected).toEqual(Array.from({length:3},()=>({calls:0,characters:0})));
    }finally{stringify.mockRestore();}
  });

  const changes:Array<{name:string;before:Reference;after:Reference;visible?:string}>=[
    {name:'reference kind',before:{kind:'note',id:'target',excerpt:'Retained source',createdAt:1},after:{kind:'session',id:'target',excerpt:'Retained source',createdAt:1},visible:'Resolved target revision 2'},
    {name:'reference identity',before:{kind:'session',id:'old-session',createdAt:1},after:{kind:'session',id:'new-session',createdAt:1},visible:'Resolved new-session revision 2'},
    {name:'saved excerpt',before:{kind:'note',id:'target',excerpt:'Old excerpt',createdAt:1},after:{kind:'note',id:'target',excerpt:'New excerpt',createdAt:1},visible:'New excerpt'},
    {name:'saved note',before:{kind:'note',id:'target',note:'Old note',createdAt:1},after:{kind:'note',id:'target',note:'New note',createdAt:1},visible:'New note'},
    {name:'creation timestamp',before:{kind:'note',id:'target',createdAt:1},after:{kind:'note',id:'target',createdAt:2}},
    {name:'note update timestamp',before:{kind:'note',id:'target',createdAt:1,updatedAt:2},after:{kind:'note',id:'target',createdAt:1,updatedAt:3}},
  ];
  it.each(changes)('reloads resolved content after an authoritative $name change and retains current drafts',async change=>{
    const reader=sessionReader(),ui=await mount({list:async()=>[snapshot([sentinel,change.before])],session:reader.session});await ui.panel.select('references');await ui.flush();
    ui.panel.startEdit();ui.panel.draft.title='Draft stays';ui.panel.note='Note draft stays';const draft=ui.panel.draft;reader.session.mockClear();reader.next();
    ui.api.materialList.mockResolvedValueOnce([snapshot([sentinel,change.after],3)]);await ui.panel.reload();await ui.flush();
    expect(reader.session).toHaveBeenCalledWith('reference-sentinel');expect(reader.session.mock.calls.filter(([id])=>id==='reference-sentinel')).toHaveLength(1);
    expect(ui.document.body.textContent).toContain('Resolved reference-sentinel revision 2');if(change.visible)expect(ui.document.body.textContent).toContain(change.visible);
    expect(ui.panel.selectedId).toBe('references');expect(ui.panel.draft).toBe(draft);expect(ui.panel.draft.title).toBe('Draft stays');expect(ui.panel.note).toBe('Note draft stays');
  });

  it('treats absent optionals, explicit undefined and property insertion order as the same saved reference',async()=>{
    const reader=sessionReader(),ui=await mount({list:async()=>[snapshot([sentinel,{kind:'note',id:'equivalent',createdAt:1}])],session:reader.session});await ui.panel.select('references');await ui.flush();reader.session.mockClear();
    const equivalents:Reference[]=[{kind:'note',id:'equivalent',excerpt:undefined,note:undefined,updatedAt:undefined,createdAt:1},{createdAt:1,id:'equivalent',kind:'note'},{kind:'note',id:'equivalent',createdAt:1}];
    for(const reference of equivalents){ui.api.materialList.mockResolvedValueOnce([snapshot([sentinel,reference],3)]);await ui.panel.reload();await ui.flush();}
    expect(reader.session).toHaveBeenCalledTimes(3);expect(ui.document.body.textContent).toContain('Resolved reference-sentinel revision 1');expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(2);
  });

  it('refreshes the current prefix for reordered, added and removed authoritative references',async()=>{
    const first:Reference={kind:'session',id:'first',createdAt:1},second:Reference={kind:'session',id:'second',createdAt:1};
    const reader=sessionReader(),ui=await mount({list:async()=>[snapshot([first,second])],session:reader.session});await ui.panel.select('references');await ui.flush();
    for(const references of [[second,first],[second,first,{kind:'session' as const,id:'third',createdAt:1}],[first]]){
      reader.session.mockClear();reader.next();ui.api.materialList.mockResolvedValueOnce([snapshot(references,3)]);await ui.panel.reload();await ui.flush();
      expect(reader.session.mock.calls.map(([id])=>id)).toEqual(references.map(reference=>reference.id));expect([...ui.document.querySelectorAll('.fr-material-reference blockquote')].map(node=>node.textContent)).toEqual(references.map(reference=>`Resolved ${reference.id} revision ${references.length===2?2:references.length===3?3:4}`));
    }
  });

  it('re-reads the full currently shown detail prefix when only a reference beyond it changes',async()=>{
    const references:Reference[]=Array.from({length:49},(_,index)=>({kind:'session',id:`paged-${index}`,createdAt:1}));
    const reader=sessionReader(),ui=await mount({list:async()=>[snapshot(references)],session:reader.session});await ui.panel.select('references');await ui.flush();await activate(ui,namedButton(ui,'显示更多学习内容'));expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(48);reader.session.mockClear();reader.next();
    const changed=references.map(reference=>({...reference}));changed[48].excerpt='Tail changed outside the shown prefix';ui.api.materialList.mockResolvedValueOnce([snapshot(changed,3)]);await ui.panel.reload();await ui.flush();
    expect(reader.session.mock.calls.map(([id])=>id)).toEqual(references.slice(0,48).map(reference=>reference.id));expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(48);expect(ui.document.body.textContent).toContain('Resolved paged-47 revision 2');expect(ui.document.body.textContent).not.toContain('Tail changed outside the shown prefix');
  });

  it('replaces a pending old detail read with the authoritative reload without losing selection or drafts',async()=>{
    const old=deferred<unknown>(),session=vi.fn((id:string)=>id==='old-detail'?old.promise:Promise.resolve({id,text:'Authoritative fresh detail',turns:[]}));
    const ui=await mount({list:async()=>[snapshot([{kind:'session',id:'old-detail',createdAt:1}])],session});await ui.panel.select('references');await ui.flush();expect(ui.panel.detailLoading).toBe(true);
    ui.panel.startEdit();ui.panel.draft.title='Pending draft';ui.panel.note='Pending note';const draft=ui.panel.draft;
    ui.api.materialList.mockResolvedValueOnce([snapshot([{kind:'session',id:'new-detail',createdAt:1}],3)]);await ui.panel.reload();await ui.flush();expect(session).toHaveBeenCalledWith('new-detail');expect(ui.document.body.textContent).toContain('Authoritative fresh detail');
    old.resolve({id:'old-detail',text:'Obsolete late detail',turns:[]});await ui.flush();expect(ui.document.body.textContent).not.toContain('Obsolete late detail');expect(ui.document.body.textContent).toContain('Authoritative fresh detail');expect(ui.panel.detailLoading).toBe(false);expect(ui.panel.selectedId).toBe('references');expect(ui.panel.draft).toBe(draft);expect(ui.panel.note).toBe('Pending note');
  });
});

it('retains the exported materials URL until the user confirms the browser download is complete',async()=>{
  const ui=await mount();let live=false;
  vi.spyOn(URL,'createObjectURL').mockImplementation(()=>{live=true;return 'blob:readable';});
  const revoked=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{live=false;});
  let consume!:()=>boolean;vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){if(this.tagName==='A')consume=()=>live;});
  await activate(ui,namedButton(ui,'导出材料备份'));expect(consume()).toBe(true);expect(revoked).not.toHaveBeenCalled();
  await activate(ui,namedButton(ui,'下载已完成，释放临时数据'));expect(revoked).toHaveBeenCalledWith('blob:readable');expect(consume()).toBe(false);
});

it('falls back to a buffered download if Firefox permission or OPFS setup fails before export begins',async()=>{
  const ui=await mount();ui.browserSave.mockRejectedValueOnce(new Error('OPFS unavailable'));
  const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:fallback');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
  await activate(ui,namedButton(ui,'导出材料备份'));expect(create).toHaveBeenCalledOnce();expect(ui.document.body.textContent).toContain('已发起材料备份下载');expect(ui.panel.busy).toBe(false);
});

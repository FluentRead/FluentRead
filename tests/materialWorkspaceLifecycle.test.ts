import * as runtime from 'vue';
import {parseHTML} from 'linkedom';
import MaterialWorkspace from '@/src/features/vocabulary/ui/MaterialWorkspace.vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';
import {translateLegacyText} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

const KEY = '__fluentreadMaterialUiTest';
const dispose: Array<() => unknown> = [];
afterEach(async () => {for (const close of dispose.splice(0).reverse()) await close(); delete (globalThis as any)[KEY]; vi.restoreAllMocks(); vi.unstubAllGlobals();});
const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => {resolve=done;reject=fail;}); return {promise,resolve,reject};};
const record = (id = 'a'): MaterialRecord => ({id,identityKey:`article:https://example.test/${id}`,kind:'article',title:`Article ${id}`,source:{kind:'article',url:`https://example.test/${id}`},locator:{kind:'text',quote:'The original sentence.'},topics:['Design'],references:[{kind:'note',id:'note-1',note:'A personal thought.'}],createdAt:1,updatedAt:2,lastReadAt:2,archivedAt:null});
// Port calls resolve the current fixture, while the normal Vite SFC module retains source maps.
vi.mock('@/src/features/vocabulary/materialClient', () => Object.fromEntries([
  'materialList','materialCapture','materialUpdate','materialArchive','materialRestore',
  'materialRemoveReference','materialClear','materialExport','materialImport','materialGeneration',
].map(name => [name, (...args: unknown[]) => (globalThis as any).__fluentreadMaterialUiTest.api[name](...args)])));
vi.mock('webextension-polyfill', () => ({default: {get runtime() {return (globalThis as any).__fluentreadMaterialUiTest.browser.runtime;}}}));
vi.mock('@/src/features/reading-assistant/public', () => ({getHarnessSession: (...args: unknown[]) => (globalThis as any).__fluentreadMaterialUiTest.getSession(...args), listLearningMemories: (...args: unknown[]) => (globalThis as any).__fluentreadMaterialUiTest.memories(...args)}));
vi.mock('@/src/features/reading-assistant/ui/answer/public', () => ({ReadingAnswer: {render: () => null}}));
vi.mock('@/src/ui/dateFormat', () => ({useRenderDateFormatter: () => () => '10/15'}));
async function mount(options: {shown?: import('vue').Ref<boolean>; list?: (...args: any[]) => Promise<MaterialRecord[]>; session?: (...args: any[]) => Promise<unknown>; update?: (...args: any[]) => Promise<MaterialRecord>; memories?: () => Promise<unknown[]>; getEntry?: (message: unknown) => Promise<unknown>} = {}) {
  let items = [record(),record('b')]; let listener: ((message: unknown) => void) | undefined;
  const api = {
    materialList:vi.fn(options.list || (async () => items.map(item => structuredClone(item)))),
    materialUpdate:vi.fn(options.update || (async (id: string, patch: any) => ({...items.find(item => item.id === id)!,...patch}))),
    materialCapture:vi.fn(async (input: any) => ({...items[0], references:input.referenceMode==='update-existing'?items[0].references.map(reference=>reference.id===input.reference.id?input.reference:reference):[...items[0].references,input.reference]})),
    materialArchive:vi.fn(async (id:string) => {items=items.filter(item=>item.id!==id);return record(id);}),
    materialRestore:vi.fn(async (id:string) => record(id)),
    materialRemoveReference:vi.fn(async (id:string) => ({...record(id),references:[]})),
    materialClear:vi.fn(async()=>{items=[];return true;}),
    materialExport:vi.fn(async()=>({format:'fluentread-learning-materials',version:1,materials:items})),
    materialImport:vi.fn(async()=>({inserted:1,updated:0,skipped:0})),
    materialGeneration:vi.fn(async()=>0),
  };
  const removeListener = vi.fn();
  (globalThis as any)[KEY] = {api,getSession:options.session || (async()=>null),memories:options.memories || (async()=>[]),browser:{runtime:{getURL:(p:string)=>`chrome-extension://fixture/${p}`,sendMessage:options.getEntry || (async()=>({success:true,data:null})),onMessage:{addListener:(value:typeof listener)=>{listener=value;},removeListener}}}};
  const {document, window} = parseHTML('<html><body><main></main></body></html>');
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
  let active=true; const unmount=()=>{if(active){active=false;app.unmount();}}; dispose.push(unmount);
  const flush=async()=>{for(let i=0;i<15;i++){await Promise.resolve();await runtime.nextTick();}};
  await flush();
  return {panel,api,flush,unmount,document,window,openTab,removeListener,notify:()=>listener?.({type:'fluentReadMaterialsChanged'})};
}
describe('material workspace action ownership',()=>{
  it('keeps lightweight list, topic/search and exact selected source; persists editing and notes through real clients',async()=>{
    const ui=await mount(); expect(ui.panel.materials).toHaveLength(2);expect(ui.panel.selected).toBeUndefined();
    ui.panel.query='Article a'; expect(ui.panel.filtered.map((item:MaterialRecord)=>item.id)).toEqual(['a']);
    ui.panel.query='';await ui.panel.select('a'); expect(ui.panel.resume.href).toContain('https://example.test/a?__fluentread_material=a');
    ui.panel.startEdit(); ui.panel.draft.title='Reading design';ui.panel.draft.topics='Design, Language'; await ui.panel.saveEdit();
    expect(ui.api.materialUpdate).toHaveBeenCalledWith('a',expect.objectContaining({title:'Reading design',topics:['Design','Language']}));expect(ui.panel.selected.title).toBe('Reading design');
    ui.panel.note='My understanding'; await ui.panel.saveNote(); expect(ui.api.materialCapture).toHaveBeenCalledWith(expect.objectContaining({reference:expect.objectContaining({kind:'note',note:'My understanding'})}));expect(ui.panel.note).toBe('');
    await ui.panel.removeNote({kind:'note',id:'note-1'});expect(ui.api.materialRemoveReference).toHaveBeenCalledWith('a','note','note-1');
  });
  it('archives without deleting learning records and restores from separate removed list',async()=>{
    const ui=await mount();await ui.panel.select('a');await ui.panel.archiveSelected();expect(ui.panel.selected).toBeUndefined();expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['b']);
    ui.panel.toggleArchive();await ui.flush();expect(ui.api.materialList).toHaveBeenLastCalledWith({archived:true});expect(ui.panel.archived).toBe(true);
    ui.panel.materials=[{...record('a'),archivedAt:3}];await ui.panel.select('a');await ui.panel.restoreSelected();expect(ui.api.materialRestore).toHaveBeenCalledWith('a');expect(ui.panel.materials).toEqual([]);
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
    write.reject(new Error('Local write unavailable'));await saving;expect(ui.panel.error).toBe('Local write unavailable');await ui.panel.select('a');
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
    ui.panel.backToList();write.resolve(record());await saving;await ui.panel.select('a');
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
    const archived={...record(),archivedAt:5};write.resolve(archived);await saving;expect(ui.panel.selected).toBeUndefined();
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
  await editField(ui,search,'unmatched');expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(0);
  await activate(ui,namedButton(ui,'清除筛选'));expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(2);
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
  namedButton(ui,'保存').closest('form')!.dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));await ui.flush();expect(ui.api.materialUpdate).toHaveBeenCalledWith('a',expect.not.objectContaining({source:expect.anything()}));
  await activate(ui,ui.document.querySelector('[data-material-id="video"]')!);expect(ui.document.body.textContent).toContain('上次看到 1:05');
});
it('paginates material and reference lists, resets the visible page for search, and navigates from an empty library',async()=>{
  const list=Array.from({length:35},(_,i)=>({...record(String(i)),topics:i%2?['Language']:['Design'],references:Array.from({length:25},(_,j)=>({kind:'note' as const,id:`note-${j}`,note:`Note ${j}`}))}));
  const ui=await mount({list:async()=>list});expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30);
  await activate(ui,namedButton(ui,'显示更多材料（30 / 35）'));expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(35);
  await editField(ui,ui.document.querySelector('input[type="search"]')!,'Article');expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30);
  await activate(ui,ui.document.querySelector('[data-material-id="0"]')!);expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(24);
  await activate(ui,namedButton(ui,'显示更多学习内容'));expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(25);
  await activate(ui,namedButton(ui,'清空全部材料'));expect(ui.api.materialClear).not.toHaveBeenCalled();await activate(ui,namedButton(ui,'取消'));expect(ui.api.materialClear).not.toHaveBeenCalled();
  await activate(ui,namedButton(ui,'清空全部材料'));await activate(ui,namedButton(ui,'确认清空'));expect(ui.document.body.textContent).toContain('从一段值得留下的原文开始');await activate(ui,namedButton(ui,'查看我的收藏'));expect(ui.openTab).toHaveBeenCalledWith('saved');
});
it('超大备份提醒在所有界面语言都有实际译文',()=>{
  registerAllUiLanguageBundles();
  const message='此备份超过 20 MB，当前版本无法恢复。请保留现有材料，并妥善保存备份文件。';
  expect(translateLegacyText(message,'zh-CN')).toBe(message);
  for (const language of ['en-US','es-ES','fr-FR','ja-JP','ko-KR','ru-RU'] as const) {
    expect(translateLegacyText(message,language)).not.toBe(message);
    expect(translateLegacyText(message,language).length).toBeGreaterThan(20);
  }
});
it('提醒超大导出文件无法在当前版本恢复，并仍然保留下载',async()=>{
  const ui=await mount();
  const oversized={format:'fluentread-learning-materials',version:1,materials:[],padding:'x'.repeat(20*1024*1024)};
  ui.api.materialExport.mockResolvedValue(oversized);
  const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:oversize');
  const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(ui.window,'setTimeout').mockImplementation((()=>1) as unknown as typeof window.setTimeout);
  const click=vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
  await activate(ui,namedButton(ui,'导出材料备份'));
  expect(create).toHaveBeenCalledOnce();expect(click).toHaveBeenCalledOnce();
  expect(ui.document.querySelector('[role="alert"]')?.textContent).toContain('当前版本无法恢复');
  expect(ui.document.body.textContent).toContain('请保留现有材料');
  expect(revoke).not.toHaveBeenCalled();
});
it('不把恰好处于恢复大小上限的导出错误标记为不可恢复',async()=>{
  const ui=await mount();const data={format:'fluentread-learning-materials',version:1,materials:[],padding:''};
  data.padding='x'.repeat(20*1024*1024-JSON.stringify(data,null,2).length);
  ui.api.materialExport.mockResolvedValue(data);
  const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:at-limit');
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(ui.window,'setTimeout').mockImplementation((()=>1) as unknown as typeof window.setTimeout);
  vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
  await activate(ui,namedButton(ui,'导出材料备份'));
  expect((create.mock.calls[0][0] as Blob).size).toBe(20*1024*1024);
  expect(ui.document.querySelector('[role="alert"]')).toBeNull();
  expect(ui.document.body.textContent).toContain('材料备份已导出');
});
it('exports through the rendered action, releases its download URL and reports a retryable storage failure',async()=>{
  const ui=await mount();const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:materials');const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  const scheduled:Array<()=>void>=[];vi.spyOn(ui.window,'setTimeout').mockImplementation(((callback:()=>void)=>{scheduled.push(callback);return 1;}) as typeof window.setTimeout);
  const downloads: string[]=[];vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){if(this.tagName==='A')downloads.push((this as HTMLAnchorElement).download);});
  await activate(ui,namedButton(ui,'导出材料备份'));expect(create).toHaveBeenCalledOnce();expect(revoke).not.toHaveBeenCalled();scheduled.shift()!();expect(revoke).toHaveBeenCalledWith('blob:materials');expect(downloads[0]).toMatch(/^fluentread-materials-.*\.json$/u);expect(ui.document.body.textContent).toContain('材料备份已导出');
  ui.api.materialExport.mockRejectedValueOnce(new Error('Export unavailable'));await activate(ui,namedButton(ui,'导出材料备份'));expect(ui.document.body.textContent).toContain('Export unavailable');expect(ui.panel.busy).toBe(false);
  await activate(ui,namedButton(ui,'导出材料备份'));expect(downloads).toHaveLength(2);
});
it('validates a chosen backup before import and displays the actual restored counts through the template',async()=>{
  const ui=await mount();const input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!;const picker=vi.spyOn(input,'click').mockImplementation(()=>{});await activate(ui,namedButton(ui,'恢复材料备份'));expect(picker).toHaveBeenCalledOnce();
  Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024,text:vi.fn()}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();expect(ui.document.body.textContent).toContain('超过 20 MB');expect(ui.api.materialImport).not.toHaveBeenCalled();
  Object.defineProperty(input,'files',{configurable:true,value:[{size:2,text:async()=>'{}'}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();expect(ui.api.materialImport).toHaveBeenCalledOnce();expect(ui.document.body.textContent).toContain('已恢复 1 份材料');
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
    expect(ui.panel.busy).toBe(false);expect(ui.panel.note).toBe('');expect(ui.panel.feedback).toContain('笔记已保存');expect(ui.panel.materials[0].references).toEqual(updated.references);
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
    await importing;expect(ui.api.materialImport).toHaveBeenCalledOnce();expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['imported']);expect(ui.panel.feedback).toContain('已恢复 2 份材料');expect(ui.panel.busy).toBe(false);
    ui.api.materialList.mockResolvedValue(imported);await visibility(ui,shown,true);expect(ui.panel.busy).toBe(false);expect(ui.panel.feedback).toContain('已恢复 2 份材料');
  });

  it.each(['success','download-failure','storage-failure'] as const)('settles an accepted export after hiding with %s and releases every created URL',async outcome=>{
    const shown=runtime.ref(true),ui=await mount({shown}),exported=deferred<Awaited<ReturnType<typeof ui.api.materialExport>>>();ui.api.materialExport.mockReturnValueOnce(exported.promise);
    const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:hidden-materials'),revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{}),downloads:Element[]=[];
    const scheduled:Array<()=>void>=[];vi.spyOn(ui.window,'setTimeout').mockImplementation(((callback:()=>void)=>{scheduled.push(callback);return 1;}) as typeof window.setTimeout);
    vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){if(this.tagName==='A'){downloads.push(this);if(outcome==='download-failure')throw new Error('Download failed');}});
    const exporting=ui.panel.exportMaterials();await visibility(ui,shown,false);
    if(outcome==='storage-failure')exported.reject(new Error('Export storage failed'));else exported.resolve({format:'fluentread-learning-materials',version:1,materials:[record()]});
    await exporting;expect(ui.panel.busy).toBe(false);
    if(outcome==='storage-failure'){expect(create).not.toHaveBeenCalled();expect(revoke).not.toHaveBeenCalled();expect(ui.panel.error).toBe('Export storage failed');}
    else {expect(create).toHaveBeenCalledOnce();expect(downloads).toHaveLength(1);if(outcome==='success'){expect(revoke).not.toHaveBeenCalled();scheduled.shift()!();}expect(revoke).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledWith('blob:hidden-materials');if(outcome==='success')expect(ui.panel.feedback).toContain('材料备份已导出');else expect(ui.panel.error).toBe('Download failed');}
    await visibility(ui,shown,true);expect(ui.panel.busy).toBe(false);
  });

  it('remembers a list read interrupted by accepted export and refreshes once after returning idle and visible',async()=>{
    const shown=runtime.ref(true),first=deferred<MaterialRecord[]>();let lists=0;
    const ui=await mount({shown,list:()=>++lists===1?first.promise:Promise.resolve([record('refreshed')])}),exported=deferred<Awaited<ReturnType<typeof ui.api.materialExport>>>();expect(ui.panel.loading).toBe(true);ui.api.materialExport.mockReturnValueOnce(exported.promise);
    vi.spyOn(ui.window,'setTimeout').mockImplementation((()=>1) as unknown as typeof window.setTimeout);
    const create=vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:pending-list');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});
    const exporting=ui.panel.exportMaterials();await visibility(ui,shown,false);first.resolve([record('obsolete')]);exported.resolve({format:'fluentread-learning-materials',version:1,materials:[]});await exporting;await ui.flush();
    expect(ui.panel.busy).toBe(false);expect(ui.api.materialList).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledOnce();
    await visibility(ui,shown,true);expect(ui.api.materialList).toHaveBeenCalledTimes(2);expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['refreshed']);
  });

  it.each(['success','failure'] as const)('preserves the export failure during automatic refresh %s until an explicit user refresh',async outcome=>{
    const ui=await mount(),interrupted=deferred<MaterialRecord[]>(),automatic=deferred<MaterialRecord[]>(),exported=deferred<Awaited<ReturnType<typeof ui.api.materialExport>>>();
    ui.api.materialList.mockReturnValueOnce(interrupted.promise).mockReturnValueOnce(automatic.promise).mockResolvedValueOnce([record('explicit')]);ui.api.materialExport.mockReturnValueOnce(exported.promise);
    const reloading=ui.panel.reload();await ui.flush();expect(ui.panel.loading).toBe(true);
    namedButton(ui,'导出材料备份').dispatchEvent(new ui.window.Event('click',{bubbles:true}));await ui.flush();expect(ui.panel.busy).toBe(true);
    exported.reject(new Error('Original export failure'));await ui.flush();expect(ui.api.materialList).toHaveBeenCalledTimes(3);
    const duringAutomatic=ui.document.querySelector('[role="alert"]')?.textContent||'';
    if(outcome==='success')automatic.resolve([record('automatic')]);else automatic.reject(new Error('Automatic refresh failure'));
    interrupted.resolve([record('obsolete')]);await reloading;await ui.flush();const afterAutomatic=ui.document.querySelector('[role="alert"]')?.textContent||'';
    expect(ui.panel.busy).toBe(false);expect(ui.panel.loading).toBe(false);
    await activate(ui,namedButton(ui,'刷新材料'));const afterExplicit=ui.document.querySelector('[role="alert"]')?.textContent||'';
    if(process.env.FLUENTREAD_MATERIAL_RECOVERY_METRICS==='1')console.info(`MATERIAL_EXPORT_RECOVERY ${JSON.stringify({outcome,duringAutomatic,afterAutomatic,afterExplicit,listRequests:ui.api.materialList.mock.calls.length})}`);
    expect(duringAutomatic).toContain('Original export failure');expect(afterAutomatic).toContain('Original export failure');expect(afterAutomatic).not.toContain('Automatic refresh failure');expect(afterExplicit).toBe('');
    expect(ui.api.materialList).toHaveBeenCalledTimes(4);expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['explicit']);
  });

  it.each(['success','failure'] as const)('preserves a newer backup validation error after an already pending automatic refresh %s',async outcome=>{
    const ui=await mount(),automatic=deferred<MaterialRecord[]>();ui.api.materialList.mockReturnValueOnce(automatic.promise).mockResolvedValueOnce([record('retried')]);
    ui.notify();await ui.flush();expect(ui.panel.loading).toBe(true);expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    const input=ui.document.querySelector<HTMLInputElement>('input[type="file"]')!,read=vi.fn();
    Object.defineProperty(input,'files',{configurable:true,value:[{size:21*1024*1024,text:read}]});input.dispatchEvent(new ui.window.Event('change',{bubbles:true}));await ui.flush();
    expect(ui.document.querySelector('[role="alert"]')?.textContent).toContain('超过 20 MB');expect(read).not.toHaveBeenCalled();expect(ui.api.materialImport).not.toHaveBeenCalled();
    if(outcome==='success')automatic.resolve([record('automatic')]);else automatic.reject(new Error('Automatic read failure after validation'));
    await ui.flush();const afterAutomatic=ui.document.querySelector('[role="alert"]')?.textContent||'';
    await activate(ui,namedButton(ui,'重试'));const afterExplicit=ui.document.querySelector('[role="alert"]')?.textContent||'';
    if(process.env.FLUENTREAD_MATERIAL_RECOVERY_METRICS==='1')console.info(`MATERIAL_VALIDATION_RECOVERY ${JSON.stringify({outcome,afterAutomatic,afterExplicit,listRequests:ui.api.materialList.mock.calls.length})}`);
    expect(afterAutomatic).toContain('超过 20 MB');expect(afterAutomatic).not.toContain('Automatic read failure after validation');expect(afterExplicit).toBe('');expect(ui.panel.materials.map((item:MaterialRecord)=>item.id)).toEqual(['retried']);
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

describe('material workspace search workload and bounded memo',()=>{
  type Ui=Awaited<ReturnType<typeof mount>>;
  type Reads={excerpt:number;note:number};
  type Operations={bodyLower:number;bodyCharacters:number;queryLower:number;queryTrim:number;excerpt:number;note:number};
  type SearchMemo={items:MaterialRecord[];texts:Map<MaterialRecord,string>;remaining:number};
  const budget=4*1024*1024;
  const zero=():Operations=>({bodyLower:0,bodyCharacters:0,queryLower:0,queryTrim:0,excerpt:0,note:0});
  const difference=(after:Operations,before:Operations):Operations=>Object.fromEntries(Object.keys(after).map(key=>[key,after[key as keyof Operations]-before[key as keyof Operations]])) as Operations;
  function measured(id:string,reads:Reads,count=8,excerptLength=300,noteLength=0):MaterialRecord{
    return {...record(id),title:`MAT-BODY-${id}`,references:Array.from({length:count},(_,index)=>{
      let excerpt=`MAT-EXCERPT-${id}-${index}-`.padEnd(excerptLength,'x');
      const suffix=index===count-1?'TAIL-NEEDLE':'';
      let note=noteLength?`MAT-NOTE-${id}-${index}-`.padEnd(noteLength-suffix.length,'y')+suffix:undefined;
      return {kind:noteLength?'note' as const:'vocabulary' as const,id:`ref-${index}`,
        get excerpt(){reads.excerpt++;return excerpt;},set excerpt(value:string){excerpt=value;},
        get note(){reads.note++;return note;},set note(value:string|undefined){note=value;}};
    })};
  }
  function track(reads:Reads){
    const operations={bodyLower:0,bodyCharacters:0,queryLower:0,queryTrim:0},localeArguments:unknown[][]=[];
    const originalLower=String.prototype.toLocaleLowerCase,originalTrim=String.prototype.trim;
    const lower=vi.spyOn(String.prototype,'toLocaleLowerCase').mockImplementation(function(this:string,...args:Parameters<typeof originalLower>){
      const value=String(this);let counted=true;
      if(value.startsWith('MAT-BODY-')){operations.bodyLower++;operations.bodyCharacters+=value.length;}
      else if(value.startsWith('MAT-QUERY-'))operations.queryLower++;else counted=false;
      if(counted)localeArguments.push(args);return originalLower.apply(this,args);
    });
    const trim=vi.spyOn(String.prototype,'trim').mockImplementation(function(this:string){if(String(this).startsWith('  MAT-QUERY-'))operations.queryTrim++;return originalTrim.call(this);});
    return {snapshot:():Operations=>({...operations,...reads}),localeArguments,restore:()=>{lower.mockRestore();trim.mockRestore();}};
  }
  const ids=(ui:Ui):string[]=>(ui.panel.filtered as MaterialRecord[]).map(item=>item.id);
  const memo=(ui:Ui):SearchMemo=>ui.panel.searchMemo;
  const retained=(value:SearchMemo):number=>[...value.texts.values()].reduce((count,text)=>count+text.length,0);
  async function search(ui:Ui,value:string){await editField(ui,ui.document.querySelector('input[type="search"]')!,value);}
  function report(scenario:string,data:object){if(process.env.FLUENTREAD_MATERIAL_SEARCH_METRICS==='1')console.info(`MATERIAL_SEARCH_OPERATIONS ${JSON.stringify({scenario,...data})}`);}

  it('reuses thousand-material text across twenty immediate inputs while exposing first-input dependency reads',async()=>{
    const reads={excerpt:0,note:0},probe=track(reads);
    try{
      const list=Array.from({length:1000},(_,index)=>measured(`fixture-${index}`,reads));
      const ui=await mount({list:async()=>list}),mounted=probe.snapshot();expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30);
      await search(ui,'  MAT-QUERY-0  ');const first=difference(probe.snapshot(),mounted),afterFirst=probe.snapshot();
      for(let index=1;index<20;index++)await search(ui,`  MAT-QUERY-${index}  `);
      const afterInputs=probe.snapshot(),following=difference(afterInputs,afterFirst),total=difference(afterInputs,mounted);
      await search(ui,'  MAT-QUERY-19  ');const repeated=difference(probe.snapshot(),afterInputs);
      const cached=ui.panel.searchMemo as SearchMemo|undefined;
      report('1000-materials-8-references-300-characters-20-queries',{mounted,firstInput:first,following19Inputs:following,totalInputs:total,repeatedSameInput:repeated,cachedEntries:cached?.texts.size??null,cachedCharacters:cached?retained(cached):null,remaining:cached?.remaining??null});
      expect(mounted).toEqual(zero());expect(first).toMatchObject({bodyLower:1000,queryLower:1,queryTrim:2,excerpt:16000,note:16000});
      expect(following).toEqual({bodyLower:0,bodyCharacters:0,queryLower:19,queryTrim:38,excerpt:0,note:0});
      expect(total).toMatchObject({bodyLower:1000,queryLower:20,queryTrim:40,excerpt:16000,note:16000});expect(repeated).toEqual(zero());
      expect(memo(ui).texts.size).toBe(1000);expect(retained(memo(ui))).toBeLessThanOrEqual(budget);expect(memo(ui).remaining).toBe(budget-retained(memo(ui)));
      const beforeClear=probe.snapshot();await search(ui,'');expect(difference(probe.snapshot(),beforeClear)).toEqual(zero());expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30);expect(memo(ui).texts.size).toBe(0);
      expect(probe.localeArguments.every(args=>args.length===0)).toBe(true);expect(ui.api.materialList).toHaveBeenCalledOnce();
    }finally{probe.restore();}
  });

  it('preserves joined field matching, empty slots, default locale and query normalization without expanding the searched data',async()=>{
    const primary:MaterialRecord={...record('primary'),title:'TitleTail',source:{kind:'article',url:'https://search.example/PathEnd',title:'excluded-source-title'},topics:['TopicAlpha','TopicBeta'],locator:{kind:'text',quote:'excluded-locator-quote'},references:[{kind:'note',id:'first',excerpt:'First\nLine',note:'NoteTail'},{kind:'vocabulary',id:'last',excerpt:'LastExcerpt'},{kind:'session',id:'session-ref'}]};
    const accent:MaterialRecord={...record('accent'),title:'Café IİΣΟΣ',topics:[],references:[]};
    const document:MaterialRecord={...record('document'),kind:'document',title:'DocTail',source:{kind:'document',fingerprint:'local'},identityKey:'document:fingerprint:local',topics:['DocTopic'],references:[{kind:'note',id:'doc',note:'DocNote'}]};
    const ui=await mount({list:async()=>[primary,accent,document]});await ui.panel.select('primary');await ui.flush();ui.panel.startEdit();ui.panel.draft.title='excluded-unsaved-title';ui.panel.note='excluded-unsaved-note';const draft=ui.panel.draft;
    ui.panel.resolved={'session:session-ref':{session:{text:'excluded-session-body',turns:[{id:'turn',answer:'excluded-answer'}]}},'vocabulary:last':{entry:{term:'excluded-saved-term',translations:{en:{text:'excluded-translation'}}}},'memory:unused':{memory:'excluded-memory'}};
    const cases:[string,string[]][]=[['\u00a0 TITLETAIL \t',['primary']],['search.example/pathend',['primary']],['topicbeta',['primary']],['first\nline',['primary']],['notetail',['primary']],['lastexcerpt',['primary']],['titletail https://search.example/pathend',['primary']],['pathend topicalpha',['primary']],['notetail lastexcerpt',['primary']],['doctail  doctopic',['document']],['doctail doctopic',[]],['CAFÉ',['accent']],['CAFE\u0301',[]],['IİΣΟΣ',['accent']]];
    for(const [value,expected] of cases){await search(ui,value);expect(ids(ui),JSON.stringify(value)).toEqual(expected);}
    for(const value of ['excluded-source-title','excluded-locator-quote','excluded-unsaved-title','excluded-unsaved-note','excluded-session-body','excluded-answer','excluded-saved-term','excluded-translation','excluded-memory']){await search(ui,value);expect(ids(ui),value).toEqual([]);}
    await search(ui,'İ'.toLocaleLowerCase());expect(ids(ui)).toEqual(['accent']);expect(ui.panel.selectedId).toBe('primary');expect(ui.panel.draft).toBe(draft);expect(ui.panel.note).toBe('excluded-unsaved-note');
  });

  it('invalidates same-array title, source, topic and nested reference mutations and preserves material ordering',async()=>{
    const ui=await mount({list:async()=>[{...record('mutable'),references:[{kind:'note',id:'ref'}]}]});await search(ui,'needle');const items=ui.panel.materials as MaterialRecord[],item=items[0];expect(ids(ui)).toEqual([]);
    item.title='needle title';await ui.flush();expect(ids(ui)).toEqual(['mutable']);item.title='changed';item.source.url='https://needle.example/';await ui.flush();expect(ids(ui)).toEqual(['mutable']);
    delete item.source.url;item.topics.push('needle');await ui.flush();expect(ids(ui)).toEqual(['mutable']);item.topics.splice(1,1);item.references[0].excerpt='needle excerpt';await ui.flush();expect(ids(ui)).toEqual(['mutable']);
    delete item.references[0].excerpt;item.references[0].note='needle note';await ui.flush();expect(ids(ui)).toEqual(['mutable']);delete item.references[0].note;await ui.flush();expect(ids(ui)).toEqual([]);
    item.references.push({kind:'note',id:'new',note:'needle last'});item.references.reverse();await ui.flush();expect(ids(ui)).toEqual(['mutable']);item.references[0]={kind:'note',id:'replacement',excerpt:'needle replacement'};await ui.flush();expect(ids(ui)).toEqual(['mutable']);item.references.splice(0,1);await ui.flush();expect(ids(ui)).toEqual([]);
    item.title='needle mutable';items.push({...record('next'),title:'needle next'});await ui.flush();expect(ids(ui)).toEqual(['mutable','next']);items.reverse();await ui.flush();expect(ids(ui)).toEqual(['next','mutable']);items.splice(1,1);await ui.flush();expect(ids(ui)).toEqual(['next']);expect(ui.panel.materials).toBe(items);
  });

  it('never reads reference bodies excluded by the exact topic filter and reuses eligible text',async()=>{
    const keepReads={excerpt:0,note:0},otherReads={excerpt:0,note:0};
    const ui=await mount({list:async()=>[{...measured('keep',keepReads,2),topics:['Keep']},{...measured('other',otherReads,2),topics:['Other']}]});ui.panel.topic='Keep';await ui.flush();await search(ui,'MAT-EXCERPT');
    expect(ids(ui)).toEqual(['keep']);expect(keepReads).toEqual({excerpt:4,note:4});expect(otherReads).toEqual({excerpt:0,note:0});
    await search(ui,'mat-excerpt');expect(keepReads).toEqual({excerpt:4,note:4});expect(otherReads).toEqual({excerpt:0,note:0});
    ui.panel.topic='Other';await ui.flush();expect(ids(ui)).toEqual(['other']);expect(otherReads).toEqual({excerpt:4,note:4});ui.panel.topic='other';await ui.flush();expect(ids(ui)).toEqual([]);expect(otherReads).toEqual({excerpt:4,note:4});
  });

  it('matches the tail of one legal oversized row without double lowercase and still caches later small rows',async()=>{
    const reads={excerpt:0,note:0},probe=track(reads);
    try{
      const large=measured('oversized',reads,250,6000,12000),small:MaterialRecord={...record('small'),title:'MAT-BODY-small',references:[{kind:'note',id:'small',note:'TAIL-NEEDLE'}]};
      const ui=await mount({list:async()=>[large,small]}),before=probe.snapshot();await search(ui,'TAIL-NEEDLE');expect(ids(ui)).toEqual(['oversized','small']);const first=difference(probe.snapshot(),before),afterFirst=probe.snapshot();
      await search(ui,'tail-needle');expect(ids(ui)).toEqual(['oversized','small']);const following=difference(probe.snapshot(),afterFirst),cached=ui.panel.searchMemo as SearchMemo|undefined;
      report('oversized-first-row-250-references-and-later-small-row',{firstInput:first,secondInput:following,cachedEntries:cached?.texts.size??null,cachedCharacters:cached?retained(cached):null});
      expect(first).toMatchObject({bodyLower:2,excerpt:500,note:500});expect(following).toMatchObject({bodyLower:1,excerpt:250,note:250});
      expect(memo(ui).texts.has(ui.panel.materials[0])).toBe(false);expect(memo(ui).texts.has(ui.panel.materials[1])).toBe(true);expect(retained(memo(ui))).toBeLessThanOrEqual(budget);expect(memo(ui).remaining).toBe(budget-retained(memo(ui)));
    }finally{probe.restore();}
  });

  it('bounds aggregate text and refreshes uncached reference edits, deletion and reordered records',async()=>{
    const reads={excerpt:0,note:0},first=measured('prefix',reads,120,6000,12000),overflow=measured('overflow',reads,120,6000,12000),small={...record('small'),title:'MAT-BODY-small',references:[{kind:'note' as const,id:'small',note:'TAIL-NEEDLE'}]};
    const ui=await mount({list:async()=>[first,overflow,small]});await search(ui,'TAIL-NEEDLE');expect(ids(ui)).toEqual(['prefix','overflow','small']);
    expect(memo(ui).texts.has(ui.panel.materials[0])).toBe(true);expect(memo(ui).texts.has(ui.panel.materials[1])).toBe(false);expect(memo(ui).texts.has(ui.panel.materials[2])).toBe(true);expect(retained(memo(ui))).toBeLessThanOrEqual(budget);
    await search(ui,'new-needle');expect(ids(ui)).toEqual([]);ui.panel.materials[1].references[119].note='new-needle';await ui.flush();expect(ids(ui)).toEqual(['overflow']);
    delete ui.panel.materials[1].references[119].note;await ui.flush();expect(ids(ui)).toEqual([]);ui.panel.materials[1].references.push({kind:'note',id:'extra',note:'new-needle'});await ui.flush();expect(ids(ui)).toEqual(['overflow']);
    ui.panel.materials.reverse();await ui.flush();expect(ids(ui)).toEqual(['overflow']);ui.panel.materials.splice(1,1);await ui.flush();expect(ids(ui)).toEqual([]);expect(retained(memo(ui))).toBeLessThanOrEqual(budget);
  });

  it('resets thirty-row pagination for changed queries and topics without reordering equal matches',async()=>{
    const list=Array.from({length:35},(_,index)=>({...record(String(index)),title:`Common ${index}`})),ui=await mount({list:async()=>list});
    await activate(ui,namedButton(ui,'显示更多材料（30 / 35）'));expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(35);await search(ui,'common');expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30);
    await activate(ui,namedButton(ui,'显示更多材料（30 / 35）'));await search(ui,'COMMON');expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30);expect(ids(ui)).toEqual(list.map(item=>item.id));
    await activate(ui,namedButton(ui,'显示更多材料（30 / 35）'));ui.panel.topic='Design';await ui.flush();expect(ui.document.querySelectorAll('[data-material-id]')).toHaveLength(30);expect(ids(ui)).toEqual(list.map(item=>item.id));
  });

  it.each(['',' \t\n\u00a0 '])('releases cached text and record keys for blank query %j across authoritative replacement',async value=>{
    const ui=await mount();await search(ui,'article');expect(memo(ui).texts.size).toBe(2);const previous=memo(ui);await search(ui,value);
    expect(previous.texts.size).toBe(0);expect(previous.items).toEqual([]);expect(memo(ui)).not.toBe(previous);expect(memo(ui).texts.size).toBe(0);expect(memo(ui).remaining).toBe(budget);expect(ids(ui)).toEqual(['a','b']);
    ui.api.materialList.mockResolvedValueOnce([record('replacement')]);ui.notify();await ui.flush();expect(ids(ui)).toEqual(['replacement']);expect(memo(ui).texts.size).toBe(0);expect(memo(ui).items[0].id).toBe('replacement');
  });

  it('refreshes broadcast and archive lists while search changes preserve selected material drafts',async()=>{
    const ui=await mount();await ui.panel.select('a');ui.panel.startEdit();ui.panel.draft.title='unsubmitted title';ui.panel.note='unsubmitted note';const draft=ui.panel.draft;
    await search(ui,'article');await search(ui,'personal');expect(ui.panel.selectedId).toBe('a');expect(ui.panel.draft).toBe(draft);expect(ui.panel.note).toBe('unsubmitted note');
    ui.api.materialList.mockResolvedValueOnce([{...record('a'),references:[{kind:'note',id:'remote',note:'remote-needle'}]},record('remote')]);ui.notify();await ui.flush();await search(ui,'remote-needle');expect(ids(ui)).toEqual(['a']);expect(ui.panel.selectedId).toBe('a');expect(ui.panel.draft).toBe(draft);expect(ui.panel.note).toBe('unsubmitted note');
    ui.api.materialList.mockResolvedValueOnce([{...record('archived'),archivedAt:4}]);ui.panel.toggleArchive();await ui.flush();expect(ui.panel.query).toBe('');expect(ui.panel.topic).toBe('');expect(ids(ui)).toEqual(['archived']);expect(memo(ui).texts.size).toBe(0);
    await search(ui,'article');expect(ids(ui)).toEqual(['archived']);ui.api.materialList.mockResolvedValueOnce([record('a')]);ui.panel.toggleArchive();await ui.flush();await ui.panel.select('a');expect(ui.panel.draft.title).toBe('unsubmitted title');expect(ui.panel.note).toBe('unsubmitted note');
    await search(ui,'article');await ui.panel.clearMaterials();expect(ids(ui)).toEqual([]);expect(memo(ui).texts.size).toBe(0);expect(ui.panel.selectedId).toBe('');
  });

  it.each(['clear-materials','archive-last','reload-empty','splice-empty','unmount'] as const)('actively clears a captured text Map on %s without reading a new memo',async action=>{
    const reads={excerpt:0,note:0},probe=track(reads);
    try{
      const ui=await mount({list:async()=>[measured('only',reads)]});await search(ui,'mat-body');
      if(action==='archive-last'){await ui.panel.select('only');await ui.flush();}
      const previous=memo(ui),captured=previous.texts;expect(captured.size).toBe(1);expect(previous.items).toHaveLength(1);const before=probe.snapshot();
      if(action==='clear-materials')await ui.panel.clearMaterials();
      else if(action==='archive-last')await ui.panel.archiveSelected();
      else if(action==='reload-empty'){ui.api.materialList.mockResolvedValueOnce([]);await ui.panel.reload();}
      else if(action==='splice-empty')ui.panel.materials.splice(0);
      else ui.unmount();
      // 不读 searchMemo/filtered/visibleMaterials，避免测试自身触发 lazy computed 掩盖旧 Map。
      expect(captured.size).toBe(0);expect(previous.items).toEqual([]);expect(difference(probe.snapshot(),before).bodyLower).toBe(0);
    }finally{probe.restore();}
  });
});

// 真实 SFC 刷新合同：只观察客户端解析、DOM 与 JSON 工作量，不测试 private comparator 的字段表。
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
    expect(reader.session).not.toHaveBeenCalled();expect(ui.document.body.textContent).toContain('Resolved reference-sentinel revision 1');expect(ui.document.querySelectorAll('.fr-material-reference')).toHaveLength(2);
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

it('retains the exported materials URL until the browser has time to start reading',async()=>{
  const ui=await mount();let live=false;const callbacks:Array<()=>void>=[];
  vi.spyOn(URL,'createObjectURL').mockImplementation(()=>{live=true;return 'blob:readable';});
  const revoked=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{live=false;});
  vi.spyOn(ui.window,'setTimeout').mockImplementation(((fn:()=>void,delay:number)=>{expect(delay).toBe(1000);callbacks.push(fn);return 1;}) as typeof window.setTimeout);
  let consume!:()=>boolean;vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(function(this:HTMLElement){if(this.tagName==='A')consume=()=>live;});
  await activate(ui,namedButton(ui,'导出材料备份'));expect(consume()).toBe(true);expect(revoked).not.toHaveBeenCalled();expect(callbacks).toHaveLength(1);
  callbacks[0]!();expect(revoked).toHaveBeenCalledWith('blob:readable');expect(consume()).toBe(false);
});

it('releases the material URL and reports failure if scheduling cleanup throws',async()=>{
  const ui=await mount();vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:timer-failure');const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(ui.window.HTMLElement.prototype,'click').mockImplementation(()=>{});vi.spyOn(ui.window,'setTimeout').mockImplementation(()=>{throw new Error('Timer unavailable');});
  await activate(ui,namedButton(ui,'导出材料备份'));expect(revoke).toHaveBeenCalledWith('blob:timer-failure');expect(ui.document.body.textContent).toContain('Timer unavailable');expect(ui.panel.busy).toBe(false);
});

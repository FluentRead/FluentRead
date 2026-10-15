import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin} from 'vite';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';

const KEY = '__fluentreadMaterialUiTest';
const dispose: Array<() => unknown> = [];
afterEach(async () => {for (const close of dispose.splice(0).reverse()) await close(); delete (globalThis as any)[KEY];});
const deferred = <T,>() => {let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => {resolve=done;reject=fail;}); return {promise,resolve,reject};};
const record = (id = 'a'): MaterialRecord => ({id,identityKey:`article:https://example.test/${id}`,kind:'article',title:`Article ${id}`,source:{kind:'article',url:`https://example.test/${id}`},locator:{kind:'text',quote:'The original sentence.'},topics:['Design'],references:[{kind:'note',id:'note-1',note:'A personal thought.'}],createdAt:1,updatedAt:2,lastReadAt:2,archivedAt:null});
function mocks(): Plugin {return {name:'materials-client-test',enforce:'pre',resolveId(id) {
  if (id.endsWith('/materialClient') || id === '../materialClient') return '\0materials-client';
  if (id === 'webextension-polyfill') return '\0materials-browser';
  if (id.endsWith('/reading-assistant/public')) return '\0materials-reading';
  if (id.endsWith('/reading-assistant/ui/answer/public')) return '\0materials-answer';
  if (id.endsWith('/ui/dateFormat')) return '\0materials-date';
  return null;
},load(id) {
  if (id === '\0materials-client') return `const api=globalThis.${KEY}.api; export const {materialList,materialCapture,materialUpdate,materialArchive,materialRestore,materialRemoveReference,materialClear,materialExport,materialImport,materialGeneration}=api;`;
  if (id === '\0materials-browser') return `export default globalThis.${KEY}.browser;`;
  if (id === '\0materials-reading') return `export const getHarnessSession=(...a)=>globalThis.${KEY}.getSession(...a);export const listLearningMemories=async()=>[];`;
  if (id === '\0materials-answer') return 'export const ReadingAnswer={render(){return null}};';
  if (id === '\0materials-date') return 'export const useRenderDateFormatter=()=>()=>"10/15";';
  return null;
}};}
async function mount(options: {list?: (...args: any[]) => Promise<MaterialRecord[]>; session?: (...args: any[]) => Promise<unknown>; update?: (...args: any[]) => Promise<MaterialRecord>} = {}) {
  const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
  let items = [record(),record('b')]; let listener: ((message: unknown) => void) | undefined;
  const api = {
    materialList:vi.fn(options.list || (async () => items.map(item => structuredClone(item)))),
    materialUpdate:vi.fn(options.update || (async (id: string, patch: any) => ({...items.find(item => item.id === id)!,...patch}))),
    materialCapture:vi.fn(async (input: any) => ({...items[0], references:[...items[0].references,input.reference]})),
    materialArchive:vi.fn(async (id:string) => {items=items.filter(item=>item.id!==id);return record(id);}),
    materialRestore:vi.fn(async (id:string) => record(id)),
    materialRemoveReference:vi.fn(async (id:string) => ({...record(id),references:[]})),
    materialClear:vi.fn(async()=>{items=[];return true;}),
    materialExport:vi.fn(async()=>({format:'fluentread-learning-materials',version:1,materials:items})),
    materialImport:vi.fn(async()=>({inserted:1,updated:0,skipped:0})),
    materialGeneration:vi.fn(async()=>0),
  };
  const removeListener = vi.fn();
  (globalThis as any)[KEY] = {api,getSession:options.session || (async()=>null),browser:{runtime:{getURL:(p:string)=>`chrome-extension://fixture/${p}`,sendMessage:async()=>({success:true,data:null}),onMessage:{addListener:(value:typeof listener)=>{listener=value;},removeListener}}}};
  const server = await createServer({configFile:false,appType:'custom',logLevel:'silent',root:process.cwd(),plugins:[mocks(),vue()],resolve:{alias:{'@':resolve(process.cwd())}},server:{hmr:false,middlewareMode:true},ssr:{noExternal:['webextension-polyfill']}});
  dispose.push(()=>server.close());
  const component = (await server.ssrLoadModule('/src/features/vocabulary/ui/MaterialWorkspace.vue')).default;
  component.ssrRender=undefined; component.render=()=>null;
  const renderer = runtime.createRenderer<any,any>({patchProp:()=>{},insert:()=>{},remove:()=>{},createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText:()=>{},setElementText:()=>{},parentNode:()=>null,nextSibling:()=>null,querySelector:()=>null,setScopeId:()=>{},cloneNode:()=>({}),insertStaticContent:()=>[{},{}]});
  let panel: any;
  const app = renderer.createApp({render:()=>runtime.h(component,{ref:(instance:any)=>{if(instance) panel=instance.$.setupState;}})});
  app.provide(runtime.ssrContextKey,{modules:new Set()}); app.config.warnHandler=()=>{};app.mount({});
  let active=true; const unmount=()=>{if(active){active=false;app.unmount();}}; dispose.push(unmount);
  const flush=async()=>{for(let i=0;i<15;i++){await Promise.resolve();await runtime.nextTick();}};
  await flush();
  return {panel,api,flush,unmount,removeListener,notify:()=>listener?.({type:'fluentReadMaterialsChanged'})};
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

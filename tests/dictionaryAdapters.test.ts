import 'fake-indexeddb/auto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {defaultDictionaryWorkspace, EMPTY_DICTIONARY_FIELDS} from '@/src/core/config/dictionaryWorkspace';
import {DictionaryRepository} from '@/src/platform/storage/dictionaryRepository';
import {dictionaryScriptAssets, dictionaryScriptBuildPlugin} from '../scripts/testing/dictionary-script-build';
const state=vi.hoisted(()=>({config:{selectionDictionaryRecipe:'',selectionDictionarySource:'auto',selectionDictionaryWorkspace:{recipes:[] as any[],anki:{}},customHeaders:{} as Record<string,string>},lookup:vi.fn(async()=>null),recipe:vi.fn(async()=>null),anki:vi.fn(async()=>1357)}));
vi.mock('@/src/services/config/store',()=>({config:state.config,configReady:Promise.resolve()}));
vi.mock('@/src/features/selection-translation/services/wordDictionary',()=>({lookupWord:state.lookup}));
vi.mock('@/src/features/selection-translation/dictionary/service',()=>({lookupDictionaryRecipe:state.recipe}));
vi.mock('@/src/features/selection-translation/dictionary/anki',()=>({sendDictionaryCardToAnki:state.anki}));
import {createDictionaryRuntimeHandler,lookupSelectionDictionary} from '@/src/app/background/dictionaryRuntime';
afterEach(()=>{vi.unstubAllGlobals();});
describe('dictionary composition and build adapters',()=>{
    it('uses built-in lookup by default and injects private recipe headers only in the background',async()=>{
        await lookupSelectionDictionary('word');expect(state.lookup).toHaveBeenCalledWith('word','auto');
        state.config.selectionDictionaryRecipe='a';const recipe={id:'a',kind:'json',name:'Fixture',url:'https://example.test/{{word}}',headers:{},fields:EMPTY_DICTIONARY_FIELDS,script:'',localId:''};state.config.selectionDictionaryWorkspace={recipes:[recipe],anki:defaultDictionaryWorkspace().anki};
        await lookupSelectionDictionary('word');expect(state.recipe).toHaveBeenLastCalledWith('word',recipe);
        state.config.customHeaders['dictionary:a']='{"X-Fixture":"private"}';await lookupSelectionDictionary('word');expect(state.recipe).toHaveBeenLastCalledWith('word',{...recipe,headers:{'X-Fixture':'private'}});
        const handler=createDictionaryRuntimeHandler();expect(await handler.handle({type:handler.type,front:'word',back:'meaning'} as any,{})).toEqual({success:true,data:1357});
    });
    it('pins only the known QuickJS browser loader and keeps WASM external',()=>{
        const plugin=dictionaryScriptBuildPlugin();expect(plugin.transform('a','unrelated.ts')).toBeNull();expect(()=>plugin.transform('changed','/quickjs-wasmfile-release-sync/dist/emscripten-module.browser.mjs')).toThrow('changed');
        expect(plugin.transform('x=(new URL("emscripten-module.wasm",import.meta.url)).href','/quickjs-wasmfile-release-sync/dist/emscripten-module.browser.mjs')?.code).toContain('/dictionary/quickjs.wasm');
        const assets=dictionaryScriptAssets(process.cwd());expect(assets).toHaveLength(4);expect(assets[0].relativeDest).toBe('dictionary/quickjs.wasm');
    });
    it('runs the actual import Worker protocol and persists only a successfully parsed dictionary',async()=>{
        const replies:unknown[]=[];const scope={importScripts() {},onmessage:null as ((event:MessageEvent)=>void)|null,postMessage:(value:unknown)=>replies.push(value)};vi.stubGlobal('self',scope);await import('@/src/features/selection-translation/dictionary/importWorker');
        const id=`worker-${crypto.randomUUID()}`,bytes=new TextEncoder().encode('word\n\tmeaning');scope.onmessage!({data:{id,files:[{name:'test.dsl',size:bytes.length,arrayBuffer:async()=>bytes.buffer}]}} as MessageEvent);
        await vi.waitFor(()=>expect(replies).toHaveLength(1));expect(replies[0]).toMatchObject({success:true,data:{id,count:1}});
        scope.onmessage!({data:{id,files:[{size:129*1024*1024}]}} as MessageEvent);await vi.waitFor(()=>expect(replies).toHaveLength(2));expect(replies[1]).toMatchObject({success:false,error:expect.stringContaining('128')});
        scope.onmessage!({data:{id,files:null}} as MessageEvent);await vi.waitFor(()=>expect(replies).toHaveLength(3));expect(replies[2]).toMatchObject({success:false});
        scope.onmessage!({data:{id,files:[{name:'bad.dsl',size:1,arrayBuffer:async()=>Promise.reject('fixture read failed')}]}} as MessageEvent);await vi.waitFor(()=>expect(replies).toHaveLength(4));expect(replies[3]).toEqual({success:false,error:'fixture read failed'});
        const db=new DictionaryRepository();await db.remove(id);db.close();
    });
});

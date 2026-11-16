import {afterAll, afterEach, describe, expect, it, vi} from 'vitest';
const environment = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');const {window,document}=parseHTML('<html><body></body></html>');
    const keys=['window','document','Node','Element','HTMLElement','SVGElement','Event'];const originals=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
    for (const key of keys) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:(window as any)[key]});
    return {document:document as unknown as Document,restore(){for (const [key,original] of originals) {if(original)Object.defineProperty(globalThis,key,original);else Reflect.deleteProperty(globalThis,key);}}};
});
import {createApp, h, nextTick, reactive, type App, type Component} from 'vue';
import {Config} from '@/src/core/config/model';
import {defaultDictionaryWorkspace, EMPTY_DICTIONARY_FIELDS, type DictionaryRecipe} from '@/src/core/config/dictionaryWorkspace';
import {dictionaryDocument} from '@/src/features/selection-translation/dictionary/presentation';
import Settings from '@/src/features/settings/ui/DictionaryWorkspaceSettings.vue';
import Tools from '@/src/features/selection-translation/ui/DictionaryCardTools.vue';
const mocks=vi.hoisted(()=>({confirm:vi.fn(async()=>true),download:vi.fn(),send:vi.fn(async()=>({success:true}))}));
vi.mock('element-plus',()=>({ElMessageBox:{confirm:mocks.confirm}}));
vi.mock('@/src/shared/dom/downloadTextFile',()=>({downloadTextFile:mocks.download}));
vi.mock('@/src/ui/i18n',()=>({useUiI18n:()=>({t:(key:string)=>key})}));
const source:DictionaryRecipe={id:'fixture',name:'Fixture',kind:'json',url:'https://example.test/{{word}}',headers:{Authorization:'test-only'},fields:{...EMPTY_DICTIONARY_FIELDS,definition:'definition'},script:'return data;',localId:''};
let app:App|undefined,root:HTMLElement;
async function settle(){await nextTick();await nextTick();}
async function mount(component:Component,props:Record<string,unknown>){root=environment.document.createElement('div');environment.document.body.append(root);app=createApp({setup:()=>()=>h(component,props)});app.mount(root);await settle();}
function button(text:string){const match=Array.from(root.querySelectorAll('button')).find(node=>node.textContent===text);expect(match,text).toBeTruthy();return match!;}
async function change(node:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,value:string,event='input'){Object.defineProperty(node,'value',{value,configurable:true,writable:true});node.dispatchEvent(new Event(event,{bubbles:true}));await settle();}
class FakeWorker {static instances:FakeWorker[]=[];onmessage:((event:MessageEvent)=>void)|null=null;onerror:(()=>void)|null=null;terminate=vi.fn();postMessage=vi.fn();constructor(){FakeWorker.instances.push(this);}}
afterEach(async()=>{app?.unmount();app=undefined;await settle();environment.document.body.replaceChildren();vi.unstubAllGlobals();mocks.confirm.mockReset().mockResolvedValue(true);mocks.download.mockReset();mocks.send.mockReset().mockResolvedValue({success:true});FakeWorker.instances=[];});
afterAll(()=>environment.restore());

describe('dictionary settings and card surfaces',()=>{
    it('edits a declarative source without making any network request, then updates or removes it',async()=>{
        const config=reactive(new Config());await mount(Settings,{config});button('dictionary.add').click();await settle();
        const inputs=root.querySelectorAll<HTMLInputElement>('.dictionary-editor>label input');await change(inputs[0],'My source');await change(inputs[1],'https://example.test/{{word}}');
        root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();expect(config.selectionDictionaryWorkspace.recipes).toHaveLength(1);expect(root.querySelector('form')).toBeNull();
        button('dictionary.edit').click();await settle();await change(root.querySelector<HTMLInputElement>('.dictionary-editor>label input')!,'Renamed');root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();expect(config.selectionDictionaryWorkspace.recipes[0].name).toBe('Renamed');
        config.selectionDictionaryRecipe=config.selectionDictionaryWorkspace.recipes[0].id;button('dictionary.remove').click();await settle();await settle();expect(config.selectionDictionaryWorkspace.recipes).toEqual([]);expect(config.selectionDictionaryRecipe).toBe('');
    });
    it('rejects invalid source form values and preserves canceled removals',async()=>{
        const config=reactive(new Config());config.selectionDictionaryWorkspace.recipes=[{...source}];await mount(Settings,{config});
        mocks.confirm.mockRejectedValueOnce('cancel');button('dictionary.remove').click();await settle();expect(config.selectionDictionaryWorkspace.recipes).toHaveLength(1);
        button('dictionary.edit').click();await settle();await change(root.querySelector<HTMLTextAreaElement>('.dictionary-editor textarea')!,'not JSON');root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();expect(root.textContent).toContain('dictionary.invalid');expect(root.querySelector('form')).toBeTruthy();button('dictionary.cancel').click();await settle();expect(root.querySelector('form')).toBeNull();
        button('dictionary.export').click();expect(mocks.download.mock.calls[0][1]).not.toContain('test-only');
    });
    it('imports recipe files on demand, keeps IDs distinct and rejects malformed files',async()=>{
        const config=reactive(new Config());await mount(Settings,{config});const input=root.querySelector<HTMLInputElement>('input[accept=".json"]')!;
        Object.defineProperty(input,'files',{configurable:true,value:[{size:200,text:async()=>JSON.stringify({version:1,recipes:[source]})}]});input.dispatchEvent(new Event('change'));await settle();await settle();expect(config.selectionDictionaryWorkspace.recipes).toHaveLength(1);
        input.dispatchEvent(new Event('change'));await settle();await settle();expect(config.selectionDictionaryWorkspace.recipes).toHaveLength(1);
        Object.defineProperty(input,'files',{configurable:true,value:[{size:10,text:async()=>'{bad'}]});input.dispatchEvent(new Event('change'));await settle();await settle();expect(root.textContent).toContain('dictionary.importError');
    });
    it('indexes files in a disposable Worker, installs only after success and supports cancellation',async()=>{
        vi.stubGlobal('Worker',FakeWorker);const config=reactive(new Config());await mount(Settings,{config});const input=root.querySelector<HTMLInputElement>('input[multiple]')!;
        Object.defineProperty(input,'files',{value:[{name:'test.dsl',size:10}],configurable:true});input.dispatchEvent(new Event('change'));await settle();expect(root.textContent).toContain('dictionary.importing');const worker=FakeWorker.instances[0];expect(worker.postMessage).toHaveBeenCalled();expect(config.selectionDictionaryWorkspace.recipes).toHaveLength(0);
        worker.onmessage!({data:{success:true,data:{name:'Local'}}} as MessageEvent);await settle();expect(config.selectionDictionaryWorkspace.recipes[0]).toMatchObject({kind:'local',name:'Local'});expect(worker.terminate).toHaveBeenCalledTimes(1);
        input.dispatchEvent(new Event('change'));await settle();const second=FakeWorker.instances[1];button('dictionary.cancel').click();await settle();expect(second.terminate).toHaveBeenCalledTimes(1);expect(root.textContent).not.toContain('dictionary.importing');
        input.dispatchEvent(new Event('change'));await settle();app!.unmount();app=undefined;expect(FakeWorker.instances[2].terminate).toHaveBeenCalledTimes(1);
    });
    it('reports worker errors and invalid formats without retaining busy state',async()=>{
        vi.stubGlobal('Worker',FakeWorker);await mount(Settings,{config:reactive(new Config())});const input=root.querySelector<HTMLInputElement>('input[multiple]')!;Object.defineProperty(input,'files',{value:[{name:'bad.mdx',size:10}]});
        input.dispatchEvent(new Event('change'));await settle();FakeWorker.instances[0].onmessage!({data:{success:false,error:'protected dictionary'}} as MessageEvent);await settle();expect(root.textContent).toContain('protected dictionary');expect(root.textContent).not.toContain('dictionary.importing');
        input.dispatchEvent(new Event('change'));await settle();FakeWorker.instances[1].onerror!();await settle();expect(root.textContent).toContain('dictionary.importError');
    });
    it('previews templates, exports data and contacts Anki only after an explicit click',async()=>{
        vi.stubGlobal('browser',{runtime:{sendMessage:mocks.send}});const entry={...EMPTY_DICTIONARY_FIELDS,word:'curious',definition:'eager',source:'Fixture',sourceUrl:''};
        await mount(Tools,{entry,workspace:defaultDictionaryWorkspace(),context:'A curious reader.',explanation:'',dark:false});expect(root.textContent).toContain('A curious reader.');expect(mocks.send).not.toHaveBeenCalled();
        button('CSV').click();expect(mocks.download).toHaveBeenCalledWith('FluentRead-card.csv',expect.stringContaining('curious'),'text/csv;charset=utf-8');button('Markdown').click();expect(mocks.download.mock.calls[1][0]).toBe('FluentRead-card.md');
        button('Anki').click();await settle();expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({type:'fluentReadDictionaryAnki',front:'curious\n'}));expect(root.textContent).toContain('dictionary.ankiSaved');
        mocks.send.mockResolvedValueOnce({success:false});button('Anki').click();await settle();expect(root.textContent).toContain('dictionary.ankiError');
    });
    it('loads embedded sites only when requested and destroys the frame when closed',async()=>{
        await mount(Tools,{entry:{...EMPTY_DICTIONARY_FIELDS,word:'word',webUrl:'https://example.test/word',source:'Fixture',sourceUrl:'https://example.test/word'},workspace:defaultDictionaryWorkspace(),context:'',explanation:'',dark:true});
        expect(root.querySelector('iframe')).toBeNull();button('dictionary.openWeb').click();await settle();expect(root.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');expect(root.querySelector('a')?.getAttribute('rel')).toContain('noreferrer');button('dictionary.closeWeb').click();await settle();expect(root.querySelector('iframe')).toBeNull();
    });
    it('places offline markup in a non-executable, network-isolated document',()=>{
        const result=dictionaryDocument('<script>bad()</script><iframe src="https://evil.test"></iframe><b onclick="bad()" style="color:red;background:url(https://evil.test/a)">safe</b><img src="https://evil.test/a"><img src="data:image/png;base64,AQI="><form><input value="a"></form><svg onload="bad()"></svg><style>@import "https://evil.test";p{color:blue}</style>','@import "evil";b{color:navy}',true);
        expect(result).not.toContain('<script');expect(result).not.toContain('onclick');expect(result).not.toContain('https://evil.test');expect(result).toContain("default-src 'none'");expect(result).toContain('data:image/png;base64,AQI=');expect(result).toContain('color-scheme:dark');
        const light=dictionaryDocument('<style></style><p class="dictionary" style="background:url(\'data:image/png;base64,AQI=\')">text</p>','',false);
        expect(light).toContain('color-scheme:light');expect(light).toContain('url("data:image/png;base64,AQI=")'.replaceAll('"','&quot;'));
    });
});

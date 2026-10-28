import {beforeEach, describe, expect, it, vi} from 'vitest';
import browser from 'webextension-polyfill';
const sendMessage = vi.hoisted(() => vi.fn());
const privateContext = vi.hoisted(()=>({inIncognitoContext:false}));
const fakeRepository = vi.hoisted(()=>({generation:vi.fn(async()=>0),list:vi.fn(async()=>[]),capture:vi.fn(async()=>({id:'material'}))}));
const legacyFactory = vi.hoisted(()=>vi.fn());
vi.mock('webextension-polyfill', () => ({default:{runtime:{id:'test',sendMessage,getURL:(path:string)=>`chrome-extension://test/${path.replace(/^\//,'')}`},extension:privateContext}}));
vi.mock('@/src/features/vocabulary/materialRepository',()=>({MaterialRepository:vi.fn(function(_db:unknown,legacy:unknown){legacyFactory(legacy);return fakeRepository;})}));
import {createBrowserMaterialHandler,createBrowserVocabularyUndoOptions} from '@/src/app/background/handlers/vocabulary';
import type {MaterialRequest} from '@/src/features/vocabulary/materialProtocol';
import {materialArchive,materialCapture,materialClear,materialExport,materialGeneration,materialGet,materialImport,materialList,materialRemoveReference,materialResolve,materialRestore,materialUpdate} from '@/src/features/vocabulary/materialClient';
beforeEach(()=>{sendMessage.mockReset();privateContext.inIncognitoContext=false;});
describe('typed local material client',()=>{
    it('routes management operations through the existing runtime instead of direct database access', async()=>{
        sendMessage.mockResolvedValue({success:true,data:'result'});
        const source = {kind:'article' as const,url:'https://example.test/'};
        const operations = [()=>materialList(),()=>materialList({archived:true}),()=>materialGeneration(),()=>materialGet('id'),()=>materialResolve('id'),()=>materialCapture({source}),()=>materialUpdate('id',{topics:['AI']}),()=>materialRemoveReference('id','note','n'),()=>materialArchive('id'),()=>materialRestore('id'),()=>materialClear(),()=>materialExport(),()=>materialImport({}),()=>materialImport({},{generation:1,capturedAt:100})];
        for (const operation of operations) expect(await operation()).toBe('result');
        expect(sendMessage.mock.calls.map(([message])=>message.action)).toEqual(['list','list','generation','get','resolve','capture','update','removeReference','archive','restore','clear','exportData','importData','importData']);
        expect(sendMessage.mock.calls.every(([message])=>message.type==='fluentReadMaterials')).toBe(true);
    });
    it('blocks private extension pages before any runtime message and tolerates an unavailable extension namespace',async()=>{
        privateContext.inIncognitoContext=true;
        const source = {kind:'article' as const,url:'https://example.test/'};
        for (const operation of [()=>materialList(),()=>materialCapture({source}),()=>materialExport(),()=>materialClear()]) await expect(operation()).rejects.toMatchObject({name:'MaterialClientError',code:'privacy-disabled'});
        expect(sendMessage).not.toHaveBeenCalled();
        const original = browser.extension;
        Object.defineProperty(browser,'extension',{value:undefined,configurable:true,writable:true});
        try {sendMessage.mockResolvedValue({success:true,data:[]}); expect(await materialList()).toEqual([]);}
        finally {Object.defineProperty(browser,'extension',{value:original,configurable:true,writable:true});}
        expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    it('returns structured domain errors and a generic failure when runtime supplies no valid reply', async()=>{
        sendMessage.mockResolvedValue({success:false,error:{code:'privacy-disabled',message:'Private'}});
        await expect(materialList()).rejects.toMatchObject({name:'MaterialClientError',code:'privacy-disabled',message:'Private'});
        for (const response of [undefined,null,{}, {success:'invalid'}]) {
            sendMessage.mockResolvedValue(response);
            await expect(materialList()).rejects.toMatchObject({code:'storage-error',message:'本地学习材料暂时不可用'});
        }
    });
});

describe('browser material composition privacy and collection settings',()=>{
    it('composes the extension-only undo repository with a trusted options sender',()=>{
        const undo=createBrowserVocabularyUndoOptions();
        expect(undo.vocabularyUndo).toBeDefined();
        expect(undo.isTrustedUndoSender({id:'test',url:'chrome-extension://test/options.html#settings-vocabulary'})).toBe(true);
        expect(undo.isTrustedUndoSender({id:'test',url:'https://example.test/options.html'})).toBe(false);
        privateContext.inIncognitoContext=true;
        expect(undo.isTrustedUndoSender({id:'test',url:'chrome-extension://test/options.html'})).toBe(false);
    });
    it('wires read-only legacy migration and applies collection flags, site rules and private context',async()=>{
        sendMessage.mockResolvedValue({success:true});
        const config = {on:true,vocabularyBookEnabled:false,harness:{enabled:false,memoryEnabled:false},disabledExtensionDomains:['blocked.test']};
        const vocabularyBook = {list:vi.fn(async()=>[])};
        const handler = createBrowserMaterialHandler({ready:Promise.resolve(),config:config as never,vocabularyBook:vocabularyBook as never});
        await legacyFactory.mock.calls.at(-1)![0]();
        expect(vocabularyBook.list).toHaveBeenCalledWith({order:'recent'});
        const capture = (kind?:string) => ({type:'fluentReadMaterials',action:'capture',input:{source:{kind:'article',url:'https://example.test/'},...(kind?{reference:{kind,id:'ref'}}:{})}} as MaterialRequest);
        const ui = {sender:{url:'chrome-extension://test/options.html'}};
        const page = {sender:{url:'https://example.test/'}};
        expect(await handler.handle(capture('vocabulary'),ui)).toMatchObject({success:false});
        config.vocabularyBookEnabled=true;
        expect(await handler.handle(capture('vocabulary'),ui)).toMatchObject({success:true});
        config.vocabularyBookEnabled=false;
        expect(await handler.handle(capture('session'),ui)).toMatchObject({success:false});
        config.harness.enabled=true;
        expect(await handler.handle(capture('session'),page)).toMatchObject({success:true});
        config.harness.enabled=false;
        for (const kind of ['note','memory']) expect(await handler.handle(capture(kind),ui)).toMatchObject({success:true});
        config.vocabularyBookEnabled=true;
        expect(await handler.handle(capture(),page)).toMatchObject({success:true});
        config.on=false;
        expect(await handler.handle(capture(),page)).toMatchObject({success:false});
        config.on=true;
        expect(await handler.handle(capture(),{sender:{url:'https://blocked.test/'}})).toMatchObject({success:false});
        privateContext.inIncognitoContext=true;
        expect(await handler.handle({type:'fluentReadMaterials',action:'list'},ui)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(sendMessage).toHaveBeenCalledWith({type:'fluentReadMaterialsChanged'});
    });
    it('saves independent documents and existing reading positions with AI and vocabulary disabled',async()=>{
        sendMessage.mockResolvedValue({success:true});
        const config = {on:true,vocabularyBookEnabled:false,harness:{enabled:false,memoryEnabled:false},disabledExtensionDomains:['blocked.test']};
        const handler = createBrowserMaterialHandler({ready:Promise.resolve(),config:config as never,vocabularyBook:{list:async()=>[]} as never});
        const ui = {sender:{url:'chrome-extension://test/document-translation.html'}};
        const documentCapture: MaterialRequest = {type:'fluentReadMaterials',action:'capture',input:{source:{kind:'document',fingerprint:'sha256:local-document',title:'Independent material'},locator:{kind:'document',page:3}}};
        expect(await handler.handle(documentCapture,ui)).toMatchObject({success:true});
        const position: MaterialRequest = {type:'fluentReadMaterials',action:'capture',input:{source:{kind:'article',url:'https://example.test/'},positionOnly:true,locator:{kind:'text',quote:'Existing reading position'}}};
        expect(await handler.handle(position,{sender:{url:'https://example.test/'}})).toMatchObject({success:true});
        expect(fakeRepository.capture).toHaveBeenCalledWith(position.input);
        config.on=false;
        expect(await handler.handle(documentCapture,ui)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await handler.handle(position,{sender:{url:'https://example.test/'}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        config.on=true;
        expect(await handler.handle(position,{sender:{url:'https://blocked.test/'}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await handler.handle(documentCapture,{sender:{...ui.sender,tab:{incognito:true}}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        privateContext.inIncognitoContext=true;
        expect(await handler.handle(documentCapture,ui)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
    });
    it('ignores notification transport failures after committing captured learning data',async()=>{
        sendMessage.mockRejectedValue(new Error('closed extension page'));
        const handler = createBrowserMaterialHandler({ready:Promise.resolve(),config:{on:true,harness:{enabled:true},disabledExtensionDomains:[]} as never,vocabularyBook:{list:async()=>[]} as never});
        expect(await handler.handle({type:'fluentReadMaterials',action:'capture',input:{source:{kind:'article',url:'https://example.test/'}}},{sender:{url:'https://example.test/'}})).toMatchObject({success:true});
    });
});

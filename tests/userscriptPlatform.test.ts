import {beforeEach, describe, expect, it, vi} from 'vitest';
import {CONFIG_COUNT_INCREMENT_MESSAGE} from '@/src/services/config/count';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {createVisionProbeIdentity} from '@/src/core/config/visionProbe';
import {VISION_PROBE_MESSAGE} from '@/src/services/translation/types';
import {extractConfigCredentials, LOCAL_CREDENTIALS_STORAGE_KEY} from '@/src/core/config/credentials';
import browser from '@/userscript/browser';
import {TRANSLATION_CANCEL_MESSAGE_TYPE} from '@/src/services/translation/types';
import {UNHANDLED_RUNTIME_MESSAGE, setPlatformMessageHandler, resetPlatformMessageHandler} from '@/userscript/browser';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({
    config: {count: 0},
    saveConfig: vi.fn(),
    incrementUserscriptConfigCount: vi.fn(),
    applyConfigHistoryAction: vi.fn(),
    runTranslationServiceConnectionTest: vi.fn(),
    translateMicrosoftTexts: vi.fn(),
    cleanupTranslationCache: vi.fn(),
    clearTranslationCache: vi.fn(),
    translateWithCache: vi.fn(),
    lookupWord: vi.fn(),
    preparePatch: vi.fn(), prepareSave: vi.fn(), parseStored: vi.fn(), watch: vi.fn(), vision: vi.fn(),
    watched: [] as {key: string; callback: (value: unknown) => void; stop: ReturnType<typeof vi.fn>}[],
    usage: {getDashboard: vi.fn(), clear: vi.fn()}, vocabulary: {list: vi.fn(), clear: vi.fn(), upsert: vi.fn(), updateNote: vi.fn(), removeWithSnapshot: vi.fn(), restoreSnapshot: vi.fn()},
}));

vi.mock('@/src/services/config/store', () => ({
    config: mocks.config,
    configReady: Promise.resolve(),
    CONFIG_HISTORY_MESSAGE: 'configHistoryAction',
    CONFIG_PERSIST_MESSAGE: 'persistConfig',
    CONFIG_PERSIST_BATCH_MESSAGE: 'persistConfigBatch',
    CONFIG_STORAGE_KEY: 'local:config',
    getConfigRevision: () => 0,
    prepareConfigPatchRequest: mocks.preparePatch,
    prepareConfigSaveRequest: mocks.prepareSave,
    parseStoredConfig: mocks.parseStored,
    saveConfig: mocks.saveConfig,
    applyConfigHistoryAction: mocks.applyConfigHistoryAction,
}));

vi.mock('@/userscript/count', () => ({
    incrementUserscriptConfigCount: mocks.incrementUserscriptConfigCount,
}));

vi.mock('@/src/core/config/constants', () => ({
    CONNECTION_TEST_MESSAGE: 'testTranslationServiceConnection',
}));

vi.mock('@/src/providers/translation/microsoft', () => ({
    translateMicrosoftTexts: mocks.translateMicrosoftTexts,
}));

vi.mock('@/src/providers/translation/connectionTest', () => ({
    runTranslationServiceConnectionTest: mocks.runTranslationServiceConnectionTest,
}));

vi.mock('@/src/app/translation/runtime', () => ({
    cleanupTranslationCache: mocks.cleanupTranslationCache,
    clearTranslationCache: mocks.clearTranslationCache,
    translateWithCache: mocks.translateWithCache,
}));

vi.mock('@/src/features/selection-translation/services/wordDictionary', () => ({
    lookupWord: mocks.lookupWord,
}));

vi.mock('@/userscript/storage', () => ({configStorage: {watch: mocks.watch}}));
vi.mock('@/src/app/translation/visionProbeRuntime', () => ({modelVisionProbe: {resolve: mocks.vision}}));
vi.mock('@/src/platform/storage/modelUsageRepository', () => ({getModelUsageRepository: () => (mocks.usage)}));
vi.mock('@/src/features/vocabulary/repository', () => ({vocabularyBook: mocks.vocabulary,createUuid:()=>crypto.randomUUID()}));

import {createPlatformMessageHandler} from '@/userscript/platform';
import {createPlatformMessageHandler as createFullPlatformMessageHandler} from '@/userscript/platformFull';
import {getTranslationGlossaryContext, getTranslationRequestControl} from '@/src/services/translation/requestSnapshot';

describe('userscript 平台消息适配', () => {
    it('免费池逐服务检查保留候选 ID，避免脚本端退回自动换线', async () => {
        mocks.runTranslationServiceConnectionTest.mockResolvedValue({durationMs: 12});
        const handler = createPlatformMessageHandler(vi.fn());
        await expect(handler({type: 'testTranslationServiceConnection', service: 'freeTranslation', freeProviderId: 'transmart'}))
            .resolves.toEqual({success: true, durationMs: 12});
        expect(mocks.runTranslationServiceConnectionTest).toHaveBeenCalledWith('freeTranslation', expect.objectContaining({freeProviderId: 'transmart'}));
    });
    it('术语网站范围取当前页面而不是公开payload，视频仍使用独立入口', async () => {
        vi.stubGlobal('location', {href: 'https://docs.example.com/article'});
        mocks.translateWithCache.mockResolvedValue('译文');
        const handler = createPlatformMessageHandler(vi.fn());
        try {
            await handler({origin: 'agent', pageUrl: 'https://forged.example', glossaryContext: 'document'});
            expect(getTranslationGlossaryContext(mocks.translateWithCache.mock.calls[0][0])).toEqual({pageUrl: 'https://docs.example.com/article', context: 'page'});
            await handler({origin: 'agent', glossaryContext: 'video'});
            expect(getTranslationGlossaryContext(mocks.translateWithCache.mock.calls[1][0])).toEqual({pageUrl: 'https://docs.example.com/article', context: 'video'});
        } finally { vi.unstubAllGlobals(); }
    });
    beforeEach(() => {
        vi.clearAllMocks();
        Object.assign(mocks.config, new Config());
        mocks.config.count = 0;
        mocks.watched.length = 0;
        mocks.watch.mockImplementation((key, callback) => {const stop=vi.fn();mocks.watched.push({key,callback,stop});return stop;});
        mocks.parseStored.mockImplementation(value => value && typeof value === 'object' ? normalizeConfig(value) : null);
        mocks.preparePatch.mockImplementation((patch, _expected, current) => normalizeConfig({...current,...patch}));
        mocks.prepareSave.mockImplementation((value, current) => normalizeConfig({...current,...value}));
        mocks.usage.getDashboard.mockResolvedValue({rows:[]});mocks.vocabulary.list.mockResolvedValue([]);
        mocks.vision.mockResolvedValue({supported:true});
        mocks.translateWithCache.mockReset();
        mocks.saveConfig.mockResolvedValue(undefined);
        mocks.incrementUserscriptConfigCount.mockResolvedValue(14);
    });

    it('完整脚本只在内存中删除和恢复，重建处理器不保留快照并拒绝无痕',async()=>{
        const handler=createFullPlatformMessageHandler(vi.fn());
        const entry={id:'entry',term:'private'};mocks.vocabulary.removeWithSnapshot.mockResolvedValue({entry,reviewLogs:[]});
        mocks.vocabulary.restoreSnapshot.mockResolvedValue(undefined);
        const removed=await handler({type:'fluentReadVocabularyBook',action:'removeWithUndo',entryId:'entry',sender:{url:'https://forged.invalid'}});
        expect(removed).toMatchObject({success:true,data:{term:'private'}});
        expect(await handler({type:'fluentReadVocabularyBook',action:'listUndo'})).toMatchObject({success:true,data:[{id:removed.data.id}]});
        expect(await handler({type:'fluentReadVocabularyBook',action:'restoreUndo',undoId:removed.data.id})).toMatchObject({success:true,data:'restored'});
        expect(await handler({type:'fluentReadVocabularyBook',action:'restoreUndo',undoId:removed.data.id})).toMatchObject({success:true,data:'previously-restored'});
        expect(mocks.vocabulary.restoreSnapshot).toHaveBeenCalledOnce();handler.dispose();
        const restarted=createFullPlatformMessageHandler(vi.fn());expect(await restarted({type:'fluentReadVocabularyBook',action:'listUndo'})).toMatchObject({success:true,data:[]});
        vi.stubGlobal('GM_info',{isIncognito:true});expect(await restarted({type:'fluentReadVocabularyBook',action:'listUndo'})).toMatchObject({success:false});
        vi.unstubAllGlobals();restarted.dispose();
    });
    it('clears in-memory undo with collection clear, and rejects the obsolete snapshot action',async()=>{
        const handler=createFullPlatformMessageHandler(vi.fn());mocks.vocabulary.removeWithSnapshot.mockResolvedValue({entry:{id:'e',term:'private'},reviewLogs:[]});
        expect(await handler({type:'fluentReadVocabularyBook',action:'removeWithUndo',entryId:'e'})).toMatchObject({success:true});
        expect(await handler({type:'fluentReadVocabularyBook',action:'removeWithSnapshot',entryId:'e'})).toMatchObject({success:false});
        mocks.vocabulary.clear.mockResolvedValue(undefined);
        expect(await handler({type:'fluentReadVocabularyBook',action:'clear'})).toMatchObject({success:true});
        expect(await handler({type:'fluentReadVocabularyBook',action:'listUndo'})).toMatchObject({success:true,data:[]});handler.dispose();
    });
    it('establishes a clear barrier before awaiting storage and retains tickets when clear fails',async()=>{
        const handler=createFullPlatformMessageHandler(vi.fn());mocks.vocabulary.removeWithSnapshot.mockResolvedValue({entry:{id:'e',term:'private'},reviewLogs:[]});
        const removed=await handler({type:'fluentReadVocabularyBook',action:'removeWithUndo',entryId:'e'});const id=removed.data.id;
        let finish!:(value:unknown)=>void;mocks.vocabulary.clear.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
        const clearing=handler({type:'fluentReadVocabularyBook',action:'clear'});await Promise.resolve();
        expect(await handler({type:'fluentReadVocabularyBook',action:'restoreUndo',undoId:id})).toMatchObject({success:false,error:{code:'invalid-input'}});
        expect(mocks.vocabulary.restoreSnapshot).not.toHaveBeenCalled();finish(Promise.reject(new Error('failure')));
        expect(await clearing).toMatchObject({success:false});expect(await handler({type:'fluentReadVocabularyBook',action:'listUndo'})).toMatchObject({success:true,data:[{id}]});handler.dispose();
    });
    it('isolates failed notification listeners without changing an already committed deletion',async()=>{
        const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);const later=vi.fn();
        const throws=()=>{throw new Error('private input')};const rejects=()=>Promise.reject(new Error('private input'));
        browser.runtime.onMessage.addListener(throws);browser.runtime.onMessage.addListener(rejects);browser.runtime.onMessage.addListener(later);
        const handler=createFullPlatformMessageHandler(vi.fn());mocks.vocabulary.removeWithSnapshot.mockResolvedValue({entry:{id:'e',term:'private'},reviewLogs:[]});
        expect(await handler({type:'fluentReadVocabularyBook',action:'removeWithUndo',entryId:'e'})).toMatchObject({success:true});
        await Promise.resolve();await Promise.resolve();expect(later).toHaveBeenCalled();expect(warn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private input');
        browser.runtime.onMessage.removeListener(throws);browser.runtime.onMessage.removeListener(rejects);browser.runtime.onMessage.removeListener(later);handler.dispose();warn.mockRestore();
    });
    it('does not route forged page message events into the sandbox runtime handler',async()=>{
        const {window}=parseHTML('<html><body></body></html>');vi.stubGlobal('window',window);
        const handler=createFullPlatformMessageHandler(vi.fn());setPlatformMessageHandler(handler);
        const event=new window.Event('message');Object.defineProperty(event,'data',{value:{type:'fluentReadVocabularyBook',action:'removeWithUndo',entryId:'e'}});
        window.dispatchEvent(event);await Promise.resolve();await Promise.resolve();
        expect(mocks.vocabulary.removeWithSnapshot).not.toHaveBeenCalled();resetPlatformMessageHandler();vi.unstubAllGlobals();
    });
    it('通过 userscript 专用副本累加，并避免把瞬时总数作为跨标签持久投影', async () => {
        mocks.config.count = 12;
        const handler = createPlatformMessageHandler(vi.fn());

        await expect(handler({
            type: CONFIG_COUNT_INCREMENT_MESSAGE,
            delta: 2,
            operationId: 'userscript-operation-1',
        })).resolves.toEqual({
            success: true,
            count: 14,
        });
        expect(mocks.incrementUserscriptConfigCount).toHaveBeenCalledWith(2, 'userscript-operation-1');
        expect(mocks.saveConfig).not.toHaveBeenCalled();
        expect(mocks.config.count).toBe(14);
    });

    it('拒绝无效计数增量或 operationId，且不写专用副本', async () => {
        const handler = createPlatformMessageHandler(vi.fn());

        await expect(handler({
            type: CONFIG_COUNT_INCREMENT_MESSAGE,
            delta: 0,
            operationId: 'userscript-operation-2',
        })).resolves.toEqual({
            success: false,
            error: '无效的翻译计数增量',
        });
        await expect(handler({
            type: CONFIG_COUNT_INCREMENT_MESSAGE,
            delta: 1,
            operationId: 'bad id',
        })).resolves.toEqual({
            success: false,
            error: '无效的翻译计数操作标识',
        });
        expect(mocks.incrementUserscriptConfigCount).not.toHaveBeenCalled();
        expect(mocks.saveConfig).not.toHaveBeenCalled();
    });

    describe.each([
        ['兼容', createPlatformMessageHandler],
        ['完整', createFullPlatformMessageHandler],
    ] as const)('%s userscript 输入框取消', (_name, createHandler) => {
        it('未知有类型消息和非协议对象不能仅因含origin误触发provider', async () => {
            const handler = createHandler(vi.fn());mocks.translateWithCache.mockResolvedValue('translated');
            try {
                for (const candidate of [{type:'unregistered-operation',origin:'private source'}, {type:undefined,origin:['private source']}, Object.create({origin:'inherited'}), Object.assign([], {origin:'array field'})]) {
                    await expect(handler(candidate)).resolves.toBe(UNHANDLED_RUNTIME_MESSAGE);
                }
                expect(mocks.translateWithCache).not.toHaveBeenCalled();
                await expect(handler({origin:'valid untyped'})).resolves.toBe('translated');expect(mocks.translateWithCache).toHaveBeenCalledOnce();
            } finally {if ('dispose' in handler && typeof handler.dispose === 'function') handler.dispose();}
        });
        it.each(['single', 'batch'] as const)('普通网页 %s 请求也把取消传到翻译运行时，并在导航后保留请求归属', async kind => {
            let finish!: (value: string) => void;
            let request: unknown;
            mocks.translateWithCache.mockImplementation(message => {
                request = message;
                return new Promise<string>((resolve, reject) => {
                    finish = resolve;
                    getTranslationRequestControl(message)?.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {once: true});
                });
            });
            vi.stubGlobal('location', {href: 'https://fixture.test/first'});
            const handler = createHandler(vi.fn());
            const pending = handler({origin: kind === 'single' ? 'Hello' : ['Hello', 'World'], clientRequestId: 'userscript-page-active'});
            const result = pending.then(value => ({value}), error => ({error}));
            try {
                expect(getTranslationRequestControl(request)?.signal.aborted).toBe(false);
                vi.stubGlobal('location', {href: 'https://fixture.test/second'});
                await expect(handler({type: TRANSLATION_CANCEL_MESSAGE_TYPE, clientRequestId: 'userscript-page-active'}))
                    .resolves.toMatchObject({success: true, cancelled: true});
                expect(getTranslationRequestControl(request)?.signal.aborted).toBe(true);
                await expect(result).resolves.toMatchObject({error: {name: 'AbortError'}});
            } finally {
                finish('late result');await result;
                vi.unstubAllGlobals();
                if ('dispose' in handler && typeof handler.dispose === 'function') handler.dispose();
            }
        });

        it('普通请求的先取消后开始不调用运行时，并拒绝无法由取消协议标识的请求', async () => {
            const handler = createHandler(vi.fn());
            try {
                await handler({type: TRANSLATION_CANCEL_MESSAGE_TYPE, clientRequestId: 'userscript-page-pending'});
                await expect(handler({origin: 'Hello', clientRequestId: 'userscript-page-pending'})).rejects.toMatchObject({name: 'AbortError'});
                await expect(handler({origin: 'Hello', clientRequestId: 'invalid id'})).rejects.toThrow('clientRequestId');
                expect(mocks.translateWithCache).not.toHaveBeenCalled();
            } finally {if ('dispose' in handler && typeof handler.dispose === 'function') handler.dispose();}
        });

        it('共享取消消息可以终止输入框的真实后台请求', async () => {
            let started!: () => void;
            const providerStarted = new Promise<void>(resolve => {started = resolve;});
            let signal!: AbortSignal;
            mocks.translateWithCache.mockImplementation(async (request) => {
                signal = getTranslationRequestControl(request)!.signal;
                started();
                return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => {
                    const error = new Error('provider cancelled'); error.name = 'AbortError'; reject(error);
                }, {once: true}));
            });
            const handler = createHandler(vi.fn());
            const translation = handler({type: 'inputBoxTranslation', text: 'Hello', targetLang: 'ja', clientRequestId: 'userscript-input-active'});
            await providerStarted;
            await expect(handler({type: TRANSLATION_CANCEL_MESSAGE_TYPE, clientRequestId: 'userscript-input-active'}))
                .resolves.toMatchObject({success: true, cancelled: true});
            expect(signal.aborted).toBe(true);
            await expect(translation).resolves.toMatchObject({success: false, error: 'provider cancelled'});
            if ('dispose' in handler && typeof handler.dispose === 'function') handler.dispose();
        });

        it('先取消后触发不调用 provider，错误取消标识返回明确失败', async () => {
            const handler = createHandler(vi.fn());
            await expect(handler({type: TRANSLATION_CANCEL_MESSAGE_TYPE, clientRequestId: 'userscript-input-pending'}))
                .resolves.toMatchObject({success: true, cancelled: false});
            await expect(handler({type: 'inputBoxTranslation', text: 'Hello', targetLang: 'ja', clientRequestId: 'userscript-input-pending'}))
                .resolves.toMatchObject({success: false, error: '翻译请求已取消'});
            await expect(handler({type: TRANSLATION_CANCEL_MESSAGE_TYPE, clientRequestId: 'invalid id'}))
                .resolves.toMatchObject({success: false, error: '翻译请求 clientRequestId 格式无效'});
            expect(mocks.translateWithCache).not.toHaveBeenCalled();
            if ('dispose' in handler && typeof handler.dispose === 'function') handler.dispose();
        });
    });

    describe.each([['compact',createPlatformMessageHandler],['full',createFullPlatformMessageHandler]] as const)('%s shared message contract',(_name,createHandler)=>{
        it('routes page, dictionary, caches, history and unsupported capabilities without conflating typed messages with translation',async()=>{
            const open=vi.fn(),handler=createHandler(open);
            try{
                for(const input of [null,undefined,false,'unknown',42]) expect(await handler(input)).toBe(UNHANDLED_RUNTIME_MESSAGE);
                expect(await handler({type:'openOptionsPage'})).toEqual({success:true});expect(open).toHaveBeenCalledOnce();
                expect(await handler({type:'fullPageTranslationState'})).toEqual({success:true});
                mocks.lookupWord.mockResolvedValueOnce({word:'sample'});expect(await handler({type:'selectionWordLookup',word:'sample'})).toMatchObject({success:true,data:{word:'sample'}});
                mocks.lookupWord.mockRejectedValueOnce('dictionary unavailable');expect(await handler({type:'selectionWordLookup'})).toEqual({success:false,error:'dictionary unavailable'});
                expect(mocks.lookupWord).toHaveBeenLastCalledWith('');
                for(const type of ['selectionTts','selectionTtsGoogle','selectionTtsStop','toggleSelectionAreaTranslator','toggleImageTranslator','fluentReadImageSynthetic','fluentReadAreaSynthetic']) expect(await handler({type})).toMatchObject({success:false});
                expect(await handler({type:'clearTranslationCache'})).toEqual({success:true});expect(mocks.clearTranslationCache).toHaveBeenCalledOnce();
                expect(await handler({type:'userscriptCacheMaintenance'})).toEqual({success:true});expect(mocks.cleanupTranslationCache).toHaveBeenCalledOnce();
                mocks.applyConfigHistoryAction.mockResolvedValue({position:1});expect(await handler({type:'configHistoryAction',action:'undo',version:7})).toEqual({success:true,history:{position:1}});
                expect(mocks.applyConfigHistoryAction).toHaveBeenCalledWith('undo',7);
                await handler({type:'configHistoryAction',action:'redo'});expect(mocks.applyConfigHistoryAction).toHaveBeenLastCalledWith('redo',undefined);
                expect(await handler({type:'configHistoryAction',action:'delete'})).toMatchObject({success:false});
                mocks.lookupWord.mockRejectedValueOnce(new Error('dictionary port failed'));expect(await handler({type:'selectionWordLookup',word:'sample'})).toEqual({success:false,error:'dictionary port failed'});
                expect(await handler({type:'unknown'})).toBe(UNHANDLED_RUNTIME_MESSAGE);
            }finally{if('dispose'in handler&&typeof handler.dispose==='function')handler.dispose();}
        });
        it('validates vision identity and converts provider-port errors at the same boundary',async()=>{
            const handler=createHandler(vi.fn());
            try{
                const identity=createVisionProbeIdentity(mocks.config as Config,'deepseek','fixture-model');
                expect(await handler({type:VISION_PROBE_MESSAGE,service:'deepseek',model:'fixture-model',identity,requestId:'vision-probe-actual-route'})).toMatchObject({success:true,supported:true});
                expect(mocks.vision).toHaveBeenCalledOnce();expect(mocks.vision.mock.calls[0][3]).toMatchObject({force:true,signal:expect.any(AbortSignal)});
                expect(await handler({type:VISION_PROBE_MESSAGE,service:'deepseek',model:'fixture-model',identity:'stale',requestId:'vision-probe-stale-route'})).toMatchObject({success:false});
                for(const error of [new Error('connection unavailable'),'connection unavailable']){mocks.runTranslationServiceConnectionTest.mockRejectedValueOnce(error);expect(await handler({type:'testTranslationServiceConnection'})).toEqual({success:false,error:'connection unavailable'});}
            }finally{if('dispose'in handler&&typeof handler.dispose==='function')handler.dispose();}
        });
    });

    it('full settings route keeps authoritative GM fields and credentials independent from optimistic config, then releases both subscriptions',async()=>{
        vi.stubGlobal('location',{href:'https://fixture.test/#fluentread-userscript-settings/general'});
        const open=vi.fn(),handler=createFullPlatformMessageHandler(open);
        try{
            const configWatch=mocks.watched.find(row=>row.key==='local:config')!,credentialWatch=mocks.watched.find(row=>row.key===LOCAL_CREDENTIALS_STORAGE_KEY)!;
            configWatch.callback(normalizeConfig({to:'ja',theme:'dark'}));credentialWatch.callback(extractConfigCredentials({token:{deepseek:'synthetic-fixture-token'}}));
            Object.assign(mocks.config,{to:'de',theme:'light'});
            await expect(handler({type:'persistConfig',mode:'patch',config:{from:'en'},expected:{from:'auto'},clientId:'full-settings',sequence:1})).resolves.toEqual({success:true,revision:0});
            expect(mocks.preparePatch).toHaveBeenLastCalledWith({from:'en'},{from:'auto'},expect.objectContaining({to:'ja',theme:'dark',token:expect.objectContaining({deepseek:'synthetic-fixture-token'})}),true);
            credentialWatch.callback(null);configWatch.callback(null);
            await handler({type:'persistConfigBatch',clientId:'full-batch',patches:[{sequence:1,config:{to:'fr'},expected:{to:'ja'}}]});
            expect(mocks.preparePatch.mock.calls.at(-1)![2].token.deepseek).toBeUndefined();
            await handler({type:'openOptionsPage',section:'models'});expect(open).toHaveBeenLastCalledWith('models');
            await handler({type:'openOptionsPage',section:42});expect(open).toHaveBeenLastCalledWith(undefined);
            handler.dispose();const calls=mocks.preparePatch.mock.calls.length;configWatch.callback(normalizeConfig({to:'es'}));credentialWatch.callback({token:{deepseek:'late'}});
            expect(await handler({type:'persistConfig',config:{to:'es'}})).toBe(UNHANDLED_RUNTIME_MESSAGE);expect(mocks.preparePatch).toHaveBeenCalledTimes(calls);
            expect(mocks.watched.every(row=>row.stop.mock.calls.length===1)).toBe(true);handler.dispose();expect(mocks.watched.every(row=>row.stop.mock.calls.length===1)).toBe(true);
        }finally{handler.dispose();vi.unstubAllGlobals();}
    });

    it('full local management preserves usage-page permissions, vocabulary settings and change notifications',async()=>{
        vi.stubGlobal('location',{href:'https://fixture.test/#fluentread-userscript-settings'});Object.assign(mocks.config,{vocabularyBookEnabled:true});
        const handler=createFullPlatformMessageHandler(vi.fn()),changed=vi.fn();browser.runtime.onMessage.addListener(changed);
        try{
            expect(await handler({type:'modelUsage',action:'query'})).toMatchObject({success:true,data:{rows:[]}});expect(mocks.usage.getDashboard).toHaveBeenCalledOnce();
            vi.stubGlobal('location',{href:'https://fixture.test/article'});expect(await handler({type:'modelUsage',action:'query'})).toMatchObject({success:false});expect(mocks.usage.getDashboard).toHaveBeenCalledOnce();
            expect(await handler({type:'fluentReadVocabularyBook',action:'list'})).toMatchObject({success:true});expect(mocks.vocabulary.list).toHaveBeenCalledOnce();
            expect(await handler({type:'fluentReadVocabularyBook',action:'clear'})).toMatchObject({success:true});expect(mocks.vocabulary.clear).toHaveBeenCalledOnce();
            expect(changed).toHaveBeenCalledWith(expect.objectContaining({type:'fluentReadVocabularyBookChanged'}),expect.anything(),expect.any(Function));
        }finally{handler.dispose();browser.runtime.onMessage.removeListener(changed);vi.unstubAllGlobals();}
    });

    it('full vocabulary writes honor the enabled setting and expose storage errors through the public response',async()=>{
        const handler=createFullPlatformMessageHandler(vi.fn());
        const errorLog=vi.spyOn(console,'error').mockImplementation(()=>{});
        const message={type:'fluentReadVocabularyBook',action:'upsert',input:{sourceLanguage:'en',targetLanguage:'zh',term:'sample',translation:'示例'}};
        try{
            Object.assign(mocks.config,{vocabularyBookEnabled:false});
            expect(await handler(message)).toMatchObject({success:false,error:{code:'invalid-input'}});expect(mocks.vocabulary.upsert).not.toHaveBeenCalled();
            Object.assign(mocks.config,{vocabularyBookEnabled:true});mocks.vocabulary.upsert.mockRejectedValueOnce(new Error('storage port failed'));
            expect(await handler(message)).toMatchObject({success:false,error:{code:'storage-error',message:'storage port failed'}});
            expect(errorLog).toHaveBeenCalledWith('[FluentRead userscript] 单词本操作失败',expect.objectContaining({message:'storage port failed'}));
        }finally{handler.dispose();errorLog.mockRestore();}
    });

    it.each([
        ['GM_info', 'isIncognito'], ['GM_info', 'isPrivate'], ['GM', 'isIncognito'], ['GM', 'isPrivate'],
    ] as const)('full vocabulary uses trusted %s.%s for both private write guards at dispatch time', async (namespace, flag) => {
        Object.assign(mocks.config, {vocabularyBookEnabled: true});
        mocks.vocabulary.upsert.mockResolvedValue({id: 'entry-1'});
        mocks.vocabulary.updateNote.mockResolvedValue({id: 'entry-1'});
        const info = {[flag]: false};
        vi.stubGlobal('GM_info', namespace === 'GM_info' ? info : undefined);
        vi.stubGlobal('GM', namespace === 'GM' ? {info} : undefined);
        const handler = createFullPlatformMessageHandler(vi.fn());
        const changed = vi.fn(); browser.runtime.onMessage.addListener(changed);
        const log = vi.spyOn(console, 'error');
        const messages = [
            {type: 'fluentReadVocabularyBook', action: 'upsert', input: {sourceLanguage: 'en', targetLanguage: 'zh', term: 'sample', translation: '示例'}},
            {type: 'fluentReadVocabularyBook', action: 'updateNote', entryId: 'entry-1', note: 'note'},
        ];
        try {
            info[flag] = true;
            for (const message of messages) {
                expect(await handler({...message, sender: {tab: {incognito: false}}, incognito: false}))
                    .toMatchObject({success: false, error: {code: 'invalid-input', message: expect.stringContaining('无痕窗口')}});
            }
            expect(mocks.vocabulary.upsert).not.toHaveBeenCalled();
            expect(mocks.vocabulary.updateNote).not.toHaveBeenCalled();
            expect(changed).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
            expect(await handler({type: 'fluentReadVocabularyBook', action: 'list'})).toMatchObject({success: true});
            info[flag] = false;
            for (const message of messages) {
                expect(await handler({...message, sender: {tab: {incognito: true}}, incognito: true})).toMatchObject({success: true});
            }
            expect(mocks.vocabulary.upsert).toHaveBeenCalledOnce();
            expect(mocks.vocabulary.updateNote).toHaveBeenCalledOnce();
            expect(changed).toHaveBeenCalledTimes(2);
        } finally {handler.dispose();browser.runtime.onMessage.removeListener(changed);log.mockRestore();vi.unstubAllGlobals();}
    });

    it('full vocabulary ordinary writes keep working without manager metadata and ignore forged private payload', async () => {
        vi.stubGlobal('GM_info', undefined); vi.stubGlobal('GM', undefined);
        Object.assign(mocks.config, {vocabularyBookEnabled: true});
        mocks.vocabulary.upsert.mockResolvedValue({id: 'entry-1'});mocks.vocabulary.updateNote.mockResolvedValue({id: 'entry-1'});
        const handler = createFullPlatformMessageHandler(vi.fn());
        try {
            expect(await handler({type: 'fluentReadVocabularyBook', action: 'upsert', input: {sourceLanguage: 'en', targetLanguage: 'zh', term: 'sample', translation: '示例'}, sender: {tab: {incognito: true}}})).toMatchObject({success: true});
            expect(await handler({type: 'fluentReadVocabularyBook', action: 'updateNote', entryId: 'entry-1', note: 'note', incognito: true})).toMatchObject({success: true});
            expect(mocks.vocabulary.upsert).toHaveBeenCalledOnce();expect(mocks.vocabulary.updateNote).toHaveBeenCalledOnce();
        } finally {handler.dispose();vi.unstubAllGlobals();}
    });

    it('full management leaves usage and credential authority untrusted when the current page has no location', async () => {
        vi.stubGlobal('location', undefined);
        const handler = createFullPlatformMessageHandler(vi.fn());
        try {
            expect(await handler({type: 'modelUsage', action: 'query'})).toMatchObject({success: false});
            expect(await handler({type: 'persistConfig', mode: 'patch', clientId: 'no-location', sequence: 1, config: {to: 'de'}, expected: {to: 'en'}, sender: {url: 'https://fixture.test/#fluentread-userscript-settings'}})).toMatchObject({success: true});
            expect(await handler({type: 'persistConfigBatch', clientId: 'no-location-batch', patches: [{sequence: 1, config: {to: 'de'}, expected: {to: 'en'}}]})).toMatchObject({success: true});
            expect(mocks.usage.getDashboard).not.toHaveBeenCalled();expect(mocks.saveConfig).toHaveBeenCalledTimes(2);
            expect(mocks.preparePatch.mock.calls.map(call => call[3])).toEqual([false, false]);
        } finally {handler.dispose();vi.unstubAllGlobals();}
    });

    it('full disposal releases every GM subscription once even when both unsubscribe functions fail and reenter',async()=>{
        const handler=createFullPlatformMessageHandler(vi.fn()),first=new Error('first unsubscribe failed');
        mocks.watched[0].stop.mockImplementation(()=>{handler.dispose();throw first;});
        mocks.watched[1].stop.mockImplementation(()=>{throw new Error('second unsubscribe failed');});
        expect(()=>handler.dispose()).toThrow(first);expect(mocks.watched.every(row=>row.stop.mock.calls.length===1)).toBe(true);
        expect(()=>handler.dispose()).not.toThrow();expect(await handler({type:'clearTranslationCache'})).toBe(UNHANDLED_RUNTIME_MESSAGE);
        expect(mocks.cleanupTranslationCache).not.toHaveBeenCalled();
    });

});

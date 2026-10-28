import {describe, expect, it, vi} from 'vitest';
import ts from 'typescript';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';

import {
    createBrowserVocabularyBookChangedBroadcaster,
    createVocabularyBackgroundHandlers,
    createVocabularyBookChangedMessage,
    createVocabularyBookHandler,
    VOCABULARY_BOOK_CHANGED_ACK_RESPONSE,
    type VocabularyBookBackgroundDependencies,
} from '@/src/features/vocabulary/background';
import {createBackgroundMessageRouter} from '@/src/services/messaging/backgroundRouter';
import {isTrustedSettingsSender} from '@/src/app/background/handlers/trustedSettingsSender';
import {
    VOCABULARY_BOOK_CHANGED_MESSAGE,
    VOCABULARY_BOOK_MESSAGE,
} from '@/src/features/vocabulary/protocol';

function protocolTypeDiagnostics(body: string): string[] {
    const file = resolve(process.cwd(), '.vocabulary-protocol-contract.ts');
    const options: ts.CompilerOptions = {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,
        moduleResolution:ts.ModuleResolutionKind.Bundler,strict:true,skipLibCheck:true,noEmit:true,types:[]};
    const host = ts.createCompilerHost(options); const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name,languageVersion,onError,createNew) => name === file
        ? ts.createSourceFile(name,body,languageVersion,true) : original(name,languageVersion,onError,createNew);
    return ts.getPreEmitDiagnostics(ts.createProgram([file],options,host)).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n'));
}

const contractImports = `import type * as Wire from './src/features/vocabulary/protocol';
import type * as Domain from './src/features/vocabulary/learningModel';
type Assert<T extends true> = T;
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;`;

describe('vocabulary wire and domain contracts', () => {
    it('compiles every persisted status and shared contract while retaining the wire context boundary', () => {
        const errors = protocolTypeDiagnostics(contractImports+`
const states: Domain.VocabularyStatus[] = ['new','learning','familiar','mastered'];
const list: Wire.VocabularyListOptions = {status:states};
type Status = Assert<Equal<Wire.VocabularyStatus,Domain.VocabularyStatus>>;
type List = Assert<Equal<Wire.VocabularyListOptions,Domain.VocabularyListOptions>>;
type Rating = Assert<Equal<Wire.VocabularyReviewRating,Domain.VocabularyReviewRating>>;
type Scheduled = Assert<Equal<Wire.VocabularyScheduledReviewRating,Domain.VocabularyScheduledReviewRating>>;
type Export = Assert<Equal<Wire.VocabularyExportOptions,Domain.VocabularyExportOptions>>;
type Error = Assert<Equal<Wire.VocabularyBookErrorCode,Domain.VocabularyBookErrorCode>>;
type Response = Assert<Equal<Wire.VocabularyBookResponse<string>,Domain.VocabularyBookResponse<string>>>;
type Changed = Assert<Equal<Wire.VocabularyBookChangedMessage,Domain.VocabularyBookChangedMessage>>;
type Upsert = Assert<Equal<Omit<Wire.VocabularyUpsertInput,'context'|'contexts'>,Omit<Domain.VocabularyUpsertInput,'context'|'contexts'>>>;
type Actions = Assert<Equal<Exclude<Wire.VocabularyBookAction,'reencounterGet'|'reencounterList'>,Domain.VocabularyBookRequest['action']>>;
type Message = Assert<Equal<typeof import('./src/features/vocabulary/protocol').VOCABULARY_BOOK_MESSAGE,typeof import('./src/features/vocabulary/learningModel').VOCABULARY_BOOK_MESSAGE>>;
const wireContext: Wire.VocabularyContextInput = {sourceUrl:'https://example.test/source'};
const input: Wire.VocabularyUpsertInput = {sourceLanguage:'en',targetLanguage:'zh-CN',term:'art',translation:'艺术',context:wireContext};
const untrusted: Wire.VocabularyBookRuntimeMessage = {type:'fluentReadVocabularyBook',action:{malformed:true},input:false};
type RequiredDomainText = Assert<undefined extends Domain.VocabularyContextInput['text']?false:true>;
`);
        expect(errors).toEqual([]);
    });
    it('still rejects unknown statuses, unsupported ratings, missing save fields and domain contexts without text', () => {
        const errors = protocolTypeDiagnostics(contractImports+`
const status: Wire.VocabularyStatus = 'unsupported';
const rating: Wire.VocabularyScheduledReviewRating = 'perfect';
const save: Wire.VocabularyUpsertInput = {term:'art'};
const context: Domain.VocabularyContextInput = {sourceUrl:'https://example.test/source'};
`);
        expect(errors).toHaveLength(4);
        expect(errors.some(error=>error.includes('unsupported'))).toBe(true);
        expect(errors.some(error=>error.includes('perfect'))).toBe(true);
        expect(errors.some(error=>error.includes('sourceLanguage'))).toBe(true);
        expect(errors.some(error=>error.includes('text'))).toBe(true);
    });
    it('emits a standalone wire protocol with no runtime dependency on model algorithms or storage', () => {
        const source=readFileSync(resolve(process.cwd(),'src/features/vocabulary/protocol.ts'),'utf8');
        const emitted=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
        const ast=ts.createSourceFile('protocol.js',emitted,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
        expect(ast.statements.filter(statement=>ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement)&&statement.moduleSpecifier)).toEqual([]);
    });
});

async function flushMicrotasks(times = 4): Promise<void> {
    for (let index = 0; index < times; index += 1) await Promise.resolve();
}

function createRepository() {
    return {
        list: vi.fn(async (options = {}) => ({method: 'list', options})),
        get: vi.fn(async (entryId: string) => ({method: 'get', entryId})),
        getByTerm: vi.fn(async (sourceLanguage: string, term: string) => ({method: 'getByTerm', sourceLanguage, term})),
        upsert: vi.fn(async () => ({id: 'entry-upsert', method: 'upsert'})),
        updateNote: vi.fn(async (entryId: string, note: string) => ({id:entryId, note})),
        review: vi.fn(async (entryId: string, rating: string) => ({method: 'review', entryId, rating})),
        setMastery: vi.fn(async (entryId: string) => ({method: 'setMastery', entryId})),
        relearn: vi.fn(async (entryId: string) => ({method: 'relearn', entryId})),
        getReviewLogs: vi.fn(async (entryId: string) => ({method: 'getReviewLogs', entryId})),
        remove: vi.fn(async (entryId: string): Promise<unknown> => ({id: entryId, removed: true})),
        removeWithUndo: vi.fn(async (entryId: string): Promise<unknown> => ({id:'00000000-0000-4000-8000-000000000001',term:entryId})),
        listUndo: vi.fn(async () => []),
        restoreUndo: vi.fn(async () => 'restored' as const),
        discardUndo: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
        exportData: vi.fn(async (options) => ({method: 'exportData', options})),
        importData: vi.fn(async (data) => ({method: 'importData', data})),
    };
}

function createDependencies(overrides: Partial<VocabularyBookBackgroundDependencies> = {}) {
    const repository = createRepository();
    const dependencies: VocabularyBookBackgroundDependencies = {
        configReady: Promise.resolve(),
        isVocabularyBookEnabled: () => true,
        vocabularyBook: repository as unknown as VocabularyBookBackgroundDependencies['vocabularyBook'],
        vocabularyUndo: repository,
        broadcastChanged: vi.fn(),
        logOperationFailure: vi.fn(),
        ...overrides,
    };
    return {dependencies, repository};
}

describe('vocabulary background message handlers', () => {
    it('only lets the same extension settings page access durable deletion recovery', async () => {
        const {dependencies, repository} = createDependencies({isTrustedUndoSender: sender =>
            isTrustedSettingsSender(sender, 'fixture-id', 'chrome-extension://fixture-id/options.html')});
        const handler = createVocabularyBookHandler(dependencies);
        const id = '00000000-0000-4000-8000-000000000001';
        const actions = [
            {type:VOCABULARY_BOOK_MESSAGE,action:'listUndo'},
            {type:VOCABULARY_BOOK_MESSAGE,action:'removeWithUndo',entryId:'entry'},
            {type:VOCABULARY_BOOK_MESSAGE,action:'restoreUndo',undoId:id},
            {type:VOCABULARY_BOOK_MESSAGE,action:'discardUndo',undoId:id},
        ];
        for (const sender of [undefined, {id:'fixture-id',url:'https://example.test/'},
            {id:'other',url:'chrome-extension://fixture-id/options.html'},
            {id:'fixture-id',url:'chrome-extension://fixture-id/popup.html'},
            {id:'fixture-id',url:'chrome-extension://fixture-id/options.html',tab:{incognito:true}}]) {
            for (const message of actions) expect(await handler.handle(message, {sender})).toMatchObject({success:false,error:{code:'invalid-input'}});
        }
        const missingPolicy=createDependencies();
        expect(await createVocabularyBookHandler(missingPolicy.dependencies).handle(actions[0],{sender:{id:'fixture-id',url:'chrome-extension://fixture-id/options.html'}})).toMatchObject({success:false});
        expect(missingPolicy.repository.listUndo).not.toHaveBeenCalled();
        expect(repository.listUndo).not.toHaveBeenCalled(); expect(repository.removeWithUndo).not.toHaveBeenCalled();
        expect(repository.restoreUndo).not.toHaveBeenCalled(); expect(repository.discardUndo).not.toHaveBeenCalled();
        const sender = {id:'fixture-id',url:'chrome-extension://fixture-id/options.html#settings-vocabulary'};
        for (const message of actions) expect(await handler.handle(message, {sender})).toMatchObject({success:true});
        expect(await handler.handle({...actions[2],undoId:'not-a-ticket'}, {sender})).toMatchObject({success:false,error:{code:'invalid-input'}});
        expect(repository.restoreUndo).toHaveBeenCalledOnce();
        expect(dependencies.logOperationFailure).not.toHaveBeenCalled();
    });
    it.each(['invalid-input','limit-exceeded'])('maps confirmed undo errors to fixed safe messages: %s',async code=>{
        const {dependencies,repository}=createDependencies({isTrustedUndoSender:()=>true});
        repository.listUndo.mockRejectedValueOnce(Object.assign(new Error('private secret'),{name:'VocabularyBookError',code}));
        const result=await createVocabularyBookHandler(dependencies).handle({type:VOCABULARY_BOOK_MESSAGE,action:'listUndo'},{});
        expect(result).toMatchObject({success:false,error:{code}});expect(JSON.stringify(result)).not.toContain('private secret');
        expect(dependencies.logOperationFailure).not.toHaveBeenCalled();
    });
    it('does not leak private text through clear failure diagnostics',async()=>{
        const {dependencies,repository}=createDependencies();repository.clear.mockRejectedValueOnce(new Error('private reading https://secret.test'));
        const result=await createVocabularyBookHandler(dependencies).handle({type:VOCABULARY_BOOK_MESSAGE,action:'clear'},{});
        expect(result).toMatchObject({success:false,error:{code:'storage-error'}});
        expect(JSON.stringify(result)).not.toContain('private');expect(dependencies.logOperationFailure).not.toHaveBeenCalled();
    });
    it('never logs or returns undo storage exceptions containing private text',async()=>{
        const {dependencies,repository}=createDependencies({isTrustedUndoSender:()=>true});
        repository.listUndo.mockRejectedValueOnce(new Error('private text https://example.test/secret'));
        const result=await createVocabularyBookHandler(dependencies).handle({type:VOCABULARY_BOOK_MESSAGE,action:'listUndo'},{});
        expect(result).toMatchObject({success:false,error:{code:'storage-error'}});
        expect(JSON.stringify(result)).not.toContain('private');expect(dependencies.logOperationFailure).not.toHaveBeenCalled();
    });
    it('再次遇见只返回最小表达列表，并在主动打开后才返回对应收藏原句', async () => {
        const {dependencies, repository} = createDependencies({isReencounterEnabled: () => true});
        const entry = {id: 'art', term: 'art', sourceLanguage: 'en', contexts: [{text: 'Art matters.', capturedAt: 1}], translations: {zh: {text: '艺术', updatedAt: 1}}, reviewCount: 7};
        repository.list.mockResolvedValue([entry] as never); repository.get.mockResolvedValue(entry as never);
        const handler = createVocabularyBookHandler(dependencies);
        const result = await handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'reencounterList'}, {});
        expect(result).toEqual({success: true, data: [{id: 'art', term: 'art', sourceLanguage: 'en', reference: '', savedSentence: '', savedTitle: ''}]});
        expect(repository.get).not.toHaveBeenCalled();
        expect(await handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'reencounterGet', entryId: 'art'}, {})).toMatchObject({success: true, data: {savedSentence: 'Art matters.', reference: '艺术'}});
        expect(repository.review).not.toHaveBeenCalled(); expect(dependencies.broadcastChanged).not.toHaveBeenCalled(); expect(entry.reviewCount).toBe(7);
        repository.get.mockResolvedValueOnce(null as never);
        expect(await handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'reencounterGet', entryId: 'missing'}, {})).toMatchObject({success: false, error: {code: 'not-found'}});
    });
    it('再次遇见在后台强制遵守关闭与无痕边界', async () => {
        for (const action of ['reencounterList', 'reencounterGet']) {
            const disabled = createDependencies();
            expect(await createVocabularyBookHandler(disabled.dependencies).handle({type: VOCABULARY_BOOK_MESSAGE, action, entryId: 'art'}, {})).toMatchObject({success: false, error: {code: 'invalid-input'}});
            expect(disabled.repository.list).not.toHaveBeenCalled(); expect(disabled.repository.get).not.toHaveBeenCalled();
            const enabled = createDependencies({isReencounterEnabled: () => true});
            expect(await createVocabularyBookHandler(enabled.dependencies).handle({type: VOCABULARY_BOOK_MESSAGE, action, entryId: 'art'}, {sender: {tab: {incognito: true}}})).toMatchObject({success: false});
            expect(enabled.repository.list).not.toHaveBeenCalled(); expect(enabled.repository.get).not.toHaveBeenCalled();
        }
    });
    it('修改解释不依赖收藏入口开关，校验解释并阻止无痕修改', async () => {
        const {dependencies, repository} = createDependencies({isVocabularyBookEnabled: () => false});
        const handler = createVocabularyBookHandler(dependencies);
        const request = {type:VOCABULARY_BOOK_MESSAGE, action:'updateNote', entryId:'sentence', note:'一句简单解释'};
        expect(await handler.handle(request, {})).toEqual({success:true, data:{id:'sentence', note:'一句简单解释'}});
        expect(repository.updateNote).toHaveBeenCalledWith('sentence', '一句简单解释');
        expect(dependencies.broadcastChanged).toHaveBeenCalledWith('note', 'sentence');
        expect(await handler.handle({...request, note:42}, {})).toMatchObject({success:false, error:{code:'invalid-input'}});
        expect(await handler.handle(request, {sender:{tab:{incognito:true}}})).toMatchObject({success:false, error:{code:'invalid-input'}});
    });
    it('允许保存没有AI释义的多语种原文', async () => {
        const {dependencies, repository} = createDependencies();
        const handler = createVocabularyBookHandler(dependencies);
        const input = {sourceLanguage: 'ja', targetLanguage: 'zh-CN', term: 'この文章を覚えたい。', translation: ''};
        expect(await handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'upsert', input}, {})).toMatchObject({success: true});
        expect(repository.upsert).toHaveBeenCalledWith(input);
    });
    it('通过静态 registry 处理变更通知 ACK 和词书请求', async () => {
        const {dependencies, repository} = createDependencies();
        const router = createBackgroundMessageRouter(createVocabularyBackgroundHandlers(dependencies));

        await expect(router.dispatch({
            type: VOCABULARY_BOOK_CHANGED_MESSAGE,
            reason: 'upsert',
        }, {})).resolves.toEqual({
            handled: true,
            response: VOCABULARY_BOOK_CHANGED_ACK_RESPONSE,
        });

        await expect(router.dispatch({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'get',
            entryId: ' entry-1 ',
        }, {})).resolves.toEqual({
            handled: true,
            response: {success: true, data: {method: 'get', entryId: 'entry-1'}},
        });
        expect(repository.get).toHaveBeenCalledWith('entry-1');
    });

    it('覆盖读取类 action 和 getByTerm 的 term/word 兼容路径', async () => {
        const {dependencies, repository} = createDependencies();
        const handler = createVocabularyBookHandler(dependencies);

        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'list'}, {}))
            .resolves.toEqual({success: true, data: {method: 'list', options: {}}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'list', options: {status: 'new'}}, {}))
            .resolves.toEqual({success: true, data: {method: 'list', options: {status: 'new'}}});
        await expect(handler.handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'getByTerm',
            sourceLanguage: 'en',
            term: 'common',
        }, {})).resolves.toEqual({success: true, data: {method: 'getByTerm', sourceLanguage: 'en', term: 'common'}});
        await expect(handler.handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'getByTerm',
            sourceLanguage: 'en',
            word: 'rare',
        }, {})).resolves.toEqual({success: true, data: {method: 'getByTerm', sourceLanguage: 'en', term: 'rare'}});

        expect(repository.list).toHaveBeenCalledWith(undefined);
        expect(repository.list).toHaveBeenCalledWith({status: 'new'});
        expect(repository.getByTerm).toHaveBeenCalledWith('en', 'common');
        expect(repository.getByTerm).toHaveBeenCalledWith('en', 'rare');
    });

    it('执行会广播的写入和复习 action，并保持旧响应结构', async () => {
        const {dependencies, repository} = createDependencies();
        const handler = createVocabularyBookHandler(dependencies);

        const input = {sourceLanguage: 'en', targetLanguage: 'zh-CN', term: 'common', translation: '常见'};
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'upsert', input}, {}))
            .resolves.toEqual({success: true, data: {id: 'entry-upsert', method: 'upsert'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'review', entryId: 'entry-1', rating: 'good'}, {}))
            .resolves.toEqual({success: true, data: {method: 'review', entryId: 'entry-1', rating: 'good'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'setMastery', entryId: 'entry-1'}, {}))
            .resolves.toEqual({success: true, data: {method: 'setMastery', entryId: 'entry-1'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'relearn', entryId: 'entry-1'}, {}))
            .resolves.toEqual({success: true, data: {method: 'relearn', entryId: 'entry-1'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'clear'}, {}))
            .resolves.toEqual({success: true, data: true});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'importData', data: {entries: []}}, {}))
            .resolves.toEqual({success: true, data: {method: 'importData', data: {entries: []}}});

        expect(repository.upsert).toHaveBeenCalledWith(input);
        expect(dependencies.broadcastChanged).toHaveBeenCalledWith('upsert', 'entry-upsert');
        expect(dependencies.broadcastChanged).toHaveBeenCalledWith('review', 'entry-1');
        expect(dependencies.broadcastChanged).toHaveBeenCalledWith('manual-mastered', 'entry-1');
        expect(dependencies.broadcastChanged).toHaveBeenCalledWith('relearn', 'entry-1');
        expect(dependencies.broadcastChanged).toHaveBeenCalledWith('clear', undefined);
        expect(dependencies.broadcastChanged).toHaveBeenCalledWith('import', undefined);
    });

    it('执行删除、日志、导出 action，并只在真实删除时广播', async () => {
        const {dependencies, repository} = createDependencies();
        const handler = createVocabularyBookHandler(dependencies);

        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'getReviewLogs', entryId: 'entry-1'}, {}))
            .resolves.toEqual({success: true, data: {method: 'getReviewLogs', entryId: 'entry-1'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'remove', entryId: 'entry-1'}, {}))
            .resolves.toEqual({success: true, data: {id: 'entry-1', removed: true}});
        repository.remove.mockResolvedValueOnce(false);
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'remove', entryId: 'entry-missing'}, {}))
            .resolves.toEqual({success: true, data: false});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'removeWithSnapshot', entryId: 'entry-2'}, {}))
            .resolves.toMatchObject({success:false});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'exportData', options: {format: 'anki'}}, {}))
            .resolves.toEqual({success: true, data: {method: 'exportData', options: {format: 'anki'}}});

        expect(dependencies.broadcastChanged).toHaveBeenCalledWith('remove', 'entry-1');
        expect(dependencies.broadcastChanged).toHaveBeenCalledTimes(1);
    });

    it('功能未启用、无痕窗口和非法 entryId 都返回词书业务错误', async () => {
        const disabled = createDependencies({isVocabularyBookEnabled: () => false});
        await expect(createVocabularyBookHandler(disabled.dependencies).handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'upsert',
            input: {sourceLanguage: 'en', targetLanguage: 'zh-CN', term: 'common', translation: '常见'},
        }, {})).resolves.toMatchObject({
            success: false,
            error: {code: 'invalid-input', message: '请先在单词本页面开启功能'},
        });
        expect(disabled.repository.upsert).not.toHaveBeenCalled();

        const incognito = createDependencies();
        await expect(createVocabularyBookHandler(incognito.dependencies).handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'upsert',
            input: {sourceLanguage: 'en', targetLanguage: 'zh-CN', term: 'common', translation: '常见'},
        }, {sender: {tab: {incognito: true}}})).resolves.toMatchObject({
            success: false,
            error: {code: 'invalid-input', message: '无痕窗口不保存单词本数据'},
        });
        expect(incognito.repository.upsert).not.toHaveBeenCalled();

        const invalid = createDependencies();
        await expect(createVocabularyBookHandler(invalid.dependencies).handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'get',
            entryId: 42,
        }, {})).resolves.toMatchObject({
            success: false,
            error: {code: 'invalid-input', message: '缺少有效的单词条目标识'},
        });
        await expect(createVocabularyBookHandler(invalid.dependencies).handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'get',
            entryId: '   ',
        }, {})).resolves.toMatchObject({
            success: false,
            error: {code: 'invalid-input', message: '缺少有效的单词条目标识'},
        });
    });

    it('存储失败、非 Error 异常、广播同步失败和非法 action 都按旧协议返回', async () => {
        const storageFailure = createDependencies();
        storageFailure.repository.list.mockRejectedValueOnce(new Error('indexeddb blocked'));
        await expect(createVocabularyBookHandler(storageFailure.dependencies).handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'list',
        }, {})).resolves.toEqual({
            success: false,
            error: {code: 'storage-error', message: 'indexeddb blocked'},
        });
        expect(storageFailure.dependencies.logOperationFailure).toHaveBeenCalledWith(expect.any(Error));

        const nonErrorFailure = createDependencies();
        nonErrorFailure.repository.exportData.mockRejectedValueOnce('plain failure');
        await expect(createVocabularyBookHandler(nonErrorFailure.dependencies).handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'exportData',
        }, {})).resolves.toEqual({
            success: false,
            error: {code: 'storage-error', message: '本地单词本暂时不可用'},
        });
        expect(nonErrorFailure.dependencies.logOperationFailure).toHaveBeenCalledWith('plain failure');

        const broadcastFailure = createDependencies({broadcastChanged: vi.fn(() => { throw new Error('broadcast failed'); })});
        await expect(createVocabularyBookHandler(broadcastFailure.dependencies).handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'review',
            entryId: 'entry-1',
            rating: 'again',
        }, {})).resolves.toEqual({success: true, data: {method: 'review', entryId: 'entry-1', rating: 'again'}});
        expect(broadcastFailure.dependencies.logOperationFailure).toHaveBeenCalledWith(expect.any(Error));

        const illegal = createDependencies();
        await expect(createVocabularyBookHandler(illegal.dependencies).handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'dropAll',
        }, {})).resolves.toMatchObject({
            success: false,
            error: {code: 'invalid-input', message: '不支持的单词本操作'},
        });
    });

    it('拒绝后台信任边界上的非法 payload，不把 unknown 强转给 repository', async () => {
        const {dependencies, repository} = createDependencies();
        const handler = createVocabularyBookHandler(dependencies);

        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'getByTerm', sourceLanguage: 'en'}, {}))
            .resolves.toMatchObject({success: false, error: {code: 'invalid-input', message: '缺少有效的查询单词'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'getByTerm', term: 'common'}, {}))
            .resolves.toMatchObject({success: false, error: {code: 'invalid-input', message: '缺少有效的源语言'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'upsert', input: 'common'}, {}))
            .resolves.toMatchObject({success: false, error: {code: 'invalid-input', message: '缺少有效的单词保存内容'}});
        await expect(handler.handle({
            type: VOCABULARY_BOOK_MESSAGE,
            action: 'upsert',
            input: {sourceLanguage: 'en', targetLanguage: 'zh-CN', term: 'common'},
        }, {})).resolves.toMatchObject({success: false, error: {code: 'invalid-input', message: '缺少有效的译文'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'review', entryId: 'entry-1', rating: 'easy'}, {}))
            .resolves.toMatchObject({success: false, error: {code: 'invalid-input', message: '缺少有效的复习评分'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'list', options: []}, {}))
            .resolves.toMatchObject({success: false, error: {code: 'invalid-input', message: '查询选项无效'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'exportData', options: []}, {}))
            .resolves.toMatchObject({success: false, error: {code: 'invalid-input', message: '导出选项无效'}});
        await expect(handler.handle({type: VOCABULARY_BOOK_MESSAGE, action: 'importData', data: []}, {}))
            .resolves.toMatchObject({success: false, error: {code: 'invalid-input', message: '导入数据无效'}});

        expect(repository.getByTerm).not.toHaveBeenCalled();
        expect(repository.upsert).not.toHaveBeenCalled();
        expect(repository.review).not.toHaveBeenCalled();
        expect(repository.importData).not.toHaveBeenCalled();
    });
});

describe('vocabulary browser changed broadcaster', () => {
    it('构造带 entryId 的变更消息，并广播到扩展页和可用 tab', async () => {
        const sendRuntimeMessage = vi.fn(async () => undefined);
        const queryTabs = vi.fn(async () => [{id: 1}, {}, {id: 2}]);
        const sendTabMessage = vi.fn(async () => undefined);
        const broadcaster = createBrowserVocabularyBookChangedBroadcaster({
            sendRuntimeMessage,
            queryTabs,
            sendTabMessage,
        });

        broadcaster('upsert', 'entry-1');
        await flushMicrotasks();

        const message = createVocabularyBookChangedMessage('upsert', 'entry-1');
        expect(sendRuntimeMessage).toHaveBeenCalledWith(message);
        expect(queryTabs).toHaveBeenCalledOnce();
        expect(sendTabMessage).toHaveBeenCalledWith(1, message);
        expect(sendTabMessage).toHaveBeenCalledWith(2, message);
        expect(sendTabMessage).toHaveBeenCalledTimes(2);
    });

    it('构造不带 entryId 的变更消息，并吞掉广播链路失败', async () => {
        const runtimeFailure = new Error('runtime closed');
        const sendRuntimeMessage = vi.fn(async () => { throw runtimeFailure; });
        const queryTabs = vi.fn()
            .mockRejectedValueOnce(new Error('tabs unavailable'))
            .mockResolvedValueOnce([{id: 1}]);
        const sendTabMessage = vi.fn(async () => { throw new Error('restricted tab'); });
        const broadcaster = createBrowserVocabularyBookChangedBroadcaster({
            sendRuntimeMessage,
            queryTabs,
            sendTabMessage,
        });

        expect(() => broadcaster('clear')).not.toThrow();
        await flushMicrotasks();
        expect(sendRuntimeMessage).toHaveBeenCalledWith({type: VOCABULARY_BOOK_CHANGED_MESSAGE, reason: 'clear'});
        expect(queryTabs).toHaveBeenCalledOnce();

        expect(() => broadcaster('import')).not.toThrow();
        await flushMicrotasks();
        expect(sendTabMessage).toHaveBeenCalledWith(1, {type: VOCABULARY_BOOK_CHANGED_MESSAGE, reason: 'import'});
    });
});

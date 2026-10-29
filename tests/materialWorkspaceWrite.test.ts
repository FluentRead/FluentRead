/**
 * @file tests/materialWorkspaceWrite.test.ts
 * 文件职责：验证设置页材料写入的轻量回执、权限边界和事务结果。
 * 主要内容：覆盖每类写入、通知、未知结果恢复、拒绝网页与无痕访问，并保持旧采集和解析合同。
 * 模块边界：使用模拟 IndexedDB 和后台 handler，不模拟浏览器进程消息传输或真实崩溃。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {isTrustedSettingsSender} from '@/src/app/background/handlers/trustedSettingsSender';
import {createMaterialBackgroundHandler, type MaterialBackgroundContext} from '@/src/features/vocabulary/materialBackground';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {MATERIAL_MESSAGE, type MaterialCaptureInput, type MaterialRequest} from '@/src/features/vocabulary/materialProtocol';

let serial = 0;
const databases: MaterialDatabase[] = [];
function makeDatabase(): MaterialDatabase {const db = new MaterialDatabase(`material-workspace-write-${++serial}`); databases.push(db); return db;}
afterEach(async () => {const opened=databases.splice(0), names=new Set(opened.map(db=>db.name));for(const db of opened)db.close();for(const name of names)await Dexie.delete(name);});
const sender = {id:'test',url:'chrome-extension://test/options.html?section=materials#list'};
const source = {kind:'article' as const,url:'https://example.test/article',title:'Article'};
const input = (note = 'private material note'):MaterialCaptureInput => ({source,reference:{kind:'note',id:'note-1',note},capturedAt:10});
const message = (action:string, fields:Record<string,unknown> = {}) => ({type:MATERIAL_MESSAGE,action,...fields}) as MaterialRequest;
function setup(overrides: {privateContext?:boolean;allowCapture?:boolean;changed?:()=>void;trusted?:boolean} = {}) {
    const db = makeDatabase(), repo = new MaterialRepository(db), changed = vi.fn(overrides.changed ?? (()=>{}));
    const handler = createMaterialBackgroundHandler({repository:repo,ready:Promise.resolve(),isPrivateContext:()=>overrides.privateContext === true,
        isExtensionUrl:url=>url.startsWith('chrome-extension://test/'),
        isTrustedWorkspace:overrides.trusted === false ? undefined : value=>isTrustedSettingsSender(value,'test','chrome-extension://test/options.html'),
        canCapture:()=>overrides.allowCapture !== false,changed});
    const call = (action:string,fields:Record<string,unknown> = {},context:MaterialBackgroundContext = {sender}) => handler.handle(message(action,fields),context);
    return {db,repo,changed,call};
}

describe('settings material workspace write receipts', () => {
    it('returns only IDs for capture, edit, reference removal, archive and restore and broadcasts each commit', async () => {
        const {db,repo,changed,call} = setup();
        const captured = await call('workspaceCapture',{input:input()});
        expect(captured.success).toBe(true);
        if (!captured.success) throw Error('capture failed');
        const id = (captured.data as {id:string}).id;
        const bulky = await repo.get(id); expect(bulky).not.toBeNull();
        const refs = Array.from({length:64},(_,i)=>({kind:'note' as const,id:`n-${i}`,note:'private-'.repeat(3000)}));
        await db.materials.update(id,{references:refs});
        const cases = [
            ['workspaceUpdate',{id,patch:{title:'Updated'}}],
            ['workspaceRemoveReference',{id,kind:'note',referenceId:'n-0'}],
            ['workspaceArchive',{id}], ['workspaceRestore',{id}],
        ] as const;
        for (const [action,fields] of cases) {
            const result = await call(action,fields);
            expect(result).toEqual({success:true,data:{id}});
            expect(JSON.stringify(result)).not.toContain('private-');
        }
        expect(changed).toHaveBeenCalledTimes(5);
        expect(await repo.get(id)).toMatchObject({title:'Updated',archivedAt:null});
        expect((await repo.get(id))?.references).toHaveLength(63);
    });
    it('rejects non-settings senders and all incognito variants without writes or notifications', async () => {
        const {repo,changed,call} = setup();
        const senders:MaterialBackgroundContext['sender'][] = [undefined, {id:'other',url:sender.url},
            {id:'test',url:'chrome-extension://other/options.html'}, {id:'test',url:'chrome-extension://test/popup.html'},
            {id:'test',url:'chrome-extension://test/options.html.evil'}, {id:'test',url:'https://example.test/options.html'},
            {id:'test',tab:{url:sender.url}}, {...sender,incognito:true}, {...sender,tab:{incognito:true}}];
        for (const value of senders) {
            const result = await call('workspaceCapture',{input:input()},{sender:value});
            expect(result).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        }
        expect(await repo.list()).toEqual([]); expect(changed).not.toHaveBeenCalled();
        const privateSetup = setup({privateContext:true});
        expect(await privateSetup.call('workspaceCapture',{input:input()})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        const noTrust = setup({trusted:false});
        expect(await noTrust.call('workspaceCapture',{input:input()})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
    });
    it('rejects every workspace-only mutation from other extension surfaces', async () => {
        const {repo,changed,call} = setup(), item = await repo.capture(input(),20);
        const popup = {sender:{id:'test',url:'chrome-extension://test/popup.html'}};
        const actions = [
            ['workspaceCapture',{input:input()}], ['workspaceUpdate',{id:item.id,patch:{title:'blocked'}}],
            ['workspaceRemoveReference',{id:item.id,kind:'note',referenceId:'note-1'}],
            ['workspaceArchive',{id:item.id}], ['workspaceRestore',{id:item.id}],
        ] as const;
        for (const [action, fields] of actions) expect(await call(action,fields,popup)).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(await repo.get(item.id)).toEqual(item); expect(changed).not.toHaveBeenCalled();
    });
    it('checks capture configuration and preserves existing operation guards', async () => {
        const disabled = setup({allowCapture:false});
        expect(await disabled.call('workspaceCapture',{input:input()})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(disabled.changed).not.toHaveBeenCalled();
        const {repo,changed,call} = setup(), saved = await repo.capture(input(),20);
        const stale = {...input('edit'),reference:{kind:'note',id:'missing',note:'edit'},referenceMode:'update-existing' as const};
        expect(await call('workspaceCapture',{input:stale})).toMatchObject({success:false,error:{code:'stale-operation'}});
        expect(await call('workspaceUpdate',{id:'missing',patch:{title:'x'}})).toMatchObject({success:false,error:{code:'not-found'}});
        expect(changed).not.toHaveBeenCalled(); expect((await repo.get(saved.id))?.references[0].note).toBe('private material note');
    });
    it('keeps a successful commit when change notification throws and lets the caller query current storage', async () => {
        const {repo,changed,call} = setup({changed:()=>{throw Error('notification channel unavailable');}});
        const result = await call('workspaceCapture',{input:input()});
        expect(result.success).toBe(true);
        if (!result.success) throw Error('capture failed');
        const id = (result.data as {id:string}).id;
        expect((await repo.get(id))?.references[0].note).toBe('private material note');
        expect(changed).toHaveBeenCalledOnce();
    });
    it('preserves full-record capture and source-authorized resolve for existing web callers', async () => {
        const {changed,call} = setup();
        const page = {sender:{id:'test',url:source.url,tab:{url:source.url}}};
        const captured = await call('capture',{input:input()},page);
        expect(captured.success).toBe(true);
        if (!captured.success) throw Error('capture failed');
        const record = captured.data as {id:string;references:unknown[]};
        expect(record.references).toMatchObject([{id:'note-1',note:'private material note'}]);
        expect(await call('resolve',{id:record.id},page)).toMatchObject({success:true,data:{id:record.id,references:record.references}});
        expect(await call('resolve',{id:record.id},{sender:{url:'https://different.test/'}})).toMatchObject({success:false,error:{code:'privacy-disabled'}});
        expect(changed).toHaveBeenCalledOnce();
    });
});

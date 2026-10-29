/**
 * @file tests/materialWorkspaceClient.test.ts
 * 文件职责：验证设置页材料写操作的轻量回执与未知结果语义。
 * 主要内容：覆盖每种写消息、无痕拒绝、领域错误、断连和格式无效的回复，不自动重放提交。
 * 模块边界：使用模拟扩展消息，不证明后台事务或真实浏览器断连时序。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {beforeEach, describe, expect, it, vi} from 'vitest';
const sendMessage = vi.hoisted(() => vi.fn());
const privateContext = vi.hoisted(() => ({inIncognitoContext:false}));
vi.mock('webextension-polyfill', () => ({default:{runtime:{sendMessage},extension:privateContext}}));
import {workspaceMaterialArchive, workspaceMaterialCapture, workspaceMaterialRemoveReference, workspaceMaterialRestore, workspaceMaterialUpdate} from '@/src/features/vocabulary/materialClient';
import {createMaterialBackgroundHandler} from '@/src/features/vocabulary/materialBackground';
import {MaterialDatabase, MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import type {MaterialRequest} from '@/src/features/vocabulary/materialProtocol';

const input = {source:{kind:'article' as const,url:'https://example.test/'},reference:{kind:'note' as const,id:'note-1',note:'private'}};
beforeEach(() => {sendMessage.mockReset(); privateContext.inIncognitoContext=false;});

describe('lightweight workspace material clients', () => {
    it('sends each typed request once and returns its ID receipt', async () => {
        sendMessage.mockResolvedValue({success:true,data:{id:'item'}});
        const results = [
            await workspaceMaterialCapture(input), await workspaceMaterialUpdate('item',{title:'Updated'}),
            await workspaceMaterialRemoveReference('item','note','note-1'), await workspaceMaterialArchive('item'), await workspaceMaterialRestore('item'),
        ];
        expect(results).toEqual(Array.from({length:5},()=>({id:'item'})));
        expect(sendMessage.mock.calls.map(([message])=>message)).toEqual([
            {type:'fluentReadMaterials',action:'workspaceCapture',input},
            {type:'fluentReadMaterials',action:'workspaceUpdate',id:'item',patch:{title:'Updated'}},
            {type:'fluentReadMaterials',action:'workspaceRemoveReference',id:'item',kind:'note',referenceId:'note-1'},
            {type:'fluentReadMaterials',action:'workspaceArchive',id:'item'},
            {type:'fluentReadMaterials',action:'workspaceRestore',id:'item'},
        ]);
    });
    it('rejects incognito before sending any write', async () => {
        privateContext.inIncognitoContext=true;
        for (const action of [()=>workspaceMaterialCapture(input),()=>workspaceMaterialUpdate('item',{title:'x'}),
            ()=>workspaceMaterialRemoveReference('item','note','note-1'),()=>workspaceMaterialArchive('item'),()=>workspaceMaterialRestore('item')]) {
            await expect(action()).rejects.toMatchObject({code:'privacy-disabled'});
        }
        expect(sendMessage).not.toHaveBeenCalled();
    });
    it('preserves a valid domain failure without automatically retrying the write', async () => {
        sendMessage.mockResolvedValue({success:false,error:{code:'stale-operation',message:'材料已清空'}});
        await expect(workspaceMaterialCapture(input)).rejects.toMatchObject({code:'stale-operation',message:'材料已清空'});
        expect(sendMessage).toHaveBeenCalledOnce();
    });
    it('reports a connection failure as an unknown outcome without exposing the transport error or retrying', async () => {
        sendMessage.mockRejectedValue(Error('private transport content'));
        await expect(workspaceMaterialCapture(input)).rejects.toMatchObject({code:'storage-error',message:'无法确认操作是否完成，请刷新材料后检查。'});
        expect(sendMessage).toHaveBeenCalledOnce();
    });
    it('leaves an actually committed write intact when its reply is lost and never automatically replays it', async () => {
        const name='material-workspace-lost-reply', db=new MaterialDatabase(name), repository=new MaterialRepository(db), changed=vi.fn();
        const handler=createMaterialBackgroundHandler({repository,ready:Promise.resolve(),isPrivateContext:()=>false,
            isExtensionUrl:url=>url.startsWith('chrome-extension://test/'),
            isTrustedWorkspace:sender=>sender?.id==='test'&&sender.url==='chrome-extension://test/options.html',
            canCapture:()=>true,changed});
        sendMessage.mockImplementation(async (message:MaterialRequest)=>{
            const response=await handler.handle(message,{sender:{id:'test',url:'chrome-extension://test/options.html'}});
            expect(response.success).toBe(true);
            throw Error('response channel closed after commit');
        });
        try {
            await expect(workspaceMaterialCapture(input)).rejects.toMatchObject({code:'storage-error',message:'无法确认操作是否完成，请刷新材料后检查。'});
            expect(sendMessage).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
            expect((await repository.list())[0].references).toMatchObject([{id:'note-1',note:'private'}]);
        } finally {db.close();await Dexie.delete(name);}
    });
    it('treats missing, malformed, or invalid receipts as unknown outcomes', async () => {
        for (const response of [undefined,null,{}, {success:'yes'}, {success:false,error:null},
            {success:false,error:{code:'storage-error'}}, {success:true}, {success:true,data:null}, {success:true,data:{}},
            {success:true,data:{id:''}}, {success:true,data:{id:'x'.repeat(257)}}, {success:true,data:{id:'item',private:'secret'}}]) {
            sendMessage.mockClear(); sendMessage.mockResolvedValue(response);
            await expect(workspaceMaterialUpdate('item',{title:'x'})).rejects.toMatchObject({code:'storage-error',message:'无法确认操作是否完成，请刷新材料后检查。'});
            expect(sendMessage).toHaveBeenCalledOnce();
        }
    });
});

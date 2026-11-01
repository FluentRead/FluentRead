import {describe,it,expect,vi} from 'vitest';
import {createMaterialBackupOpfsTarget,MaterialBackupDownloadNotStartedError,type MaterialBackupOpfsPlatform,type MaterialBackupDownloadTerminal} from '@/src/features/vocabulary/materialBackupOpfsSave';
import {saveMaterialBackup} from '@/src/features/vocabulary/materialBackupSave';
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(){
    const terminal=deferred<MaterialBackupDownloadTerminal>(),events:string[]=[];
    const release=vi.fn(()=>events.push('release'));
    const writer={write:vi.fn(async()=>{events.push('write');}),close:vi.fn(async()=>{events.push('close');}),abort:vi.fn(async()=>{events.push('abort');}),file:vi.fn(async()=>new Blob(['backup']))};
    const download={wait:vi.fn(()=>terminal.promise),cancel:vi.fn(async()=>{events.push('cancel');})};
    const platform:MaterialBackupOpfsPlatform={acquire:vi.fn(async()=>release),create:vi.fn(async()=>writer),remove:vi.fn(async()=>{events.push('remove');}),objectURL:vi.fn(()=>{events.push('url');return 'blob:test';}),revokeURL:vi.fn(()=>{events.push('revoke');}),startDownload:vi.fn(async()=>{events.push('download');return download;}),randomId:()=> 'a'.repeat(32),now:()=>1700000000000};
    return {platform,writer,download,terminal,events,release};
}
describe('OPFS material backup target',()=>{
    it('waits for verified receive and confirmed download before cleanup and saved',async()=>{
        const f=fixture(),target=await createMaterialBackupOpfsTarget('backup.json',f.platform),receive=deferred<void>();
        const work=saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));await receive.promise;});await tick();expect(f.events).toEqual(['write']);
        receive.resolve();await tick();expect(f.events).toEqual(['write','close','url','download']);expect(f.platform.remove).not.toHaveBeenCalled();
        f.terminal.resolve('complete');expect(await work).toEqual({state:'saved',bytes:1});expect(f.events).toEqual(['write','close','url','download','revoke','remove','release']);
    });
    it('cancels but retains the source and lock until download reports interruption',async()=>{
        const f=fixture(),target=await createMaterialBackupOpfsTarget('backup.json',f.platform),controller=new AbortController();
        const work=saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));},{signal:controller.signal});await tick();controller.abort();await tick();expect(f.download.cancel).toHaveBeenCalledOnce();expect(f.platform.remove).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
        f.terminal.resolve('interrupted');await expect(work).rejects.toMatchObject({name:'AbortError'});expect(f.events.slice(-3)).toEqual(['revoke','remove','release']);
    });
    it('reports a completed download even if cancellation loses the race',async()=>{
        const f=fixture(),target=await createMaterialBackupOpfsTarget('backup.json',f.platform),controller=new AbortController();const work=saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));},{signal:controller.signal});await tick();controller.abort();f.terminal.resolve('complete');expect((await work).state).toBe('saved');
    });
    it('cancels when the signal changes between a completed start and listener registration',async()=>{
        const f=fixture(),start=deferred<ReturnType<typeof fixture>['download']>(),controller=new AbortController();vi.mocked(f.platform.startDownload).mockReturnValueOnce(start.promise);
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=target.commit(controller.signal);void work.catch(()=>{});await tick();
        start.resolve(f.download);queueMicrotask(()=>queueMicrotask(()=>controller.abort()));await tick();expect(f.download.cancel).toHaveBeenCalledOnce();
        f.terminal.resolve('interrupted');await expect(work).rejects.toMatchObject({name:'AbortError'});expect(f.platform.remove).toHaveBeenCalledOnce();
    });
    it('does not wait for a stalled cancellation after a confirmed terminal state',async()=>{
        const f=fixture(),pending=deferred<void>();f.download.cancel.mockReturnValueOnce(pending.promise);
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),controller=new AbortController();
        const work=saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));},{signal:controller.signal});await tick();controller.abort();await tick();
        expect(f.download.cancel).toHaveBeenCalledOnce();f.terminal.resolve('complete');expect((await work).state).toBe('saved');expect(f.platform.remove).toHaveBeenCalledOnce();pending.reject(Error('late error'));await tick();
    });
    it('does not remove a file when download terminal state is unknown',async()=>{
        const f=fixture(),target=await createMaterialBackupOpfsTarget('backup.json',f.platform);const work=saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));});await tick();f.terminal.reject(new Error('lost download state'));await expect(work).rejects.toThrow('lost download state');expect(f.platform.remove).not.toHaveBeenCalled();expect(f.platform.revokeURL).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
    });
    it('returns an unknown result promptly when cancellation races a stalled start and cleans only after late interruption',async()=>{
        const f=fixture(),start=deferred<ReturnType<typeof fixture>['download']>();vi.mocked(f.platform.startDownload).mockReturnValueOnce(start.promise);
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),controller=new AbortController();
        const work=saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));},{signal:controller.signal});void work.catch(()=>{});await tick();controller.abort();
        await expect(work).rejects.toThrow('无法确认材料备份下载是否已开始');expect(f.platform.remove).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
        start.resolve(f.download);await tick();expect(f.download.cancel).toHaveBeenCalledOnce();expect(f.platform.remove).not.toHaveBeenCalled();
        f.terminal.resolve('interrupted');await tick();expect(f.platform.remove).toHaveBeenCalledOnce();expect(f.release).toHaveBeenCalledOnce();
    });
    it('returns an unknown result on a stalled start timeout and keeps the file while it remains unconfirmed',async()=>{
        vi.useFakeTimers();try{
            const f=fixture(),start=deferred<ReturnType<typeof fixture>['download']>();vi.mocked(f.platform.startDownload).mockReturnValueOnce(start.promise);
            const target=await createMaterialBackupOpfsTarget('backup.json',f.platform,{startTimeoutMs:25});const work=target.commit(new AbortController().signal);void work.catch(()=>{});await tick();
            await vi.advanceTimersByTimeAsync(25);await expect(work).rejects.toThrow('无法确认材料备份下载是否已开始');expect(f.platform.remove).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
            start.resolve(f.download);await tick();expect(f.download.cancel).toHaveBeenCalledOnce();f.terminal.resolve('complete');await tick();expect(f.platform.remove).toHaveBeenCalledOnce();
        }finally{vi.useRealTimers();}
    });
    it('cleans a late-started interrupted download even if cancel never resolves',async()=>{
        const f=fixture(),start=deferred<ReturnType<typeof fixture>['download']>(),cancel=deferred<void>();
        vi.mocked(f.platform.startDownload).mockReturnValueOnce(start.promise);f.download.cancel.mockReturnValueOnce(cancel.promise);
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),controller=new AbortController();
        const work=target.commit(controller.signal);void work.catch(()=>{});await tick();controller.abort();await expect(work).rejects.toThrow('无法确认材料备份下载是否已开始');
        start.resolve(f.download);await tick();f.terminal.resolve('interrupted');await tick();expect(f.platform.remove).toHaveBeenCalledOnce();cancel.reject(Error('late cancel'));await tick();
    });
    it('aborts and removes uncommitted data if receive integrity fails',async()=>{
        const f=fixture(),target=await createMaterialBackupOpfsTarget('backup.json',f.platform);await expect(saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));throw Error('digest mismatch');})).rejects.toThrow('digest mismatch');expect(f.events).toEqual(['write','abort','remove','release']);expect(f.platform.startDownload).not.toHaveBeenCalled();
    });
    it('reports that download completed if private cleanup fails',async()=>{
        const f=fixture();vi.mocked(f.platform.remove).mockRejectedValueOnce(new Error('disk error'));const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));});await tick();f.terminal.resolve('complete');await expect(work).rejects.toMatchObject({name:'MaterialBackupOpfsCleanupError',message:'材料备份已下载，但临时文件清理失败'});expect(f.release).not.toHaveBeenCalled();
    });
    it('does not let a concurrent abort remove a download source',async()=>{
        const f=fixture(),target=await createMaterialBackupOpfsTarget('backup.json',f.platform);const work=target.commit(new AbortController().signal);await tick();await expect(target.abort()).rejects.toThrow('提交尚未结束');expect(f.platform.remove).not.toHaveBeenCalled();f.terminal.resolve('complete');await work;
    });
    it('retains the source if starting a download fails and cleans it on confirmed interruption',async()=>{
        for(const reason of ['start','interrupted'] as const){const f=fixture();if(reason==='start')vi.mocked(f.platform.startDownload).mockRejectedValueOnce(Error('start failed'));const target=await createMaterialBackupOpfsTarget('backup.json',f.platform);const work=target.commit(new AbortController().signal);if(reason==='interrupted'){await tick();f.terminal.resolve('interrupted');}await expect(work).rejects.toThrow(reason==='start'?'无法确认材料备份下载是否已开始':'下载中断');if(reason==='start'){expect(f.platform.remove).not.toHaveBeenCalled();expect(f.platform.revokeURL).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();}else expect(f.events.slice(-3)).toEqual(['revoke','remove','release']);}
    });
    it('cleans up a pre-cancelled target and releases failed acquisitions safely',async()=>{
        const f=fixture(),target=await createMaterialBackupOpfsTarget('backup.json',f.platform),c=new AbortController();c.abort();await expect(target.commit(c.signal)).rejects.toMatchObject({name:'AbortError'});expect(f.events).toEqual(['abort','remove','release']);
        const denied=fixture();vi.mocked(denied.platform.acquire).mockResolvedValueOnce(undefined);await expect(createMaterialBackupOpfsTarget('backup.json',denied.platform)).rejects.toThrow('正在使用');expect(denied.platform.create).not.toHaveBeenCalled();
        const failed=fixture();vi.mocked(failed.platform.create).mockRejectedValueOnce(Error('create failed'));await expect(createMaterialBackupOpfsTarget('backup.json',failed.platform)).rejects.toThrow('create failed');expect(failed.release).toHaveBeenCalledOnce();
    });
    it('does not release a write until the underlying write and abort settle',async()=>{
        const f=fixture(),pending=deferred<void>();f.writer.write.mockReturnValueOnce(pending.promise);const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),writing=target.write(new Uint8Array([1]));await expect(target.write(new Uint8Array([2]))).rejects.toThrow('写入状态无效');const stopping=target.abort();await tick();expect(f.writer.abort).not.toHaveBeenCalled();pending.resolve();await writing;await stopping;expect(f.events.slice(-3)).toEqual(['abort','remove','release']);
    });
    it('rejects an invalid filename before acquiring a lock',async()=>{
        const f=fixture();await expect(createMaterialBackupOpfsTarget('',f.platform)).rejects.toThrow('参数无效');expect(f.platform.acquire).not.toHaveBeenCalled();
    });
    it('rejects an invalid start timeout and repeated or concurrent commit',async()=>{
        const f=fixture();await expect(createMaterialBackupOpfsTarget('backup.json',f.platform,{startTimeoutMs:0})).rejects.toThrow('启动时限无效');
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=target.commit(new AbortController().signal);await tick();
        await expect(target.commit(new AbortController().signal)).rejects.toThrow('提交状态无效');f.terminal.resolve('complete');await work;
        await expect(target.commit(new AbortController().signal)).rejects.toThrow('提交状态无效');
    });
    it('cleans a cancelled backup before a download is started',async()=>{
        const f=fixture(),closing=deferred<void>(),controller=new AbortController();f.writer.close.mockReturnValueOnce(closing.promise);
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=target.commit(controller.signal);void work.catch(()=>{});await tick();controller.abort();closing.resolve();
        await expect(work).rejects.toMatchObject({name:'AbortError'});expect(f.platform.startDownload).not.toHaveBeenCalled();expect(f.platform.remove).toHaveBeenCalledOnce();
    });
    it('cleans the private file if cancellation occurs while creating the object URL',async()=>{
        const f=fixture(),controller=new AbortController();vi.mocked(f.platform.objectURL).mockImplementationOnce(()=>{controller.abort();return 'blob:test';});
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform);await expect(target.commit(controller.signal)).rejects.toMatchObject({name:'AbortError'});
        expect(f.platform.startDownload).not.toHaveBeenCalled();expect(f.platform.revokeURL).toHaveBeenCalledWith('blob:test');expect(f.platform.remove).toHaveBeenCalledOnce();
    });
    it('retains the source if a late-started download cannot report its terminal state',async()=>{
        const f=fixture(),start=deferred<ReturnType<typeof fixture>['download']>(),controller=new AbortController();vi.mocked(f.platform.startDownload).mockReturnValueOnce(start.promise);
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=target.commit(controller.signal);void work.catch(()=>{});await tick();controller.abort();await expect(work).rejects.toThrow('无法确认材料备份下载是否已开始');
        start.resolve(f.download);await tick();f.terminal.reject(Error('state lost'));await tick();expect(f.platform.remove).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
    });
    it('retains the source when a pending start rejects after cancellation',async()=>{
        const f=fixture(),start=deferred<ReturnType<typeof fixture>['download']>(),controller=new AbortController();vi.mocked(f.platform.startDownload).mockReturnValueOnce(start.promise);
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=target.commit(controller.signal);void work.catch(()=>{});await tick();controller.abort();await expect(work).rejects.toThrow('无法确认材料备份下载是否已开始');
        start.reject(Error('request lost'));await tick();expect(f.platform.remove).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
    });
    it('cleans a late start only when the adapter proves the browser never received it',async()=>{
        const f=fixture(),start=deferred<ReturnType<typeof fixture>['download']>(),controller=new AbortController();vi.mocked(f.platform.startDownload).mockReturnValueOnce(start.promise);
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=target.commit(controller.signal);void work.catch(()=>{});await tick();controller.abort();await expect(work).rejects.toThrow('无法确认材料备份下载是否已开始');
        expect(f.platform.remove).not.toHaveBeenCalled();start.reject(new MaterialBackupDownloadNotStartedError('未启动'));await tick();expect(f.platform.remove).toHaveBeenCalledOnce();expect(f.release).toHaveBeenCalledOnce();
    });
    it('keeps the lock when cleanup of a late not-started download fails',async()=>{
        const f=fixture(),start=deferred<ReturnType<typeof fixture>['download']>(),controller=new AbortController();vi.mocked(f.platform.startDownload).mockReturnValueOnce(start.promise);vi.mocked(f.platform.remove).mockRejectedValueOnce(Error('disk error'));
        const target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=target.commit(controller.signal);void work.catch(()=>{});await tick();controller.abort();await expect(work).rejects.toThrow('无法确认材料备份下载是否已开始');
        start.reject(new MaterialBackupDownloadNotStartedError('未启动'));await tick();expect(f.platform.remove).toHaveBeenCalledOnce();expect(f.release).not.toHaveBeenCalled();
    });
    it('keeps the source when a download reports an invalid terminal state',async()=>{
        const f=fixture(),target=await createMaterialBackupOpfsTarget('backup.json',f.platform),work=target.commit(new AbortController().signal);void work.catch(()=>{});await tick();
        f.terminal.resolve('invalid' as MaterialBackupDownloadTerminal);await expect(work).rejects.toThrow('无法确认材料备份下载状态');expect(f.platform.remove).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
    });
});

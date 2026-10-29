/**
 * @file tests/materialBackupSave.test.ts
 * 文件职责：验证材料备份文件选择、分块缓存和完成状态的保存合同。
 * 主要内容：覆盖选择器用户激活、传输及写入背压、大备份字节完整性、下载发起与保存完成、取消和清理失败。
 * 模块边界：使用可注入的文件和下载器替身，不代表真实浏览器、物理磁盘或扩展权限验证。
 */
import {describe, expect, it, vi} from 'vitest';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {chooseMaterialBackupTarget, saveMaterialBackup, waitForMaterialBackupTarget, type MaterialBackupSaveTarget, type MaterialBackupWritable} from '@/src/features/vocabulary/materialBackupSave';
import {MATERIAL_INLINE_BACKUP_MAX_BYTES} from '@/src/features/vocabulary/materialProtocol';
import {MATERIAL_READ_FRAME_BYTES} from '@/src/features/vocabulary/materialReadTransport';

function writable() {
    const chunks:Uint8Array[] = [];
    const file:MaterialBackupWritable = {write:vi.fn(async chunk=>{chunks.push(chunk.slice());}),close:vi.fn(async()=>{}),abort:vi.fn(async()=>{})};
    return {file,chunks};
}
function deferred<T>() {let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

describe('material backup save targets', () => {
    it('cancels pending target selection immediately and aborts a target that arrives later',async()=>{
        const pending=deferred<MaterialBackupSaveTarget>(),controller=new AbortController();
        const target:MaterialBackupSaveTarget={write:vi.fn(async()=>{}),commit:vi.fn(async()=> 'saved' as const),abort:vi.fn(async()=>{})};
        const selection=waitForMaterialBackupTarget(pending.promise,controller.signal);controller.abort();
        await expect(selection).rejects.toMatchObject({name:'AbortError'});expect(target.abort).not.toHaveBeenCalled();
        pending.resolve(target);await vi.waitFor(()=>expect(target.abort).toHaveBeenCalledOnce());
        expect(target.commit).not.toHaveBeenCalled();
    });
    it('observes late failures and reports failure to clean up a late target',async()=>{
        const controller=new AbortController(),pending=deferred<MaterialBackupSaveTarget>(),cleanupFailure=Error('late cleanup failed'),report=vi.fn();
        const selection=waitForMaterialBackupTarget(pending.promise,controller.signal,report);controller.abort();
        await expect(selection).rejects.toMatchObject({name:'AbortError'});
        pending.resolve({write:async()=>{},commit:async()=> 'saved',abort:async()=>{throw cleanupFailure;}});
        await vi.waitFor(()=>expect(report).toHaveBeenCalledWith(cleanupFailure));
        const denied=deferred<MaterialBackupSaveTarget>(),aborted=new AbortController();aborted.abort();
        await expect(waitForMaterialBackupTarget(denied.promise,aborted.signal)).rejects.toMatchObject({name:'AbortError'});
        denied.reject(Error('late permission failure'));await Promise.resolve();await Promise.resolve();
    });
    it('contains an exception from the late-cleanup reporting callback',async()=>{
        const controller=new AbortController(),pending=deferred<MaterialBackupSaveTarget>(),cleanupFailure=Error('cleanup failed');
        const report=vi.fn(()=>{throw Error('reporting failed');});
        const selection=waitForMaterialBackupTarget(pending.promise,controller.signal,report);
        controller.abort();await expect(selection).rejects.toMatchObject({name:'AbortError'});
        pending.resolve({write:async()=>{},commit:async()=> 'saved',abort:async()=>{throw cleanupFailure;}});
        await vi.waitFor(()=>expect(report).toHaveBeenCalledOnce());
        expect(report).toHaveBeenCalledWith(cleanupFailure);
    });
    it('leaves an already delivered target to its owner when cancellation follows selection',async()=>{
        const target:MaterialBackupSaveTarget={write:vi.fn(async()=>{}),commit:vi.fn(async()=> 'saved' as const),abort:vi.fn(async()=>{})};
        const controller=new AbortController(),selected=await waitForMaterialBackupTarget(Promise.resolve(target),controller.signal);
        controller.abort();expect(target.abort).not.toHaveBeenCalled();
        await expect(saveMaterialBackup(selected,async()=>{throw Error('must not receive');},{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(target.abort).toHaveBeenCalledOnce();expect(target.commit).not.toHaveBeenCalled();
    });
    it('preserves target selection failures without an abort signal',async()=>{
        const failure=Error('permission denied');
        await expect(waitForMaterialBackupTarget(Promise.reject(failure))).rejects.toBe(failure);
    });
    it('starts the picker synchronously and closes only after verified receiving completes', async () => {
        const {file,chunks}=writable(), gate=deferred<void>();let inClick=true;
        const pick=vi.fn(()=>{expect(inClick).toBe(true);return Promise.resolve({createWritable:async()=>file});});
        const selecting=chooseMaterialBackupTarget('materials.json',{pick});inClick=false;
        expect(pick).toHaveBeenCalledOnce();
        const target=await selecting;
        const result=saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1,2]));await gate.promise;await consume(new Uint8Array([3]));});
        await vi.waitFor(()=>expect(file.write).toHaveBeenCalledTimes(1));expect(file.close).not.toHaveBeenCalled();
        gate.resolve();await expect(result).resolves.toEqual({state:'saved',bytes:3});
        expect(chunks.map(value=>[...value])).toEqual([[1,2],[3]]);expect(file.close).toHaveBeenCalledOnce();expect(file.abort).not.toHaveBeenCalled();
        expect(pick).toHaveBeenCalledWith({suggestedName:'materials.json',types:[{description:'JSON',accept:{'application/json':['.json']}}]});
    });
    it('preserves picker cancellation without silently falling back to a download', async () => {
        const error=new DOMException('cancelled','AbortError'), download=vi.fn();
        await expect(chooseMaterialBackupTarget('materials.json',{pick:async()=>{throw error;},downloadBuffered:download})).rejects.toBe(error);
        expect(download).not.toHaveBeenCalled();
    });
    it('rejects unsupported saving and invalid file names', async () => {
        await expect(chooseMaterialBackupTarget('ok.json',{})).rejects.toMatchObject({code:'storage-error'});
        for(const name of ['', 'x'.repeat(256)]) await expect(chooseMaterialBackupTarget(name,{})).rejects.toMatchObject({code:'invalid-input'});
    });
    it('coalesces many tiny blocks and distinguishes a started download from a confirmed save', async () => {
        const observed:{parts:number;bytes:number}[]=[];
        const download=vi.fn(async (_name:string,parts:readonly Uint8Array[])=>{observed.push({parts:parts.length,bytes:parts.reduce((n,p)=>n+p.length,0)});return 'initiated' as const;});
        const target=await chooseMaterialBackupTarget('backup.json',{downloadBuffered:download});
        const result=await saveMaterialBackup(target,async consume=>{for(let i=0;i<2000;i++)await consume(new Uint8Array([i%256]));});
        expect(result).toEqual({state:'initiated',bytes:2000});expect(observed).toEqual([{parts:1,bytes:2000}]);
        const saved=await chooseMaterialBackupTarget('backup.json',{downloadBuffered:async()=> 'saved'});
        await expect(saveMaterialBackup(saved,async consume=>{await consume(new Uint8Array([1]));})).resolves.toEqual({state:'saved',bytes:1});
    });
    it('downloads more than 20 MiB without truncation, in coalesced chunks, only after receipt succeeds', async () => {
        const total=MATERIAL_INLINE_BACKUP_MAX_BYTES+137,expected=sha256.create(),received=deferred<void>(),receiveDone=deferred<void>();
        let actual='',observed=0,partSizes:number[]=[];
        const download=vi.fn(async (_name:string,parts:readonly Uint8Array[])=>{
            const digest=sha256.create();for(const part of parts){observed+=part.length;partSizes.push(part.length);digest.update(part);}
            actual=bytesToHex(digest.digest());return 'initiated' as const;
        });
        const target=await chooseMaterialBackupTarget('large.json',{downloadBuffered:download});
        const result=saveMaterialBackup(target,async consume=>{
            let size=total,index=0;const chunk=new Uint8Array(MATERIAL_READ_FRAME_BYTES);
            while(size) {chunk.fill(index%251);const n=Math.min(size,chunk.length),part=chunk.subarray(0,n);expected.update(part);await consume(part);size-=n;index++;}
            expect(index).toBeGreaterThan(1);received.resolve();await receiveDone.promise;
        });
        await received.promise;expect(download).not.toHaveBeenCalled();
        receiveDone.resolve();await expect(result).resolves.toEqual({state:'initiated',bytes:total});
        expect(download).toHaveBeenCalledOnce();expect(observed).toBe(total);expect(actual).toBe(bytesToHex(expected.digest()));
        expect(partSizes.slice(0,-1).every(size=>size===64*1024)).toBe(true);
        expect(partSizes.at(-1)).toBe(total%(64*1024));
    });
    it('discards buffered data on cancellation or failed integrity without starting a download',async()=>{
        for(const reason of ['cancel','integrity'] as const){
            const download=vi.fn(async()=> 'initiated' as const),controller=new AbortController();
            const target=await chooseMaterialBackupTarget('backup.json',{downloadBuffered:download});
            const failure=Error('checksum mismatch');
            await expect(saveMaterialBackup(target,async consume=>{
                await consume(new Uint8Array([1,2,3]));
                if(reason==='cancel')controller.abort();else throw failure;
            },{signal:controller.signal})).rejects.toMatchObject(reason==='cancel'?{name:'AbortError'}:{message:'checksum mismatch'});
            expect(download).not.toHaveBeenCalled();
            await expect(target.write(new Uint8Array([1]))).rejects.toMatchObject({code:'storage-error'});
        }
    });
    it('rejects repeated buffered commits and a caller cancelled before receiving',async()=>{
        const download=vi.fn(async()=> 'initiated' as const),target=await chooseMaterialBackupTarget('backup.json',{downloadBuffered:download});
        await target.abort();
        await expect(target.commit(new AbortController().signal)).rejects.toMatchObject({code:'storage-error'});
        const controller=new AbortController();controller.abort();const receive=vi.fn();
        const second=await chooseMaterialBackupTarget('backup.json',{downloadBuffered:download});
        await expect(saveMaterialBackup(second,receive,{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
        expect(receive).not.toHaveBeenCalled();expect(download).not.toHaveBeenCalled();
    });
    it('rejects downloader failure or an invalid reported state', async () => {
        const failure=Error('download failed');
        for(const download of [async()=>{throw failure;},async()=> 'unknown' as never]) {
            const target=await chooseMaterialBackupTarget('backup.json',{downloadBuffered:download});
            await expect(saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));})).rejects.toThrow();
        }
    });
    it('aborts on incomplete transport or disk failure without committing', async () => {
        const failure=Error('checksum failed'), one=writable(), target=await chooseMaterialBackupTarget('a.json',{pick:async()=>({createWritable:async()=>one.file})});
        await expect(saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));throw failure;})).rejects.toBe(failure);
        expect(one.file.abort).toHaveBeenCalledOnce();expect(one.file.close).not.toHaveBeenCalled();
        const two=writable();(two.file.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Error('disk full'));
        const second=await chooseMaterialBackupTarget('b.json',{pick:async()=>({createWritable:async()=>two.file})});
        await expect(saveMaterialBackup(second,async consume=>{try {await consume(new Uint8Array([1]));} catch {/* consumer cannot hide write failure */}})).rejects.toThrow('disk full');
        expect(two.file.abort).toHaveBeenCalledOnce();expect(two.file.close).not.toHaveBeenCalled();
    });
    it('keeps undefined write errors and rejects invalid or overlapping frames even if receive catches them', async () => {
        const target:MaterialBackupSaveTarget={write:async()=>{throw undefined;},commit:vi.fn(async()=> 'saved' as const),abort:vi.fn(async()=>{})};
        await expect(saveMaterialBackup(target,async consume=>{try {await consume(new Uint8Array([1]));} catch {}})).rejects.toBeUndefined();
        expect(target.commit).not.toHaveBeenCalled();expect(target.abort).toHaveBeenCalledOnce();
        for(const chunk of [new Uint8Array(),new Uint8Array(MATERIAL_READ_FRAME_BYTES+1),'not bytes' as never]) {
            const one=writable(), sink=await chooseMaterialBackupTarget('x.json',{pick:async()=>({createWritable:async()=>one.file})});
            await expect(saveMaterialBackup(sink,async consume=>{try {await consume(chunk);} catch {}})).rejects.toMatchObject({code:'invalid-input'});
            expect(one.file.close).not.toHaveBeenCalled();expect(one.file.abort).toHaveBeenCalledOnce();
        }
        const hold=deferred<void>(), one=writable();one.file.write=async()=>hold.promise;
        const sink=await chooseMaterialBackupTarget('x.json',{pick:async()=>({createWritable:async()=>one.file})});
        const result=saveMaterialBackup(sink,async consume=>{const first=consume(new Uint8Array([1]));try {await consume(new Uint8Array([2]));} catch {} hold.resolve();await first;});
        await expect(result).rejects.toMatchObject({code:'invalid-input'});expect(one.file.close).not.toHaveBeenCalled();
    });
    it('preserves the first write failure if the consumer tries another frame',async()=>{
        const failure=Error('disk full'),target:MaterialBackupSaveTarget={write:vi.fn(async()=>{throw failure;}),commit:vi.fn(async()=> 'saved' as const),abort:vi.fn(async()=>{})};
        await expect(saveMaterialBackup(target,async consume=>{
            await expect(consume(new Uint8Array([1]))).rejects.toBe(failure);
            await expect(consume(new Uint8Array([2]))).rejects.toBe(failure);
        })).rejects.toBe(failure);
        expect(target.write).toHaveBeenCalledOnce();expect(target.commit).not.toHaveBeenCalled();expect(target.abort).toHaveBeenCalledOnce();
    });
    it('rejects a receiver that returns before its pending write and waits for cleanup',async()=>{
        const writing=deferred<void>(),started=deferred<void>(),target:MaterialBackupSaveTarget={
            write:async()=>{started.resolve();await writing.promise;},commit:vi.fn(async()=> 'saved' as const),abort:vi.fn(async()=>{}),
        };
        const work=saveMaterialBackup(target,async consume=>{void consume(new Uint8Array([1])).catch(()=>{});await started.promise;});
        const settled=work.catch(error=>error);await started.promise;await Promise.resolve();expect(target.commit).not.toHaveBeenCalled();
        writing.resolve();expect(await settled).toMatchObject({code:'invalid-input',message:'材料备份写入尚未完成'});expect(target.abort).toHaveBeenCalledOnce();
    });
    it('waits for outstanding disk work and abort cleanup after cancellation', async () => {
        const write=deferred<void>(), started=deferred<void>(), aborting=deferred<void>();
        const target:MaterialBackupSaveTarget={write:async()=>{started.resolve();await write.promise;},commit:vi.fn(async()=> 'saved' as const),abort:vi.fn(async()=>{await aborting.promise;})};
        const controller=new AbortController();let settled=false;
        const result=saveMaterialBackup(target,(consume,signal)=>new Promise<void>((_resolve,reject)=>{
            void consume(new Uint8Array([1])).catch(()=>{});signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});
        }),{signal:controller.signal}).finally(()=>{settled=true;});
        const captured=result.catch(error=>error);await started.promise;controller.abort();
        await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
        aborting.resolve();await Promise.resolve();expect(settled).toBe(false);
        write.resolve();await expect(captured).resolves.toMatchObject({name:'AbortError'});expect(settled).toBe(true);expect(target.commit).not.toHaveBeenCalled();
    });
    it('reports failed cleanup instead of claiming the partial target is gone', async () => {
        const original=Error('write failed'), target:MaterialBackupSaveTarget={write:async()=>{throw original;},commit:vi.fn(async()=> 'saved' as const),abort:async()=>{throw Error('cleanup failed');}};
        await expect(saveMaterialBackup(target,async consume=>{await consume(new Uint8Array([1]));}))
            .rejects.toMatchObject({name:'MaterialBackupSaveCleanupError',cause:original});
        expect(target.commit).not.toHaveBeenCalled();
    });
    it('does not accept late frames after successful receipt and copies caller-owned bytes', async () => {
        const written=deferred<void>(), started=deferred<void>();let captured:Uint8Array|undefined, late!:(chunk:Uint8Array)=>Promise<void>;
        const target:MaterialBackupSaveTarget={write:async chunk=>{captured=chunk;started.resolve();await written.promise;},commit:vi.fn(async()=> 'saved' as const),abort:vi.fn(async()=>{})};
        const original=new Uint8Array([1,2]);
        const result=saveMaterialBackup(target,async consume=>{late=consume;await consume(original);});
        await started.promise;original[0]=9;expect(captured?.[0]).toBe(1);written.resolve();
        await expect(result).resolves.toEqual({state:'saved',bytes:2});
        await expect(late(new Uint8Array([3]))).rejects.toMatchObject({code:'invalid-input'});
        expect(target.commit).toHaveBeenCalledOnce();
    });
});

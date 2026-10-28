/**
 * @file tests/materialBackupExportBridge.test.ts
 * 文件职责：验证材料导出端口的信任、分片、错误与取消合同。
 * 主要内容：覆盖真实的 ACK/摘要传输、分段数据解析、存储版本失效、受限错误码及悬挂读取时的额度保留。
 * 模块边界：使用内存端口与仓库替身，不代表真实浏览器、扩展更新或用户文件保存。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {describe,expect,it,vi} from 'vitest';
import {MaterialError} from '@/src/features/vocabulary/materialModel';
import {createMaterialBackupExportBridge, type MaterialBackupExportPort} from '@/src/features/vocabulary/materialBackupExportBridge';
import {receiveMaterialBackupExport} from '@/src/features/vocabulary/materialBackupExportClient';
import {MATERIAL_BACKUP_EXPORT_PORT_NAME} from '@/src/features/vocabulary/materialBackupExportProtocol';
import {sendMaterialRead, type MaterialReadPort} from '@/src/features/vocabulary/materialReadTransport';
import {chooseMaterialBackupTarget,saveMaterialBackup,type MaterialBackupWritable} from '@/src/features/vocabulary/materialBackupSave';
import {isTrustedSettingsSender} from '@/src/app/background/handlers/trustedSettingsSender';
import {MaterialDatabase,MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {prepareMaterialBackup,sendMaterialBackup} from '@/src/features/vocabulary/materialBackupReader';
import {createStage} from '@/src/features/vocabulary/materialImportStage';
import {createMaterialImportCapability} from '@/src/features/vocabulary/materialImportPort';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';

type Fn=(...args:any[])=>void;
class Events<T extends Fn> {
    listeners=new Set<T>();
    addListener(fn:T){this.listeners.add(fn);}
    removeListener(fn:T){this.listeners.delete(fn);}
    fire(...args:Parameters<T>){for(const listener of [...this.listeners])listener(...args);}
}
class Port {
    name=MATERIAL_BACKUP_EXPORT_PORT_NAME;
    sender:MaterialBackupExportPort['sender']={id:'abc',url:'chrome-extension://abc/options.html?tab=materials'};
    onMessage=new Events<(message:unknown)=>void>();onDisconnect=new Events<()=>void>();
    peer!:Port;closed=false;sent:unknown[]=[];
    postMessage(message:unknown){if(this.closed)throw Error('closed');this.sent.push(message);queueMicrotask(()=>{if(!this.peer.closed)this.peer.onMessage.fire(message);});}
    disconnect(){if(this.closed)return;this.closed=true;this.peer.closed=true;this.onDisconnect.fire();this.peer.onDisconnect.fire();}
}
function pair(){const a=new Port(),b=new Port();a.peer=b;b.peer=a;return [a,b] as const;}
const start={v:1,type:'start',operation:'export'};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function material(id='m'):MaterialRecord{return {id,identityKey:'private-id',kind:'article',title:'Private title',source:{kind:'article',url:'https://example.test/'},
    topics:['topic'],references:[{kind:'note',id:'n',note:'my note'}],createdAt:1,updatedAt:2,lastReadAt:3,archivedAt:null};}
function setup(overrides:Partial<Parameters<typeof createMaterialBackupExportBridge>[0]>={}){
    const repo={openSnapshot:vi.fn(async()=>({revision:1,ids:['m']})),readSnapshotRecord:vi.fn(async()=>material()),checkSnapshot:vi.fn(async()=>{})};
    const bridge=createMaterialBackupExportBridge({repository:repo,ready:Promise.resolve(),
        isTrustedSender:sender=>isTrustedSettingsSender(sender,'abc','chrome-extension://abc/options.html'),isPrivateContext:()=>false,...overrides});
    return {repo,bridge};
}
async function* bytes(...chunks:number[][]){for(const value of chunks)yield new Uint8Array(value);}

describe('material backup export bridge',()=>{
    it('rejects invalid resource limits before installing any listener',()=>{
        for(const overrides of [{maxPorts:0},{maxPorts:33},{maxPorts:1.5},{idleTimeoutMs:0},{idleTimeoutMs:2_147_483_648}])
            expect(()=>setup(overrides)).toThrow('材料导出端口限制无效');
    });
    it('fails closed when trust evaluation or disconnect unexpectedly fails',async()=>{
        const {repo,bridge}=setup({isTrustedSender:()=>{throw Error('cannot verify');}}),[server]=pair();
        server.disconnect=()=>{throw Error('disconnect failed');};expect(bridge.connect(server)).toBe(true);
        expect(repo.openSnapshot).not.toHaveBeenCalled();await bridge.dispose();
    });
    it('cleans up and releases capacity when port listener registration fails',async()=>{
        for(const event of ['onMessage','onDisconnect'] as const){
            const {bridge}=setup({maxPorts:1}),[server]=pair();server[event].addListener=()=>{throw Error('registration failed');};
            expect(bridge.connect(server)).toBe(true);expect(server.closed).toBe(true);
            const [retry]=pair();expect(bridge.connect(retry)).toBe(true);expect(retry.closed).toBe(false);await bridge.dispose();
        }
    });
    it('continues closing the port if listener removal throws',async()=>{
        const {repo,bridge}=setup(),[server,client]=pair();bridge.connect(server);
        server.onMessage.removeListener=()=>{throw Error('remove failed');};server.onDisconnect.removeListener=()=>{throw Error('remove failed');};
        client.postMessage({v:0,type:'start',operation:'export'});await tick();expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();await bridge.dispose();
    });
    it('releases capacity if disconnect itself fails after an invalid handshake',async()=>{
        const {repo,bridge}=setup({maxPorts:1}),[server,client]=pair();bridge.connect(server);
        server.disconnect=()=>{throw Error('context already invalidated');};client.postMessage({v:0,type:'start',operation:'export'});await tick();
        expect(repo.openSnapshot).not.toHaveBeenCalled();const [retry]=pair();expect(bridge.connect(retry)).toBe(true);expect(retry.closed).toBe(false);await bridge.dispose();
    });
    it('ignores a queued handshake delivered after another listener closed the port',async()=>{
        const {repo,bridge}=setup(),[server,client]=pair();server.onMessage.addListener(()=>server.disconnect());bridge.connect(server);
        client.postMessage(start);await tick();expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();await bridge.dispose();
    });
    it('does not read after a disconnect races a resolved readiness gate',async()=>{
        let release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});
        const {repo,bridge}=setup({ready}),[server,client]=pair();bridge.connect(server);client.postMessage(start);await tick();
        release();queueMicrotask(()=>client.disconnect());await tick();expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();await bridge.dispose();
    });
    it('refuses a second start while readiness is still pending',async()=>{
        const {repo,bridge}=setup({ready:new Promise(()=>{})}),[server,client]=pair();bridge.connect(server);
        client.postMessage(start);client.postMessage(start);await tick();expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();await bridge.dispose();
    });
    it('closes ports on a failed readiness gate whether failure occurs before or after the request',async()=>{
        for(const initiallyFailed of [false,true]){
            let fail!:(error:Error)=>void;const ready=new Promise<void>((_resolve,reject)=>{fail=reject;});
            const {repo,bridge}=setup({ready}),[server,client]=pair();if(initiallyFailed){fail(Error('config'));await tick();}
            bridge.connect(server);client.postMessage(start);if(!initiallyFailed){await tick();fail(Error('config'));}await tick();
            expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();await bridge.dispose();
        }
    });
    it('rechecks private mode after readiness and does not begin a read when it changes',async()=>{
        let restricted=false,release!:()=>void;const ready=new Promise<void>(resolve=>{release=resolve;});
        const {repo,bridge}=setup({ready,isPrivateContext:()=>restricted}),[server,client]=pair();bridge.connect(server);client.postMessage(start);
        await tick();restricted=true;release();await tick();expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();await bridge.dispose();
    });
    it('rejects untrusted and private senders without opening storage',()=>{
        const {repo,bridge}=setup();
        for(const sender of [undefined,{id:'wrong',url:'chrome-extension://abc/options.html'},
            {id:'abc',url:'https://example.test/options.html'},{id:'abc',url:'chrome-extension://abc/popup.html'},
            {id:'abc',url:'chrome-extension://abc/options.html',incognito:true},
            {id:'abc',url:'chrome-extension://abc/options.html',tab:{incognito:true}}]){
            const [port]=pair();port.sender=sender;expect(bridge.connect(port)).toBe(true);expect(port.closed).toBe(true);
        }
        const [other]=pair();other.name='unrelated';expect(bridge.connect(other)).toBe(false);expect(other.closed).toBe(false);
        expect(repo.openSnapshot).not.toHaveBeenCalled();bridge.dispose();
    });
    it('requires a bounded exact handshake and ignores duplicate port registration',async()=>{
        for(const message of [null,[],{...start,extra:'private'},{...start,v:2},{...start,operation:'list'}]){
            const {repo,bridge}=setup(),[server,client]=pair();bridge.connect(server);bridge.connect(server);
            expect(server.onMessage.listeners.size).toBe(1);client.postMessage(message);await tick();
            expect(server.closed).toBe(true);expect(repo.openSnapshot).not.toHaveBeenCalled();bridge.dispose();
        }
    });
    it('rejects a sender if disposal occurs synchronously inside the trust check',async()=>{
        let dispose!:()=>Promise<void>;
        const {repo,bridge}=setup({isTrustedSender:()=>{void dispose();return true;}});dispose=bridge.dispose;
        const [port]=pair();expect(bridge.connect(port)).toBe(true);expect(port.closed).toBe(true);
        await bridge.dispose();expect(repo.openSnapshot).not.toHaveBeenCalled();
    });
    it('drains an already-started read before disposal finishes',async()=>{
        let finish!:(value:{revision:number;ids:string[]})=>void,started!:()=>void;
        const pending=new Promise<{revision:number;ids:string[]}>(resolve=>{finish=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
        const repo={openSnapshot:()=>{started();return pending;},readSnapshotRecord:async()=>null,checkSnapshot:async()=>{}};
        const {bridge}=setup({repository:repo}),[server,client]=pair();bridge.connect(server);
        const read=receiveMaterialBackupExport(client as MaterialReadPort,async()=>{}).catch(error=>error);client.postMessage(start);await began;
        let done=false;const stop=bridge.dispose().then(()=>{done=true;});await tick();expect(done).toBe(false);await read;
        finish({revision:1,ids:[]});await stop;expect(done).toBe(true);
    });
    it('exports a verified byte stream and saves only after the terminal digest',async()=>{
        const {repo,bridge}=setup(),[server,client]=pair();bridge.connect(server);
        const chunks:Uint8Array[]=[],file:MaterialBackupWritable={write:vi.fn(async chunk=>{chunks.push(chunk);}),close:vi.fn(async()=>{}),abort:vi.fn(async()=>{})};
        const target=await chooseMaterialBackupTarget('backup.json',{pick:async()=>({createWritable:async()=>file})});
        const saving=saveMaterialBackup(target,async (consume,signal)=>{const receiving=receiveMaterialBackupExport(client as MaterialReadPort,consume,{signal});client.postMessage(start);await receiving;});
        const result=await saving;expect(result.state).toBe('saved');expect(file.close).toHaveBeenCalledOnce();expect(file.abort).not.toHaveBeenCalled();
        const text=new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk]))),backup=JSON.parse(text);
        expect(backup).toMatchObject({format:'fluentread-learning-materials',version:1,materials:[material()]});
        expect(result.bytes).toBe(new TextEncoder().encode(text).length);expect(repo.checkSnapshot).toHaveBeenCalledOnce();bridge.dispose();
    });
    it('sends only a verified public stale code and aborts the partially written target',async()=>{
        const repo={openSnapshot:async()=>({revision:1,ids:['m']}),readSnapshotRecord:async()=>material(),
            checkSnapshot:async()=>{throw new MaterialError('stale-operation','private path secret');}};
        const {bridge}=setup({repository:repo}),[server,client]=pair();bridge.connect(server);
        const file:MaterialBackupWritable={write:vi.fn(async()=>{}),close:vi.fn(async()=>{}),abort:vi.fn(async()=>{})};
        const target=await chooseMaterialBackupTarget('backup.json',{pick:async()=>({createWritable:async()=>file})});
        const result=saveMaterialBackup(target,async (consume,signal)=>{const receiving=receiveMaterialBackupExport(client as MaterialReadPort,consume,{signal});client.postMessage(start);await receiving;});
        await expect(result).rejects.toMatchObject({code:'stale-operation'});
        expect(file.close).not.toHaveBeenCalled();expect(file.abort).toHaveBeenCalledOnce();
        expect(JSON.stringify(server.sent)).not.toContain('private path secret');bridge.dispose();
    });
    it('round trips real repository data through verified export transport, file writes and staged restore',async()=>{
        const sourceDb=new MaterialDatabase(`export-wire-src-${crypto.randomUUID()}`),targetDb=new MaterialDatabase(`export-wire-dst-${crypto.randomUUID()}`);
        let stop:(()=>Promise<void>)|undefined;
        try {
            const source=new MaterialRepository(sourceDb),target=new MaterialRepository(targetDb);
            const saved=await source.capture({source:{kind:'article',url:'https://example.test/one'},
                reference:{kind:'note',id:'n',excerpt:'片段😀',note:'笔记'},capturedAt:10},10);
            await source.update(saved.id,{topics:['主题']},11);
            await source.capture({source:{kind:'video',url:'https://example.test/two'},locator:{kind:'video',startMs:100,quote:'视频'},capturedAt:12},12);
            const {bridge}=setup({repository:source}),[server,client]=pair();stop=bridge.dispose;bridge.connect(server);
            const parts:Uint8Array[]=[];
            const file:MaterialBackupWritable={write:async chunk=>{parts.push(chunk.slice());},close:vi.fn(async()=>{}),abort:vi.fn(async()=>{})};
            const sink=await chooseMaterialBackupTarget('backup.json',{pick:async()=>({createWritable:async()=>file})});
            const result=await saveMaterialBackup(sink,async (consume,signal)=>{const transfer=receiveMaterialBackupExport(client as MaterialReadPort,consume,{signal});client.postMessage(start);await transfer;});
            expect(result.state).toBe('saved');expect(file.close).toHaveBeenCalledOnce();expect(file.abort).not.toHaveBeenCalled();
            const size=parts.reduce((sum,item)=>sum+item.length,0),data=new Uint8Array(size);let at=0;
            for(const part of parts){data.set(part,at);at+=part.length;}
            const blob=new Blob([data.buffer]),plan=await prepareMaterialBackup(blob),stage=createStage(targetDb,{clock:()=>100}),cap=createMaterialImportCapability();
            await stage.beginRecoverable(plan.manifest,{generation:0,capturedAt:100},cap,{deadline:1000});
            await sendMaterialBackup(blob,plan,async frame=>{await stage.append(cap,frame);});await stage.seal(cap);
            expect(await stage.commit(cap)).toEqual({inserted:2,updated:0,skipped:0});
            const expected=(await source.exportData(100)).materials.sort((a,b)=>a.id.localeCompare(b.id)).map(item=>({...item,aliases:item.aliases??[],locator:item.locator}));
            const actual=(await target.exportData(100)).materials.sort((a,b)=>a.id.localeCompare(b.id));expect(actual).toEqual(expected);
        } finally {if(stop)await stop();sourceDb.close();targetDb.close();await Dexie.delete(sourceDb.name);await Dexie.delete(targetDb.name);}
    });
    it('maps unknown repository errors to a public storage error without leaking text',async()=>{
        const repo={openSnapshot:async()=>{throw Error('private text');},readSnapshotRecord:async()=>null,checkSnapshot:async()=>{}};
        const {bridge}=setup({repository:repo}),[server,client]=pair();bridge.connect(server);
        const receiving=receiveMaterialBackupExport(client as MaterialReadPort,async()=>{});client.postMessage(start);
        await expect(receiving).rejects.toMatchObject({code:'storage-error'});expect(JSON.stringify(server.sent)).not.toContain('private text');bridge.dispose();
    });
    it('holds the port quota through underlying uncooperative storage and releases it after cleanup',async()=>{
        let resolve!:(value:{revision:number;ids:string[]})=>void,started!:()=>void;
        const pending=new Promise<{revision:number;ids:string[]}>(done=>{resolve=done;}),began=new Promise<void>(done=>{started=done;});
        const repo={openSnapshot:()=>{started();return pending;},readSnapshotRecord:async()=>null,checkSnapshot:async()=>{}};
        const {bridge}=setup({repository:repo,maxPorts:1}),[server,client]=pair();bridge.connect(server);
        const read=receiveMaterialBackupExport(client as MaterialReadPort,async()=>{}).catch(error=>error);client.postMessage(start);await began;
        client.disconnect();await expect(read).resolves.toBeInstanceOf(Error);
        const [blocked]=pair();bridge.connect(blocked);expect(blocked.closed).toBe(true);
        resolve({revision:1,ids:[]});await tick();await tick();const [allowed]=pair();bridge.connect(allowed);expect(allowed.closed).toBe(false);bridge.dispose();
    });
    it('cancels a pending readiness gate and safely closes silent ports',async()=>{
        let ready!:()=>void;const waiting=new Promise<void>(resolve=>{ready=resolve;});
        const {repo,bridge}=setup({ready:waiting,idleTimeoutMs:25,maxPorts:1}),[server,client]=pair();bridge.connect(server);client.postMessage(start);
        await tick();client.disconnect();ready();await tick();expect(repo.openSnapshot).not.toHaveBeenCalled();
        const [silent]=pair();bridge.connect(silent);await new Promise(resolve=>setTimeout(resolve,40));expect(silent.closed).toBe(true);bridge.dispose();
    });
});

describe('material backup wire reader',()=>{
    it('stops immediately when the consumer cancels after receiving a chunk',async()=>{
        const controller=new AbortController(),[server,client]=pair(),out:number[]=[];
        const read=receiveMaterialBackupExport(client as MaterialReadPort,async value=>{out.push(...value);controller.abort();},{signal:controller.signal});
        const write=sendMaterialRead(server as MaterialReadPort,bytes([1,0,0,0,3,65,66,67,2])).catch(error=>error);
        await expect(read).rejects.toThrow();await write;expect(out).toEqual([65,66,67]);
    });
    it('parses length headers and data split at arbitrary transport boundaries',async()=>{
        const [server,client]=pair(),out:number[]=[];
        const read=receiveMaterialBackupExport(client as MaterialReadPort,async value=>{out.push(...value);});
        const write=sendMaterialRead(server as MaterialReadPort,bytes([1],[0,0],[0,3,65],[66,67,2]));
        await Promise.all([read,write]);expect(out).toEqual([65,66,67]);
    });
    it.each([
        [[2]],[[1,0,0,0,0]],[[1,0,1,0,0]],[[1,0,0,0,1]],[[3,99]],[[99]],[[1,0,0,0,1,65,2,7]],[[3,1,2]],
    ].map(chunks=>({chunks})))('rejects malformed, truncated, trailing or empty-success wire records %#',async ({chunks})=>{
        const [server,client]=pair(),read=receiveMaterialBackupExport(client as MaterialReadPort,async()=>{});
        const write=sendMaterialRead(server as MaterialReadPort,bytes(...chunks)).catch(error=>error);
        await expect(read).rejects.toThrow();await write;
    });
    it('reports public failures only after the transport itself is verified',async()=>{
        const [server,client]=pair(),read=receiveMaterialBackupExport(client as MaterialReadPort,async()=>{});
        const write=sendMaterialRead(server as MaterialReadPort,bytes([3,1]));
        await expect(read).rejects.toMatchObject({code:'stale-operation'});await write;
    });
});

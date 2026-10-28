/**
 * @file src/features/vocabulary/materialBackupExportBridge.ts
 * 文件职责：为扩展设置页提供受限、可取消的材料备份分片导出。
 * 主要内容：校验端口来源和并发额度，逐帧承载原始备份或公开错误码，并在完整摘要验证后确认成功或失败。
 * 模块边界：不安装浏览器监听、不打开文件或输出个人正文到日志；存储读取在仓库内按快照进行，调用方负责保存目标和信任策略。
 */
import {MaterialError} from './materialModel';
import type {MaterialRepository} from './materialRepository';
import {streamMaterialBackup} from './materialBackupExport';
import {sendMaterialRead, type MaterialReadPort} from './materialReadTransport';
import {MATERIAL_BACKUP_EXPORT_PORT_NAME, MATERIAL_BACKUP_EXPORT_ERROR_CODES, type MaterialBackupExportErrorCode} from './materialBackupExportProtocol';

type Repository = Pick<MaterialRepository,'openSnapshot'|'readSnapshotRecord'|'checkSnapshot'>;
export type MaterialBackupExportSender = {id?:string;url?:string;frameId?:number;incognito?:boolean;tab?:{id?:number;incognito?:boolean}};
export type MaterialBackupExportPort = MaterialReadPort & {name:string;sender?:MaterialBackupExportSender};

function aborted(signal?:AbortSignal):void {if(signal?.aborted)throw new DOMException('材料导出已取消','AbortError');}

/** 二进制数据记录有长度前缀，终止记录不携带私密错误文本。 */
async function* exportWire(repository:Repository, signal:AbortSignal):AsyncGenerator<Uint8Array> {
    try {
        for await (const chunk of streamMaterialBackup(repository,{signal})) {
            aborted(signal);
            // streamMaterialBackup 只产出长度为 1..MATERIAL_READ_FRAME_BYTES 的分片。
            const length = chunk.length;
            yield new Uint8Array([1,(length>>>24)&255,(length>>>16)&255,(length>>>8)&255,length&255]);
            aborted(signal);yield chunk;
        }
        aborted(signal);yield new Uint8Array([2]);
    } catch(error) {
        if (signal.aborted) throw error;
        const codes:readonly string[]=MATERIAL_BACKUP_EXPORT_ERROR_CODES;
        const code = error instanceof MaterialError && codes.includes(error.code) ? error.code as MaterialBackupExportErrorCode : 'storage-error';
        yield new Uint8Array([3,codes.indexOf(code)]);
    }
}

export interface MaterialBackupExportBridgeOptions {
    repository:Repository;
    ready:Promise<unknown>;
    isTrustedSender(sender:MaterialBackupExportSender|undefined):boolean;
    isPrivateContext():boolean;
    maxPorts?:number;
    idleTimeoutMs?:number;
}

/** 接收器启动前不读取材料；底层读取实际结束之前不释放连接额度。 */
export function createMaterialBackupExportBridge(options:MaterialBackupExportBridgeOptions):{connect(port:MaterialBackupExportPort):boolean;dispose():Promise<void>} {
    const limit=options.maxPorts??2,timeout=options.idleTimeoutMs??30_000;
    if(!Number.isSafeInteger(limit)||limit<1||limit>32||!Number.isSafeInteger(timeout)||timeout<1||timeout>2_147_483_647)throw Error('材料导出端口限制无效');
    const active=new Set<()=>void>(),claimed=new WeakSet<MaterialBackupExportPort>(),waiters=new Set<(ready:boolean)=>void>(),drained=new Set<()=>void>();
    let disposed=false,ready:'pending'|'ready'|'failed'='pending';
    void options.ready.then(()=>{ready='ready';for(const waiter of [...waiters])waiter(true);},()=>{ready='failed';for(const waiter of [...waiters])waiter(false);});
    const waitReady=(signal:AbortSignal):Promise<void>=>{
        if(disposed||signal.aborted)return Promise.reject(Error('unavailable'));
        if(ready!=='pending')return ready==='ready'?Promise.resolve():Promise.reject(Error('unavailable'));
        return new Promise((resolve,reject)=>{
            const finish=(ok:boolean)=>{waiters.delete(finish);signal.removeEventListener('abort',abort);ok?resolve():reject(Error('unavailable'));};
            const abort=()=>finish(false);
            // 前面的取消检查与监听注册之间没有异步边界，原生 AbortSignal 不会在此处重入。
            waiters.add(finish);signal.addEventListener('abort',abort,{once:true});
        });
    };
    function connect(port:MaterialBackupExportPort):boolean {
        if(port.name!==MATERIAL_BACKUP_EXPORT_PORT_NAME)return false;
        if(claimed.has(port))return true;
        claimed.add(port);
        let trusted=false;
        try {trusted=!disposed&&!options.isPrivateContext()&&port.sender?.incognito!==true&&port.sender?.tab?.incognito!==true&&options.isTrustedSender(port.sender);} catch {/* 拒绝无法验证的来源。 */}
        if(disposed||!trusted||active.size>=limit){try{port.disconnect();}catch{}return true;}
        const controller=new AbortController(),pending=new Set<Promise<unknown>>();
        let started=false,closed=false;
        const timer=setTimeout(()=>close(),timeout);
        const cleanup=()=>{clearTimeout(timer);try{port.onMessage.removeListener(onMessage);}catch{}try{port.onDisconnect.removeListener(onDisconnect);}catch{}};
        const release=()=>{active.delete(close);if(disposed&&!active.size){for(const done of drained)done();drained.clear();}};
        const close=()=>{if(closed)return;closed=true;controller.abort();cleanup();try{port.disconnect();}catch{}if(!started)release();};
        const onDisconnect=()=>close();
        const track=<T>(work:Promise<T>):Promise<T>=>{pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;};
        const onMessage=(message:unknown)=>{
            if(started){close();return;}
            try {
                if(!message||typeof message!=='object'||Array.isArray(message))throw Error('invalid');
                const input=message as Record<string,unknown>,keys=Object.keys(input);
                if(keys.length!==3||!['v','type','operation'].every(key=>Object.hasOwn(input,key))||input.v!==1||input.type!=='start'||input.operation!=='export')throw Error('invalid');
            } catch {close();return;}
            started=true;
            void(async()=>{
                try {
                    await waitReady(controller.signal);
                    if(controller.signal.aborted||disposed)throw Error('unavailable');
                    if(options.isPrivateContext())throw Error('unavailable');
                    // 隐私检查可能同步触发关闭，不能在关闭后启动读取。
                    if(controller.signal.aborted||disposed)throw Error('unavailable');
                    cleanup();
                    await sendMaterialRead(port,signal=>{
                        const iterator=exportWire(options.repository,signal);
                        return {[Symbol.asyncIterator](){return {next:()=>track(iterator.next()),return:()=>track(iterator.return(undefined))};}};
                    },{signal:controller.signal,idleTimeoutMs:timeout});
                } catch {/* 对外仅断开连接，不发送异常、正文或路径。 */}
                finally {close();while(pending.size)await Promise.allSettled([...pending]);release();}
            })();
        };
        active.add(close);
        try{port.onDisconnect.addListener(onDisconnect);if(!closed)port.onMessage.addListener(onMessage);if(closed)cleanup();}catch{close();}
        return true;
    }
    return {connect,dispose(){
        if(!disposed){disposed=true;for(const close of [...active])close();}
        if(!active.size)return Promise.resolve();
        return new Promise(resolve=>{drained.add(resolve);});
    }};
}

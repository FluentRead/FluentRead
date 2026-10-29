/**
 * @file src/features/vocabulary/materialPageBridge.ts
 * 文件职责：为可信设置页提供有界材料分页会话。
 * 主要内容：能力令牌、分页握手、分帧传输、并发限制、取消与空闲回收。
 * 模块边界：不安装浏览器监听，不保存材料正文；权限及仓库由后台组装层注入。
 */
import {MaterialError} from './materialModel';
import {createMaterialPageSession, type MaterialPageSession} from './materialPageSession';
import {readMaterialDetailPage, type MaterialDetailMetadata} from './materialDetailPage';
import type {MaterialRepository} from './materialRepository';
import {sendMaterialRead, type MaterialReadPort} from './materialReadTransport';
import {MATERIAL_PAGE_PORT_NAME, MATERIAL_PAGE_MAX_LINE_BYTES, type MaterialPageErrorCode, type MaterialPageMessage, type MaterialPageRequest} from './materialPageProtocol';
export type MaterialPageSender = {id?:string; url?:string; incognito?:boolean; tab?:{id?:number; incognito?:boolean}};
export type MaterialPagePort = MaterialReadPort & {name:string; sender?:MaterialPageSender};
type Repository = Pick<MaterialRepository,'openSnapshot'|'readSnapshotRecord'|'checkSnapshot'>;
type Entry = {controller:AbortController; session?:MaterialPageSession; busy:boolean; pending?:Promise<unknown>; timer?:ReturnType<typeof setTimeout>; closing?:Promise<void>};
export interface MaterialPageBridgeOptions {
    repository:Repository;
    ready:Promise<unknown>;
    isTrustedSender(sender:MaterialPageSender|undefined):boolean;
    isPrivateContext():boolean;
    maxSessions?:number;
    maxPorts?:number;
    idleTimeoutMs?:number;
    sessionTimeoutMs?:number;
}
function message(value:MaterialPageMessage):Uint8Array {
    const result=new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    if(result.length>MATERIAL_PAGE_MAX_LINE_BYTES)throw new MaterialError('limit-exceeded','材料读取内容超过单行预算');
    return result;
}
function capability():string {return Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');}
function parse(input:unknown):MaterialPageRequest {
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid request');
    const value=input as Record<string,unknown>, keys=Object.keys(value);
    if(value.v!==1||value.type!=='start')throw Error('invalid request');
    if(value.operation==='open') {
        if(keys.length!==4||!Object.hasOwn(value,'options')||!value.options||typeof value.options!=='object'||Array.isArray(value.options))throw Error('invalid request');
        const options=value.options as Record<string,unknown>;
        if(Object.keys(options).some(key=>!['archived','topic','search'].includes(key))
            ||(options.archived!==undefined&&typeof options.archived!=='boolean')
            ||(options.topic!==undefined&&(typeof options.topic!=='string'||options.topic.length>80))
            ||(options.search!==undefined&&(typeof options.search!=='string'||options.search.length>128*1024)))throw Error('invalid request');
        return {v:1,type:'start',operation:'open',options:{archived:options.archived as boolean|undefined,topic:options.topic as string|undefined,search:options.search as string|undefined}};
    }
    if((value.operation==='page'||value.operation==='detail'||value.operation==='topics'||value.operation==='close')&&typeof value.capability==='string'&&/^[0-9a-f]{64}$/u.test(value.capability)) {
        if(value.operation==='close'&&keys.length===4)return {v:1,type:'start',operation:'close',capability:value.capability};
        if(value.operation==='page'&&keys.length===5&&Number.isSafeInteger(value.offset)&&typeof value.offset==='number'&&value.offset>=0)
            return {v:1,type:'start',operation:'page',capability:value.capability,offset:value.offset};
        if(value.operation==='detail'&&keys.length===6&&typeof value.id==='string'&&value.id.length>0&&value.id.length<=256
            &&Number.isSafeInteger(value.offset)&&typeof value.offset==='number'&&value.offset>=0)
            return {v:1,type:'start',operation:'detail',capability:value.capability,id:value.id,offset:value.offset};
        if(value.operation==='topics'&&(keys.length===5||keys.length===6)&&Number.isSafeInteger(value.offset)&&typeof value.offset==='number'&&value.offset>=0
            &&(value.search===undefined||(typeof value.search==='string'&&value.search.length<=128*1024))
            &&keys.every(key=>['v','type','operation','capability','offset','search'].includes(key)))
            return {v:1,type:'start',operation:'topics',capability:value.capability,offset:value.offset,...(value.search===undefined?{}:{search:value.search as string})};
    }
    throw Error('invalid request');
}
class PageBusy extends Error {}
function errorCode(error:unknown):MaterialPageErrorCode {
    if(error instanceof PageBusy)return 'busy';
    if(error instanceof MaterialError&&(['stale-operation','invalid-input','limit-exceeded','storage-error','not-found'] as string[]).includes(error.code))return error.code as MaterialPageErrorCode;
    return 'storage-error';
}

/** 只发送实际完成的扫描进度，合并快速更新；底层工作仍由调用方跟踪至真正结束。 */
async function* withProgress<T>(start:(update:(processed:number,total:number)=>void)=>Promise<T>,signal:AbortSignal):AsyncGenerator<Uint8Array,T> {
    let result:{ok:true;value:T}|{ok:false;error:unknown}|undefined,latest:{processed:number;total:number}|undefined;
    let wake:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined,last=-Infinity;
    const notify=()=>{wake?.();wake=undefined;};
    const update=(processed:number,total:number)=>{
        latest={processed,total};
        if(performance.now()-last>=500)notify();
        else if(timer===undefined)timer=setTimeout(()=>{timer=undefined;notify();},Math.max(0,500-(performance.now()-last)));
    };
    const abort=()=>notify();
    signal.addEventListener('abort',abort,{once:true});
    try{
        if(signal.aborted)throw Error('cancelled');
        void Promise.resolve().then(()=>start(update)).then(value=>{result={ok:true,value};notify();},error=>{result={ok:false,error};notify();});
        while(!result){
            if(signal.aborted)throw Error('cancelled');
            if(latest&&performance.now()-last>=500){
                const progress=latest;latest=undefined;last=performance.now();yield message({type:'progress',...progress});continue;
            }
            await new Promise<void>(resolve=>{
                wake=resolve;
                if(result||signal.aborted){notify();return;}
                if(latest&&timer===undefined)timer=setTimeout(()=>{timer=undefined;notify();},Math.max(0,500-(performance.now()-last)));
            });
            if(timer!==undefined){clearTimeout(timer);timer=undefined;}
        }
        if(!result.ok)throw result.error;
        return result.value;
    }finally{if(timer!==undefined)clearTimeout(timer);signal.removeEventListener('abort',abort);}
}

/** 传输成功前不交付新会话；已取消的底层读取完成后才释放容量。 */
export function createMaterialPageBridge(options:MaterialPageBridgeOptions):{connect(port:MaterialPagePort):boolean;dispose():Promise<void>} {
    const maxSessions=options.maxSessions??2,maxPorts=options.maxPorts??4,idleTimeout=options.idleTimeoutMs??30_000,sessionTimeout=options.sessionTimeoutMs??300_000;
    if(!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>32||!Number.isSafeInteger(maxPorts)||maxPorts<1||maxPorts>32
        ||!Number.isSafeInteger(idleTimeout)||idleTimeout<1||idleTimeout>2_147_483_647||!Number.isSafeInteger(sessionTimeout)||sessionTimeout<1||sessionTimeout>2_147_483_647)throw Error('invalid bridge limits');
    const entries=new Map<string,Entry>(),active=new Set<()=>void>(),claimed=new WeakSet<MaterialPagePort>();
    let disposed=false,ready:'pending'|'ready'|'failed'='pending',busyPort=false;
    let disposal:Promise<void>|undefined,finishDrain:(()=>void)|undefined;
    const notifyDrained=()=>{
        if(disposed&&!active.size&&!entries.size){finishDrain?.();finishDrain=undefined;}
    };
    const waiters=new Set<(ok:boolean)=>void>();
    void options.ready.then(()=>{ready='ready';for(const finish of [...waiters])finish(true);},()=>{ready='failed';for(const finish of [...waiters])finish(false);});
    const waitReady=(signal:AbortSignal):Promise<void>=>{
        if(signal.aborted||disposed)return Promise.reject(Error('unavailable'));
        if(ready!=='pending')return ready==='ready'?Promise.resolve():Promise.reject(Error('unavailable'));
        return new Promise((resolve,reject)=>{
            const finish=(ok:boolean)=>{waiters.delete(finish);signal.removeEventListener('abort',abort);ok?resolve():reject(Error('unavailable'));};
            const abort=()=>finish(false);
            waiters.add(finish);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        });
    };
    const drop=(token:string,entry:Entry):Promise<void>=>{
        if(entry.closing)return entry.closing;
        if(entry.timer!==undefined)clearTimeout(entry.timer);
        // Publish the shared closing promise before abort: an abort listener can
        // synchronously reenter disposal and must reuse this same cleanup.
        entry.closing=Promise.resolve().then(async()=>{
            try{await Promise.allSettled([Promise.resolve().then(()=>entry.session?.close()),entry.pending??Promise.resolve()]);}
            finally{if(entries.get(token)===entry)entries.delete(token);notifyDrained();}
        });
        entry.controller.abort();
        return entry.closing;
    };
    const arm=(token:string,entry:Entry)=>{
        if(entry.timer!==undefined)clearTimeout(entry.timer);
        if(!disposed&&!entry.closing&&entries.get(token)===entry){
            // The map order is the idle LRU: a new tab may replace an idle
            // abandoned session, but never one with actual work in flight.
            entries.delete(token);entries.set(token,entry);
            entry.timer=setTimeout(()=>{void drop(token,entry);},sessionTimeout);
        }
    };
    const connect=(port:MaterialPagePort):boolean=>{
        if(port.name!==MATERIAL_PAGE_PORT_NAME)return false;
        if(claimed.has(port))return true;
        claimed.add(port);
        let trusted=false;
        try{trusted=!disposed&&!options.isPrivateContext()&&port.sender?.incognito!==true&&port.sender?.tab?.incognito!==true&&options.isTrustedSender(port.sender);}catch{}
        if(!trusted||disposed){try{port.disconnect();}catch{}return true;}
        // 留一个有界拒绝通道，使繁忙错误仍经过正常传输校验；进一步的并发直接断开。
        const rejectBusy=active.size>=maxPorts;
        if(rejectBusy&&busyPort){try{port.disconnect();}catch{}return true;}
        if(rejectBusy)busyPort=true;
        const controller=new AbortController(),pending=new Set<Promise<unknown>>();
        let closed=false,started=false,delivered=false,complete=false,retireBorrowed=false,ownedToken:string|undefined,ownedEntry:Entry|undefined,borrowed:Entry|undefined;
        const timer=setTimeout(()=>close(),idleTimeout);
        const cleanup=()=>{clearTimeout(timer);try{port.onMessage.removeListener(onMessage);}catch{}try{port.onDisconnect.removeListener(onDisconnect);}catch{}};
        const release=()=>{if(active.delete(close)&&rejectBusy)busyPort=false;notifyDrained();};
        const close=()=>{if(closed)return;closed=true;controller.abort();cleanup();try{port.disconnect();}catch{}if(!started)release();};
        const onDisconnect=()=>close();
        const track=<T>(work:Promise<T>):Promise<T>=>{pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;};
        const entryWork=<T>(entry:Entry,task:()=>Promise<T>):Promise<T>=>{
            const work=Promise.resolve().then(task);entry.pending=work;
            void work.then(()=>{if(entry.pending===work)entry.pending=undefined;},()=>{if(entry.pending===work)entry.pending=undefined;});
            return track(work);
        };
        const onMessage=(input:unknown)=>{
            if(started){close();return;}
            let request:MaterialPageRequest;
            try{request=parse(input);}catch{close();return;}
            started=true;
            void(async()=>{
                try{
                    await waitReady(controller.signal);
                    if(controller.signal.aborted||disposed||options.isPrivateContext()||disposed||controller.signal.aborted)throw Error('unavailable');
                    clearTimeout(timer);port.onMessage.removeListener(onMessage);port.onDisconnect.removeListener(onDisconnect);
                    const source=(signal:AbortSignal):AsyncIterable<Uint8Array>=>{
                        const run=async function*():AsyncGenerator<Uint8Array>{
                            try{
                                if(rejectBusy){yield message({type:'error',code:'busy'});return;}
                                if(request.operation==='close'){
                                    const entry=entries.get(request.capability);
                                    if(entry)await track(drop(request.capability,entry));
                                    yield message({type:'closed'});return;
                                }
                                let entry:Entry,token:string;
                                if(request.operation==='open'){
                                    if(entries.size>=maxSessions){
                                        const idle=[...entries].find(([,candidate])=>!candidate.busy&&!candidate.closing);
                                        if(idle)await track(drop(idle[0],idle[1]));
                                        if(signal.aborted)throw Error('cancelled');
                                        if(entries.size>=maxSessions)throw new PageBusy();
                                    }
                                    token=capability();if(entries.has(token))throw Error('duplicate capability');
                                    entry={controller:new AbortController(),busy:true};entries.set(token,entry);ownedToken=token;ownedEntry=entry;
                                    const abort=()=>entry.controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
                                    try{entry.session=yield* withProgress(update=>entryWork(entry,()=>createMaterialPageSession(options.repository,request.options,entry.controller.signal,update)),signal);}
                                    finally{signal.removeEventListener('abort',abort);}
                                } else {
                                    token=request.capability;
                                    const found=entries.get(token);
                                    if(!found||found.closing||!found.session)throw new MaterialError('stale-operation','材料读取会话已结束');
                                    if(found.busy)throw new PageBusy();
                                    entry=found;entry.busy=true;borrowed=entry;
                                    if(entry.timer!==undefined)clearTimeout(entry.timer);
                                }
                                if(signal.aborted||entry.controller.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');
                                if(request.operation==='topics'){
                                    const page=await entryWork(entry,()=>entry.session!.getTopicsPage({offset:request.offset,search:request.search,signal}));
                                    if(signal.aborted||entry.controller.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');
                                    yield message({type:'topics-header',version:1,revision:page.revision,total:page.total,matched:page.matched,offset:page.offset,nextOffset:page.nextOffset});
                                    for(const topic of page.topics){if(signal.aborted||entry.controller.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');yield message({type:'topic',value:topic});}
                                    await entryWork(entry,()=>options.repository.checkSnapshot(entry.session!.snapshot,signal));
                                    if(signal.aborted||entry.controller.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');
                                    yield message({type:'complete',count:page.topics.length});complete=true;return;
                                }
                                if(request.operation==='detail'){
                                    const combined=new AbortController(),abort=()=>combined.abort();
                                    signal.addEventListener('abort',abort,{once:true});entry.controller.signal.addEventListener('abort',abort,{once:true});
                                    if(signal.aborted||entry.controller.signal.aborted)abort();
                                    try{
                                        const detail=await entryWork(entry,()=>readMaterialDetailPage(options.repository,{revision:entry.session!.revision,id:request.id,offset:request.offset},combined.signal,entry.session!.snapshot));
                                        if(combined.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');
                                        yield message({type:'detail-header',version:1,revision:detail.revision,id:detail.id,total:detail.total,offset:detail.offset,nextOffset:detail.nextOffset});
                                        for(const key of Object.keys(detail.metadata) as Array<keyof MaterialDetailMetadata>){
                                            if(combined.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');
                                            yield message({type:'metadata',key,value:detail.metadata[key]});
                                        }
                                        for(const reference of detail.references){if(combined.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');yield message({type:'reference',value:reference});}
                                        await entryWork(entry,()=>options.repository.checkSnapshot(entry.session!.snapshot,combined.signal));
                                        if(combined.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');
                                        yield message({type:'complete',count:detail.references.length});complete=true;return;
                                    }finally{signal.removeEventListener('abort',abort);entry.controller.signal.removeEventListener('abort',abort);}
                                }
                                const page=await entryWork(entry,()=>entry.session!.getPage({offset:request.operation==='open'?0:request.offset,signal}));
                                if(signal.aborted||entry.controller.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');
                                yield message({type:'header',version:1,operation:request.operation,...(request.operation==='open'?{capability:token}:{}),revision:page.revision,total:page.total,matched:page.matched,offset:page.offset,nextOffset:page.nextOffset});
                                for(const item of page.items){if(signal.aborted||entry.controller.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');yield message({type:'summary',value:item});}
                                await entryWork(entry,()=>options.repository.checkSnapshot(entry.session!.snapshot,signal));
                                if(signal.aborted||entry.controller.signal.aborted)throw new MaterialError('stale-operation','材料读取会话已结束');
                                yield message({type:'complete',count:page.items.length});
                                complete=true;
                            }catch(error){
                                if(signal.aborted)throw error;
                                const code=borrowed?.controller.signal.aborted?'stale-operation':errorCode(error);
                                if(borrowed&&code==='stale-operation')retireBorrowed=true;
                                yield message({type:'error',code});
                            }
                        };
                        const iterator=run();return {[Symbol.asyncIterator](){return {next:()=>track(iterator.next()),return:()=>track(iterator.return(undefined))};}};
                    };
                    await sendMaterialRead(port,source,{signal:controller.signal,idleTimeoutMs:idleTimeout});
                    delivered=true;
                }catch{/* 断连不暴露私密异常，也不推测部分结果完整。 */}
                finally{
                    close();
                    while(pending.size)await Promise.allSettled([...pending]);
                    if(ownedEntry&&ownedToken){
                        // An error response has no usable session, even if its transport succeeded.
                        if(!delivered||!complete||!ownedEntry.session)await drop(ownedToken,ownedEntry);
                        else {ownedEntry.busy=false;arm(ownedToken,ownedEntry);}
                    }
                    if(borrowed&&(request.operation==='page'||request.operation==='detail'||request.operation==='topics')){
                        if(retireBorrowed)await drop(request.capability,borrowed);
                        else{borrowed.busy=false;arm(request.capability,borrowed);}
                    }
                    release();
                }
            })();
        };
        active.add(close);
        try{port.onDisconnect.addListener(onDisconnect);if(!closed)port.onMessage.addListener(onMessage);if(closed)cleanup();}catch{close();}
        return true;
    };
    return {connect,dispose(){
        if(disposal)return disposal;
        disposal=new Promise(resolve=>{finishDrain=resolve;});
        disposed=true;for(const close of [...active])close();for(const [token,entry] of entries)void drop(token,entry);
        notifyDrained();return disposal;
    }};
}

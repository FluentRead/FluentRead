/**
 * @file src/app/background/materialPageRuntime.ts
 * 文件职责：将材料分页端口接入扩展后台运行时。
 * 主要内容：验证设置页来源、按需创建材料仓库、安装和移除端口监听，并等待未完成的读取实际结束后关闭数据库；监听移除失败时保留租约以便安全重试。
 * 模块边界：只负责依赖组装，不读取网页、不保存或发送材料正文；查询、权限与传输细节由专用桥接模块处理。
 */
import browser from 'webextension-polyfill';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {createMaterialPageBridge, type MaterialPagePort} from '@/src/features/vocabulary/materialPageBridge';
import {isTrustedSettingsSender} from './handlers/trustedSettingsSender';

type Runtime={id:string;getURL(path:string):string;onConnect:{addListener(fn:(port:MaterialPagePort)=>void):void;removeListener(fn:(port:MaterialPagePort)=>void):void}};
type Options={runtime:Runtime;ready:Promise<unknown>;isPrivateContext():boolean;createRepository():MaterialRepository};
type Lease={dispose:()=>Promise<void>;cleanupFailed:boolean;recover():void};
const installed=new WeakMap<Runtime,Lease>();
function reusable(runtime:Runtime):(()=>Promise<void>)|undefined {
    const previous=installed.get(runtime);if(!previous)return undefined;
    if(!previous.cleanupFailed)return previous.dispose;
    previous.recover();return undefined;
}

/** 监听立即安装；只有可信页面实际发出请求时才打开数据库。 */
export function installMaterialPageRuntime(options:Options):()=>Promise<void> {
    const previous=reusable(options.runtime);if(previous)return previous;
    let repository:MaterialRepository|undefined,disposed=false;
    const getRepository=()=>{
        if(disposed)throw Error('unavailable');
        if(!repository){
            const created=options.createRepository();
            repository=created;
            // 工厂可能同步触发销毁；由排空后的统一清理保留并关闭已创建的仓库。
            if(disposed)throw Error('unavailable');
        }
        return repository;
    };
    const bridge=createMaterialPageBridge({
        repository:{
            openSnapshot:signal=>getRepository().openSnapshot(signal),
            readSnapshotRecord:(revision,id,signal)=>getRepository().readSnapshotRecord(revision,id,signal),
            checkSnapshot:(revision,signal)=>getRepository().checkSnapshot(revision,signal),
        },ready:options.ready,isPrivateContext:options.isPrivateContext,
        isTrustedSender:sender=>isTrustedSettingsSender(sender,options.runtime.id,options.runtime.getURL('/options.html')),
    });
    const onConnect=(port:MaterialPagePort)=>{if(!disposed)bridge.connect(port);};
    let disposal:Promise<void>|undefined,databaseClosed=false,drained=false,cleanupFinished=false;
    const dispose=():Promise<void>=>{
        if(disposal)return disposal;
        disposed=true;
        drained=false;cleanupFinished=false;
        lease.cleanupFailed=false;
        let resolve!:()=>void,reject!:(error:unknown)=>void;
        disposal=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
        void disposal.catch(()=>{});
        void(async()=>{
            let removalError:unknown,removalFailed=false;
            try{options.runtime.onConnect.removeListener(onConnect);}catch(error){removalFailed=true;removalError=error;lease.cleanupFailed=true;}
            try{
                await bridge.dispose();drained=true;
                if(repository&&!databaseClosed){repository.db.close();databaseClosed=true;}
                if(removalFailed)throw removalError;resolve();
            }catch(error){lease.cleanupFailed=true;reject(error);}
            finally{
                cleanupFinished=true;
                // 任一清理失败均保留租约，直到监听移除与数据库关闭都能确认完成。
                if(drained&&!lease.cleanupFailed)installed.delete(options.runtime);
                if(lease.cleanupFailed)disposal=undefined;
            }
        })();
        return disposal;
    };
    const lease:Lease={dispose,cleanupFailed:false,recover(){
        if(!drained||!cleanupFinished)throw Error('材料分页仍在等待未完成读取，无法重新安装');
        options.runtime.onConnect.removeListener(onConnect);
        if(repository&&!databaseClosed){repository.db.close();databaseClosed=true;}
        installed.delete(options.runtime);
    }};
    installed.set(options.runtime,lease);
    try{options.runtime.onConnect.addListener(onConnect);}catch(error){void dispose();throw error;}
    return dispose;
}

export function installBrowserMaterialPageRuntime(ready:Promise<unknown>):void {
    installMaterialPageRuntime({
        runtime:browser.runtime as unknown as Runtime,ready,
        isPrivateContext:()=>browser.extension.inIncognitoContext===true,
        createRepository:()=>new MaterialRepository(undefined,()=>vocabularyBook.list({order:'recent'})),
    });
}

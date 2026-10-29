/**
 * @file src/app/background/materialBackupExportRuntime.ts
 * 文件职责：将材料备份导出端口接入扩展后台生命周期。
 * 主要内容：安装受信任设置页端口、等待配置就绪，并在销毁时释放监听与材料数据库连接。
 * 模块边界：不打开用户文件或显示结果；材料内容由本地仓库按快照读取，仅传送给可信扩展设置页。
 */
import browser from 'webextension-polyfill';
import {vocabularyBook} from '@/src/features/vocabulary/repository';
import {MaterialRepository} from '@/src/features/vocabulary/materialRepository';
import {createMaterialBackupExportBridge, type MaterialBackupExportPort} from '@/src/features/vocabulary/materialBackupExportBridge';
import {isTrustedSettingsSender} from './handlers/trustedSettingsSender';

type Runtime={id:string;getURL(path:string):string;onConnect:{addListener(listener:(port:MaterialBackupExportPort)=>void):void;removeListener(listener:(port:MaterialBackupExportPort)=>void):void}};
type Options={runtime:Runtime;repository:MaterialRepository;ready:Promise<unknown>;isPrivateContext():boolean};
type Lease={dispose:()=>Promise<void>;cleanupFailed:boolean;recover():void};
const installed=new WeakMap<Runtime,Lease>();
function reusable(runtime:Runtime):(()=>Promise<void>)|undefined {
    const prior=installed.get(runtime);if(!prior)return undefined;
    if(!prior.cleanupFailed)return prior.dispose;
    prior.recover();return undefined;
}

export function installMaterialBackupExportRuntime(options:Options):()=>Promise<void> {
    const prior=reusable(options.runtime);if(prior)return prior;
    const bridge=createMaterialBackupExportBridge({repository:options.repository,ready:options.ready,isPrivateContext:options.isPrivateContext,
        isTrustedSender:sender=>isTrustedSettingsSender(sender,options.runtime.id,options.runtime.getURL('/options.html'))});
    let disposed=false;
    const onConnect=(port:MaterialBackupExportPort)=>{if(!disposed)bridge.connect(port);};
    let disposal:Promise<void>|undefined,databaseClosed=false,drained=false,cleanupFinished=false;
    const dispose=():Promise<void>=>{
        if(disposal)return disposal;
        disposed=true;
        drained=false;cleanupFinished=false;
        lease.cleanupFailed=false;
        let finish!:()=>void,fail!:(error:unknown)=>void;
        disposal=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});
        void disposal.catch(()=>{});
        void(async()=>{
            let removalError:unknown,removalFailed=false;
            try{options.runtime.onConnect.removeListener(onConnect);}catch(error){removalFailed=true;removalError=error;lease.cleanupFailed=true;}
            try {
                // 保留安装记录和数据库，直到所有无法强制终止的读取真正结束。
                await bridge.dispose();
                drained=true;
                if(!databaseClosed){options.repository.db.close();databaseClosed=true;}
                if(removalFailed)throw removalError;
                finish();
            } catch(error){lease.cleanupFailed=true;fail(error);}
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
        if(!drained||!cleanupFinished)throw Error('材料导出仍在等待未完成读取，无法重新安装');
        options.runtime.onConnect.removeListener(onConnect);
        if(!databaseClosed){options.repository.db.close();databaseClosed=true;}
        installed.delete(options.runtime);
    }};
    installed.set(options.runtime,lease);
    try{options.runtime.onConnect.addListener(onConnect);}
    catch(error){void dispose();throw error;}
    return dispose;
}

/** 仓库在首次可信请求使用时打开，本地旧词书只用于现有迁移。 */
export function installBrowserMaterialBackupExportRuntime(ready:Promise<unknown>):()=>Promise<void> {
    const runtime=browser.runtime as unknown as Runtime;
    const prior=reusable(runtime);if(prior)return prior;
    return installMaterialBackupExportRuntime({runtime,ready,isPrivateContext:()=>browser.extension.inIncognitoContext===true,
        repository:new MaterialRepository(undefined,()=>vocabularyBook.list({order:'recent'}))});
}

/**
 * @file src/features/image-translation/services/mangaSessionFallback.ts
 * 文件职责：在 GPU 推理出错时为同一个漫画识别或修补会话有界切换 CPU，避免 SDK 吞掉异常后返回空文字。
 * 主要内容：仅重试失败模型一次、复用本次张量；取消不重试，释放失效 GPU 和替代 CPU 会话；若释放 GPU 后创建 CPU 失败或被取消，通过可选 onBroken 回调通知上层丢弃损毁会话；串行模型队列保证不会并发切换。
 * 模块边界：只装饰 ONNX 公共会话接口；调用方提供 CPU 创建端口和当前取消信号，不读取网页、模型文件或用户配置。
 */
import type {InferenceSession} from 'onnxruntime-web';

export function protectMangaSession(session:InferenceSession,createCpu:()=>Promise<InferenceSession>,signal:()=>AbortSignal|undefined,onBroken?:()=>void):()=>void {
    const run=session.run.bind(session),release=session.release.bind(session);
    let failure:unknown;
    let cpu:InferenceSession|undefined,attempted=false,released=false,disposed=false;
    const execute=async(...args:Parameters<InferenceSession['run']>)=>{
        if(cpu)return cpu.run(...args);
        try{return await run(...args);}
        catch(error){
            if(attempted||signal()?.aborted)throw error;
            attempted=true;released=true;
            // 失效设备的释放异常不能阻止 CPU 完成本页；CPU 创建失败或中止时通知上层丢弃已释放的失效会话。
            await release().catch(()=>undefined);
            try{cpu=await createCpu();}
            catch(fallbackError){onBroken?.();throw fallbackError;}
            return cpu.run(...args);
        }
    };
    session.run=(async(...args:Parameters<InferenceSession['run']>)=>{
        try{return await execute(...args);}catch(error){failure=error;throw error;}
    }) as InferenceSession['run'];
    session.release=async()=>{
        if(disposed)return;disposed=true;
        try {await cpu?.release();}
        finally {if(!released){released=true;await release();}}
    };
    // Paddle 的识别层会把推理异常变成空结果；调用方在其返回后仍须检查实际失败。
    return ()=>{if(failure!==undefined){const error=failure;failure=undefined;throw error;}};
}

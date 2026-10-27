/**
 * @file src/features/image-translation/content/mangaReadingCoordinator.ts
 * 文件职责：管理漫画按需阅读目标的短生命周期令牌，避免异步校验结果在换页或取消后暴露。
 * 主要内容：只接收已有可见目标快照，分别列出图片、画布、背景和长图分段；换代、暂停和卸载撤销旧目标及在途读取；异步读前读后检查身份并按统一预算复制文字，不截断。
 * 模块边界：不查 DOM、不发现页面、不运行 OCR、不创建持久缓存；目标资格、内容摘要和具体数据源由调用方注入。
 */
import {prepareMangaReadingLines, type MangaReadingLine} from './mangaReadingSnapshots';

export interface MangaReadingSource<T extends object> {
    surface: T;
    kind: 'image' | 'canvas' | 'background' | 'segment';
    /** 当前候选次序，不声称是站点的章节页码。 */
    ordinal: number;
    identity: string;
    segment?: {top:number; height:number};
}
export type MangaReadingResult = {status:'ready'; lines:MangaReadingLine[]}
    | {status:'empty' | 'pending' | 'error' | 'unavailable' | 'stale' | 'cancelled' | 'overBudget'};
export interface MangaReadingCandidate {
    token: object;
    kind: MangaReadingSource<object>['kind'];
    ordinal: number;
    segment?: {top:number; height:number};
}
export type MangaReadingList = {status:'ready';items:MangaReadingCandidate[]} | {status:'unavailable' | 'overBudget'};

// 重挂不能绕过不可中断摘要的全局并发限制；真正结束后才归还读取槽。
let activeLoads = 0;

export function createMangaReadingCoordinator<T extends object>(ports: {
    live: (source:MangaReadingSource<T>) => boolean;
    load: (source:MangaReadingSource<T>, signal:AbortSignal) => Promise<MangaReadingResult>;
}, options: {maxCandidates?:number} = {}) {
    const maximum = options.maxCandidates ?? 64;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 64) throw new RangeError('漫画阅读目标预算无效');
    let disposed = false, overflow = false;
    const targets = new Map<object,MangaReadingSource<T>>();
    const pending = new Set<AbortController>();
    function invalidate():void {
        targets.clear();overflow=false;
        for(const controller of pending) controller.abort();
        pending.clear();
    }
    const live = (source:MangaReadingSource<T>) => {try{return ports.live(source);}catch{return false;}};
    return {
        update(sources:ReadonlyArray<MangaReadingSource<T>>) {
            invalidate();if(disposed)return;
            if(sources.length>maximum){overflow=true;return;}
            for(const source of sources) targets.set(Object.freeze({}),{...source,...(source.segment?{segment:{...source.segment}}:{})});
        },
        invalidate,
        list():MangaReadingList {
            if(disposed)return {status:'unavailable'};
            if(overflow)return {status:'overBudget'};
            return {status:'ready',items:Array.from(targets,([token,source])=>({token,kind:source.kind,ordinal:source.ordinal,
                ...(source.segment?{segment:{...source.segment}}:{})}))};
        },
        /** 仅供会话建立单一已打开快照的观察句柄，永不暴露给产品界面。 */
        source(token:object):MangaReadingSource<T>|undefined {return disposed?undefined:targets.get(token);},
        async read(token:object, signal:AbortSignal):Promise<MangaReadingResult> {
            if(signal.aborted)return {status:'cancelled'};
            const source=targets.get(token);
            if(disposed||!source||!live(source))return {status:'stale'};
            if(activeLoads)return {status:'unavailable'};
            activeLoads++;
            const controller=new AbortController();pending.add(controller);
            const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
            if(signal.aborted)controller.abort();
            let stop!:()=>void;
            const cancelled=new Promise<MangaReadingResult>(resolve=>{
                stop=()=>resolve({status:signal.aborted?'cancelled':'stale'});
                if(controller.signal.aborted)stop();else controller.signal.addEventListener('abort',stop,{once:true});
            });
            try {
                const operation=Promise.resolve().then(()=>controller.signal.aborted?{status:'cancelled'} as const:ports.load(source,controller.signal)).catch(()=>({status:'error'} as const)).finally(()=>{activeLoads--;});
                const result=await Promise.race([operation,cancelled]);
                if(signal.aborted)return {status:'cancelled'};
                if(disposed||controller.signal.aborted||targets.get(token)!==source||!live(source))return {status:'stale'};
                if(result.status!=='ready')return result;
                const prepared=prepareMangaReadingLines(result.lines);
                if(prepared.status==='overBudget')return {status:'overBudget'};
                if(prepared.status!=='ready')return {status:'error'};
                return prepared.lines.length?{status:'ready',lines:prepared.lines}:{status:'empty'};
            } finally {
                signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',stop);pending.delete(controller);
            }
        },
        dispose() {if(disposed)return;disposed=true;invalidate();},
    };
}

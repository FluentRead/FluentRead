import {describe, expect, it, vi} from 'vitest';
import {createMangaReadingCoordinator, type MangaReadingSource} from '@/src/features/image-translation/content/mangaReadingCoordinator';

const line = {text:'译文',sourceText:'source',bbox:{x0:0,y0:0,x1:10,y1:10},backgroundColor:'transparent'};
const deferred = <T,>() => {let resolve!: (value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const source = (surface:object,kind:MangaReadingSource<object>['kind'], ordinal:number):MangaReadingSource<object> => ({surface,kind,ordinal,identity:`${kind}-${ordinal}`});

describe('漫画按需阅读目标所有权',()=>{
    it('预算非法时拒绝创建；零预算明确拒绝任何目标',()=>{
        for(const maxCandidates of [-1,1.5,NaN,Infinity,65])expect(()=>createMangaReadingCoordinator({load:vi.fn(),live:()=>true},{maxCandidates})).toThrow(RangeError);
        const c=createMangaReadingCoordinator({load:vi.fn(),live:()=>true},{maxCandidates:0});c.update([source({},'image',1)]);
        expect(c.list()).toEqual({status:'overBudget'});c.update([]);expect(c.list()).toEqual({status:'ready',items:[]});c.dispose();
    });
    it('预取消、无效目标或身份检查异常不会启动加载，卸载后不能恢复',async()=>{
        const live=vi.fn(()=>{throw Error('source unavailable');}),load=vi.fn(),c=createMangaReadingCoordinator({load,live});
        const surface={},item=source(surface,'image',1);c.update([item]);const list=c.list();if(list.status!=='ready')throw Error('unexpected');
        const signal=new AbortController();signal.abort();expect(await c.read(list.items[0].token,signal.signal)).toEqual({status:'cancelled'});
        expect(await c.read({},new AbortController().signal)).toEqual({status:'stale'});
        expect(await c.read(list.items[0].token,new AbortController().signal)).toEqual({status:'stale'});expect(load).not.toHaveBeenCalled();
        expect(c.source(list.items[0].token)?.surface).toBe(surface);c.dispose();c.dispose();c.update([item]);
        expect(c.source(list.items[0].token)).toBeUndefined();expect(c.list()).toEqual({status:'unavailable'});
        expect(await c.read(list.items[0].token,new AbortController().signal)).toEqual({status:'stale'});
    });
    it('立即取消不会启动异步加载；恢复后可安全读取',async()=>{
        const load=vi.fn(async()=>({status:'empty' as const})),c=createMangaReadingCoordinator({load,live:()=>true});
        c.update([source({},'image',1)]);const list=c.list();if(list.status!=='ready')throw Error('unexpected');
        const abort=new AbortController(),read=c.read(list.items[0].token,abort.signal);abort.abort();expect(await read).toEqual({status:'cancelled'});
        await Promise.resolve();await Promise.resolve();expect(load).not.toHaveBeenCalled();
        expect(await c.read(list.items[0].token,new AbortController().signal)).toEqual({status:'empty'});c.dispose();
    });
    it('监听注册期间同步取消时不丢失取消信号或启动加载',async()=>{
        const load=vi.fn(async()=>({status:'empty' as const})),c=createMangaReadingCoordinator({load,live:()=>true});
        c.update([source({},'canvas',1)]);const list=c.list();if(list.status!=='ready')throw Error('unexpected');
        const controller=new AbortController(),original=controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal,'addEventListener').mockImplementation((...args)=>{original(...args);controller.abort();});
        expect(await c.read(list.items[0].token,controller.signal)).toEqual({status:'cancelled'});
        await Promise.resolve();expect(load).not.toHaveBeenCalled();c.dispose();
    });
    it('加载异常、异常数据、超预算和空文字均返回明确状态，不截断或复活旧文本',async()=>{
        const load=vi.fn(),c=createMangaReadingCoordinator({load,live:()=>true});c.update([source({},'image',1)]);
        const list=c.list();if(list.status!=='ready')throw Error('unexpected');const read=()=>c.read(list.items[0].token,new AbortController().signal);
        load.mockRejectedValueOnce(Error('provider down'));expect(await read()).toEqual({status:'error'});
        load.mockResolvedValueOnce({status:'ready',lines:[{...line,bbox:{x0:10,y0:0,x1:1,y1:1}}]});expect(await read()).toEqual({status:'error'});
        load.mockResolvedValueOnce({status:'ready',lines:Array.from({length:513},()=>line)});expect(await read()).toEqual({status:'overBudget'});
        load.mockResolvedValueOnce({status:'ready',lines:[]});expect(await read()).toEqual({status:'empty'});
        load.mockResolvedValueOnce({status:'pending'});expect(await read()).toEqual({status:'pending'});c.dispose();
    });
    it('多可见载体分别有不暴露 DOM 的 token，枚举不触发读取或翻译',()=>{
        const load=vi.fn(), live=vi.fn(()=>true), c=createMangaReadingCoordinator({load,live});
        const a={},b={},segment={};c.update([source(a,'image',1),source(b,'canvas',2),{...source(segment,'segment',3),segment:{top:2048,height:2048}}]);
        const list=c.list();expect(list.status).toBe('ready');if(list.status!=='ready')throw Error('unexpected');
        expect(list.items.map(x=>x.kind)).toEqual(['image','canvas','segment']);expect(list.items[2].segment).toEqual({top:2048,height:2048});
        expect(list.items[0].token).not.toBe(a);expect(load).not.toHaveBeenCalled();expect(live).not.toHaveBeenCalled();
    });
    it('切页、刷新、暂停或卸载撤销旧 token，迟到的读取结果不能复活',async()=>{
        const pending=deferred<{status:'ready';lines:typeof line[]}>(),c=createMangaReadingCoordinator({load:()=>pending.promise,live:()=>true});
        c.update([source({},'background',1)]);const list=c.list();if(list.status!=='ready')throw Error('unexpected');
        const read=c.read(list.items[0].token,new AbortController().signal);c.invalidate();pending.resolve({status:'ready',lines:[line]});
        expect(await read).toEqual({status:'stale'});expect(await c.read(list.items[0].token,new AbortController().signal)).toEqual({status:'stale'});
    });
    it('取消在途读取立即结束，忽略迟到结果并保留原始错误处理',async()=>{
        const pending=deferred<{status:'ready';lines:typeof line[]}>(),c=createMangaReadingCoordinator({load:()=>pending.promise,live:()=>true});
        c.update([source({},'image',1)]);const list=c.list();if(list.status!=='ready')throw Error('unexpected');
        const abort=new AbortController(),read=c.read(list.items[0].token,abort.signal);abort.abort();expect(await read).toEqual({status:'cancelled'});
        pending.resolve({status:'ready',lines:[line]});await Promise.resolve();
    });
    it('取消仅停止等待，底层任务真正结束前拒绝并发读取',async()=>{
        const pending=deferred<{status:'empty'}>(),load=vi.fn(()=>pending.promise),c=createMangaReadingCoordinator({load,live:()=>true});
        c.update([source({},'canvas',1)]);const list=c.list();if(list.status!=='ready')throw Error('unexpected');
        const abort=new AbortController(),first=c.read(list.items[0].token,abort.signal);await Promise.resolve();abort.abort();
        expect(await first).toEqual({status:'cancelled'});expect(await c.read(list.items[0].token,new AbortController().signal)).toEqual({status:'unavailable'});
        c.dispose();const next=createMangaReadingCoordinator({load,live:()=>true});next.update([source({},'canvas',1)]);
        const nextList=next.list();if(nextList.status!=='ready')throw Error('unexpected');
        expect(await next.read(nextList.items[0].token,new AbortController().signal)).toEqual({status:'unavailable'});
        expect(load).toHaveBeenCalledOnce();pending.resolve({status:'empty'});await Promise.resolve();await Promise.resolve();await Promise.resolve();
        expect(await next.read(nextList.items[0].token,new AbortController().signal)).toEqual({status:'empty'});expect(load).toHaveBeenCalledTimes(2);next.dispose();
    });
    it('候选过多显式拒绝，不截断列表或启动任何读取',()=>{
        const c=createMangaReadingCoordinator({load:vi.fn(),live:()=>true},{maxCandidates:2});
        c.update([source({},'image',1),source({},'canvas',2),source({},'background',3)]);
        expect(c.list()).toEqual({status:'overBudget'});
    });
    it('读取前后重新验证，任一阶段无效都不返回旧文本',async()=>{
        const pending=deferred<{status:'ready';lines:typeof line[]}>(),live=vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
        const c=createMangaReadingCoordinator({load:()=>pending.promise,live});c.update([source({},'segment',1)]);
        const list=c.list();if(list.status!=='ready')throw Error('unexpected');const read=c.read(list.items[0].token,new AbortController().signal);
        pending.resolve({status:'ready',lines:[line]});expect(await read).toEqual({status:'stale'});
    });
    it('已经打开的独立文字快照不随后续滚动候选换代被篡改或关闭',async()=>{
        const c=createMangaReadingCoordinator({load:async()=>({status:'ready' as const,lines:[line]}),live:()=>true});
        c.update([source({},'image',1)]);const list=c.list();if(list.status!=='ready')throw Error('unexpected');
        const opened=await c.read(list.items[0].token,new AbortController().signal);
        expect(opened.status).toBe('ready');c.invalidate();c.update([source({},'image',2)]);
        expect(opened).toEqual({status:'ready',lines:[line]});expect(await c.read(list.items[0].token,new AbortController().signal)).toEqual({status:'stale'});
    });
});

import {afterEach,describe,expect,it,vi} from 'vitest';
import {localModelIdleMs} from '@/src/shared/onnx/modelResidency';
import {createInferencePacer,createLocalInferenceBudget,localInferenceLimits,localWasmThreads} from '@/src/shared/onnx/resources';
import {probeWebGpu} from '@/src/shared/onnx/webgpu';
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetModules();});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
describe('本地推理共享资源预算',()=>{
    it('模型保温随已知内存缩短或延长，未知和无效内存使用两分钟',()=>{
        for (const memory of [0.25, 1, 2, 4]) expect(localModelIdleMs(memory)).toBe(60_000);
        for (const memory of [4.1, 8, 16]) expect(localModelIdleMs(memory)).toBe(180_000);
        for (const memory of [null, '8', 0, -1, NaN, Infinity]) expect(localModelIdleMs(memory)).toBe(120_000);
        vi.stubGlobal('navigator', undefined); expect(localModelIdleMs()).toBe(120_000);
        vi.stubGlobal('navigator', {}); expect(localModelIdleMs()).toBe(120_000);
        vi.stubGlobal('navigator', {deviceMemory: 4}); expect(localModelIdleMs()).toBe(60_000);
        vi.stubGlobal('navigator', {deviceMemory: 8}); expect(localModelIdleMs()).toBe(180_000);
    });
    it('限制硬件线程与并行数量，为小设备保留资源',()=>{
        expect(localInferenceLimits(16,8)).toEqual({jobs:2,threads:4});
        expect(localInferenceLimits(12,8)).toEqual({jobs:2,threads:3});
        expect(localInferenceLimits(8,8)).toEqual({jobs:2,threads:2});
        expect(localInferenceLimits(4,8)).toEqual({jobs:1,threads:2});
        expect(localInferenceLimits(16,4)).toEqual({jobs:1,threads:1});
        for(const n of [1,0,-1,NaN,Infinity])expect(localInferenceLimits(n,8)).toEqual({jobs:1,threads:1});
        vi.stubGlobal('navigator',undefined);expect(localInferenceLimits()).toEqual({jobs:1,threads:1});
        vi.stubGlobal('navigator',{hardwareConcurrency:8});expect(localInferenceLimits()).toEqual({jobs:2,threads:2});
    });
    it('跨源隔离和共享内存均可用才选择 pthread，失败锁定单线程',async()=>{
        vi.stubGlobal('navigator',{hardwareConcurrency:8});vi.stubGlobal('crossOriginIsolated',false);expect(localWasmThreads()).toBe(1);
        vi.stubGlobal('crossOriginIsolated',true);vi.stubGlobal('SharedArrayBuffer',undefined);expect(localWasmThreads()).toBe(1);
        vi.stubGlobal('SharedArrayBuffer',class {});expect(localWasmThreads()).toBe(2);
        const fresh=await import('@/src/shared/onnx/resources');fresh.forceSingleThreadInference();expect(fresh.localWasmThreads()).toBe(1);
    });
    it('FIFO 并行闸门只运行预算内任务，失败释放槽位',async()=>{
        const run=createLocalInferenceBudget(2),a=deferred(),b=deferred(),started:string[]=[];
        const first=run(async()=>{started.push('a');await a.promise;throw new Error('failed');});const rejected=expect(first).rejects.toThrow('failed');
        const second=run(async()=>{started.push('b');await b.promise;return 2;});
        const third=run(async()=>{started.push('c');return 3;});const fourth=run(async()=>{started.push('d');return 4;});
        expect(started).toEqual(['a','b']);a.resolve();await rejected;expect(await third).toBe(3);expect(await fourth).toBe(4);b.resolve();expect(await second).toBe(2);expect(started).toEqual(['a','b','c','d']);
    });
    it('取消排队请求不打断当前任务，启动前取消不执行用户代码',async()=>{
        const run=createLocalInferenceBudget(1),busy=deferred(),active=run(()=>busy.promise);
        const signal=new AbortController(),operation=vi.fn(async()=>1),queued=run(operation,signal.signal);const stopped=expect(queued).rejects.toMatchObject({name:'AbortError'});signal.abort();await stopped;expect(operation).not.toHaveBeenCalled();
        await expect(run(operation,signal.signal)).rejects.toMatchObject({name:'AbortError'});
        const racing=new AbortController(),next=run(operation,racing.signal);const cancelled=expect(next).rejects.toMatchObject({name:'AbortError'});busy.resolve();racing.abort();await active;await cancelled;
        expect(await run(async()=>3)).toBe(3);
    });
    it('推理间休息遵守 70% 计算目标并保留调度余量，异常后串行队列仍可用',async()=>{
        let time=0;const sleep=vi.fn(async ms=>{time+=ms;});const pace=createInferencePacer(()=>time,sleep);
        expect(await pace(async()=>{time+=70;return 1;})).toBe(1);
        await expect(pace(async()=>{time+=35;throw new Error('operator');})).rejects.toThrow('operator');
        expect(await pace(async()=>2)).toBe(2);expect(sleep.mock.calls).toEqual([[30],[15]]);
    });

    it('硬件默认值读取实际内存并向下取整核数，缺失设备字段采用保守默认值',()=>{
        vi.stubGlobal('navigator',{});
        expect(localInferenceLimits()).toEqual({jobs:1,threads:1});
        vi.stubGlobal('navigator',{hardwareConcurrency:8,deviceMemory:4});
        expect(localInferenceLimits()).toEqual({jobs:1,threads:1});
        vi.stubGlobal('navigator',{hardwareConcurrency:8,deviceMemory:8});
        expect(localInferenceLimits()).toEqual({jobs:2,threads:2});
        expect(localInferenceLimits(3.9,8)).toEqual({jobs:1,threads:1});
        expect(localInferenceLimits(7.9,8)).toEqual({jobs:1,threads:2});
    });

    it('COI 必须严格为 true，具备共享内存的小设备仍只用一条 WASM 线程',async()=>{
        vi.resetModules();
        const resources=await import('@/src/shared/onnx/resources');
        vi.stubGlobal('navigator',{hardwareConcurrency:8,deviceMemory:8});
        vi.stubGlobal('SharedArrayBuffer',class {});
        for(const isolated of [undefined,false,1,'true']){
            vi.stubGlobal('crossOriginIsolated',isolated);
            expect(resources.localWasmThreads()).toBe(1);
        }
        vi.stubGlobal('crossOriginIsolated',true);
        vi.stubGlobal('SharedArrayBuffer',undefined);
        expect(resources.localWasmThreads()).toBe(1);
        vi.stubGlobal('SharedArrayBuffer',class {});
        vi.stubGlobal('navigator',{hardwareConcurrency:2});
        expect(resources.localWasmThreads()).toBe(1);
        vi.stubGlobal('navigator',{hardwareConcurrency:8});
        expect(resources.localWasmThreads()).toBe(2);
        resources.forceSingleThreadInference();
        resources.forceSingleThreadInference();
        expect(resources.localWasmThreads()).toBe(1);
    });

    it('取消中间的排队请求保留 FIFO，已开始的请求移除取消监听器',async()=>{
        const run=createLocalInferenceBudget(1),busy=deferred(),started:string[]=[];
        const active=run(()=>busy.promise);
        const firstSignal=new AbortController(),cancelledSignal=new AbortController(),lastSignal=new AbortController();
        const removed=vi.spyOn(firstSignal.signal,'removeEventListener');
        const added=vi.spyOn(firstSignal.signal,'addEventListener');
        const first=run(async()=>{started.push('first');return 1;},firstSignal.signal);
        const skipped=vi.fn(async()=>2),cancelled=run(skipped,cancelledSignal.signal);
        const rejected=expect(cancelled).rejects.toMatchObject({name:'AbortError'});
        const last=run(async()=>{started.push('last');return 3;},lastSignal.signal);
        cancelledSignal.abort();await rejected;
        expect(started).toEqual([]);expect(skipped).not.toHaveBeenCalled();
        expect(added).toHaveBeenCalledWith('abort',expect.any(Function),{once:true});
        busy.resolve();await active;
        expect(await first).toBe(1);expect(await last).toBe(3);
        expect(started).toEqual(['first','last']);
        expect(removed).toHaveBeenCalledWith('abort',added.mock.calls[0][1]);
        firstSignal.abort();lastSignal.abort();
        expect(await run(async()=>4)).toBe(4);
    });

    it('取得槽位但尚未执行的取消竞态释放预算，并启动下一项',async()=>{
        const run=createLocalInferenceBudget(1),busy=deferred(),active=run(()=>busy.promise);
        const controller=new AbortController(),operation=vi.fn(async()=>1);
        const removed=vi.spyOn(controller.signal,'removeEventListener');
        const racing=run(operation,controller.signal);
        const cancelled=expect(racing).rejects.toMatchObject({name:'AbortError'});
        const nextOperation=vi.fn(async()=>2),next=run(nextOperation);
        busy.resolve();
        // active 的 finally 已交出槽位；queued 的 await 续体仍在当前微任务之后。
        await busy.promise;
        expect(removed).toHaveBeenCalledWith('abort',expect.any(Function));
        controller.abort();await active;await cancelled;
        expect(operation).not.toHaveBeenCalled();expect(await next).toBe(2);
        expect(nextOperation).toHaveBeenCalledOnce();
    });

    it('运行中 abort 不提前交出槽位，原操作失败后才让排队任务继续',async()=>{
        const run=createLocalInferenceBudget(1),busy=deferred(),controller=new AbortController();
        const failure=new Error('native inference failed');
        const active=run(async()=>{await busy.promise;throw failure;},controller.signal);
        const rejected=expect(active).rejects.toBe(failure);
        const operation=vi.fn(async()=>2),next=run(operation);
        controller.abort();await Promise.resolve();
        expect(operation).not.toHaveBeenCalled();
        busy.resolve();await rejected;
        expect(await next).toBe(2);expect(operation).toHaveBeenCalledOnce();
        await expect(run(()=>{throw failure;})).rejects.toBe(failure);
        expect(await run(async()=>3)).toBe(3);
    });

    it('共享默认预算按设备限制两个并行任务，第三项等待真实完成',async()=>{
        vi.stubGlobal('navigator',{hardwareConcurrency:8,deviceMemory:8});
        vi.resetModules();
        const {withLocalInferenceBudget}=await import('@/src/shared/onnx/resources');
        const a=deferred(),b=deferred(),started:string[]=[];
        const first=withLocalInferenceBudget(async()=>{started.push('a');await a.promise;return 1;});
        const second=withLocalInferenceBudget(async()=>{started.push('b');await b.promise;return 2;});
        const third=withLocalInferenceBudget(async()=>{started.push('c');return 3;});
        expect(started).toEqual(['a','b']);a.resolve();
        expect(await first).toBe(1);expect(await third).toBe(3);
        expect(started).toEqual(['a','b','c']);b.resolve();expect(await second).toBe(2);
    });

    it.each(['factory','shared'] as const)('%s pacer 默认使用 performance.now 与 setTimeout，失败后也保留 70%% 计算时间预算',async kind=>{
        vi.useFakeTimers();
        let time=0;
        const now=vi.spyOn(performance,'now').mockImplementation(()=>time);
        const timeout=vi.spyOn(globalThis,'setTimeout');
        vi.resetModules();
        const resources=await import('@/src/shared/onnx/resources');
        const pace=kind==='factory'?resources.createInferencePacer():resources.paceLocalInference;
        const failure=new Error('operator failed'),starts:number[]=[];
        await expect(pace(async()=>{starts.push(time);time+=70;throw failure;})).rejects.toBe(failure);
        const operation=vi.fn(async()=>{starts.push(time);time+=35;return 2;}),next=pace(operation);
        await Promise.resolve();
        expect(timeout).toHaveBeenCalledWith(expect.any(Function),30);
        await vi.advanceTimersByTimeAsync(29);expect(operation).not.toHaveBeenCalled();
        time=100;await vi.advanceTimersByTimeAsync(1);
        expect(await next).toBe(2);
        const thirdOperation=vi.fn(async()=>{starts.push(time);return 3;}),third=pace(thirdOperation);
        await Promise.resolve();
        expect(timeout).toHaveBeenLastCalledWith(expect.any(Function),15);
        await vi.advanceTimersByTimeAsync(14);expect(thirdOperation).not.toHaveBeenCalled();
        time=150;await vi.advanceTimersByTimeAsync(1);
        expect(await third).toBe(3);expect(now).toHaveBeenCalled();
        expect(starts).toEqual([0,100,150]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('pacer 串行排队，外部空闲已偿还计算间歇时不额外等待',async()=>{
        let time=0;
        const busy=deferred(),sleep=vi.fn(async(ms:number)=>{time+=ms;});
        const pace=createInferencePacer(()=>time,sleep);
        const first=pace(async()=>{await busy.promise;time+=70;return 1;});
        const operation=vi.fn(async()=>2),second=pace(operation);
        await Promise.resolve();expect(operation).not.toHaveBeenCalled();
        busy.resolve();expect(await first).toBe(1);expect(await second).toBe(2);
        expect(sleep.mock.calls).toEqual([[30]]);
        time+=100;expect(await pace(async()=>3)).toBe(3);
        expect(sleep).toHaveBeenCalledOnce();
    });

    it('休眠失败不会毒化 pacer 队列，重试仍须偿还尚未经过的间歇',async()=>{
        let time=0;
        const failure=new Error('sleep interrupted');
        const sleep=vi.fn(async(ms:number)=>{time+=ms;}).mockRejectedValueOnce(failure);
        const pace=createInferencePacer(()=>time,sleep);
        await pace(async()=>{time+=70;});
        const operation=vi.fn(async()=>2);
        await expect(pace(operation)).rejects.toBe(failure);expect(operation).not.toHaveBeenCalled();
        expect(await pace(operation)).toBe(2);
        expect(sleep.mock.calls).toEqual([[30],[30]]);expect(operation).toHaveBeenCalledOnce();
    });

    it('pacer 封顶长推理间歇，并支持 WebGPU 路径跳过人工休眠与自定义上限',async()=>{
        let time=0;
        const sleep=vi.fn(async(ms:number)=>{time+=ms;});
        const pace=createInferencePacer(()=>time,sleep);
        await pace(async()=>{time+=7_000;});
        await pace(async()=>{time+=7_000;},{maxRestMs:500});
        await pace(async()=>{time+=70;});
        await pace(async()=>{time+=7_000;},{skipRest:true});
        await pace(async()=>{time+=70;},{skipRest:true});
        expect(sleep.mock.calls).toEqual([[1_500],[500]]);
    });

    it('WebGPU 探测拦截低于显存或工作组下限的适配器，满足阈值或缺少 limits 字段时正常通过',async()=>{
        const safeLimits={
            maxStorageBufferBindingSize:128*1024*1024,
            maxBufferSize:256*1024*1024,
            maxComputeWorkgroupStorageSize:16_384,
        };
        vi.stubGlobal('navigator',{gpu:{requestAdapter:async()=>({info:{vendor:'apple'},limits:safeLimits})}});
        await expect(probeWebGpu()).resolves.toEqual({available:true,info:'apple'});

        for(const limits of [
            {...safeLimits,maxStorageBufferBindingSize:128*1024*1024-1},
            {...safeLimits,maxBufferSize:256*1024*1024-1},
            {...safeLimits,maxComputeWorkgroupStorageSize:16_383},
        ]){
            vi.stubGlobal('navigator',{gpu:{requestAdapter:async()=>({info:{vendor:'low-vram'},limits})}});
            await expect(probeWebGpu()).resolves.toEqual({available:false,info:''});
        }
    });
});

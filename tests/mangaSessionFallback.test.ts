import {describe,expect,it,vi} from 'vitest';
import type {InferenceSession} from 'onnxruntime-web';
import {protectMangaSession} from '@/src/features/image-translation/services/mangaSessionFallback';
function session(){return {run:vi.fn(async(..._args:unknown[])=>({output:'pixels'})),release:vi.fn(async()=>{})};}
describe('漫画模型 GPU 推理回退',()=>{
    it('健康 GPU 沿用输入输出，不创建 CPU；销毁只释放一次',async()=>{
        const gpu=session(),run=gpu.run,release=gpu.release,create=vi.fn();
        const check=protectMangaSession(gpu as unknown as InferenceSession,create,()=>undefined);
        const input={x:'tensor'};expect(await gpu.run(input as never)).toEqual({output:'pixels'});expect(run).toHaveBeenCalledWith(input);expect(create).not.toHaveBeenCalled();expect(check).not.toThrow();
        await gpu.release();await gpu.release();expect(release).toHaveBeenCalledOnce();
    });
    it('GPU 失效后同一张量只重试一次，随后直接复用 CPU 并正确释放',async()=>{
        const gpu=session(),cpu=session(),run=gpu.run,release=gpu.release,create=vi.fn(async()=>cpu as unknown as InferenceSession);
        run.mockRejectedValueOnce(new Error('GPU lost'));release.mockRejectedValueOnce(new Error('device gone'));
        protectMangaSession(gpu as unknown as InferenceSession,create,()=>undefined);
        const input={x:'same tensor'};expect(await gpu.run(input as never)).toEqual({output:'pixels'});expect(cpu.run).toHaveBeenCalledWith(input);
        await gpu.run(input as never);expect(run).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledOnce();
        await gpu.release();await gpu.release();expect(cpu.release).toHaveBeenCalledOnce();expect(release).toHaveBeenCalledOnce();
    });
    it('CPU 创建或重试失败不会循环创建，取消不重试',async()=>{
        const gpu=session(),run=gpu.run,create=vi.fn().mockRejectedValue(new Error('CPU create'));
        run.mockRejectedValue(new Error('GPU'));const check=protectMangaSession(gpu as unknown as InferenceSession,create,()=>undefined);
        await expect(gpu.run()).rejects.toThrow('CPU create');expect(check).toThrow('CPU create');expect(check).not.toThrow();await expect(gpu.run()).rejects.toThrow('GPU');expect(create).toHaveBeenCalledOnce();await gpu.release();
        const broken=session(),cpu=session();broken.run.mockRejectedValue(new Error('GPU'));cpu.run.mockRejectedValue(new Error('CPU inference'));cpu.release.mockRejectedValue(new Error('CPU release'));
        const cpuCreate=vi.fn(async()=>cpu as unknown as InferenceSession);protectMangaSession(broken as unknown as InferenceSession,cpuCreate,()=>undefined);
        await expect(broken.run()).rejects.toThrow('CPU inference');await expect(broken.run()).rejects.toThrow('CPU inference');expect(cpuCreate).toHaveBeenCalledOnce();await expect(broken.release()).rejects.toThrow('CPU release');
        const stopped=session(),controller=new AbortController();controller.abort();stopped.run.mockRejectedValue(new Error('cancelled'));const unnecessary=vi.fn();
        protectMangaSession(stopped as unknown as InferenceSession,unnecessary,()=>controller.signal);await expect(stopped.run()).rejects.toThrow('cancelled');expect(unnecessary).not.toHaveBeenCalled();await stopped.release();
    });
    it('释放失效 GPU 后若 CPU 创建失败或中止，调用 onBroken 通知上层重建',async()=>{
        const gpu=session(),controller=new AbortController(),onBroken=vi.fn();
        gpu.run.mockRejectedValueOnce(new Error('GPU lost'));
        const createCpu=vi.fn(async()=>{controller.abort();throw new DOMException('已取消','AbortError');});
        protectMangaSession(gpu as unknown as InferenceSession,createCpu,()=>controller.signal,onBroken);
        await expect(gpu.run()).rejects.toMatchObject({name:'AbortError'});
        expect(onBroken).toHaveBeenCalledOnce();
        // 健康回退不触发 onBroken。
        const okGpu=session(),okCpu=session(),okBroken=vi.fn();
        okGpu.run.mockRejectedValueOnce(new Error('GPU lost'));
        protectMangaSession(okGpu as unknown as InferenceSession,async()=>okCpu as unknown as InferenceSession,()=>undefined,okBroken);
        await expect(okGpu.run()).resolves.toEqual({output:'pixels'});
        expect(okBroken).not.toHaveBeenCalled();
    });
});

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MANGA_INPAINT_ASSET, MANGA_OCR_ASSETS, MANGA_OCR_CACHE, MANGA_OCR_MODEL_BYTES,MANGA_TEXT_SEGMENTATION_ASSET,
    assertMangaOcrActive, loadMangaInpaintAsset, loadMangaOcrAssets, mangaOcrModelStatus, removeMangaOcrAssets, importMangaModel,loadMangaTextSegmentationAsset,withMangaModelAdmission,withMangaModelRemoval} from '@/src/features/image-translation/services/mangaOcrAssets';
import {createVirtualModelResponsePort, virtualModelBuffer} from './helpers/virtualModelResponse';
// 资源生命周期使用显式虚拟容量，不伪装为真实 ONNX；实际 wire 与固定配方由独立测试及外部字节 replay 验证。
const shapes=vi.hoisted(()=>({optimize:vi.fn()}));
vi.mock('@/src/features/image-translation/services/mangaRecognitionShapes',()=>({optimizeVerifiedMangaRecognition:shapes.optimize}));
const allAssets=[...MANGA_OCR_ASSETS,MANGA_INPAINT_ASSET,MANGA_TEXT_SEGMENTATION_ASSET];
const NativeResponse=globalThis.Response;
// 虚拟容量与受控 digest 只验证容量、状态和缓存契约；标记 Response 端口不声称原生大模型复制，真实内容和完整 SHA-256 留给浏览器专项。
const buffer=virtualModelBuffer;
function response(bytes:number,status=200) {return {ok:status===200,status,arrayBuffer:vi.fn(async()=>buffer(bytes))} as unknown as Response;}
function digest(bytes:number) {const asset=allAssets.find(asset=>asset.bytes===bytes)!;return Uint8Array.from(asset.sha256.match(/../g)!,part=>parseInt(part,16)).buffer;}
function deferred<T>() {let resolve!: (value:T) => void, reject!: (error:Error) => void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
let preferences:{match:ReturnType<typeof vi.fn>;put:ReturnType<typeof vi.fn>};
let cache:{match:ReturnType<typeof vi.fn>;put:ReturnType<typeof vi.fn>;delete:ReturnType<typeof vi.fn>};
beforeEach(async()=>{
    shapes.optimize.mockReset().mockImplementation((buffer:ArrayBuffer)=>buffer);
    vi.stubGlobal('Response',createVirtualModelResponsePort(NativeResponse));
    preferences={match:vi.fn(async()=>undefined),put:vi.fn(async()=>{})};
    cache={match:vi.fn(async()=>undefined),put:vi.fn(async()=>{}),delete:vi.fn(async()=>true)};
    vi.stubGlobal('caches',{open:vi.fn(async(name:string)=>name===MANGA_OCR_CACHE?cache:preferences),delete:vi.fn(async()=>true)});
    vi.stubGlobal('crypto',{subtle:{digest:vi.fn(async(_method:string,b:ArrayBuffer)=>digest(b.byteLength))}});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>response(allAssets.find(a=>url.endsWith('path' in a?a.path:'lama-manga-dynamic.onnx'))!.bytes)));
    await removeMangaOcrAssets();vi.mocked(caches.delete).mockClear();
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('漫画模型固定版本和完整性',()=>{
    it('原文件全部校验和缓存完成后才生成会话副本，状态与离线原文件保持源版本',async()=>{
        const derived=new ArrayBuffer(5),abort=new AbortController();
        shapes.optimize.mockImplementation((original,asset,signal)=>{
            expect(original.byteLength).toBe(MANGA_OCR_ASSETS[1].bytes);expect(asset).toBe(MANGA_OCR_ASSETS[1]);expect(signal).toBe(abort.signal);
            expect(crypto.subtle.digest).toHaveBeenCalledTimes(3);expect(cache.put).toHaveBeenCalledTimes(3);return derived;
        });
        expect((await loadMangaOcrAssets(abort.signal)).recognition).toBe(derived);expect(shapes.optimize).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledTimes(3);expect(cache.delete).not.toHaveBeenCalled();
        const cachedRecognition=cache.put.mock.calls.find(([url])=>url.endsWith(MANGA_OCR_ASSETS[1].path))![1] as Response;
        expect((await cachedRecognition.arrayBuffer()).byteLength).toBe(MANGA_OCR_ASSETS[1].bytes);
    });
    it.each(['download','cache'])('形状配方失败不会把有效%s原文件当损坏重下或删除',async source=>{
        if(source==='cache')cache.match.mockImplementation(async(url:string)=>response(MANGA_OCR_ASSETS.find(a=>url.endsWith(a.path))!.bytes));
        const failure=new Error('shape recipe mismatch');shapes.optimize.mockImplementationOnce(()=>{throw failure;});
        await expect(loadMangaOcrAssets()).rejects.toBe(failure);expect(cache.delete).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(source==='cache'?0:3);expect(cache.put).toHaveBeenCalledTimes(source==='cache'?0:3);
    });
    it.each(['ocr','inpaint'] as const)('缓存 match 迟到时 %s 释放未读正文，不复制、摘要、删缓存或请求网络',async kind=>{
        const abort=new AbortController(),entered=deferred<void>(),matched=deferred<Response>(),cancel=vi.fn(async()=>{});
        const cached=new NativeResponse(new ReadableStream({cancel}));
        const read=vi.spyOn(cached,'arrayBuffer').mockResolvedValue(buffer(kind==='ocr'?MANGA_OCR_ASSETS[0].bytes:MANGA_INPAINT_ASSET.bytes));
        cache.match.mockImplementationOnce(()=>{entered.resolve();return matched.promise;});
        const task=kind==='ocr'?loadMangaOcrAssets(abort.signal):loadMangaInpaintAsset(abort.signal);
        const check=expect(task).rejects.toMatchObject({name:'AbortError'});
        await entered.promise;abort.abort();matched.resolve(cached);await check;
        expect(cancel).toHaveBeenCalledOnce();expect(read).not.toHaveBeenCalled();
        expect(crypto.subtle.digest).not.toHaveBeenCalled();expect(cache.delete).not.toHaveBeenCalled();
        expect(cache.put).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['ocr','inpaint'] as const)('缓存正文复制结束后取消的 %s 不再启动摘要或删除有效缓存',async kind=>{
        const abort=new AbortController(),asset=kind==='ocr'?MANGA_OCR_ASSETS[0]:MANGA_INPAINT_ASSET,cached=response(asset.bytes);
        vi.mocked(cached.arrayBuffer).mockImplementationOnce(async()=>{abort.abort();return buffer(asset.bytes);});
        cache.match.mockResolvedValueOnce(cached);
        await expect(kind==='ocr'?loadMangaOcrAssets(abort.signal):loadMangaInpaintAsset(abort.signal)).rejects.toMatchObject({name:'AbortError'});
        expect(crypto.subtle.digest).not.toHaveBeenCalled();expect(cache.delete).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();expect(cache.put).not.toHaveBeenCalled();
    });

    it.each(['ocr','inpaint'] as const)('原生摘要在 %s 取消后拒绝也不误删缓存',async kind=>{
        const abort=new AbortController(),entered=deferred<void>(),hashed=deferred<ArrayBuffer>();
        cache.match.mockResolvedValueOnce(response(kind==='ocr'?MANGA_OCR_ASSETS[0].bytes:MANGA_INPAINT_ASSET.bytes));
        vi.mocked(crypto.subtle.digest).mockImplementationOnce(()=>{entered.resolve();return hashed.promise;});
        const task=kind==='ocr'?loadMangaOcrAssets(abort.signal):loadMangaInpaintAsset(abort.signal);
        const check=expect(task).rejects.toMatchObject({name:'AbortError'});
        await entered.promise;abort.abort();hashed.reject(new Error('late native digest failure'));await check;
        expect(cache.delete).not.toHaveBeenCalled();expect(cache.put).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['ocr','inpaint'] as const)('等待打开缓存时 %s 取消不继续匹配文件',async kind=>{
        const abort=new AbortController(),entered=deferred<void>(),opened=deferred<Cache>();
        vi.mocked(caches.open).mockImplementationOnce(()=>{entered.resolve();return opened.promise;});
        const task=kind==='ocr'?loadMangaOcrAssets(abort.signal):loadMangaInpaintAsset(abort.signal);
        const check=expect(task).rejects.toMatchObject({name:'AbortError'});
        await entered.promise;abort.abort();opened.resolve(cache as unknown as Cache);await check;
        expect(cache.match).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['network','cache'])('释放 %s 拒绝正文，未结束取消不阻塞自动恢复',async stage=>{
        let rejectCancel!:(reason:unknown)=>void;
        const cancel=vi.fn(()=>new Promise<void>((_resolve,reject)=>{rejectCancel=reject;}));
        const rejected=new NativeResponse(new ReadableStream({cancel}),{status:503});
        if(stage==='network') vi.mocked(fetch).mockResolvedValueOnce(rejected);
        else cache.match.mockResolvedValueOnce(rejected);
        await loadMangaOcrAssets();
        expect(cancel).toHaveBeenCalledOnce();expect(rejected.body?.locked).toBe(false);
        expect(cache.put).toHaveBeenCalledTimes(3);
        rejectCancel(new Error('late cleanup failure'));await Promise.resolve();
    });

    it('仅显式虚拟容量绕过原生复制，普通字节和流保真，未标记的伪容量仍被拒绝',async()=>{
        const plain=new Response('public source');
        expect(await plain.clone().text()).toBe('public source');expect(plain.bodyUsed).toBe(false);
        expect(await plain.text()).toBe('public source');expect(plain.bodyUsed).toBe(true);
        const bytes=new Uint8Array([0,255,3]);
        expect(new Uint8Array(await new Response(bytes).arrayBuffer())).toEqual(bytes);
        expect(new Uint8Array(await new Response(bytes.buffer).arrayBuffer())).toEqual(bytes);
        const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});
        expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
        const virtual=buffer(MANGA_INPAINT_ASSET.bytes),held=await new Response(virtual).arrayBuffer();
        expect(held).toBe(virtual);expect(held.byteLength).toBe(MANGA_INPAINT_ASSET.bytes);
        expect(new Uint8Array(held)).toHaveLength(1);
        const unmarked=new ArrayBuffer(1);Object.defineProperty(unmarked,'byteLength',{value:MANGA_OCR_ASSETS[0].bytes});
        expect(()=>new Response(unmarked)).toThrow(RangeError);
    });
    it('历史来源设置不影响自动下载，损坏来源仍校验失败后回退',async()=>{
        vi.stubGlobal('navigator',{language:'en-US'});
        preferences.match.mockImplementation(async()=>new Response('mirror'));
        vi.mocked(fetch).mockResolvedValueOnce(response(1));await loadMangaOcrAssets();
        expect(vi.mocked(fetch).mock.calls[0][0]).toContain('huggingface.co');expect(vi.mocked(fetch).mock.calls[1][0]).toContain('hf-mirror.com');
        expect(await mangaOcrModelStatus()).toMatchObject({source:'auto'});
        preferences.match.mockImplementation(async()=>new Response('official'));
        vi.stubGlobal('navigator',{language:'zh-CN'});vi.mocked(fetch).mockClear();await loadMangaInpaintAsset();
        expect(vi.mocked(fetch).mock.calls[0][0]).toContain('hf-mirror.com');expect(await mangaOcrModelStatus()).toMatchObject({source:'auto'});
    });
    it('20 秒无数据会切换备用来源，用户取消则立即结束且不切换',async()=>{
        vi.useFakeTimers();vi.mocked(fetch).mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>reject(new Error('timeout')))));
        const pending=loadMangaInpaintAsset();await vi.advanceTimersByTimeAsync(20_001);await pending;
        expect(fetch).toHaveBeenCalledTimes(2);expect(vi.mocked(fetch).mock.calls[1][0]).toContain('hf-mirror.com');
        cache.match.mockResolvedValue(undefined);const abort=new AbortController();
        vi.mocked(fetch).mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>reject('cancel'))));
        const cancelled=loadMangaInpaintAsset(abort.signal);const check=expect(cancelled).rejects.toMatchObject({name:'AbortError'});
        await vi.advanceTimersByTimeAsync(1);abort.abort();await check;expect(fetch).toHaveBeenCalledTimes(3);
        expect((await mangaOcrModelStatus()).download?.phase).toBe('paused');
        cache.match.mockResolvedValue(response(1));expect((await mangaOcrModelStatus()).download).toBeUndefined();
    });
    it('流式接收显示真实字节、校验后完成，过量和截断数据进入备用来源',async()=>{
        const bytes=MANGA_OCR_ASSETS[0].bytes,progress=vi.fn();
        const read=vi.fn().mockResolvedValueOnce({done:false,value:new Uint8Array(bytes)}).mockResolvedValueOnce({done:true});
        const reader={read,cancel:vi.fn(async()=>{}),releaseLock:vi.fn()};
        vi.mocked(fetch).mockResolvedValueOnce({ok:true,body:{getReader:()=>reader}} as never);
        await loadMangaOcrAssets(undefined,progress);expect(progress.mock.calls.length).toBeGreaterThanOrEqual(3);expect(new Set(progress.mock.calls.map(call=>call[0])).size).toBe(progress.mock.calls.length);expect(reader.cancel).toHaveBeenCalled();
        for(const size of [bytes+1,1]){
            const read=vi.fn().mockResolvedValueOnce({done:false,value:new Uint8Array(size)}).mockResolvedValueOnce({done:true});
            vi.mocked(fetch).mockResolvedValueOnce({ok:true,body:{getReader:()=>({read,cancel:async()=>{},releaseLock(){}})}} as never);
            await loadMangaOcrAssets();
        }
        expect((await mangaOcrModelStatus()).download).toBeUndefined();
    });
    it('离线导入只接受指定文件名、容量和完整哈希，原字典与修补模型均可导入',async()=>{
        const file=(name:string,bytes:number)=>({name,size:bytes,arrayBuffer:async()=>buffer(bytes)}) as File;
        await expect(importMangaModel(file('wrong.onnx',1))).rejects.toThrow('配套');
        await expect(importMangaModel(file('PP-OCRv6_small_det.onnx',1))).rejects.toThrow('配套');
        await importMangaModel(file('ppocrv6_dict.txt',MANGA_OCR_ASSETS[2].bytes));
        await importMangaModel(file('lama-manga-dynamic.onnx',MANGA_INPAINT_ASSET.bytes));expect(cache.put).toHaveBeenCalledTimes(2);expect(fetch).not.toHaveBeenCalled();
        vi.mocked(crypto.subtle.digest).mockResolvedValueOnce(new ArrayBuffer(32));
        await expect(importMangaModel(file('PP-OCRv6_small_det.onnx',MANGA_OCR_ASSETS[0].bytes))).rejects.toThrow('校验失败');expect(cache.put).toHaveBeenCalledTimes(2);
    });
    it('下载固定来源、校验哈希和尺寸、按文件报告进度，不上传图像',async()=>{
        const progress=vi.fn(),abort=new AbortController();const model=await loadMangaOcrAssets(abort.signal,progress);
        expect(Object.keys(model)).toEqual(['detection','recognition','charactersDictionary']);expect(caches.open).toHaveBeenCalledWith(MANGA_OCR_CACHE);
        expect(fetch).toHaveBeenCalledTimes(3);expect(cache.put).toHaveBeenCalledTimes(3);expect(progress.mock.calls.map(c=>c[0])).toEqual([31,99,100]);
        for(const [url,options] of vi.mocked(fetch).mock.calls) {expect(url).toContain('/resolve/bf1d5edb0335d3262be7caf13f766ba274b4cadd/');expect(options).toEqual({signal:expect.any(AbortSignal),credentials:'omit',referrerPolicy:'no-referrer'});}
    });
    it('完整缓存不请求网络，取消后的任务不继续读取后续文件',async()=>{
        cache.match.mockImplementation(async(url:string)=>response(MANGA_OCR_ASSETS.find(a=>url.endsWith(a.path))!.bytes));
        await loadMangaOcrAssets();expect(fetch).not.toHaveBeenCalled();expect(cache.put).not.toHaveBeenCalled();
        const abort=new AbortController();await expect(loadMangaOcrAssets(abort.signal,()=>abort.abort())).rejects.toMatchObject({name:'AbortError'});
    });
    it('损坏缓存被删除并重新下载，不保留坏模型',async()=>{
        cache.match.mockResolvedValueOnce(response(1,503));await loadMangaOcrAssets();expect(cache.delete).toHaveBeenCalledOnce();cache.delete.mockClear();
        cache.match.mockResolvedValueOnce(response(1));await loadMangaOcrAssets();expect(cache.delete).toHaveBeenCalledOnce();
        vi.mocked(fetch).mockResolvedValue(response(1));await expect(loadMangaOcrAssets()).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringContaining('不完整')})});
        cache.match.mockResolvedValueOnce(undefined).mockResolvedValueOnce(response(1));expect((await mangaOcrModelStatus()).download?.phase).toBe('error');
        cache.match.mockResolvedValue(response(1));expect((await mangaOcrModelStatus()).download).toBeUndefined();
    });
    it('所有来源的 HTTP 错误、哈希不符和读取失败都报告且不写入缓存',async()=>{
        vi.mocked(fetch).mockResolvedValue(response(1,503));await expect(loadMangaOcrAssets()).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringContaining('(503)')})});
        vi.mocked(fetch).mockResolvedValue(response(MANGA_OCR_ASSETS[0].bytes));
        vi.mocked(crypto.subtle.digest).mockResolvedValue(new ArrayBuffer(32));await expect(loadMangaOcrAssets()).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringContaining('校验失败')})});
        const bad=response(MANGA_OCR_ASSETS[0].bytes);vi.mocked(bad.arrayBuffer).mockRejectedValue(new Error('connection closed'));
        vi.mocked(fetch).mockResolvedValue(bad);await expect(loadMangaOcrAssets()).rejects.toMatchObject({cause:expect.objectContaining({message:'connection closed'})});expect(cache.put).not.toHaveBeenCalled();
    });
    it('非 Error 失败仍结束下载并报告可重试状态，取消清理失败不成为未处理异常',async()=>{
        vi.mocked(fetch).mockRejectedValue('network');await expect(loadMangaInpaintAsset()).rejects.toThrow('未完成');
        vi.mocked(fetch).mockResolvedValueOnce({ok:true,body:{getReader:()=>({read:async()=>({done:true}),cancel:async()=>{throw new Error('already closed')},releaseLock(){}})}} as never)
            .mockResolvedValueOnce(response(MANGA_INPAINT_ASSET.bytes));await loadMangaInpaintAsset();
        const file={name:'PP-OCRv6_small_det.onnx',size:MANGA_OCR_ASSETS[0].bytes,arrayBuffer:async()=>buffer(MANGA_OCR_ASSETS[0].bytes)} as File;
        await importMangaModel(file);expect(cache.put).toHaveBeenCalled();
    });
    it('下载完成但取消的结果不会入库，预取消不接触缓存',async()=>{
        const abort=new AbortController();vi.mocked(fetch).mockImplementationOnce(async()=>{abort.abort();return response(MANGA_OCR_ASSETS[0].bytes)});
        await expect(loadMangaOcrAssets(abort.signal)).rejects.toMatchObject({name:'AbortError'});expect(cache.put).not.toHaveBeenCalled();
        const before=vi.mocked(caches.open).mock.calls.length;await expect(loadMangaOcrAssets(abort.signal)).rejects.toMatchObject({name:'AbortError'});expect(caches.open).toHaveBeenCalledTimes(before);
        expect(()=>assertMangaOcrActive()).not.toThrow();
    });
    it('资源状态区分未下载、识别就绪和精细修补就绪，清除只删除本功能缓存',async()=>{
        expect(await mangaOcrModelStatus()).toEqual({ready:false,bytes:0,inpaintingReady:false,segmentationReady:false,source:'auto'});
        cache.match.mockImplementation(async(url:string)=>MANGA_OCR_ASSETS.some(asset=>url.endsWith(asset.path))?response(1):undefined);
        expect(await mangaOcrModelStatus()).toEqual({ready:true,bytes:MANGA_OCR_MODEL_BYTES,inpaintingReady:false,segmentationReady:false,source:'auto'});
        cache.match.mockResolvedValue(response(1));expect(await mangaOcrModelStatus()).toEqual({ready:true,bytes:MANGA_OCR_MODEL_BYTES+MANGA_INPAINT_ASSET.bytes+MANGA_TEXT_SEGMENTATION_ASSET.bytes,inpaintingReady:true,segmentationReady:true,source:'auto'});
        await removeMangaOcrAssets();expect(caches.delete).toHaveBeenCalledWith(MANGA_OCR_CACHE);
    });
    it('LaMa 同样按固定版本校验并复用缓存，损坏文件重新准备',async()=>{
        await loadMangaInpaintAsset();expect(fetch).toHaveBeenCalledWith(MANGA_INPAINT_ASSET.url,{signal:expect.any(AbortSignal),credentials:'omit',referrerPolicy:'no-referrer'});
        cache.match.mockResolvedValue(response(MANGA_INPAINT_ASSET.bytes));await loadMangaInpaintAsset();expect(fetch).toHaveBeenCalledOnce();
        cache.match.mockResolvedValueOnce(response(1));await loadMangaInpaintAsset();expect(cache.delete).toHaveBeenCalledWith(MANGA_INPAINT_ASSET.url);
    });
    it('LaMa 下载和缓存验证阶段取消均不写入新结果',async()=>{
        const abort=new AbortController();vi.mocked(fetch).mockImplementationOnce(async()=>{abort.abort();return response(MANGA_INPAINT_ASSET.bytes)});
        await expect(loadMangaInpaintAsset(abort.signal)).rejects.toMatchObject({name:'AbortError'});expect(cache.put).not.toHaveBeenCalled();
        const cacheAbort=new AbortController();const cached=response(MANGA_INPAINT_ASSET.bytes);vi.mocked(cached.arrayBuffer).mockImplementationOnce(async()=>{cacheAbort.abort();return buffer(MANGA_INPAINT_ASSET.bytes)});cache.match.mockResolvedValueOnce(cached);
        await expect(loadMangaInpaintAsset(cacheAbort.signal)).rejects.toMatchObject({name:'AbortError'});expect(cache.delete).not.toHaveBeenCalled();
    });
});

describe('可选离线 CTD 模型',()=>{
    it('共用删除边界，重复删除复用同promise，失败删除后仍允许cached-only准备',async()=>{
        const gate=deferred<void>(),remove=vi.fn(()=>gate.promise),duplicate=vi.fn(async()=>{});
        const removal=withMangaModelRemoval(remove);expect(withMangaModelRemoval(duplicate)).toBe(removal);
        const queued=withMangaModelAdmission(()=>loadMangaTextSegmentationAsset());
        await Promise.resolve();expect(cache.match).not.toHaveBeenCalled();expect(duplicate).not.toHaveBeenCalled();
        gate.resolve();await removal;await expect(queued).resolves.toBeUndefined();expect(remove).toHaveBeenCalledOnce();
        const failure=new Error('delete failure'),bad=withMangaModelRemoval(async()=>{throw failure;});
        const after=withMangaModelAdmission(()=>loadMangaTextSegmentationAsset());await expect(bad).rejects.toBe(failure);await after;
        expect(cache.match).toHaveBeenCalledTimes(2);expect(fetch).not.toHaveBeenCalled();
    });
    it('导入CTD不清除无关下载失败，匹配原文件导入仍清除原状态',async()=>{
        vi.mocked(fetch).mockRejectedValue(new Error('offline'));await expect(loadMangaInpaintAsset()).rejects.toThrow('未完成');
        const file=(name:string,bytes:number)=>({name,size:bytes,arrayBuffer:async()=>buffer(bytes)} as File);
        await importMangaModel(file(MANGA_TEXT_SEGMENTATION_ASSET.file,MANGA_TEXT_SEGMENTATION_ASSET.bytes));
        expect((await mangaOcrModelStatus()).download?.phase).toBe('error');
        await importMangaModel(file('lama-manga-dynamic.onnx',MANGA_INPAINT_ASSET.bytes));
        expect((await mangaOcrModelStatus()).download).toBeUndefined();
    });
    it('摘要迟到拒绝不能覆盖先发生的取消，也不删除已导入原文件',async()=>{
        const abort=new AbortController(),entered=deferred<void>(),hash=deferred<ArrayBuffer>();
        cache.match.mockResolvedValue(response(MANGA_TEXT_SEGMENTATION_ASSET.bytes));
        vi.mocked(crypto.subtle.digest).mockImplementationOnce(()=>{entered.resolve();return hash.promise;});
        const pending=loadMangaTextSegmentationAsset(abort.signal),check=expect(pending).rejects.toMatchObject({name:'AbortError'});
        await entered.promise;abort.abort();hash.reject(new Error('late digest failure'));await check;
        expect(cache.delete).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });
    it('缺失明确不可用，不改变原三件就绪或请求网络/删除缓存',async()=>{
        expect(MANGA_OCR_ASSETS).toHaveLength(3);
        expect(MANGA_TEXT_SEGMENTATION_ASSET).toMatchObject({file:'comictextdetector.pt.onnx',bytes:94669756,sha256:'1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f'});
        await expect(loadMangaTextSegmentationAsset()).resolves.toBeUndefined();
        expect(cache.match).toHaveBeenCalledWith(MANGA_TEXT_SEGMENTATION_ASSET.url);
        expect(fetch).not.toHaveBeenCalled();expect(cache.delete).not.toHaveBeenCalled();expect(cache.put).not.toHaveBeenCalled();
    });
    it('离线导入遵守同一容量/完整SHA，随后只读取原缓存',async()=>{
        const asset=MANGA_TEXT_SEGMENTATION_ASSET,bytes=buffer(asset.bytes);
        await importMangaModel({name:asset.file,size:asset.bytes,arrayBuffer:async()=>bytes} as File);
        expect(cache.put).toHaveBeenCalledWith(asset.url,expect.any(Response));
        cache.match.mockResolvedValue(response(asset.bytes));
        expect((await loadMangaTextSegmentationAsset())?.byteLength).toBe(asset.bytes);
        expect(fetch).not.toHaveBeenCalled();expect(shapes.optimize).not.toHaveBeenCalled();
    });
    it.each(['size','hash','http','read'] as const)('%s错误保留原缓存，禁止隐式重下或镜像恢复',async fault=>{
        const saved=response(fault==='size'?1:MANGA_TEXT_SEGMENTATION_ASSET.bytes,fault==='http'?503:200);
        const failure=new Error('disk read');
        if(fault==='hash')vi.mocked(crypto.subtle.digest).mockResolvedValue(new ArrayBuffer(32));
        if(fault==='read')vi.mocked(saved.arrayBuffer).mockRejectedValue(failure);
        cache.match.mockResolvedValue(saved);
        await expect(loadMangaTextSegmentationAsset()).rejects.toThrow(fault==='read'?'disk read':fault==='hash'?'校验':fault==='size'?'不完整':'503');
        expect(cache.delete).not.toHaveBeenCalled();expect(cache.put).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['before','open','missing','matched','copied','hashed'] as const)('%s取消保持首因并禁止晚到网络/缓存写入',async stage=>{
        const abort=new AbortController(),asset=MANGA_TEXT_SEGMENTATION_ASSET;
        cache.match.mockResolvedValue(response(asset.bytes));
        if(stage==='before')abort.abort();
        if(stage==='open')vi.mocked(caches.open).mockImplementationOnce(async()=>{abort.abort();return cache as unknown as Cache;});
        if(stage==='missing')cache.match.mockImplementationOnce(async()=>{abort.abort();return undefined;});
        if(stage==='matched')cache.match.mockImplementationOnce(async()=>{abort.abort();return response(asset.bytes);});
        if(stage==='copied')cache.match.mockResolvedValueOnce({ok:true,arrayBuffer:async()=>{abort.abort();return buffer(asset.bytes);}} as Response);
        if(stage==='hashed')vi.mocked(crypto.subtle.digest).mockImplementationOnce(async()=>{abort.abort();return digest(asset.bytes);});
        await expect(loadMangaTextSegmentationAsset(abort.signal)).rejects.toMatchObject({name:'AbortError'});
        expect(fetch).not.toHaveBeenCalled();expect(cache.delete).not.toHaveBeenCalled();expect(cache.put).not.toHaveBeenCalled();
    });
});

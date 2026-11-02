/**
 * @file src/features/image-translation/services/mangaOcrAssets.ts
 * 文件职责：按固定上游版本加载并缓存本地漫画识别模型，不上传漫画图片。
 * 主要内容：固定模型版本、尺寸和 SHA-256，自动选择下载来源并在断流或损坏时切换已登记的备用来源，流式显示当前下载操作的进度，失败或取消后迟到的缓存响应立即释放未读正文，复制后取消不再摘要且不误删有效缓存；缓存已完成文件，支持校验后导入离线模型、读取状态与清除，历史来源偏好不再影响下载；删除会话期间暂缓新推理任务入队，普通识别与修补仍各自并行排队。
 * 模块边界：只处理模型数据文件，不加载远程代码、不执行 OCR、不读取用户配置；自动下载只含原 Apache-2.0 模型，可选 CTD 仅接受用户离线导入，不替其独立权重声明许可证；镜像与离线文件必须通过相同完整性校验，来源偏好不包含用户凭据。
 * 会话副本：所有原文件完成 SHA 校验和原始缓存写入后，仅识别模型按固定形状配方生成一次内存副本；正常和 CPU 重载共用同一路径，优化失败不删除有效原缓存或重新下载，状态/离线导入仍表示原文件。
 */
import {modelDownloadSources} from '@/src/platform/http/modelDownloads';
import {cancelUnreadResponseBody} from '@/src/platform/http/runtime';
import {optimizeVerifiedMangaRecognition} from './mangaRecognitionShapes';

const ROOT = 'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/bf1d5edb0335d3262be7caf13f766ba274b4cadd/';
export const MANGA_OCR_CACHE = 'fluent-read-manga-ocr-v1';
export const MANGA_OCR_ASSETS = [
    {key: 'detection', path: 'detection/PP-OCRv6_small_det.onnx', bytes: 9880512,
        sha256: 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e'},
    {key: 'recognition', path: 'recognition/PP-OCRv6_small_rec.onnx', bytes: 21159378,
        sha256: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634'},
    {key: 'charactersDictionary', path: 'recognition/ppocrv6_dict.txt', bytes: 74948,
        sha256: '41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8'},
] as const;
export const MANGA_OCR_MODEL_BYTES = MANGA_OCR_ASSETS.reduce((sum, asset) => sum + asset.bytes, 0);
export const MANGA_INPAINT_ASSET = {
    url: 'https://huggingface.co/ogkalu/lama-manga-onnx-dynamic/resolve/ee4ed4a8447b6730fc41d34f90876b6c48af925a/lama-manga-dynamic.onnx',
    bytes: 206291843, sha256: 'de31ffa5ba26916b8ea35319f6c12151ff9654d4261bccf0583a69bb095315f9',
};
/** 可选用户导入模型；url 仅为缓存身份，加载器绝不请求该地址。 */
export const MANGA_TEXT_SEGMENTATION_ASSET = {
    file: 'comictextdetector.pt.onnx',
    url: 'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx',
    bytes: 94669756, sha256: '1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f',
} as const;

export function assertMangaOcrActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('漫画识别已取消', 'AbortError');
}

/** 后台状态消息保留跨版本来源类型；下载策略始终自动选择。 */
export type MangaModelSource = 'auto' | 'official' | 'mirror';
export interface MangaDownloadState {phase:'downloading'|'verifying'|'error'|'paused';file:string;loaded:number;total:number;source:string}
let download: MangaDownloadState | undefined;
let downloadOwner: number | undefined;
let nextDownloadRequest = 0, latestDownloadRequest = 0;
let removal: Promise<void> | undefined;

/** 删除只阻止新任务入队，已入队的工作仍由各自运行时完成，不中止其他调用方。 */
export function withMangaModelAdmission<T>(operation: () => Promise<T>): Promise<T> {
    // 等待恢复的微任务运行前可能已开始下一次删除，入队时必须重新检查当前边界。
    return removal ? removal.catch(() => undefined).then(() => withMangaModelAdmission(operation)) : operation();
}

/** 同一模块实例的两个会话队列共用删除边界；失败也须开放后续任务，重复删除复用当前操作。 */
export function withMangaModelRemoval(operation: () => Promise<void>): Promise<void> {
    if (removal) return removal;
    const pending = Promise.resolve().then(operation).finally(() => {if (removal === pending) removal = undefined;});
    removal = pending;
    return pending;
}
async function downloadAsset(url:string,asset:{bytes:number;sha256:string},owner:number,signal?:AbortSignal,onProgress?:(bytes:number)=>void):Promise<ArrayBuffer> {
    // 同一公开加载请求的多个文件和备用来源共享身份，旧请求进入下一文件也不能夺回新请求的快照。
    if (owner > latestDownloadRequest) {latestDownloadRequest = owner;downloadOwner = owner;}
    // 下载策略由资源服务自动决定，历史手动来源设置不能干预后续下载和校验回退。
    const sources=modelDownloadSources(url);
    let failure:unknown;
    for(const source of sources){
        assertMangaOcrActive(signal);
        const controller=new AbortController();let timeout:ReturnType<typeof setTimeout>;
        const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
        const arm=()=>{clearTimeout(timeout);timeout=setTimeout(abort,20_000);};
        const state:MangaDownloadState={phase:'downloading',file:url.split('/').pop()!,loaded:0,total:asset.bytes,source:new URL(source).host};
        if (downloadOwner === owner) download = state;
        try {
            arm();const response=await fetch(source,{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});
            if(!response.ok){cancelUnreadResponseBody(response);throw new Error(`漫画模型下载失败 (${response.status})`);}
            let buffer:ArrayBuffer;
            const reader=response.body?.getReader();
            if(reader){
                const complete=new Uint8Array(asset.bytes);let received=0;
                try {
                    while(true){arm();const chunk=await reader.read();if(chunk.done)break;
                        received+=chunk.value.length;if(received>asset.bytes)throw new Error('漫画识别模型文件不完整，请重试');
                        complete.set(chunk.value,received-chunk.value.length);state.loaded=received;onProgress?.(received);
                    }
                    if(received!==asset.bytes)throw new Error('漫画识别模型文件不完整，请重试');buffer=complete.buffer;
                } finally {void reader.cancel().catch(()=>undefined);reader.releaseLock();}
            }else buffer=await response.arrayBuffer();
            clearTimeout(timeout!);assertMangaOcrActive(signal);state.phase='verifying';
            const verified=await verifiedArrayBuffer(buffer,asset);assertMangaOcrActive(signal);
            // 成功的单个文件不撤销同一请求后续文件的发布资格；删除或更新请求才撤销资格。
            if (downloadOwner === owner) download=undefined;
            return verified;
        }catch(error){failure=error;if(signal?.aborted){state.phase='paused';assertMangaOcrActive(signal);}}
        finally{clearTimeout(timeout!);controller.abort();signal?.removeEventListener('abort',abort);}
    }
    if (downloadOwner === owner && download) download.phase='error';
    throw new Error('漫画模型下载未完成，请重试或导入已下载文件',{cause:failure});
}

/** 文件名、尺寸、哈希都匹配后才写入，浏览器选择的文件从不上传。 */
export async function importMangaModel(file:File):Promise<void> {
    const snapshot = download, owner = downloadOwner;
    const asset=MANGA_OCR_ASSETS.find(asset=>asset.path.split('/').pop()===file.name);
    const metadata=asset??(file.name==='lama-manga-dynamic.onnx'?MANGA_INPAINT_ASSET:file.name===MANGA_TEXT_SEGMENTATION_ASSET.file?MANGA_TEXT_SEGMENTATION_ASSET:undefined);
    if(!metadata||file.size!==metadata.bytes)throw new Error('请选择配套的漫画模型文件');
    const buffer=await verifiedArrayBuffer(await file.arrayBuffer(),metadata);
    await (await caches.open(MANGA_OCR_CACHE)).put('path' in metadata?ROOT+metadata.path:metadata.url,new Response(buffer));
    if (download === snapshot && downloadOwner === owner && snapshot?.file === file.name && ['paused','error'].includes(snapshot.phase)) {
        download=undefined;downloadOwner=undefined;
    }
}

/** 缺失是正常的可选能力；损坏、缓存故障和取消保留原错误，既不删文件也不下载替代。 */
export async function loadMangaTextSegmentationAsset(signal?:AbortSignal):Promise<ArrayBuffer|undefined> {
    assertMangaOcrActive(signal);
    const cache=await caches.open(MANGA_OCR_CACHE);assertMangaOcrActive(signal);
    const cached=await cache.match(MANGA_TEXT_SEGMENTATION_ASSET.url);
    if(!cached){assertMangaOcrActive(signal);return;}
    try{
        const bytes=await verifiedBuffer(cached,MANGA_TEXT_SEGMENTATION_ASSET,signal);
        assertMangaOcrActive(signal);return bytes;
    }catch(error){assertMangaOcrActive(signal);throw error;}
}

async function verifiedBuffer(response: Response, asset: {bytes: number; sha256: string}, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (signal?.aborted) {cancelUnreadResponseBody(response);assertMangaOcrActive(signal);}
    if (!response.ok) {cancelUnreadResponseBody(response);throw new Error(`漫画识别模型下载失败 (${response.status})`);}
    const buffer = await response.arrayBuffer();
    assertMangaOcrActive(signal);
    return verifiedArrayBuffer(buffer,asset);
}

async function verifiedArrayBuffer(buffer:ArrayBuffer,asset:{bytes:number;sha256:string}):Promise<ArrayBuffer> {
    if (buffer.byteLength !== asset.bytes) throw new Error('漫画识别模型文件不完整，请重试');
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== asset.sha256) throw new Error('漫画识别模型校验失败，请重试');
    return buffer;
}

export async function loadMangaInpaintAsset(signal?: AbortSignal,onProgress?:(bytes:number)=>void): Promise<ArrayBuffer> {
    assertMangaOcrActive(signal);
    const owner = ++nextDownloadRequest;
    const cache = await caches.open(MANGA_OCR_CACHE), asset = MANGA_INPAINT_ASSET;
    assertMangaOcrActive(signal);
    const cached = await cache.match(asset.url);
    if (cached) {
        try {const buffer = await verifiedBuffer(cached, asset, signal); assertMangaOcrActive(signal); return buffer;}
        catch (error) {assertMangaOcrActive(signal); await cache.delete(asset.url);}
    }
    const buffer = await downloadAsset(asset.url,asset,owner,signal,onProgress);
    assertMangaOcrActive(signal); await cache.put(asset.url, new Response(buffer));
    return buffer;
}

export async function loadMangaOcrAssets(signal?: AbortSignal, onProgress?: (percent: number) => void) {
    assertMangaOcrActive(signal);
    const owner = ++nextDownloadRequest;
    const cache = await caches.open(MANGA_OCR_CACHE);
    const model: Record<string, ArrayBuffer> = {};
    let completed = 0;
    let lastPercent = -1;
    const report = (percent:number) => {if(percent !== lastPercent){lastPercent=percent;onProgress?.(percent);}};
    for (const asset of MANGA_OCR_ASSETS) {
        assertMangaOcrActive(signal);
        const url = ROOT + asset.path;
        const cached = await cache.match(url);
        let buffer: ArrayBuffer | undefined;
        if (cached) {
            try { buffer = await verifiedBuffer(cached, asset, signal); }
            catch { assertMangaOcrActive(signal); await cache.delete(url); }
        }
        assertMangaOcrActive(signal);
        if (!buffer) {
            buffer = await downloadAsset(url,asset,owner,signal,bytes=>report(Math.min(99,Math.floor((completed+bytes)*100/MANGA_OCR_MODEL_BYTES))));
            assertMangaOcrActive(signal);
            await cache.put(url, new Response(buffer));
        }
        model[asset.key] = buffer;
        completed += asset.bytes;
        report(Math.floor(completed * 100 / MANGA_OCR_MODEL_BYTES));
    }
    // 脱离缓存损坏/下载回退的 catch：配方不匹配必须报告，不能误删已校验的原模型。
    const recognition=MANGA_OCR_ASSETS[1];
    model.recognition=optimizeVerifiedMangaRecognition(model.recognition,recognition,signal);
    return model;
}

export async function mangaOcrModelStatus(): Promise<{ready: boolean; bytes: number; inpaintingReady: boolean; segmentationReady:boolean; source:'auto'; download?:MangaDownloadState}> {
    const cache = await caches.open(MANGA_OCR_CACHE);
    const responses = await Promise.all(MANGA_OCR_ASSETS.map(asset => cache.match(ROOT + asset.path)));
    const bytes = responses.reduce((sum, response, index) => sum + (response ? MANGA_OCR_ASSETS[index].bytes : 0), 0);
    const inpaintingReady = !!await cache.match(MANGA_INPAINT_ASSET.url);
    const segmentationReady=!!await cache.match(MANGA_TEXT_SEGMENTATION_ASSET.url);
    // 设置页的离线导入与 Offscreen 属于不同模块实例，共享缓存后解除旧的暂停/失败提示。
    if (download && ['paused','error'].includes(download.phase)) {
        const index = MANGA_OCR_ASSETS.findIndex(asset => asset.path.endsWith('/' + download!.file));
        if (index >= 0 ? !!responses[index] : download.file === 'lama-manga-dynamic.onnx' && inpaintingReady) {download = undefined;downloadOwner = undefined;}
    }
    return {ready: bytes === MANGA_OCR_MODEL_BYTES, bytes: bytes + (inpaintingReady ? MANGA_INPAINT_ASSET.bytes : 0)+(segmentationReady?MANGA_TEXT_SEGMENTATION_ASSET.bytes:0), inpaintingReady,segmentationReady,source:'auto',...(download?{download:{...download}}:{})};
}

export async function removeMangaOcrAssets(): Promise<void> {
    const owner = downloadOwner;
    await caches.delete(MANGA_OCR_CACHE);
    if (downloadOwner === owner) {download=undefined;downloadOwner=undefined;}
}

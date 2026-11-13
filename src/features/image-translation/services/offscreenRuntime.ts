/**
 * @file src/features/image-translation/services/offscreenRuntime.ts
 * 后台选择的本地后端在加载图片前交给已有推理客户端，在串行任务边界生效。
 * 文件职责：在隔离 Offscreen 文档中编排图片重绘翻译，并为圈选文本翻译提供仅裁剪和本地 OCR 的独立入口。
 * 主要内容：单图可选与漫画共用的 PaddleOCR，两种引擎均按普通段落合行翻译、限制字号并保留对齐，擦除只使用原始行框；独立数字保留原图与可读原文，不发送翻译；单图与漫画按实际清字和绘字范围对未变化原文进行有界级联保护，碰撞后仍保留原文与完整阅读译文；保留单图完整译图与原文对照，不自动加载漫画修补模型；图片解码时前置尺寸校验和取消/超时清理，普通修补复用独占像素，透明图先完整全文避孔预检，再将低alpha从擦写与背景采样中排除，未知透明先按同帧完整RGBA静区与墨迹组件进行有界全页救援，所有图案、原文保护和完整译字均通过才精确上传墨迹脏矩形；证明不足、不可达修补或预算不足原子保留原图与完整阅读译文；不透明图不额外复制整页；完整译图、漫画局部图块和圈选裁剪共用可取消的异步 PNG 编码；漫画在原始像素尚未回写前计算全局透明孔保护，与背景分类一起交给修补及绘字，避免重叠写入破坏已保护的画面；确认整页均匀时复用本次独占 ImageData 并跳过同一数组的拷回，复杂页仍分离输入与输出，完成或失败后释放临时图像与画布。
 * 可选分割：整页颜色、归属和完整译文预检后，先验证已有检测支持；不足时只读用户已导入的 CTD 缓存，只发送本帧有界 RGBA，由独立 Worker 缩放和构造张量，同帧量化 seg 经局部投影与全页授权后才上传墨迹，不自动下载可选模型；实际到达分割而缺文件的保留原图结果携带私有重试标记，其他安全撤回不标记。
 * 段落关系：普通识别数组的私有同帧布局证据只豁免相邻物理行距；过滤后的数字框仍作遮挡，逐行擦除框与所有回填权限保持独立。
 * 注音边界：原文碰撞与漫画修补共用注音自己的字高余量，按候选缓存坐标查询，避免扩大清字范围或在级联保护中重复扫描注音。
 * 字号尺度与原色：普通图先通过透明准入，再按原文单行校验字号、在原图中观察背景与字色；只有新增范围全部是已证不透明底色且避开其他文字时，才为完整单行少量增高绘字框，清字始终沿原掩码。漫画修补前保存源色供后续绘制，不从修补结果反推样式。
 * 空识别：普通图片仅在 OCR 真正返回空数组时使用轻量原图保留协议，不分配译图画布；非空结果经保护或置信过滤后不可读仍报错，漫画维持既有空页协议。
 * 气泡补绘：漫画发生原文碰撞时保持全部原文保护；仅同源局部气泡提示有效、原闭合组件内有足够纯白空处且完整译文字号不低于源字号时另放译文，不清除原文、不新增 OCR、翻译或修补模型；分段显示窗口同时限制原段归属和完整补绘位置，非法范围仅撤回补绘，不改变正常清字；已使用补绘范围参与后续避让，阅读定位仍保留原坐标，无安全位置时继续标记未绘制。
 * 模块边界：该运行时只在具备 Canvas/DOM 的 Offscreen 环境执行，不直接接收 browser.runtime 事件；消息入口由 app/offscreen 组装，翻译函数由依赖注入，几何算法来自 area feature。
 */
import {createImageTranslationFailure} from '../failure';
import {IMAGE_PROGRESS_MESSAGE_TYPE, type ImageTranslationStage} from '../progress';
import { selectChangedTranslations, type OcrLine } from '@/src/features/image-translation/core';
import type {ImageViewport} from '@/src/shared/image/types';
import { areaRectToImageCrop, type AreaTranslationSelection, type AreaRecognitionResult } from '@/src/features/area-translation/protocol';
import { imageMaskBoxes, imageMaskBoxIntersects, inpaintTextRegions } from './inpainting';
import {proposeImageMattePage,getImageMatteProposalDrawings,authorizeImageMatteProposal,discardImageMatteProposal,applyImageMattePage} from './imageMattePage';
import {getImageDetectionEvidence,type ImageDetectionSupport} from './imageDetectionEvidence';
import {getImageParagraphGapEvidence} from './imageParagraphGapEvidence';
import {isSingleFrameImageData} from './imageDetectionSnapshot';
import {createImageTextSegmentationSupport} from './imageTextSegmentation';
import {mangaInferenceClient} from './mangaInferenceClient';
import { recognizeImage } from './ocrRuntime';
import { getImageTextBackgroundColor, drawTranslatedImageText,getImageTextDirection,getImageSourceFontLimit,getImageSingleLineHeight,IMAGE_TEXT_FONT,layoutImageTranslationText,type ImageTranslationTextLayout } from './rendering';
import {observeImageSourceAppearances,expandImageTextBounds} from './sourceAppearance';
import {groupImageParagraphs, type ImageTextRegion} from '../paragraphs';
import {mangaOcrRuntime} from './mangaOcr';
import {createMangaBlankLayoutBudget, drawMangaTranslations, planMangaBlankTranslation, sampleMangaBackgrounds} from './mangaRendering';
import {getMangaBubblePlacement} from './mangaBubblePlacement';
import {findMangaBlankSpaces} from './mangaBlankSpaces';
import {ImageAlphaProtectionUnavailableError,MangaAlphaProtectionLimitError,mangaAlphaClearRects,planMangaAlphaProtection,planMaskAlphaProtection} from './mangaAlphaProtection';
import {groupMangaOcrLines, type MangaRegion} from './mangaRegions';
import {numericEvidenceKey,numericProtection} from './mangaNumeric';
import {mangaInpaintingRuntime} from './mangaInpainting';
import {encodeImageCanvas} from './imageEncoding';
import {mangaMaskBoxes, mangaMaskBoxIntersects, createMangaMaskFontResolver, mangaPatchRects, type MangaPatchPacket} from '../mangaPatchResult';
import {getMangaOcrEngine} from '../ocrLanguages';

export type OffscreenImageTranslationLine = OcrLine & { backgroundColor: string; sourceText?: string; renderSkipped?: true; numericUncertain?: true };

export interface OffscreenImageTranslationResult {
    image: string;
    imageUnchanged?: true;
    retryWhenSegmentationReady?: true;
    mangaPatches?: MangaPatchPacket;
    lines: OffscreenImageTranslationLine[];
}

const IMAGE_TEXT_TRANSLATION_TIMEOUT_MS = 120_000;
const IMAGE_DECODE_TIMEOUT_MS = 30_000;
const MAX_RENDER_IMAGE_PIXELS = 16_777_216;
const MAX_RENDER_IMAGE_SIDE = 8192;
let legacyImageTextRequestSequence = 0;

function createImageOperationAbortError(): Error {
    const error = new Error('图片翻译请求已取消');
    error.name = 'AbortError';
    return error;
}

function throwIfImageOperationAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw createImageOperationAbortError();
}

function loadImage(dataUrl: string, signal?: AbortSignal): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createImageOperationAbortError());
            return;
        }
        const source = new Image();
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            source.onload = null;
            source.onerror = null;
            signal?.removeEventListener('abort', handleAbort);
            callback();
        };
        const fail = (error: Error) => finish(() => {
            source.src = '';
            reject(error);
        });
        const handleAbort = () => fail(createImageOperationAbortError());
        source.onload = () => {
            const width = source.naturalWidth || source.width;
            const height = source.naturalHeight || source.height;
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
                fail(new Error('图片尺寸无效'));
            } else if (width * height > MAX_RENDER_IMAGE_PIXELS || Math.max(width, height) > MAX_RENDER_IMAGE_SIDE) {
                fail(new Error('图片过大，请缩小图片或使用圈选翻译'));
            } else finish(() => resolve(source));
        };
        source.onerror = () => fail(new Error('图片数据无法解码'));
        signal?.addEventListener('abort', handleAbort, {once: true});
        timeout = setTimeout(() => fail(new Error('图片解码超时，请重试')), IMAGE_DECODE_TIMEOUT_MS);
        try {
            source.src = dataUrl;
        } catch {
            fail(new Error('图片数据无法解码'));
        }
    });
}

/** 在像素阶段让出事件循环，使已发送的取消消息有机会在编码和返回结果前生效。 */
async function checkImageCancellation(signal?: AbortSignal): Promise<void> {
    throwIfImageOperationAborted(signal);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    throwIfImageOperationAborted(signal);
}

function reportProgress(requestId: string | undefined, stage: ImageTranslationStage, progress?: number): void {
    if (!requestId) return;
    // 进度是旁路；页面已关闭时不得影响取消与 OCR 主链。
    try { chrome.runtime.sendMessage({type: IMAGE_PROGRESS_MESSAGE_TYPE, requestId, stage, progress}, () => void chrome.runtime.lastError); } catch { /* 扩展上下文可能已销毁。 */ }
}

export async function translateImageTextsInExtension(
    texts: string[],
    title: string,
    requestId: string | undefined,
    signal?: AbortSignal,
): Promise<string[]> {
    const operationId = requestId || `legacy-image-text-${++legacyImageTextRequestSequence}`;
    const response = await new Promise<any>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout>;
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', handleAbort);
            callback();
        };
        const notifyCancellation = () => {
            try {
                chrome.runtime.sendMessage({
                    type: 'fluentReadImageCancel',
                    requestId: operationId,
                }, () => void chrome.runtime.lastError);
            } catch {
                // Offscreen 正在销毁时取消消息可能无法投递；本地等待仍必须立即结束。
            }
        };
        const handleAbort = () => finish(() => {
            notifyCancellation();
            reject(createImageOperationAbortError());
        });
        if (signal?.aborted) {
            handleAbort();
            return;
        }
        signal?.addEventListener('abort', handleAbort, {once: true});
        timeout = setTimeout(() => finish(() => {
            notifyCancellation();
            reject(new Error('图片文字翻译超时，请重试'));
        }), IMAGE_TEXT_TRANSLATION_TIMEOUT_MS);
        try {
            chrome.runtime.sendMessage({
                type: 'fluentReadImageTranslateTexts',
                texts,
                title,
                requestId: operationId,
                timeoutMs: IMAGE_TEXT_TRANSLATION_TIMEOUT_MS,
            }, result => finish(() => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(result);
            }));
        } catch (error) {
            finish(() => reject(error));
        }
    });
    throwIfImageOperationAborted(signal);
    if (!response?.success || !Array.isArray(response.translations)) {
        throw createImageTranslationFailure(response?.error || '图片文字翻译失败', response);
    }
    return response.translations;
}

async function cropImage(dataUrl: string, selection: AreaTranslationSelection, signal?: AbortSignal): Promise<string> {
    const source = await loadImage(dataUrl, signal);
    let canvas: HTMLCanvasElement | undefined;
    try {
        throwIfImageOperationAborted(signal);
        const imageWidth = source.naturalWidth || source.width;
        const imageHeight = source.naturalHeight || source.height;
        const crop = areaRectToImageCrop(selection, imageWidth, imageHeight);
        canvas = document.createElement('canvas');
        canvas.width = crop.width;
        canvas.height = crop.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器不支持区域截图处理');
        context.drawImage(source, crop.left, crop.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
        throwIfImageOperationAborted(signal);
        // 画布已拥有裁剪像素；等待编码时不继续持有整张解码截图。
        source.src = '';
        const image = await encodeImageCanvas(canvas, signal);
        throwIfImageOperationAborted(signal);
        return image;
    } finally {
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
        }
        source.src = '';
    }
}

/** 仅裁剪选区供视觉模型使用；此路径不加载 OCR 语言包，也不执行本地识别。 */
export async function cropAreaInOffscreen(
    image: string,
    selection: AreaTranslationSelection,
    signal?: AbortSignal,
): Promise<{image: string; lines: OcrLine[]}> {
    const croppedImage = await cropImage(image, selection, signal);
    throwIfImageOperationAborted(signal);
    return {image: croppedImage, lines: []};
}

/** 单图译文裁剪框既决定绘制范围，也用于保护附近保留的原文。 */
function imageDrawBounds(line: ImageTextRegion, width: number, height: number): OcrLine['bbox'] {
    const sourceHeight = line.fontSize ?? line.bbox.y1 - line.bbox.y0;
    const paddingX = line.vertical ? 3 : 2;
    const paddingY = line.vertical ? 2 : Math.max(2, Math.round(sourceHeight * 0.18));
    const left = Math.max(0, line.bbox.x0 - paddingX), top = Math.max(0, line.bbox.y0 - paddingY);
    const drawWidth = Math.max(1, Math.min(width - left, line.bbox.x1 - line.bbox.x0 + paddingX * 2));
    const drawHeight = Math.max(1, Math.min(height - top, line.bbox.y1 - line.bbox.y0 + paddingY * 2));
    return {x0:left,y0:top,x1:left+drawWidth,y1:top+drawHeight};
}

/** 透明度证明覆盖修补的一像素采样上下文及绘字足迹；不扩张实际擦除或绘字范围。 */
function imageAlphaSamplingAndWriteBoxes(line:ImageTextRegion,width:number,height:number):OcrLine['bbox'][] {
    const draw=imageDrawBounds(line,width,height);
    if(![draw.x0,draw.y0,draw.x1,draw.y1].every(Number.isFinite))throw new ImageAlphaProtectionUnavailableError();
    const box={x0:Math.max(0,Math.min(width,Math.floor(draw.x0))),y0:Math.max(0,Math.min(height,Math.floor(draw.y0))),
        x1:Math.max(0,Math.min(width,Math.ceil(draw.x1))),y1:Math.max(0,Math.min(height,Math.ceil(draw.y1)))};
    if(box.x1<=box.x0||box.y1<=box.y0)throw new ImageAlphaProtectionUnavailableError();
    // 完整包含的修补框外周只是写入并集内部，不能把内部孔误当成未知外部边界。
    const repair=imageMaskBoxes(line,width,height).map(mask=>({x0:Math.max(0,mask.x0-1),y0:Math.max(0,mask.y0-1),
        x1:Math.min(width,mask.x1+1),y1:Math.min(height,mask.y1+1)})).filter(mask=>
        box.x0>mask.x0||box.y0>mask.y0||box.x1<mask.x1||box.y1<mask.y1);
    return [...repair,box];
}

/** 验证透明重排的单个框；不能把非空矩形或完整元数据当作完整字形的证明。 */
function prepareImageAlphaTextLayout(context:CanvasRenderingContext2D,text:string,bounds:OcrLine['bbox'],
    maxFontSize:number,textAlign:'left'|'center'|'right',budget?:{remaining:number;characters:number}):ImageTranslationTextLayout|undefined {
    const width=bounds.x1-bounds.x0,height=bounds.y1-bounds.y0;
    const paddingX=Math.min(2,width*.03),paddingY=Math.min(1,height*.05);
    const contentWidth=width-paddingX*2,contentHeight=height-paddingY*2;
    context.save();
    try {
        context.direction=getImageTextDirection(text);
        // 词拆分及每次原生度量均预付UTF-16工作量，不能以巨长译文绕过调用次数上限。
        if(budget&&(--budget.remaining<0||(budget.characters-=text.length)<0))throw new MangaAlphaProtectionLimitError();
        const layout=layoutImageTranslationText(text,contentWidth,contentHeight,(line,size)=>{
            if(budget&&(--budget.remaining<0||(budget.characters-=line.length)<0))throw new MangaAlphaProtectionLimitError();
            context.font='400 '+size+'px '+IMAGE_TEXT_FONT;
            return context.measureText(line).width;
        },maxFontSize);
        if(!layout.lines.length || !Number.isFinite(layout.fontSize) || layout.fontSize<=0
            || !Number.isFinite(layout.lineHeight) || layout.lines.length*layout.lineHeight>contentHeight)return;
        context.font='400 '+layout.fontSize+'px '+IMAGE_TEXT_FONT;
        context.textAlign=textAlign;context.textBaseline='middle';
        // 原描边半径另加一个像素保守抗锯齿余量；不通过时不尝试裁字或换小段发布。
        const bleed=Math.max(.35,layout.fontSize*.06)/2+1;
        const first=textAlign==='center'?(height-layout.lineHeight*layout.lines.length)/2+layout.lineHeight/2:paddingY+layout.lineHeight/2;
        const x=textAlign==='left'?paddingX:textAlign==='right'?width-paddingX:width/2;
        for(let index=0;index<layout.lines.length;index++){
            if(!layout.lines[index].trim())continue;
            if(budget&&(--budget.remaining<0||(budget.characters-=layout.lines[index].length)<0))throw new MangaAlphaProtectionLimitError();
            const metrics=context.measureText(layout.lines[index]),y=first+index*layout.lineHeight;
            if(![metrics.width,metrics.actualBoundingBoxLeft,metrics.actualBoundingBoxRight,metrics.actualBoundingBoxAscent,metrics.actualBoundingBoxDescent].every(Number.isFinite)
                || metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight<=0 || metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent<=0
                || metrics.width>contentWidth || x-metrics.actualBoundingBoxLeft-bleed<0
                || x+metrics.actualBoundingBoxRight+bleed>width || y-metrics.actualBoundingBoxAscent-bleed<0
                || y+metrics.actualBoundingBoxDescent+bleed>height)return;
        }
        return layout;
    } finally {context.restore();}
}

/** 已知 alpha 准入失败仍返回完整文本，原子保留源位图；未知失败不使用此结果。 */
function imageAlphaUnchanged(lines:OffscreenImageTranslationLine[]):OffscreenImageTranslationResult {
    return {image:'',imageUnchanged:true,lines:lines.map(line=>({...line,
        ...(line.text!==line.sourceText?{renderSkipped:true as const}:{}),
    }))};
}

/** 严格 alpha 准入失败时才尝试完整 RGBA 证明；全页预检通过前不更改像素或上传。 */
async function renderImageMatteRescue(context:CanvasRenderingContext2D,canvas:HTMLCanvasElement,sourcePixels:ImageData,
    translated:ImageTextRegion[],retained:ImageTextRegion[],reading:OffscreenImageTranslationLine[],support:ImageDetectionSupport,signal?:AbortSignal,
):Promise<OffscreenImageTranslationResult|undefined> {
    const proposal=proposeImageMattePage(sourcePixels.data,canvas.width,canvas.height,translated,retained,imageDrawBounds);
    if(!proposal)return;
    try {
    const view=getImageMatteProposalDrawings(proposal)!;
    let plan=authorizeImageMatteProposal(proposal,support);
    const drawing:Array<{line:ImageTextRegion;bounds:OcrLine['bbox'];prepared:ImageTranslationTextLayout;background:string}>=[];
    const layoutBudget={remaining:1_048_576},measureBudget={remaining:8192,characters:4_194_304};
    try {
        for(const item of view.drawings){
            throwIfImageOperationAborted(signal);
            const available=mangaAlphaClearRects(view,item.bounds,layoutBudget).sort((a,b)=>
                (b.x1-b.x0)*(b.y1-b.y0)-(a.x1-a.x0)*(a.y1-a.y0));
            let chosen:{bounds:OcrLine['bbox'];prepared:ImageTranslationTextLayout}|undefined;
            const maxFontSize=item.line.vertical?Infinity:(item.line.fontSize??item.line.bbox.y1-item.line.bbox.y0)*1.2;
            for(const bounds of available){
                const prepared=prepareImageAlphaTextLayout(context,item.line.text,bounds,maxFontSize,item.line.vertical?'center':item.line.textAlign??'left',measureBudget);
                if(prepared){chosen={bounds,prepared};break;}
            }
            if(!chosen)return;
            const [red,green,blue,alpha]=item.background;
            const background=alpha<128?'rgb(255,255,255)':`rgba(${red},${green},${blue},${alpha/255})`;
            drawing.push({line:item.line,...chosen,background});
        }
    }catch(error){
        if(!(error instanceof MangaAlphaProtectionLimitError))throw error;
        return;
    }
    await checkImageCancellation(signal);
    if(!plan){
        // 无缓存时不下载、不构造张量；所有颜色、归属与完整字形均已通过才准备可选会话。
        const ready=await mangaInferenceClient.prepareTextSegmentation(signal);
        if(!ready){
            // 缺资源也是异步结果；保留外层撤回前的让出与取消检查，不能发布迟到的可重试结果。
            await checkImageCancellation(signal);
            return {...imageAlphaUnchanged(reading),retryWhenSegmentationReady:true};
        }
        throwIfImageOperationAborted(signal);
        const seg=await mangaInferenceClient.segmentText(()=>{
            throwIfImageOperationAborted(signal);
            return {pixels:sourcePixels.data,width:canvas.width,height:canvas.height};
        },signal);
        throwIfImageOperationAborted(signal);
        const segmentation=createImageTextSegmentationSupport(seg,canvas.width,canvas.height);
        try {plan=authorizeImageMatteProposal(proposal,segmentation);}
        finally {segmentation.dispose();}
        if(!plan)return;
    }
    await checkImageCancellation(signal);
    applyImageMattePage(sourcePixels.data,canvas.width,canvas.height,plan);
    // 每个脏矩形仅含原墨迹，不让未修改的半透明图案经历整页读回后的再次量化。
    for(let index=0;index<plan.uploads.length;index++){
        if((index&127)===0)await checkImageCancellation(signal);
        const box=plan.uploads[index];
        context.putImageData(sourcePixels,0,0,box.x0,box.y0,box.x1-box.x0,box.y1-box.y0);
    }
    for(const item of drawing){
        throwIfImageOperationAborted(signal);
        const b=item.bounds;
        drawTranslatedImageText(context,item.line.text,b.x0,b.y0,b.x1-b.x0,b.y1-b.y0,item.background,
            item.line.vertical?Infinity:(item.line.fontSize??item.line.bbox.y1-item.line.bbox.y0)*1.2,
            item.line.vertical?'center':item.line.textAlign??'left',item.prepared);
    }
    await checkImageCancellation(signal);
    const image=await encodeImageCanvas(canvas,signal);
    throwIfImageOperationAborted(signal);
    return {image,lines:reading};
    } finally {discardImageMatteProposal(proposal);}
}

/** 显示窗口只收窄新增气泡补绘；非法值不应退回整图补绘权限，也不改变正常译文清字。 */
function mangaPlacementBounds(viewport:ImageViewport|undefined,width:number,height:number):OcrLine['bbox']|null|undefined {
    if(viewport===undefined)return;
    if(!viewport||typeof viewport!=='object'||Array.isArray(viewport))return null;
    const {x,y,width:w,height:h}=viewport;
    if(![x,y,w,h].every(Number.isSafeInteger)||x<0||y<0||w<=0||h<=0||x+w>width||y+h>height)return null;
    return {x0:x,y0:y,x1:x+w,y1:y+h};
}

async function prepareTranslatedImage(
    source: HTMLImageElement,
    lines: ImageTextRegion[],
    translations: string[],
    signal?: AbortSignal,
    manga = false,
    requestId?: string,
    support?:ImageDetectionSupport,
    placementImage?:string,
    mangaViewport?:ImageViewport,
): Promise<OffscreenImageTranslationResult> {
    await checkImageCancellation(signal);
    const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
    const skipped = new Set<number>();
    let protectionExhausted=false;
    const candidates: Array<{index: number; original: ImageTextRegion; translated: ImageTextRegion; maskFont?: ReturnType<typeof createMangaMaskFontResolver>}> = [];
    const originals: ImageTextRegion[] = [];
    lines.forEach((line,index) => {
        const changed = line.guardOnly || numericProtection(line.text) ? [] : selectChangedTranslations([line], [translations[index]]);
        if (changed.length) candidates.push({index,original:line,translated:changed[0]});
        else originals.push(line);
    });
    if (candidates.length && originals.length) {
        // 所有保留原文（含碰撞后未绘制的译文）都必须避开后续修补和排版。
        const protectedBoxes: OcrLine['bbox'][] = [], seen = new Set<string>();
        let work = 0, exhausted = false;
        const validBox = (box:OcrLine['bbox'] | null | undefined): box is OcrLine['bbox'] => !!box && Number.isFinite(box.x0) && Number.isFinite(box.y0)
            && Number.isFinite(box.x1) && Number.isFinite(box.y1) && box.x1>box.x0 && box.y1>box.y0;
        const protect = async (line: ImageTextRegion) => {
            const sources = line.sourceBoxes ?? [];
            for (let index=-1;index<sources.length;index++) {
                const box = index<0 ? line.bbox : sources[index];
                if (++work > 1_000_000 || !validBox(box)) {exhausted = true;return;}
                if ((work & 32767)===0) await checkImageCancellation(signal);
                const rect = {x0:Math.max(0,Math.floor(box.x0)-2),y0:Math.max(0,Math.floor(box.y0)-2),
                    x1:Math.min(width,Math.ceil(box.x1)+2),y1:Math.min(height,Math.ceil(box.y1)+2)};
                if (rect.x1<=rect.x0 || rect.y1<=rect.y0) continue;
                const key = `${rect.x0},${rect.y0},${rect.x1},${rect.y1}`;
                if (!seen.has(key)) {
                    if (protectedBoxes.length>=8192) {exhausted=true;return;}
                    seen.add(key);protectedBoxes.push(rect);
                }
            }
        };
        for (const line of originals) {await protect(line);if (exhausted) break;}
        // 对新保留的原文继续传播；只对尚未跳过的候选比较，达到预算时不绘制任何候选。
        for (let cursor=0;cursor<protectedBoxes.length && !exhausted && skipped.size<candidates.length;cursor++) {
            const protectedBox = protectedBoxes[cursor];
            for (const candidate of candidates) {
                if (++work>1_000_000) {exhausted=true;break;}
                if ((work & 32767)===0) await checkImageCancellation(signal);
                if (skipped.has(candidate.index)) continue;
                const region = candidate.translated, box = region.bbox;
                if (++work>1_000_000 || !validBox(box) || ((manga || region.fontSize !== undefined) && !Number.isFinite(region.fontSize))) {exhausted=true;break;}
                if ((work & 32767)===0) await checkImageCancellation(signal);
                const drawBox = manga ? box : imageDrawBounds(region,width,height);
                if (!validBox(drawBox)) {exhausted=true;break;}
                let hit = drawBox.x0<protectedBox.x1 && protectedBox.x0<drawBox.x1 && drawBox.y0<protectedBox.y1 && protectedBox.y0<drawBox.y1;
                const sources = region.sourceBoxes;
                for (let index=0;!hit && index<(sources?.length ?? 1);index++) {
                    const source = sources ? sources[index] : box;
                    if (++work>1_000_000 || !validBox(source)) {exhausted=true;break;}
                    if ((work & 32767)===0) await checkImageCancellation(signal);
                    hit=manga ? mangaMaskBoxIntersects(source,(candidate.maskFont??=createMangaMaskFontResolver(region as MangaRegion))(source),width,height,protectedBox)
                        : imageMaskBoxIntersects(source,width,height,protectedBox);
                }
                if (hit) {skipped.add(candidate.index);await protect(candidate.original);}
                if (exhausted) break;
            }
        }
        if (exhausted) {
            protectionExhausted=true;
            for (const candidate of candidates) skipped.add(candidate.index);
        }
    }
    throwIfImageOperationAborted(signal);
    const translatedLines = candidates.filter(candidate=>!skipped.has(candidate.index)).map(candidate=>candidate.translated);
    const placementBounds=manga?mangaPlacementBounds(mangaViewport,width,height):undefined;
    // 不撤回原文保护。只有实际局部气泡、同源对象和尺寸仍有效的横排候选可尝试在空白处另画完整译文。
    const blankCandidates=manga&&placementImage&&!protectionExhausted&&placementBounds!==null?candidates.flatMap(candidate=>{
        if(!skipped.has(candidate.index)||candidate.original.vertical)return [];
        const owner=getMangaBubblePlacement(candidate.original as MangaRegion,placementImage,width,height);
        if(!owner)return [];
        if(placementBounds){
            const within=(box:OcrLine['bbox'])=>box.x0>=placementBounds.x0&&box.y0>=placementBounds.y0
                &&box.x1<=placementBounds.x1&&box.y1<=placementBounds.y1;
            // padding 中的全文不能搬进邻段；跨可见边界的源段仍保留原有未绘制状态。
            if(!within(candidate.original.bbox)||candidate.original.sourceBoxes?.some(box=>!within(box)))return [];
        }
        return [{candidate,owner}];
    }).slice(0,32):[];
    const readingLines = lines.flatMap((line, index) => line.guardOnly ? [] : [{...line, sourceText: line.text, text: translations[index]?.trim() || line.text, backgroundColor: 'transparent',
        ...(skipped.has(index) ? {renderSkipped: true as const} : {})}]);
    // 品牌名或已经是目标语言的文字仍可阅读/复制，不应把识别成功显示为错误。
    if (translatedLines.length === 0&&!blankCandidates.length) return manga ? {image: '', mangaPatches: {width: source.naturalWidth || source.width, height: source.naturalHeight || source.height, patches: []}, lines: readingLines} : {image: '', imageUnchanged: true, lines: readingLines};
    const canvas = document.createElement('canvas');
    try {
        canvas.width = source.naturalWidth || source.width;
        canvas.height = source.naturalHeight || source.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器不支持图片处理');

        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height);
        throwIfImageOperationAborted(signal);
        if (manga) {
            const placed:Array<{index:number;region:MangaRegion}>=[];
            if(blankCandidates.length){
                const obstacles:OcrLine['bbox'][]=[],seen=new Set<string>();let valid=true;
                const add=(box:OcrLine['bbox'],margin=0)=>{
                    // 原框已由未耗尽的保护阶段核对；清字框再次夹紧，完全位于图外的范围不参与补绘。
                    const b={x0:Math.max(0,Math.floor(box.x0)-margin),y0:Math.max(0,Math.floor(box.y0)-margin),
                        x1:Math.min(width,Math.ceil(box.x1)+margin),y1:Math.min(height,Math.ceil(box.y1)+margin)};
                    if(b.x1<=b.x0||b.y1<=b.y0)return;
                    const key=[b.x0,b.y0,b.x1,b.y1].join(',');
                    if(seen.has(key))return;
                    if(obstacles.length>=8192){valid=false;return;}
                    seen.add(key);obstacles.push(b);
                };
                if(placementBounds){
                    if(placementBounds.x0>0)add({x0:0,y0:0,x1:placementBounds.x0,y1:height});
                    if(placementBounds.y0>0)add({x0:0,y0:0,x1:width,y1:placementBounds.y0});
                    if(placementBounds.x1<width)add({x0:placementBounds.x1,y0:0,x1:width,y1:height});
                    if(placementBounds.y1<height)add({x0:0,y0:placementBounds.y1,x1:width,y1:height});
                }
                // 保留所有源段、数值、源行清字余量与正常译文的范围；不能只排除这一次碰撞框。
                for(const line of lines){
                    add(line.bbox,2);
                    if(line.fontSize!==undefined){
                        if(!Number.isFinite(line.fontSize)||line.fontSize<=0){valid=false;break;}
                        for(const box of mangaMaskBoxes(line as MangaRegion,width,height))add(box);
                    }
                    if(!valid)break;
                }
                const budget={remainingPixels:2_000_000};
                const layoutBudget=createMangaBlankLayoutBudget();
                if(valid)for(const {candidate,owner} of blankCandidates){
                    await checkImageCancellation(signal);
                    if(!getMangaBubblePlacement(candidate.original as MangaRegion,placementImage!,width,height))continue;
                    const spaces=findMangaBlankSpaces(sourcePixels.data,width,height,owner,obstacles,budget,()=>throwIfImageOperationAborted(signal));
                    const region=planMangaBlankTranslation(context,candidate.translated as MangaRegion,width,height,spaces,layoutBudget);
                    if(!region)continue;
                    // 下一个补绘仍须避开此处，原 skipped 集合和原文传播保持有效。
                    placed.push({index:candidate.index,region});add(region.bbox,2);
                    if(!valid)break;
                }
            }
            const backgrounds = translatedLines.length?sampleMangaBackgrounds(sourcePixels.data,canvas.width,canvas.height,translatedLines as MangaRegion[]):[];
            const protection = translatedLines.length?planMangaAlphaProtection(sourcePixels.data,canvas.width,canvas.height,translatedLines as MangaRegion[]):undefined;
            const pixels = translatedLines.length?await mangaInpaintingRuntime.repair(sourcePixels.data,canvas.width,canvas.height,translatedLines as MangaRegion[],signal,
                (percent,initializing)=>reportProgress(requestId,initializing?'initializing':'preparing',percent),
                (done,total)=>reportProgress(requestId,'cleaning',Math.floor(done*100/total)),backgrounds,{reuseUniformPixels:true,protection}):sourcePixels.data;
            if(pixels!==sourcePixels.data)sourcePixels.data.set(pixels);
            if(translatedLines.length)context.putImageData(sourcePixels,0,0);
            reportProgress(requestId,'rendering');
            if(translatedLines.length)drawMangaTranslations(context, sourcePixels.data, canvas.width, canvas.height, translatedLines as MangaRegion[],true,backgrounds,protection);
            if(placed.length){
                // 已逐像素证明的原纯白区域不需要修补模型，也不清除任何原文。
                drawMangaTranslations(context,sourcePixels.data,width,height,placed.map(item=>item.region),true,
                    placed.map(()=>({color:'rgb(255,255,255)',uniform:true})));
                const visible=new Set(placed.map(item=>item.index));let readingIndex=0;
                for(const [index,line] of lines.entries())if(!line.guardOnly){
                    if(visible.has(index))delete readingLines[readingIndex].renderSkipped;
                    readingIndex++;
                }
            }
            await checkImageCancellation(signal);
            const patches: MangaPatchPacket['patches'] = [];
            for (const rect of mangaPatchRects([...translatedLines as MangaRegion[],...placed.map(item=>item.region)], canvas.width, canvas.height)) {
                const patchCanvas = document.createElement('canvas');
                try {
                    patchCanvas.width = rect.width; patchCanvas.height = rect.height;
                    const patchContext = patchCanvas.getContext('2d');
                    if (!patchContext) throw new Error('浏览器不支持图片处理');
                    patchContext.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
                    patches.push({...rect, image: await encodeImageCanvas(patchCanvas, signal)});
                    throwIfImageOperationAborted(signal);
                } finally {patchCanvas.width = 0; patchCanvas.height = 0;}
            }
            return {image: '', mangaPatches: {width: canvas.width, height: canvas.height, patches}, lines: readingLines};
        }
        let sourceUnchanged=true;
        try {
        // 先在原图上准入整个擦字/绘字足迹。undefined在严格模式下仅表示已确认无需保护。
        const protection=planMaskAlphaProtection(sourcePixels.data,canvas.width,canvas.height,translatedLines,imageAlphaSamplingAndWriteBoxes,{requireConfirmedTransparency:true});
        const fontLimits=new Map<ImageTextRegion,number>();
        for(const candidate of candidates)if(!skipped.has(candidate.index))fontLimits.set(candidate.translated,getImageSourceFontLimit(context,candidate.original));
        const selected=candidates.filter(candidate=>!skipped.has(candidate.index));
        const baseBounds=new Map(lines.map(line=>[line,imageDrawBounds(line,canvas.width,canvas.height)]));
        const appearances=observeImageSourceAppearances(sourcePixels.data,canvas.width,canvas.height,selected.map(c=>c.original),line=>baseBounds.get(line)!);
        const drawing=new Map<ImageTextRegion,{bounds:OcrLine['bbox'];prepared?:ImageTranslationTextLayout;foreground?:string;background?:string}>();
        const expansionBudget={remaining:262_144};
        function* otherTextBoxes(owner:ImageTextRegion){
            for(const line of lines)if(line!==owner){
                yield baseBounds.get(line)!;
                for(let index=-1;index<(line.sourceBoxes?.length??0);index++){
                    const box=index<0?line.bbox:line.sourceBoxes![index];
                    yield {x0:Math.max(0,Math.floor(box.x0)-2),y0:Math.max(0,Math.floor(box.y0)-2),
                        x1:Math.min(canvas.width,Math.ceil(box.x1)+2),y1:Math.min(canvas.height,Math.ceil(box.y1)+2)};
                }
            }
        }
        for(const candidate of selected){
            const original=candidate.original,appearance=appearances.get(original),limit=fontLimits.get(candidate.translated)!;
            let bounds=baseBounds.get(original)!;
            if(appearance&&!original.vertical&&!original.ruby?.length&&(!original.sourceBoxes||original.sourceBoxes.length===1)
                &&limit!==(original.fontSize??original.bbox.y1-original.bbox.y0)*1.2){
                const required=getImageSingleLineHeight(context,candidate.translated.text,bounds.x1-bounds.x0,limit);
                if(required!==undefined&&required>bounds.y1-bounds.y0)bounds=expandImageTextBounds(sourcePixels.data,canvas.width,canvas.height,bounds,required,appearance,
                    otherTextBoxes(original),expansionBudget);
            }
            baseBounds.set(original,bounds);drawing.set(candidate.translated,{bounds,...(appearance?{background:`rgb(${appearance.background.slice(0,3).join(',')})`}:{}),...(appearance?.foreground?{foreground:appearance.foreground}:{})});
        }
        if(protection){
            const budget={remaining:1_048_576};
            for(const line of translatedLines){
                throwIfImageOperationAborted(signal);
                const original=drawing.get(line)!.bounds,available=mangaAlphaClearRects(protection,original,budget);
                let bounds:OcrLine['bbox']|undefined,area=0;
                for(const candidate of available){const size=(candidate.x1-candidate.x0)*(candidate.y1-candidate.y0);if(size>area){bounds=candidate;area=size;}}
                if(!bounds)throw new ImageAlphaProtectionUnavailableError();
                const changed=bounds.x0!==original.x0||bounds.y0!==original.y0||bounds.x1!==original.x1||bounds.y1!==original.y1;
                const maxFontSize=fontLimits.get(line)!;
                const prepared=changed?prepareImageAlphaTextLayout(context,line.text,bounds,maxFontSize,line.vertical?'center':line.textAlign??'left'):undefined;
                if(changed&&!prepared)throw new ImageAlphaProtectionUnavailableError();
                drawing.set(line,{...drawing.get(line)!,bounds,prepared});
            }
        }
        // 全文布局先全部通过才擦除；保护点不可写也不可当作已知背景，无法完整修补时撤回。
        sourceUnchanged=false;
        const pixels = protection ? inpaintTextRegions(sourcePixels.data, canvas.width, canvas.height, translatedLines, true, protection)
            : inpaintTextRegions(sourcePixels.data, canvas.width, canvas.height, translatedLines, true);
        await checkImageCancellation(signal);
        context.putImageData(sourcePixels, 0, 0);

        const renderedLines = translatedLines.map(line => ({
            ...line,
            backgroundColor: drawing.get(line)!.background??getImageTextBackgroundColor(pixels, canvas.width, canvas.height, line.bbox),
            drawing:drawing.get(line)!,
            maxFontSize:fontLimits.get(line)!,
        }));
        for(const line of renderedLines){
            throwIfImageOperationAborted(signal);
            const plan=line.drawing,bounds=plan.bounds;
            if(plan.foreground)drawTranslatedImageText(context,line.text,bounds.x0,bounds.y0,bounds.x1-bounds.x0,bounds.y1-bounds.y0,
                line.backgroundColor,line.maxFontSize,line.vertical?'center':line.textAlign??'left',plan.prepared,plan.foreground);
            else if(plan.prepared)drawTranslatedImageText(context,line.text,bounds.x0,bounds.y0,bounds.x1-bounds.x0,bounds.y1-bounds.y0,
                line.backgroundColor,line.maxFontSize,line.vertical?'center':line.textAlign??'left',plan.prepared);
            else drawTranslatedImageText(context,line.text,bounds.x0,bounds.y0,bounds.x1-bounds.x0,bounds.y1-bounds.y0,
                line.backgroundColor,line.maxFontSize,line.vertical?'center':line.textAlign??'left');
        }
        await checkImageCancellation(signal);
        const image = await encodeImageCanvas(canvas, signal);
        throwIfImageOperationAborted(signal);
        return { image, lines: readingLines };
        } catch(error) {
            if(!(error instanceof MangaAlphaProtectionLimitError)&&!(error instanceof ImageAlphaProtectionUnavailableError))throw error;
            if(sourceUnchanged&&error instanceof ImageAlphaProtectionUnavailableError&&support&&isSingleFrameImageData(source.currentSrc||source.src)){
                const selected=new Set(candidates.filter(candidate=>!skipped.has(candidate.index)).map(candidate=>candidate.original));
                const rescued=await renderImageMatteRescue(context,canvas,sourcePixels,translatedLines,lines.filter(line=>!selected.has(line)),readingLines,support,signal);
                if(rescued)return rescued;
            }
            await checkImageCancellation(signal);
            return imageAlphaUnchanged(readingLines);
        }
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

export async function translateImageInOffscreen(
    image: string,
    sourceLanguage: string,
    title: string,
    signal?: AbortSignal,
    requestId?: string,
    manga = false,
    ocrEngine: 'tesseract' | 'paddle' = 'tesseract',
    mangaViewport?:ImageViewport,
    inferenceBackend?: 'auto' | 'cpu',
): Promise<OffscreenImageTranslationResult> {
    if (inferenceBackend !== undefined) mangaInferenceClient.setBackend(inferenceBackend);
    // 提前验证输出预算，避免巨大输入完成 OCR 和付费翻译后才在生成译图时失败。
    const source = await loadImage(image, signal);
    try {
        throwIfImageOperationAborted(signal);
        const usePaddle = (manga ? getMangaOcrEngine(sourceLanguage) : ocrEngine) === 'paddle';
        if (!usePaddle) reportProgress(requestId, 'recognizing');
        const recognized = usePaddle ? await mangaOcrRuntime.recognize(image, sourceLanguage, source.naturalWidth || source.width,
            source.naturalHeight || source.height, signal,
            (stage, percent) => {if (!signal?.aborted) reportProgress(requestId, stage, percent);}, source, manga ? 'manga' : 'image') : await recognizeImage(image, sourceLanguage, signal, {
            decodedImage: source,
            includeMangaNumericConfidence: true,
            onProgress: percent => { if (!signal?.aborted) reportProgress(requestId, 'recognizing', percent); },
        });
        throwIfImageOperationAborted(signal);
        const guards:ImageTextRegion[]=[],guardKeys=new Map<string,{text?:string;conflict?:true; bbox:OcrLine['bbox']}>();
        const width=source.naturalWidth || source.width,height=source.naturalHeight || source.height;
        const detectionSupport=manga?undefined:getImageDetectionEvidence(recognized,image,source.naturalWidth||source.width,source.naturalHeight||source.height);
        const eligible=recognized.filter(line=>{
            const numericConfidence='numericConfidence' in line ? line.numericConfidence : undefined;
            const suspected=line.guardOnly || (!usePaddle && numericProtection(line.text)
                && !(typeof numericConfidence==='number' && Number.isFinite(numericConfidence) && numericConfidence>=90 && numericConfidence<=100));
            if(!suspected)return true;
            const b=line.bbox;
            if(!b||![b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)||b.x1<=b.x0||b.y1<=b.y0)
                throw new Error('图片数字保护位置无效，已保留原图');
            const bbox={x0:Math.max(0,b.x0),y0:Math.max(0,b.y0),x1:Math.min(width,b.x1),y1:Math.min(height,b.y1)};
            if(bbox.x1<=bbox.x0||bbox.y1<=bbox.y0)return false;
            const key=[bbox.x0,bbox.y0,bbox.x1,bbox.y1].join(',');
            const evidence='numericGuardText' in line ? line.numericGuardText : line.text || undefined;
            const text=evidence===undefined?undefined:numericEvidenceKey(evidence);
            const conflict='numericGuardConflict' in line && line.numericGuardConflict === true;
            const previous=guardKeys.get(key);
            if(previous){if(conflict || previous.text!==text)previous.conflict=true;return false;}
            if(guards.length>=4096)throw new Error('图片数字保护区域过于复杂，已保留原图');
            guardKeys.set(key,{bbox,text,...(conflict?{conflict:true as const}:{})});guards.push({text:'',bbox,guardOnly:true});return false;
        });
        const readable:ImageTextRegion[] = manga ? usePaddle ? eligible : groupMangaOcrLines(eligible, sourceLanguage,
            source.naturalWidth || source.width, source.naturalHeight || source.height)
            : groupImageParagraphs(eligible.map(line => numericProtection(line.text) ? {...line,sourceBoxes:[line.bbox]} : line),
                usePaddle?getImageParagraphGapEvidence(recognized,image,width,height):undefined);
        if (!usePaddle) {
            // 原始数值证据仅用于本地提示，不进入阅读结果或翻译请求。
            const numbers=readable.filter(line=>numericProtection(line.text)).map(line=>({line,key:numericEvidenceKey(line.text)}));
            let comparisons=0,exhausted=false;
            for(const guard of guardKeys.values()) {
                const guardKey=guard.text;
                for(const number of numbers) {
                    const {line,key}=number;
                    if(++comparisons>1_000_000){exhausted=true;break;}
                    const a=guard.bbox,b=line.bbox;
                    if(a.x0<b.x1 && b.x0<a.x1 && a.y0<b.y1 && b.y0<a.y1
                        && (guard.conflict || guardKey!==key))
                        line.numericUncertain=true;
                }
                if(exhausted)break;
            }
            // 原始同值框可能已被可信结果覆盖而省略，但其他可信结果仍可能与其冲突。
            for(let i=0;!exhausted && i<numbers.length;i++) for(let j=i+1;j<numbers.length;j++) {
                if(++comparisons>1_000_000){exhausted=true;break;}
                const left=numbers[i],right=numbers[j],a=left.line.bbox,b=right.line.bbox;
                if(a.x0<b.x1 && b.x0<a.x1 && a.y0<b.y1 && b.y0<a.y1
                    && left.key!==right.key)
                    left.line.numericUncertain=right.line.numericUncertain=true;
            }
            if(exhausted)numbers.forEach(({line})=>line.numericUncertain=true);
        }
        if (readable.length === 0) {
            if (manga) return {image,lines:[]};
            if (recognized.length === 0) return {image:'',imageUnchanged:true,lines:[]};
            throw new Error('没有识别到图片文字');
        }
        const lines:ImageTextRegion[]=[...readable,...guards];
        const translatable = lines.map((line, index) => ({line, index})).filter(({line}) => !line.guardOnly && !numericProtection(line.text));
        const translations = lines.map(line => line.text);
        if (translatable.length) {
            reportProgress(requestId, 'translating');
            const translated = await translateImageTextsInExtension(translatable.map(({line}) => line.text), title, requestId, signal);
            translatable.forEach(({index}, position) => {translations[index] = translated[position] ?? lines[index].text;});
        }
        throwIfImageOperationAborted(signal);
        reportProgress(requestId, manga ? 'cleaning' : 'rendering');
        return await prepareTranslatedImage(source, lines, translations, signal, manga, requestId,detectionSupport,manga?image:undefined,mangaViewport);
    } finally {
        source.src = '';
    }
}

export async function translateAreaInOffscreen(
    image: string,
    sourceLanguage: string,
    _title: string,
    selection: AreaTranslationSelection,
    signal?: AbortSignal,
    _requestId?: string,
): Promise<AreaRecognitionResult> {
    const croppedImage = await cropImage(image, selection, signal);
    throwIfImageOperationAborted(signal);
    const lines = await recognizeImage(croppedImage, sourceLanguage, signal, {profile: 'area'});
    throwIfImageOperationAborted(signal);
    if (lines.length === 0) throw new Error('没有识别到圈选区域文字');
    return {image: croppedImage, lines};
}

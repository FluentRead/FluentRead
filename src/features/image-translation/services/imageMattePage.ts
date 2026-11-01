/**
 * @file src/features/image-translation/services/imageMattePage.ts
 * 文件职责：在普通图片的严格透明准入失败后，原子规划同一原始帧的完整 RGBA 墨迹修补。
 * 主要内容：共享整页观察、绘字扫描、候选和碰撞预算，逐物理源框验证局部背景；保留原文与相邻行的原像素必须避开实际新墨迹支持；绘字框内未归属源墨且不同于观测背景的像素只作图案保护；全页填充与图案冲突即撤回，精确墨迹行段合并为有界脏矩形，仅上传确实改变的字形像素，不回写整页图案。
 * 模块边界：纯数据规划和独占像素写入，不创建 Canvas、不运行模型、不修改 OCR；仅消费同帧局部 RGBA 证明，不能证明相连同色装饰的语义。调用方必须先完成所有完整译文字形预检，再一次性应用并上传。
 */
import type {ImageTextRegion} from '../paragraphs';
import {imageMatteObservationBox,planImageMatteRepair,type ImageMatteRepair} from './imageMatteRepair';
import type {ImageDetectionSupport} from './imageDetectionEvidence';

type Box=ImageTextRegion['bbox'];
type Rgba=readonly [number,number,number,number];
type Run={y:number;x0:number;x1:number};
export interface ImageMattePageDrawing {readonly line:ImageTextRegion;readonly bounds:Readonly<Box>;readonly background:Rgba}
export interface ImageMattePagePlan {
    readonly drawings:readonly ImageMattePageDrawing[];
    readonly rectangles:readonly Readonly<Box>[];
    /** 半开原图坐标，仅覆盖已经确认的墨迹，不能以包络代替这些上传授权。 */
    readonly uploads:readonly Readonly<Box>[];
}
interface Authority {pixels:Uint8ClampedArray;width:number;height:number;repairs:ImageMatteRepair[];applied:boolean}
const authorities=new WeakMap<ImageMattePagePlan,Authority>();
const MAX_PIXELS=1_048_576,MAX_CHECKS=1_048_576,MAX_ATTEMPTS=128,MAX_RUNS=65_536,MAX_RECTS=4096,MAX_RETAINED_BOXES=8192;
const valid=(b:Box)=>[b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)&&b.x1>b.x0&&b.y1>b.y0;
const overlap=(a:Box,b:Box)=>a.x0<b.x1&&b.x0<a.x1&&a.y0<b.y1&&b.y0<a.y1;
const equal=(a:Rgba,b:Rgba)=>a.every((value,index)=>value===b[index]);
const matches=(pixels:Uint8ClampedArray,offset:number,rgba:Rgba)=>pixels[offset]===rgba[0]&&pixels[offset+1]===rgba[1]
    &&pixels[offset+2]===rgba[2]&&pixels[offset+3]===rgba[3];
function integerBox(box:Box,width:number,height:number):Box|undefined {
    if(!valid(box))return;
    const result={x0:Math.max(0,Math.floor(box.x0)),y0:Math.max(0,Math.floor(box.y0)),
        x1:Math.min(width,Math.ceil(box.x1)),y1:Math.min(height,Math.ceil(box.y1))};
    return result.x1>result.x0&&result.y1>result.y0?result:undefined;
}
function appendMaskRuns(plan:ImageMatteRepair,mask:Uint8Array,rows:Run[],limit:number):boolean {
    for(let y=0;y<plan.height;y++){
        let start=-1;
        for(let x=0;x<=plan.width;x++){
            if(x<plan.width&&mask[y*plan.width+x]!==0){if(start<0)start=x;}
            else if(start>=0){rows.push({y:plan.top+y,x0:plan.left+start,x1:plan.left+x});start=-1;if(rows.length>limit)return false;}
        }
    }
    return true;
}
function unionRuns(rows:Run[]):Run[] {
    rows.sort((a,b)=>a.y-b.y||a.x0-b.x0||a.x1-b.x1);
    const result:Run[]=[];
    for(const row of rows){
        const last=result[result.length-1];
        if(last&&last.y===row.y&&row.x0<=last.x1)last.x1=Math.max(last.x1,row.x1);
        else result.push({...row});
    }
    return result;
}
function rectangles(rows:Run[]):Readonly<Box>[]|undefined {
    const result:Box[]=[];let previous=new Map<string,Box>(),next=new Map<string,Box>(),y=-2;
    for(const row of rows){
        if(row.y!==y){previous=row.y===y+1?next:new Map();next=new Map();y=row.y;}
        const key=`${row.x0},${row.x1}`;let box=previous.get(key);
        if(box)box.y1=row.y+1;
        else {box={x0:row.x0,y0:row.y,x1:row.x1,y1:row.y+1};result.push(box);if(result.length>MAX_RECTS)return;}
        next.set(key,box);
    }
    return result.map(box=>Object.freeze(box));
}

/** 原框不变；所有局部证明和所有碰撞均使用尚未回写的同一原始 ImageData。 */
export function planImageMattePage(
    pixels:Uint8ClampedArray,width:number,height:number,lines:ImageTextRegion[],retained:ImageTextRegion[],
    drawBounds:(line:ImageTextRegion,width:number,height:number)=>Box,support?:ImageDetectionSupport,
):ImageMattePagePlan|undefined {
    if(!(pixels instanceof Uint8ClampedArray)||![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192)
        ||width*height>16_777_216||pixels.length<width*height*4||lines.length===0||lines.length>MAX_ATTEMPTS||!support)return;
    let remainingPixels=MAX_PIXELS,checks=MAX_CHECKS,attempts=0,retainedBoxes=0;
    const reserve=(amount:number)=>Number.isSafeInteger(amount)&&amount>0&&(remainingPixels-=amount)>=0;
    const repairs:ImageMatteRepair[]=[],drawings:ImageMattePageDrawing[]=[],artRows:Run[]=[],inkRows:Run[]=[];
    const protectedBoxes:Box[]=[];
    const fitBudget={remaining:4_194_304};
    for(const line of retained){
        const sources=line.sourceBoxes;
        for(let index=-1;index<(sources?.length??0);index++){
            const b=index<0?line.bbox:sources![index];
            if(++retainedBoxes>MAX_RETAINED_BOXES||!valid(b))return;
            const box=integerBox({x0:b.x0-2,y0:b.y0-2,x1:b.x1+2,y1:b.y1+2},width,height);
            if(box)protectedBoxes.push(box);
        }
    }
    for(const line of lines){
        const sources=line.sourceBoxes??[line.bbox];if(!sources.length||sources.length>MAX_ATTEMPTS-attempts)return;
        const bounds=drawBounds(line,width,height),draw=integerBox(bounds,width,height);
        if(!draw||bounds.x0<0||bounds.y0<0||bounds.x1>width||bounds.y1>height)return;
        if(!reserve((draw.x1-draw.x0)*(draw.y1-draw.y0)))return;
        for(const old of drawings){if(--checks<0||overlap(draw,old.bounds))return;}
        for(const box of protectedBoxes){if(--checks<0||overlap(draw,box))return;}
        const group:ImageMatteRepair[]=[];
        for(const source of sources){
            attempts++;
            const observation=imageMatteObservationBox(width,height,source);
            if(!observation||!reserve(observation.width*observation.height))return;
            const supportAt=support.forBox(source,observation);if(!supportAt)return;
            const plan=planImageMatteRepair(pixels,width,height,source,supportAt,fitBudget);if(!plan)return;
            if(group.length&&!equal(group[0].background,plan.background))return;
            // 支持可超出原排版框；不同背景不能按应用顺序争用同一个原墨迹像素。
            for(const old of repairs){
                if(--checks<0)return;
                if(equal(old.background,plan.background)||!overlap(old.supportBox,plan.supportBox))continue;
                const x0=Math.max(old.supportBox.x0,plan.supportBox.x0),y0=Math.max(old.supportBox.y0,plan.supportBox.y0);
                const x1=Math.min(old.supportBox.x1,plan.supportBox.x1),y1=Math.min(old.supportBox.y1,plan.supportBox.y1);
                for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
                    if(--checks<0)return;
                    if(old.mask[(y-old.top)*old.width+x-old.left]&&plan.mask[(y-plan.top)*plan.width+x-plan.left])return;
                }
            }
            if(!appendMaskRuns(plan,plan.artMask,artRows,MAX_RUNS-inkRows.length)
                ||!appendMaskRuns(plan,plan.mask,inkRows,MAX_RUNS-artRows.length))return;
            for(const box of protectedBoxes){
                if(--checks<0)return;
                if(!overlap(plan.supportBox,box))continue;
                for(let y=0;y<plan.height;y++)for(let x=0;x<plan.width;x++){
                    if(--checks<0)return;
                    if(plan.mask[y*plan.width+x]&&plan.left+x>=box.x0&&plan.left+x<box.x1&&plan.top+y>=box.y0&&plan.top+y<box.y1)return;
                }
            }
            group.push(plan);repairs.push(plan);
        }
        const background=group[0].background;
        for(let y=draw.y0;y<draw.y1;y++){
            let start=-1;
            for(let x=draw.x0;x<=draw.x1;x++){
                let blocked=false;
                if(x<draw.x1&&!matches(pixels,(y*width+x)*4,background)){
                    let ink=false;
                    for(const plan of group){
                        if(--checks<0)return;
                        if(x>=plan.left&&x<plan.left+plan.width&&y>=plan.top&&y<plan.top+plan.height
                            &&plan.mask[(y-plan.top)*plan.width+x-plan.left]){ink=true;break;}
                    }
                    blocked=!ink;
                }
                if(blocked){if(start<0)start=x;}
                else if(start>=0){artRows.push({y,x0:start,x1:x});start=-1;if(artRows.length+inkRows.length>MAX_RUNS)return;}
            }
        }
        drawings.push(Object.freeze({line,bounds:Object.freeze({...bounds}),background:Object.freeze([...background]) as Rgba}));
    }
    const ink=unionRuns(inkRows),art=unionRuns(artRows);
    // 一个区域的旧字不能是另一区域必须保留的画面；共享原图规划完毕后才作这一全局检查。
    let cursor=0;
    for(const run of ink){
        while(cursor<art.length&&(art[cursor].y<run.y||(art[cursor].y===run.y&&art[cursor].x1<=run.x0))){if(--checks<0)return;cursor++;}
        if(cursor<art.length&&art[cursor].y===run.y&&art[cursor].x0<run.x1)return;
    }
    const uploads=rectangles(ink),holes=rectangles(art);if(!uploads||!holes)return;
    const result:ImageMattePagePlan={drawings:Object.freeze(drawings),rectangles:Object.freeze(holes),uploads:Object.freeze(uploads)};
    authorities.set(result,{pixels,width,height,repairs,applied:false});
    return Object.freeze(result);
}

/** 只有原规划的独占像素可使用一次；不把支持包络当作擦字蒙版，也不采样任何外部图案。 */
export function applyImageMattePage(pixels:Uint8ClampedArray,width:number,height:number,plan:ImageMattePagePlan):void {
    const authority=authorities.get(plan);
    if(!authority||authority.applied||authority.pixels!==pixels||authority.width!==width||authority.height!==height)throw new Error('图片背景修补计划已失效');
    authority.applied=true;
    for(const repair of authority.repairs)for(let y=0;y<repair.height;y++)for(let x=0;x<repair.width;x++){
        if(repair.mask[y*repair.width+x])pixels.set(repair.background,((repair.top+y)*width+repair.left+x)*4);
    }
}

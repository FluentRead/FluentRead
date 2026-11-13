/**
 * @file src/features/image-translation/services/sourceAppearance.ts
 * 文件职责：从尚未修补的同帧原像素确认可复用的文字颜色，并验证普通译文字框的少量垂直扩展。
 * 主要内容：复用闭环静区和共同墨色端点观察，只接受不透明、整段背景一致的源区域；注音不决定正文字色，混色正文不猜测。源色对背景至少4.5:1时才提供字色，其余保留高对比默认；全部候选预付有界像素预算，避免顺序决定大页只有前半部换色。扩展仅扫描新增像素、保持原横向边界、避开所有其他文字，并要求完整新增范围仍是同一不透明底色。
 * 模块边界：只读像素和几何，不授权清字、不扩大擦除mask、不改变OCR或翻译，也不读取DOM；调色板不替代原透明保护和原文保护。对比度是局部采用门槛，不代表整页符合可访问性规范。
 * 渐变观察：原静区观察不足时，可在整段完整边界及物理字框内验证共同墨色；渐变只提供字色与细对比描边，不提供纯色背景或扩框权限，注音和已确认的混色/行间图案不进入此后备路径。
 */
import type {ImageTextRegion} from '../paragraphs';
import {imageMatteObservationBox,observeImageMattePalette} from './imageMatteRepair';
import {getImageRgbContrast} from './rendering';
import {observeImageSourceInk,type ImageSourceInk} from './sourceInk';

type Box=ImageTextRegion['bbox'];
export type ImageSourceAppearance=ImageSourceInk;
const sameBox=(a:Box,b:Box)=>a.x0===b.x0&&a.y0===b.y0&&a.x1===b.x1&&a.y1===b.y1;
const intersects=(a:Box,b:Box)=>a.x0<b.x1&&a.x1>b.x0&&a.y0<b.y1&&a.y1>b.y0;
const valid=(b:Box|undefined|null,w:number,h:number):b is Box=>!!b&&[b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)&&b.x0>=0&&b.y0>=0&&b.x1<=w&&b.y1<=h&&b.x1>b.x0&&b.y1>b.y0;
const equalColor=(a:readonly number[],b:readonly number[])=>a.every((value,index)=>value===b[index]);

/** 整段的非文字间隙也必须是已观测底色，不能跨图案把原色应用到另一种背景。 */
function flatBetweenSources(pixels:Uint8ClampedArray,width:number,box:Box,sources:Box[],background:readonly number[]):boolean {
    const left=Math.floor(box.x0),right=Math.ceil(box.x1);
    for(let y=Math.floor(box.y0);y<Math.ceil(box.y1);y++){
        const spans=sources.filter(b=>y>=Math.floor(b.y0)&&y<Math.ceil(b.y1)).map(b=>[Math.floor(b.x0),Math.ceil(b.x1)]).sort((a,b)=>a[0]-b[0]);
        let x=left,index=0;
        while(x<right){
            while(index<spans.length&&spans[index][1]<=x)index++;
            if(index<spans.length&&spans[index][0]<=x){x=Math.min(right,spans[index][1]);continue;}
            const offset=(y*width+x)*4;
            if(!background.every((value,c)=>pixels[offset+c]===value))return false;
            x++;
        }
    }
    return true;
}

/** 同页预算先整体检查；分析失败仅撤回样式，不删除识别文本或中断原翻译流程。 */
export function observeImageSourceAppearances(pixels:Uint8ClampedArray,width:number,height:number,regions:readonly ImageTextRegion[],drawBounds:(region:ImageTextRegion)=>Box=region=>region.bbox):Map<ImageTextRegion,ImageSourceAppearance> {
    const result=new Map<ImageTextRegion,ImageSourceAppearance>();
    if(![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||width*height>16_777_216||pixels.length<width*height*4||regions.length>4096)return result;
    const jobs:Array<{region:ImageTextRegion;bounds:Box;sources:Box[];main:Box[]}> = [];let cost=0,checks=0;
    for(const region of regions){
        if(!region)continue;
        const sources=region.sourceBoxes??[region.bbox],ruby=region.ruby??[];
        if(region.guardOnly||!Array.isArray(sources)||!sources.length||sources.length>128||!Array.isArray(ruby)||ruby.length>128||!valid(region.bbox,width,height)
            ||!Array.from(sources).every(b=>valid(b,width,height))||!Array.from(ruby).every(r=>r&&valid(r.bbox,width,height)))continue;
        const bounds=drawBounds(region);if(!valid(bounds,width,height))continue;
        const main=sources.filter(b=>!ruby.some(annotation=>sameBox(b,annotation.bbox)));
        if(!main.length)continue;
        const rois=main.map(b=>imageMatteObservationBox(width,height,b));if(rois.some(r=>!r))continue;
        const area=(Math.ceil(bounds.x1)-Math.floor(bounds.x0))*(Math.ceil(bounds.y1)-Math.floor(bounds.y0));
        if(area>262_144)continue;
        cost+=area+rois.reduce((sum,r)=>sum+r!.width*r!.height,0);
        checks+=(Math.ceil(bounds.y1)-Math.floor(bounds.y0))*(sources.length+main.length)+sources.length*ruby.length;
        const fallback=ruby.length?undefined:imageMatteObservationBox(width,height,bounds);
        if(fallback){cost+=fallback.width*fallback.height*2;checks+=fallback.height*sources.length;}
        if(cost>2_097_152||checks>1_048_576)return result;
        jobs.push({region,bounds,sources,main});
    }
    const budget={remaining:2_097_152};
    for(const {region,bounds,sources,main} of jobs){
        const palettes=main.map(b=>observeImageMattePalette(pixels,width,height,b,budget));
        if(palettes.some(p=>!p)){
            if(!region.ruby?.length){const appearance=observeImageSourceInk(pixels,width,height,bounds,sources);if(appearance)result.set(region,appearance);}
            continue;
        }
        const first=palettes[0]!;
        if(!palettes.every(p=>equalColor(p!.background,first.background)&&equalColor(p!.ink,first.ink)))continue;
        if(!flatBetweenSources(pixels,width,bounds,[...sources,...palettes.map(p=>p!.supportBox)],first.background))continue;
        const foreground=getImageRgbContrast(first.ink,first.background)>=4.5?`rgb(${first.ink.slice(0,3).join(',')})`:undefined;
        result.set(region,{background:first.background,...(foreground?{foreground}:{})});
    }
    return result;
}

/** 新增行高至多向两侧各十二像素；所有新增像素与其他文字范围均先验证，不修改原框。 */
export function expandImageTextBounds(pixels:Uint8ClampedArray,width:number,height:number,original:Box,requiredHeight:number,
    appearance:ImageSourceAppearance,obstacles:Iterable<Box>,budget:{remaining:number}):Box {
    if(![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||pixels.length<width*height*4||!valid(original,width,height)||!Number.isFinite(requiredHeight)||!Number.isSafeInteger(budget.remaining)||budget.remaining<0)return original;
    const extra=Math.ceil((requiredHeight-(original.y1-original.y0))/2);
    if(extra<=0||extra>12||!appearance.background||appearance.background.length!==4||appearance.background[3]!==255)return original;
    const proposed={...original,y0:original.y0-extra,y1:original.y1+extra};
    if(!valid(proposed,width,height))return original;
    const left=Math.floor(proposed.x0),right=Math.ceil(proposed.x1),top=Math.floor(proposed.y0),bottom=Math.ceil(proposed.y1);
    const cost=(right-left)*(bottom-top-(Math.floor(original.y1)-Math.ceil(original.y0)));
    if(cost>budget.remaining)return original;
    for(const obstacle of obstacles){
        if(--budget.remaining<cost||!valid(obstacle,width,height)||intersects(obstacle,proposed))return original;
    }
    budget.remaining-=cost;
    for(let y=top;y<bottom;y++){
        if(y>=Math.ceil(original.y0)&&y<Math.floor(original.y1))continue;
        for(let x=left;x<right;x++){
            const offset=(y*width+x)*4;
            if(!appearance.background.every((value,c)=>pixels[offset+c]===value))return original;
        }
    }
    return proposed;
}

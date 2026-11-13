/**
 * @file src/features/image-translation/services/sourceInk.ts
 * 文件职责：只读观察纯色或平滑渐变底上的共同源字色，为译文保留可确认的视觉样式。
 * 主要内容：完整不透明外周校验双线性背景，所有显著差异限于原物理字框四像素内，以包含真实OCR框外的抗锯齿尾缘；从实际重复墨色中选取主色，再验证每个墨迹像素都能由同一颜色与局部背景混合得到。渐变容忍仅覆盖八位量化，不用它授予清字权限；纯色底的框外空处要求逐字节一致。单项六万五千像素、四千颜色和一百二十八物理框有硬上限，整页预算由调用方预付。
 * 模块边界：不修改像素、不返回掩码或修补计划，不推断字体、语义或艺术归属；纯色沿用4.5的局部对比门槛，渐变至少3并另给细对比描边，均不代表缩放后页面的可访问性认证。混色、纹理、透明或证据不足时保持未知。
 */
import type {OcrLine} from '@/src/shared/image/types';
import {imageMatteObservationBox,type ImageMattePalette} from './imageMatteRepair';
import {getImageRgbContrast,getImageRgbLuminance,getImageTextColor} from './rendering';

type Box=OcrLine['bbox'];
export interface ImageSourceInk {background?:ImageMattePalette['background'];foreground?:string;outline?:string}
const TOLERANCE=1.5;

/** 每个颜色通道必须共享同一个覆盖率；色差不是字形或擦除证明。 */
function sameInk(pixel:readonly number[],background:readonly number[],ink:readonly number[]):boolean {
    let low=0,high=1;
    for(let c=0;c<3;c++){
        const delta=ink[c]-background[c],offset=pixel[c]-background[c];
        if(delta===0){if(Math.abs(offset)>TOLERANCE)return false;continue;}
        const a=(offset-TOLERANCE)/delta,b=(offset+TOLERANCE)/delta;
        low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));
        if(low>high)return false;
    }
    return true;
}

/** 仅在已通过页预算的候选上调用；结果不允许扩张或替代原清字范围。 */
export function observeImageSourceInk(pixels:Uint8ClampedArray,width:number,height:number,bounds:Box,sources:readonly Box[]):ImageSourceInk|undefined {
    const roi=imageMatteObservationBox(width,height,bounds);
    if(!roi||pixels.length<width*height*4||!sources.length||sources.length>128)return;
    if(sources.some(b=>b.x1<=b.x0||b.y1<=b.y0))return;
    const {left,top,width:w,height:h}=roi;
    if(left>=bounds.x0||top>=bounds.y0||left+w<=bounds.x1||top+h<=bounds.y1)return;
    const boxes=sources.map(b=>({x0:Math.floor(b.x0)-4,y0:Math.floor(b.y0)-4,x1:Math.ceil(b.x1)+4,y1:Math.ceil(b.y1)+4}));
    if(boxes.some(b=>![b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)||b.x0<=left||b.y0<=top||b.x1>=left+w||b.y1>=top+h||b.x1<=b.x0||b.y1<=b.y0))return;
    const read=(x:number,y:number):[number,number,number,number]=>{const p=((top+y)*width+left+x)*4;return [pixels[p],pixels[p+1],pixels[p+2],pixels[p+3]];};
    const corners=[read(0,0),read(w-1,0),read(0,h-1),read(w-1,h-1)];
    if(corners.some(c=>c[3]!==255))return;
    const flat=corners.every(c=>c.every((v,i)=>v===corners[0][i]));
    if(!flat&&Math.max(...[0,1,2].map(c=>Math.max(...corners.map(p=>p[c]))-Math.min(...corners.map(p=>p[c]))))<4)return;
    const background=(x:number,y:number)=>{
        if(flat)return corners[0].slice(0,3);
        const u=x/(w-1),v=y/(h-1);
        return [0,1,2].map(c=>(corners[0][c]*(1-u)+corners[1][c]*u)*(1-v)+(corners[2][c]*(1-u)+corners[3][c]*u)*v);
    };
    const matches=(x:number,y:number)=>{const p=read(x,y),b=background(x,y);return p[3]===255&&b.every((value,c)=>Math.abs(value-p[c])<=(flat?0:1));};
    for(let x=0;x<w;x++)if(!matches(x,0)||!matches(x,h-1))return;
    for(let y=1;y<h-1;y++)if(!matches(0,y)||!matches(w-1,y))return;
    const colors=new Map<number,number>(),inkPixels=new Uint32Array(w*h);let inkCount=0;
    for(let y=1;y<h-1;y++){
        const spans=boxes.filter(b=>top+y>=b.y0&&top+y<b.y1).sort((a,b)=>a.x0-b.x0);let span=0;
        for(let x=1;x<w-1;x++){
            const pixel=read(x,y),b=background(x,y);if(pixel[3]!==255)return;
            while(span<spans.length&&spans[span].x1<=left+x)span++;
            const inSource=span<spans.length&&spans[span].x0<=left+x;
            const quiet=b.every((value,c)=>Math.abs(value-pixel[c])<=(flat?0:1));
            if(!inSource){if(!quiet)return;continue;}
            if(quiet)continue;
            inkPixels[inkCount++]=y*w+x;
            const color=pixel[0]|pixel[1]<<8|pixel[2]<<16;
            colors.set(color,(colors.get(color)??0)+1);if(colors.size>4096)return;
        }
    }
    let candidate=0,count=0;
    for(const [color,n] of colors)if(n>count){candidate=color;count=n;}
    if(count<8||count<inkCount*.1)return;
    const ink=[candidate&255,candidate>>>8&255,candidate>>>16&255];
    for(let i=0;i<inkCount;i++){
        const x=inkPixels[i]%w,y=Math.floor(inkPixels[i]/w);
        if(!sameInk(read(x,y),background(x,y),ink))return;
    }
    const foreground=`rgb(${ink.join(',')})`;
    if(flat)return {background:[...corners[0]] as ImageMattePalette['background'],...(getImageRgbContrast(ink,corners[0])>=4.5?{foreground}:{})};
    const luminance=getImageRgbLuminance(ink);
    for(let y=Math.floor(bounds.y0);y<Math.ceil(bounds.y1);y++)for(let x=Math.floor(bounds.x0);x<Math.ceil(bounds.x1);x++){
        const bg=getImageRgbLuminance(background(x-left,y-top));
        if((Math.max(luminance,bg)+.05)/(Math.min(luminance,bg)+.05)<3)return;
    }
    return {foreground,outline:getImageTextColor(foreground)};
}

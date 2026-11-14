/**
 * @file src/features/image-translation/services/flatTextRepair.ts
 * 文件职责：在原有物理清字框内独立验证纯色底与单一墨色字形，避免紧框边缘误采到原字后让模型生成色带。
 * 主要内容：完整不透明外周须为同一颜色，内部每个非底色像素须符合共同高对比墨色的抗锯齿混合；八邻域组件须有实心墨迹、符合原字号尺度，且至少两个组件的包围框内有足够空隙。单框最多65536像素、512种非底色和256个组件，先扣除调用方整页预算；成功计划只写原清字框，不保留源像素引用。
 * 模块边界：纯像素验证，不猜测图中文字、不调用模型，也不把只读样式观察当作清字授权；沿用调用方已有OCR物理框，混色、纹理、透明、孤立浅色、连通大图案和不足证据均不产生计划。
 * 贴边完整性：已验证的完整同色外周排除连通笔画被框边截断；组件只有同时达到字号尺度与包围框空隙要求时才可触及原蒙版边缘，孤立边点仍拒绝，不扩张清字范围。
 */
import type {OcrLine} from '@/src/shared/image/types';
import {getImageRgbContrast} from './rendering';

interface FlatTextRepairRequest {
    mask: OcrLine['bbox'];
    source: OcrLine['bbox'];
    fontSize: number;
    vertical?: boolean;
}

/** 验证失败也不退回已花费的像素额度；返回计划只在独占目标缓冲中执行。 */
export function planImageFlatTextRepair(pixels:Uint8ClampedArray,imageWidth:number,imageHeight:number,
    request:FlatTextRepairRequest,budget:{remaining:number}):((target:Uint8ClampedArray)=>void)|undefined {
    const {mask,source,fontSize,vertical}=request,{x0,y0,x1,y1}=mask;
    if(![imageWidth,imageHeight,x0,y0,x1,y1].every(Number.isSafeInteger)||imageWidth<=0||imageHeight<=0
        ||pixels.length<imageWidth*imageHeight*4||x0<1||y0<1||x1>=imageWidth||y1>=imageHeight||x1<=x0||y1<=y0
        ||![source.x0,source.y0,source.x1,source.y1,fontSize].every(Number.isFinite)
        ||source.x0<x0||source.y0<y0||source.x1>x1||source.y1>y1||source.x1<=source.x0||source.y1<=source.y0||fontSize<2||fontSize>512)return;
    const width=x1-x0,height=y1-y0,area=(width+2)*(height+2);
    if(area>65_536||!Number.isSafeInteger(budget.remaining)||budget.remaining<area)return;
    budget.remaining-=area;
    const at=(x:number,y:number)=>(y*imageWidth+x)*4;
    const first=at(x0-1,y0-1),background=[pixels[first],pixels[first+1],pixels[first+2]];
    const same=(x:number,y:number)=>{const p=at(x,y);return pixels[p+3]===255&&background.every((value,c)=>pixels[p+c]===value);};
    for(let x=x0-1;x<=x1;x++)if(!same(x,y0-1)||!same(x,y1))return;
    for(let y=y0;y<y1;y++)if(!same(x0-1,y)||!same(x1,y))return;
    const backgroundKey=background[0]*65_536+background[1]*256+background[2],colors=new Map<number,number>();
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
        const p=at(x,y);if(pixels[p+3]!==255)return;
        const key=pixels[p]*65_536+pixels[p+1]*256+pixels[p+2];if(key===backgroundKey)continue;
        colors.set(key,(colors.get(key)??0)+1);if(colors.size>512)return;
    }
    let foreground:number[]|undefined,bestCount=0;
    for(const [key,count] of colors){
        const color=[key>>>16,(key>>>8)&255,key&255];
        if(count>bestCount&&getImageRgbContrast(color,background)>=4.5){foreground=color;bestCount=count;}
    }
    if(!foreground)return;
    const difference=foreground.map((value,c)=>value-background[c]);
    const channel=difference.reduce((best,value,c)=>Math.abs(value)>Math.abs(difference[best])?c:best,0);
    const ink=new Uint8Array(width*height);let count=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const p=at(x+x0,y+y0),coverage=(pixels[p+channel]-background[channel])/difference[channel];
        if(coverage<0||coverage>1||difference.some((delta,c)=>Math.abs(pixels[p+c]-(background[c]+delta*coverage))>1))return;
        if(coverage>0){ink[y*width+x]=coverage>=.5?2:1;count++;}
    }
    if(count<width*height*.01||count>width*height*.75)return;
    const queue=new Uint32Array(count);let components=0,shaped=0;
    for(let start=0;start<ink.length;start++){
        if(!ink[start])continue;
        if(++components>256)return;
        let head=0,tail=1,left=width,top=height,right=0,bottom=0,strong=ink[start]===2;
        queue[0]=start;ink[start]=0;
        while(head<tail){
            const index=queue[head++],x=index%width,y=Math.floor(index/width);
            left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
            for(let ny=Math.max(0,y-1);ny<=Math.min(height-1,y+1);ny++)for(let nx=Math.max(0,x-1);nx<=Math.min(width-1,x+1);nx++){
                const next=ny*width+nx;if(!ink[next])continue;
                strong ||= ink[next]===2;ink[next]=0;queue[tail++]=next;
            }
        }
        const w=right-left+1,h=bottom-top+1,cross=vertical?w:h,along=vertical?h:w;
        const glyph=tail<w*h*.85&&cross>=fontSize*.5&&along>=fontSize*.25;
        // The full outside ring has already proved no connected ink continues
        // beyond this mask. Edge noise still needs the same glyph-scale evidence.
        if(!strong||cross>fontSize*1.5||along>fontSize*3
            ||(left===0||top===0||right===width-1||bottom===height-1)&&!glyph)return;
        if(glyph)shaped++;
    }
    if(shaped<2)return;
    const length=pixels.length;
    return target=>{
        if(target.length!==length)throw new RangeError('纯色文字修补缓冲尺寸不一致');
        for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
            const p=(y*imageWidth+x)*4;
            for(let c=0;c<3;c++)target[p+c]=background[c];target[p+3]=255;
        }
    };
}

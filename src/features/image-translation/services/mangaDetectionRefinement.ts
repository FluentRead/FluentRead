/**
 * @file src/features/image-translation/services/mangaDetectionRefinement.ts
 * 文件职责：在原检测组件内部寻找被弱响应淹没的紧凑水平文字候选，供原识别结束后的有界复核使用。
 * 主要内容：只读同次完整Float32区域，用0.3核心和八邻域组件定位内部完整长行；限制区域、页像素、强响应密度和组件次数，保留按原行厚度追加的裁图余量，候选须显著降低原识别框的高度与面积。原像素检查要求完整不透明静区包围裁图和至少一像素内部余白，内部墨迹允许多色和重采样残色，不借样式调色板限制识别文字。
 * 模块边界：不改检测张量、原框、识别批次、文字或置信，不创建模型或Canvas；候选不是OCR结果或擦除许可。调用方仍须绑定原Box、映回当前页、验证实际墨迹、独立识别并保护其他已识别文字。
 */
import {imageMatteObservationBox} from './imageMatteRepair';
export interface MangaDetectionRect {x0:number;y0:number;x1:number;y1:number}
export interface MangaDetectionRefinementCore {core:MangaDetectionRect;crop:MangaDetectionRect;area:number}
export interface MangaDetectionRefinementSource {pageWidth:number;pageHeight:number;x:number;y:number;width:number;height:number}
export interface MangaDetectionRefinement extends MangaDetectionRefinementCore {parent:MangaDetectionRect;pageWidth:number;pageHeight:number}
export interface MangaDetectionRefinementBudget {pixels:number;components:number}
export const MANGA_DETECTION_REFINEMENT_LIMITS=Object.freeze({pixels:4_194_304,regionPixels:1_048_576,components:512,records:128});

export function createMangaDetectionRefinementBudget():MangaDetectionRefinementBudget {return {pixels:0,components:0};}

/** 帧和矩形坐标由检测拥有者预先验证；失败预付不退，不能借重试绕开整页额度。 */
export function collectMangaDetectionRefinementCores(data:Float32Array,width:number,height:number,region:MangaDetectionRect,parent:MangaDetectionRect,
    budget:MangaDetectionRefinementBudget):MangaDetectionRefinementCore[]|undefined {
    const w=region.x1-region.x0,h=region.y1-region.y0,area=w*h,limits=MANGA_DETECTION_REFINEMENT_LIMITS;
    if(w<48||h<48||area>limits.regionPixels||budget.pixels+area>limits.pixels||budget.components>=limits.components)return;
    budget.pixels+=area;
    if(data.length!==width*height)return;
    const mask=new Uint8Array(area);let foreground=0,index=0;
    for(let y=region.y0;y<region.y1;y++)for(let x=region.x0;x<region.x1;x++,index++){
        const value=data[y*width+x];
        if(!Number.isFinite(value)||value<0||value>1)return;
        if(value>=.3){mask[index]=1;foreground++;}
    }
    // 密集核心没有明显字形稀释，不为正常大字或大面积图形生成替代框。
    if(!foreground||foreground>area*.3)return;
    const queue=new Uint32Array(foreground),result:MangaDetectionRefinementCore[]=[];
    for(let start=0;start<area;start++){
        if(mask[start]!==1)continue;
        if(++budget.components>limits.components)return;
        let head=0,tail=1,minX=w,minY=h,maxX=0,maxY=0;
        queue[0]=start;mask[start]=2;
        while(head<tail){
            const point=queue[head++],x=point%w,y=Math.floor(point/w);
            minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
            for(let ny=Math.max(0,y-1);ny<=Math.min(h-1,y+1);ny++)for(let nx=Math.max(0,x-1);nx<=Math.min(w-1,x+1);nx++){
                const next=ny*w+nx;if(mask[next]!==1)continue;
                mask[next]=2;queue[tail++]=next;
            }
        }
        const coreWidth=maxX-minX+1,coreHeight=maxY-minY+1;
        if(tail<20||coreHeight<8||coreWidth<coreHeight*3||minX===0||minY===0||maxX+1===w||maxY+1===h)continue;
        const core={x0:region.x0+minX,y0:region.y0+minY,x1:region.x0+maxX+1,y1:region.y0+maxY+1};
        const padding=Math.round(coreHeight*.25)+1,crop={x0:core.x0-padding,y0:core.y0-padding,x1:core.x1+padding,y1:core.y1+padding};
        const cropWidth=crop.x1-crop.x0,cropHeight=crop.y1-crop.y0,parentWidth=parent.x1-parent.x0,parentHeight=parent.y1-parent.y0;
        if(crop.x0<parent.x0||crop.y0<parent.y0||crop.x1>parent.x1||crop.y1>parent.y1
            ||cropHeight>parentHeight*.6||cropWidth*cropHeight>parentWidth*parentHeight*.5)continue;
        result.push({core,crop,area:tail});
    }
    return result;
}

/** 只证明候选包含已观察到的墨迹；不能证明其语义、字体或艺术归属。 */
export function hasCompleteMangaDetectionCropInk(pixels:Uint8ClampedArray,width:number,height:number,crop:MangaDetectionRect):boolean {
    const roi=imageMatteObservationBox(width,height,crop);
    if(!roi||pixels.length<width*height*4||![crop.x0,crop.y0,crop.x1,crop.y1].every(Number.isSafeInteger))return false;
    const {left,top,width:w,height:h}=roi;
    if(left>=crop.x0||top>=crop.y0||left+w<=crop.x1||top+h<=crop.y1)return false;
    const read=(x:number,y:number)=>pixels.subarray(((top+y)*width+left+x)*4,((top+y)*width+left+x)*4+3);
    const corners=[read(0,0),read(w-1,0),read(0,h-1),read(w-1,h-1)];
    const flat=corners.every(p=>p.every((value,c)=>value===corners[0][c]));
    let ink=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const offset=((top+y)*width+left+x)*4;
        if(pixels[offset+3]!==255)return false;
        const u=x/(w-1),v=y/(h-1);let quiet=true;
        for(let c=0;c<3;c++){
            const background=flat?corners[0][c]:(corners[0][c]*(1-u)+corners[1][c]*u)*(1-v)+(corners[2][c]*(1-u)+corners[3][c]*u)*v;
            if(Math.abs(pixels[offset+c]-background)>(flat?0:1)){quiet=false;break;}
        }
        if(left+x<=crop.x0||top+y<=crop.y0||left+x+1>=crop.x1||top+y+1>=crop.y1){if(!quiet)return false;}
        else if(!quiet)ink++;
    }
    return ink>=8;
}

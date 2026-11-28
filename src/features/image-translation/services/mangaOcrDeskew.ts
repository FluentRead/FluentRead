/**
 * @file src/features/image-translation/services/mangaOcrDeskew.ts
 * 文件职责：仅从识别框内的像素估计浅底水平文字的轻微倾角和旋转后的墨迹边界。
 * 主要内容：支持独立裁图缓冲与整图 RGBA 偏移直读（零画布预检），有界扫描近白背景与深色墨迹，用前景协方差估计基线，仅接受三至十五度、墨迹紧凑且能实质提高有效字高的裁切；按与估角一致的不透明近白阈值（RGB 均 ≥ 240 且全不透明）裁除 JPEG 扫描近白底边，同时保留全部非近白与半透明前景像素，避免丢失彩色或浅灰文字。
 * 模块边界：纯像素几何，不访问浏览器、模型、语言或已识别文字，不检测新区域，不改动输入像素；画布旋转、取消和识别预算由 OCR 会话负责。
 */
export interface MangaDeskewPlan {radians:number;width:number;height:number;}
export interface MangaDeskewTrim {x:number;y:number;width:number;height:number;}

/** 每页源框和旋转结果读取像素之和，与原有四框复识别预算分别有界。 */
export const MANGA_DESKEW_PIXEL_BUDGET=2_000_000;

function ink(data:Uint8ClampedArray,index:number):boolean {
    return data[index]<128&&data[index+1]<128&&data[index+2]<128;
}

/** 仅为长水平框估角；彩色/暗底、稀疏线条及大面积插画保留原处理。支持整图 RGBA 零画布直读。 */
export function planMangaOcrDeskew(data:Uint8ClampedArray,width:number,height:number):MangaDeskewPlan|undefined;
export function planMangaOcrDeskew(pixels:Uint8ClampedArray,pageWidth:number,x0:number,y0:number,width:number,height:number):MangaDeskewPlan|undefined;
export function planMangaOcrDeskew(
    data:Uint8ClampedArray,
    widthOrPageWidth:number,
    heightOrX0:number,
    y0?:number,
    regionWidth?:number,
    regionHeight?:number,
):MangaDeskewPlan|undefined {
    const paged=y0!==undefined||regionWidth!==undefined||regionHeight!==undefined;
    const pageWidth=widthOrPageWidth;
    const x0=paged?heightOrX0:0;
    const startY=paged?y0!:0;
    const width=paged?regionWidth!:widthOrPageWidth;
    const height=paged?regionHeight!:heightOrX0;
    if(!Number.isInteger(pageWidth)||!Number.isInteger(x0)||!Number.isInteger(startY)
        ||!Number.isInteger(width)||!Number.isInteger(height)
        ||pageWidth<=0||x0<0||startY<0||width<120||height<20||width/height<2.5
        ||x0+width>pageWidth||width*height>MANGA_DESKEW_PIXEL_BUDGET)return;
    if(paged?(data.length%(pageWidth*4)!==0||(startY+height)*pageWidth*4>data.length):data.length!==width*height*4)return;
    let count=0,white=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;
    for(let y=0;y<height;y++){
        const row=((startY+y)*pageWidth+x0)*4;
        for(let x=0;x<width;x++){
            const index=row+x*4;
            if(data[index]>=240&&data[index+1]>=240&&data[index+2]>=240)white++;
            if(!ink(data,index))continue;
            count++;sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
        }
    }
    if(count<60||white/(width*height)<.8||count/(width*height)<.01)return;
    const xx=sxx/count-(sx/count)**2,yy=syy/count-(sy/count)**2,xy=sxy/count-sx*sy/count**2;
    const radians=.5*Math.atan2(2*xy,xx-yy),degrees=Math.abs(radians*180/Math.PI);
    if(degrees<3||degrees>15)return;
    const c=Math.cos(radians),s=Math.sin(radians);let low=Infinity,high=-Infinity;
    for(let y=0;y<height;y++){
        const row=((startY+y)*pageWidth+x0)*4;
        for(let x=0;x<width;x++)if(ink(data,row+x*4)){
            const projected=-s*x+c*y;low=Math.min(low,projected);high=Math.max(high,projected);
        }
    }
    if(high-low+1>height*.6)return;
    const rotatedWidth=Math.ceil(Math.abs(width*c)+Math.abs(height*s)),rotatedHeight=Math.ceil(Math.abs(width*s)+Math.abs(height*c));
    if(rotatedWidth*rotatedHeight>MANGA_DESKEW_PIXEL_BUDGET)return;
    return {radians,width:rotatedWidth,height:rotatedHeight};
}

/** 保留全部非近白或半透明前景像素及两像素边距，浅灰/彩字同样不可裁掉；仅裁除不透明近白底边，噪点或底色使改善不足时保留原框。 */
export function trimMangaOcrDeskew(data:Uint8ClampedArray,width:number,height:number,originalHeight:number):MangaDeskewTrim|undefined {
    if(!Number.isInteger(width)||!Number.isInteger(height)||!Number.isInteger(originalHeight)||width<=0||height<=0||originalHeight<=0
        ||width*height>MANGA_DESKEW_PIXEL_BUDGET||data.length!==width*height*4)return;
    let x0=width,y0=height,x1=-1,y1=-1;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const index=(y*width+x)*4;
        if(data[index]>=240&&data[index+1]>=240&&data[index+2]>=240&&data[index+3]===255)continue;
        x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
    }
    if(x1<0)return;
    x0=Math.max(0,x0-2);y0=Math.max(0,y0-2);x1=Math.min(width,x1+3);y1=Math.min(height,y1+3);
    const trimmedWidth=x1-x0,trimmedHeight=y1-y0;
    if(trimmedWidth<120||trimmedHeight>originalHeight*.6)return;
    return {x:x0,y:y0,width:trimmedWidth,height:trimmedHeight};
}

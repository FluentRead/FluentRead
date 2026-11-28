/**
 * @file src/features/image-translation/services/sourceInk.ts
 * 文件职责：只读观察纯色、平滑渐变或紧凑控件底色上的共同源字色，为译文保留可确认的视觉样式。
 * 主要内容：完整不透明外周校验双线性背景，所有显著差异限于原物理字框四像素内，以包含真实OCR框外的抗锯齿尾缘；紧凑按钮或输入框外扩触及控件边沿时，按检测到的上下锐利边框夹紧至控件内部纯色区，避免外部白底或细边框污染采样；全程使用标量像素读取与线性亮度查找表避免逐像素数组分配；从实际重复墨色中选取主色，再验证每个墨迹像素都能由同一颜色与局部背景混合得到。渐变容忍仅覆盖八位量化，不用它授予清字权限；纯色底的框外空处要求逐字节一致。单项六万五千像素、四千颜色和一百二十八物理框有硬上限，整页预算由调用方预付。
 * 模块边界：不修改像素、不返回掩码或修补计划，不推断字体、语义或艺术归属；纯色沿用 4.5 局部对比门槛，并允许饱和彩色 UI 控件上的高亮浅字按 2.6:1 保留原色，渐变至少 3 并另给细对比描边，均不代表缩放后页面的可访问性认证。混色、纹理、透明或证据不足时保持未知。
 * 字形边界：单个物理源框完成全部颜色验证后复用已有墨迹索引给出紧边界，供独立字号核对；多框不把总包围框冒充单行字高，也不授予额外清字范围。
 * 旋转标签：同一源字框的上下静区逐列一致时，按列观察书脊的局部底色，再用同一墨色与完整外围核对源色。
 */
import type {OcrLine} from '@/src/shared/image/types';
import {imageMatteObservationBox,type ImageMattePalette} from './imageMatteRepair';
import {getImageRgbLuminance,getImageRgbLuminanceValues,getImageTextColor,isAcceptableImageSourceInk} from './rendering';

type Box=OcrLine['bbox'];
export interface ImageSourceInk {background?:ImageMattePalette['background'];foreground?:string;outline?:string;inkBoxes?:readonly Box[]}
const TOLERANCE=1.5;

function matchesInkScalar(pr:number,pg:number,pb:number,br:number,bg:number,bb:number,ir:number,ig:number,ib:number):boolean {
    let low=0,high=1;
    for(let c=0;c<3;c++){
        const delta=(c===0?ir-br:c===1?ig-bg:ib-bb);
        const offset=(c===0?pr-br:c===1?pg-bg:pb-bb);
        if(delta===0){if(Math.abs(offset)>TOLERANCE)return false;continue;}
        const a=(offset-TOLERANCE)/delta,b=(offset+TOLERANCE)/delta;
        low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));
        if(low>high)return false;
    }
    return true;
}

/** 每个颜色通道必须共享同一个覆盖率；可供只读样式和识别投影复核，不能证明字形、词界或擦除归属。 */
export function matchesImageSourceInk(pixel:readonly number[],background:readonly number[],ink:readonly number[]):boolean {
    return matchesInkScalar(pixel[0],pixel[1],pixel[2],background[0],background[1],background[2],ink[0],ink[1],ink[2]);
}

function selectDominantInk(colors:Map<number,number>,inkCount:number):[number,number,number]|undefined {
    let candidate=0,count=0;
    for(const [color,n] of colors)if(n>count){candidate=color;count=n;}
    if(count<8||count<inkCount*.1)return;
    return [candidate&255,candidate>>>8&255,candidate>>>16&255];
}

function l1Diff(pixels:Uint8ClampedArray,offset:number,r:number,g:number,b:number):number {
    return Math.abs(pixels[offset]-r)+Math.abs(pixels[offset+1]-g)+Math.abs(pixels[offset+2]-b);
}

/** 紧凑按钮/输入框被八像素外扩跨过边界时，夹紧至上下锐利边沿之内的均匀底色再验证共同墨色。 */
function observeCompactWidgetInk(pixels:Uint8ClampedArray,width:number,height:number,src:Box):ImageSourceInk|undefined {
    const sx0=Math.floor(src.x0),sy0=Math.floor(src.y0),sx1=Math.ceil(src.x1),sy1=Math.ceil(src.y1);
    if(sx0<1||sy0<1||sx1>=width||sy1>=height)return;
    const buckets=new Map<number,[number,number,number,number]>();
    let ringTotal=0;
    const sampleRing=(x:number,y:number):boolean=>{
        const p=(y*width+x)*4;
        if(pixels[p+3]!==255)return false;
        const r=pixels[p],g=pixels[p+1],b=pixels[p+2];
        const key=((r&0xf0)<<4)|(g&0xf0)|(b>>>4);
        let entry=buckets.get(key);
        if(!entry){entry=[0,0,0,0];buckets.set(key,entry);}
        entry[0]+=r;entry[1]+=g;entry[2]+=b;entry[3]++;ringTotal++;
        return true;
    };
    for(let x=sx0;x<sx1;x++)if(!sampleRing(x,sy0-1)||!sampleRing(x,sy1))return;
    for(let y=sy0;y<sy1;y++)if(!sampleRing(sx0-1,y)||!sampleRing(sx1,y))return;
    let best:[number,number,number,number]=[0,0,0,0];
    for(const entry of buckets.values())if(entry[3]>best[3])best=entry;
    if(best[3]<ringTotal*.75)return;
    const bgR=Math.round(best[0]/best[3]),bgG=Math.round(best[1]/best[3]),bgB=Math.round(best[2]/best[3]);
    const spanW=sx1-sx0,spanH=sy1-sy0;
    const isRowBorder=(y:number)=>{
        let diff=0;
        for(let x=sx0;x<sx1;x++){const p=(y*width+x)*4;if(pixels[p+3]===255&&l1Diff(pixels,p,bgR,bgG,bgB)>=45)diff++;}
        return diff>=spanW*.75;
    };
    const isColBorder=(x:number)=>{
        let diff=0;
        for(let y=sy0;y<sy1;y++){const p=(y*width+x)*4;if(pixels[p+3]===255&&l1Diff(pixels,p,bgR,bgG,bgB)>=45)diff++;}
        return diff>=spanH*.75;
    };
    let topBorder:number|undefined,bottomBorder:number|undefined,leftBorder:number|undefined,rightBorder:number|undefined;
    for(let y=sy0-1;y>=Math.max(0,sy0-8);y--)if(isRowBorder(y)){topBorder=y;break;}
    for(let y=sy1;y<Math.min(height,sy1+8);y++)if(isRowBorder(y)){bottomBorder=y;break;}
    if(topBorder===undefined||bottomBorder===undefined)return;
    for(let x=sx0-1;x>=Math.max(0,sx0-8);x--)if(isColBorder(x)){leftBorder=x;break;}
    for(let x=sx1;x<Math.min(width,sx1+8);x++)if(isColBorder(x)){rightBorder=x;break;}
    const roiTop=topBorder+1,roiBottom=bottomBorder;
    const roiLeft=leftBorder!==undefined?leftBorder+1:Math.max(0,sx0-8);
    const roiRight=rightBorder!==undefined?rightBorder:Math.min(width,sx1+8);
    const rw=roiRight-roiLeft,rh=roiBottom-roiTop;
    if(roiLeft>=sx0||roiTop>=sy0||roiRight<=sx1||roiBottom<=sy1||rw*rh>65_536)return;
    const matchesBg=(x:number,y:number)=>{
        const p=(y*width+x)*4;
        return pixels[p+3]===255&&Math.abs(pixels[p]-bgR)<=2&&Math.abs(pixels[p+1]-bgG)<=2&&Math.abs(pixels[p+2]-bgB)<=2;
    };
    for(let x=roiLeft;x<roiRight;x++)if(!matchesBg(x,roiTop)||!matchesBg(x,roiBottom-1))return;
    for(let y=roiTop+1;y<roiBottom-1;y++)if(!matchesBg(roiLeft,y)||!matchesBg(roiRight-1,y))return;
    const inkX0=Math.max(roiLeft+1,sx0-2),inkY0=Math.max(roiTop+1,sy0-2);
    const inkX1=Math.min(roiRight-1,sx1+2),inkY1=Math.min(roiBottom-1,sy1+2);
    const colors=new Map<number,number>(),inkPixels=new Uint32Array(rw*rh);let inkCount=0;
    for(let y=roiTop+1;y<roiBottom-1;y++){
        const inY=y>=inkY0&&y<inkY1;
        for(let x=roiLeft+1;x<roiRight-1;x++){
            const p=(y*width+x)*4;
            if(pixels[p+3]!==255)return;
            const r=pixels[p],g=pixels[p+1],b=pixels[p+2];
            const quiet=Math.abs(r-bgR)<=2&&Math.abs(g-bgG)<=2&&Math.abs(b-bgB)<=2;
            if(!inY||x<inkX0||x>=inkX1){if(!quiet)return;continue;}
            if(quiet)continue;
            inkPixels[inkCount++]=(y-roiTop)*rw+(x-roiLeft);
            const color=r|g<<8|b<<16;
            colors.set(color,(colors.get(color)??0)+1);
            if(colors.size>4096)return;
        }
    }
    const ink=selectDominantInk(colors,inkCount);
    if(!ink)return;
    let x0=rw,y0=rh,x1=0,y1=0;
    for(let i=0;i<inkCount;i++){
        const lx=inkPixels[i]%rw,ly=Math.floor(inkPixels[i]/rw);
        const p=((roiTop+ly)*width+roiLeft+lx)*4;
        if(!matchesInkScalar(pixels[p],pixels[p+1],pixels[p+2],bgR,bgG,bgB,ink[0],ink[1],ink[2]))return;
        x0=Math.min(x0,lx);y0=Math.min(y0,ly);x1=Math.max(x1,lx+1);y1=Math.max(y1,ly+1);
    }
    const bg:ImageMattePalette['background']=[bgR,bgG,bgB,255];
    return {
        inkBoxes:[{x0:roiLeft+x0,y0:roiTop+y0,x1:roiLeft+x1,y1:roiTop+y1}],
        background:bg,
        ...(isAcceptableImageSourceInk(ink,bg)?{foreground:`rgb(${ink[0]},${ink[1]},${ink[2]})`}:{}),
    };
}

function observeFullHorizon(pixels:Uint8ClampedArray,width:number,height:number,bounds:Box,sources:readonly Box[],rotatedLabel:boolean):ImageSourceInk|undefined {
    const roi=imageMatteObservationBox(width,height,bounds);
    if(!roi)return;
    const {left,top,width:w,height:h}=roi;
    if(left>=bounds.x0||top>=bounds.y0||left+w<=bounds.x1||top+h<=bounds.y1)return;
    const boxes=sources.map(b=>({x0:Math.floor(b.x0)-4,y0:Math.floor(b.y0)-4,x1:Math.ceil(b.x1)+4,y1:Math.ceil(b.y1)+4}));
    if(boxes.some(b=>![b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)||b.x0<=left||b.y0<=top||b.x1>=left+w||b.y1>=top+h||b.x1<=b.x0||b.y1<=b.y0))return;
    const p00=((top)*width+left)*4,p10=((top)*width+left+w-1)*4,p01=((top+h-1)*width+left)*4,p11=((top+h-1)*width+left+w-1)*4;
    if(pixels[p00+3]!==255||pixels[p10+3]!==255||pixels[p01+3]!==255||pixels[p11+3]!==255)return;
    const c00r=pixels[p00],c00g=pixels[p00+1],c00b=pixels[p00+2];
    const c10r=pixels[p10],c10g=pixels[p10+1],c10b=pixels[p10+2];
    const c01r=pixels[p01],c01g=pixels[p01+1],c01b=pixels[p01+2];
    const c11r=pixels[p11],c11g=pixels[p11+1],c11b=pixels[p11+2];
    let colR:Uint8Array|undefined,colG:Uint8Array|undefined,colB:Uint8Array|undefined;
    if(rotatedLabel&&sources.length===1){
        const rArr=new Uint8Array(w),gArr=new Uint8Array(w),bArr=new Uint8Array(w);
        let validCols=true;
        for(let x=0;x<w;x++){
            const q0=(top*width+left+x)*4;
            if(pixels[q0+3]!==255){validCols=false;break;}
            const r=pixels[q0],g=pixels[q0+1],b=pixels[q0+2];
            const q1=((top+1)*width+left+x)*4,q2=((top+h-2)*width+left+x)*4,q3=((top+h-1)*width+left+x)*4;
            if(pixels[q1]!==r||pixels[q1+1]!==g||pixels[q1+2]!==b||pixels[q1+3]!==255
                ||pixels[q2]!==r||pixels[q2+1]!==g||pixels[q2+2]!==b||pixels[q2+3]!==255
                ||pixels[q3]!==r||pixels[q3+1]!==g||pixels[q3+2]!==b||pixels[q3+3]!==255){validCols=false;break;}
            rArr[x]=r;gArr[x]=g;bArr[x]=b;
        }
        if(validCols){colR=rArr;colG=gArr;colB=bArr;}
    }
    let flat=true;
    if(colR){
        for(let x=1;x<w;x++)if(colR[x]!==colR[0]||colG![x]!==colG![0]||colB![x]!==colB![0]){flat=false;break;}
    }else{
        flat=c00r===c10r&&c00g===c10g&&c00b===c10b&&c00r===c01r&&c00g===c01g&&c00b===c01b&&c00r===c11r&&c00g===c11g&&c00b===c11b;
        if(!flat){
            const spanR=Math.max(c00r,c10r,c01r,c11r)-Math.min(c00r,c10r,c01r,c11r);
            const spanG=Math.max(c00g,c10g,c01g,c11g)-Math.min(c00g,c10g,c01g,c11g);
            const spanB=Math.max(c00b,c10b,c01b,c11b)-Math.min(c00b,c10b,c01b,c11b);
            if(Math.max(spanR,spanG,spanB)<4)return;
        }
    }
    const tol=flat?0:1,invW=1/(w-1),invH=1/(h-1);
    const bgChannel=(x:number,y:number,c:number)=>{
        if(colR)return c===0?colR[x]:c===1?colG![x]:colB![x];
        if(flat)return c===0?c00r:c===1?c00g:c00b;
        const u=x*invW,v=y*invH;
        const a=c===0?c00r:c===1?c00g:c00b,b=c===0?c10r:c===1?c10g:c10b;
        const d=c===0?c01r:c===1?c01g:c01b,e=c===0?c11r:c===1?c11g:c11b;
        return (a*(1-u)+b*u)*(1-v)+(d*(1-u)+e*u)*v;
    };
    const matches=(x:number,y:number)=>{
        const p=((top+y)*width+left+x)*4;
        return pixels[p+3]===255&&Math.abs(bgChannel(x,y,0)-pixels[p])<=tol
            &&Math.abs(bgChannel(x,y,1)-pixels[p+1])<=tol&&Math.abs(bgChannel(x,y,2)-pixels[p+2])<=tol;
    };
    for(let x=0;x<w;x++)if(!matches(x,0)||!matches(x,h-1))return;
    for(let y=1;y<h-1;y++)if(!matches(0,y)||!matches(w-1,y))return;
    const colors=new Map<number,number>(),inkPixels=new Uint32Array(w*h);let inkCount=0;
    for(let y=1;y<h-1;y++){
        const spans=boxes.filter(b=>top+y>=b.y0&&top+y<b.y1).sort((a,b)=>a.x0-b.x0);let span=0;
        for(let x=1;x<w-1;x++){
            const p=((top+y)*width+left+x)*4;
            if(pixels[p+3]!==255)return;
            while(span<spans.length&&spans[span].x1<=left+x)span++;
            const inSource=span<spans.length&&spans[span].x0<=left+x;
            const r=pixels[p],g=pixels[p+1],b=pixels[p+2];
            const quiet=Math.abs(bgChannel(x,y,0)-r)<=tol&&Math.abs(bgChannel(x,y,1)-g)<=tol&&Math.abs(bgChannel(x,y,2)-b)<=tol;
            if(!inSource){if(!quiet)return;continue;}
            if(quiet)continue;
            inkPixels[inkCount++]=y*w+x;
            const color=r|g<<8|b<<16;
            colors.set(color,(colors.get(color)??0)+1);if(colors.size>4096)return;
        }
    }
    const ink=selectDominantInk(colors,inkCount);
    if(!ink)return;
    let x0=w,y0=h,x1=0,y1=0;
    for(let i=0;i<inkCount;i++){
        const x=inkPixels[i]%w,y=Math.floor(inkPixels[i]/w),p=((top+y)*width+left+x)*4;
        if(!matchesInkScalar(pixels[p],pixels[p+1],pixels[p+2],bgChannel(x,y,0),bgChannel(x,y,1),bgChannel(x,y,2),ink[0],ink[1],ink[2]))return;
        x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);
    }
    const geometry=sources.length===1?{inkBoxes:[{x0:left+x0,y0:top+y0,x1:left+x1,y1:top+y1}]}:{};
    const foreground=`rgb(${ink[0]},${ink[1]},${ink[2]})`;
    if(flat){
        const bg:ImageMattePalette['background']=[c00r,c00g,c00b,255];
        return {...geometry,background:bg,...(isAcceptableImageSourceInk(ink,bg)?{foreground}:{})};
    }
    const luminance=getImageRgbLuminance(ink);
    for(let y=Math.floor(bounds.y0);y<Math.ceil(bounds.y1);y++)for(let x=Math.floor(bounds.x0);x<Math.ceil(bounds.x1);x++){
        const bgLum=getImageRgbLuminanceValues(bgChannel(x-left,y-top,0),bgChannel(x-left,y-top,1),bgChannel(x-left,y-top,2));
        if((Math.max(luminance,bgLum)+.05)/(Math.min(luminance,bgLum)+.05)<3)return;
    }
    return {...geometry,foreground,outline:getImageTextColor(foreground)};
}

/** 仅在已通过页预算的候选上调用；结果不允许扩张或替代原清字范围。 */
export function observeImageSourceInk(pixels:Uint8ClampedArray,width:number,height:number,bounds:Box,sources:readonly Box[],rotatedLabel=false):ImageSourceInk|undefined {
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0||width>8192||height>8192
        ||width*height>16_777_216||pixels.length<width*height*4||!sources.length||sources.length>128)return;
    if(sources.some(b=>![b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)||b.x0<0||b.y0<0||b.x1>width||b.y1>height||b.x1<=b.x0||b.y1<=b.y0))return;
    const full=observeFullHorizon(pixels,width,height,bounds,sources,rotatedLabel);
    if(full)return full;
    if(!rotatedLabel&&sources.length===1)return observeCompactWidgetInk(pixels,width,height,sources[0]);
}

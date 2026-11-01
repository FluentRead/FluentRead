/**
 * @file src/features/image-translation/services/mangaAlphaProtection.ts
 * 文件职责：在漫画原始像素上冻结保守低透明度保护区，供修补与完整译文排版共享。
 * 主要内容：仅完整外周 alpha 一致的文字蒙版提供阈值；扫描其并集并合并重叠行段，保留 alpha 更低的全部 RGBA，限制源像素、外周、事件、行段与裁剪复杂度；按保护区切分原框内连续可用矩形，不推断字形或删除内容。
 * 模块边界：纯数据算法，不创建画布、不复制整页 RGBA、不运行模型；保护信号不等同文字分割，异常碎片显式失败，由调用方保留原图。
 */
import type {MangaRegion} from './mangaRegions';
import {mangaMaskBoxes} from '../mangaPatchResult';

type Box = MangaRegion['bbox'];
export interface MangaAlphaProtection {
    /** 每项依次是 y、x0、x1，同行区间不重叠且不相邻。 */
    runs: Uint16Array;
    rowStarts: Uint32Array;
    rectangles: readonly Readonly<Box>[];
}
// 仅标记本模块创建并冻结的数组；包装它的 Proxy 和调用方自造数组都不可信。
const trustedRectangles=new WeakSet<readonly Readonly<Box>[]>();
export function isTrustedMangaAlphaRectangles(rectangles:readonly Readonly<Box>[]):boolean {
    return trustedRectangles.has(rectangles);
}
export interface MangaAlphaLayoutBudget {remaining:number}
// 源并集逐行只扫描一次，受16MP尺寸上限约束；此额外预算只计算外周采样和区间事件。
const MAX_PIXELS = 16_777_216, MAX_BOXES = 8192, MAX_WORK = 8_388_608;
const MAX_RUNS = 65_536, MAX_RECTS = 4096, MAX_LAYOUT_RECTS = 64;
const exhausted = () => new Error('漫画透明图案过于复杂，已保留原图');

/** 原始坐标扫描；既不依赖模型降采样命中，也不把局部不透明采样当成整页证明。 */
export function planMangaAlphaProtection(pixels: Uint8ClampedArray, width: number, height: number, regions: MangaRegion[]): MangaAlphaProtection | undefined {
    if (![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192) || width*height>MAX_PIXELS || pixels.length<width*height*4) return;
    const unique = new Map<string, Box & {alpha:number}>();
    const alphaCache = new Map<string, number | undefined>();
    let work = 0, boxCount = 0;
    for (const region of regions) {
        boxCount += region.sourceBoxes?.length ?? 1;
        if (boxCount>MAX_BOXES) throw exhausted();
        const boxes = mangaMaskBoxes(region,width,height);
        let alpha: number | undefined, valid = boxes.length>0;
        for (const box of boxes) {
            if (![box.x0,box.y0,box.x1,box.y1].every(Number.isSafeInteger) || box.x0<=0 || box.y0<=0 || box.x1>=width || box.y1>=height || box.x1<=box.x0 || box.y1<=box.y0) {valid=false;break;}
            const key=`${box.x0},${box.y0},${box.x1},${box.y1}`;
            let value=alphaCache.get(key);
            if (!alphaCache.has(key)) {
                work+=2*(box.x1-box.x0+2)+2*(box.y1-box.y0);
                if (work>MAX_WORK) throw exhausted();
                value=pixels[((box.y0-1)*width+box.x0-1)*4+3];
                const same=(x:number,y:number)=>pixels[(y*width+x)*4+3]===value;
                for(let x=box.x0-1;x<=box.x1&&value!==undefined;x++) if(!same(x,box.y0-1)||!same(x,box.y1))value=undefined;
                for(let y=box.y0;y<box.y1&&value!==undefined;y++) if(!same(box.x0-1,y)||!same(box.x1,y))value=undefined;
                alphaCache.set(key,value);
            }
            if(value===undefined || (alpha!==undefined&&alpha!==value)){valid=false;break;}
            alpha=value;
        }
        if(valid&&alpha!==undefined&&alpha>0)for(const box of boxes)unique.set(`${box.x0},${box.y0},${box.x1},${box.y1},${alpha}`,{...box,alpha});
    }
    if(!unique.size)return;
    const events = new Map<number, Array<{box:Box & {alpha:number};add:boolean}>>();
    for(const box of unique.values())for(const [y,add] of [[box.y0,true],[box.y1,false]] as const){
        let list=events.get(y);if(!list){list=[];events.set(y,list);}list.push({box,add});
    }
    const ys=Array.from(events.keys()).sort((a,b)=>a-b),active=new Set<Box & {alpha:number}>(),values:number[]=[];
    for(let band=0;band<ys.length-1;band++){
        const y0=ys[band],y1=ys[band+1];
        for(const event of events.get(y0)!){if(event.add)active.add(event.box);else active.delete(event.box);}
        work+=active.size*2;if(work>MAX_WORK)throw exhausted();
        const xs=Array.from(active).flatMap(b=>[{x:b.x0,alpha:b.alpha,add:1},{x:b.x1,alpha:b.alpha,add:-1}]).sort((a,b)=>a.x-b.x);
        const levels=new Uint16Array(256),spans:Array<{x0:number;x1:number;alpha:number}>=[];
        let maximum=0,last=0;
        for(let i=0;i<xs.length;){
            const x=xs[i].x;if(maximum>0&&x>last)spans.push({x0:last,x1:x,alpha:maximum});
            while(i<xs.length&&xs[i].x===x){const e=xs[i++];levels[e.alpha]+=e.add;if(e.add>0)maximum=Math.max(maximum,e.alpha);}
            while(maximum>0&&levels[maximum]===0)maximum--;last=x;
        }
        for(let y=y0;y<y1;y++){
            let start=-1,end=0;
            const flush=()=>{if(start>=0){values.push(y,start,end);if(values.length/3>MAX_RUNS)throw exhausted();start=-1;}};
            for(const span of spans){
                if(start>=0&&span.x0!==end)flush();
                for(let x=span.x0;x<span.x1;x++){
                    if(pixels[(y*width+x)*4+3]<span.alpha){if(start<0)start=x;end=x+1;}
                    else flush();
                }
            }
            flush();
        }
    }
    if(!values.length)return;
    const runs=Uint16Array.from(values),rowStarts=new Uint32Array(height+1),rectangles:Box[]=[];
    let cursor=0,previous=new Map<string,Box>();
    for(let y=0;y<height;y++){
        rowStarts[y]=cursor;const next=new Map<string,Box>();
        while(cursor<runs.length/3&&runs[cursor*3]===y){
            const x0=runs[cursor*3+1],x1=runs[cursor*3+2],key=`${x0},${x1}`;
            let rect=previous.get(key);
            if(rect)rect.y1=y+1;else{rect={x0,y0:y,x1,y1:y+1};rectangles.push(rect);if(rectangles.length>MAX_RECTS)throw exhausted();}
            next.set(key,rect);cursor++;
        }
        previous=next;
    }
    rowStarts[height]=cursor;
    for(const rect of rectangles)Object.freeze(rect);
    Object.freeze(rectangles);trustedRectangles.add(rectangles);
    return {runs,rowStarts,rectangles};
}

/** 行内二分查询共享并集；后续区域不能重写前一个区域已确认的孔洞。 */
export function isMangaAlphaProtected(protection:MangaAlphaProtection|undefined,x:number,y:number):boolean {
    if(!protection || y<0 || y+1>=protection.rowStarts.length)return false;
    let low=protection.rowStarts[y],high=protection.rowStarts[y+1];
    while(low<high){const mid=(low+high)>>>1,start=protection.runs[mid*3+1],end=protection.runs[mid*3+2];if(x<start)high=mid;else if(x>=end)low=mid+1;else return true;}
    return false;
}

/** 候选可互相重叠，但每个都不含保护区；只移除被另一候选完整包含者，不截断译文。 */
export function mangaAlphaClearRects(protection:MangaAlphaProtection,box:Box,budget:MangaAlphaLayoutBudget={remaining:1_048_576}):Box[] {
    let available=[box];
    for(const hole of protection.rectangles){
        if(--budget.remaining<0)throw exhausted();
        if(hole.x1<=box.x0||hole.x0>=box.x1||hole.y1<=box.y0||hole.y0>=box.y1)continue;
        const next:Box[]=[];
        const add=(r:Box)=>{
            const contains=(a:Box,b:Box)=>a.x0<=b.x0&&a.y0<=b.y0&&a.x1>=b.x1&&a.y1>=b.y1;
            for(const other of next){if(--budget.remaining<0)throw exhausted();if(contains(other,r))return;}
            for(let i=next.length-1;i>=0;i--){if(--budget.remaining<0)throw exhausted();if(contains(r,next[i]))next.splice(i,1);}
            next.push(r);
        };
        for(const r of available){
            if(--budget.remaining<0)throw exhausted();
            const x0=Math.max(r.x0,hole.x0),x1=Math.min(r.x1,hole.x1),y0=Math.max(r.y0,hole.y0),y1=Math.min(r.y1,hole.y1);
            if(x1<=x0||y1<=y0){add(r);continue;}
            if(y0>r.y0)add({...r,y1:y0});if(y1<r.y1)add({...r,y0:y1});
            if(x0>r.x0)add({...r,x1:x0});if(x1<r.x1)add({...r,x0:x1});
        }
        if(next.length>MAX_LAYOUT_RECTS)throw exhausted();available=next;
    }
    return available;
}

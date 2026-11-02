/**
 * @file src/features/image-translation/services/mangaBlankSpaces.ts
 * 文件职责：在已建议的漫画气泡内寻找保留全部原墨迹的有界纯白排版候选。
 * 主要内容：预扣同页原像素预算，以一像素外周验证唯一封闭亮组件及精确归属框；只允许该组件内原始 RGBA 全为 255 的像素，合并障碍后再保留一像素完整安全边缘；用线性直方图栈枚举极大空白矩形，最多返回三十二个面积降序、同面积按扫描发现顺序稳定的候选。
 * 模块边界：纯坐标与像素查询，不擦字、不推断字符、不读取 Canvas 或调用 OCR；仅预算对象可变。调用方必须保持源像素在本次同步查询中不变，并由真实字形排版确认完整译文可读，不得将候选当作清字权限或跨来源复用。
 */
export interface MangaBlankSpaceBox {x0:number;y0:number;x1:number;y1:number}
export interface MangaBlankSpaceBudget {remainingPixels:number}
export const MANGA_BLANK_SPACE_PAGE_PIXELS=2_000_000;
const MAX_ROI_PIXELS=65_536,MAX_OBSTACLES=8192,MAX_CANDIDATES=32;

function validBox(box:Readonly<MangaBlankSpaceBox>|undefined):box is Readonly<MangaBlankSpaceBox> {
    return !!box&&[box.x0,box.y0,box.x1,box.y1].every(Number.isFinite)&&box.x1>box.x0&&box.y1>box.y0;
}

export function findMangaBlankSpaces(
    pixels:Uint8ClampedArray,width:number,height:number,owner:Readonly<MangaBlankSpaceBox>,
    obstacles:readonly Readonly<MangaBlankSpaceBox>[],budget:MangaBlankSpaceBudget,checkCancelled?:()=>void,
):MangaBlankSpaceBox[] {
    checkCancelled?.();
    if(!(pixels instanceof Uint8ClampedArray)||![width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192)
        ||width*height>16_777_216||pixels.length<width*height*4||!validBox(owner)
        ||![owner.x0,owner.y0,owner.x1,owner.y1].every(Number.isSafeInteger)
        ||owner.x0<1||owner.y0<1||owner.x1>=width||owner.y1>=height
        ||!Array.isArray(obstacles)||obstacles.length>MAX_OBSTACLES
        ||!budget||!Number.isSafeInteger(budget.remainingPixels)||budget.remainingPixels<0||budget.remainingPixels>MANGA_BLANK_SPACE_PAGE_PIXELS)return [];
    const {x0,y0,x1,y1}=owner,ow=x1-x0,oh=y1-y0,rw=ow+2,rh=oh+2,count=rw*rh;
    if(count>MAX_ROI_PIXELS||ow<3||oh<3)return [];
    let work=0;
    const tick=()=>{if((++work&4095)===0)checkCancelled?.();};
    const clipped:MangaBlankSpaceBox[]=[];
    for(const box of obstacles){
        tick();if(!validBox(box))return [];
        const left=Math.max(x0,Math.floor(box.x0)),top=Math.max(y0,Math.floor(box.y0));
        const right=Math.min(x1,Math.ceil(box.x1)),bottom=Math.min(y1,Math.ceil(box.y1));
        if(right>left&&bottom>top)clipped.push({x0:left-x0,y0:top-y0,x1:right-x0,y1:bottom-y0});
    }
    const remaining=budget.remainingPixels-count;
    if(remaining<0)return [];
    // 所有原像素读取前扣费；非闭合、取消或空候选均不返还。
    try{budget.remainingPixels=remaining;}catch{return [];}
    if(budget.remainingPixels!==remaining)return [];
    checkCancelled?.();
    const flags=new Uint8Array(count),labels=new Int32Array(count).fill(-1),queue=new Uint32Array(count);
    for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){
        tick();const p=((y0-1+y)*width+x0-1+x)*4,r=pixels[p],g=pixels[p+1],b=pixels[p+2],a=pixels[p+3];
        flags[y*rw+x]=Number(r>235&&g>235&&b>235&&a===255)|(Number(r===255&&g===255&&b===255&&a===255)<<1);
    }
    let label=0,matches=0,owned=-1;
    for(let first=0;first<count;first++){
        if(!(flags[first]&1)||labels[first]>=0)continue;
        let head=0,tail=1,left=rw,top=rh,right=-1,bottom=-1;queue[0]=first;labels[first]=label;
        const visit=(index:number)=>{if((flags[index]&1)&&labels[index]<0){labels[index]=label;queue[tail++]=index;}};
        while(head<tail){
            tick();const index=queue[head++],x=index%rw,y=Math.floor(index/rw);
            left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
            if(x>0)visit(index-1);if(x+1<rw)visit(index+1);if(y>0)visit(index-rw);if(y+1<rh)visit(index+rw);
        }
        if(left===1&&top===1&&right===ow&&bottom===oh){matches++;owned=label;}
        label++;
    }
    if(matches!==1)return [];
    // 差分并集避免对每个像素反复扫描全部障碍，重复与相交框不会改变可写区域。
    const stride=ow+1,difference=new Int32Array(stride*(oh+1));
    for(const box of clipped){
        tick();difference[box.y0*stride+box.x0]++;difference[box.y0*stride+box.x1]--;
        difference[box.y1*stride+box.x0]--;difference[box.y1*stride+box.x1]++;
    }
    const writable=new Uint8Array(count),available=new Uint8Array(ow*oh);
    for(let y=0;y<oh;y++){
        let horizontal=0;
        for(let x=0;x<ow;x++){
            tick();const d=y*stride+x,k=(y+1)*rw+x+1;horizontal+=difference[d];
            difference[d]=horizontal+(y?difference[d-stride]:0);
            writable[k]=Number(labels[k]===owned&&(flags[k]&2)!==0&&difference[d]===0);
        }
    }
    const neighbors=[-rw-1,-rw,-rw+1,-1,0,1,rw-1,rw,rw+1];
    for(let y=0;y<oh;y++)for(let x=0;x<ow;x++){
        tick();const k=(y+1)*rw+x+1;available[y*ow+x]=Number(neighbors.every(offset=>writable[k+offset]===1));
    }
    const heights=new Uint16Array(ow),stackHeight=new Uint16Array(ow),stackLeft=new Uint16Array(ow),nextBlocked=new Uint16Array(ow+1);
    const best:Array<{box:MangaBlankSpaceBox;area:number}>=[];
    const retain=(left:number,top:number,right:number,bottom:number)=>{
        const area=(right-left)*(bottom-top);let index=0;
        while(index<best.length&&best[index].area>=area)index++;
        if(index>=MAX_CANDIDATES)return;
        best.splice(index,0,{box:{x0:x0+left,y0:y0+top,x1:x0+right,y1:y0+bottom},area});
        if(best.length>MAX_CANDIDATES)best.pop();
    };
    for(let y=0;y<oh;y++){
        nextBlocked[0]=0;
        for(let x=0;x<ow;x++){
            tick();heights[x]=available[y*ow+x]?heights[x]+1:0;
            nextBlocked[x+1]=nextBlocked[x]+Number(y+1===oh||available[(y+1)*ow+x]===0);
        }
        let size=0;
        for(let x=0;x<=ow;x++){
            tick();const current=x<ow?heights[x]:0;let left=x;
            while(size&&stackHeight[size-1]>current){
                const h=stackHeight[--size];left=stackLeft[size];
                // 能向下继续的矩形留到后续行；相等高度合并，只生成一次同一极大矩形。
                if(nextBlocked[x]>nextBlocked[left])retain(left,y-h+1,x,y+1);
            }
            if(current&&(size===0||stackHeight[size-1]<current)){stackHeight[size]=current;stackLeft[size++]=left;}
        }
    }
    checkCancelled?.();return best.map(item=>item.box);
}

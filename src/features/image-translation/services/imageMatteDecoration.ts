/**
 * @file src/features/image-translation/services/imageMatteDecoration.ts
 * 文件职责：识别原 OCR 横行末端误入物理擦除矩形的独立小图案。
 * 主要内容：在已观察纯色墨迹框的两端检查完整空白列；只接纳与大写原文逐字对应、具有共同字高的正文。用同一闭环提案内的九成墨迹复核字形，并确认图案从全强度墨迹上也独立，完整正文仍位于旧擦除范围内。
 * 模块边界：只借原 RGBA 或本次未授权的局部蒙版，不运行模型、不移动 OCR 框、不写原图。页规划仍须校验译文与图案的冲突和独占写入权限。
 * 行末空心边饰：是否识别为独立句点只影响如何寻找候选。小图案仍须由完整空白列与正文分开，并包住可验证的原底色。
 */
import type {OcrLine} from '@/src/shared/image/types';
import type {ImageMatteRepair} from './imageMatteRepair';
import type {ImageSourceAppearance} from './sourceAppearance';

type Box=OcrLine['bbox'];
export interface ImageMatteDecoration {side:'left'|'right';gap:number;characters:number;enclosed?:true}

function include(box:Box,x:number,y:number):void {
    box.x0=Math.min(box.x0,x);
    box.y0=Math.min(box.y0,y);
    box.x1=Math.max(box.x1,x+1);
    box.y1=Math.max(box.y1,y+1);
}
const emptyBox=():Box=>({x0:Infinity,y0:Infinity,x1:-1,y1:-1});
const inside=(box:Box,outer:Box)=>box.x0>=outer.x0&&box.y0>=outer.y0&&box.x1<=outer.x1&&box.y1<=outer.y1;
const contains=(box:Box,x:number,y:number)=>x>=box.x0&&x<box.x1&&y>=box.y0&&y<box.y1;

/** 从边缘连通的底色中排除外部空白，确认图案实际包住至少一块 2×2 的同色底。 */
function enclosesBackground(repair:ImageMatteRepair,box:Box):boolean {
    const width=box.x1-box.x0,height=box.y1-box.y0;
    if(width<4||height<4)return false;
    const cells=new Uint8Array(width*height),queue=new Uint16Array(cells.length);
    const left=box.x0-repair.left,top=box.y0-repair.top;
    for(let y=0;y<height;y++){
        const start=(top+y)*repair.width+left;
        cells.set(repair.mask.subarray(start,start+width),y*width);
    }
    let tail=0;
    const visit=(index:number)=>{
        if(cells[index])return;
        cells[index]=2;queue[tail++]=index;
    };
    for(let x=0;x<width;x++){visit(x);visit((height-1)*width+x);}
    for(let y=1;y<height-1;y++){visit(y*width);visit((y+1)*width-1);}
    for(let head=0;head<tail;head++){
        const index=queue[head],x=index%width;
        if(x>0)visit(index-1);
        if(x<width-1)visit(index+1);
        if(index>=width)visit(index-width);
        if(index<cells.length-width)visit(index+width);
    }
    for(let y=1;y<height-2;y++)for(let x=1;x<width-2;x++){
        const index=y*width+x;
        if(!cells[index]&&!cells[index+1]&&!cells[index+width]&&!cells[index+width+1])return true;
    }
    return false;
}

/** 从两端最多读半个字宽；疑似空列只用于触发完整蒙版复核。 */
export function observeImageMatteDecoration(pixels:Uint8ClampedArray,width:number,sourceText:string,
    appearance:ImageSourceAppearance|undefined):ImageMatteDecoration|undefined {
    const spacedPeriod=sourceText.endsWith(' .');
    const label=spacedPeriod?sourceText.slice(0,-2).trimEnd():sourceText;
    if(!/^[A-Z0-9]+(?: +[A-Z0-9]+)*$/u.test(label))return;
    const characters=label.replaceAll(' ','').length,background=appearance?.background,boxes=appearance?.inkBoxes;
    if(characters<4||characters>48||background?.[3]!==255||boxes?.length!==1)return;
    const {x0,y0,x1,y1}=boxes[0],height=y1-y0;
    if(height<12||height>96||x1-x0<height*2)return;
    let match:ImageMatteDecoration|undefined;
    const sides=spacedPeriod?['right'] as const:['left','right'] as const;
    for(const side of sides){
        const edge=emptyBox(),direction=side==='left'?1:-1;
        for(let step=0;step<=Math.floor(height/2);step++){
            const x=(side==='left'?x0:x1-1)+step*direction;
            let hasInk=false;
            for(let y=y0;y<y1;y++){
                const offset=(y*width+x)*4;
                if(background.every((channel,index)=>pixels[offset+index]===channel))continue;
                hasInk=true;
                include(edge,x,y);
            }
            if(hasInk)continue;
            const raised=edge.y1<=y1-Math.floor(height/4);
            // OCR 可能略过紧靠基线的图案。右侧这种候选必须另证闭孔，普通实心句点不能通过。
            const enclosed=spacedPeriod||(!raised&&side==='right'&&edge.x1-edge.x0>=4&&edge.y1-edge.y0>=4);
            if(step>0&&edge.y1-edge.y0<=height*.55&&(enclosed||raised)){
                if(match)return;
                match={side,gap:x,characters,...(enclosed?{enclosed:true as const}:{})};
            }
            break;
        }
    }
    return match;
}

/** 成功时只修改还在当前提案内的蒙版，并要求保留图案和清除的正文均属于旧范围。 */
export function keepImageMatteDecoration(repair:ImageMatteRepair,decoration:ImageMatteDecoration,legacy:Box):boolean {
    const {mask,inkCore,artMask,left,top,width}=repair;
    const {gap,side,characters,enclosed}=decoration;
    if(enclosed?side!=='right':!inkCore)return false;
    const towardArt=(x:number)=>side==='left'?x<gap:x>gap;
    const textBounds=emptyBox(),artBounds=emptyBox(),clippedText=emptyBox(),components=new Uint8Array(mask.length);
    let artPixels=0;
    for(let index=0;index<mask.length;index++){
        if(!mask[index])continue;
        const x=left+index%width,y=top+Math.floor(index/width);
        if(x===gap)return false;
        if(towardArt(x)){
            include(artBounds,x,y);
            components[index]=2;
            artPixels++;
        }else{
            include(textBounds,x,y);
            if(enclosed){
                if(contains(legacy,x,y))include(clippedText,x,y);
            }else if(inkCore![index])components[index]=1;
        }
    }
    const height=textBounds.y1-textBounds.y0;
    if(height<12||!artPixels||artPixels>height*height/8||artBounds.x1-artBounds.x0>height/2
        ||artBounds.y1-artBounds.y0>height*.55||!inside(artBounds,legacy))return false;
    if(enclosed){
        if(artBounds.x0-textBounds.x1<2||clippedText.x0>=clippedText.x1||!enclosesBackground(repair,artBounds))return false;
    }else if(artBounds.y0>textBounds.y0+1||artBounds.y1>textBounds.y1-Math.floor(height/4)||!inside(textBounds,legacy))return false;

    const queue=new Uint32Array(mask.length),neighbors=[-width-1,-width,1-width,-1,1,width-1,width,width+1];
    let letters=0,ornaments=0;
    // 提案中的墨迹没有碰到观察外缘，可安全按相邻偏移遍历。
    for(let start=0;start<components.length;start++){
        const kind=components[start];if(!kind)continue;
        const bounds=emptyBox();
        queue[0]=start;
        components[start]=0;
        let length=1;
        for(let cursor=0;cursor<length;cursor++){
            const index=queue[cursor];
            include(bounds,left+index%width,top+Math.floor(index/width));
            for(const offset of neighbors){
                const next=index+offset;
                if(components[next]!==kind)continue;
                components[next]=0;
                queue[length++]=next;
            }
        }
        if(kind===2){if(++ornaments>1)return false;}
        else if(++letters>characters||bounds.y0>textBounds.y0+1||bounds.y1<textBounds.y1-1||bounds.x1-bounds.x0>height*2)return false;
    }
    if((!enclosed&&letters!==characters)||ornaments!==1)return false;
    // 右侧边饰已在旧框内，正文右边不会超出旧框。
    if(enclosed&&textBounds.x0>=legacy.x0){
        // 只保存贴着一侧原擦除边的最多三行。横向超界、两侧超界和较大的缺口仍按旧范围处理。
        const above=legacy.y0-textBounds.y0,below=textBounds.y1-legacy.y1;
        const rows=Math.max(above,below);
        if(rows>0&&rows<=3&&Math.min(above,below)<=0){
            repair.decorationFringe={
                firstRow:(above>0?legacy.y0-1:legacy.y1)-top,
                step:above>0?-1:1,
                mask:new Uint8Array(rows*width),
            };
        }
    }
    const fringe=repair.decorationFringe;
    for(let index=0;index<mask.length;index++){
        if(!mask[index])continue;
        const x=left+index%width;
        if(towardArt(x)){
            artMask[index]=1;
            mask[index]=0;
        }else if(enclosed){
            const row=Math.floor(index/width);
            if(contains(legacy,x,top+row))continue;
            if(fringe)fringe.mask[(row-fringe.firstRow)*fringe.step*width+index%width]=1;
            mask[index]=0;
        }
    }
    // 框外候选不能借用一般的衬线授权，只有页规划取得同帧分割证据后才能使用。
    if(enclosed)delete repair.fringeCore;
    repair.supportBox=enclosed?clippedText:textBounds;
    return true;
}

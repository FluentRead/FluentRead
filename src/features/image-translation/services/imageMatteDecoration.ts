/**
 * @file src/features/image-translation/services/imageMatteDecoration.ts
 * 文件职责：识别原 OCR 横行末端误入物理擦除矩形的独立小图案。
 * 主要内容：在已观察纯色墨迹框的两端检查完整空白列；只接纳与大写原文逐字对应、具有共同字高的正文。用同一闭环提案内的九成墨迹复核字形，并确认图案从全强度墨迹上也独立，完整正文仍位于旧擦除范围内。
 * 模块边界：只借原 RGBA 或本次未授权的局部蒙版，不运行模型、不移动 OCR 框、不写原图。页规划仍须校验译文与图案的冲突和独占写入权限。
 */
import type {OcrLine} from '@/src/shared/image/types';
import type {ImageMatteRepair} from './imageMatteRepair';
import type {ImageSourceAppearance} from './sourceAppearance';

type Box=OcrLine['bbox'];
export interface ImageMatteDecoration {side:'left'|'right';gap:number;characters:number}

function include(box:Box,x:number,y:number):void {
    box.x0=Math.min(box.x0,x);
    box.y0=Math.min(box.y0,y);
    box.x1=Math.max(box.x1,x+1);
    box.y1=Math.max(box.y1,y+1);
}
const emptyBox=():Box=>({x0:Infinity,y0:Infinity,x1:-1,y1:-1});
const inside=(box:Box,outer:Box)=>box.x0>=outer.x0&&box.y0>=outer.y0&&box.x1<=outer.x1&&box.y1<=outer.y1;

/** 从两端最多读半个字宽；疑似空列只用于触发完整蒙版复核。 */
export function observeImageMatteDecoration(pixels:Uint8ClampedArray,width:number,sourceText:string,
    appearance:ImageSourceAppearance|undefined):ImageMatteDecoration|undefined {
    if(!/^[A-Z0-9]+(?: +[A-Z0-9]+)*$/u.test(sourceText))return;
    const characters=sourceText.replaceAll(' ','').length,background=appearance?.background,boxes=appearance?.inkBoxes;
    if(characters<4||characters>48||background?.[3]!==255||boxes?.length!==1)return;
    const {x0,y0,x1,y1}=boxes[0],height=y1-y0;
    if(height<12||height>96||x1-x0<height*2)return;
    let match:ImageMatteDecoration|undefined;
    for(const side of ['left','right'] as const){
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
            if(step>0&&edge.y1-edge.y0<=height*.55&&edge.y1<=y1-Math.floor(height/4)){
                if(match)return;
                match={side,gap:x,characters};
            }
            break;
        }
    }
    return match;
}

/** 成功时只修改还在当前提案内的蒙版，并要求保留图案和清除的正文均属于旧范围。 */
export function keepImageMatteDecoration(repair:ImageMatteRepair,decoration:ImageMatteDecoration,legacy:Box):boolean {
    const {mask,inkCore,artMask,left,top,width}=repair;
    if(!inkCore)return false;
    const {gap,side,characters}=decoration;
    const towardArt=(x:number)=>side==='left'?x<gap:x>gap;
    const textBounds=emptyBox(),artBounds=emptyBox(),components=new Uint8Array(mask.length);
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
            if(inkCore[index])components[index]=1;
        }
    }
    const height=textBounds.y1-textBounds.y0;
    if(height<12||!artPixels||artPixels>height*height/8||artBounds.x1-artBounds.x0>height/2
        ||artBounds.y1-artBounds.y0>height*.55||artBounds.y0>textBounds.y0+1
        ||artBounds.y1>textBounds.y1-Math.floor(height/4)||!inside(textBounds,legacy)||!inside(artBounds,legacy))return false;

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
    if(letters!==characters||ornaments!==1)return false;
    for(let index=0;index<mask.length;index++){
        if(!mask[index]||!towardArt(left+index%width))continue;
        artMask[index]=1;
        mask[index]=0;
    }
    repair.supportBox=textBounds;
    return true;
}

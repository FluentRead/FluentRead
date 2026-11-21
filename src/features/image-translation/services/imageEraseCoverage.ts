/**
 * @file src/features/image-translation/services/imageEraseCoverage.ts
 * 文件职责：在普通图片的原像素中发现旧清字框遗漏的已观察墨迹，作为完整修补的只读触发条件。
 * 主要内容：只检查已确认不透明纯色背景的物理墨迹框，比较原清字框并集；共享像素和几何预算，跳过已经完整包含的框。
 * 模块边界：不扩大 OCR 框、不改变像素、不授权清字、不把颜色当作文字模型；调用方仍须完成同帧模型授权与完整译文字形预检。
 */
import type {ImageTextRegion} from '../paragraphs';
import type {ImageSourceAppearance} from './sourceAppearance';
import {imageMaskBoxes} from './inpainting';

export function hasUncoveredImageInk(pixels:Uint8ClampedArray,width:number,height:number,
    appearances:ReadonlyMap<ImageTextRegion,ImageSourceAppearance>):boolean {
    let checks=1_048_576,pixelBudget=262_144;
    for(const [line,appearance] of appearances){
        const background=appearance.background;
        if(!background||background[3]!==255||!appearance.inkBoxes)continue;
        const masks=imageMaskBoxes(line,width,height);
        for(const ink of appearance.inkBoxes){
            let contained=false;
            for(const mask of masks){
                if(--checks<0)return false;
                if(ink.x0>=mask.x0&&ink.y0>=mask.y0&&ink.x1<=mask.x1&&ink.y1<=mask.y1){contained=true;break;}
            }
            if(contained)continue;
            const x0=Math.max(0,Math.floor(ink.x0)),y0=Math.max(0,Math.floor(ink.y0));
            const x1=Math.min(width,Math.ceil(ink.x1)),y1=Math.min(height,Math.ceil(ink.y1));
            if(![x0,y0,x1,y1].every(Number.isFinite)||(pixelBudget-=(x1-x0)*(y1-y0))<0)return false;
            for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
                let covered=false;
                for(const mask of masks){
                    if(--checks<0)return false;
                    if(x>=mask.x0&&x<mask.x1&&y>=mask.y0&&y<mask.y1){covered=true;break;}
                }
                if(covered)continue;
                const offset=(y*width+x)*4;
                if(background.some((value,channel)=>pixels[offset+channel]!==value))return true;
            }
        }
    }
    return false;
}

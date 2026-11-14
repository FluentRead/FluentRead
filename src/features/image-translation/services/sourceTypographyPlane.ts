/**
 * @file src/features/image-translation/services/sourceTypographyPlane.ts
 * 文件职责：把已核对的原字倾角转换为受原绘字框约束的译文排版平面，保留原墨迹锚点并完整容纳真实回退字体。
 * 主要内容：反向投影原框得到搜索尺寸；按原行距和边线生成局部基线，以实际字形四边及描边计算旋转后的整段包围盒，只允许在原框内作最小整体平移。尺寸或指标不可靠时返回未知，由调用方沿用直立布局。
 * 模块边界：纯几何与字体度量，不观察像素、不推断角度、不改源区域、不清字；返回的变换必须在原世界坐标裁剪之后应用，不能扩大修补或透明保护范围。
 */
import type {OcrLine} from '@/src/shared/image/types';
import type {ImageTranslationTextLayout,ImageTextLayoutConstraints} from './textLayoutTypes';
import type {ImageSourceTypographyGeometry} from './sourceTypographyGeometry';

type Box=OcrLine['bbox'];
export interface ImageTypographyGlyph {left:number;right:number;ascent:number;descent:number}
export interface ImageTypographyPlacement {points:Array<{x:number;y:number}>;transform:[number,number,number,number,number,number]}

/** 只有整个旋转字形仍放得进原框时接受候选；一像素外侧余量独立于字体描边。 */
export function createImageTypographyPlane(bounds:Box,geometry:ImageSourceTypographyGeometry,
    align:'left'|'center'|'right',measure:(text:string,size:number)=>ImageTypographyGlyph,bleed:(size:number)=>number) {
    const {radians,originX,originY}=geometry,anchor=geometry.bounds;
    if(![bounds.x0,bounds.y0,bounds.x1,bounds.y1,radians,originX,originY,anchor.x0,anchor.y0,anchor.x1,anchor.y1].every(Number.isFinite)
        ||bounds.x1-bounds.x0<=2||bounds.y1-bounds.y0<=2||anchor.x1<=anchor.x0||anchor.y1<=anchor.y0)return;
    const c=Math.cos(radians),s=Math.sin(radians),w=bounds.x1-bounds.x0,h=bounds.y1-bounds.y0;
    const width=Math.abs(c)*w+Math.abs(s)*h-2,height=Math.abs(s)*w+Math.abs(c)*h-2;
    const plan=(layout:ImageTranslationTextLayout):ImageTypographyPlacement|undefined=>{
        if(!layout.ink||!layout.lines.length||layout.ink.baselines.length!==layout.lines.length)return;
        const padding=bleed(layout.fontSize),top=(anchor.y0+anchor.y1-layout.ink.height)/2;
        if(!Number.isFinite(padding)||padding<0||!Number.isFinite(top))return;
        const points:Array<{x:number;y:number}>=[];
        let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
        for(let index=0;index<layout.lines.length;index++){
            const text=layout.lines[index],y=top+layout.ink.baselines[index];
            if(!text){points.push({x:0,y});continue;}
            const metric=measure(text,layout.fontSize),span=metric.left+metric.right;
            if(![metric.left,metric.right,metric.ascent,metric.descent,y].every(Number.isFinite)||span<=0||metric.ascent+metric.descent<=0)return;
            const start=align==='left'?anchor.x0:align==='right'?anchor.x1-span-padding*2:(anchor.x0+anchor.x1-span-padding*2)/2;
            const x=start+metric.left+padding;
            points.push({x,y});
            for(const u of [x-metric.left-padding,x+metric.right+padding])for(const v of [y-metric.ascent-padding,y+metric.descent+padding]){
                const px=originX+c*u-s*v,py=originY+s*u+c*v;
                x0=Math.min(x0,px);x1=Math.max(x1,px);y0=Math.min(y0,py);y1=Math.max(y1,py);
            }
        }
        if(!Number.isFinite(x0)||x1-x0>w-2||y1-y0>h-2)return;
        const dx=Math.max(bounds.x0+1-x0,Math.min(bounds.x1-1-x1,0)),dy=Math.max(bounds.y0+1-y0,Math.min(bounds.y1-1-y1,0));
        return {points,transform:[c,s,-s,c,originX+dx,originY+dy]};
    };
    const constraints:ImageTextLayoutConstraints={sourceLineCount:geometry.count,sourceLinePitch:geometry.linePitch,accept:layout=>!!plan(layout)};
    return {width,height,plan,constraints};
}

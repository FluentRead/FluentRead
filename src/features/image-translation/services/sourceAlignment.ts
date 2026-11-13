/**
 * @file src/features/image-translation/services/sourceAlignment.ts
 * 文件职责：从相邻、独立物理行的共同边线推导有限的原图对齐提示。
 * 主要内容：调用方先用原像素选出可采用样式的区域；这里只比较长横排单行，要求紧邻、强水平交叠、唯一明显的左或右边线，并排除夹在中间的其他识别区域。相同宽度、居中、竖排、注音和已重定位区域均不猜测；整页最多四千余行、三万余次比较，耗尽后整体回退。
 * 模块边界：纯几何样式提示，不证明同一气泡或语义段落，不修改文字、源框、清字范围或字号，不授予新的写入空间；绘制方仍须核验实际字形完整位于原框内。
 */
import type {ImageTextRegion} from '../paragraphs';

type Box=ImageTextRegion['bbox'];
type Alignment='left'|'right';
const sameBox=(a:Box,b:Box)=>a.x0===b.x0&&a.y0===b.y0&&a.x1===b.x1&&a.y1===b.y1;
const intersects=(a:Box,b:Box)=>a.x0<b.x1&&a.x1>b.x0&&a.y0<b.y1&&a.y1>b.y0;
const valid=(b:Box,w:number,h:number)=>b&&[b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)&&b.x0>=0&&b.y0>=0&&b.x1<=w&&b.y1<=h&&b.x1>b.x0&&b.y1>b.y0;

/** 已验证原图样式的长横排才提供提示，不能从清字后的平色或单一文字框猜对齐。 */
export function inferImageSourceAlignments(regions:readonly ImageTextRegion[],eligible:ReadonlySet<ImageTextRegion>,width:number,height:number):Map<ImageTextRegion,Alignment> {
    const result=new Map<ImageTextRegion,Alignment>();
    if(![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||width*height>16_777_216||regions.length>4096
        ||regions.some(r=>!r||!valid(r.bbox,width,height)))return result;
    const candidates=regions.filter(r=>eligible.has(r)&&!r.vertical&&!r.guardOnly&&!r.numericUncertain&&!r.ruby?.length
        &&(!r.sourceBoxes||Array.isArray(r.sourceBoxes)&&r.sourceBoxes.length===1&&r.sourceBoxes[0]&&sameBox(r.sourceBoxes[0],r.bbox))
        &&r.bbox.x1-r.bbox.x0>=(r.bbox.y1-r.bbox.y0)*4);
    const hints=new Map<ImageTextRegion,Alignment|undefined>();let comparisons=0;
    const add=(region:ImageTextRegion,alignment:Alignment)=>hints.set(region,hints.has(region)&&hints.get(region)!==alignment?undefined:alignment);
    for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
        if(++comparisons>32_768)return result;
        const first=candidates[i],second=candidates[j],a=first.bbox,b=second.bbox;
        const small=Math.min(a.y1-a.y0,b.y1-b.y0),gap=Math.max(a.y0,b.y0)-Math.min(a.y1,b.y1);
        if(gap<0||gap>small*2.5||Math.max(a.y1-a.y0,b.y1-b.y0)>small*2
            ||Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)<Math.min(a.x1-a.x0,b.x1-b.x0)*.75)continue;
        const left=Math.abs(a.x0-b.x0),right=Math.abs(a.x1-b.x1),center=Math.abs(a.x0+a.x1-b.x0-b.x1)/2;
        const alignment=left<=small*.15&&right>=small*1.5&&center>=small*.75?'left'
            :right<=small*.15&&left>=small*1.5&&center>=small*.75?'right':undefined;
        if(!alignment)continue;
        const envelope={x0:Math.min(a.x0,b.x0),y0:Math.min(a.y0,b.y0),x1:Math.max(a.x1,b.x1),y1:Math.max(a.y1,b.y1)};
        let blocked=false;
        for(const other of regions){
            if(++comparisons>32_768)return result;
            if(other!==first&&other!==second&&intersects(other.bbox,envelope)){blocked=true;break;}
        }
        if(!blocked){add(first,alignment);add(second,alignment);}
    }
    for(const [region,alignment] of hints)if(alignment)result.set(region,alignment);
    return result;
}

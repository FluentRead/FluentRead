/**
 * @file src/features/image-translation/services/sourceAlignment.ts
 * 文件职责：从相邻、独立物理行的共同边线以及单行有界控件的对称内边距推导有限的原图对齐提示。
 * 主要内容：多行对齐仅比较长横排单行，要求紧邻、强水平交叠、唯一明显的左或右边线，并排除夹在中间的其他识别区域，相同宽度、居中、竖排、注音和已重定位区域均不猜测；单行容器对齐只读原像素扫描文字框左右与上下边界，仅在闭合不透明容器/胶囊按钮内且左右边距均不少于四像素并对称时返回居中提示，避免对普通左对齐标签误判；整页多行比较最多四千余行、三万余次，耗尽后整体回退。
 * 模块边界：纯几何与只读像素样式提示，不证明同一气泡或语义段落，不修改像素、文字、源框、清字范围或字号，不授予新的写入空间；绘制方仍须核验实际字形完整位于原框内。
 */
import type {ImageTextRegion} from '../paragraphs';

type Box=ImageTextRegion['bbox'];
type Alignment='left'|'right';
const sameBox=(a:Box,b:Box)=>a.x0===b.x0&&a.y0===b.y0&&a.x1===b.x1&&a.y1===b.y1;
const intersects=(a:Box,b:Box)=>a.x0<b.x1&&a.x1>b.x0&&a.y0<b.y1&&a.y1>b.y0;
const valid=(b:Box,w:number,h:number)=>b&&[b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)&&b.x0>=0&&b.y0>=0&&b.x1<=w&&b.y1<=h&&b.x1>b.x0&&b.y1>b.y0;

function pixelL1(pixels:Uint8ClampedArray,offset:number,r:number,g:number,b:number):number {
    return Math.abs(pixels[offset]-r)+Math.abs(pixels[offset+1]-g)+Math.abs(pixels[offset+2]-b);
}

/** 扫描单行文字框在均匀不透明容器/胶囊按钮中的左右与上下边界；对称居中时返回 center。 */
export function detectImageSingleLineAlignment(
    pixels:Uint8ClampedArray,
    width:number,
    height:number,
    bbox:Box,
):'center'|undefined {
    if(![width,height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192)||width*height>16_777_216
        ||pixels.length<width*height*4||!valid(bbox,width,height))return;
    const boxW=bbox.x1-bbox.x0,boxH=bbox.y1-bbox.y0;
    if(boxW<4||boxH<6||boxH>80)return;
    const xLeft=Math.floor(bbox.x0)-1,xRight=Math.ceil(bbox.x1);
    const yTop=Math.floor(bbox.y0+boxH*.25),yMid=Math.floor((bbox.y0+bbox.y1)/2),yBot=Math.floor(bbox.y0+boxH*.75);
    if(xLeft<4||xRight+4>=width)return;
    const probeRows=[yTop,yMid,yBot];
    const seedOffset=(yMid*width+xLeft)*4;
    if(pixels[seedOffset+3]!==255)return;
    const seedR=pixels[seedOffset],seedG=pixels[seedOffset+1],seedB=pixels[seedOffset+2];
    let sumR=0,sumG=0,sumB=0;
    for(const px of [xLeft,xRight])for(const py of probeRows){
        const p=(py*width+px)*4;
        if(pixels[p+3]!==255||pixelL1(pixels,p,seedR,seedG,seedB)>12)return;
        sumR+=pixels[p];sumG+=pixels[p+1];sumB+=pixels[p+2];
    }
    const bgR=Math.round(sumR/6),bgG=Math.round(sumG/6),bgB=Math.round(sumB/6);
    const maxRadius=Math.min(Math.max(40,Math.ceil(boxW*2)),240);
    const scanHorizontal=(start:number,step:-1|1):number|undefined=>{
        for(let d=0;d<=maxRadius;d++){
            const x=start+d*step;
            if(x<0||x>=width)return;
            let hits=0,midHit=false;
            for(let idx=0;idx<3;idx++){
                const p=(probeRows[idx]*width+x)*4;
                if(pixels[p+3]!==255)return;
                if(pixelL1(pixels,p,bgR,bgG,bgB)>=40){hits++;if(idx===1)midHit=true;}
            }
            if(midHit||hits>=2)return d;
        }
    };
    const leftMargin=scanHorizontal(xLeft,-1),rightMargin=scanHorizontal(xRight,1);
    if(leftMargin===undefined||rightMargin===undefined||leftMargin<4||rightMargin<4)return;
    if(Math.abs(leftMargin-rightMargin)>Math.max(4,(leftMargin+rightMargin)*.22))return;
    const maxVRadius=Math.min(Math.max(20,Math.ceil(boxH)),64);
    const probeCols=[Math.floor(bbox.x0),Math.floor((bbox.x0+bbox.x1)/2),Math.max(Math.floor(bbox.x0),Math.ceil(bbox.x1)-1)];
    const scanVertical=(startY:number,step:-1|1):boolean=>{
        let minDist=Infinity,maxDist=-1;
        for(const x of probeCols){
            let found=-1;
            for(let d=0;d<=maxVRadius;d++){
                const y=startY+d*step;
                if(y<0||y>=height)return false;
                const p=(y*width+x)*4;
                if(pixels[p+3]!==255)return false;
                if(pixelL1(pixels,p,bgR,bgG,bgB)>=40){found=d;break;}
            }
            if(found<0)return false;
            minDist=Math.min(minDist,found);maxDist=Math.max(maxDist,found);
        }
        return maxDist-minDist<=1;
    };
    if(!scanVertical(Math.floor(bbox.y0)-1,-1)||!scanVertical(Math.ceil(bbox.y1),1))return;
    return 'center';
}

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

/**
 * @file src/features/image-translation/services/mangaRecognitionInkProjection.ts
 * 文件职责：为抗锯齿残色、灰度起伏或深色底紧裁的识别裁图提供相互核对的字形间隙。
 * 主要内容：恒色外周路径仅接收48像素高、完整不透明恒色外周的有界裁图；所有颜色必须能由同一实测墨色与底色混合得到。墨色差1/8和1/4两层须有相同的4–64个字形、逐项嵌套及同位置显著词隙；更弱1/16层只允许至多两个字形通过不超过两像素的词内抗锯齿连合，词隙仍须在该层为空。返回共同空列和前一字形序号；全部组件扫描预付共享余额。
 * 灰度裁图：完整不透明、逐像素色差不超过16且左右边缘亮度至少220时，借用既有80/120/160灰度阈值核对字形；上下边缘允许紧裁字形，不要求整个气泡恒色。三层沿用相同组件与词隙约束，由调用方使用独立的页级额度。
 * 浅色底裁图：左右完整边缘须为同一不透明浅色，内部仍须符合共同墨色混合；背景色差超过16时再使用同一80/120/160分层，避免弱抗锯齿把词内相邻字形连成一个。该路径不放宽原灰度或恒色外周的判断。
 * 深色底裁图：允许字形触及四边；最多4096种颜色中占比至少20%的唯一主导暗色（各通道不超过64）须与实测高对比墨色共同解释全部不透明像素。沿用三层字形后，每个词隙还须有至少三列完整同色背景，至多裁去两侧各两列弱抗锯齿，中间有杂色就撤回该间隙。此证明不推断字符框外的像素或文字。
 * 模块边界：只读既有RGBA，不运行模型、不创建Canvas、不猜词或改变字符；调用方仍须核对原SDK文本、CTC字符数量、唯一blank-run及空格峰。各路径的底色、墨色或字形对应不明时不提供旁证，不能用作清字蒙版。
 */
import {getImageRgbContrast} from './rendering';
import {matchesImageSourceInk} from './sourceInk';

type Band={start:number;end:number};
export interface MangaRecognitionInkBudget {remaining:number}
export interface MangaRecognitionInkProjection {characters:number;gaps:Array<Band&{after:number}>}

function bands(columns:Uint8Array,budget:MangaRecognitionInkBudget):Band[]|undefined {
    const result:Band[]=[];
    for(let x=0;x<columns.length;){
        if(!columns[x]){x++;continue;}
        if(!budget.remaining)return;
        budget.remaining--;const start=x;while(x<columns.length&&columns[x])x++;
        result.push({start,end:x});
    }
    return result;
}
function significant(items:Band[]):Array<Band&{after:number}> {
    const gaps=items.slice(1).map((item,i)=>({start:items[i].end,end:item.start,after:i+1}));
    const sorted=[...gaps].sort((a,b)=>a.end-a.start-(b.end-b.start)||a.after-b.after),rank=new Map(sorted.map((gap,i)=>[gap,i]));
    const mid=Math.floor((gaps.length-1)/2);
    return gaps.filter(gap=>{const other=sorted[mid+(rank.get(gap)!<=mid?1:0)];return gap.end-gap.start>=2*(other.end-other.start)+1;});
}

function resolve(low:Uint8Array,middle:Uint8Array,high:Uint8Array,budget:MangaRecognitionInkBudget):MangaRecognitionInkProjection|undefined {
    const lower=bands(low,budget);if(!lower)return;
    const center=bands(middle,budget);if(!center||center.length<4||center.length>64)return;
    const upper=bands(high,budget);if(!upper||upper.length!==center.length||upper.some((b,i)=>b.start<center[i].start||b.end>center[i].end))return;
    const lowGaps=new Map<number,Band>();let cursor=0;
    for(let i=0;i<lower.length;i++){
        const first=cursor;while(cursor<center.length&&center[cursor].start<lower[i].end)cursor++;
        if(cursor===first||cursor-first>2||(cursor-first===2&&center[cursor-1].start-center[first].end>2))return;
        if(i+1<lower.length)lowGaps.set(cursor,{start:lower[i].end,end:lower[i+1].start});
    }
    // 强层字形包含于弱层；共同空列不能凭阈值切断真实连接。显著词隙至少三像素，不会被允许的两像素弱层连合吞掉。
    const highGaps=new Set(significant(upper).map(gap=>gap.after)),gaps=significant(center).filter(gap=>highGaps.has(gap.after))
        .map(gap=>({...lowGaps.get(gap.after)!,after:gap.after}));
    return gaps.length?{characters:center.length,gaps}:undefined;
}

/** 非恒色中性底只提供字形空列，不能改写字母；调用方预付像素观察并在失败后保留组件扣费。 */
export function observeMangaRecognitionNeutralProjection(data:Uint8ClampedArray,width:number,budget:MangaRecognitionInkBudget):MangaRecognitionInkProjection|undefined {
    if(!Number.isSafeInteger(width)||width<8||width*48>262_144||!(data instanceof Uint8ClampedArray)||data.length!==width*48*4
        ||!Number.isSafeInteger(budget.remaining)||budget.remaining<=0)return;
    const low=new Uint8Array(width),middle=new Uint8Array(width),high=new Uint8Array(width);
    for(let y=0;y<48;y++)for(let x=0;x<width;x++){
        const p=(y*width+x)*4,r=data[p],g=data[p+1],b=data[p+2],value=Math.max(r,g,b);
        if(data[p+3]!==255||value-Math.min(r,g,b)>16||((x===0||x===width-1)&&value<220))return;
        if(value<=160)low[x]=1;if(value<=120)middle[x]=1;if(value<=80)high[x]=1;
    }
    return resolve(low,middle,high,budget);
}

/** 调用方预付两遍完整像素扫描；失败也不返还组件预算。 */
export function observeMangaRecognitionInkProjection(data:Uint8ClampedArray,width:number,budget:MangaRecognitionInkBudget):MangaRecognitionInkProjection|undefined {
    return observePaletteProjection(data,width,budget,false);
}

/** 浅色有色底只放行上下紧裁；左右背景、内部单一墨色及三层字序须分别成立。 */
export function observeMangaRecognitionTintedProjection(data:Uint8ClampedArray,width:number,budget:MangaRecognitionInkBudget):MangaRecognitionInkProjection|undefined {
    return observePaletteProjection(data,width,budget,true);
}

/** 深色紧裁不借用角点猜底色；调用方预付两遍完整像素扫描，间隙必须另有完整源色空列。 */
export function observeMangaRecognitionDarkProjection(data:Uint8ClampedArray,width:number,budget:MangaRecognitionInkBudget):MangaRecognitionInkProjection|undefined {
    if(!Number.isSafeInteger(width)||width<8||width*48>262_144||!(data instanceof Uint8ClampedArray)||data.length!==width*48*4
        ||!Number.isSafeInteger(budget.remaining)||budget.remaining<=0)return;
    const colors=new Map<number,number>(),rgb=(key:number)=>[key&255,key>>>8&255,key>>>16&255];
    for(let p=0;p<data.length;p+=4){
        if(data[p+3]!==255)return;
        const key=data[p]|data[p+1]<<8|data[p+2]<<16;colors.set(key,(colors.get(key)??0)+1);if(colors.size>4096)return;
    }
    let backgroundKey=0,backgroundCount=0,ambiguous=false;
    for(const [key,count]of colors){
        if(Math.max(...rgb(key))>64)continue;
        if(count>backgroundCount){backgroundKey=key;backgroundCount=count;ambiguous=false;}
        else if(count===backgroundCount)ambiguous=true;
    }
    if(ambiguous||backgroundCount<width*48*.2)return;
    const background=rgb(backgroundKey),distance=(color:readonly number[])=>Math.max(...color.map((value,c)=>Math.abs(value-background[c])));
    let candidate=0,count=0,significantPixels=0;
    for(const [key,n]of colors){if(distance(rgb(key))<24)continue;significantPixels+=n;if(n>count){candidate=key;count=n;}}
    if(count<8)return;
    const ink=rgb(candidate);let support=0;
    for(const [key,n]of colors)if(rgb(key).every((value,c)=>Math.abs(value-ink[c])<=1))support+=n;
    if(support<significantPixels*.1||getImageRgbContrast(ink,background)<3)return;
    for(const key of colors.keys())if(!matchesImageSourceInk(rgb(key),background,ink))return;
    const low=new Uint8Array(width),middle=new Uint8Array(width),high=new Uint8Array(width),empty=new Uint8Array(width).fill(1);
    const lowLevel=Math.ceil(distance(ink)/16),middleLevel=Math.ceil(distance(ink)/8),highLevel=Math.ceil(distance(ink)/4);
    for(let y=0;y<48;y++)for(let x=0;x<width;x++){
        const p=(y*width+x)*4,d=Math.max(Math.abs(data[p]-background[0]),Math.abs(data[p+1]-background[1]),Math.abs(data[p+2]-background[2]));
        if(d!==0)empty[x]=0;
        if(d>=lowLevel)low[x]=1;if(d>=middleLevel)middle[x]=1;if(d>=highLevel)high[x]=1;
    }
    const projection=resolve(low,middle,high,budget);if(!projection)return;
    const gaps:Array<Band&{after:number}>=[];
    for(const gap of projection.gaps){
        let start=gap.start,end=gap.end;
        while(start<end&&!empty[start])start++;
        while(end>start&&!empty[end-1])end--;
        if(start-gap.start>2||gap.end-end>2||end-start<3)continue;
        let clear=true;for(let x=start;x<end;x++)if(!empty[x]){clear=false;break;}
        if(clear)gaps.push({start,end,after:gap.after});
    }
    return gaps.length?{characters:projection.characters,gaps}:undefined;
}

function observePaletteProjection(data:Uint8ClampedArray,width:number,budget:MangaRecognitionInkBudget,tinted:boolean):MangaRecognitionInkProjection|undefined {
    if(!Number.isSafeInteger(width)||width<8||width*48>262_144||!(data instanceof Uint8ClampedArray)||data.length!==width*48*4
        ||!Number.isSafeInteger(budget.remaining)||budget.remaining<=0)return;
    const background=[data[0],data[1],data[2]],colors=new Map<number,number>();
    if(tinted&&(Math.max(...background)<220||Math.max(...background)-Math.min(...background)<=16))return;
    for(let y=0;y<48;y++)for(let x=0;x<width;x++){
        const p=(y*width+x)*4,r=data[p],g=data[p+1],b=data[p+2];
        if(data[p+3]!==255||((!x||x===width-1||!tinted&&(!y||y===47))&&(r!==background[0]||g!==background[1]||b!==background[2])))return;
        const key=r|g<<8|b<<16;colors.set(key,(colors.get(key)??0)+1);if(colors.size>4096)return;
    }
    const rgb=(key:number)=>[key&255,key>>>8&255,key>>>16&255];
    const distance=(color:readonly number[])=>Math.max(...color.map((value,c)=>Math.abs(value-background[c])));
    let count=0,candidate=0,significantPixels=0;
    for(const [key,n] of colors){if(distance(rgb(key))<24)continue;significantPixels+=n;if(n>count){count=n;candidate=key;}}
    if(count<8)return;
    const ink=rgb(candidate);let support=0;
    // 原生缩放会把实心墨色分到相邻量化值；只合计一字节邻域，候选仍是实际最多的源色。
    for(const [key,n] of colors)if(rgb(key).every((value,c)=>Math.abs(value-ink[c])<=1))support+=n;
    if(support<significantPixels*.1||getImageRgbContrast(ink,background)<3)return;
    for(const key of colors.keys())if(!matchesImageSourceInk(rgb(key),background,ink))return;
    const low=new Uint8Array(width),middle=new Uint8Array(width),high=new Uint8Array(width),lowLevel=Math.ceil(distance(ink)/16),middleLevel=Math.ceil(distance(ink)/8),highLevel=Math.ceil(distance(ink)/4);
    for(let y=0;y<48;y++)for(let x=0;x<width;x++){
        const p=(y*width+x)*4;
        if(tinted){
            const value=Math.max(data[p],data[p+1],data[p+2]);
            if(value<=160)low[x]=1;if(value<=120)middle[x]=1;if(value<=80)high[x]=1;
        }else{
            const d=Math.max(Math.abs(data[p]-background[0]),Math.abs(data[p+1]-background[1]),Math.abs(data[p+2]-background[2]));
            if(d>=lowLevel)low[x]=1;if(d>=middleLevel)middle[x]=1;if(d>=highLevel)high[x]=1;
        }
    }
    return resolve(low,middle,high,budget);
}

/**
 * @file src/features/image-translation/services/imageParagraphGapEvidence.ts
 * 文件职责：用同次图片 OCR 已读取的原始RGBA，为少量紧邻小字和大行距物理行提供私有、可撤回的布局续行关系。
 * 小字续行：狭窄走廊保留至少两行实测像素，中心对齐的未完句同时验证两端前景与完整平滑间隙；相邻关系不受更早或更晚的段内行干扰。已被像素证明选中的空格视图可通过内部原对象来历保留几何关系，克隆、坐标或非空格文字变化仍拒绝。
 * 主要内容：先限定横排字号、列投影和邻接范围，再按页预扣128次/1Mi源观察面积、每ROI64Ki预算；H8唯一静区、完整横向空白走廊和左右行单元共同排除边线与控件附件；不透明精确平色间隙还须证明两行处于同一封闭matte owner；原始对象及完整快照随同页graph跨Worker，实际去重采用后绑定数组、原图及尺寸，整段包络仍受所有物理行和数值guard阻挡。
 * 样式边界：逐列渐变候选的行高差超过20%时，最多额外观察262,144像素面积并复用同页源色；两个已确认墨色的对比达到3时撤回额外续行，避免大标题与副标题因同底色被并成一种样式。未知字色沿用原规则，这项观察只撤回关系，不授予写入或新增合段权限。
 * 墨迹间距：两端完整静区已经提供真实字形边界时，常规续行的2.5倍行距还须按较小实测字高核对，OCR留白不能放大可接受间隙；明确过远的原字形不借平色回退再次合段。消费者对实际墨迹证明执行相同限制，虚拟profile边界不冒充实测字形；大面积透明页的已授权长间距路径仍独立核对。
 * 背景归属：以实际墨迹静区外角作为seed，避免OCR框外伸笔画占据旧起点；矩形证明之后可沿四邻封闭外轮廓取得owner边界，第二seed仍须有实色路径连到已验证边界，不能用包络包含代替连通。每个读取tile仍按原1Mi预算预付并进入receipt，失败不发布部分轮廓，内孔或过长边界仍沿用原洪泛路径。
 * 模块边界：不创建Canvas、不运行模型、不翻译或修改文字、不保留像素或擦除mask；缺失、歧义、预算不足及对象替换均回到原严格行距，静区布局不授权修补或绘字。普通图片可延迟给段落排版读取旁证；漫画可在结果收集时一次性消费旁证，仍需保留原始单行框。
 */
import type {ImageParagraphContinuations,ImageTextRegion} from '../paragraphs';
import type {MangaOcrItem} from './mangaRegions';
import {numericProtection} from './mangaNumeric';
import {getMangaViewWordBoundaryGeometrySource,getMangaViewWordBoundaryProvenance} from './mangaViewWordBoundary';
import {normalizeMangaSourceText} from './mangaRegions';
import {imageMatteObservationBox,observeImageMatteGeometry,type ImageMatteGeometry,type ImageMatteObservationBox} from './imageMatteRepair';
import {observeImageSourceInk} from './sourceInk';
import {getImageRgbContrast} from './rendering';
import {traceImageMatteBoundary} from './imageMatteBoundary';
type Box=ImageTextRegion['bbox'];
/** 只读取段落所需的物理行与归属；不反向依赖采用此证明的气泡消费者。 */
interface ImageParagraphPage {results:MangaOcrItem[];numericEvidence?:MangaOcrItem[];bubbles?:Array<{bbox:Box;results:MangaOcrItem[];numericEvidence?:MangaOcrItem[]}>;layoutBubbles?:Array<{bbox:Box}>;largeAlphaHoles?:true;imageParagraphGapProofs?:ImageParagraphGapProof[]}
type Snapshot={text:string;confidence:number;box:MangaOcrItem['box']};
type RegionSnapshot={text:string;bbox:Box;fontSize?:number;vertical?:true;sourceBoxes?:Box[];guardOnly?:true;numericUncertain?:true};
export interface ImageParagraphGapProof {
    version:'image-paragraph-gap-v1';width:number;height:number;ordinal:number;pixels:number;
    /** 逐列渐变、低对比场或紧邻行平滑走廊；tight-field另复核对齐、句末与两端真实前景。 */
    /** flat-owner还要求精确平色间隙采样及同一封闭matte receipt。 */
    mode?:'column-profile'|'smooth-field'|'flat-owner'|'tight-field';
    /** flat-owner只记录经像素核验的共同背景采样列，消费端核对其有界几何。 */
    flatOwner?:{x:number;anchorY:number;targetY:number;runStart:number;runEnd:number};
    /** only permit a long, strongly aligned gap on a source page with substantial transparent canvas area. */
    alphaLongContinuation?:true;
    previous:MangaOcrItem;next:MangaOcrItem;previousSnapshot:Snapshot;nextSnapshot:Snapshot;
    previousGeometry:ImageMatteGeometry;nextGeometry:ImageMatteGeometry;
    /** 仅未知截断外部组件需要：完整封闭matte owner与真实收费的tile footprint，无像素或mask。 */
    topology?:{owner:Box;tiles:ImageMatteObservationBox[]};
}
const VERSION='image-paragraph-gap-v1',MAX_PAIRS=128,MAX_PIXELS=1_048_576,MAX_ROI=65_536,MAX_ITEMS=4096,MAX_COMPARISONS=32_768;
/** Bound low-contrast translucent fields separately from exact opaque gradient profiles. */
const SMOOTH_FIELD_MIN_SPREAD=16,SMOOTH_FIELD_MAX_SPREAD=24,SMOOTH_FIELD_MAX_RGB_STEP=10,SMOOTH_FIELD_MAX_RGB_DRIFT=20;
const SMOOTH_FIELD_MAX_ALPHA_STEP=16,SMOOTH_FIELD_MAX_ALPHA_DRIFT=48,SMOOTH_FIELD_MAX_ALPHA_RANGE=64;
/** 保留2–5px框缘隔离及至少两行待验证像素；宽间距仍沿用5px，窄间距不能被固定余量吞掉。 */
function gapTextClearance(a:Box,b:Box):number {return Math.max(2,Math.min(5,Math.floor((Math.floor(b.y0)-Math.ceil(a.y1)-2)/2)));}
/** OCR框缘可能贴近字形；放宽候选只增加像素复核机会，不单独授权合段。 */
const MAX_PARAGRAPH_LINE_HEIGHT_RATIO=1.35;
class ImageParagraphResourceError extends Error {}
/** 生产固定64Ki条目（256KiB）；小容量仍遵循同一FIFO/回绕/溢出契约，不能扩大硬上限。 */
export function createImageParagraphWorkQueue(capacity=MAX_ROI) {
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>MAX_ROI)throw new ImageParagraphResourceError('图片段落队列容量无效');
    const values=new Uint32Array(capacity);let head=0,tail=0,size=0;
    return {push(value:number):void {if(size===capacity)throw new ImageParagraphResourceError('图片段落观察队列已满');values[tail]=value;tail=(tail+1)%capacity;size++;},
        shift():number|undefined {if(!size)return;const value=values[head];head=(head+1)%capacity;size--;return value;},
        clear():void {head=tail=size=0;},get size(){return size;}};
}
const pending=new WeakMap<object,{width:number;height:number;support:ImageParagraphContinuations}>();
const bindings=new WeakMap<object,{image:string;width:number;height:number;support:ImageParagraphContinuations}>();
const boxOf=(item:MangaOcrItem):Box=>({x0:item.box.x,y0:item.box.y,x1:item.box.x+item.box.width,y1:item.box.y+item.box.height});
const snapshot=(item:MangaOcrItem):Snapshot=>({text:item.text,confidence:item.confidence,box:{...item.box}});
const sameBox=(a:Box,b:Box)=>a.x0===b.x0&&a.y0===b.y0&&a.x1===b.x1&&a.y1===b.y1;
const singleSourceRegion=(line:ImageTextRegion)=>!line.sourceBoxes||line.sourceBoxes.length===1&&sameBox(line.sourceBoxes[0],line.bbox);
const intersects=(a:Box,b:Box)=>a.x0<b.x1&&a.x1>b.x0&&a.y0<b.y1&&a.y1>b.y0;
const area=(box:Box)=>(box.x1-box.x0)*(box.y1-box.y0);
const inkObservationArea=(box:Box)=>(Math.ceil(box.x1)-Math.floor(box.x0))*(Math.ceil(box.y1)-Math.floor(box.y0));
function pageSize(width:number,height:number):boolean {return [width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192)&&width*height<=16_777_216;}
function validBox(box:Box,width:number,height:number):boolean {return [box.x0,box.y0,box.x1,box.y1].every(Number.isFinite)&&box.x0>=0&&box.y0>=0&&box.x1<=width&&box.y1<=height&&box.x1>box.x0&&box.y1>box.y0;}
function itemsOf(page:ImageParagraphPage):MangaOcrItem[]|undefined {
    if(!Array.isArray(page.results)||!Array.isArray(page.bubbles??[]))return;
    const items:MangaOcrItem[]=[];
    for(const rows of [page.results,...(page.bubbles??[]).map(b=>b.results)]){
        if(!Array.isArray(rows)||items.length+rows.length>MAX_ITEMS)return;
        items.push(...rows);
    }
    return items;
}
function sameItem(item:MangaOcrItem,value:Snapshot):boolean {return !!item?.box&&!!value?.box&&item.text===value.text&&item.confidence===value.confidence&&['x','y','width','height'].every(key=>item.box[key as keyof Snapshot['box']]===value.box[key as keyof Snapshot['box']]);}
function eligible(item:MangaOcrItem,width:number,height:number):boolean {return !!item?.box&&typeof item.text==='string'&&item.text.length>0&&item.text.length<=4096&&Number.isFinite(item.confidence)&&item.confidence>=.65&&item.confidence<=1&&!numericProtection(item.text)&&validBox(boxOf(item),width,height)&&item.box.width>=item.box.height;}
function potential(a:Box,b:Box,wide=true):boolean {
    const ah=a.y1-a.y0,bh=b.y1-b.y0,small=Math.min(ah,bh),gap=b.y0-a.y1;
    return Math.max(ah,bh)<=small*MAX_PARAGRAPH_LINE_HEIGHT_RATIO&&gap>=0&&gap<=small*2.5&&b.y0-a.y0>=small*.7
        &&(!wide||Math.floor(gap)>Math.floor(small*.65))
        &&Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0)>=Math.min(a.x1-a.x0,b.x1-b.x0)*.5
        &&Math.min(Math.abs(a.x0-b.x0),Math.abs(a.x1-b.x1),Math.abs(a.x0+a.x1-b.x0-b.x1)/2)<=small*.8;
}
/** 完整墨迹只收紧原候选间距；单独满足此式不提供续段或写图权限。 */
function observedInkGapFits(previous:ImageMatteGeometry,next:ImageMatteGeometry):boolean {
    const a=previous.supportBox,b=next.supportBox;
    return b.y0-a.y1<=Math.min(a.y1-a.y0,b.y1-b.y0)*2.5;
}
/** 紧邻居中续行仅豁免小幅行距：字号接近、无句末、中心相合，仍须逐像素验证完整间隙。 */
function tightContinuation(previous:MangaOcrItem,next:MangaOcrItem):boolean {
    const a=boxOf(previous),b=boxOf(next),small=Math.min(a.y1-a.y0,b.y1-b.y0);
    return !/[.!?。！？…]$/u.test(previous.text.trim())&&b.y0-a.y1<=small*.9
        &&Math.max(a.y1-a.y0,b.y1-b.y0)<=small*1.2
        &&Math.abs(a.x0+a.x1-b.x0-b.x1)/2<=small*.3;
}
/** Transparent canvas layouts can leave larger line gaps; require near-identical column geometry. */
function alphaLongPotential(a:Box,b:Box):boolean {
    const ah=a.y1-a.y0,bh=b.y1-b.y0,small=Math.min(ah,bh),gap=b.y0-a.y1,overlap=Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0);
    return gap>small*2.5&&gap<=small*3.4&&Math.max(ah,bh)<=small*1.12
        &&Math.abs(a.x0-b.x0)<=small*.15&&overlap>=Math.min(a.x1-a.x0,b.x1-b.x0)*.88;
}
function owner(item:MangaOcrItem,page:ImageParagraphPage):object|undefined {
    const b=boxOf(item),x=(b.x0+b.x1)/2,y=(b.y0+b.y1)/2;
    let selected:object|undefined,size=Infinity;
    for(const candidate of [...(page.bubbles??[]),...(page.layoutBubbles??[])]){
        const c=candidate.bbox,measure=area(c);
        if(x>=c.x0&&x<c.x1&&y>=c.y0&&y<c.y1&&measure<size){selected=candidate;size=measure;}
    }
    return selected;
}
function validGeometry(g:ImageMatteGeometry,source:Box,width:number,height:number,allowTranslucent=false):boolean {
    const expected=imageMatteObservationBox(width,height,source);
    return !!g&&!!expected&&['left','top','width','height'].every(k=>g[k as keyof typeof expected]===expected[k as keyof typeof expected])
        &&Array.isArray(g.background)&&g.background.length===4&&g.background.every(v=>Number.isSafeInteger(v)&&v>=0&&v<=255)&&(allowTranslucent||g.background[3]===255)
        &&!!g.supportBox&&validBox(g.supportBox,width,height)&&intersects(g.supportBox,source)
        &&g.supportBox.x0>=g.left&&g.supportBox.y0>=g.top&&g.supportBox.x1<=g.left+g.width&&g.supportBox.y1<=g.top+g.height;
}
/** 由同一pair的完整墨迹和列gutter导出观察域，不以文字含义或固定坐标选择附件。 */
function layout(a:Box,b:Box,ga:ImageMatteGeometry,gb:ImageMatteGeometry,items:MangaOcrItem[],width:number,height:number):Box[]|undefined {
    if(!ga.background.every((v,i)=>v===gb.background[i]))return;
    const small=Math.min(a.y1-a.y0,b.y1-b.y0),envelope={x0:Math.min(a.x0,b.x0),x1:Math.max(a.x1,b.x1),y0:a.y0,y1:b.y1};
    let left=0,right=width;
    for(const item of items){const c=boxOf(item);if(c.x1<envelope.x0-small)left=Math.max(left,Math.ceil((envelope.x0+c.x1)/2));if(c.x0>envelope.x1+small)right=Math.min(right,Math.floor((envelope.x1+c.x0)/2));}
    const pitch=(b.y0+b.y1-a.y0-a.y1)/2;
    const windows=[{x0:Math.floor(envelope.x0),x1:Math.ceil(envelope.x1),y0:Math.ceil(ga.supportBox.y1),y1:Math.floor(gb.supportBox.y0)}];
    for(const [box,g] of [[a,ga],[b,gb]] as const){
        const center=(box.y0+box.y1)/2,y0=Math.max(0,Math.floor(center-pitch/2)-2),y1=Math.min(height,Math.ceil(center+pitch/2)+2);
        windows.push({x0:left,x1:Math.floor(g.supportBox.x0)-1,y0,y1},{x0:Math.ceil(g.supportBox.x1)+1,x1:right,y0,y1});
    }
    return windows.every(box=>validBox(box,width,height)&&area(box)<=MAX_ROI)?windows:undefined;
}
const packed=(p:Uint8ClampedArray,i:number)=>(p[i]|p[i+1]<<8|p[i+2]<<16|p[i+3]<<24)>>>0;
function clearWindow(pixels:Uint8ClampedArray,width:number,box:Box,bg:number,side:boolean,check:()=>void,outside:(seed:number)=>boolean):boolean {
    const w=box.x1-box.x0,h=box.y1-box.y0,colors=new Uint32Array(w*h);
    for(let y=0;y<h;y++){check();for(let x=0;x<w;x++){const value=packed(pixels,((box.y0+y)*width+box.x0+x)*4);if(!side&&value!==bg)return false;colors[y*w+x]=value;}}
    if(!side)return true;
    const seen=new Uint8Array(w*h),queue=new Uint32Array(w*h);
    for(let start=0;start<colors.length;start++){
        if(seen[start]||colors[start]===bg)continue;
        let head=0,tail=1,x0=w,y0=h,x1=0,y1=0;queue[0]=start;seen[start]=1;
        while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1);
            for(let yy=Math.max(0,y-1);yy<=Math.min(h-1,y+1);yy++)for(let xx=Math.max(0,x-1);xx<=Math.min(w-1,x+1);xx++){const next=yy*w+xx;if(!seen[next]&&colors[next]!==bg){seen[next]=1;queue[tail++]=next;}}}
        // 触边数量不构成权限：截断组件必须真实连到同一封闭matte owner之外。
        if((x0>0&&x1<w&&y0>0&&y1<h)||!outside((box.y0+Math.floor(start/w))*width+box.x0+start%w))return false;
    }
    return true;
}

/** 同帧原像素的有界水平间隙；上下各留2px隔离框缘墨迹，避免字形污染底色剖面。 */
function pageGapEvidenceWindow(a:Box,b:Box,width:number,height:number):Box|undefined {
    const clearance=gapTextClearance(a,b);
    const box={x0:Math.floor(Math.min(a.x0,b.x0)),x1:Math.ceil(Math.max(a.x1,b.x1)),y0:Math.ceil(a.y1)+clearance,y1:Math.floor(b.y0)-clearance};
    return validBox(box,width,height)&&box.y1-box.y0>=2&&area(box)<=MAX_ROI?box:undefined;
}
/** 输入由pageGapEvidenceWindow限定：宽度不超过页宽，高度至少2px且已计入64KiB ROI预算。 */
function observeGapEvidence(pixels:Uint8ClampedArray,width:number,box:Box,profile:Uint32Array,previousRow:Uint32Array,check:()=>void,reserveRows:()=>boolean,tight=false):{mode:'column-profile'|'smooth-field'|'flat-owner'|'tight-field';background:[number,number,number,number];pixels:number}|null|undefined {
    const w=box.x1-box.x0,h=box.y1-box.y0;
    const minimum=[255,255,255],maximum=[0,0,0];
    let profileStep=0,maxStep=0,maxDrift=0,profileAlphaStep=0,maxAlphaStep=0,maxAlphaDrift=0,minimumAlpha=255,maximumAlpha=0,exactProfile=true,opaque=true;
    const update=(value:number)=>{
        const red=value&255,green=(value>>>8)&255,blue=(value>>>16)&255;
        minimum[0]=Math.min(minimum[0],red);maximum[0]=Math.max(maximum[0],red);
        minimum[1]=Math.min(minimum[1],green);maximum[1]=Math.max(maximum[1],green);
        minimum[2]=Math.min(minimum[2],blue);maximum[2]=Math.max(maximum[2],blue);
    };
    const channelStep=(a:number,b:number)=>Math.max(Math.abs((a&255)-(b&255)),Math.abs(((a>>>8)&255)-((b>>>8)&255)),Math.abs(((a>>>16)&255)-((b>>>16)&255)));
    for(let x=0;x<w;x++){
        const value=packed(pixels,(box.y0*width+box.x0+x)*4),alpha=value>>>24;if(alpha<128)return;
        profile[x]=previousRow[x]=value;update(value);
        minimumAlpha=Math.min(minimumAlpha,alpha);maximumAlpha=Math.max(maximumAlpha,alpha);if(alpha!==255)opaque=false;
        if(x){profileStep=Math.max(profileStep,channelStep(value,profile[x-1]));maxStep=Math.max(maxStep,profileStep);
            profileAlphaStep=Math.max(profileAlphaStep,Math.abs(alpha-(profile[x-1]>>>24)));maxAlphaStep=Math.max(maxAlphaStep,profileAlphaStep);}
    }
    const initialSpread=Math.max(maximum[0]-minimum[0],maximum[1]-minimum[1],maximum[2]-minimum[2]);
    const columnCandidate=opaque&&initialSpread>=24&&profileStep<=2&&profileAlphaStep===0;
    const smoothFieldCandidate=initialSpread>=SMOOTH_FIELD_MIN_SPREAD&&initialSpread<=SMOOTH_FIELD_MAX_SPREAD
        &&maxStep<=SMOOTH_FIELD_MAX_RGB_STEP&&profileAlphaStep<=SMOOTH_FIELD_MAX_ALPHA_STEP;
    const flatOwnerCandidate=initialSpread===0&&profileStep===0&&profileAlphaStep===0;
    const tightCandidate=tight&&opaque&&initialSpread<=48&&profileStep<=8;
    if(!columnCandidate&&!smoothFieldCandidate&&!flatOwnerCandidate&&!tightCandidate)return;
    if(!reserveRows())return null;
    for(let y=1;y<h;y++){
        check();let rowStep=0,previousValue=0;
        for(let x=0;x<w;x++){
            const value=packed(pixels,((box.y0+y)*width+box.x0+x)*4),alpha=value>>>24;if(alpha<128)return;
            if(value!==profile[x])exactProfile=false;
            maxDrift=Math.max(maxDrift,channelStep(value,profile[x]));
            maxAlphaDrift=Math.max(maxAlphaDrift,Math.abs(alpha-(profile[x]>>>24)));
            rowStep=Math.max(rowStep,channelStep(value,previousRow[x]));
            let alphaStep=Math.abs(alpha-(previousRow[x]>>>24));
            if(x){rowStep=Math.max(rowStep,channelStep(value,previousValue));alphaStep=Math.max(alphaStep,Math.abs(alpha-(previousValue>>>24)));}
            maxAlphaStep=Math.max(maxAlphaStep,alphaStep);minimumAlpha=Math.min(minimumAlpha,alpha);maximumAlpha=Math.max(maximumAlpha,alpha);
            previousValue=value;
            previousRow[x]=value;
        }
        maxStep=Math.max(maxStep,rowStep);
        if(!exactProfile&&(maxStep>SMOOTH_FIELD_MAX_RGB_STEP||maxAlphaStep>SMOOTH_FIELD_MAX_ALPHA_STEP))return;
    }
    const value=profile[0];
    if(tightCandidate&&maxStep<=8&&maxDrift<=8&&minimumAlpha===255&&maximumAlpha===255)
        return{mode:'tight-field',background:[value&255,(value>>>8)&255,(value>>>16)&255,255],pixels:w*h};
    if(flatOwnerCandidate&&exactProfile&&maxStep===0&&maxAlphaStep===0&&minimumAlpha===maximumAlpha)
        return{mode:'flat-owner',background:[value&255,(value>>>8)&255,(value>>>16)&255,minimumAlpha],pixels:w*h};
    if(exactProfile&&initialSpread>=24&&profileStep<=2)return{mode:'column-profile',background:[value&255,(value>>>8)&255,(value>>>16)&255,255],pixels:w*h};
    if(smoothFieldCandidate&&maxDrift<=SMOOTH_FIELD_MAX_RGB_DRIFT&&maxStep<=SMOOTH_FIELD_MAX_RGB_STEP
        &&maxAlphaDrift<=SMOOTH_FIELD_MAX_ALPHA_DRIFT&&maxAlphaStep<=SMOOTH_FIELD_MAX_ALPHA_STEP
        &&maximumAlpha-minimumAlpha<=SMOOTH_FIELD_MAX_ALPHA_RANGE)
        return{mode:'smooth-field',background:[value&255,(value>>>8)&255,(value>>>16)&255,255],pixels:w*h};
    return;
}

type TopologyReceipt=NonNullable<ImageParagraphGapProof['topology']>;
type Tile={geometry:ImageMatteObservationBox;classes:Uint8Array};
type MatteOwner={id:number;color:number;box:Box;keys:Set<number>;complete:boolean;rectangle?:true;contour?:true};
/** Only ordinary candidates with complete H8 matte geometry enter topology; that geometry guarantees an in-page pixel outside each source edge. */
/** 按页借已有RGBA懒分类，每tile只读源一次；仅保留1byte分类/owner标签，不复制RGBA。 */
function topologyPage(pixels:Uint8ClampedArray,width:number,height:number,backgrounds:number[],reserve:(count:number)=>boolean,check:()=>void) {
    const side=32,columns=Math.ceil(width/side),palette=new Map(backgrounds.map((color,index)=>[color,index+1]));
    const tiles=new Map<number,Tile>(),owners=new Map<number,MatteOwner>();let nextLabel=palette.size+1;
    let workQueue:ReturnType<typeof createImageParagraphWorkQueue>|undefined;
    const borrowQueue=()=>{const queue=workQueue??=createImageParagraphWorkQueue();queue.clear();return queue;};
    const geometry=(key:number):ImageMatteObservationBox=>{const left=(key%columns)*side,top=Math.floor(key/columns)*side;return{left,top,width:Math.min(side,width-left),height:Math.min(side,height-top)};};
    return (background:number,a:Box,b:Box)=>{
        const used=new Set<number>();let current:MatteOwner|undefined;
        function tileFor(x:number,y:number,ownerKeys?:Set<number>):Tile {
            const key=Math.floor(y/side)*columns+Math.floor(x/side);let tile=tiles.get(key);const g=tile?.geometry??geometry(key);
            if(!used.has(key)){if(!reserve(g.width*g.height))throw new ImageParagraphResourceError('图片段落观察预算已满');used.add(key);}
            ownerKeys?.add(key);
            if(!tile){
                const classes=new Uint8Array(g.width*g.height);
                for(let yy=0;yy<g.height;yy++){check();for(let xx=0;xx<g.width;xx++)classes[yy*g.width+xx]=palette.get(packed(pixels,((g.top+yy)*width+g.left+xx)*4))??0;}
                tile={geometry:g,classes};tiles.set(key,tile);
            }
            return tile;
        }
        const index=(tile:Tile,x:number,y:number)=>(y-tile.geometry.top)*tile.geometry.width+x-tile.geometry.left;
        function findOwner():MatteOwner|undefined {
            const x=Math.floor(a.x0)-1,y=Math.floor(a.y0)-1,color=palette.get(background)!;
            const first=tileFor(x,y);
            const label=first.classes[index(first,x,y)],cached=owners.get(label);
            if(cached){for(const key of cached.keys){const g=geometry(key);if(!used.has(key)){if(!reserve(g.width*g.height))throw new ImageParagraphResourceError('图片段落观察预算已满');used.add(key);}}return cached.complete?cached:undefined;}
            if(label!==color)return;
            if(nextLabel>255)throw new ImageParagraphResourceError('图片段落颜色标签已满');
            const owner:MatteOwner={id:nextLabel++,color,box:{x0:x,y0:y,x1:x+1,y1:y+1},keys:new Set(),complete:false};owners.set(owner.id,owner);
            const isBackground=(xx:number,yy:number)=>{const tile=tileFor(xx,yy,owner.keys),value=tile.classes[index(tile,xx,yy)];return value===color||owners.get(value)?.color===color;};
            // 严格矩形证书：完整matte内周长、四邻非matte外halo及seed连到内周长。
            // 因四邻外halo封闭且内周长已连通，可证明owner精确bbox，无需扫描内部holes。
            let left=x,right=x,top=y,bottom=y;
            while(left>0&&isBackground(left-1,y))left--;while(right<width-1&&isBackground(right+1,y))right++;
            while(top>0&&isBackground(left,top-1))top--;while(bottom<height-1&&isBackground(left,bottom+1))bottom++;
            let rectangle=left>0&&right<width-1&&top>0&&bottom<height-1;
            for(let xx=left;rectangle&&xx<=right;xx++)rectangle=isBackground(xx,top)&&isBackground(xx,bottom)&&!isBackground(xx,top-1)&&!isBackground(xx,bottom+1);
            for(let yy=top+1;rectangle&&yy<bottom;yy++)rectangle=isBackground(left,yy)&&isBackground(right,yy)&&!isBackground(left-1,yy)&&!isBackground(right+1,yy);
            if(rectangle){owner.box={x0:left,y0:top,x1:right+1,y1:bottom+1};owner.complete=true;owner.rectangle=true;first.classes[index(first,x,y)]=owner.id;return owner;}
            const contour=traceImageMatteBoundary(width,height,x,y,isBackground,check);
            if(contour){
                owner.box=contour.box;owner.complete=true;owner.contour=true;
                // No partial contour labels may escape a failed/cancelled trace.
                for(const p of contour.points){const xx=p%width,yy=Math.floor(p/width),tile=tileFor(xx,yy,owner.keys);tile.classes[index(tile,xx,yy)]=owner.id;}
                first.classes[index(first,x,y)]=owner.id;return owner;
            }
            // 64Ki条目，即256KiB；仅环形待处理前沿，不按整页分配队列。
            const queue=borrowQueue();let steps=0;
            function push(xx:number,yy:number):void {
                const tile=tileFor(xx,yy,owner.keys),at=index(tile,xx,yy);
                const label=tile.classes[at];
                if(label!==color){
                    // 早退/失败的其他owner标签仍是同色matte，不能作为封闭边界剪断连通域。
                    // 当前owner自身的已访问点才可跳过；跨owner同色关系未证明则整项撤回。
                    if(label!==owner.id&&owners.get(label)?.color===color)throw new ImageParagraphResourceError('图片段落同色归属尚未证明');
                    return;
                }
                queue.push(yy*width+xx);tile.classes[at]=owner.id;
            }
            push(x,y);
            while(queue.size){if((steps++&1023)===0)check();const p=queue.shift()!,xx=p%width,yy=Math.floor(p/width);
                if(xx===0||yy===0||xx===width-1||yy===height-1)return;
                owner.box.x0=Math.min(owner.box.x0,xx);owner.box.y0=Math.min(owner.box.y0,yy);owner.box.x1=Math.max(owner.box.x1,xx+1);owner.box.y1=Math.max(owner.box.y1,yy+1);
                push(xx-1,yy);push(xx+1,yy);push(xx,yy-1);push(xx,yy+1);
            }
            owner.complete=true;return owner;
        }
        function sameOwner():MatteOwner|undefined {
            const owner=current??findOwner();if(!owner)return;
            const x=Math.floor(b.x0)-1,y=Math.floor(b.y0)-1;
            const tile=tileFor(x,y);
            if(owner.rectangle){
                if(x<owner.box.x0||x>=owner.box.x1||y<owner.box.y0||y>=owner.box.y1)return;
                for(let xx=owner.box.x0;xx<=x;xx++){const t=tileFor(xx,y),label=t.classes[index(t,xx,y)];if(label!==owner.color&&owners.get(label)?.color!==owner.color)return;}
            }else if(owner.contour){
                // Bbox containment cannot identify islands inside a closed outline.
                // Each ray must remain actual background until a verified boundary.
                let connected=false;
                for(const [dx,dy]of [[-1,0],[1,0],[0,-1],[0,1]]){
                    for(let xx=x,yy=y;xx>=owner.box.x0&&xx<owner.box.x1&&yy>=owner.box.y0&&yy<owner.box.y1;xx+=dx,yy+=dy){
                        const t=tileFor(xx,yy),label=t.classes[index(t,xx,yy)];
                        if(label===owner.id){connected=true;break;}
                        if(label!==owner.color&&owners.get(label)?.color!==owner.color)break;
                    }
                    if(connected)break;
                }
                if(!connected)return;
            }else if(tile.classes[index(tile,x,y)]!==owner.id)return;
            current=owner;return owner;
        }
        return {
            outside(seed:number):boolean {
                const owner=sameOwner();if(!owner)return false;
                const queue=borrowQueue(),seen=new Set<number>();
                function push(p:number):void {
                    if(seen.has(p))return;const x=p%width,y=Math.floor(p/width),tile=tileFor(x,y);
                    const label=tile.classes[index(tile,x,y)];if(label===owner!.color||owners.get(label)?.color===owner!.color)return;
                    if(seen.size===MAX_ROI)throw new ImageParagraphResourceError('图片段落外部观察范围已满');queue.push(p);seen.add(p);
                }
                push(seed);
                while(queue.size){check();const p=queue.shift()!,x=p%width,y=Math.floor(p/width);
                    if(x<owner.box.x0||x>=owner.box.x1||y<owner.box.y0||y>=owner.box.y1)return true;
                    push(p-1);push(p+1);push(p-width);push(p+width);
                }
                return false;
            },
            receipt():TopologyReceipt|undefined {return current?{owner:{...current.box},tiles:[...used].map(geometry)}:undefined;},
        };
    };
}

function receiptPixels(receipt:TopologyReceipt|undefined,width:number,height:number,a:Box,b:Box):number|undefined {
    if(!receipt)return 0;
    const owner=receipt.owner;
    if(!owner||!validBox(owner,width,height)||![owner.x0,owner.y0,owner.x1,owner.y1].every(Number.isSafeInteger)||owner.x0===0||owner.y0===0||owner.x1===width||owner.y1===height
        ||owner.x0>a.x0||owner.y0>a.y0||owner.x1<a.x1||owner.y1<a.y1||owner.x0>b.x0||owner.y0>b.y0||owner.x1<b.x1||owner.y1<b.y1||!Array.isArray(receipt.tiles)||!receipt.tiles.length||receipt.tiles.length>2048)return;
    let count=0;const keys=new Set<string>();
    for(const g of receipt.tiles){
        if(!g||![g.left,g.top,g.width,g.height].every(Number.isSafeInteger)||g.left<0||g.top<0||g.left>=width||g.top>=height||g.left%32||g.top%32||g.width!==Math.min(32,width-g.left)||g.height!==Math.min(32,height-g.top))return;
        const key=`${g.left},${g.top}`;if(keys.has(key))return;keys.add(key);count+=g.width*g.height;if(count>MAX_PIXELS)return;
    }
    return count;
}

/** 借同次OCR已有原始RGBA；所有候选/失败观察先收费，返回仅含原对象与有界标量。 */
export function produceImageParagraphGapProofs(page:ImageParagraphPage,width:number,height:number,pixels:Uint8ClampedArray,checkActive:()=>void=()=>{}):ImageParagraphGapProof[] {
    checkActive();const all=itemsOf(page);
    if(!pageSize(width,height)||!(pixels instanceof Uint8ClampedArray)||pixels.length!==width*height*4||!all)return [];
    const physical=all.filter(item=>!!item?.box&&validBox(boxOf(item),width,height));
    const lines=physical.filter(item=>eligible(item,width,height)).sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x),proofs:ImageParagraphGapProof[]=[];
    const candidates:Array<Omit<ImageParagraphGapProof,'version'|'width'|'height'|'pixels'|'topology'>&{
        endpointArea:number;windows:Box[];precheckedGap?:Box;topologyBackground?:number
    }> = [];
    const cache=new Map<MangaOcrItem,ImageMatteGeometry|undefined>();let attempts=0,charged=0,comparisons=0;
    // 相同渐变底不能证明同一视觉段落。额外源色观察只撤回已有候选，不提供合段或清字权限。
    const styleColors=new Map<MangaOcrItem,number[]|undefined>();let stylePixels=0;
    const styleColor=(item:MangaOcrItem,roi:ImageMatteObservationBox)=>{
        if(styleColors.has(item))return styleColors.get(item);
        const cost=roi.width*roi.height*2;
        if(stylePixels+cost>262_144)return;
        stylePixels+=cost;checkActive();const box=boxOf(item);
        const color=observeImageSourceInk(pixels,width,height,box,[box])?.foreground?.slice(4,-1).split(',').map(Number);
        styleColors.set(item,color);checkActive();return color;
    };
    let gapProfile:Uint32Array|undefined,gapPreviousRow:Uint32Array|undefined;
    const reserve=(count:number)=>{if(count>MAX_PIXELS-charged)return false;charged+=count;return true;};
    const proveSmoothGap=(previous:MangaOcrItem,next:MangaOcrItem,previousSnapshot:Snapshot,nextSnapshot:Snapshot,ordinal:number,
        endpointArea:number,oa:ImageMatteObservationBox,ob:ImageMatteObservationBox,allowFlatOwner=true,alphaLongContinuation=false):boolean|'budget'=>{
        const a=boxOf(previous),b=boxOf(next),profileBox=pageGapEvidenceWindow(a,b,width,height);if(!profileBox)return false;
        const profileWidth=profileBox.x1-profileBox.x0;if(!reserve(profileWidth))return 'budget';
        gapProfile??=new Uint32Array(width);gapPreviousRow??=new Uint32Array(width);
        const profile=observeGapEvidence(pixels,width,profileBox,gapProfile,gapPreviousRow,checkActive,()=>reserve(area(profileBox)-profileWidth),tightContinuation(previous,next));
        if(profile===null)return 'budget';if(!profile||!sameItem(previous,previousSnapshot)||!sameItem(next,nextSnapshot))return false;
        if(profile.mode==='tight-field'){
            // 两端也必须有真实前景；这个额外观察预付整个源框，提前找到墨迹也不退回预算。
            if(!reserve(inkObservationArea(a)+inkObservationArea(b)))return 'budget';
            const hasInk=(box:Box)=>{
                let count=0;const required=Math.max(3,Math.ceil((box.y1-box.y0)/2));
                for(let y=Math.floor(box.y0);y<Math.ceil(box.y1);y++){
                    checkActive();
                    for(let x=Math.floor(box.x0);x<Math.ceil(box.x1);x++){
                        const i=(y*width+x)*4;
                        if(pixels[i+3]>=128&&Math.max(Math.abs(pixels[i]-profile.background[0]),Math.abs(pixels[i+1]-profile.background[1]),Math.abs(pixels[i+2]-profile.background[2]))>=48&&++count>=required)return true;
                    }
                }
                return false;
            };
            if(!hasInk(a)||!hasInk(b))return false;
        }
        const own=new Set([previous,next]),envelope={x0:Math.min(a.x0,b.x0),x1:Math.max(a.x1,b.x1),y0:a.y0,y1:b.y1};
        if(physical.some(item=>!own.has(item)&&!intersects(boxOf(item),a)&&!intersects(boxOf(item),b)&&intersects(boxOf(item),envelope)))return false;
        if(profile.mode==='column-profile'&&Math.max(a.y1-a.y0,b.y1-b.y0)>Math.min(a.y1-a.y0,b.y1-b.y0)*1.2){
            const first=styleColor(previous,oa),second=styleColor(next,ob);
            if(!sameItem(previous,previousSnapshot)||!sameItem(next,nextSnapshot)||first&&second&&getImageRgbContrast(first,second)>=3)return false;
        }
        if(profile.mode==='flat-owner'){
            const previousOwner=owner(previous,page),nextOwner=owner(next,page),sameBubble=previousOwner!==undefined&&previousOwner===nextOwner;
            const lineHeight=Math.min(a.y1-a.y0,b.y1-b.y0),lineGap=b.y0-a.y1;
            const sentencePair=/[.!?。！？…]$/u.test(previous.text.trim())&&/[.!?。！？…]$/u.test(next.text.trim());
            const shortContinuation=sameBubble&&!/[.!?。！？…]$/u.test(previous.text.trim())&&lineGap<=lineHeight*1.2;
            const gapQualifies=sameBubble?lineGap>lineHeight*1.5||shortContinuation:sentencePair&&lineGap>lineHeight*.8||alphaLongContinuation&&page.largeAlphaHoles===true&&alphaLongPotential(a,b);
            if(!allowFlatOwner||!gapQualifies)return false;
            const anchorY=Math.floor(a.y0)-2,targetY=Math.floor(b.y0)-2,profileWidth=profileBox.x1-profileBox.x0;
            if(anchorY<0||targetY<0||anchorY>=height||targetY>=height)return false;
            if(!reserve(profileWidth*2))return 'budget';
            const expected=(profile.background[0]|profile.background[1]<<8|profile.background[2]<<16|profile.background[3]<<24)>>>0;
            let bestStart=-1,bestEnd=-1,runStart=-1;
            for(let offset=0;offset<=profileWidth;offset++){
                const x=profileBox.x0+offset,matched=offset<profileWidth&&gapProfile[offset]===expected
                    &&packed(pixels,(anchorY*width+x)*4)===expected&&packed(pixels,(targetY*width+x)*4)===expected;
                if(matched&&runStart<0)runStart=x;
                if(!matched&&runStart>=0){const runEnd=x;if(runEnd-runStart>bestEnd-bestStart){bestStart=runStart;bestEnd=runEnd;}runStart=-1;}
            }
            if(bestEnd-bestStart<8)return false;
            const flatOwner={x:Math.floor((bestStart+bestEnd)/2),anchorY,targetY,runStart:bestStart,runEnd:bestEnd};
            const matteBackground:[number,number,number,number]=[profile.background[0],profile.background[1],profile.background[2],255];
            const topologyBackground=(profile.background[0]|profile.background[1]<<8|profile.background[2]<<16|profile.background[3]<<24)>>>0;
            const clearance=gapTextClearance(a,b);
            const previousGeometry:ImageMatteGeometry={...oa,background:matteBackground,supportBox:{...a,y1:a.y1+clearance}};
            const nextGeometry:ImageMatteGeometry={...ob,background:matteBackground,supportBox:{...b,y0:b.y0-clearance}};
            const windows=[profileBox];
            candidates.push({mode:'flat-owner',ordinal,previous,next,previousSnapshot,nextSnapshot,previousGeometry,nextGeometry,endpointArea,windows,
                ...(alphaLongContinuation?{alphaLongContinuation:true as const}:{}),
                precheckedGap:profileBox,flatOwner,topologyBackground});
            return true;
        }
        const previousGeometry:ImageMatteGeometry={...oa,background:profile.background,supportBox:{...a}};
        const nextGeometry:ImageMatteGeometry={...ob,background:profile.background,supportBox:{...b}};
        proofs.push({version:VERSION,mode:profile.mode,width,height,ordinal,pixels:endpointArea+area(profileBox)
            +(profile.mode==='tight-field'?inkObservationArea(a)+inkObservationArea(b):0),previous,next,previousSnapshot,nextSnapshot,previousGeometry,nextGeometry});
        return true;
    };
    enumerate:for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++){
        checkActive();const previous=lines[i],next=lines[j],a=boxOf(previous),b=boxOf(next);
        if(b.y0>a.y1+(a.y1-a.y0)*(page.largeAlphaHoles===true?3.4:2.5))break;
        if(++comparisons>MAX_COMPARISONS||attempts>=MAX_PAIRS)break enumerate;
        const alphaLongContinuation=page.largeAlphaHoles===true&&alphaLongPotential(a,b);
        if((!potential(a,b)&&!alphaLongContinuation)||owner(previous,page)!==owner(next,page))continue;
        const ordinal=++attempts,previousSnapshot=snapshot(previous),nextSnapshot=snapshot(next),oa=imageMatteObservationBox(width,height,a),ob=imageMatteObservationBox(width,height,b);
        if(!oa||!ob)continue;
        const endpointArea=oa.width*oa.height+ob.width*ob.height;
        if(endpointArea>MAX_PIXELS-charged)break enumerate;charged+=endpointArea;
        for(const item of [previous,next])if(!cache.has(item))cache.set(item,observeImageMatteGeometry(pixels,width,height,boxOf(item)));
        const ga=cache.get(previous),gb=cache.get(next);
        if(ga&&gb&&!alphaLongContinuation&&!observedInkGapFits(ga,gb))continue;
        const windows=ga&&gb?layout(a,b,ga,gb,physical,width,height):undefined;
        if(ga&&gb&&windows&&!alphaLongContinuation){candidates.push({ordinal,previous,next,previousSnapshot,nextSnapshot,previousGeometry:ga,nextGeometry:gb,endpointArea,windows});continue;}
        if(proveSmoothGap(previous,next,previousSnapshot,nextSnapshot,ordinal,endpointArea,oa,ob,true,alphaLongContinuation)==='budget')break enumerate;
    }
    const backgrounds=[...new Set(candidates.map(c=>c.topologyBackground??(c.previousGeometry.background[0]|c.previousGeometry.background[1]<<8|c.previousGeometry.background[2]<<16|255<<24)>>>0))];
    const topology=topologyPage(pixels,width,height,backgrounds,reserve,checkActive);
    for(const candidate of candidates){
        const {previous,next,previousSnapshot,nextSnapshot,previousGeometry:ga,nextGeometry:gb,endpointArea,windows,ordinal}=candidate,a=boxOf(previous),b=boxOf(next);
        const own=new Set([previous,next]),envelope={x0:Math.min(a.x0,b.x0),x1:Math.max(a.x1,b.x1),y0:a.y0,y1:b.y1};
        if(physical.some(item=>!own.has(item)&&!intersects(boxOf(item),a)&&!intersects(boxOf(item),b)&&intersects(boxOf(item),envelope)))continue;
        const extra=windows.reduce((sum,box)=>sum+area(box),0),prechecked=candidate.precheckedGap?area(candidate.precheckedGap):0;
        if(prechecked>extra||!reserve(extra-prechecked))break;
        const background=candidate.topologyBackground??(ga.background[0]|ga.background[1]<<8|ga.background[2]<<16|ga.background[3]<<24)>>>0;
        const external=candidate.precheckedGap?undefined:topology(background,ga.supportBox,gb.supportBox);
        let clear=true;
        if(candidate.precheckedGap){
            const anchor=candidate.flatOwner!;
            clear=packed(pixels,(anchor.anchorY*width+anchor.x)*4)===(background>>>0)
                &&packed(pixels,(anchor.targetY*width+anchor.x)*4)===(background>>>0);
        }else{
            try{
                for(const [index,box] of windows.entries()){
                    const ok=clearWindow(pixels,width,box,background,index>0,checkActive,external!.outside);
                    if(!ok){clear=false;break;}
                }
            }
            catch(error){if(error instanceof ImageParagraphResourceError)continue;throw error;}
        }
        if(!clear){
            if(candidate.precheckedGap)continue;
            const status=proveSmoothGap(previous,next,previousSnapshot,nextSnapshot,ordinal,endpointArea,ga,gb);
            if(status==='budget')break;
            continue;
        }
        const receipt=external?.receipt(),topologyCost=receipt?.tiles.reduce((sum,g)=>sum+g.width*g.height,0)??0;
        if(!sameItem(previous,previousSnapshot)||!sameItem(next,nextSnapshot))continue;
        proofs.push({version:VERSION,...(candidate.mode?{mode:candidate.mode}:{}),...(candidate.flatOwner?{flatOwner:candidate.flatOwner}:{}),width,height,ordinal,
            pixels:endpointArea+extra+topologyCost+(candidate.flatOwner?2*(candidate.precheckedGap!.x1-candidate.precheckedGap!.x0):0),
            previous,next,previousSnapshot,nextSnapshot,previousGeometry:ga,nextGeometry:gb,...(candidate.alphaLongContinuation?{alphaLongContinuation:true as const}:{}),...(receipt?{topology:receipt}:{})});
    }
    return proofs;
}
const regionSnapshot=(line:ImageTextRegion):RegionSnapshot=>({text:line.text,bbox:{...line.bbox},fontSize:line.fontSize,vertical:line.vertical,sourceBoxes:line.sourceBoxes?.map(b=>({...b})),guardOnly:line.guardOnly,numericUncertain:line.numericUncertain});
function sameRegion(line:ImageTextRegion,s:RegionSnapshot):boolean {return line.text===s.text&&sameBox(line.bbox,s.bbox)&&line.fontSize===s.fontSize&&line.vertical===s.vertical&&line.guardOnly===s.guardOnly&&line.numericUncertain===s.numericUncertain&&line.sourceBoxes?.length===s.sourceBoxes?.length&&(!line.sourceBoxes||line.sourceBoxes.every((box,index)=>sameBox(box,s.sourceBoxes![index])));}

/** raw graph身份在收集后不能靠bbox猜回；record仅接受实际被采用的单行，seal绑定最终含guard数组。 */
export function createImageParagraphGapConsumer(page:ImageParagraphPage,width:number,height:number,sourceLanguage='') {
    const all=itemsOf(page),raw=new Set(all),accepted=new Map<MangaOcrItem,ImageTextRegion|null>();
    const matchesText=(line:ImageTextRegion,item:MangaOcrItem)=>{
        const original=normalizeMangaSourceText(item.text.trim(),sourceLanguage);
        if(line.text===original)return true;
        const proof=getMangaViewWordBoundaryProvenance(line);
        return proof?.length===1&&getMangaViewWordBoundaryGeometrySource(line)===item
            &&sameItem(item,proof[0].local)&&proof[0].textView==='whole'
            &&line.text===normalizeMangaSourceText(proof[0].whole.text.trim(),sourceLanguage)
            &&line.text.replaceAll(' ','')===original.replaceAll(' ','');
    };
    return {
        record(item:MangaOcrItem,region:ImageTextRegion):void {
            const source=raw.has(item)?item:getMangaViewWordBoundaryGeometrySource(region);
            if(source&&raw.has(source))accepted.set(source,accepted.has(source)?null:region);
        },
        seal(regions:ImageTextRegion[]):void {
            pending.delete(regions);bindings.delete(regions);if(!all||!pageSize(width,height)||regions.length>MAX_ITEMS||!page.imageParagraphGapProofs?.length||page.imageParagraphGapProofs.length>MAX_PAIRS)return;
            const snapshots=new Map(regions.map(line=>[line,regionSnapshot(line)])),successors=new Map<ImageTextRegion,ImageTextRegion>(),ordinals=new Set<number>();let charged=0,comparisons=0;
            const physical=all.filter(item=>!!item?.box&&validBox(boxOf(item),width,height));
            for(const proof of page.imageParagraphGapProofs){
                const {previous,next}=proof;
                if(proof.version!==VERSION||(proof.mode!==undefined&&proof.mode!=='column-profile'&&proof.mode!=='smooth-field'&&proof.mode!=='flat-owner'&&proof.mode!=='tight-field')||proof.width!==width||proof.height!==height||!Number.isSafeInteger(proof.ordinal)||proof.ordinal<1||proof.ordinal>MAX_PAIRS||ordinals.has(proof.ordinal)
                    ||!raw.has(previous)||!raw.has(next)||!sameItem(previous,proof.previousSnapshot)||!sameItem(next,proof.nextSnapshot)||!eligible(previous,width,height)||!eligible(next,width,height))continue;
                ordinals.add(proof.ordinal);const a=boxOf(previous),b=boxOf(next),ga=proof.previousGeometry,gb=proof.nextGeometry;
                const profileMode=proof.mode==='column-profile'||proof.mode==='smooth-field'||proof.mode==='tight-field',flatOwnerMode=proof.mode==='flat-owner';
                if(proof.mode==='tight-field'&&!tightContinuation(previous,next))continue;
                const alphaLongContinuation=proof.alphaLongContinuation===true;
                if(proof.alphaLongContinuation!==undefined&&!alphaLongContinuation||alphaLongContinuation&&(page.largeAlphaHoles!==true||!alphaLongPotential(a,b))
                    ||(!potential(a,b)&&!alphaLongContinuation)||owner(previous,page)!==owner(next,page)||!validGeometry(ga,a,width,height,profileMode||flatOwnerMode)||!validGeometry(gb,b,width,height,profileMode||flatOwnerMode))continue;
                if(!profileMode&&!flatOwnerMode&&!observedInkGapFits(ga,gb))continue;
                const profileWindow=flatOwnerMode||profileMode?pageGapEvidenceWindow(a,b,width,height):undefined;
                const windows=profileMode||flatOwnerMode?(profileWindow?[profileWindow]:undefined):layout(a,b,ga,gb,physical,width,height);if(!windows)continue;
                if(flatOwnerMode){
                    const flat=proof.flatOwner,anchorY=Math.floor(a.y0)-2,targetY=Math.floor(b.y0)-2;
                    if(!flat||flat.anchorY!==anchorY||flat.targetY!==targetY||flat.runStart<profileWindow!.x0||flat.runEnd>profileWindow!.x1
                        ||flat.runEnd-flat.runStart<8||flat.x!==Math.floor((flat.runStart+flat.runEnd)/2))continue;
                }else if(proof.flatOwner!==undefined)continue;
                const topologyCost=profileMode||flatOwnerMode?(proof.topology===undefined?0:undefined):receiptPixels(proof.topology,width,height,a,b);if(topologyCost===undefined)continue;
                const flatProbePixels=flatOwnerMode&&profileWindow?2*(profileWindow.x1-profileWindow.x0):0;
                const count=ga.width*ga.height+gb.width*gb.height+windows.reduce((sum,box)=>sum+area(box),0)+topologyCost+flatProbePixels
                    +(proof.mode==='tight-field'?inkObservationArea(a)+inkObservationArea(b):0);
                if(proof.pixels!==count||count>MAX_PIXELS-charged)continue;charged+=count;
                const first=accepted.get(previous),second=accepted.get(next);
                if(!first||!second||first===second||!snapshots.has(first)||!snapshots.has(second)||first.vertical||second.vertical||!singleSourceRegion(first)||!singleSourceRegion(second)
                    ||!matchesText(first,previous)||!matchesText(second,next)||!sameBox(first.bbox,a)||!sameBox(second.bbox,b)||first.fontSize!==previous.box.height||second.fontSize!==next.box.height)continue;
                let ambiguous=false;
                for(const line of regions){
                    if(++comparisons>MAX_COMPARISONS)return;
                    if(line===first||line===second||line.vertical||!singleSourceRegion(line)||line.guardOnly||numericProtection(line.text))continue;
                    // 只比较这对实际相邻行之间的竞争者；同段更早/更晚的行不能否定中间的续行。
                    if(potential(a,line.bbox,false)&&line.bbox.y0<=b.y0
                        ||potential(line.bbox,b,false)&&line.bbox.y1>=a.y1){ambiguous=true;break;}
                }
                if(ambiguous)continue;
                successors.set(first,second);
            }
            if(!successors.size)return;
            const sealed=regions.slice(),sameArray=()=>regions.length===sealed.length&&regions.every((line,index)=>line===sealed[index]);
            const valid=(line:ImageTextRegion)=>snapshots.has(line)&&sameRegion(line,snapshots.get(line)!);
            const support:ImageParagraphContinuations={
                successor(previous){const next=successors.get(previous);return sameArray()&&next&&valid(previous)&&valid(next)?next:undefined;},
                permits(previous,next,members,bounds){
                    if(!sameArray()||successors.get(previous)!==next||members.at(-1)!==previous||members.includes(next)||new Set(members).size!==members.length||!valid(next)||members.some(line=>!valid(line)))return false;
                    const expected={x0:next.bbox.x0,y0:next.bbox.y0,x1:next.bbox.x1,y1:next.bbox.y1};
                    for(const line of members){expected.x0=Math.min(expected.x0,line.bbox.x0);expected.y0=Math.min(expected.y0,line.bbox.y0);expected.x1=Math.max(expected.x1,line.bbox.x1);expected.y1=Math.max(expected.y1,line.bbox.y1);}
                    if(!sameBox(bounds,expected))return false;
                    const included=new Set([...members,next]);
                    return sealed.every(line=>valid(line)&&(included.has(line)||!intersects(line.bbox,bounds)));
                },
            };
            pending.set(regions,{width,height,support});
        },
    };
}
/** 原图字符串与最终数组同时绑定；无效绑定先撤销旧权限。 */
export function bindImageParagraphGapEvidence(regions:ImageTextRegion[],image:string,width:number,height:number):void {
    bindings.delete(regions);const value=pending.get(regions);
    if(!value||typeof image!=='string'||!image||value.width!==width||value.height!==height)return;
    bindings.set(regions,{image,width,height,support:value.support});
}
/** 数组clone、原图/尺寸变化或未采用原行均没有大行距权限。 */
export function getImageParagraphGapEvidence(regions:object,image:string,width:number,height:number):ImageParagraphContinuations|undefined {
    const value=bindings.get(regions);return value&&value.image===image&&value.width===width&&value.height===height?value.support:undefined;
}
/** 漫画在收集阶段同步消费旁证后立即解除绑定，避免跨页缓存保留证明图。 */
export function consumeImageParagraphGapEvidence(regions:object,image:string,width:number,height:number):ImageParagraphContinuations|undefined {
    const support=getImageParagraphGapEvidence(regions,image,width,height);
    if(!support)return;
    bindings.delete(regions);pending.delete(regions);
    return support;
}

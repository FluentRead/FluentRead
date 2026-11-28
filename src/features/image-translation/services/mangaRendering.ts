/**
 * @file src/features/image-translation/services/mangaRendering.ts
 * 文件职责：在整段漫画区域中绘制适合阅读的译文，避免整行逐框放大和复杂背景扩散条纹。
 * 背景颜色：均匀性判定直接对照采样桶实际 RGB 均值及不透明门禁，消除 16 级量化漂移导致的误判；实际填色使用采样均值，减少可见色块。
 * 原图样式：修补前验证完整绘字区域的背景与共同墨色，可靠且对比充分时沿用源字色；复杂背景在修补后若缺少已证源字色，按框内有界采样网格跳过透明保护像素计算局部相对亮度，暗底采用白字黑描边、浅/中底采用黑字白描边，并用更清晰的 0.22× 外描边与 miterLimit=2 保证可读性，同时将外描边余量从多行行距解耦以维持干净行间节奏。
 * 原字尺度：调用方提供原文字与原生度量端口时，复用同次样式观察的逐行墨迹核对字号；可靠尺度仅替换绘字上限，大字号均匀喊叫气泡放宽至 0.062× 页宽与 700 字重以保留漫画视觉层次，源 fontSize 继续决定原清字余量，不修改源框或白底旁置规则。
 * 边线对齐：可确认原字色的相邻渐变单行，只有唯一明确共同边线时提供左右对齐提示；单行译文用实际字形左右界及描边余量核验后放入原框，缺指标、换行或透明避让仍保持居中，不改变字号或清字范围。
 * 双向文字：按整段译文首个强方向字符统一度量和绘制，数字、括号及换行后的弱方向内容继承该段方向；缓存键包含方向，避免混合语言段落串用指标，结束后恢复原画布状态。
 * 横向墨迹：排版同时核对文字行进宽度及含描边的左右笔画边界。笔画偏离文字中心时在原框内移动整行，避免裁掉附标或伸展笔画。
 * 主要内容：保留整段内容和裁剪边界，对白保留横向内边距，传入画布目标语言并在居中多行均匀气泡启用可选椭圆塑形；按真实 Canvas 整行字形上下界、描边与有界像素余量适配并居中，缺少完整指标时保守沿用行框；多行标准及倾斜绘字均采用先全描边、再全填充的两遍绘制，避免后行外描边覆盖前行下伸笔画；旋转短标签采用一致的 600 字重、最小字号门禁保护并保持物理裁剪，低于可读下限时回退通用绘制；边缘采样全部不透明时才允许均匀背景按原始行及描边蒙版清字；清字和绘字共同扣除原图冻结的低 alpha 并集；受影响的短段优先在原字号整行中绕孔分配完整词，并以实际绘字像素审计，失败时仅增加一次水平余量；成功复用同一位图，预算或不支持路径沿用无孔连续矩形完整重排；多候选共享分词，按原序预检最大字号后用二分上界跳过必输搜索，保留原候选顺序的平局及页内准入；页内度量以固定字体族下的字重、字号与全文短键复用，仍保持有界缓存；复用原图背景分类，避免修补后被误判成均匀底色而二次铺板。
 * 模块边界：只操作调用方提供的画布和像素，不运行 OCR/翻译、不修改宿主页面；白底旁置规划只消费调用方已证明的候选，保持完整译文和源字号下限，不提供像素或清字授权；完整原图仍可通过现有按钮对照。
 * 倾斜横排：仅在原字号证据不足时独立观察方向并核对原文尺度；同源原框及物理框绑定不变、未受透明孔洞影响时，按真实字形旋转后完整适配。原清字范围、透明裁剪与颜色证明保持独立。
 */
import type {MangaRegion} from './mangaRegions';
import {getImageTextColor, getImageTextBackgroundColor,getImageTextDirection,getImageSourceInkFontSize,getImageSourceTypographyStyle,
    drawTranslatedImageText,getImageSourceTextStyle,getImageRgbLuminance} from './rendering';
import {observeImageSourceTypographyGeometry,type ImageSourceTypographyGeometry} from './sourceTypographyGeometry';
import {createImageTypographyPlane} from './sourceTypographyPlane';
import {createMangaTranslationSearch, layoutMangaTranslationText, MANGA_TEXT_FONT, type MangaTypographyOptions} from './mangaTypography';
import {mangaMaskBoxes} from '../mangaPatchResult';
import {isMangaAlphaProtected,mangaAlphaClearRects,type MangaAlphaProtection} from './mangaAlphaProtection';
import {planMangaTextFlow} from './mangaTextFlow';
import {createMangaGlyphRasterLedger,rasterizeMangaGlyphs} from './mangaGlyphRaster';
import {observeImageSourceAppearances} from './sourceAppearance';
import {inferImageSourceAlignments} from './sourceAlignment';

export interface MangaBackground {color: string; uniform: boolean; foreground?:string; textBackground?:string; foregroundOutline?:string; textAlign?:'left'|'right';sourceFontSize?:number;sourceTypography?:ImageSourceTypographyGeometry}
type Box=MangaRegion['bbox'];
interface MangaTextMetrics {
    width:number;
    ascent:number;
    descent:number;
    actualBoundingBoxLeft:number;
    actualBoundingBoxRight:number;
}
type MangaMeasure=(text:string,size:number)=>MangaTextMetrics;

function readMangaTextMetrics(context:CanvasRenderingContext2D,text:string):MangaTextMetrics {
    const metrics=context.measureText(text);
    return {width:metrics.width,ascent:metrics.actualBoundingBoxAscent,descent:metrics.actualBoundingBoxDescent,
        actualBoundingBoxLeft:metrics.actualBoundingBoxLeft,actualBoundingBoxRight:metrics.actualBoundingBoxRight};
}

export interface MangaBlankLayoutBudget {readonly remainingMeasurements:number;readonly remainingCharacters:number}
type BlankLayoutRemaining={remainingMeasurements:number;remainingCharacters:number};
const blankLayoutBudgets=new WeakMap<MangaBlankLayoutBudget,BlankLayoutRemaining>();
const BLANK_LAYOUT_EXHAUSTED=Symbol('blank layout budget exhausted');

/** 同一页的所有补绘共享余额；冻结视图不能抬高、重置或转授内部计费余额。 */
export function createMangaBlankLayoutBudget():MangaBlankLayoutBudget {
    const remaining={remainingMeasurements:1024,remainingCharacters:65_536};
    const budget=Object.freeze({get remainingMeasurements(){return remaining.remainingMeasurements;},get remainingCharacters(){return remaining.remainingCharacters;}});
    blankLayoutBudgets.set(budget,remaining);return budget;
}

function mangaTranslationSpace(bounds:Box,maxSize:number,display:boolean) {
    const w=bounds.x1-bounds.x0,h=bounds.y1-bounds.y0;
    const inset=Math.min(display ? Math.max(3,maxSize*.12) : Math.min(4,maxSize*.1),w/4,h/4);
    return {w,h,inset};
}

function mangaHorizontalInkWidth(metrics:MangaTextMetrics):number|undefined {
    const width=metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight;
    return Number.isFinite(width)&&width>0?width:undefined;
}

function mangaTranslationMeasurements(lineWidth:(size:number)=>number,measure:MangaMeasure) {
    const padding=(size:number)=>lineWidth(size)/2+.5;
    return {
        width(text:string,size:number) {
            const metrics=measure(text,size),inkWidth=mangaHorizontalInkWidth(metrics);
            return inkWidth===undefined?metrics.width:Math.max(metrics.width,inkWidth+padding(size)*2);
        },
        ink(text:string,size:number) {
            const {ascent,descent}=measure(text,size);
            if(![ascent,descent].every(Number.isFinite)||ascent+descent<=0)return undefined;
            return {ascent,descent,bleed:padding(size)};
        },
        padding,
    };
}

/** 清字后的原区域和已证明白底的旁置区域共用同一个完整文字 fit。 */
function fitMangaTranslation(text:string,bounds:Box,maxSize:number,display:boolean,measure:ReturnType<typeof mangaTranslationMeasurements>,options?:MangaTypographyOptions) {
    const {w,h,inset}=mangaTranslationSpace(bounds,maxSize,display);
    const layout=layoutMangaTranslationText(text,w-inset*2,h,measure.width,maxSize,measure.ink,undefined,options);
    const fits=(layout.ink?.height??layout.lines.length*layout.lineHeight)<=h&&layout.lines.every(line=>measure.width(line,layout.fontSize)<=w-inset*2);
    return {bounds,layout,fits};
}

/** 修补后的复杂背景缺少已证源字色时，在绘字框内做有界网格亮度采样，跳过透明保护像素。 */
function samplePostInpaintLuminance(pixels:Uint8ClampedArray,width:number,height:number,bounds:Box,protection?:MangaAlphaProtection):number|undefined {
    const w=bounds.x1-bounds.x0,h=bounds.y1-bounds.y0;
    const cols=8,rows=4;
    let sum=0,count=0;
    for(let row=0;row<rows;row++){
        const y=Math.max(0,Math.min(height-1,Math.floor(bounds.y0+(row+.5)*h/rows)));
        for(let col=0;col<cols;col++){
            const x=Math.max(0,Math.min(width-1,Math.floor(bounds.x0+(col+.5)*w/cols)));
            if(protection&&isMangaAlphaProtected(protection,x,y))continue;
            const offset=(y*width+x)*4;
            if(pixels[offset+3]<128)continue;
            sum+=getImageRgbLuminance([pixels[offset],pixels[offset+1],pixels[offset+2]]);
            count++;
        }
    }
    return count?sum/count:undefined;
}

/** 只选择调用方已证明的白底候选；不证明像素、不清字、不降低源字号或截断译文。 */
export function planMangaBlankTranslation(context:CanvasRenderingContext2D,region:MangaRegion,width:number,height:number,spaces:readonly Box[],budget:MangaBlankLayoutBudget=createMangaBlankLayoutBudget()):MangaRegion|undefined {
    if(![width,height].every(value=>Number.isSafeInteger(value)&&value>0&&value<=8192)||width*height>16_777_216
        ||!region||region.vertical||typeof region.text!=='string'||!region.text.trim()||region.text.length>4096
        ||!Number.isFinite(region.fontSize)||region.fontSize<=0||!Array.isArray(spaces)||!spaces.length)return;
    const valid=(box:Box|undefined):box is Box=>!!box&&[box.x0,box.y0,box.x1,box.y1].every(Number.isFinite)
        &&box.x0>=0&&box.y0>=0&&box.x1<=width&&box.y1<=height&&box.x1>box.x0&&box.y1>box.y0;
    if(!valid(region.bbox))return;
    const maxSize=Math.min(region.fontSize*1.05,width*.034);
    if(maxSize<region.fontSize)return;
    const remaining=blankLayoutBudgets.get(budget);
    if(!remaining||remaining.remainingMeasurements===0||remaining.remainingCharacters===0)return;
    context.save();
    let failed=false,firstError:unknown;
    try {
        context.textBaseline='alphabetic';context.textAlign='left';context.direction=getImageTextDirection(region.text);
        let measuredSize=NaN,validMetrics=true;
        const measure:MangaMeasure=(text,size)=>{
            // 每次逻辑度量都扣费；不能用缓存命中规避文字遍历成本，也不因候选失败或原生异常退款。
            if(remaining.remainingMeasurements===0||remaining.remainingCharacters<text.length){
                remaining.remainingMeasurements=remaining.remainingCharacters=0;throw BLANK_LAYOUT_EXHAUSTED;
            }
            remaining.remainingMeasurements--;remaining.remainingCharacters-=text.length;
            if(measuredSize!==size){context.font=`600 ${size}px ${MANGA_TEXT_FONT}`;measuredSize=size;}
            const value=readMangaTextMetrics(context,text);
            if(![value.width,value.ascent,value.descent,value.ascent+value.descent].every(Number.isFinite)
                ||value.width<0||(text.length>0&&value.ascent+value.descent<=0))validMetrics=false;
            return value;
        };
        const measurements=mangaTranslationMeasurements(size=>Math.max(.5,size*.035),measure);
        const language=context.canvas?.lang;
        // 只做源字号的最大布局准入，失败就跳过；不会为不可读的小空白二分搜索到源字号以下。
        const sourceFloor=createMangaTranslationSearch(region.text,measurements.width,region.fontSize,measurements.ink,{language});
        let best:ReturnType<typeof fitMangaTranslation>|undefined;
        for(let index=0;index<Math.min(32,spaces.length);index++){
            const box=spaces[index];if(!valid(box))continue;
            const {w,h,inset}=mangaTranslationSpace(box,maxSize,false),floor=sourceFloor.prepare(w-inset*2,h);
            if(!validMetrics)return;
            if(!floor.maximum)continue;
            const next=fitMangaTranslation(region.text,box,maxSize,false,measurements,{language});
            if(!validMetrics)return;
            if(next.fits&&next.layout.ink&&next.layout.fontSize>=region.fontSize&&(!best||next.layout.fontSize>best.layout.fontSize))best=next;
            if(best?.layout.fontSize===maxSize)break;
        }
        // fontSize保留源基准，后续真实draw才会复现本次相同的maxSize和fit，而非再次放大已选字号。
        return best?{...region,bbox:{...best.bounds},sourceBoxes:[]}:undefined;
    } catch(error) {if(error!==BLANK_LAYOUT_EXHAUSTED){failed=true;firstError=error;}}
    finally {
        if(failed){try{context.restore();}catch{/* 原始原生度量/状态错误优先于恢复错误。 */}}
        else context.restore();
    }
    if(failed)throw firstError;
}

export function mangaRegionBackground(pixels: Uint8ClampedArray, width: number, height: number, box: MangaRegion['bbox']) {
    const sampled = getImageTextBackgroundColor(pixels, width, height, box);
    // 直接对照主桶样本的真实 RGB 均值，消除 16 级量化漂移导致米白/压缩气泡被误判复杂。
    const channels = sampled.match(/\d+/g)!.map(Number);
    let matching = 0, samples = 0, opaque = true;
    const sample = (x: number, y: number) => {
        const offset = (y * width + x) * 4; samples += 1;
        const alpha = pixels[offset + 3];
        // RGB 的少量噪声容差不能用于透明度，否则 fillRect 会把半透明原图铺成不透明色块。
        if (alpha !== 255) opaque = false;
        if (alpha === 255 && channels.every((value, index) => Math.abs(pixels[offset + index] - value) <= 20)) matching += 1;
    };
    for (let x = Math.floor(box.x0); x < box.x1; x += Math.max(1, Math.floor((box.x1 - box.x0) / 32))) {
        sample(x, Math.max(0, Math.floor(box.y0) - 1)); sample(x, Math.min(height - 1, Math.ceil(box.y1)));
    }
    for (let y = Math.floor(box.y0); y < box.y1; y += Math.max(1, Math.floor((box.y1 - box.y0) / 32))) {
        sample(Math.max(0, Math.floor(box.x0) - 1), y); sample(Math.min(width - 1, Math.ceil(box.x1)), y);
    }
    return {color: sampled, uniform: opaque && matching / samples >= 0.9};
}

/** 背景判断取自原图；修补模型生成的平滑像素不应改变该区域的绘制策略。 */
export function sampleMangaBackgrounds(pixels: Uint8ClampedArray, width: number, height: number, regions: MangaRegion[],context?:CanvasRenderingContext2D): MangaBackground[] {
    const appearances=observeImageSourceAppearances(pixels,width,height,regions);
    const eligible=new Set([...appearances].filter(([,appearance])=>appearance.outline).map(([region])=>region));
    const alignments=inferImageSourceAlignments(regions,eligible,width,height);
    const backgrounds:MangaBackground[]=regions.map(region => {
        const background={...mangaRegionBackground(pixels,width,height,region.bbox),...(alignments.has(region)?{textAlign:alignments.get(region)}:{})},appearance=appearances.get(region);
        const sourceFontSize=context&&appearance?getImageSourceInkFontSize(context,region,appearance.inkBoxes):undefined;
        return appearance?{...background,...(appearance.foreground?{foreground:appearance.foreground}:{}),...(appearance.background?{textBackground:`rgb(${appearance.background.slice(0,3).join(',')})`}:{}),...(appearance.outline?{foregroundOutline:appearance.outline}:{}),...(sourceFontSize!==undefined?{sourceFontSize}:{})}:background;
    });
    if(!context)return backgrounds;
    const orientations=observeImageSourceTypographyGeometry(pixels,width,height,regions.filter((_,index)=>backgrounds[index].sourceFontSize===undefined));
    return backgrounds.map((background,index)=>{
        const style=getImageSourceTypographyStyle(context,regions[index],orientations.get(regions[index]));
        return style?{...background,sourceFontSize:style.fontSize,sourceTypography:style.orientation}:background;
    });
}

/** 短对白有统一上限，喊叫气泡与标题根据源字号保持层次；所有文字依然限制在原识别范围内。 */
export function drawMangaTranslations(context: CanvasRenderingContext2D, pixels: Uint8ClampedArray,
    width: number, height: number, regions: Array<MangaRegion & {sourceText?: string}>, repaired = false, backgrounds?: MangaBackground[],protection?:MangaAlphaProtection) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0) || pixels.length < width * height * 4) return;
    // 本次绘制的字体族固定；短键保留段落方向、字重、实际字号和全文，不跨页面或设备复用。
    const measurements = new Map<string,MangaTextMetrics>();
    let cachedCharacters = 0;
    const alphaLayoutBudget={remaining:1_048_576};let additionalLayouts=0,flowRegions=0;
    let glyphLedger:ReturnType<typeof createMangaGlyphRasterLedger>|undefined;
    const language = context.canvas?.lang;
    if(protection)context.save();
    try {
    // 共享全页裁剪只构造一次；区域恢复继续沿用已有 save/restore，避免路径按区域数放大。
    if(protection){
        context.beginPath();context.rect(0,0,width,height);
        for(const hole of protection.rectangles)context.rect(hole.x0,hole.y0,hole.x1-hole.x0,hole.y1-hole.y0);
        context.clip('evenodd');
    }
    for (const [index,region] of regions.entries()) {
        const box = region.bbox;
        let left = Math.max(0, box.x0), top = Math.max(0, box.y0);
        let right = Math.min(width, box.x1), bottom = Math.min(height, box.y1);
        if (right <= left || bottom <= top) continue;
        const bounds={x0:left,y0:top,x1:right,y1:bottom};
        const sampled:MangaBackground = backgrounds?.[index] ?? mangaRegionBackground(pixels, width, height, bounds);
        const background = sampled.uniform ? sampled.color : 'rgb(255,255,255)';
        const textBackground=sampled.textBackground??(sampled.uniform?background:'#ffffff');
        const flatTextBackground=sampled.textBackground!==undefined||sampled.uniform;
        let resolvedInk: string;
        let resolvedOutline: string;
        if (sampled.foreground) {
            resolvedInk = sampled.foreground;
            resolvedOutline = sampled.foregroundOutline ?? textBackground;
        } else if (flatTextBackground || !repaired) {
            resolvedInk = getImageTextColor(textBackground);
            resolvedOutline = sampled.foregroundOutline ?? textBackground;
        } else {
            const luminance = samplePostInpaintLuminance(pixels, width, height, bounds, protection);
            const darkBackground = luminance !== undefined && luminance < 0.32;
            resolvedInk = darkBackground ? '#ffffff' : '#111111';
            resolvedOutline = sampled.foregroundOutline ?? (darkBackground ? '#111111' : '#ffffff');
        }
        const fillInk = resolvedInk === '#111827' ? '#111111' : resolvedInk;
        context.save();
        try {
            if (sampled.uniform || !repaired) {
                context.fillStyle = background;
                // 已有物理行时，清字边界与修补/传输图块完全一致：清掉框外描边，不铺白整段行间画面。
                if (sampled.uniform && region.sourceBoxes?.length) {
                    for (const source of mangaMaskBoxes(region, width, height)) {
                        context.fillRect(source.x0, source.y0, source.x1 - source.x0, source.y1 - source.y0);
                    }
                } else context.fillRect(left, top, right - left, bottom - top);
            }
            if(region.quarterTurn){
                const {fontSize,orientation}=getImageSourceTextStyle(context,region);
                const labelColor=sampled.textBackground??sampled.color;
                const labelFill=sampled.foreground??getImageTextColor(labelColor);
                const labelStroke=sampled.foregroundOutline??labelColor;
                const labelLineWidth=(size:number)=>Math.max(.35,size*(sampled.foregroundOutline ? .025 : .06));
                const labelMeasure=(text:string,size:number)=>{
                    context.font=`600 ${size}px ${MANGA_TEXT_FONT}`;
                    return readMangaTextMetrics(context,text);
                };
                const labelPlane=orientation&&region.text.length<=256&&!/[\r\n]/u.test(region.text)
                    ?createImageTypographyPlane(bounds,orientation,'center',(text,size)=>{
                        const metric=labelMeasure(text,size);return {left:metric.actualBoundingBoxLeft,right:metric.actualBoundingBoxRight,ascent:metric.ascent,descent:metric.descent};
                    },size=>labelLineWidth(size)/2+.5):undefined;
                if(labelPlane){
                    context.textBaseline='alphabetic';context.textAlign='left';context.direction=getImageTextDirection(region.text);
                    const labelMeasurements=mangaTranslationMeasurements(labelLineWidth,labelMeasure);
                    const labelMinimum=Math.max(7,fontSize*.5);
                    const rotatedLayout=layoutMangaTranslationText(region.text,labelPlane.width,labelPlane.height,labelMeasurements.width,fontSize,labelMeasurements.ink,
                        {accept:layout=>layout.lines.length===1&&layout.fontSize>=labelMinimum&&!!labelPlane.plan(layout)},{language});
                    const placement=labelPlane.plan(rotatedLayout);
                    if(placement&&rotatedLayout.lines.length===1&&rotatedLayout.fontSize>=labelMinimum){
                        context.beginPath();context.rect(left,top,right-left,bottom-top);context.clip();
                        context.font=`600 ${rotatedLayout.fontSize}px ${MANGA_TEXT_FONT}`;context.textAlign='left';context.textBaseline='alphabetic';
                        context.lineJoin='round';context.miterLimit=2;
                        context.fillStyle=labelFill==='#111827'?'#111111':labelFill;
                        context.strokeStyle=labelStroke;context.lineWidth=labelLineWidth(rotatedLayout.fontSize);
                        context.transform(...placement.transform);
                        const {x,y}=placement.points[0];context.strokeText(rotatedLayout.lines[0],x,y);context.fillText(rotatedLayout.lines[0],x,y);
                        continue;
                    }
                }
                drawTranslatedImageText(context,region.text,left,top,right-left,bottom-top,labelColor,
                    fontSize,'center',undefined,sampled.foreground,sampled.foregroundOutline,undefined,orientation);
                continue;
            }
            const display = !sampled.uniform && !region.vertical && region.fontSize >= width * .045;
            const shout = sampled.uniform && !region.vertical && region.fontSize >= width * .048;
            const weight = display ? 800 : shout ? 700 : 600;
            const observedSize=sampled.sourceFontSize;
            const maxSize = observedSize!==undefined&&Number.isFinite(observedSize)&&observedSize>0&&observedSize<=(box.y1-box.y0)*2.5
                ?observedSize:Math.min(region.fontSize * 1.05,width * (display ? .10 : shout ? .062 : .034));
            // 保留横向余量；OCR 框是字形边界，竖向空间由实际字形和描边适配，不再重复扣除内边距。
            let measuredFont = '', keyFontSize = NaN, font = '', keyPrefix = '', logicalPrefixLength = 0;
            const direction=getImageTextDirection(region.text);
            context.textBaseline = 'alphabetic';context.textAlign = 'left';context.direction=direction;
            const measure = (text:string,size:number) => {
                if (keyFontSize !== size) {
                    keyFontSize = size; font = `${weight} ${size}px ${MANGA_TEXT_FONT}`;
                    keyPrefix = `${direction}|${weight}|${size}|`; logicalPrefixLength = font.length + direction.length + 2;
                }
                const key = keyPrefix + text;
                const cached = measurements.get(key);
                if (cached !== undefined) return cached;
                if (measuredFont !== font) {context.font = font; measuredFont = font;}
                const value = readMangaTextMetrics(context,text);
                // 键更短也不增加缓存准入量，仍按原完整字体键的长度计费。
                const logicalCharacters = logicalPrefixLength + text.length;
                if (measurements.size < 8192 && cachedCharacters + logicalCharacters <= 131072) {measurements.set(key,value); cachedCharacters += logicalCharacters;}
                return value;
            };
            const lineWidth = (size:number)=>Math.max(.5,size*(flatTextBackground||sampled.foregroundOutline ? .035 : .22));
            const layoutMeasurements=mangaTranslationMeasurements(lineWidth,measure);
            const available=protection?mangaAlphaClearRects(protection,bounds,alphaLayoutBudget):[bounds];
            if(!available.length)throw new Error('漫画透明图案遮挡译文区域，已保留原图');
            const affected=available.length!==1||available[0]!==bounds;
            const elliptical = sampled.uniform && !region.vertical && !sampled.textAlign && !affected && region.sourceBoxes?.length !== 0;
            const fit=(targetBounds:MangaRegion['bbox'],shape=false)=>fitMangaTranslation(region.text,targetBounds,maxSize,display,layoutMeasurements,{language,elliptical:shape});
            const orientation=sampled.sourceTypography;
            if(!affected&&orientation&&orientation.owner.bbox===box&&orientation.owner.sourceBoxes===region.sourceBoxes
                &&orientation.sourceText===orientation.owner.text&&region.text.length<=4096){
                const plane=createImageTypographyPlane(bounds,orientation,sampled.textAlign??'center',(text,size)=>{
                    const metric=measure(text,size);return {left:metric.actualBoundingBoxLeft,right:metric.actualBoundingBoxRight,ascent:metric.ascent,descent:metric.descent};
                },size=>lineWidth(size)/2+.5);
                if(plane){
                    const tilted=layoutMangaTranslationText(region.text,plane.width,plane.height,(text,size)=>{
                        const metric=measure(text,size),inkWidth=metric.actualBoundingBoxLeft+metric.actualBoundingBoxRight;
                        return Number.isFinite(inkWidth)?Math.max(metric.width,inkWidth)+lineWidth(size)+1:metric.width;
                    },maxSize,layoutMeasurements.ink,plane.constraints,{language});
                    const placement=plane.plan(tilted);
                    if(placement){
                        context.beginPath();context.rect(left,top,right-left,bottom-top);context.clip();
                        context.font=`${weight} ${tilted.fontSize}px ${MANGA_TEXT_FONT}`;context.textAlign='left';context.textBaseline='alphabetic';context.lineJoin='round';context.miterLimit=2;
                        context.fillStyle=fillInk;context.strokeStyle=resolvedOutline;context.lineWidth=lineWidth(tilted.fontSize);
                        context.transform(...placement.transform);
                        tilted.lines.forEach((text,line)=>{const {x,y}=placement.points[line];context.strokeText(text,x,y);});
                        tilted.lines.forEach((text,line)=>{const {x,y}=placement.points[line];context.fillText(text,x,y);});
                        continue;
                    }
                }
            }
            // 只有实际受孔洞影响的短段进入额外路径；普通单框不分词、不建栅格画布。
            // 全页至多64段，每段最多两个固定计划；像素、读回和相交检查另共用累计账本。
            let flowed=false;
            if(affected&&region.text.length<=4096&&++flowRegions<=64){
                const whole=fit(bounds),layout=whole.layout;
                if(whole.fits&&layout.ink&&layout.lines.length){
                    const ref={layout,fontSize:layout.fontSize,lineWidth:lineWidth(layout.fontSize),box:bounds,
                        family:MANGA_TEXT_FONT,style:String(weight)};
                    for(const safety of [0,1] as const){
                        const plan=planMangaTextFlow(region.text,ref,protection!.rectangles,text=>{
                            const metrics=measure(text,layout.fontSize);
                            return {...metrics,actualBoundingBoxAscent:metrics.ascent,actualBoundingBoxDescent:metrics.descent};
                        },safety);
                        if(!plan.accepted)break;
                        const raster=rasterizeMangaGlyphs(plan,bounds,protection!.rectangles,{
                            fillStyle:fillInk,strokeStyle:resolvedOutline,language,
                        },glyphLedger??=createMangaGlyphRasterLedger());
                        if(raster.kind==='accepted'){
                            let drawn=false;
                            try{context.drawImage(raster.canvas,raster.x,raster.y);drawn=true;}
                            finally{
                                // drawImage首因不能被随后释放异常覆盖；正常绘制时释放错误仍向上传播。
                                if(drawn)raster.dispose();else try{raster.dispose();}catch{/* 保留同一原生绘制异常。 */}
                            }
                            flowed=true;break;
                        }
                        // 真实字形越界才准许h1；资源不足直接保留连续矩形路径。
                        if(raster.kind!=='unsafe')break;
                    }
                }
            }
            if(flowed)continue;
            let best:ReturnType<typeof fit>|undefined;
            if(!affected||available.length===1||!(maxSize>.99)){
                best=fit(available[0],elliptical);if(affected&&!best.fits)best=undefined;
                for(let candidate=1;candidate<available.length;candidate++){
                    if(best?.layout.fontSize===maxSize)break;
                    if(++additionalLayouts>512)throw new Error('漫画透明图案过于复杂，已保留原图');
                    const next=fit(available[candidate]);
                    if(next.fits&&(!best||next.layout.fontSize>best.layout.fontSize))best=next;
                }
            }else{
                // 私有离屏原生 context 在本次同步绘制中不加载字体；同一字号/全文的数值度量稳定。
                const search=createMangaTranslationSearch(region.text,layoutMeasurements.width,maxSize,layoutMeasurements.ink,{language});
                // state 仅含尺寸；不保留失败最大布局、分词副本或每候选闭包。
                const jobs:Array<{candidate:number;bounds:typeof bounds;w:number;h:number;inset:number;state:ReturnType<typeof search.prepare>}>=[];
                for(let candidate=0;candidate<available.length;candidate++){
                    if(candidate&&++additionalLayouts>512)throw new Error('漫画透明图案过于复杂，已保留原图');
                    const bounds=available[candidate],{w,h,inset}=mangaTranslationSpace(bounds,maxSize,display);
                    const state=search.prepare(w-inset*2,h);
                    jobs.push({candidate,bounds,w,h,inset,state});
                    // 与旧路径同样选择首个最大字号候选，后续候选不扣准入预算。
                    if(state.maximum?.fontSize===maxSize){best={bounds,layout:state.maximum,fits:true};break;}
                }
                if(!best){
                    let bestIndex=Infinity;
                    // 面积只决定计算先后；上界和原索引负责精确的输赢与平局，不用面积拒绝候选。
                    jobs.sort((a,b)=>b.w*b.h-a.w*a.h||a.candidate-b.candidate);
                    for(const job of jobs){
                        const layout=search.finish(job.state,best?.layout.fontSize??-Infinity,job.candidate<bestIndex);
                        if(!layout)continue;
                        const fits=(layout.ink?.height??layout.lines.length*layout.lineHeight)<=job.h
                            &&layout.lines.every(line=>layoutMeasurements.width(line,layout.fontSize)<=job.w-job.inset*2);
                        if(fits&&(!best||layout.fontSize>best.layout.fontSize||(layout.fontSize===best.layout.fontSize&&job.candidate<bestIndex))){
                            best={bounds:job.bounds,layout,fits};bestIndex=job.candidate;
                        }
                    }
                }
            }
            if(!best)throw new Error('漫画透明图案遮挡译文区域，已保留原图');
            ({x0:left,y0:top,x1:right,y1:bottom}=best.bounds);
            const {w,h,inset}=mangaTranslationSpace(best.bounds,maxSize,display);
            // 无孔的原框仍可使用旧行框处理不可用或始终装不下的墨迹边界。
            const layout=best.fits?best.layout:layoutMangaTranslationText(region.text,w-inset*2,h,
                (text,size)=>measure(text,size).width,maxSize,layoutMeasurements.ink,undefined,{language});
            if (!layout.lines.length) continue;
            context.beginPath();context.rect(left,top,right-left,bottom-top);context.clip();
            const center=(left+right)/2,padding=layoutMeasurements.padding(layout.fontSize);
            const alignment=best.fits&&!affected&&layout.lines.length===1?sampled.textAlign:undefined;
            const leftAnchors=layout.lines.map(line=>{
                // 统一以左锚点度量，实际绘制时仅在需要时将整行平移进原框。
                const metrics=measure(line,layout.fontSize);
                const minimum=left+metrics.actualBoundingBoxLeft+padding,maximum=right-metrics.actualBoundingBoxRight-padding;
                if(mangaHorizontalInkWidth(metrics)===undefined||minimum>maximum)return undefined;
                if(alignment)return alignment==='left'?minimum+inset:maximum-inset;
                const start=center-metrics.width/2;
                const fitted=Math.max(minimum,Math.min(start,maximum));
                return fitted===start?undefined:fitted;
            });
            context.font = `${weight} ${layout.fontSize}px ${MANGA_TEXT_FONT}`;
            context.textBaseline = layout.ink ? 'alphabetic' : 'middle';context.lineJoin = 'round';context.miterLimit = 2;
            context.fillStyle = fillInk;
            context.strokeStyle = resolvedOutline;
            context.lineWidth = lineWidth(layout.fontSize);
            const firstLine = top + (bottom-top-layout.lines.length*layout.lineHeight)/2 + layout.lineHeight/2;
            const positioned = layout.lines.map((text,line)=>({
                text,
                x: leftAnchors[line]??center,
                y: layout.ink ? top+(bottom-top-layout.ink.height)/2+layout.ink.baselines[line] : firstLine+line*layout.lineHeight,
                align: (leftAnchors[line]===undefined?'center':'left') as CanvasTextAlign,
            }));
            for (const item of positioned) {context.textAlign=item.align;context.strokeText(item.text,item.x,item.y);}
            for (const item of positioned) {context.textAlign=item.align;context.fillText(item.text,item.x,item.y);}
        } finally { context.restore(); }
    }
    } finally {if(protection)context.restore();}
}

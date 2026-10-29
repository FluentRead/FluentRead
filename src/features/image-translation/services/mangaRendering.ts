/**
 * @file src/features/image-translation/services/mangaRendering.ts
 * 文件职责：在整段漫画区域中绘制适合阅读的译文，避免整行逐框放大和复杂背景扩散条纹。
 * 主要内容：保留整段内容和裁剪边界，对白保留横向内边距，按真实 Canvas 整行字形上下界、描边与有界像素余量适配并居中，缺少完整指标时保守沿用行框；原始大标题使用有界大字与高对比描边；边缘采样全部不透明时才允许均匀背景按原始行及描边蒙版清字；清字和绘字共同扣除原图冻结的低 alpha 并集；受影响的短段优先在原字号整行中绕孔分配完整词，并以实际绘字像素审计，失败时仅增加一次水平余量；成功复用同一位图，预算或不支持路径沿用无孔连续矩形完整重排，避免切除译文字形；多候选共享分词，按原序预检最大字号后用二分上界跳过必输搜索，保留原候选顺序的平局及页内准入；页内度量以固定字体族下的字重、字号与全文短键复用，仍保持有界缓存；复用原图背景分类，避免修补后被误判成均匀底色而二次铺板。
 * 模块边界：只操作调用方提供的画布和像素，不运行 OCR/翻译、不修改宿主页面；绘制区域局限于识别框，完整原图仍可通过现有按钮对照。
 */
import type {MangaRegion} from './mangaRegions';
import {getImageTextColor, getImageTextBackgroundColor} from './rendering';
import {createMangaTranslationSearch, layoutMangaTranslationText, MANGA_TEXT_FONT} from './mangaTypography';
import {mangaMaskBoxes} from '../mangaPatchResult';
import {mangaAlphaClearRects,type MangaAlphaProtection} from './mangaAlphaProtection';
import {planMangaTextFlow} from './mangaTextFlow';
import {createMangaGlyphRasterLedger,rasterizeMangaGlyphs} from './mangaGlyphRaster';

export interface MangaBackground {color: string; uniform: boolean}

export function mangaRegionBackground(pixels: Uint8ClampedArray, width: number, height: number, box: MangaRegion['bbox']) {
    const sampled = getImageTextBackgroundColor(pixels, width, height, box);
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
export function sampleMangaBackgrounds(pixels: Uint8ClampedArray, width: number, height: number, regions: MangaRegion[]): MangaBackground[] {
    return regions.map(region => mangaRegionBackground(pixels,width,height,region.bbox));
}

/** 短对白有统一上限，标题根据源字号保持层次；所有文字依然限制在原识别范围内。 */
export function drawMangaTranslations(context: CanvasRenderingContext2D, pixels: Uint8ClampedArray,
    width: number, height: number, regions: Array<MangaRegion & {sourceText?: string}>, repaired = false, backgrounds?: MangaBackground[],protection?:MangaAlphaProtection) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0) || pixels.length < width * height * 4) return;
    // 本次绘制的字体族固定；短键保留字重、实际字号和全文，不跨页面或设备复用。
    const measurements = new Map<string, {width:number;ascent:number;descent:number;actualBoundingBoxLeft:number;actualBoundingBoxRight:number}>();
    let cachedCharacters = 0;
    const alphaLayoutBudget={remaining:1_048_576};let additionalLayouts=0,flowRegions=0;
    let glyphLedger:ReturnType<typeof createMangaGlyphRasterLedger>|undefined;
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
        const sampled = backgrounds?.[index] ?? mangaRegionBackground(pixels, width, height, {x0:left,y0:top,x1:right,y1:bottom});
        const background = sampled.uniform ? sampled.color : 'rgb(255,255,255)';
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
            const display = !sampled.uniform && !region.vertical && region.fontSize >= width * .045;
            const weight = display ? 800 : 600;
            const maxSize = Math.min(region.fontSize * 1.05,width * (display ? .10 : .034));
            // 保留横向余量；OCR 框是字形边界，竖向空间由实际字形和描边适配，不再重复扣除内边距。
            let measuredFont = '', keyFontSize = NaN, font = '', keyPrefix = '', logicalPrefixLength = 0;
            context.textBaseline = 'alphabetic';context.textAlign = 'left';
            const measure = (text:string,size:number) => {
                if (keyFontSize !== size) {
                    keyFontSize = size; font = `${weight} ${size}px ${MANGA_TEXT_FONT}`;
                    keyPrefix = `${weight}|${size}|`; logicalPrefixLength = font.length + 1;
                }
                const key = keyPrefix + text;
                const cached = measurements.get(key);
                if (cached !== undefined) return cached;
                if (measuredFont !== font) {context.font = font; measuredFont = font;}
                const metrics = context.measureText(text);
                const value = {width:metrics.width,ascent:metrics.actualBoundingBoxAscent,descent:metrics.actualBoundingBoxDescent,
                    actualBoundingBoxLeft:metrics.actualBoundingBoxLeft,actualBoundingBoxRight:metrics.actualBoundingBoxRight};
                // 键更短也不增加缓存准入量，仍按原完整字体键的长度计费。
                const logicalCharacters = logicalPrefixLength + text.length;
                if (measurements.size < 8192 && cachedCharacters + logicalCharacters <= 131072) {measurements.set(key,value); cachedCharacters += logicalCharacters;}
                return value;
            };
            const lineWidth = (size:number)=>Math.max(.5,size*(sampled.uniform ? .035 : .14));
            const fit=(bounds:MangaRegion['bbox'])=>{
                const w=bounds.x1-bounds.x0,h=bounds.y1-bounds.y0;
                const inset=Math.min(display ? Math.max(3,maxSize*.12) : Math.min(4,maxSize*.1),w/4,h/4);
                const layout=layoutMangaTranslationText(region.text,w-inset*2,h,(text,size)=>measure(text,size).width,maxSize,(text,size)=>{
                const {ascent,descent} = measure(text,size);
                if (![ascent,descent].every(Number.isFinite) || ascent+descent<=0) return undefined;
                const padding = lineWidth(size)/2+.5;
                return {ascent:ascent+padding,descent:descent+padding};
                });
                const fits=(layout.ink?.height??layout.lines.length*layout.lineHeight)<=h&&layout.lines.every(line=>measure(line,layout.fontSize).width<=w-inset*2);
                return {bounds,layout,fits};
            };
            const bounds={x0:left,y0:top,x1:right,y1:bottom};
            const available=protection?mangaAlphaClearRects(protection,bounds,alphaLayoutBudget):[bounds];
            if(!available.length)throw new Error('漫画透明图案遮挡译文区域，已保留原图');
            const affected=available.length!==1||available[0]!==bounds;
            // 只有实际受孔洞影响的短段进入额外路径；普通单框不分词、不建栅格画布。
            // 全页至多64段，每段最多两个固定计划；像素、读回和相交检查另共用累计账本。
            let flowed=false;
            if(affected&&region.text.length<=4096&&++flowRegions<=64){
                const whole=fit(bounds),layout=whole.layout;
                if(whole.fits&&layout.ink&&layout.lines.length){
                    const ink=sampled.uniform?getImageTextColor(background):'#111111';
                    const ref={layout,fontSize:layout.fontSize,lineWidth:lineWidth(layout.fontSize),box:bounds,
                        family:MANGA_TEXT_FONT,style:String(weight)};
                    for(const safety of [0,1] as const){
                        const plan=planMangaTextFlow(region.text,ref,protection!.rectangles,text=>{
                            const metrics=measure(text,layout.fontSize);
                            return {...metrics,actualBoundingBoxAscent:metrics.ascent,actualBoundingBoxDescent:metrics.descent};
                        },safety);
                        if(!plan.accepted)break;
                        const raster=rasterizeMangaGlyphs(plan,bounds,protection!.rectangles,{
                            fillStyle:ink==='#111827'?'#111111':ink,strokeStyle:sampled.uniform?background:'#ffffff',
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
                best=fit(available[0]);if(affected&&!best.fits)best=undefined;
                for(let candidate=1;candidate<available.length;candidate++){
                    if(best?.layout.fontSize===maxSize)break;
                    if(++additionalLayouts>512)throw new Error('漫画透明图案过于复杂，已保留原图');
                    const next=fit(available[candidate]);
                    if(next.fits&&(!best||next.layout.fontSize>best.layout.fontSize))best=next;
                }
            }else{
                // 私有离屏原生 context 在本次同步绘制中不加载字体；同一字号/全文的数值度量稳定。
                const search=createMangaTranslationSearch(region.text,(text,size)=>measure(text,size).width,maxSize,(text,size)=>{
                    const {ascent,descent}=measure(text,size);
                    if(![ascent,descent].every(Number.isFinite)||ascent+descent<=0)return undefined;
                    const padding=lineWidth(size)/2+.5;return{ascent:ascent+padding,descent:descent+padding};
                });
                // state 仅含尺寸；不保留失败最大布局、分词副本或每候选闭包。
                const jobs:Array<{candidate:number;bounds:typeof bounds;w:number;h:number;inset:number;state:ReturnType<typeof search.prepare>}>=[];
                for(let candidate=0;candidate<available.length;candidate++){
                    if(candidate&&++additionalLayouts>512)throw new Error('漫画透明图案过于复杂，已保留原图');
                    const bounds=available[candidate],w=bounds.x1-bounds.x0,h=bounds.y1-bounds.y0;
                    const inset=Math.min(display ? Math.max(3,maxSize*.12) : Math.min(4,maxSize*.1),w/4,h/4);
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
                        const fits=(layout.ink?.height??layout.lines.length*layout.lineHeight)<=job.h&&layout.lines.every(line=>measure(line,layout.fontSize).width<=job.w-job.inset*2);
                        if(fits&&(!best||layout.fontSize>best.layout.fontSize||(layout.fontSize===best.layout.fontSize&&job.candidate<bestIndex))){
                            best={bounds:job.bounds,layout,fits};bestIndex=job.candidate;
                        }
                    }
                }
            }
            if(!best)throw new Error('漫画透明图案遮挡译文区域，已保留原图');
            const layout=best.layout;
            ({x0:left,y0:top,x1:right,y1:bottom}=best.bounds);
            if (!layout.lines.length) continue;
            context.beginPath();context.rect(left,top,right-left,bottom-top);context.clip();
            context.font = `${weight} ${layout.fontSize}px ${MANGA_TEXT_FONT}`;
            context.textAlign = 'center';context.textBaseline = layout.ink ? 'alphabetic' : 'middle';context.lineJoin = 'round';
            const ink = sampled.uniform ? getImageTextColor(background) : '#111111';
            context.fillStyle = ink === '#111827' ? '#111111' : ink;
            context.strokeStyle = sampled.uniform ? background : '#ffffff';
            context.lineWidth = lineWidth(layout.fontSize);
            const firstLine = top + (bottom-top-layout.lines.length*layout.lineHeight)/2 + layout.lineHeight/2;
            layout.lines.forEach((text,line)=>{
                const y = layout.ink ? top+(bottom-top-layout.ink.height)/2+layout.ink.baselines[line] : firstLine+line*layout.lineHeight;
                context.strokeText(text,(left+right)/2,y);context.fillText(text,(left+right)/2,y);
            });
        } finally { context.restore(); }
    }
    } finally {if(protection)context.restore();}
}

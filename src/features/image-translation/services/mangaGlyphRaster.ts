/**
 * @file src/features/image-translation/services/mangaGlyphRaster.ts
 * 文件职责：把单个完整漫画排版计划栅格化并审计，只有实际字形像素安全时才交付同一张画布。
 * 主要内容：保留分数坐标相位，在原框外加整数保护边；严格检查非零 alpha 像素单元、保护矩形及裁切前后四通道；首次墨迹前以完整读回域有界筛去无关的稳定数值孔，未知坐标仍走原像素谓词，页内共享累计与活动资源预算，失败释放画布和显式读回。
 * 模块边界：不运行 OCR、翻译、字体搜索或重排，不编码 PNG；调用方负责 h0/h1 策略和成功画布的最终释放，真实 Canvas 异常原样传播。
 */

export interface MangaGlyphRasterBox {x0:number;y0:number;x1:number;y1:number}
export interface MangaGlyphRasterPlan {
    font:string;
    lineWidth:number;
    chunks:ReadonlyArray<{text:string;x:number;y:number}>;
}
export interface MangaGlyphRasterStyles {
    fillStyle:CanvasRenderingContext2D['fillStyle'];
    strokeStyle:CanvasRenderingContext2D['strokeStyle'];
}
export interface MangaGlyphRasterLedger {
    canvasPixels:number;
    readbackPixels:number;
    auditPixels:number;
    holeChecks:number;
    liveCanvasPixels:number;
    liveReadbackPixels:number;
}
export const MANGA_GLYPH_RASTER_LIMITS=Object.freeze({
    guard:8,edge:8192,layerPixels:2_097_152,holes:4096,
    pageCanvasPixels:16_777_216,pageReadbackPixels:16_777_216,pageAuditPixels:16_777_216,
    liveCanvasPixels:8_388_608,liveReadbackPixels:4_194_304,holeChecks:8_388_608,
});
export type MangaGlyphRasterResult=
    |{kind:'accepted';canvas:HTMLCanvasElement;x:number;y:number;dispose:()=>void}
    |{kind:'unsafe'}
    |{kind:'budget';reason:'layer'|'holes'|'page'|'intersection'};

/** 每次完整绘页创建一次；累计准入不因释放、重试或下一个区域而退款。 */
export function createMangaGlyphRasterLedger():MangaGlyphRasterLedger {
    return {canvasPixels:0,readbackPixels:0,auditPixels:0,holeChecks:0,liveCanvasPixels:0,liveReadbackPixels:0};
}

function validBox(box:MangaGlyphRasterBox):boolean {
    return [box.x0,box.y0,box.x1,box.y1].every(Number.isFinite)&&box.x1>box.x0&&box.y1>box.y0;
}

/** 可选预筛不调用未知坐标 getter；反射不支持或非稳定数值时仍交原审计谓词决定。 */
function mayIntersectReadback(hole:MangaGlyphRasterBox,x0:number,y0:number,x1:number,y1:number):boolean {
    if(typeof hole!=='object'||hole===null)return true;
    try {
        const coordinates=['x0','y0','x1','y1'].map(key=>Object.getOwnPropertyDescriptor(hole,key));
        if(coordinates.some(value=>!value||!('value' in value)||!Number.isFinite(value.value)))return true;
        const [left,top,right,bottom]=coordinates.map(value=>value!.value as number);
        return right>x0&&left<x1&&bottom>y0&&top<y1;
    } catch {return true;}
}

/** 纯像素规则；完整读回已在分配前计费，交孔比较另外共享页内硬上限。 */
export function auditMangaGlyphRaster(raster:{pixels:Uint8ClampedArray;clipped:Uint8ClampedArray;width:number;height:number;x:number;y:number},
    box:MangaGlyphRasterBox,holes:ReadonlyArray<MangaGlyphRasterBox>,ledger:MangaGlyphRasterLedger):'safe'|'unsafe'|'budget' {
    const {pixels,clipped,width,height,x:originX,y:originY}=raster;
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<=0||height<=0
        ||pixels.length!==width*height*4||clipped.length!==pixels.length)throw new Error('漫画字形像素尺寸无效，已保留原图');
    let ink=false,relevant:ReadonlyArray<MangaGlyphRasterBox>|undefined;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const offset=(y*width+x)*4;
        for(let channel=0;channel<4;channel++)if(pixels[offset+channel]!==clipped[offset+channel])return 'unsafe';
        if(pixels[offset+3]===0)continue;
        ink=true;
        const px=x+originX,py=y+originY;
        if(px<box.x0||px+1>box.x1||py<box.y0||py+1>box.y1)return 'unsafe';
        if(relevant===undefined){
            // 包含 floor/ceil 与保护边的完整像素域；不能按名义框过滤而漏掉边缘字形。
            // 无墨迹、首个 RGBA/bbox 失败和未知原点仍保留原审计顺序。
            if([originX,originY,originX+width,originY+height].every(Number.isFinite)){
                const local:MangaGlyphRasterBox[]=[];
                for(const hole of holes){
                    if(ledger.holeChecks>=MANGA_GLYPH_RASTER_LIMITS.holeChecks)return 'budget';
                    ledger.holeChecks++;
                    if(mayIntersectReadback(hole,originX,originY,originX+width,originY+height))local.push(hole);
                }
                relevant=local;
            }else relevant=holes;
        }
        for(const hole of relevant){
            if(ledger.holeChecks>=MANGA_GLYPH_RASTER_LIMITS.holeChecks)return 'budget';
            ledger.holeChecks++;
            if(px+1>hole.x0&&px<hole.x1&&py+1>hole.y0&&py<hole.y1)return 'unsafe';
        }
    }
    return ink?'safe':'unsafe';
}

function reserve(area:number,ledger:MangaGlyphRasterLedger):boolean {
    const limits=MANGA_GLYPH_RASTER_LIMITS;
    if(ledger.canvasPixels+area*2>limits.pageCanvasPixels||ledger.readbackPixels+area*2>limits.pageReadbackPixels
        ||ledger.auditPixels+area>limits.pageAuditPixels||ledger.liveCanvasPixels+area*2>limits.liveCanvasPixels
        ||ledger.liveReadbackPixels+area*2>limits.liveReadbackPixels)return false;
    ledger.canvasPixels+=area*2;ledger.readbackPixels+=area*2;ledger.auditPixels+=area;
    return true;
}

function createLayer(width:number,height:number,ledger:MangaGlyphRasterLedger){
    const canvas=document.createElement('canvas'),area=width*height;
    let disposed=false;
    ledger.liveCanvasPixels+=area;
    const dispose=()=>{
        if(disposed)return;
        disposed=true;
        try {canvas.width=0;} finally {try {canvas.height=0;} finally {ledger.liveCanvasPixels-=area;}}
    };
    try {
        canvas.width=width;canvas.height=height;
        const context=canvas.getContext('2d',{willReadFrequently:true});
        if(!context)throw new Error('漫画字形画布不可用，已保留原图');
        return {canvas,context,dispose};
    } catch(error){try {dispose();} catch {/* 首次分配或原生 context 错误不能被随后释放错误覆盖。 */}throw error;}
}

/** 仅栅格化一个既定计划；安全时交付原 bitmap，调用方以整数 x/y drawImage 并在 finally dispose。 */
export function rasterizeMangaGlyphs(plan:MangaGlyphRasterPlan,box:MangaGlyphRasterBox,holes:ReadonlyArray<MangaGlyphRasterBox>,
    styles:MangaGlyphRasterStyles,ledger:MangaGlyphRasterLedger):MangaGlyphRasterResult {
    if(holes.length>MANGA_GLYPH_RASTER_LIMITS.holes)return {kind:'budget',reason:'holes'};
    if(!validBox(box)||!plan.font||!Number.isFinite(plan.lineWidth)||plan.lineWidth<=0
        ||plan.chunks.some(chunk=>typeof chunk.text!=='string'||!Number.isFinite(chunk.x)||!Number.isFinite(chunk.y))
        ||holes.some(hole=>!validBox(hole)))throw new Error('漫画字形栅格参数无效，已保留原图');
    const guard=MANGA_GLYPH_RASTER_LIMITS.guard,x=Math.floor(box.x0)-guard,y=Math.floor(box.y0)-guard;
    const width=Math.ceil(box.x1)+guard-x,height=Math.ceil(box.y1)+guard-y,area=width*height;
    if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||width>MANGA_GLYPH_RASTER_LIMITS.edge||height>MANGA_GLYPH_RASTER_LIMITS.edge
        ||!Number.isSafeInteger(area)||area>MANGA_GLYPH_RASTER_LIMITS.layerPixels)return {kind:'budget',reason:'layer'};
    if(!reserve(area,ledger))return {kind:'budget',reason:'page'};
    let glyph:ReturnType<typeof createLayer>|undefined,verify:ReturnType<typeof createLayer>|undefined;
    let pixels:Uint8ClampedArray|undefined,clipped:Uint8ClampedArray|undefined,reads=0,accepted=false,failed=false;
    let result:MangaGlyphRasterResult;
    try {
        glyph=createLayer(width,height,ledger);verify=createLayer(width,height,ledger);
        const context=glyph.context;
        context.translate(-x,-y);context.font=plan.font;context.lineWidth=plan.lineWidth;
        context.textAlign='left';context.textBaseline='alphabetic';context.lineJoin='round';
        context.fillStyle=styles.fillStyle;context.strokeStyle=styles.strokeStyle;
        for(const chunk of plan.chunks){context.strokeText(chunk.text,chunk.x,chunk.y);context.fillText(chunk.text,chunk.x,chunk.y);}
        const target=verify.context;
        target.translate(-x,-y);target.beginPath();target.rect(box.x0,box.y0,box.x1-box.x0,box.y1-box.y0);target.clip();
        // 连续求交扣除每个孔；重叠孔仍是并集，不能用一次 evenodd 把重叠处重新放行。
        for(const hole of holes){
            target.beginPath();target.rect(x,y,width,height);target.rect(hole.x0,hole.y0,hole.x1-hole.x0,hole.y1-hole.y0);target.clip('evenodd');
        }
        target.drawImage(glyph.canvas,x,y);
        pixels=context.getImageData(0,0,width,height).data;ledger.liveReadbackPixels+=area;reads++;
        clipped=target.getImageData(0,0,width,height).data;ledger.liveReadbackPixels+=area;reads++;
        const audit=auditMangaGlyphRaster({pixels,clipped,width,height,x,y},box,holes,ledger);
        if(audit==='budget')result={kind:'budget',reason:'intersection'};
        else if(audit==='unsafe')result={kind:'unsafe'};
        else {accepted=true;result={kind:'accepted',canvas:glyph.canvas,x,y,dispose:glyph.dispose};}
    } catch(error){failed=true;throw error;} finally {
        pixels=clipped=undefined;ledger.liveReadbackPixels-=reads*area;
        let cleanupFailed=false,cleanupError:unknown;
        try {verify?.dispose();} catch(error){cleanupFailed=true;cleanupError=error;}
        if(!accepted||cleanupFailed)try {glyph?.dispose();} catch(error){if(!cleanupFailed){cleanupFailed=true;cleanupError=error;}}
        if(cleanupFailed&&!failed)throw cleanupError;
    }
    return result;
}

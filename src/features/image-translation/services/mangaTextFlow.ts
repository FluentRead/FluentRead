/**
 * @file src/features/image-translation/services/mangaTextFlow.ts
 * 文件职责：在既有漫画字号、完整行和基线不变的前提下，规划绕过透明保护孔的水平文字片段。
 * 主要内容：沿用原布局的字体和纵向字形带，按实际字素边界合并词界、绑定东亚标点且不拆词，将完整 token 顺序放入同一行的无孔区间；无字素分割器时仅在词界可安全确认时规划，否则回退连续矩形；
 * 使用调用方提供的原生字形左右及上下界和描边留量检查每个片段，横向安全量不改变纵向坐标；限制全文、行、token、
 * 度量次数、被测字符和投影工作量，任何可预期的不适配均返回完整回退结果，真正的度量异常保留原对象向上传播。
 * 模块边界：纯文字与矩形算法，复用 mangaTypography 的布局类型及调用方已经选定的字体；不访问 Canvas、像素或字体资源，
 * 不重排原行、不缩小字号、不修补原图，也不把名义度量范围当作最终原生栅格安全证明。
 */
import {hasMangaMixedClosingPrefix,hasMangaUnboundEdgePunctuation,isMangaOpeningToken,isMangaClosingToken,splitEdgePunctuation,type MangaTextLayout} from './mangaTypography';
import type {MangaRegion} from './mangaRegions';

export const MANGA_TEXT_FLOW_LIMITS = Object.freeze({utf16:4096,tokens:256,rows:16,spans:32,projections:65536,measure:1024,measuredUtf16:65536});
export type MangaTextFlowBox = MangaRegion['bbox'];
export type MangaTextFlowMetrics = Pick<TextMetrics,'width'|'actualBoundingBoxLeft'|'actualBoundingBoxRight'|'actualBoundingBoxAscent'|'actualBoundingBoxDescent'>;
export type MangaTextFlowMeasure = (text:string)=>MangaTextFlowMetrics;
export interface MangaTextFlowReference {
    readonly layout:MangaTextLayout; readonly family:string; readonly style:string;
    readonly fontSize:number; readonly lineWidth:number; readonly box:MangaTextFlowBox;
}
export interface MangaTextFlowCost {projectionChecks:number;metricCalls:number;measuredUtf16:number;tokens:number;rows:number}
export interface MangaTextFlowSpan {x0:number;x1:number}
export interface MangaTextFlowChunk {
    row:number;text:string;x:number;y:number;bounds:MangaTextFlowBox;span:MangaTextFlowSpan;tokenStart:number;tokenEnd:number;
}
export type MangaTextFlowRow = {row:number;empty:true;baseline:number}
    | {row:number;empty:false;baseline:number;band:{y0:number;y1:number};spans:MangaTextFlowSpan[]};
export type MangaTextFlowResult = {accepted:true;chunks:MangaTextFlowChunk[];rows:MangaTextFlowRow[];fontSize:number;font:string;lineWidth:number;cost:MangaTextFlowCost}
    | {accepted:false;reason:string;details?:unknown;cost:MangaTextFlowCost;chunks:[]};

const TOKENS=/\s+|[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]\p{Mark}*|[^\s\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
// 与主线漫画排版的普通文本快路径一致，排除组合符、连接符、韩文 Jamo 与 emoji。
const SIMPLE_GRAPHEMES=/^[\x20-\x7e\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\uac00-\ud7a3\uff01-\uff65]*$/u;
const GRAPHEME_EXTEND=/[\p{Mark}\p{Grapheme_Extend}]/u;
const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}):undefined;
const supported=(text:string)=>/^[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Common}\p{Script=Inherited}]*$/u.test(text)
    && !/[\p{Bidi_Control}\u200e\u200f]/u.test(text);
class FlowRejection extends Error {}
function tokens(text:string):string[]|undefined {
    const initial:string[]=text.match(TOKENS)||[];
    const simple=SIMPLE_GRAPHEMES.test(text)&&!GRAPHEME_EXTEND.test(text);
    if(initial.length>1&&!segmenter&&(!simple||hasMangaUnboundEdgePunctuation(initial)))return;
    let parts=initial;
    if(initial.length>1&&!simple&&segmenter){
        const iterator=segmenter.segment(text)[Symbol.iterator](),merged:string[]=[];
        let offset=0,end=0,pending='';
        for(const token of initial){
            offset+=token.length;
            while(end<offset)end+=iterator.next().value!.segment.length;
            pending+=token;
            if(offset===end){merged.push(pending);pending='';}
        }
        parts=merged;
    }
    const result:string[]=[];let opening='';
    // 保留原有空白，闭标点跨空白时用共享拆分器识别其词首字素。
    const punctuationInput:string[]=[];let hasPrevious=false;
    for(let index=0;index<parts.length;index++){
        const token=parts[index];
        if(segmenter&&hasPrevious&&index>0&&/^\s+$/u.test(parts[index-1])&&hasMangaMixedClosingPrefix(token)){
            punctuationInput.push(...splitEdgePunctuation(['x',token]).slice(1));
        }else punctuationInput.push(token);
        if(!/^\s+$/u.test(token))hasPrevious=true;
    }
    // 普通文字没有待拆的词边缘标点时，保持原 token，避免逐字素再分割。
    const punctuationParts=simple&&!hasMangaUnboundEdgePunctuation(punctuationInput)?punctuationInput:splitEdgePunctuation(punctuationInput);
    for(const token of punctuationParts){
        if(isMangaOpeningToken(token)){opening+=token;continue;}
        // 原空白逐字保留，但不能让开括号或句末符号隔着空白独自落到孔的另一侧。
        if(opening&&/^\s+$/u.test(token)){opening+=token;continue;}
        // 开括号后暂时只有闭标点时继续等待正文，避免只有标点的片段跨孔悬空。
        if(opening&&isMangaClosingToken(token)){opening+=token;continue;}
        if(isMangaClosingToken(token)&&!opening&&result.length){
            let previous=result.length-1;
            while(previous>=0&&/^\s+$/u.test(result[previous]))previous--;
            if(previous>=0){result[previous]+=result.slice(previous+1).join('')+token;result.length=previous+1;continue;}
        }
        result.push(opening+token);opening='';
    }
    if(opening)result.push(opening);
    return result;
}

/** measure 必须已使用 ref 对应字体、left/alphabetic 原生度量；本函数不修改其上下文或输入。 */
export function planMangaTextFlow(text:string,ref:MangaTextFlowReference,holes:readonly MangaTextFlowBox[],
    measure:MangaTextFlowMeasure,horizontalSafety=0):MangaTextFlowResult {
    const limit=MANGA_TEXT_FLOW_LIMITS,cost:MangaTextFlowCost={projectionChecks:0,metricCalls:0,measuredUtf16:0,tokens:0,rows:ref.layout.lines.length};
    const fail=(reason:string,details?:unknown):MangaTextFlowResult=>({accepted:false,reason,details,cost,chunks:[]});
    if(text.length>limit.utf16)return fail('input-budget');
    if(!supported(text))return fail('unsupported-bidi-or-context-script');
    if(ref.layout.lines.length>limit.rows)return fail('row-budget');
    const size=ref.fontSize,b=ref.box;
    if(![size,ref.lineWidth,horizontalSafety,b.x0,b.x1,b.y0,b.y1].every(Number.isFinite)||size<=0||ref.lineWidth<=0||horizontalSafety<0||b.x1<=b.x0||b.y1<=b.y0||ref.layout.fontSize!==size||!ref.family||!ref.style)return fail('invalid-reference');
    const ink=ref.layout.ink;
    if(!ink||!Number.isFinite(ink.height)||ink.height<=0||ink.height>b.y1-b.y0||ink.baselines.length!==ref.layout.lines.length||!ink.baselines.every(Number.isFinite))return fail('incomplete-or-unfit-original-ink');
    const pad=ref.lineWidth/2+.5,hPad=pad+horizontalSafety,chunks:MangaTextFlowChunk[]=[],rows:MangaTextFlowRow[]=[];
    let inputUtf16=0;
    for(let row=0;row<ref.layout.lines.length;row++){
        const line=ref.layout.lines[row];inputUtf16+=line.length;
        if(inputUtf16>limit.utf16)return fail('input-budget');
        if(!supported(line))return fail('unsupported-bidi-or-context-script');
        const parts=tokens(line);
        if(!parts)return fail('grapheme-segmentation-unavailable');
        cost.tokens+=parts.length;
        if(cost.tokens>limit.tokens)return fail('token-budget');
        const y=b.y0+(b.y1-b.y0-ink.height)/2+ink.baselines[row];
        if(!line){rows.push({row,empty:true,baseline:y});continue;}
        const metric=(value:string):MangaTextFlowMetrics=>{
            if(++cost.metricCalls>limit.measure||(cost.measuredUtf16+=value.length)>limit.measuredUtf16)throw new FlowRejection('metric-budget');
            const m=measure(value);
            if(![m.width,m.actualBoundingBoxLeft,m.actualBoundingBoxRight,m.actualBoundingBoxAscent,m.actualBoundingBoxDescent].every(Number.isFinite))throw new FlowRejection('missing-glyph-metrics');
            return m;
        };
        try{
            const whole=metric(line),band={y0:y-whole.actualBoundingBoxAscent-pad,y1:y+whole.actualBoundingBoxDescent+pad};
            if(band.y0<b.y0||band.y1>b.y1)return fail('original-line-band-outside-bbox',band);
            const blocked:MangaTextFlowSpan[]=[];
            for(const h of holes){
                if(++cost.projectionChecks>limit.projections)return fail('projection-budget');
                if(![h.x0,h.x1,h.y0,h.y1].every(Number.isFinite)||h.x1<=h.x0||h.y1<=h.y0)return fail('invalid-hole');
                if(h.y1>band.y0&&h.y0<band.y1&&h.x1>b.x0&&h.x0<b.x1)blocked.push({x0:Math.max(b.x0,h.x0),x1:Math.min(b.x1,h.x1)});
            }
            blocked.sort((a,b)=>a.x0-b.x0);
            const merged:MangaTextFlowSpan[]=[];
            for(const r of blocked){const old=merged.at(-1);if(old&&old.x1>=r.x0)old.x1=Math.max(old.x1,r.x1);else merged.push({...r});}
            const spans:MangaTextFlowSpan[]=[];let x=b.x0;
            for(const r of merged){if(r.x0>x)spans.push({x0:x,x1:r.x0});x=r.x1;}
            if(x<b.x1)spans.push({x0:x,x1:b.x1});
            if(spans.length>limit.spans)return fail('span-budget');
            let cursor=(b.x0+b.x1-whole.width)/2,part=0;
            for(const span of spans){
                const start=Math.max(span.x0,cursor);if(start>=span.x1)continue;
                let best:MangaTextFlowChunk|undefined;
                for(let end=part+1;end<=parts.length;end++){
                    const candidate=parts.slice(part,end).join('');if(!candidate.trim())continue;
                    const m=metric(candidate),anchor=start+hPad+Math.max(0,m.actualBoundingBoxLeft);
                    const bounds={x0:anchor-m.actualBoundingBoxLeft-hPad,x1:anchor+Math.max(m.actualBoundingBoxRight,m.width)+hPad,y0:y-m.actualBoundingBoxAscent-pad,y1:y+m.actualBoundingBoxDescent+pad};
                    const clear=holes.every(h=>{
                        if(++cost.projectionChecks>limit.projections)throw new FlowRejection('projection-budget');
                        return bounds.x1<=h.x0||bounds.x0>=h.x1||bounds.y1<=h.y0||bounds.y0>=h.y1;
                    });
                    if(clear&&bounds.x0>=span.x0&&bounds.x1<=span.x1&&bounds.y0>=b.y0&&bounds.y1<=b.y1)best={row,text:candidate,x:anchor,y,bounds,span:{...span},tokenStart:part,tokenEnd:end};
                }
                if(best){chunks.push(best);part=best.tokenEnd;}
                cursor=-Infinity;if(part===parts.length)break;
            }
            if(part!==parts.length)return fail('intact-tokens-do-not-fit',{row,unplaced:parts.length-part,spans});
            rows.push({row,baseline:y,band,spans,empty:false});
        }catch(error){if(error instanceof FlowRejection)return fail(error.message);throw error;}
    }
    return{accepted:true,chunks,rows,fontSize:size,font:`${ref.style} ${size}px ${ref.family}`,lineWidth:ref.lineWidth,cost};
}

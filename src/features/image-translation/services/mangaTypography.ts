/**
 * @file src/features/image-translation/services/mangaTypography.ts
 * 文件职责：在漫画原有区域内排版完整译文，区分对白与大标题并保持东亚与泰语的阅读习惯。
 * 主要内容：保留词、字素与显式换行，扩展东亚文字、泰语与英文分词，按归一化目标语言缓存词分割器并在字素边界合并词；纯同类标点直接绑定，闭标点跟随前字、开标点跟随后字；按真实 Canvas 字宽和可用字形上下界二分适配字号，并将外描边余量从多行行距中解耦，避免厚描边挤占行间领先距同时保留顶部与底部的完整描边高度；同一区域共享分词与长词字素，候选仅保留数字状态，最大字号预检及候选精修后均严格复核胜出字号和平局剪枝契约；普通单框与候选搜索共用同一词界、逐段方差最小化行宽平衡和保持原行数的可选椭圆气泡塑形规则，不增减行数、不过度缩字、不截字、不横向压缩。
 * 模块边界：纯文字和度量算法，不读取页面、配置或字体资源，不识别、翻译或修补图片；普通图片继续使用独立的通用排版。
 * 完整词：短正文在已安全绑定的字素/标点token上按目标语言词界合并或切分泰语词，避免把词从中间折行；整段最多1024个UTF16单元和256个原token，不拆开既有安全单元，不改显式换行。长文或缺分割器沿用原分词，真正超宽的词仍由既有完整字素回退适配。
 * 可选几何约束：同样行数可采用已观察源行距，每个字号、平衡及椭圆塑形候选须同时通过调用方的完整字形变换检查；缺省调用仍保持原算法与返回布局。
 */
import type {ImageTranslationTextLayout,ImageTextLayoutConstraints} from './textLayoutTypes';

export {IMAGE_TEXT_FONT as MANGA_TEXT_FONT} from './imageTextFont';
const OPEN = /^[（【「『《〈“‘(\[]+$/u;
const CLOSE = /^[，。！？、；：）】」』》〉”’….,!?;:)\]]+$/u;
const OPEN_ANY = /[（【「『《〈“‘(\[]/u;
const CLOSE_ANY = /[，。！？、；：）】」』》〉”’….,!?;:)\]]/u;
// 无字素分割器时完整保留主线的分词和标点行为，不推断复杂字符的边界。
const LEGACY_CJK = /\s+|[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]\p{Mark}*|[^\s\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
const CJK = /\s+|[\uFF66-\uFF9D][\uFF9E\uFF9F](?:\p{Mark}|[\u200c\u200d])*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af](?:\p{Mark}|[\u200c\u200d])*|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
const SIMPLE_TEXT = /^[\x20-\x7e\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\uac00-\ud7a3\uff01-\uff65]*$/u;
const TEXT_EXTEND = /[\p{Mark}\p{Grapheme_Extend}]/u;
const MangaSegmenter=Intl.Segmenter;
const segmenter = typeof MangaSegmenter === 'function' ? new MangaSegmenter(undefined, {granularity:'grapheme'}) : undefined;
const wordSegmenters = new Map<string, Intl.Segmenter>();
const WORD_SCRIPTS=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const THAI_SCRIPT=/\p{Script=Thai}/u;

export interface MangaGlyphMetrics {ascent: number; descent: number; bleed?: number}
export interface MangaTypographyOptions {language?: string; elliptical?: boolean}
export interface MangaTextLayout extends ImageTranslationTextLayout {ink?: {height: number; baselines: number[]}}

function normalizeSegmenterLocale(language?: string): string | undefined {
    if (typeof language !== 'string') return undefined;
    const normalized = language.trim().replace(/_/gu, '-');
    if (!normalized || normalized.toLowerCase() === 'auto') return undefined;
    return normalized;
}

function getWordSegmenter(language?: string): Intl.Segmenter {
    const locale = normalizeSegmenterLocale(language);
    const key = locale?.toLowerCase() ?? '';
    const existing = wordSegmenters.get(key);
    if (existing) return existing;
    let created: Intl.Segmenter;
    try {
        created = new MangaSegmenter(locale, {granularity:'word'});
    } catch {
        const fallback = wordSegmenters.get('') ?? new MangaSegmenter(undefined, {granularity:'word'});
        wordSegmenters.set('', fallback);
        return fallback;
    }
    if (wordSegmenters.size >= 16) wordSegmenters.delete(wordSegmenters.keys().next().value!);
    wordSegmenters.set(key, created);
    return created;
}

/** 按实际字素边界合并相邻词，空白保留原有归一化规则；无分段器时沿用码点回退。 */
function tokenizeMangaText(paragraph:string):string[] {
    if(!segmenter)return paragraph.match(LEGACY_CJK)||[];
    const tokens=paragraph.match(CJK)||[];
    const mayCross=tokens.length>1&&segmenter
        &&tokens.some((token,index)=>index>0&&!/^\s/u.test(token)&&!/^\s/u.test(tokens[index-1]))
        &&!(SIMPLE_TEXT.test(paragraph)&&!TEXT_EXTEND.test(paragraph));
    if(!mayCross||!segmenter)return tokens;
    const iterator=segmenter.segment(paragraph)[Symbol.iterator](),merged:string[]=[];
    let offset=0,end=0,pending='';
    for(const token of tokens){
        offset+=token.length;
        while(end<offset)end+=iterator.next().value!.segment.length;
        if(/^\s+$/u.test(token)){
            if(pending)merged.push(pending);
            merged.push(token);pending='';
        }else{
            pending+=token;
            if(offset===end){merged.push(pending);pending='';}
        }
    }
    return merged;
}

/** 普通标点直接识别；带组合符的单一字素按分割器边界识别，避免拆开字素。 */
function isPunctuationToken(token:string,contains:RegExp):boolean {
    if(!segmenter||!contains.test(token))return false;
    const iterator=segmenter.segment(token)[Symbol.iterator]();
    return !iterator.next().done&&iterator.next().done===true;
}

/** 仅拆出词首闭标点和词尾开标点，词内小数、网址及括号仍保留原词。 */
export function splitEdgePunctuation(tokens:string[]):string[] {
    if(!segmenter)return tokens;
    const result:string[]=[];
    for(let index=0;index<tokens.length;index++){
        const token=tokens[index];
        // 同类纯标点在绑定阶段会合并成完全相同的内容，无须先逐字素拆开。
        if(token.length===1||OPEN.test(token)||CLOSE.test(token)){result.push(token);continue;}
        const prefix=index>0&&!/^\s+$/u.test(tokens[index-1])&&!/^[A-Za-z0-9]/u.test(token)&&CLOSE_ANY.test(token);
        const suffix=index<tokens.length-1&&!/[A-Za-z0-9]$/u.test(token)&&OPEN_ANY.test(token);
        if(!prefix&&!suffix){result.push(token);continue;}
        const parts=Array.from(segmenter.segment(token),part=>part.segment);
        let left=0,right=parts.length;
        if(prefix)while(left<right-1&&CLOSE_ANY.test(parts[left]))result.push(parts[left++]);
        if(suffix)while(right>left+1&&OPEN_ANY.test(parts[right-1]))right--;
        result.push(parts.slice(left,right).join(''));
        for(let position=right;position<parts.length;position++)result.push(parts[position]);
    }
    return result;
}

/** 供绕孔排版识别同一完整字素上的标点，绑定时由调用方保留原行空白。 */
export function isMangaOpeningToken(token:string):boolean {
    return OPEN.test(token)||(token.length>1&&!(token.charCodeAt(0)<128&&token.charCodeAt(1)<128)&&isPunctuationToken(token,OPEN_ANY));
}
export function isMangaClosingToken(token:string):boolean {
    return CLOSE.test(token)||(token.length>1&&!(token.charCodeAt(0)<128&&token.charCodeAt(1)<128)&&isPunctuationToken(token,CLOSE_ANY));
}

/** 判断词首闭标点是否与后文同属一个 token；不拆分字素。 */
export function hasMangaMixedClosingPrefix(token:string):boolean {
    return token.length>1&&!CLOSE.test(token)&&CLOSE_ANY.test(token[0]);
}

/** 无字素分割器时不拆词；可安全识别的词边缘标点需要调用方回退。 */
export function hasMangaUnboundEdgePunctuation(tokens:string[]):boolean {
    let hasPrevious=false;
    for(let index=0;index<tokens.length;index++){
        const token=tokens[index];
        if(/^\s+$/u.test(token))continue;
        if(token.length>1&&((hasPrevious&&hasMangaMixedClosingPrefix(token))
            || (index+1<tokens.length&&!OPEN.test(token)&&OPEN_ANY.test(token[token.length-1]))))return true;
        hasPrevious=true;
    }
    return false;
}

function bindPunctuation(tokens: string[]): string[] {
    const result: string[] = [];
    let opening = '';
    for (const token of tokens) {
        if (OPEN.test(token)) {opening += token; continue;}
        if (segmenter && opening && /^\s+$/u.test(token)) {opening += ' '; continue;}
        if (CLOSE.test(token) && !opening && result.length && !/^\s+$/u.test(result[result.length - 1])) {result[result.length - 1] += token;continue;}
        // 两个相邻 ASCII 字符不属于同一字素；普通单字及英文词不需要分割器。
        if(token.length>1&&!(token.charCodeAt(0)<128&&token.charCodeAt(1)<128)){
            if(isPunctuationToken(token,OPEN_ANY)){opening+=token;continue;}
            if(isPunctuationToken(token,CLOSE_ANY)&&!opening&&result.length&&!/^\s+$/u.test(result[result.length-1])){result[result.length-1]+=token;continue;}
        }
        result.push(opening + token);opening = '';
    }
    if (opening) result.push(opening);
    return result;
}

interface MangaTextSource {paragraphs:string[];tokens:string[][];splitTokens:Map<string,string[]>}
/** 失败的最大字号布局不进入候选状态，避免同时保留多份整段行数组和闭包。 */
export interface MangaTextSearchCandidate {readonly width:number;readonly height:number;readonly maximum?:MangaTextLayout}

function parseMangaText(normalized:string,language?:string):MangaTextSource {
    const paragraphs = normalized.split('\n').map(paragraph => paragraph.trim());
    const tokens = paragraphs.map(paragraph => bindPunctuation(splitEdgePunctuation(tokenizeMangaText(paragraph))));
    if(segmenter&&normalized.length<=1024&&tokens.reduce((count,parts)=>count+parts.length,0)<=256){
        for(let row=0;row<tokens.length;row++){
            const parts=tokens[row],text=parts.join('');
            if(!WORD_SCRIPTS.test(text))continue;
            if(THAI_SCRIPT.test(text)){
                if(text.length<2)continue;
                const seg=getWordSegmenter(language),expanded:string[]=[];
                for(const part of parts){
                    if(THAI_SCRIPT.test(part)){
                        for(const item of seg.segment(part))expanded.push(item.segment);
                    }else expanded.push(part);
                }
                tokens[row]=bindPunctuation(splitEdgePunctuation(expanded));
                continue;
            }
            if(parts.length<2)continue;
            const seg=getWordSegmenter(language);
            const boundaries=new Set<number>([text.length]);
            for(const part of seg.segment(text))boundaries.add(part.index+part.segment.length);
            const words:string[]=[];let pending='',offset=0;
            for(const part of parts){
                pending+=part;offset+=part.length;
                if(boundaries.has(offset)){words.push(pending);pending='';}
            }
            tokens[row]=words;
        }
    }
    return {paragraphs,tokens,splitTokens:new Map<string,string[]>()};
}

function mangaLayoutFunctions(source:MangaTextSource,width:number,height:number,
    measure:(text:string,size:number)=>number,measureInk?: (text:string,size:number)=>MangaGlyphMetrics|undefined,constraints?:ImageTextLayoutConstraints,options?:MangaTypographyOptions) {
    const {paragraphs,tokens,splitTokens} = source;
    const wrapParagraph = (paragraph: string[], size: number, limitForLine: (lineIndex: number) => number): string[] => {
        const lines: string[] = [];
        let current = '', space = '';
        for (const token of paragraph) {
            if (/^\s+$/u.test(token)) {space = ' '; continue;}
            const limit = limitForLine(lines.length);
            const candidate = current + space + token; space = '';
            if (measure(candidate,size) <= limit) {current = candidate; continue;}
            if (current) {lines.push(current); current = '';}
            const nextLimit = limitForLine(lines.length);
            // 有完整字素/标点边界时，平衡不能拆开原区域内放得下的词；旧码点路径保持原规则。
            if (measure(token,size) <= (segmenter?width:nextLimit)) {current = token; continue;}
            let parts = splitTokens.get(token);
            if (!parts) {
                parts = bindPunctuation(segmenter ? Array.from(segmenter.segment(token), part => part.segment) : Array.from(token));
                splitTokens.set(token, parts);
            }
            for (const part of parts) {
                if (current && measure(current + part,size) > limitForLine(lines.length)) {lines.push(current); current = '';}
                current += part;
            }
        }
        lines.push(current);
        return lines;
    };
    const finalizeLayout = (lines: string[], size: number): MangaTextLayout => {
        const layout: MangaTextLayout = {lines,fontSize:size,lineHeight:size * 1.2};
        if (!measureInk) return layout;
        // 空段仍占一个行距；任何非空行缺少完整指标时保守使用既有行框。
        const metrics = lines.map(line=>line ? measureInk(line,size) : {ascent:size*.6,descent:size*.6});
        let lineHeight = layout.lineHeight;
        for (const metric of metrics) {
            const bleed = metric?.bleed ?? 0;
            if (!metric || !Number.isFinite(metric.ascent) || !Number.isFinite(metric.descent)
                || !Number.isFinite(metric.ascent+metric.descent) || metric.ascent+metric.descent<=0
                || !Number.isFinite(bleed) || bleed < 0) return layout;
            // 外描边余量仅计入顶底外包高度，不再翻倍挤占行间基线距离。
            lineHeight = Math.max(lineHeight,metric.ascent+metric.descent,bleed>0?size*1.22:0);
        }
        layout.lineHeight = lineHeight;
        if(lines.length===constraints?.sourceLineCount&&Number.isFinite(constraints.sourceLinePitch))layout.lineHeight=Math.max(layout.lineHeight,constraints.sourceLinePitch!);
        let top = Infinity, bottom = -Infinity;
        const baselines = (metrics as MangaGlyphMetrics[]).map((metric,index)=>{
            const baseline = index*layout.lineHeight, bleed = metric.bleed ?? 0;
            top = Math.min(top,baseline-(metric.ascent+bleed));bottom = Math.max(bottom,baseline+(metric.descent+bleed));
            return baseline;
        });
        for (let index=0;index<baselines.length;index++) baselines[index] -= top;
        layout.ink = {height:bottom-top,baselines};
        return layout;
    };
    const wrap = (size: number, limit = width) => {
        const lines: string[] = [];
        for (const paragraph of tokens) {
            for (const line of wrapParagraph(paragraph, size, () => limit)) lines.push(line);
        }
        return finalizeLayout(lines, size);
    };
    const fits = (layout: MangaTextLayout) => (layout.ink?.height ?? layout.lines.length * layout.lineHeight) <= height
        && layout.lines.every(line => measure(line,layout.fontSize) <= width)&&(!constraints?.accept||constraints.accept(layout));
    const lineStats = (widths: number[]) => {
        let min = Infinity, max = -Infinity;
        for (const value of widths) { if (value < min) min = value; if (value > max) max = value; }
        const spread = max - min, last = widths[widths.length - 1];
        const widowPenalty = last < max * .45 ? (max * .45 - last) * .5 : 0;
        return {max, spread, score: spread + widowPenalty};
    };
    // 保留字号与行数，逐段在行宽差异明显时仅采纳真正降低极差与孤字惩罚的平衡候选。
    const balance = (layout: MangaTextLayout): MangaTextLayout => {
        if (paragraphs.length > 4) return layout;
        const size = layout.fontSize;
        const paragraphLines = paragraphs.length === 1
            ? [layout.lines]
            : tokens.map(paragraph => wrapParagraph(paragraph, size, () => width));
        let bestLayout = layout;
        for (let row = 0; row < paragraphLines.length; row++) {
            const currentLines = paragraphLines[row];
            if (currentLines.length < 2) continue;
            const currentWidths = currentLines.map(line => measure(line, size));
            if (currentLines.length > 6) continue;
            const base = lineStats(currentWidths);
            const trigger = segmenter ? base.spread > base.max * .25 : currentWidths[currentWidths.length - 1] < base.max * .55;
            if (!(base.max > 0) || !trigger) continue;
            let low = 0, high = width, bestSpread = base.spread, bestScore = base.score;
            for (let iteration = 0; iteration < 5; iteration++) {
                const limit = (low + high) / 2;
                const candLines = wrapParagraph(tokens[row], size, () => limit);
                if (candLines.length !== currentLines.length) { low = limit; continue; }
                const candWidths = candLines.map(line => measure(line, size));
                if (!candWidths.every(value => value <= limit)) { low = limit; continue; }
                const merged = paragraphLines.length === 1
                    ? candLines
                    : paragraphLines.flatMap((group, index) => index === row ? candLines : group);
                const candidate = finalizeLayout(merged, size);
                if (!fits(candidate)) { low = limit; continue; }
                high = limit;
                const next = lineStats(candWidths);
                if (next.spread < bestSpread && next.score < bestScore) {
                    paragraphLines[row] = candLines;
                    bestLayout = candidate;
                    bestSpread = next.spread;
                    bestScore = next.score;
                }
            }
        }
        return bestLayout;
    };
    // 居中均匀气泡的 3 行以上单段译文收窄首尾行宽贴合椭圆轮廓，超出 8% 缩字或增行则回退矩形。
    const shapeElliptical = (layout: MangaTextLayout): MangaTextLayout => {
        if (!options?.elliptical || paragraphs.length !== 1 || layout.lines.length < 3) return layout;
        const target = layout.lines.length, edgeLimit = width * .86;
        if (measure(layout.lines[0], layout.fontSize) <= edgeLimit
            && measure(layout.lines[target - 1], layout.fontSize) <= edgeLimit) return layout;
        const tryElliptical = (size: number): MangaTextLayout | undefined => {
            const candLines = wrapParagraph(tokens[0], size, line => line === 0 || line >= target - 1 ? edgeLimit : width);
            if (candLines.length !== target) return undefined;
            if (!candLines.every((line, index) => measure(line, size) <= (index === 0 || index === target - 1 ? edgeLimit : width))) return undefined;
            const candidate = finalizeLayout(candLines, size);
            return fits(candidate) ? candidate : undefined;
        };
        const sameSize = tryElliptical(layout.fontSize);
        if (sameSize) return sameSize;
        let low = layout.fontSize * .92, high = layout.fontSize;
        let best = tryElliptical(low);
        if (!best) return layout;
        for (let iteration = 0; iteration < 5; iteration++) {
            const mid = (low + high) / 2, candidate = tryElliptical(mid);
            if (candidate) { best = candidate; low = mid; } else high = mid;
        }
        return best;
    };
    const refine = (layout: MangaTextLayout) => shapeElliptical(balance(layout));
    return {wrap,fits,refine};
}

/** 准确测量候选整行；普通单框先校验、再分词，与候选搜索共用相同词界及适配算法。 */
export function layoutMangaTranslationText(text: string, width: number, height: number,
    measure: (text: string, size: number) => number, maxSize: number,
    measureInk?: (text: string, size: number) => MangaGlyphMetrics | undefined,constraints?:ImageTextLayoutConstraints,options?:MangaTypographyOptions): MangaTextLayout {
    const normalized = text.replace(/\r\n?/gu, '\n').trim();
    if (!normalized || ![width,height,maxSize].every(value => Number.isFinite(value) && value > 0)) return {lines:[],fontSize:0,lineHeight:0};
    const source=parseMangaText(normalized,options?.language);
    const {wrap,fits,refine}=mangaLayoutFunctions(source,width,height,measure,measureInk,constraints,options);
    const {paragraphs}=source;
    let high = measureInk ? maxSize : Math.min(maxSize,height / 1.2);
    const largest = wrap(high);
    if (fits(largest)) return refine(largest);
    let low = Math.min(1,width / paragraphs.reduce((largest, paragraph) => Math.max(largest, measure(paragraph,1)), 1),height / (paragraphs.length * 1.2)) * .99;
    let best = wrap(low);
    for (let iteration = 0; iteration < 12; iteration++) {
        const candidate = wrap((low + high) / 2);
        if (fits(candidate)) {best = candidate; low = candidate.fontSize;} else high = candidate.fontSize;
    }
    return refine(best);
}

/**
 * 仅用于离屏原生 Canvas 一次同步绘制：同字体/全文的数值度量必须稳定；不承诺任意有状态回调的执行次序。
 * prepare 原序预检最大字号，失败时只返回尺寸；finish 的高低界每次局部新建，不留下失败布局的间接引用。
 * 所有候选共享不可变分词及按原词缓存的字素；没有额外全文或度量缓存，原生异常不捕获、不转换。
 */
export function createMangaTranslationSearch(text:string,measure:(text:string,size:number)=>number,maxSize:number,
    measureInk?:(text:string,size:number)=>MangaGlyphMetrics|undefined,options?:MangaTypographyOptions) {
    const normalized=text.replace(/\r\n?/gu,'\n').trim();
    const source=normalized&&Number.isFinite(maxSize)&&maxSize>0?parseMangaText(normalized,options?.language):undefined;
    const empty=():MangaTextLayout=>({lines:[],fontSize:0,lineHeight:0});
    const valid=(candidate:MangaTextSearchCandidate)=>!!source&&[candidate.width,candidate.height].every(value=>Number.isFinite(value)&&value>0);
    return {
        prepare(width:number,height:number):MangaTextSearchCandidate {
            const candidate={width,height};
            if(!valid(candidate))return {...candidate,maximum:empty()};
            const {wrap,fits,refine}=mangaLayoutFunctions(source!,width,height,measure,measureInk,undefined,options);
            const largest=wrap(measureInk?maxSize:Math.min(maxSize,height/1.2));
            return fits(largest)?{...candidate,maximum:refine(largest)}:candidate;
        },
        finish(candidate:MangaTextSearchCandidate,winningSize=-Infinity,allowEqual=true):MangaTextLayout|undefined {
            const rejected=(layout:MangaTextLayout)=>layout.fontSize<winningSize||(!allowEqual&&layout.fontSize===winningSize);
            if(candidate.maximum)return rejected(candidate.maximum)?undefined:candidate.maximum;
            if(!valid(candidate))return empty();
            const {width,height}=candidate,{paragraphs}=source!;
            const {wrap,fits,refine}=mangaLayoutFunctions(source!,width,height,measure,measureInk,undefined,options);
            let high=measureInk?maxSize:Math.min(maxSize,height/1.2);
            let low=Math.min(1,width/paragraphs.reduce((largest,paragraph)=>Math.max(largest,measure(paragraph,1)),1),height/(paragraphs.length*1.2))*.99;
            // 只有 high 是后续采样与 best 的上界时才能剪枝；极小字号仍完整沿用旧搜索。
            const bounded=low<=high;
            const mayWin=()=>!bounded||(allowEqual?high>=winningSize:high>winningSize);
            if(!mayWin())return undefined;
            let best=wrap(low);
            for(let iteration=0;iteration<12;iteration++){
                if(!mayWin())return undefined;
                const next=wrap((low+high)/2);
                if(fits(next)){best=next;low=next.fontSize;}else high=next.fontSize;
            }
            if(rejected(best))return undefined;
            const refined=refine(best);
            return rejected(refined)?undefined:refined;
        },
    };
}

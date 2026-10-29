/**
 * @file src/features/image-translation/services/mangaTypography.ts
 * 文件职责：在漫画原有区域内排版完整译文，区分对白与大标题并保持东亚标点的阅读习惯。
 * 主要内容：保留词、字素与显式换行，扩展东亚文字与英文分词，必要时按字素边界合并词；闭标点跟随前字、开标点跟随后字；按真实 Canvas 字宽和可用字形上下界二分适配字号，单行不重复扣除行距，多行仍保留基线间距，缺少完整字形指标时沿用行框；合并字形有效性与最大行距遍历，基线数组就地归一化，减少临时数组而不改变浮点运算顺序；同一区域共享分词与长词字素，候选仅保留数字状态，最大字号预检后按二分上界跳过不可能胜出的搜索；普通单框仍保留原度量顺序；逐项求最大宽高以兼容大量段落与行；末行过短时平衡行宽而不增加行数或越过字形预算，不截字、不横向压缩。
 * 模块边界：纯文字和度量算法，不读取页面、配置或字体资源，不识别、翻译或修补图片；普通图片继续使用独立的通用排版。
 */
import type {ImageTranslationTextLayout} from './rendering';

export const MANGA_TEXT_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK TC", "Noto Sans CJK JP", "Noto Sans CJK KR", sans-serif';
const OPEN = /^[（【「『《〈“‘(\[]+$/u;
const CLOSE = /^[，。！？、；：）】」』》〉”’….,!?;:)\]]+$/u;
const OPEN_ANY = /[（【「『《〈“‘(\[]/u;
const CLOSE_ANY = /[，。！？、；：）】」』》〉”’….,!?;:)\]]/u;
// 无字素分割器时完整保留主线的分词和标点行为，不推断复杂字符的边界。
const LEGACY_CJK = /\s+|[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]\p{Mark}*|[^\s\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
const CJK = /\s+|[\uFF66-\uFF9D][\uFF9E\uFF9F](?:\p{Mark}|[\u200c\u200d])*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af](?:\p{Mark}|[\u200c\u200d])*|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu;
const SIMPLE_TEXT = /^[\x20-\x7e\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u2e80-\u9fff\uac00-\ud7a3\uff01-\uff65]*$/u;
const TEXT_EXTEND = /[\p{Mark}\p{Grapheme_Extend}]/u;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity:'grapheme'}) : undefined;

export interface MangaGlyphMetrics {ascent: number; descent: number}
export interface MangaTextLayout extends ImageTranslationTextLayout {ink?: {height: number; baselines: number[]}}

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
        if(token.length===1){result.push(token);continue;}
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

function parseMangaText(normalized:string):MangaTextSource {
    const paragraphs = normalized.split('\n').map(paragraph => paragraph.trim());
    const tokens = paragraphs.map(paragraph => bindPunctuation(splitEdgePunctuation(tokenizeMangaText(paragraph))));
    return {paragraphs,tokens,splitTokens:new Map<string,string[]>()};
}

function mangaLayoutFunctions(source:MangaTextSource,width:number,height:number,
    measure:(text:string,size:number)=>number,measureInk?: (text:string,size:number)=>MangaGlyphMetrics|undefined) {
    const {paragraphs,tokens,splitTokens} = source;
    const wrap = (size: number, limit = width) => {
        const lines: string[] = [];
        for (const paragraph of tokens) {
            let current = '', space = '';
            for (const token of paragraph) {
                if (/^\s+$/u.test(token)) {space = ' '; continue;}
                const candidate = current + space + token; space = '';
                if (measure(candidate,size) <= limit) {current = candidate; continue;}
                if (current) {lines.push(current); current = '';}
                if (measure(token,size) <= limit) {current = token; continue;}
                let parts = splitTokens.get(token);
                if (!parts) {
                    parts = bindPunctuation(segmenter ? Array.from(segmenter.segment(token), part => part.segment) : Array.from(token));
                    splitTokens.set(token, parts);
                }
                for (const part of parts) {
                    if (current && measure(current + part,size) > limit) {lines.push(current); current = '';}
                    current += part;
                }
            }
            lines.push(current);
        }
        const layout: MangaTextLayout = {lines,fontSize:size,lineHeight:size * 1.2};
        if (!measureInk) return layout;
        // 空段仍占一个行距；任何非空行缺少完整指标时保守使用既有行框。
        const metrics = lines.map(line=>line ? measureInk(line,size) : {ascent:size*.6,descent:size*.6});
        let lineHeight = layout.lineHeight;
        for (const metric of metrics) {
            if (!metric || !Number.isFinite(metric.ascent) || !Number.isFinite(metric.descent) || !Number.isFinite(metric.ascent+metric.descent) || metric.ascent+metric.descent<=0) return layout;
            lineHeight = Math.max(lineHeight,metric.ascent+metric.descent);
        }
        layout.lineHeight = lineHeight;
        let top = Infinity, bottom = -Infinity;
        const baselines = (metrics as MangaGlyphMetrics[]).map((metric,index)=>{
            const baseline = index*layout.lineHeight;
            top = Math.min(top,baseline-metric.ascent);bottom = Math.max(bottom,baseline+metric.descent);
            return baseline;
        });
        for (let index=0;index<baselines.length;index++) baselines[index] -= top;
        layout.ink = {height:bottom-top,baselines};
        return layout;
    };
    const fits = (layout: MangaTextLayout) => (layout.ink?.height ?? layout.lines.length * layout.lineHeight) <= height
        && layout.lines.every(line => measure(line,layout.fontSize) <= width);
    // 保留字号与行数，仅在末行明显过短时收拢行宽，避免气泡中留下单独的「了。」。
    const balance = (layout: MangaTextLayout) => {
        if (paragraphs.length !== 1 || layout.lines.length < 2) return layout;
        const lengths = layout.lines.map(line => measure(line,layout.fontSize));
        if (lengths[lengths.length-1] >= lengths.reduce((largest, length) => Math.max(largest, length), -Infinity) * .55) return layout;
        let low = 0, high = width, best = layout;
        for (let iteration = 0; iteration < 5; iteration++) {
            const limit = (low + high) / 2, candidate = wrap(layout.fontSize,limit);
            if (candidate.lines.length === layout.lines.length && candidate.lines.every(line=>measure(line,layout.fontSize)<=limit) && fits(candidate)) {high = limit; best = candidate;}
            else low = limit;
        }
        return best;
    };
    return {wrap,fits,balance};
}

/** 准确测量候选整行；普通单框保留先校验、再分词及全部度量调用的原顺序。 */
export function layoutMangaTranslationText(text: string, width: number, height: number,
    measure: (text: string, size: number) => number, maxSize: number,
    measureInk?: (text: string, size: number) => MangaGlyphMetrics | undefined): MangaTextLayout {
    const normalized = text.replace(/\r\n?/gu, '\n').trim();
    if (!normalized || ![width,height,maxSize].every(value => Number.isFinite(value) && value > 0)) return {lines:[],fontSize:0,lineHeight:0};
    const source=parseMangaText(normalized);
    const {wrap,fits,balance}=mangaLayoutFunctions(source,width,height,measure,measureInk);
    const {paragraphs}=source;
    let high = measureInk ? maxSize : Math.min(maxSize,height / 1.2);
    const largest = wrap(high);
    if (fits(largest)) return balance(largest);
    let low = Math.min(1,width / paragraphs.reduce((largest, paragraph) => Math.max(largest, measure(paragraph,1)), 1),height / (paragraphs.length * 1.2)) * .99;
    let best = wrap(low);
    for (let iteration = 0; iteration < 12; iteration++) {
        const candidate = wrap((low + high) / 2);
        if (fits(candidate)) {best = candidate; low = candidate.fontSize;} else high = candidate.fontSize;
    }
    return balance(best);
}

/**
 * 仅用于离屏原生 Canvas 一次同步绘制：同字体/全文的数值度量必须稳定；不承诺任意有状态回调的执行次序。
 * prepare 原序预检最大字号，失败时只返回尺寸；finish 的高低界每次局部新建，不留下失败布局的间接引用。
 * 所有候选共享不可变分词及按原词缓存的字素；没有额外全文或度量缓存，原生异常不捕获、不转换。
 */
export function createMangaTranslationSearch(text:string,measure:(text:string,size:number)=>number,maxSize:number,
    measureInk?:(text:string,size:number)=>MangaGlyphMetrics|undefined) {
    const normalized=text.replace(/\r\n?/gu,'\n').trim();
    const source=normalized&&Number.isFinite(maxSize)&&maxSize>0?parseMangaText(normalized):undefined;
    const empty=():MangaTextLayout=>({lines:[],fontSize:0,lineHeight:0});
    const valid=(candidate:MangaTextSearchCandidate)=>!!source&&[candidate.width,candidate.height].every(value=>Number.isFinite(value)&&value>0);
    return {
        prepare(width:number,height:number):MangaTextSearchCandidate {
            const candidate={width,height};
            if(!valid(candidate))return {...candidate,maximum:empty()};
            const {wrap,fits,balance}=mangaLayoutFunctions(source!,width,height,measure,measureInk);
            const largest=wrap(measureInk?maxSize:Math.min(maxSize,height/1.2));
            return fits(largest)?{...candidate,maximum:balance(largest)}:candidate;
        },
        finish(candidate:MangaTextSearchCandidate,winningSize=-Infinity,allowEqual=true):MangaTextLayout|undefined {
            if(candidate.maximum)return candidate.maximum;
            if(!valid(candidate))return empty();
            const {width,height}=candidate,{paragraphs}=source!;
            const {wrap,fits,balance}=mangaLayoutFunctions(source!,width,height,measure,measureInk);
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
            if(best.fontSize<winningSize||(!allowEqual&&best.fontSize===winningSize))return undefined;
            return balance(best);
        },
    };
}

/**
 * @file src/features/image-translation/services/mangaRegions.ts
 * 文件职责：把漫画专用 OCR 和通用 OCR 行转换成可整段翻译与修补的气泡或旁白区域。
 * 合列输入：通用 OCR 已合并区域继续保留全部物理源框，并按各源列或源行的中位厚度估计字号，后续合段不能丢失这些擦除边界。明确附属的日文注音随正文修补，识别记录另存，避免将读音单独翻译和重复绘字。
 * 主要内容：校验并夹紧坐标，过滤纯符号和源语言不符的短片段，日文已定位气泡内保留高置信短大写拉丁感叹或游戏术语；对中日文及自动源语言清理相邻汉字、假名及中文标点前的多余空格并保留拉丁词界与数字；神经 OCR 保留置信度策略，语言无关地保留高置信多位数字、合法时间日期、货币金额、百分数、小数、分数和温度，只为判定执行 NFKC 而保留原文；仅独立气泡容许高置信度大单字与竖列标点续行间距，同列竖排碎片按水平中心归列；通用 OCR 保留连续合法韩文 Jamo，并从行框补足字号与原始修补框；按方向、字号、重叠与间距合并相邻行，并以确定性两步聚类扫描对组内成员和全页气泡执行严格可传递、排列无关的方向与行带阅读排序；按有界 Unicode 码点边界连接东亚文字，不插入原文没有的空格，保留硬连字符且只移除行末软连字符；仅明确归属的气泡使用较宽横排行距，整页横排行距保持严格、竖列间距上限为字宽的1.8倍，额外续行必须来自同帧像素对空隙与遮挡的有界证明。
 * 模块边界：纯数据算法，不运行模型、不读取 DOM 或配置，也不修补图片；只输出可核对的识别原文和区域，不推测缺失文字。
 */
import type {OcrLine} from '@/src/shared/image/types';
import {endsEastAsianText, startsEastAsianText} from '../textBoundary';
import type {NumericEvidenceOcrLine} from '../core';
import {numericInformation} from './mangaNumeric';
import type {ImageParagraphContinuations,ImageTextRegion} from '../paragraphs';
import {attachImageRuby} from '../ruby';

export interface MangaOcrItem extends Pick<ImageTextRegion,'quarterTurn'|'preserveSource'> {
    text: string;
    confidence: number;
    box: {x: number; y: number; width: number; height: number};
}
export interface MangaRegion extends ImageTextRegion {fontSize: number}

function union(left: OcrLine['bbox'], right: OcrLine['bbox']): OcrLine['bbox'] {
    return {x0: Math.min(left.x0, right.x0), y0: Math.min(left.y0, right.y0),
        x1: Math.max(left.x1, right.x1), y1: Math.max(left.y1, right.y1)};
}

function adjacent(left: MangaRegion, right: MangaRegion, lineGap: number, columnGap: number, verticalInlineGap = 0.8): boolean {
    if (left.vertical !== right.vertical || left.quarterTurn || right.quarterTurn || left.preserveSource || right.preserveSource) return false;
    const a = left.bbox, b = right.bbox;
    const [start, end, crossStart, crossEnd] = left.vertical
        ? ['x0', 'x1', 'y0', 'y1'] as const : ['y0', 'y1', 'x0', 'x1'] as const;
    const thickness = Math.min(left.fontSize, right.fontSize);
    if (Math.max(left.fontSize, right.fontSize) > thickness * 1.8) return false;
    const gap = Math.max(a[start], b[start]) - Math.min(a[end], b[end]);
    const overlap = Math.min(a[crossEnd], b[crossEnd]) - Math.max(a[crossStart], b[crossStart]);
    // 同一基线的分词先由 OCR 合并；这里仅跨行/列合段，避免旁边的气泡被连成一句。
    const centers = Math.abs((a[start] + a[end]) - (b[start] + b[end])) / 2;
    if (centers < thickness * 0.45) {
        return gap <= 0 && -overlap <= thickness * (left.vertical ? verticalInlineGap : 0.8);
    }
    return gap <= thickness * (left.vertical ? columnGap : lineGap)
        && overlap >= Math.min(a[crossEnd] - a[crossStart], b[crossEnd] - b[crossStart]) * 0.5;
}

/** Paddle 的 spaceRecovery 可能在日文假名或汉字之间插入英文式空格；只归一化相邻中日文字符及标点前空格，不碰拉丁词界。 */
function removeIsolatedLowercaseLatinI(sourceText:string):string {
    if(!/^[\x00-\x7f]+$/u.test(sourceText)||!/[A-Z]/u.test(sourceText)||![...sourceText].every(char=>char==='i'||char===char.toUpperCase()))return sourceText;
    const index=sourceText.indexOf('i');if(index<0||sourceText.lastIndexOf('i')!==index)return sourceText;
    const before=sourceText.slice(0,index),after=sourceText.slice(index+1),previous=before.trimEnd().split(/\s+/u).at(-1)!,next=after.trimStart().split(/\s+/u)[0]!;
    if(before.endsWith(' ')&&new Set(['THE','AND','OF','TO','IN','ON','AT','IS','A','AN']).has(previous)&&next.length>=3)return before+after;
    if(!before.endsWith(' ')&&previous.length>=3&&next==='A')return `${before} ${after}`;
    return sourceText;
}
export function normalizeMangaSourceText(sourceText:string, sourceLanguage:string):string {
    if(numericInformation(sourceText))return sourceText;
    const text=removeIsolatedLowercaseLatinI(sourceText.replace(/\s+/gu,' '));
    const cjk=/^(?:ja|jpn|zh|chi|auto)(?:[-_]|$)/iu.test(sourceLanguage)
        ||/[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u.test(text);
    return cjk?text.replace(/([\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]) +(?=[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}。！？、，：；」』】）])/gu,'$1'):text;
}

/** 源语言只用于排除明确不符的绘画噪声；自动检测保留两种书写系统。 */
export function groupMangaText(items: MangaOcrItem[], sourceLanguage: string, width: number, height: number, context: 'page' | 'bubble' = 'page', protectNumeric = false): MangaRegion[] {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return [];
    const english = /^en(?:-|$)/i.test(sourceLanguage);
    const japanese = /^(?:ja|jpn)(?:-|$)/i.test(sourceLanguage);
    const lines: MangaRegion[] = items.flatMap(item => {
        const text=normalizeMangaSourceText(item.text.trim(),sourceLanguage);
        const box = item.box;
        if (!Number.isFinite(item.confidence) || item.confidence < 0.65 || item.confidence > 1 || !text) return [];
        const numericSyntax=numericInformation(text);
        const numeric=item.confidence>=0.9&&numericSyntax;
        if (numericSyntax && !numeric) return [];
        const bubbleLatinTerm = context === 'bubble' && item.confidence >= 0.9 && /^[A-Z]{2,3}[!?….]*$/u.test(text);
        if ((!numeric && (!/\p{L}/u.test(text)
            || (english && (!/[a-z]/iu.test(text) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(text)))
            || (japanese && !item.quarterTurn && !bubbleLatinTerm && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3040-\u30ff\u3400-\u9fff]/u.test(text) && text.replace(/[^a-z]/giu,'').length < 4)))
            || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return [];
        const bbox = {x0: Math.max(0, box.x), y0: Math.max(0, box.y),
            x1: Math.min(width, box.x + box.width), y1: Math.min(height, box.y + box.height)};
        if (bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) return [];
        const vertical = !item.quarterTurn && !english && box.height > box.width * 1.8;
        const fontSize = vertical || item.quarterTurn ? box.width : box.height;
        // 巨大拟声字和纹理中的孤字不作为对白；保留 I/A 等合法英语短句。
        if (!numeric && Array.from(text.replace(/[^\p{L}\p{N}]/gu, '')).length < 2
            && (english ? !/^[IA][.!?]?$/u.test(text) : item.confidence < 0.9 || (context !== 'bubble' && Math.max(box.width, box.height) > width * 0.12))) return [];
        return [{text, bbox, fontSize, ...(vertical ? {vertical: true as const} : {}),
            ...(item.quarterTurn ? {quarterTurn:item.quarterTurn,textAlign:'center' as const} : {}),
            ...(item.preserveSource ? {preserveSource:true as const} : {})}];
    });
    // 只有已有明确归属的独立气泡才允许较宽横排行距与竖列标点续行间距；整页竖列最多放宽至1.8倍字宽，
    // 避免把邻近旁白或不同说话者误并成一句。
    const annotated=attachImageRuby(lines).lines;
    const lineGap = context === 'bubble' ? 1.5 : 0.8;
    const columnGap = context === 'bubble' ? 3.5 : 1.8;
    const verticalInlineGap = context === 'bubble' ? 1.25 : 0.8;
    if (!protectNumeric) return mergeMangaLines(annotated, lineGap, columnGap, verticalInlineGap, sourceLanguage);
    const numeric = lines.filter(line => numericInformation(line.text));
    const others = annotated.filter(line => !numericInformation(line.text));
    return sortMangaRegions([...mergeMangaLines(others, lineGap, columnGap, verticalInlineGap, sourceLanguage),
        ...numeric.map(line => ({...line, sourceBoxes: [line.bbox]}))], sourceLanguage);
}

/** 已规范化的 Tesseract 行不带漫画字号；从原图行框补足修补契约，再合并跨行对白，保留所有原始框。 */
export function groupMangaOcrLines(lines: NumericEvidenceOcrLine[], sourceLanguage: string, width: number, height: number): MangaRegion[] {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return [];
    const language = sourceLanguage.trim().replace(/_/gu, '-').toLowerCase().split('-')[0];
    const regions: MangaRegion[] = lines.flatMap(line => {
        const text=normalizeMangaSourceText(line.text.trim(),language);
        const {x0, y0, x1, y1} = line.bbox;
        const numeric = typeof line.numericConfidence === 'number' && Number.isFinite(line.numericConfidence)
            && line.numericConfidence >= 90 && line.numericConfidence <= 100 && numericInformation(text);
        if (numericInformation(text) && !numeric) return [];
        if (!text || (!numeric && !/\p{L}/u.test(text)) || ![x0, y0, x1, y1].every(Number.isFinite)) return [];
        // 与日文专用模型一致，排除绘画上误识别的短拉丁碎片；合法源语言字和完整英文词仍保留。
        const native = language === 'ru' ? /\p{Script=Cyrillic}/u.test(text)
            : language === 'ko' ? /[\uac00-\ud7a3]|(?:(?![\u115f\u1160\u3164\uffa0])(?=\p{L})\p{Script=Hangul}){2}/u.test(text) : true;
        if (!numeric && !native && text.replace(/[^a-z]/giu, '').length < 4) return [];
        const bbox = {x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(width, x1), y1: Math.min(height, y1)};
        if (bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) return [];
        const sourceBoxes = line.sourceBoxes?.map(box => ({x0: Math.max(0, box.x0), y0: Math.max(0, box.y0),
            x1: Math.min(width, box.x1), y1: Math.min(height, box.y1)}))
            .filter(box => [box.x0,box.y0,box.x1,box.y1].every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0);
        if (sourceBoxes && !sourceBoxes.length) return [];
        const sizes = (sourceBoxes ?? [bbox]).map(box => line.vertical ? box.x1 - box.x0 : box.y1 - box.y0).sort((a,b)=>a-b);
        return [{text, bbox, fontSize: sizes[Math.floor(sizes.length / 2)],
            ...(sourceBoxes ? {sourceBoxes} : {}),
            ...(line.vertical ? {vertical: true as const} : {})}];
    });
    const numeric = regions.filter(line => numericInformation(line.text));
    const others = attachImageRuby(regions).lines.filter(line => !numericInformation(line.text));
    return sortMangaRegions([...mergeMangaLines(others, 0.8, 0.8, 0.8, language),
        ...numeric.map(line => ({...line, sourceBoxes: [line.bbox]}))], language);
}

const LTR_MANGA_LANGUAGES = new Set(['en', 'ko', 'ru', 'fr', 'es', 'de']);
function isLeftToRightManga(sourceLanguage: string, regions: readonly MangaRegion[]): boolean {
    let vertical = 0, total = 0;
    for (const region of regions) {
        if (region.guardOnly) continue;
        total += 1;
        if (region.vertical) vertical += 1;
    }
    if (vertical * 2 > total) return false;
    const language = sourceLanguage.trim().replace(/_/gu, '-').toLowerCase().split('-')[0];
    return LTR_MANGA_LANGUAGES.has(language);
}

function sameHorizontalRowBand(a: MangaRegion, b: MangaRegion): boolean {
    const overlap = Math.min(a.bbox.y1, b.bbox.y1) - Math.max(a.bbox.y0, b.bbox.y0);
    const minHeight = Math.min(a.bbox.y1 - a.bbox.y0, b.bbox.y1 - b.bbox.y0);
    return overlap >= minHeight * 0.5;
}

/** 按源语言与竖排占比执行两步水平行带扫描，确保阅读顺序严格可传递且排列无关。 */
export function sortMangaRegions(regions: MangaRegion[], sourceLanguage = 'auto'): MangaRegion[] {
    const ltr = isLeftToRightManga(sourceLanguage, regions);
    const sorted = [...regions].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    const bands: MangaRegion[][] = [];
    for (const region of sorted) {
        const current = bands[bands.length - 1];
        if (current && current.every(member => sameHorizontalRowBand(member, region))) {
            current.push(region);
        } else {
            bands.push([region]);
        }
    }
    const ordered = bands.flatMap(band => band.sort((a, b) => ltr
        ? (a.bbox.x0 - b.bbox.x0 || a.bbox.y0 - b.bbox.y0)
        : ((b.bbox.x0 + b.bbox.x1) - (a.bbox.x0 + a.bbox.x1) || a.bbox.y0 - b.bbox.y0)));
    regions.splice(0, regions.length, ...ordered);
    return regions;
}

/** 组内行/列按主轴严格全序聚类后再按副轴排序，避免漂移段落触发非传递比较环。 */
function sortMangaGroupMembers(members: MangaRegion[]): MangaRegion[] {
    const vertical = Boolean(members[0].vertical);
    const primary = (region: MangaRegion) => vertical ? -(region.bbox.x0 + region.bbox.x1) / 2 : region.bbox.y0;
    const secondary = (region: MangaRegion) => vertical ? region.bbox.y0 : region.bbox.x0;
    const sorted = [...members].sort((a, b) => primary(a) - primary(b) || secondary(a) - secondary(b));
    const clusters: Array<{anchor: number; fontSize: number; items: MangaRegion[]}> = [];
    for (const member of sorted) {
        const current = clusters[clusters.length - 1];
        const position = primary(member);
        if (current && Math.abs(position - current.anchor) < Math.min(current.fontSize, member.fontSize) * 0.45) {
            current.items.push(member);
        } else {
            clusters.push({anchor: position, fontSize: member.fontSize, items: [member]});
        }
    }
    return clusters.flatMap(cluster => cluster.items.sort((a, b) => secondary(a) - secondary(b) || primary(a) - primary(b)));
}

function mergeMangaLines(lines: MangaRegion[], lineGap = 0.8, columnGap = 0.8, verticalInlineGap = 0.8, sourceLanguage = 'auto'): MangaRegion[] {
    const groups: MangaRegion[][] = [];
    const remaining = new Set(lines);
    for (const first of lines) {
        if (!remaining.delete(first)) continue;
        const members = [first];
        for (let cursor = 0; cursor < members.length; cursor += 1) {
            for (const next of remaining) if (adjacent(members[cursor], next, lineGap, columnGap, verticalInlineGap)) {
                remaining.delete(next); members.push(next);
            }
        }
        groups.push(members);
    }
    return sortMangaRegions(groups.map(members => {
        const first=members[0];
        if(first.quarterTurn||first.preserveSource)return {...first,sourceBoxes:[first.bbox]};
        const orderedMembers = sortMangaGroupMembers(members);
        const sizes = orderedMembers.map(member => member.fontSize).sort((a, b) => a - b);
        const text=orderedMembers.reduce((text, member) => {
            if (text.endsWith('\u00ad')) return text.slice(0,-1) + member.text;
            const endsCjk = endsEastAsianText(text), startsCjk = startsEastAsianText(member.text);
            const hyphen = /\p{L}-$/u.test(text) && /^\p{L}/u.test(member.text);
            const separator = !text || orderedMembers[0].vertical || hyphen || ((endsCjk || /[。！？、」』】）]$/u.test(text)) && startsCjk) ? '' : ' ';
            return text + separator + member.text;
        }, '');
        return {text,
            bbox: orderedMembers.map(member => member.bbox).reduce(union), fontSize: sizes[Math.floor(sizes.length / 2)],
            sourceBoxes: orderedMembers.flatMap(member => (member.sourceBoxes ?? [member.bbox]).map(box => ({...box}))),
            ...(orderedMembers.some(member=>member.ruby)?{ruby:orderedMembers.flatMap(member=>member.ruby??[])}:{}),
            ...(orderedMembers[0].vertical ? {vertical: true as const} : {})};
    }), sourceLanguage);
}

/** 仅消费同帧像素已证明的横排后继；无证明时页面仍沿用严格行距。 */
export function mergeMangaParagraphContinuations(lines:MangaRegion[],continuations?:ImageParagraphContinuations,sourceLanguage='auto'):MangaRegion[]{
    if(!continuations||!lines.length)return lines;
    const ordered=sortMangaRegions([...lines],sourceLanguage),available=new Set(ordered),used=new Set<MangaRegion>(),result:MangaRegion[]=[];
    for(const first of ordered){
        if(used.has(first))continue;
        const members=[first];let bounds=first.bbox;
        if(!first.vertical&&!first.guardOnly&&!numericInformation(first.text)&&!first.sourceBoxes){
            for(let count=0;count<ordered.length;count++){
                const previous=members[members.length-1],next=continuations.successor(previous) as MangaRegion|undefined;
                if(!next||!available.has(next)||used.has(next)||next.vertical||next.guardOnly||numericInformation(next.text)||next.sourceBoxes)break;
                const candidate=union(bounds,next.bbox);
                if(!continuations.permits(previous,next,members,candidate))break;
                members.push(next);bounds=candidate;
            }
        }
        const grouped=members.length>1?mergeMangaLines(members,3.5,0.8,0.8,sourceLanguage):members;
        for(const member of members)used.add(member);
        result.push(...grouped);
    }
    return sortMangaRegions(result,sourceLanguage);
}

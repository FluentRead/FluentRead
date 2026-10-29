/**
 * @file src/features/image-translation/core.ts
 * 文件职责：提供图片翻译可复用的纯数据算法，用于选择真正发生变化的译文、确定 OCR 语言组合并清理 OCR 行数据。
 * 主要内容：相同译文保留原文且不重复展示；从 shared/image 复用 OcrLine 类型，筛选有效译文、规划图片与圈选各自的有界 OCR 尺寸及边框，映回原图坐标，按完整 Unicode 码点连接词组、规范化标点和置信度，按基线方向区分横竖排并合并同一气泡的竖列，数字保护视图保留独立数值边界，路径压缩与原地分组避免竖列候选的反复数组复制，避免噪声进入翻译与绘制。
 * 模块边界：该模块不接触 Canvas、Tesseract、网络或浏览器消息；OCR 执行归 ocrRuntime，像素修补与文本绘制归 services，页面展示归 content/runtime。
 */
import {hasDistinctTranslation} from '@/src/core/translation/result';
import { getRequiredImageOcrLanguages, type ImageOcrLanguageCode } from './ocrLanguages';
import type {OcrLine} from '@/src/shared/image/types';
import {numericEvidenceKey,numericInformation,numericProtection} from './services/mangaNumeric';

export type { OcrLine } from '@/src/shared/image/types';

function normalizeTranslationComparison(text: string): string {
    return text
        .toLocaleLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 只保留实际发生变化的 OCR 行。
 * 这样中文原文、品牌名或微软原样返回的内容不会被重新绘制成一张
 * 看似“已翻译”但实际没有变化的覆盖层。
 */
export function selectChangedTranslations<T extends OcrLine>(lines: T[], translations: string[]): T[] {
    return lines.flatMap((line, index) => {
        const text = translations[index]?.trim() || line.text;
        return !hasDistinctTranslation(line.text, text) || normalizeTranslationComparison(text) === normalizeTranslationComparison(line.text)
            ? []
            : [{ ...line, text }];
    });
}

/** 限制识别内存和耗时；只缩小超大图片，不插值放大小字或更改最终图片分辨率。 */
export function getOcrImageSize(width: number, height: number): {width: number; height: number} {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('图片尺寸无效');
    }
    const ratio = Math.min(1, 4096 / Math.max(width, height), Math.sqrt(6_000_000 / width / height));
    return {width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio))};
}

/**
 * 圈选的紧贴文字小图最多放大两倍，并预留 10px 白边供分割识别。
 * 白边计入最长边和像素预算；普通图片继续使用既有的只降采样策略。
 * 这些是有界输入策略，不代表任何语言或图片的准确率保证。
 */
export function getAreaOcrImageSize(width: number, height: number): {width: number; height: number; padding: number} {
    getOcrImageSize(width, height);
    const scale = width <= 1000 && height <= 500 ? 2 : 1;
    const ratio = Math.min(scale, 4076 / Math.max(width, height), Math.sqrt(5_800_000 / width / height));
    return {
        width: Math.max(1, Math.floor(width * ratio)),
        height: Math.max(1, Math.floor(height * ratio)),
        padding: 10,
    };
}

/** 将降采样后的识别框映回原始像素，夹紧边界，避免擦除与文字替换偏移。 */
export function restoreOcrLineCoordinates(
    lines: OcrLine[],
    sourceWidth: number,
    sourceHeight: number,
    ocrWidth: number,
    ocrHeight: number,
    padding = 0,
): OcrLine[] {
    return lines.flatMap(line => {
        const bbox = {
            x0: Math.max(0, Math.floor((line.bbox.x0 - padding) * sourceWidth / ocrWidth)),
            y0: Math.max(0, Math.floor((line.bbox.y0 - padding) * sourceHeight / ocrHeight)),
            x1: Math.min(sourceWidth, Math.ceil((line.bbox.x1 - padding) * sourceWidth / ocrWidth)),
            y1: Math.min(sourceHeight, Math.ceil((line.bbox.y1 - padding) * sourceHeight / ocrHeight)),
        };
        return isValidOcrBox(bbox) ? [{...line, bbox}] : [];
    });
}

function isValidOcrBox(bbox: OcrLine['bbox']): boolean {
    return [bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)
        && bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0;
}

function ocrBoxIou(a:OcrBox,b:OcrBox):number {
    const intersection=Math.max(0,getAxisOverlap(a,b,X_AXIS))*Math.max(0,getAxisOverlap(a,b,Y_AXIS));
    const area=(box:OcrBox)=>getAxisSize(box,X_AXIS)*getAxisSize(box,Y_AXIS);
    return intersection/(area(a)+area(b)-intersection);
}

export type NumericEvidenceOcrLine = OcrLine & {numericConfidence?: number; guardOnly?: true; numericGuardText?: string; numericGuardConflict?: true};

type OcrBox = OcrLine['bbox'];
type OcrAxis = {start: 'x0' | 'y0'; end: 'x1' | 'y1'};
const X_AXIS: OcrAxis = {start: 'x0', end: 'x1'};
const Y_AXIS: OcrAxis = {start: 'y0', end: 'y1'};

function getAxisSize(bbox: OcrBox, axis: OcrAxis): number {
    return bbox[axis.end] - bbox[axis.start];
}

/** 两个框在某一轴上的重叠长度；为负时表示间距。 */
function getAxisOverlap(left: OcrBox, right: OcrBox, axis: OcrAxis): number {
    return Math.min(left[axis.end], right[axis.end]) - Math.max(left[axis.start], right[axis.start]);
}

/** Tesseract 的基线沿书写方向延伸：横排近乎水平，竖排模型识别出的列近乎垂直。 */
function isVerticalOcrLine(baseline: OcrBox | null | undefined): boolean {
    if (!baseline || ![baseline.x0, baseline.y0, baseline.x1, baseline.y1].every(Number.isFinite)) return false;
    return Math.abs(baseline.y1 - baseline.y0) > Math.abs(baseline.x1 - baseline.x0) * 2;
}

function unionOcrBoxes(boxes: OcrBox[]): OcrBox {
    return boxes.reduce((result, bbox) => ({
        x0: Math.min(result.x0, bbox.x0),
        y0: Math.min(result.y0, bbox.y0),
        x1: Math.max(result.x1, bbox.x1),
        y1: Math.max(result.y1, bbox.y1),
    }), {...boxes[0]});
}

/** 同列片段横向重叠且上下相距不超过一个半字宽；相邻列相距不超过一个列宽且纵向有实质重叠。 */
function areAdjacentVerticalColumns(left: OcrBox, right: OcrBox): boolean {
    const thickness = Math.max(getAxisSize(left, X_AXIS), getAxisSize(right, X_AXIS));
    const horizontalOverlap = getAxisOverlap(left, right, X_AXIS);
    const verticalOverlap = getAxisOverlap(left, right, Y_AXIS);
    if (horizontalOverlap >= Math.min(getAxisSize(left, X_AXIS), getAxisSize(right, X_AXIS)) * 0.35) {
        return -verticalOverlap <= thickness * 1.5;
    }
    return -horizontalOverlap <= thickness
        && verticalOverlap >= Math.min(getAxisSize(left, Y_AXIS), getAxisSize(right, Y_AXIS)) * 0.3;
}

function joinVerticalColumns(members: OcrLine[]): OcrLine {
    const columns: OcrLine[][] = [];
    // 从右到左建列：中心更靠右的片段先成列，横向重叠的后续片段并入同一列。
    [...members].sort((left, right) => (right.bbox.x0 + right.bbox.x1) - (left.bbox.x0 + left.bbox.x1)).forEach(member => {
        const column = columns.find(candidate => candidate.some(part => getAxisOverlap(part.bbox, member.bbox, X_AXIS)
            >= Math.min(getAxisSize(part.bbox, X_AXIS), getAxisSize(member.bbox, X_AXIS)) * 0.35));
        if (column) column.push(member);
        else columns.push([member]);
    });
    const ordered = columns.flatMap(column => column.sort((left, right) => left.bbox.y0 - right.bbox.y0));
    return {
        text: ordered.map(line => line.text).reduce(joinOcrWords, ''),
        bbox: unionOcrBoxes(ordered.map(line => line.bbox)),
        vertical: true,
    };
}

/**
 * 漫画气泡的一句话常跨多列；逐列翻译会拆散语义，逐列绘制也只有一个字宽。
 * 相邻竖列与同列片段合成一个区域，放在其首个成员原来的位置，横排行保持原样和顺序。
 */
function mergeVerticalOcrColumns(lines: NumericEvidenceOcrLine[], protectNumeric = false): NumericEvidenceOcrLine[] {
    const vertical = lines.flatMap((line, index) => line.vertical ? [index] : []);
    if (vertical.length < 2) return lines;
    const parent = new Map(vertical.map(index => [index, index]));
    const find = (index: number): number => {
        let root = index;
        while (parent.get(root) !== root) root = parent.get(root)!;
        while (index !== root) {
            const next = parent.get(index)!;
            parent.set(index, root);
            index = next;
        }
        return root;
    };
    vertical.forEach((left, position) => {
        for (let next = position + 1; next < vertical.length; next++) {
            const right = vertical[next];
            if (!areAdjacentVerticalColumns(lines[left].bbox, lines[right].bbox)) continue;
            // 漫画视图不能让可靠独立数字与旁边对白先合列，否则之后无法保护其原框。
            const numeric = (line: NumericEvidenceOcrLine) => numericProtection(line.text);
            if (protectNumeric && (numeric(lines[left]) || numeric(lines[right]))) continue;
            const leftRoot = find(left);
            const rightRoot = find(right);
            if (leftRoot !== rightRoot) parent.set(Math.max(leftRoot, rightRoot), Math.min(leftRoot, rightRoot));
        }
    });
    const groups = new Map<number, OcrLine[]>();
    vertical.forEach(index => {
        const root = find(index);
        const group = groups.get(root);
        if (group) group.push(lines[index]);
        else groups.set(root, [lines[index]]);
    });
    return lines.flatMap((line, index) => {
        if (!line.vertical) return [line];
        const group = groups.get(index);
        if (!group) return [];
        return [group.length === 1 ? line : joinVerticalColumns(group)];
    });
}

function joinOcrWords(previous: string, next: string): string {
    if (!previous) return next;
    const joinsCjk = /[\p{Script=Han}\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]$/u.test(previous)
        || /^[\p{Script=Han}\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(next);
    const joinsPunctuation = /^[,.;:!?%\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b)\]}’”]/u.test(next)
        || /[([{\u2018\u201c]$/u.test(previous);
    return joinsCjk || joinsPunctuation ? `${previous}${next}` : `${previous} ${next}`;
}

export function getOcrLanguages(sourceLanguage: string): ImageOcrLanguageCode[] {
    return getRequiredImageOcrLanguages(sourceLanguage);
}

type OcrBlocks = Array<{
        paragraphs?: Array<{
            lines?: Array<{
                text: string;
                confidence?: number;
                bbox: OcrLine['bbox'];
                baseline?: OcrLine['bbox'] | null;
                words?: Array<{ text: string; confidence?: number; bbox: OcrLine['bbox'] }>;
            }>;
        }>;
    }> | null | undefined;

/**
 * 在过滤词之前保留不可信数字的物理框；只作防擦证据，不提供阅读文本。
 * trustedWorkerData 仅供 Tesseract Worker 的结构化克隆结果使用；未知输入保留原始顺序与异常。
 */
export function collectRawNumericGuards(blocks: OcrBlocks, recognized:readonly NumericEvidenceOcrLine[]=[],
    options?:{trustedWorkerData?:boolean}): NumericEvidenceOcrLine[] {
    const guards:NumericEvidenceOcrLine[]=[],keys=new Map<string,NumericEvidenceOcrLine>();let comparisons=0;
    let byText:Map<string,NumericEvidenceOcrLine[]>|undefined;
    let exact:Map<string,NumericEvidenceOcrLine>|undefined;
    let unstable:Set<string>|undefined;
    const stableKey=(text:string,box:OcrLine['bbox'])=>{
        try {
            const coordinates=['x0','y0','x1','y1'].map(key=>Object.getOwnPropertyDescriptor(box,key));
            if(coordinates.some(value=>!value||!('value' in value)||!Number.isFinite(value.value)))return;
            return JSON.stringify([text,...coordinates.map(value=>value!.value)]);
        } catch {return;}
    };
    const add=(raw:string,bbox:OcrLine['bbox'], evidence=raw)=>{
        const text=raw.replace(/\s+/gu,' ').trim();
        const evidenceText=evidence.replace(/\s+/gu,' ').trim();
        if (!numericProtection(text)) return;
        if (!bbox || !isValidOcrBox(bbox)) throw new Error('图片数字保护位置无效，已保留原图');
        // 只有可信完整行的实际返回框覆盖原始框时才能省略保护；词丢失、拆分或框缩小均保留原框。
        if(!byText){
            byText=new Map();exact=new Map();unstable=new Set();
            for(const candidate of recognized){
                const confidence=candidate.numericConfidence;
                if(typeof confidence!=='number'||!Number.isFinite(confidence)||confidence<90||confidence>100)continue;
                const candidateText=numericEvidenceKey(candidate.text);
                if(!numericInformation(candidateText))continue;
                const matches=byText.get(candidateText)??[];matches.push(candidate);byText.set(candidateText,matches);
                if(options?.trustedWorkerData){
                    try {
                        const bbox=Object.getOwnPropertyDescriptor(candidate,'bbox');
                        const key=bbox&&'value' in bbox&&bbox.value?stableKey(candidateText,bbox.value):undefined;
                        if(key)exact.set(key,candidate);else unstable.add(candidateText);
                    } catch {unstable.add(candidateText);}
                }
            }
        }
        let represented=false;
        // 同文候选只要有未知坐标，必须按原顺序访问，不能跳过更早的异常或副作用。
        const comparisonText=numericEvidenceKey(text);
        const exactKey=options?.trustedWorkerData?stableKey(comparisonText,bbox):undefined;
        const exactCandidate=exactKey&&!unstable!.has(comparisonText)&&exact!.get(exactKey);
        if(exactCandidate){
            const b=exactCandidate.bbox;
            represented=b.x0<=bbox.x0&&b.y0<=bbox.y0&&b.x1>=bbox.x1&&b.y1>=bbox.y1;
        }
        for(const candidate of represented?[]:byText.get(comparisonText)??[]){
            if(++comparisons>1_000_000)throw new Error('图片数字保护区域过于复杂，已保留原图');
            const b=candidate.bbox;
            if(b.x0<=bbox.x0&&b.y0<=bbox.y0&&b.x1>=bbox.x1&&b.y1>=bbox.y1){represented=true;break;}
        }
        if(represented)return;
        const key=[bbox.x0,bbox.y0,bbox.x1,bbox.y1].join(',');const previous=keys.get(key);
        if(previous){if(numericEvidenceKey(previous.numericGuardText!)!==numericEvidenceKey(evidenceText))previous.numericGuardConflict=true;return;}
        if (guards.length>=4096) throw new Error('图片数字保护区域过于复杂，已保留原图');
        const guard:NumericEvidenceOcrLine={text:'',bbox:{...bbox},guardOnly:true,numericGuardText:evidenceText};
        keys.set(key,guard);guards.push(guard);
    };
    const sourceObservations=new Map<string,{incompatibleWordBox:boolean;noWords:boolean}>();
    for (const block of blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) {
        const lineText=line.text,lineBox=line.bbox;
        add(lineText,lineBox);
        const numericLine=numericProtection(lineText.replace(/\s+/gu,' ').trim());
        const compactLineText=numericLine?lineText.replace(/\s+/gu,''):'';
        let coverageBox=lineBox;const wordBoxes:OcrBox[]=[];
        for(const word of line.words??[]) {
            const text=word.text,bbox=word.bbox;
            const partOfNumericLine=numericLine && compactLineText.includes(text.replace(/\s+/gu,''));
            add(text,bbox,partOfNumericLine?lineText:text);
            // 保持原行、词的读取顺序；整行数值的非法标点框同样无法安全修补。圈选不调用此阶段。
            if (numericLine) {
                if (!bbox||!isValidOcrBox(bbox) || bbox.x0<lineBox.x0-2 || bbox.y0<lineBox.y0-2
                    || bbox.x1>lineBox.x1+2 || bbox.y1>lineBox.y1+2) throw new Error('图片数字保护位置无效，已保留原图');
                wordBoxes.push(bbox);coverageBox=unionOcrBoxes([coverageBox,bbox]);
            }
        }
        if (numericLine) {
            const wordBox=wordBoxes.length?unionOcrBoxes(wordBoxes):undefined;
            if (wordBox && getAxisSize(lineBox,X_AXIS)*getAxisSize(lineBox,Y_AXIS)>4*getAxisSize(wordBox,X_AXIS)*getAxisSize(wordBox,Y_AXIS))
                throw new Error('图片数字保护位置无效，已保留原图');
            const key=[lineText.trim(),lineBox.x0,lineBox.y0,lineBox.x1,lineBox.y1].join('\0'),previous=sourceObservations.get(key);
            const noWords=!wordBox||previous?.noWords===true;
            const incompatibleWordBox=previous?.incompatibleWordBox===true || Boolean(wordBox && ocrBoxIou(lineBox,wordBox)<.9);
            if (noWords && incompatibleWordBox) throw new Error('图片数字保护位置无效，已保留原图');
            sourceObservations.set(key,{noWords,incompatibleWordBox});
            if (coverageBox.x0!==lineBox.x0||coverageBox.y0!==lineBox.y0||coverageBox.x1!==lineBox.x1||coverageBox.y1!==lineBox.y1)
                add(lineText,coverageBox);
        }
    }
    return guards;
}

/** 将原始识别结果清洗和拆行；结果用于各视图独立去重，不改变输入。 */
type ParsedOcrLine = NumericEvidenceOcrLine & {rawNumericText?: string; numericSourceBox?: OcrBox; numericRawConflict?: true; suppressNumericResidual?: true; hiddenNumericEvidence?: true};
function parseOcrLines(blocks: OcrBlocks, includeNumericEvidence: boolean, fast?:{noNumeric:boolean}): ParsedOcrLine[] {
    if (!blocks) return [];

    const normalized: ParsedOcrLine[] = [];
    const validConfidence = (value: number | undefined): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
    blocks.flatMap(block => block.paragraphs || []).flatMap(paragraph => paragraph.lines || []).forEach(line => {
        // 竖排行沿 y 轴书写：词按 y0 排序，并以列宽判断同列与间距；横排保持原有 x 轴规则。
        const vertical = isVerticalOcrLine(line.baseline);
        const [main, cross] = vertical ? [Y_AXIS, X_AXIS] : [X_AXIS, Y_AXIS];
        const orientation = vertical ? {vertical: true as const} : {};
        const rawWords = (line.words || []).map(word => {
            const text=word.text.replace(/[\s\u3000]+/g, ' ').trim();
            if(fast&&/\p{N}/u.test(text))fast.noNumeric=false;
            return {text,confidence:word.confidence??100,explicitConfidence:word.confidence,bbox:word.bbox};
        });
        const words = rawWords.filter(word => word.text.length > 0 && Number.isFinite(word.confidence) && word.confidence >= 25
                && isValidOcrBox(word.bbox))
            .sort((left, right) => left.bbox[main.start] - right.bbox[main.start]);

        const recordRawNumericEvidence=(startIndex:number,rawText:string,rawLine:string)=>{
            if (includeNumericEvidence && numericInformation(rawText) && line.bbox && isValidOcrBox(line.bbox)
                && rawWords.every(word=>word.text && word.bbox && isValidOcrBox(word.bbox)
                    && word.bbox.x0>=line.bbox.x0-2 && word.bbox.y0>=line.bbox.y0-2
                    && word.bbox.x1<=line.bbox.x1+2 && word.bbox.y1<=line.bbox.y1+2)) {
                const fullWords=[...rawWords].sort((a,b)=>a.bbox[main.start]-b.bbox[main.start]);
                const oneLine=fullWords.every((word,index)=>{
                    if(index===0)return true;
                    const previous=fullWords[index-1],thickness=Math.min(getAxisSize(previous.bbox,cross),getAxisSize(word.bbox,cross));
                    return getAxisOverlap(previous.bbox,word.bbox,cross)>=thickness*.35
                        && word.bbox[main.start]-previous.bbox[main.end]<=Math.max(6,getAxisSize(previous.bbox,cross)*4);
                });
                if (oneLine && rawLine===fullWords.map(word=>word.text).join('').replace(/\s/gu,'')) {
                    if (normalized.length===startIndex+1 && words.length===rawWords.length) {normalized[startIndex].rawNumericText=rawText;normalized[startIndex].numericSourceBox=line.bbox;}
                    else {
                        // 不可信缺词仅作为同框去重证据；真实残片只在可证明来自该纯数值行时移除。
                        for(let index=startIndex;index<normalized.length;index++)normalized[index].suppressNumericResidual=true;
                        const text=fullWords.map(word=>word.text).reduce(joinOcrWords,'');
                        normalized.push({text,bbox:unionOcrBoxes(fullWords.map(word=>word.bbox)),...orientation,rawNumericText:rawText,numericSourceBox:line.bbox,hiddenNumericEvidence:true});
                    }
                }
            }
        };

        if (words.length === 0) {
            // 回退行可能直接持有调用方 bbox；避免快路径改变未知 getter 的读取次数。
            if(fast)fast.noNumeric=false;
            // 有 word 数据却全部被过滤时，整行文本来自同一批噪声，不能再次回退复活。
            if (line.words?.length) {
                if (includeNumericEvidence && rawWords.some(word=>/\p{N}/u.test(word.text))) {
                    const rawText=line.text.trim();recordRawNumericEvidence(normalized.length,rawText,rawText.replace(/\s/gu,''));
                }
                return;
            }
            const sourceText=line.text;
            const text = sourceText.replace(/[\s\u3000]+/g, ' ').trim();
            const confidence = line.confidence ?? 100;
            const numeric=includeNumericEvidence && numericInformation(text);
            if (text && (Number.isFinite(confidence) && confidence >= 25 || numeric) && isValidOcrBox(line.bbox)) {
                if (Number.isFinite(confidence) && confidence >= 25) normalized.push({ text, bbox: line.bbox, ...orientation,
                    ...(includeNumericEvidence && validConfidence(line.confidence) ? {numericConfidence: line.confidence} : {}),
                    ...(numeric ? {rawNumericText:sourceText.trim(),numericSourceBox:line.bbox} : {}) });
                else if (numeric) normalized.push({text,bbox:line.bbox,...orientation,rawNumericText:sourceText.trim(),numericSourceBox:line.bbox,hiddenNumericEvidence:true});
            }
            return;
        }

        let current = [words[0]];
        const startIndex = normalized.length;
        const flush = () => {
            const bbox = unionOcrBoxes(current.map(word => word.bbox));
            const text = current.map(word => word.text).reduce(joinOcrWords, '');
            if (text) normalized.push({ text, bbox, ...orientation });
        };

        for (let index = 1; index < words.length; index += 1) {
            const previous = current[current.length - 1];
            const next = words[index];
            const previousThickness = getAxisSize(previous.bbox, cross);
            const crossOverlap = getAxisOverlap(previous.bbox, next.bbox, cross);
            const gap = next.bbox[main.start] - previous.bbox[main.end];
            const sameLine = crossOverlap >= Math.min(previousThickness, getAxisSize(next.bbox, cross)) * 0.35;
            // 英文单词间距可能接近一个字高；同一 OCR 行内合并，跨控件的大间距仍保持分开。
            if (sameLine && gap <= Math.max(6, previousThickness * 4)) {
                current.push(next);
            } else {
                flush();
                current = [next];
            }
        }
        flush();
        // 只有整个原行完整、未拆分且每个词均有可信显式分数时才保存证据。
        const rawText = line.text.trim();
        const rawLine = rawText.replace(/\s/gu, '');
        if(fast&&/\p{N}/u.test(rawLine))fast.noNumeric=false;
        const joinedWords = words.map(word => word.text).join('').replace(/\s/gu, '');
        if (includeNumericEvidence && normalized.length === startIndex + 1 && words.length === line.words?.length
            && rawLine === joinedWords && words.every(word => validConfidence(word.explicitConfidence))
            && (line.confidence === undefined || validConfidence(line.confidence))) {
            const scores = words.map(word => word.explicitConfidence as number);
            if (line.confidence !== undefined) scores.push(line.confidence);
            normalized[startIndex].numericConfidence = scores.reduce((minimum, score) => Math.min(minimum, score), 100);
        }
        recordRawNumericEvidence(startIndex,rawText,rawLine);
    });
    return normalized;
}

/** 独立处理每个视图的重复框与竖排合列，避免漫画保护信息影响普通图片。 */
function finalizeOcrLines(normalized: ParsedOcrLine[], includeNumericEvidence: boolean): NumericEvidenceOcrLine[] {
    // 相同文字且几乎完全重叠才视为重复检测；不同位置的按钮、数字和重复行必须保留。
    const seen = new Map<string, ParsedOcrLine[]>();
    // 完全同一原框出现不同原值时不能猜测；两者都只作为防擦证据。
    if (includeNumericEvidence) {
        const byNormalizedBox=new Map<string,{hasRaw:boolean;lines:ParsedOcrLine[];conflict:boolean}>();
        for(const line of normalized) {
            if(line.suppressNumericResidual)continue;
            const b=line.bbox,key=`${line.vertical?'v':'h'}\0${line.text}\0${[b.x0,b.y0,b.x1,b.y1].join(',')}`;
            const hasRaw=line.rawNumericText!==undefined,group=byNormalizedBox.get(key);
            if(!group){byNormalizedBox.set(key,{hasRaw,lines:[line],conflict:false});continue;}
            if(!group.conflict && group.hasRaw!==hasRaw){group.conflict=true;for(const other of group.lines)other.numericRawConflict=true;}
            if(group.conflict)line.numericRawConflict=true;
            group.lines.push(line);
        }
        const byBox=new Map<string,{first:string;lines:ParsedOcrLine[];conflict:boolean}>();
        for(const line of normalized) {
            if (!line.rawNumericText || !line.numericSourceBox || line.suppressNumericResidual) continue;
            const b=line.numericSourceBox,p=line.bbox,key=[b.x0,b.y0,b.x1,b.y1,p.x0,p.y0,p.x1,p.y1].join(','),group=byBox.get(key);
            if (!group) {byBox.set(key,{first:numericEvidenceKey(line.rawNumericText),lines:[line],conflict:false});continue;}
            if (!group.conflict && group.first!==numericEvidenceKey(line.rawNumericText)) {
                group.conflict=true;for(const other of group.lines)other.numericRawConflict=true;
            }
            if(group.conflict)line.numericRawConflict=true;
            group.lines.push(line);
        }
    }
    const unique = normalized.filter(line => {
        if (line.suppressNumericResidual) return false;
        const key = `${line.vertical ? 'vertical' : 'horizontal'}\0${line.rawNumericText !== undefined ? numericEvidenceKey(line.rawNumericText) : line.text}`;
        const candidates = seen.get(key) ?? [];
        const duplicate = candidates.find(previous => {
            const a=previous.rawNumericText && line.rawNumericText ? previous.numericSourceBox! : previous.bbox;
            const b=previous.rawNumericText && line.rawNumericText ? line.numericSourceBox! : line.bbox;
            return ocrBoxIou(a,b) >= 0.9 && ocrBoxIou(previous.bbox,line.bbox) >= 0.9;
        });
        if (!duplicate) {candidates.push(line); seen.set(key, candidates);}
        else {
            if (line.hiddenNumericEvidence) duplicate.hiddenNumericEvidence=true;
            if (line.numericRawConflict) duplicate.numericRawConflict=true;
            if (includeNumericEvidence && (duplicate.rawNumericText !== undefined || line.rawNumericText !== undefined)
                && (duplicate.rawNumericText === undefined || line.rawNumericText === undefined || numericEvidenceKey(duplicate.rawNumericText) !== numericEvidenceKey(line.rawNumericText))) duplicate.numericRawConflict=true;
            if (duplicate.numericConfidence === undefined || line.numericConfidence === undefined) delete duplicate.numericConfidence;
            else if (includeNumericEvidence && duplicate.numericConfidence >= 90 && line.numericConfidence >= 90 && numericInformation(line.text)) {
                duplicate.bbox = unionOcrBoxes([duplicate.bbox, line.bbox]);
                duplicate.numericConfidence = Math.min(duplicate.numericConfidence, line.numericConfidence);
            }
            else duplicate.numericConfidence = Math.min(duplicate.numericConfidence, line.numericConfidence);
        }
        return !duplicate;
    });
    return mergeVerticalOcrColumns(includeNumericEvidence ? restoreNumericRawText(unique) : unique, includeNumericEvidence);
}

function restoreNumericRawText(lines:ParsedOcrLine[]):NumericEvidenceOcrLine[] {
    let write=0;
    for (const line of lines) {
        const raw=line.rawNumericText, conflict=line.numericRawConflict, hidden=line.hiddenNumericEvidence;
        delete line.rawNumericText;delete line.numericSourceBox;delete line.numericRawConflict;delete line.hiddenNumericEvidence;
        if (hidden) continue;
        if (conflict) {delete line.numericConfidence;if (!numericProtection(line.text)) continue;}
        else if (raw !== undefined) {
            if ((line.numericConfidence ?? -1) >= 90) line.text=raw;
            else if (!numericProtection(line.text)) continue;
        }
        lines[write++]=line;
    }
    lines.length=write;
    return lines;
}

export function normalizeOcrLines(blocks: OcrBlocks, includeNumericEvidence = false): NumericEvidenceOcrLine[] {
    return finalizeOcrLines(parseOcrLines(blocks, includeNumericEvidence), includeNumericEvidence);
}

/** 共享文本解析；每个视图独立去重和合列，坐标回映仍由调用方在合列之后执行。 */
export function normalizeOcrLineViews(blocks: OcrBlocks): {ordinary: OcrLine[]; manga: NumericEvidenceOcrLine[]} {
    const fast={noNumeric:true};
    const parsed = parseOcrLines(blocks, true,fast);
    if(fast.noNumeric&&parsed.every(line=>!line.guardOnly)){
        const manga=finalizeOcrLines(parsed,true);
        // 非数字时两视图的合列和去重完全相同；逐行/框复制仍保证缓存调用者互不污染。
        const ordinary=manga.map(({numericConfidence:_confidence,...line})=>({...line,bbox:{...line.bbox}}));
        return {ordinary,manga};
    }
    // finalize 可能删除置信字段或替换框，因此普通视图必须拥有独立行对象。
    const ordinary = parsed.filter(line=>!line.hiddenNumericEvidence).map(line => ({text: line.text, bbox: {...line.bbox}, ...(line.vertical ? {vertical: true as const} : {})}));
    return {ordinary: finalizeOcrLines(ordinary, false), manga: finalizeOcrLines(parsed, true)};
}

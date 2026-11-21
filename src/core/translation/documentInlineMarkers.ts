/**
 * @file src/core/translation/documentInlineMarkers.ts
 * 文件职责：保留文档整句翻译的编号行内标签，让标签中的文字正常参与翻译。
 * 主要内容：共享实体、全角和空白写法归一，逐槽检查每个编号的次数、配对、自闭合和嵌套父子关系；文档候选必须保留源节点的可见正文占用数量，空白/不可见正文不能胜出，允许兄弟节点随译句重排及自闭合写成空对；一次汇总编号出现次数，在实际目标语言下拒绝唯一平级节点的普通正文原样返回，显式术语只豁免原文回显。
 * 模块边界：纯文本协议，不读取配置或调用服务；只由文档入口启用，不评价一般语义质量，也无法识别两个结构相同槽的正文被交换。
 */
import {isLikelyUntranslatedInlineResponse} from './resultValidation';

export interface DocumentInlineValidationContext {
    /** 导出仅校验标记和词槽可见性；翻译请求凭真实目标语进一步核对原文回显。 */
    targetLanguage?: string;
    protectedTokens?: readonly string[];
}

export class DocumentInlineTextError extends Error {
    readonly kind = 'response';
    readonly code = 'DOCUMENT_INLINE_TEXT_UNTRANSLATED';
    readonly retryable = false;
    constructor(text: string) {
        super(`翻译服务未翻译文档行内正文：${text.slice(0, 80)}`);
        this.name = 'DocumentInlineTextError';
    }
}

export class DocumentInlineMarkerError extends Error {
    readonly code = 'DOCUMENT_INLINE_MARKER_INVALID';
    readonly retryable = false;
    constructor() {
        super('翻译服务未完整保留文档行内格式，请重试或切换翻译服务');
        this.name = 'DocumentInlineMarkerError';
    }
}

/** 只规范编号标签，不解码或改写正文中的其他实体。 */
export function normalizeDocumentInlineMarkers(text: string): string {
    return text.replace(/(?:&(?:lt|#0*60|#x0*3c);|[<＜〈（(])\s*([\/／]?)\s*[gＧｇ]\s*([0-9０-９]+)\s*([\/／]?)\s*(?:&(?:gt|#0*62|#x0*3e);|[>＞〉）)])/giu,
        (_, open: string, id: string, close: string) => `<${open ? '/' : ''}g${id.replace(/[０-９]/gu, value => String(value.charCodeAt(0) - 0xff10))}${close ? '/' : ''}>`);
}

/** 文档有生成标记时，从可见文字和原文索引中只移除协议编号。 */
export function stripDocumentInlineMarkers(text: string): string {
    return normalizeDocumentInlineMarkers(text).replace(/<\/?g\d+\/?>/gu, '');
}

/** Canonical 内部语法从术语正文匹配中排除，用户的同名短词仍可匹配标签之间的文字。 */
export function documentInlineMarkerRanges(text: string): Array<{start: number; end: number}> {
    return [...text.matchAll(/<\/?g[1-9]\d*\/?\s*>/gu)].map(match => ({start: match.index, end: match.index + match[0].length}));
}

// 静态字面集合没有初始化副作用，文档校验不可达的构建目标可连同该表一起裁剪。
const invisibleEntityNames = /* @__PURE__ */ new Set('nbsp NonBreakingSpace ensp emsp emsp13 emsp14 numsp puncsp thinsp hairsp Tab NewLine ThinSpace VeryThinSpace MediumSpace ThickSpace ZeroWidthSpace NegativeVeryThinSpace NegativeThinSpace NegativeMediumSpace NegativeThickSpace shy zwnj zwj lrm rlm NoBreak ApplyFunction af InvisibleTimes it InvisibleComma ic'.split(' '));

/** 只识别确定为空白/不可见的实体，不解码或改写候选正文，未知名称和可见数字实体保留。 */
function hasVisibleText(text: string): boolean {
    const visible = /[^\s\p{Cc}\p{Default_Ignorable_Code_Point}]/u;
    return visible.test(text.replace(/&(?:#(\d+)|#x([a-f\d]+)|([a-z][a-z\d]*));/giu, (entity: string, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
        if (name) return invisibleEntityNames.has(name) ? '' : entity;
        const code = decimal ? Number(decimal) : parseInt(hexadecimal!, 16);
        return code <= 0x10ffff && !visible.test(String.fromCodePoint(code)) ? '' : entity;
    }));
}

function structure(text: string): {counts: Map<string, number>; selfIds: Set<string>; filled: Map<string, number>} | null {
    const counts = new Map<string, number>(), selfIds = new Set<string>(), filled = new Map<string, number>();
    const open: Array<{id: string; key: string; text: boolean}> = [];
    let cursor = 0;
    for (const match of text.matchAll(/<(\/?)g(\d+)(\/?)>/gu)) {
        const parent = open.at(-1);
        if (parent && hasVisibleText(text.slice(cursor, match.index))) parent.text = true;
        cursor = match.index + match[0].length;
        const [, closing, id, selfClosing] = match;
        if (!/^[1-9]\d*$/u.test(id!) || closing && selfClosing) return null;
        if (closing) {
            const frame = open.pop();
            if (!frame || frame.id !== id) return null;
            if (frame.text) {
                filled.set(frame.key, (filled.get(frame.key) ?? 0) + 1);
                const ancestor = open.at(-1);
                if (ancestor) ancestor.text = true;
            }
        } else {
            const key = `${id}:${parent?.id ?? ''}:${selfClosing ? 'self' : 'pair'}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if (selfClosing) selfIds.add(id!);
            else open.push({id: id!, key, text: false});
        }
    }
    return open.length ? null : {counts, selfIds, filled};
}

/** 源文不是完整内部协议时保留字面写法；合法文档协议必须在候选胜出前完整保留。 */
export function validateDocumentInlineMarkers(origin: string, result: unknown, context?: DocumentInlineValidationContext): unknown {
    const expected = structure(origin);
    if (!expected?.counts.size) return result;
    if (typeof result !== 'string') throw new DocumentInlineMarkerError();
    const normalized = normalizeDocumentInlineMarkers(result).replace(/<g(\d+)>\s*<\/g\1>/gu,
        (pair, id: string) => expected.selfIds.has(id) ? `<g${id}/>` : pair);
    const actual = structure(normalized);
    if (!actual || actual.counts.size !== expected.counts.size
        || [...expected.counts].some(([key, count]) => actual.counts.get(key) !== count)) throw new DocumentInlineMarkerError();
    if (context) {
        // 按结构身份累计，允许重复编号/兄弟重排；含子节点文字的父节点也算非空，扫描保持线性。
        if ([...expected.filled].some(([key, count]) => (actual.filled.get(key) ?? 0) < count)) throw new DocumentInlineMarkerError();
        if (!context.targetLanguage) return normalized;
        const occurrences = new Map<string, number>();
        for (const [key, count] of expected.counts) {
            const id = key.slice(0, key.indexOf(':'));
            occurrences.set(id, (occurrences.get(id) ?? 0) + count);
        }
        const paired = (text: string) => new Map([...text.matchAll(/<g(\d+)>([\s\S]*?)<\/g\1>/gu)].map(match => [match[1]!, match[2]!]));
        const translations = paired(normalized);
        for (const [id, source] of paired(origin)) {
            // 重复编号或嵌套正文缺少唯一的独立节点身份，不猜测哪处文字应当翻译。
            if (occurrences.get(id) !== 1
                || /<\/?g\d+\/?\s*>/u.test(source)) continue;
            const target = translations.get(id)!;
            if (context.protectedTokens?.some(token => source.includes(token) || target.includes(token))) continue;
            if (isLikelyUntranslatedInlineResponse(source, target, context.targetLanguage, origin)) throw new DocumentInlineTextError(source);
        }
    }
    return normalized;
}

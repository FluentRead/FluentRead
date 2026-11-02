/**
 * @file src/features/document-translation/services/pdfSourceOcrSuggestion.ts
 * 文件职责：为已经选定且身份经过调用方核对的 PDF 原生正文生成保守的 OCR 校正建议，只在原文异常字符的位置提出替代字素，并始终逐字保留其它原生文字、标点、数字与空白。这里的建议用于对照原页后的人工确认，既不宣称找到了字体编码的真实含义，也不把图像识别结果升级为可信字符映射；重复的异常字符仍以原字符串中的独立 UTF16 位置区分，不能因为它们的值相同就复用候选或交换出现位置。
 * 主要内容：先限制文本与异常槽的规模，拒绝孤立代理项和缺少两侧已知锚点的输入，仅在比较副本中折叠空白，再从段首开始按完整已知片段推进游标。每个槽只能消耗一个有界、完整且不含控制码、空白或替换占位符的字素；所有已知片段和段尾都必须完整匹配，否则不提供建议。返回的原文由原始已知片段与候选字素拼接，替换记录保留原始偏移和旧值，不借识别结果改写原本可读的内容。
 * 模块边界：这是不依赖文档模型、OCR 引擎、页面渲染或持久化的纯字符串服务，不读取配置，不启动 Worker、网络或翻译请求，也不修改传入文本。文件字节、页码、正文块和图像裁剪的所有权由调用方证明，用户接受、撤销、旧译文保留、历史恢复与取消代次均由上层负责；没有完整匹配时只返回 undefined，调用方应保留原文并展示原始 OCR 供手工校正，禁止退回整段识别结果覆盖原文。
 */

export interface PdfSourceOcrReplacement {offset: number; original: string; text: string}
export interface PdfSourceOcrSuggestion {source: string; replacements: readonly PdfSourceOcrReplacement[]}

const MAX_TEXT = 12_000;
const MAX_SLOTS = 32;
const UNKNOWN_SOURCE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffc\ufffd]/gu;
const UNSAFE_CANDIDATE = /[\p{C}\s\ufffc\ufffd]/u;
const foldWhitespace = (text: string) => text.replace(/\s+/gu, ' ');

/** 只提出建议；完整已知锚点与单字素约束使匹配确定，不搜索第一个重复短串或尝试模糊对齐。 */
export function suggestPdfSourceOcrCorrection(source: string, recognized: string): PdfSourceOcrSuggestion | undefined {
    if (typeof source !== 'string' || typeof recognized !== 'string' || !source || !recognized
        || source.length > MAX_TEXT || recognized.length > MAX_TEXT || /\p{Cs}/u.test(source) || /\p{Cs}/u.test(recognized)) return;
    const slots = [...source.matchAll(UNKNOWN_SOURCE)];
    if (!slots.length || slots.length > MAX_SLOTS || typeof Intl.Segmenter !== 'function') return;
    const chunks: string[] = [];
    let start = 0;
    for (const slot of slots) {chunks.push(source.slice(start, slot.index)); start = slot.index + slot[0].length;}
    chunks.push(source.slice(start));
    // 空白本身不能为两个相邻槽分配独立身份；页块边缘没有双侧锚点也交由人工处理。
    if (chunks.some(chunk => !chunk.trim())) return;
    const comparison = foldWhitespace(recognized).trim();
    const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
    const sourceGraphemes = segmenter.segment(source), graphemes = segmenter.segment(comparison);
    const replacements: PdfSourceOcrReplacement[] = [];
    let cursor = 0, suggested = '';
    for (const [index, slot] of slots.entries()) {
        const known = index === 0 ? foldWhitespace(chunks[index]).trimStart() : foldWhitespace(chunks[index]);
        if (!comparison.startsWith(known, cursor)) return;
        cursor += known.length;
        const original = sourceGraphemes.containing(slot.index)!;
        if (original.index !== slot.index || original.segment !== slot[0]) return;
        const candidate = graphemes.containing(cursor);
        if (!candidate || candidate.index !== cursor || candidate.segment.length > 8 || UNSAFE_CANDIDATE.test(candidate.segment)) return;
        // 折叠只改变空白，候选禁止空白，因此这里仍是识别结果中未经改写的完整字素。
        replacements.push({offset: slot.index, original: slot[0], text: candidate.segment});
        suggested += chunks[index] + candidate.segment;
        cursor += candidate.segment.length;
    }
    const tail = chunks[chunks.length - 1];
    if (comparison.slice(cursor) !== foldWhitespace(tail).trimEnd()) return;
    suggested += tail;
    return suggested.length <= MAX_TEXT ? {source: suggested, replacements} : undefined;
}

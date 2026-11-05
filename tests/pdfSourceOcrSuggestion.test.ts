/**
 * @file tests/pdfSourceOcrSuggestion.test.ts
 * 文件职责：验证 PDF 原生正文的 OCR 建议只替换有独立原始位置的异常字符，原本已知的文字、数字、标点和空白始终来自原文。测试区分建议与用户接受，不把模拟的识别字符当作实际字体映射或 OCR 准确性证据；重复上下文中的各个槽必须保留自己的 UTF16 偏移，只有整段已知内容都能严格对应时才允许生成建议，避免把看起来更通顺的识别结果直接覆盖原生正文。
 * 主要内容：用自拟字符串与 Smith–Levy 第三、七页的最小重复上下文检查单槽、多槽、空白比较、完整字素和替换偏移，覆盖大小写、数字、标点、Unicode 组合形式、已知字符增删以及多余文本的拒绝边界。另验证输入和输出预算、缺少分段器、相邻异常槽、控制码、替换占位符、孤立代理项以及原文锚点切开字素等情况，完整输出必须只由保留的原文片段与经过限制的候选字素构成。
 * 模块边界：所有识别字符串均为受控测试输入，不渲染或解析 PDF，不调用 OCR、翻译服务或浏览器，不加载模型，也不测试页面裁剪和原始文件归属。这里仅证明纯字符串协议能够拒绝不确定或不完整的对应关系，真实字符的含义、原图与正文块的唯一归属、确认提交、旧译文保留、撤销、历史恢复和取消竞态仍需要上层独立验证，不能以这些单元测试代替实际恢复验收。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {suggestPdfSourceOcrCorrection} from '@/src/features/document-translation/services/pdfSourceOcrSuggestion';

afterEach(() => vi.unstubAllGlobals());

describe('source-faithful native PDF OCR suggestions', () => {
    it('replaces only the opaque occurrence and retains every known byte including whitespace', () => {
        const source = '\tLeft\u00a0  known \u0003 right\r\n';
        expect(suggestPdfSourceOcrCorrection(source, ' Left known × right ')).toEqual({
            source: '\tLeft\u00a0  known × right\r\n', replacements: [{offset: 14, original: '\u0003', text: '×'}],
        });
    });

    it('keeps repeated paragraph anchors associated with their own original occurrences', () => {
        // Smith–Levy(2013), source p3/segment36: minimal substring spanning the two original U0003 occurrences.
        // Source is CC BY (declared on source p1). These distinct OCR symbols are controlled inputs, not actual recognition or semantic claims.
        const source = 'incorrectly on (1 \u0003 P(wjC)) proportion. Thus the average reading time will be (tbaseline) + (1 \u0003 P(wjC))tincorrect';
        const first = source.indexOf('\u0003'), second = source.lastIndexOf('\u0003');
        const result = suggestPdfSourceOcrCorrection(source, source.replace('\u0003', '×').replace('\u0003', '∷'));
        expect(result).toEqual({source: source.slice(0, first) + '×' + source.slice(first + 1, second) + '∷' + source.slice(second + 1),
            replacements: [{offset: first, original: '\u0003', text: '×'}, {offset: second, original: '\u0003', text: '∷'}]});
    });

    it('keeps all three independent statistical contexts and every known number unchanged', () => {
        // Minimal source p7/segment79 context; the candidate symbols are simulated and require later user confirmation.
        const source = 'total b = \u00030.05, 95% CI = (\u00030.45, 0.37), one-tailed p = 0.59; self-paced reading: total b = 0.04, 95% CI = (\u00030.90, 1.07)';
        const recognized = source.replace('\u0003', '×').replace('\u0003', '∷').replace('\u0003', '±');
        expect(suggestPdfSourceOcrCorrection(source, recognized)).toEqual({source: recognized,
            replacements: [...source.matchAll(/\u0003/gu)].map((match, index) => ({offset: match.index, original: '\u0003', text: ['×', '∷', '±'][index]}))});
        expect(suggestPdfSourceOcrCorrection(source, recognized.replace('0.45', '0.54'))).toBeUndefined();
    });

    it.each(['\u0000', '\u0003', '\u000b', '\u000c', '\u001f', '\u007f', '\u0085', '\u009f', '\ufffc', '\ufffd'])
    ('can propose a character for anomalous original %j without treating its code as a meaning', original => {
        expect(suggestPdfSourceOcrCorrection(`left ${original} right`, 'left × right')).toEqual({source: 'left × right',
            replacements: [{offset: 5, original, text: '×'}]});
    });

    it.each(['\t', '\r', '\n'])('retains legitimate whitespace %j as known text rather than a replacement slot', whitespace => {
        expect(suggestPdfSourceOcrCorrection(`left${whitespace}right`, 'left right')).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection(`left${whitespace}\u0003 right`, 'left × right')?.source).toBe(`left${whitespace}× right`);
    });

    it.each(['🧪', 'e\u0301', 'א', '一', 'a\u0301\u0302\u0303\u0304\u0305\u0306\u0307'])
    ('keeps one complete non-control grapheme %j including its exact encoding', text => {
        const source = '🧪 known \u0003 סוף';
        expect(suggestPdfSourceOcrCorrection(source, `🧪 known ${text} סוף`)).toEqual({source: `🧪 known ${text} סוף`,
            replacements: [{offset: 9, original: '\u0003', text}]});
    });

    it('retains native literal markup exactly instead of parsing or normalizing it', () => {
        expect(suggestPdfSourceOcrCorrection('literal <g7/> \u0003 end', 'literal <g7/> × end')?.source).toBe('literal <g7/> × end');
        expect(suggestPdfSourceOcrCorrection('literal <g7/> \u0003 end', 'literal <g7></g7> × end')).toBeUndefined();
    });

    it.each([
        ['known case', 'Known × right'], ['known digit', 'known × right2'],
        ['known punctuation', 'known × right.'], ['extra prefix', 'noise known × right'],
        ['extra suffix', 'known × right noise'], ['deleted known text', 'known ×'],
        ['multi-grapheme replacement', 'known xx right'], ['unconsumed replacement', 'known ×x right'],
    ])('declines %s rather than rewriting known native text', (_name, recognized) => {
        expect(suggestPdfSourceOcrCorrection('known \u0003 right', recognized)).toBeUndefined();
    });

    it('does not normalize composed known characters, dashes or numeric punctuation', () => {
        expect(suggestPdfSourceOcrCorrection('café \u0003 0.45—end', 'cafe\u0301 × 0.45—end')).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection('café \u0003 0.45—end', 'café × 0,45-end')).toBeUndefined();
    });

    it('declines an intermediate known-anchor mismatch without returning partial replacements', () => {
        expect(suggestPdfSourceOcrCorrection('a \u0003 middle \u0003 end', 'a × MIDDLE ∷ end')).toBeUndefined();
    });

    it.each(['\u0003 end', 'start \u0003', ' \u0003 end', 'start \u0003 ', 'a\u0003\u0003b', 'a\u0003 \u0003b'])
    ('declines missing or whitespace-only independent anchors: %j', source => {
        expect(suggestPdfSourceOcrCorrection(source, source.replaceAll('\u0003', '×'))).toBeUndefined();
    });

    it.each(['\u0003', '\u0085', '\ufffc', '\ufffd', '\u200b', '\ue000', ' ', '👩‍👩‍👧‍👦'])
    ('declines unsafe, unresolved, whitespace or oversized candidate %j', candidate => {
        expect(suggestPdfSourceOcrCorrection('left\u0003right', `left${candidate}right`)).toBeUndefined();
    });

    it('declines a candidate cursor inside the previous known grapheme and a missing candidate at end of OCR', () => {
        expect(suggestPdfSourceOcrCorrection('a\u0003b', 'a\u0301b')).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection('known\u0003end', 'known')).toBeUndefined();
    });

    it('does not split a replacement-source grapheme at a combining or prepend boundary', () => {
        expect(suggestPdfSourceOcrCorrection('a\ufffd\u0301b', 'a×\u0301b')).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection('a\u0600\ufffdb', 'a\u0600×b')).toBeUndefined();
    });

    it.each(['\ud800', '\udc00'])('refuses invalid UTF16 %j in either input', invalid => {
        expect(suggestPdfSourceOcrCorrection(`left${invalid}\u0003right`, 'left×right')).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection('left\u0003right', `left${invalid}right`)).toBeUndefined();
    });

    it('declines ordinary input, blank inputs and malformed runtime argument types', () => {
        expect(suggestPdfSourceOcrCorrection('ordinary text', 'different OCR')).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection('', 'known × right')).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection('known \u0003 right', '')).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection('known \u0003 right', ' \t\n')).toBeUndefined();
        expect(Reflect.apply(suggestPdfSourceOcrCorrection, undefined, [null, 'known × right'])).toBeUndefined();
        expect(Reflect.apply(suggestPdfSourceOcrCorrection, undefined, ['known \u0003 right', 3])).toBeUndefined();
    });

    it('requires the real grapheme API rather than guessing boundaries in an old environment', () => {
        vi.stubGlobal('Intl', {Segmenter: undefined});
        expect(suggestPdfSourceOcrCorrection('known \u0003 right', 'known × right')).toBeUndefined();
    });

    it('bounds original and recognized text without truncating either side', () => {
        const source = 'a'.repeat(11_998) + '\u0003b', recognized = 'a'.repeat(11_998) + '×b';
        expect(suggestPdfSourceOcrCorrection(source, recognized)?.source).toBe(recognized);
        expect(suggestPdfSourceOcrCorrection('a' + source, 'a' + recognized)).toBeUndefined();
        expect(suggestPdfSourceOcrCorrection(source, recognized + 'x')).toBeUndefined();
    });

    it('bounds each original occurrence independently even when all known anchors repeat', () => {
        const source = 'a\u0003'.repeat(32) + 'z', recognized = 'a×'.repeat(32) + 'z';
        const result = suggestPdfSourceOcrCorrection(source, recognized);
        expect(result?.source).toBe(recognized);
        expect(result?.replacements).toEqual(Array.from({length: 32}, (_, index) => ({offset: index * 2 + 1, original: '\u0003', text: '×'})));
        expect(suggestPdfSourceOcrCorrection('a\u0003'.repeat(33) + 'z', 'a×'.repeat(33) + 'z')).toBeUndefined();
    });

    it('declines a suggested result exceeding the source budget even when OCR comparison is short', () => {
        const source = 'a' + ' '.repeat(11_995) + '\u0003b';
        expect(suggestPdfSourceOcrCorrection(source, 'a ' + 'e' + '\u0301'.repeat(7) + 'b')).toBeUndefined();
    });
});

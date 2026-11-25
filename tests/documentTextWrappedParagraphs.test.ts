/**
 * @file tests/documentTextWrappedParagraphs.test.ts
 * 文件职责：验证纯文本里按固定宽度折行的段落作为一个片段翻译，而标题、列表、短行和各自成句的行仍然逐行处理。
 * 主要内容：折行段落合并后的送翻原文（折行处是空格，中日韩文字之间不留空格）、仅译文与双语导出、Windows 换行、缩进一致才合并；全大写标题、句末标点、列表与编号、分隔线、过短的行不合并；Markdown 不受影响。
 * 模块边界：只测试纯解析与渲染，不发起翻译；阅读预览与页面交互由各自的测试覆盖。
 */
import {describe, expect, it} from 'vitest';
import {parseDocument, renderDocument} from '@/src/features/document-translation/core/document';

const sources = (text: string, name = 'notes.txt') => parseDocument(name, text).segments.map(segment => segment.source);

describe('hard-wrapped plain-text paragraphs', () => {
    const wrapped = ['The budget for the second quarter was approved', 'without changes, although Luis asked for a review', 'of travel costs before the summer.'];
    const notes = ['MEETING NOTES FOR THE ORCHARD PROJECT AND ITS PARTNERS', '', 'Attendees: Dana, Luis, Mei', 'Date: 12 March', '', ...wrapped, '',
        '- Design freeze moves to the end of April and', '- Testing starts one week after the freeze has', '', 'Action items for everyone attending the meeting', '* Dana sends the plan', '', '---', 'Next meeting: 26 March'];

    it.each(['\n', '\r\n', '\r'])('translates a wrapped paragraph with %j line endings as one segment and preserves original bytes', ending => {
        expect(sources(notes.join(ending))).toEqual([
            'MEETING NOTES FOR THE ORCHARD PROJECT AND ITS PARTNERS', 'Attendees: Dana, Luis, Mei', 'Date: 12 March', wrapped.join(' '),
            '- Design freeze moves to the end of April and', '- Testing starts one week after the freeze has', 'Action items for everyone attending the meeting', '* Dana sends the plan', '---', 'Next meeting: 26 March',
        ]);
        expect(renderDocument(parseDocument('notes.txt', notes.join(ending)), [], 'translated')).toBe(notes.join(ending));
        expect(sources(notes.join(ending))[3]).toBe(wrapped.join(' '));
    });

    it('writes the translation as one line and keeps the original lines in bilingual output', () => {
        const text = `${wrapped.join('\n')}\n\nA closing line that is long enough to set the wrap width.\n`;
        const parsed = parseDocument('notes.txt', text);
        expect(parsed.segments.map(segment => segment.source)).toEqual([wrapped.join(' '), 'A closing line that is long enough to set the wrap width.']);
        expect(renderDocument(parsed, ['第二季度的预算照原样通过，不过路易斯要求在夏天之前复核差旅费用。', '结尾的一行。'], 'translated'))
            .toBe('第二季度的预算照原样通过，不过路易斯要求在夏天之前复核差旅费用。\n\n结尾的一行。\n');
        expect(renderDocument(parsed, ['第二季度的预算照原样通过。', '结尾的一行。'], 'bilingual'))
            .toBe(`${wrapped.join('\n')}\n第二季度的预算照原样通过。\n\nA closing line that is long enough to set the wrap width.\n结尾的一行。\n`);
    });

    it('joins wrapped CJK lines without a space and requires matching indentation', () => {
        const cjk = ['第二季度的预算没有改动就通过了，不过路易斯要求在夏天', '到来之前复核一次差旅费用，并把结果发给所有与会的人'];
        expect(sources(cjk.join('\n'))).toEqual([cjk.join('')]);
        // 中日韩文字与拉丁单词相接的折行处仍补一个空格。
        expect(sources('第二季度的预算没有改动就通过了，负责人是\nLuis 并且他要求在夏天到来之前复核一次差旅费用')).toEqual(['第二季度的预算没有改动就通过了，负责人是 Luis 并且他要求在夏天到来之前复核一次差旅费用']);
        // 缩进不同的下一行是另一块内容（引文、代码、署名），不并进来。
        expect(sources(`${wrapped[0]}\n    ${wrapped[1]}`)).toEqual([wrapped[0], wrapped[1]]);
    });

    it.each(['\n', '\r\n', '\r'].flatMap(ending => [
        ['中', '文'], ['𠀀', '𠀁'], ['𠀀', '文'], ['中', '𠀁'],
    ].map(([left, right]) => ({ending, left, right}))))('joins complete CJK code points at $left/$right boundaries with $ending line endings', ({ending, left, right}) => {
        const first = left.repeat(40), second = right.repeat(40), input = first + ending + second;
        const parsed = parseDocument('code-points.txt', input);
        expect(parsed.segments.map(segment => segment.source)).toEqual([first + second]);
        expect(renderDocument(parsed, [], 'translated')).toBe(input);
    });

    it.each(['\n', '\r\n', '\r'])('removes soft-wrap whitespace beside supplementary Han with %j line endings and preserves the source bytes', ending => {
        const first = '𠀀'.repeat(40), second = '𠀁'.repeat(40);
        const input = `  ${first} \t${ending}  ${second}\n`;
        const parsed = parseDocument('indented-han.txt', input);
        expect(parsed.segments.map(segment => segment.source)).toEqual([first + second]);
        expect(renderDocument(parsed, [], 'translated')).toBe(input);
    });

    it.each([
        ['中'.repeat(39) + 'a', '𠀁'.repeat(40)],
        ['𠀀'.repeat(40), 'a' + '中'.repeat(39)],
        ['中'.repeat(39) + '😀', '𠀁'.repeat(40)],
        ['𠀀'.repeat(40), '😀' + '中'.repeat(39)],
    ])('keeps a separator when either immediate boundary code point requires one', (first, second) => {
        expect(sources(`${first}\n${second}`)).toEqual([`${first} ${second}`]);
    });

    it('keeps multi-sentence hard-wrapped commit message paragraphs together while preserving blank-line splits', () => {
        const commit = [
            'The opaque rect that we report to the compositor is derived from the',
            'opaque rectangle of the render node, shrunk to whole surface pixels.',
            'The surface contents are rendered into a buffer that is scaled by the',
            'ratio between the buffer and the surface, so that ratio is often',
            'fractional, and the edges of the rect then land within buffer pixels:',
            'the outermost buffer pixel is only partially covered even though the',
            'rect claims that it is opaque. A compositor that disables blending for',
            'the opaque region then shows that partial coverage as a line along the',
            'window edges.',
            '',
            'Keep the edges that cannot be proven opaque out of the region in',
            '`gdk_surface_set_opaque_rect()`, using the exact buffer to surface',
            'ratio. Only the misaligned edges are affected, so a window that fills',
            'its buffer exactly - such as a maximized window - keeps reporting its',
            'full opaque area, and compositors can still cull windows that it covers.',
        ].join('\n');
        const result = sources(commit);
        expect(result).toHaveLength(2);
        expect(result[0]).toContain('whole surface pixels. The surface contents');
        expect(result[0]).toContain('buffer pixels: the outermost buffer pixel');
        expect(result[1]).toContain('`gdk_surface_set_opaque_rect()`, using the exact buffer to surface ratio.');

        // 中文按固定宽度折行的多句段落也合并为一段。
        const cjkCommit = [
            '合成器使用的不透明区域来源于渲染节点的矩形范围，并按整像素',
            '边界向内收缩。当表面内容绘制到缩放后的缓冲区时，边缘可能落',
            '在缓冲区像素内部。因此只排除无法证明完全不透明的边缘区域，',
            '从而保留窗口的完整裁剪能力。',
        ].join('\n');
        expect(sources(cjkCommit)).toEqual([cjkCommit.replaceAll('\n', '')]);
    });

    it('does not merge lines that end a sentence, numbered items or anything in Markdown', () => {
        expect(sources('This line is long enough and ends its sentence here.\nThis one starts another sentence of similar length')).toHaveLength(2);
        expect(sources('The first numbered step is long enough to look wrapped\n2) the second step follows on the next line here')).toHaveLength(2);
        expect(sources('An introduction that is long enough to look like wrapped\n(a) but the next line is a lettered item in a list')).toHaveLength(2);
        expect(sources('“He said the meeting would be moved to next week.”\nNobody objected, and the room was booked again')).toHaveLength(2);
        expect(sources(wrapped.join('\n'), 'notes.md')).toEqual(wrapped);
        expect(sources('')).toEqual([]);
    });
});

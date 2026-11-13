import {describe, expect, it} from 'vitest';
import {createGoogleImageContext, parseGoogleImageContext} from '@/src/providers/translation/googleImageContext';

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const decode = (text: string) => text.replace(/&(amp|lt|gt);/gu, (_, key: string) => ({amp: '&', lt: '<', gt: '>'})[key]!);
const slot = (id: number | string, text: string) => `<span data-fr-slot="${id}">${text}</span>`;
const paragraph = (...rows: string[]) => `<p>${rows.join(' ')}</p>`;

describe('同图 Google HTML 位置和语气协议', () => {
    it('标题和残句保持独立，完整句子最多共享四个相邻位置，原文大小写和重复位置不变', () => {
        const texts = ['A TITLE', 'GO.', 'WAIT!', 'WHY?', 'GO.', 'ANOTHER SENTENCE.', 'Note:', 'Yes.'];
        expect(createGoogleImageContext(texts, escape)).toEqual([
            `<pre>${slot(0, 'A TITLE')}</pre>`, paragraph(slot(1, 'GO.'), slot(2, 'WAIT!'), slot(3, 'WHY?'), slot(4, 'GO.')),
            paragraph(slot(5, 'ANOTHER SENTENCE.')), `<pre>${slot(6, 'Note:')}</pre>`, paragraph(slot(7, 'Yes.')),
        ]);
    });
    it('邻文达到 1200 字符即分组，过长单句保持完整且不与另一句连接', () => {
        const half = 'x'.repeat(599) + '.', large = 'x'.repeat(1200) + '.';
        const docs = createGoogleImageContext([half, half, 'End.', large, 'After.'], escape);
        expect(docs).toHaveLength(4);
        expect(docs[0]).toBe(paragraph(slot(0, half), slot(1, half)));
        expect(docs[2]).toBe(paragraph(slot(3, large)));
        expect(createGoogleImageContext([large], escape)).toEqual([paragraph(slot(0, large))]);
    });
    it('空批次和纯标题不制造多余段落，原始标签和实体只作为文本', () => {
        expect(createGoogleImageContext([], escape)).toEqual([]);
        expect(parseGoogleImageContext([], [], decode)).toEqual([]);
        const docs = createGoogleImageContext(['<b>&amp;</b>', 'Next title'], escape);
        expect(docs).toEqual([`<pre>${slot(0, '&lt;b&gt;&amp;amp;&lt;/b&gt;')}</pre>`, `<pre>${slot(1, 'Next title')}</pre>`]);
        expect(parseGoogleImageContext(docs, ['<b>&amp;</b>', 'Next title'], decode)).toEqual(['<b>&amp;</b>', 'Next title']);
    });
    it('多行文字保留 pre 和原始换行，不能借邻文把列表或分行内容合成一句', () => {
        expect(createGoogleImageContext(['Before.', 'First line.\nSecond line.', 'After.'], escape)).toEqual([
            paragraph(slot(0, 'Before.')), `<pre>${slot(1, 'First line.\nSecond line.')}</pre>`, paragraph(slot(2, 'After.')),
        ]);
    });
    it('按编号恢复乱序和重复对白，允许目标语言对应的句末符号和引号', () => {
        expect(parseGoogleImageContext([
            paragraph(slot(2, '走！'), slot(0, '对吗？”')), paragraph(slot(1, '走。')),
        ], ['Right?”', 'Go.', 'Go!'], decode)).toEqual(['对吗？”', '走。', '走！']);
    });
    it.each([
        ['Really?!', '真的？！'], ['End...', '结束…'], ['Right?', 'صحيح؟'], ['End.', 'समाप्त।'],
        ['Note:', '备注：'], ['A TITLE', '标题'], ['“Why?”', '「为什么？」'], ['Wait!.', '等等！'],
    ])('保留完整的语气类别：%s', (source, target) => {
        expect(parseGoogleImageContext([paragraph(slot(0, target))], [source], decode)).toEqual([target]);
    });
    it.each([
        [paragraph(slot(0, '走到中央，')), ['Step into the middle.']],
        [paragraph(slot(0, '十分钟前，')), ['TEN MINUTES EARLIER']],
        [paragraph(slot(0, '真的。')), ['Really?']],
        [paragraph(slot(0, '等等？')), ['Wait!']],
        [paragraph(slot(0, '真的？')), ['Really?!']],
        [paragraph(slot(0, '标题。')), ['A TITLE']],
        [paragraph(slot(0, '没有句末')), ['Sentence.']],
        [paragraph(slot(0, '   ')), ['Title']],
        [paragraph(slot(1, '标题')), ['Title']],
        [paragraph(slot('00', '标题')), ['Title']],
        [paragraph(slot(0, '标题'), slot(0, '重复')), ['Title', 'Next']],
        [paragraph(slot(0, '标题')), ['Title', 'Next']],
        [paragraph(slot(0, '<b>标题</b>')), ['Title']],
        [paragraph(slot(0, '标题')) + '额外正文', ['Title']],
        ['<p>额外正文' + slot(0, '标题') + '</p>', ['Title']],
        ['<p></p>', ['Title']],
        ['<div>' + slot(0, '标题') + '</div>', ['Title']],
        ['<p>' + slot(0, '标题') + '</pre>', ['Title']],
    ])('拒绝会串框、改变语气或污染正文的响应 %#', (html, sources) => {
        expect(() => parseGoogleImageContext([html as string], sources as string[], decode)).toThrow('槽位或句末边界');
    });
});

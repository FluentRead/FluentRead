import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {readingAnswerBlocks, readingAnswerSpans} from '@/src/features/reading-assistant/answerFormat';
import {captureReadingSelection, sentenceAroundSelection} from '@/src/features/reading-assistant/selectionContext';
import {buildReadingEvidence, parseReadingEvidence} from '@/src/core/harness/evidence';
import {truncateUtf16} from '@/src/shared/function/truncateUtf16';

it('UTF-16 截断只回退被截开的代理对，并遵守零预算和原有短文本', () => {
    expect(truncateUtf16('A😀B', 2)).toBe('A');
    expect(truncateUtf16('A😀B', 3)).toBe('A😀');
    expect(truncateUtf16('A😀B', 4)).toBe('A😀B');
    expect(truncateUtf16('ABC', 0)).toBe('');
    expect(truncateUtf16('ABCD', 2)).toBe('AB');
    expect(truncateUtf16('A\ud83dX', 2)).toBe('A\ud83d');
    expect(truncateUtf16('A\udc00B', 2)).toBe('A\udc00');
});

function fixture(html: string, selector = '#selected', offset = 0) {
    const {document, window} = parseHTML(`<html><body>${html}</body></html>`);
    const node = document.querySelector(selector)!.firstChild!;
    const range = {startContainer: node, endContainer: node, startOffset: offset} as unknown as Range;
    return {document, window, node, range};
}

describe('reading context respects the selected prose boundary', () => {
    it('选文达到长度预算时不把边界上的辅助平面字符拆成半个代理项', () => {
        const value = `${'a'.repeat(4095)}😀tail`;
        const {range} = fixture(`<p id="selected">${value}</p>`);
        const result = captureReadingSelection(range, value, 0);
        expect(result.text).toBe('a'.repeat(4095));
        expect(result.sentence).toBe(result.text);
    });
    it('keeps surrounding words, removes controls, and never captures an adjacent paragraph', () => {
        const {range} = fixture('<p>Before <span id="selected">practice</span> makes progress.<button>BUTTON SECRET</button><input value="INPUT SECRET"><span hidden>HIDDEN SECRET</span><span class="fluent-read-bilingual-content">TRANSLATION SECRET</span></p><p>OTHER PARAGRAPH SECRET</p>');
        expect(captureReadingSelection(range, 'practice', 1500)).toEqual({
            text: 'practice', context: 'Before practice makes progress.', sentence: 'Before practice makes progress.',
        });
    });
    it('returns only the selection when context is disabled, the range detached, or spans two blocks', () => {
        const {document, range, node} = fixture('<p id="selected">Hello there.</p><p id="other">Another paragraph.</p>');
        const only = {text: 'Hello', context: '', sentence: 'Hello'};
        expect(captureReadingSelection(range, 'Hello', 0)).toEqual(only);
        expect(captureReadingSelection({...range, endContainer: document.querySelector('#other')!.firstChild!} as Range, 'Hello', 1500)).toEqual(only);
        node.parentElement!.remove();
        expect(captureReadingSelection(range, 'Hello', 1500)).toEqual(only);
    });
    it('does not read application shells, editable content, hidden prose, or mismatched snapshots', () => {
        for (const html of ['<main id="selected">Hello</main>', '<p contenteditable="true" id="selected">Hello</p>', '<p style="display:none" id="selected">Hello</p>', '<p style="visibility:hidden" id="selected">Hello</p>']) {
            expect(captureReadingSelection(fixture(html).range, 'Hello', 1500).context).toBe('');
        }
        expect(captureReadingSelection(fixture('<p id="selected">Changed</p>').range, 'Hello', 1500)).toEqual({text: 'Hello', context: '', sentence: 'Hello'});
    });
    it('uses computed visibility and ignores comments without including their text', () => {
        const {range, window, document} = fixture('<p><!-- SECRET -->The <span class="hidden">CSS SECRET</span><span id="selected">word</span> matters.</p>');
        document.querySelector('p')!.appendChild(document.createTextNode(''));
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: vi.fn(element => ({display: element.classList.contains('hidden') ? 'none' : 'block', visibility: 'visible'}))});
        expect(captureReadingSelection(range, 'word', 1500).context).toBe('The word matters.');
        delete (window as unknown as {getComputedStyle?: unknown}).getComputedStyle;
    });
    it('selects the later identical word sentence and clips long paragraphs around it', () => {
        const prefix = `Practice helps. ${'Earlier material. '.repeat(250)}`;
        const {range} = fixture(`<p>${prefix}The <span id="selected">practice</span> here means rehearsal. ${'Later material. '.repeat(200)}</p>`);
        const result = captureReadingSelection(range, 'practice', 500);
        expect(result.sentence).toBe('The practice here means rehearsal.');
        expect(result.context.length).toBeLessThanOrEqual(500);
        expect(result.context).toContain('The practice here means rehearsal.');
        expect(result.context).not.toContain('Practice helps.');
    });
    it('bounds selection/sentence sizes and declines excessive subtree traversal', () => {
        const longText = 'a'.repeat(5000);
        const long = fixture(`<p id="selected">${longText}</p>`);
        expect(captureReadingSelection(long.range, longText, 4000).text).toHaveLength(4096);
        expect(captureReadingSelection(long.range, 'a', 4000).sentence).toBe('a');
        const crowded = fixture(`<p><span id="selected">word</span>${'<i>x</i>'.repeat(1200)}</p>`);
        expect(captureReadingSelection(crowded.range, 'word', 1500).context).toBe('');
    });
    it('handles element ranges and missing parent conservatively', () => {
        const {document, node, range} = fixture('<p id="selected">word</p>');
        expect(captureReadingSelection({...range, startContainer: node.parentElement!} as Range, 'word', 1500).context).toBe('');
        expect(captureReadingSelection({...range, startContainer: document, endContainer: document} as unknown as Range, 'word', 1500).context).toBe('');
    });
    it.each([0, 40_000, 80_000])('declines oversized raw text before normalization, including a selected occurrence at %i', offset => {
        const source = 'x'.repeat(offset) + 'practice' + 'x'.repeat(80_000 - offset);
        const {range} = fixture(`<p id="selected">${source}</p>`, '#selected', offset);
        const replace = String.prototype.replace;
        let largestInput = 0;
        const spy = vi.spyOn(String.prototype, 'replace').mockImplementation(function (this: string, pattern: any, replacement: any) {
            largestInput = Math.max(largestInput, this.length);
            return replace.call(this, pattern, replacement);
        });
        let result;
        try { result = captureReadingSelection(range, 'practice', 500); }
        finally { spy.mockRestore(); }
        expect(result).toEqual({text: 'practice', context: '', sentence: 'practice'});
        expect(largestInput).toBeLessThanOrEqual(64_000);
    });
    it('bounds cumulative raw text across small nodes and preserves the later occurrence at the exact character limit', () => {
        const crowded = fixture(`<p><span id="selected">practice</span><span>${'x'.repeat(500)}</span></p>`);
        const paragraph = crowded.node.parentElement!.parentElement!;
        for (let i = 0; i < 130; i++) paragraph.appendChild(crowded.document.createTextNode('x'.repeat(500)));
        expect(captureReadingSelection(crowded.range, 'practice', 500)).toEqual({text: 'practice', context: '', sentence: 'practice'});
        const prefix = `Practice helps. ${'Earlier material. '.repeat(3000)}`;
        const sentence = 'The practice here means rehearsal.';
        const suffix = ` ${'Later material. '.repeat(1000)}`.slice(0, 64_000 - prefix.length - sentence.length);
        const exact = fixture(`<p>${prefix}The <span id="selected">practice</span> here means rehearsal.${suffix}</p>`);
        expect(exact.node.parentElement!.parentElement!.textContent).toHaveLength(64_000);
        const result = captureReadingSelection(exact.range, 'practice', 500);
        expect(result.sentence).toBe(sentence);
        expect(result.context).toContain(sentence);
        expect(result.context).not.toContain('Practice helps.');
        expect(result.context.length).toBeLessThanOrEqual(500);
    });
    it.each([2500, 20_000])('declines a wide subtree before enumerating its %i direct siblings', siblings => {
        const {node, range} = fixture(`<p><span id="selected">word</span>${'<i>x</i>'.repeat(siblings)}</p>`);
        const paragraph = node.parentElement!.parentElement!;
        const children = paragraph.childNodes;
        let yielded = 0;
        Object.defineProperty(paragraph, 'childNodes', {configurable: true, get: () => ({length: children.length,
            *[Symbol.iterator]() { for (const child of children) { yielded++; yield child; } },
        })});
        expect(captureReadingSelection(range, 'word', 500)).toEqual({text: 'word', context: '', sentence: 'word'});
        expect(yielded).toBe(0);
    });
    it('bounds total queued traversal across nested fanout and skips oversized excluded text', () => {
        const {document, range} = fixture(`<p><span id="selected">word</span>${`<span class="branch">${'<i>x</i>'.repeat(400)}</span>`.repeat(4)}</p>`);
        let yielded = 0;
        for (const branch of document.querySelectorAll('p,span,i')) {
            const children = branch.childNodes;
            Object.defineProperty(branch, 'childNodes', {configurable: true, get: () => ({length: children.length,
                *[Symbol.iterator]() { for (const child of children) { yielded++; yield child; } },
            })});
        }
        expect(captureReadingSelection(range, 'word', 500).context).toBe('');
        expect(yielded).toBeLessThanOrEqual(2000);
        const safe = fixture(`<p>Before <span hidden>${'x'.repeat(100_000)}</span><span id="selected">word</span> after.</p>`);
        expect(captureReadingSelection(safe.range, 'word', 500).context).toBe('Before word after.');
    });
});

describe('reading answer presentation', () => {
    it('preserves HTML as inert text while keeping semantic headings, list ordering and emphasis', () => {
        expect(readingAnswerBlocks('# Structure\r\n\n- A **noun**\n1. A verb\n---\n<script>alert(1)</script>')).toEqual([
            {kind: 'heading', text: 'Structure', level: 1}, {kind: 'list', ordered: false, start: 1, items: ['A **noun**']},
            {kind: 'list', ordered: true, start: 1, items: ['A verb']}, {kind: 'paragraph', text: '<script>alert(1)</script>'},
        ]);
        expect(readingAnswerSpans('The **noun** here.')).toEqual([{text: 'The ', kind: 'text'}, {text: 'noun', kind: 'strong'}, {text: ' here.', kind: 'text'}]);
        expect(readingAnswerSpans('**unfinished')).toEqual([{text: '**unfinished', kind: 'text'}]);
        expect(readingAnswerBlocks('')).toEqual([]);
    });
    it('separates meaning sections while retaining soft breaks and grouped list numbering', () => {
        expect(readingAnswerBlocks('### 主干 ###\nA sentence\ncontinues here.\n\n### 成分\n3. Subject\n4) Verb\n- Modifier\n+ Clause\n\n### 关键点\nLast explanation.')).toEqual([
            {kind: 'heading', level: 3, text: '主干'},
            {kind: 'paragraph', text: 'A sentence\ncontinues here.'},
            {kind: 'heading', level: 3, text: '成分'},
            {kind: 'list', ordered: true, start: 3, items: ['Subject', 'Verb']},
            {kind: 'list', ordered: false, start: 1, items: ['Modifier', 'Clause']},
            {kind: 'heading', level: 3, text: '关键点'},
            {kind: 'paragraph', text: 'Last explanation.'},
        ]);
        expect(readingAnswerBlocks('Plain sentence\n- first\n- second')).toEqual([{kind: 'paragraph', text: 'Plain sentence'}, {kind: 'list', ordered: false, start: 1, items: ['first', 'second']}]);
        expect(readingAnswerBlocks('First\n___\nSecond\n***\nThird')).toEqual(['First', 'Second', 'Third'].map(text => ({kind: 'paragraph', text})));
    });
    it('preserves quoted evidence and complete or streaming code without interpreting HTML inside it', () => {
        expect(readingAnswerBlocks('Intro\n> First line\n> **Second**\n\n```html\n  <img src="https://example.test/private">\n# Not a heading\n```\nAfter')).toEqual([
            {kind: 'paragraph', text: 'Intro'}, {kind: 'quote', text: 'First line\n**Second**'},
            {kind: 'code', text: '  <img src="https://example.test/private">\n# Not a heading'}, {kind: 'paragraph', text: 'After'},
        ]);
        expect(readingAnswerBlocks('Intro\n~~~text\nunfinished\n  code')).toEqual([{kind: 'paragraph', text: 'Intro'}, {kind: 'code', text: 'unfinished\n  code'}]);
        expect(readingAnswerBlocks('> quoted')).toEqual([{kind: 'quote', text: 'quoted'}]);
        expect(readingAnswerBlocks('```\n```')).toEqual([{kind: 'code', text: ''}]);
    });
    it('renders old tabular answers as cells, preserving escaped pipes and partial rows during streaming', () => {
        expect(readingAnswerBlocks('Intro\n| 片段 | 作用 |\n| :--- | ---: |\n| `a\\|b` | 主语 |\n| Verb |\n\nNext')).toEqual([
            {kind: 'paragraph', text: 'Intro'},
            {kind: 'table', headers: ['片段', '作用'], rows: [['`a|b`', '主语'], ['Verb']]},
            {kind: 'paragraph', text: 'Next'},
        ]);
        expect(readingAnswerBlocks('Term | Meaning\n--- | ---')).toEqual([{kind: 'table', headers: ['Term', 'Meaning'], rows: []}]);
        expect(readingAnswerBlocks('A | B\nnot | a divider\nFinal | text')).toEqual([{kind: 'paragraph', text: 'A | B\nnot | a divider\nFinal | text'}]);
        expect(readingAnswerBlocks('a | b\n---')).toEqual([{kind: 'paragraph', text: 'a | b'}]);
    });
    it('keeps exact evidence markers in a table cell when the original quote contains pipes or backslashes', () => {
        const sources = buildReadingEvidence('Use a|b and regex \\| when parsing.', '');
        const citation = `[[cite:${sources[0].id}|${sources[0].text}]]`;
        const blocks = readingAnswerBlocks(`Claim | Evidence | Notes\n--- | --- | ---\nUse the expression. | ${citation} | plain\\|pipe and \\path`);
        expect(blocks).toEqual([{kind: 'table', headers: ['Claim', 'Evidence', 'Notes'], rows: [['Use the expression.', citation, 'plain|pipe and \\path']]}]);
        expect(parseReadingEvidence((blocks[0] as Extract<typeof blocks[number], {kind: 'table'}>).rows[0][1], sources)).toEqual([
            expect.objectContaining({kind: 'citation', id: sources[0].id, quote: sources[0].text}),
        ]);
        const incomplete = `[[cite:${sources[0].id}|Use a|b`;
        expect(readingAnswerBlocks(`Claim | Evidence\n--- | ---\nPartial | ${incomplete}`)).toEqual([
            {kind: 'table', headers: ['Claim', 'Evidence'], rows: [['Partial', incomplete]]},
        ]);
        expect(parseReadingEvidence(incomplete, sources)[0].kind).toBe('unavailable');
        expect(readingAnswerBlocks('A | B\n|')).toEqual([{kind: 'paragraph', text: 'A | B\n|'}]);
    });
    it('keeps raw tags and resource syntax inert and formats only complete inline delimiters', () => {
        expect(readingAnswerSpans('**bold** __also__ *em* _italics_ `**code**`')).toEqual([
            {kind: 'strong', text: 'bold'}, {kind: 'text', text: ' '}, {kind: 'strong', text: 'also'}, {kind: 'text', text: ' '},
            {kind: 'emphasis', text: 'em'}, {kind: 'text', text: ' '}, {kind: 'emphasis', text: 'italics'}, {kind: 'text', text: ' '}, {kind: 'code', text: '**code**'},
        ]);
        const unsafe = '<script>alert(1)</script> ![remote](https://example.test/pixel) [run](javascript:alert(1))';
        expect(readingAnswerSpans(unsafe)).toEqual([{kind: 'text', text: unsafe}]);
        for (const partial of ['**', '*', '_', '__', '`', '**unfinished*', 'snake_case_value']) expect(readingAnswerSpans(partial)).toEqual([{kind: 'text', text: partial}]);
        expect(readingAnswerSpans('')).toEqual([]);
        expect(readingAnswerSpans('**ready**')).toEqual([{kind: 'strong', text: 'ready'}]);
    });
    it('does not guess a different sentence for missing or punctuation-only selections', () => {
        expect(sentenceAroundSelection('First sentence. 第二句话！', '第二句', 16)).toBe('第二句话！');
        expect(sentenceAroundSelection('abc', 'missing')).toBe('missing');
        expect(sentenceAroundSelection('!!!', '!')).toBe('!');
        expect(sentenceAroundSelection('First. Second.', 'First. Second.')).toBe('First. Second.');
    });
});

import {anchorSentenceAnalysis, summarizeSentenceRole, describeSentenceRole} from '@/src/features/reading-assistant/sentenceAnalysis';
import {describePartOfSpeech} from '@/src/core/language/partOfSpeech';

describe('grounded part-of-speech annotations', () => {
    const table = (rows: string[][], headers = ['Text', 'POS', 'Role', 'Meaning']) => ({kind: 'table' as const, headers, rows});
    it('anchors repeated words in order and keeps grammatical roles separate', () => {
        const annotations = anchorSentenceAnalysis(table([['The', 'article', '限定名词', '这'], ['reader', 'noun', '主语', '读者'], ['reads', 'verb', '谓语', '读'], ['the', 'article', '限定名词', '这'], ['book', 'noun', '宾语', '书']]), 'The reader reads the book.');
        expect(annotations?.map(item => [item.text, item.part.label, item.start])).toEqual([['The', '冠词', 0], ['reader', '名词', 4], ['reads', '动词', 11], ['the', '冠词', 17], ['book', '名词', 21]]);
        expect(annotations?.[4].role).toBe('宾语');
        expect(anchorSentenceAnalysis(table([['had', 'verb', '谓语', '有'], ['had', 'auxiliary', '助动词', '过去完成']]), 'had had')?.map(item => item.start)).toEqual([0,4]);
    });
    it('does not attach invented, overlapping, reordered or partial words', () => {
        for (const rows of [[['he', 'pronoun', '主语', '他']], [['bird', 'noun', '主语', '鸟']], [['reader', 'noun', '主语', '读者'], ['The', 'article', '限定词', '这']], [['The reader', 'phrase', '主语', '读者'], ['reader', 'noun', '主语', '读者']]]) {
            expect(anchorSentenceAnalysis(table(rows), 'The reader reads.')).toBeNull();
        }
    });
    it('falls back for ordinary tables, incomplete streaming rows and excessive input', () => {
        expect(anchorSentenceAnalysis(table([['The','article','determiner','this']], ['A','B','C','D']), 'The')).toBeNull();
        expect(anchorSentenceAnalysis(table([['The','article','']]), 'The')).toBeNull();
        expect(anchorSentenceAnalysis(table([]), 'The')).toBeNull();
        expect(anchorSentenceAnalysis({kind:'paragraph',text:'hello'}, 'hello')).toBeNull();
        expect(anchorSentenceAnalysis(table([['a','noun','role','meaning']]), 'a'.repeat(4097))).toBeNull();
        expect(anchorSentenceAnalysis(table(Array.from({length:81}, () => ['a','noun','role','meaning'])), 'a '.repeat(81))).toBeNull();
    });
    it('keeps unrecognized POS and hostile text as inert data', () => {
        expect(describePartOfSpeech('art.')).toMatchObject({id:'article', label:'冠词'});
        expect(describePartOfSpeech('r.')).toMatchObject({id:'adverb', label:'副词'});
        expect(describePartOfSpeech('名词')).toMatchObject({id:'noun'});
        expect(describePartOfSpeech('主语')).toMatchObject({id:'other', label:'主语'});
        expect(describePartOfSpeech(null)).toMatchObject({id:'other',label:'其他'});
        const source = '<script>alert(1)</script>';
        const result = anchorSentenceAnalysis(table([[source,'unknown','<img src=x>','text']]), source);
        expect(result?.[0]).toMatchObject({text:source, role:'<img src=x>',part:{id:'other'}});
    });
    it.each([
        ['noun phrase', '名词短语'], ['verb phrase', '动词短语'], ['adjective phrase', '形容词短语'],
        ['adverb phrase', '副词短语'], ['prepositional phrase', '介词短语'], ['infinitive phrase', '不定式短语'],
    ])('normalizes phrase label %s without exposing English labels in Chinese UI', (input, label) => {
        expect(describePartOfSpeech(input).label).toBe(label);
    });
});


import {sentenceAnalysis, sentenceSource} from '@/src/core/config/selectionPreview';
it('renders the offline settings example with the same grounded grammar parser', () => {
    const block = readingAnswerBlocks(sentenceAnalysis)[0];
    expect(anchorSentenceAnalysis(block, sentenceSource)?.map(item => item.part.id))
        .toEqual(['noun', 'verb', 'noun', 'phrase']);
});
it('rejects incomplete annotations, overlong fields and prefixes of longer words', () => {
    const headers = ['Text', 'POS', 'Role', 'Meaning'];
    const make = (row: string[], source = 'a') => anchorSentenceAnalysis({kind:'table', headers, rows:[row]}, source);
    expect(make(['a','noun','subject','meaning'], '')).toBeNull();
    for (const index of [0,1,2,3]) {
        const row = ['a','noun','subject','meaning']; row[index] = '';
        expect(make(row)).toBeNull();
    }
    expect(make(['a'.repeat(301),'noun','role','meaning'], 'a'.repeat(301))).toBeNull();
    expect(make(['a','noun','r'.repeat(401),'meaning'])).toBeNull();
    expect(make(['a','noun','role','m'.repeat(401)])).toBeNull();
    expect(make(['a','noun','role','meaning'], 'apple')).toBeNull();
    expect(make(['a','noun','role','meaning'], 'ba')).toBeNull();
    expect(make(['a','noun','role','meaning'], 'a!')?.[0].text).toBe('a');
    expect(make(['!','unknown','role','meaning'], '!a')?.[0].text).toBe('!');
    expect(anchorSentenceAnalysis({kind:'table',headers:headers.slice(1),rows:[['a','noun','role','meaning']]}, 'a')).toBeNull();
    expect(anchorSentenceAnalysis({kind:'table',headers:['原文片段','词性','句中作用','含义'],rows:[['**a**','`noun`','role','meaning']]}, 'a')?.[0].part.id).toBe('noun');
});
it('normalizes dictionary POS variants without guessing an unknown word class', () => {
    for (const label of ['s.', 'adjective satellite', '形容詞']) expect(describePartOfSpeech(label).id).toBe('adjective');
    expect(describePartOfSpeech('  ')).toMatchObject({id:'other',label:'其他'});
    expect(describePartOfSpeech('x'.repeat(100)).label).toHaveLength(80);
});

it('keeps sentence role summaries grounded in the existing explanation rather than guessing grammar', () => {
    expect(summarizeSentenceRole(' 定语，修饰 printing sequences ')).toBe('定语');
    expect(summarizeSentenceRole('主语')).toBe('主语');
    expect(summarizeSentenceRole('Modifier, describes the subject')).toBe('Modifier');
    expect(summarizeSentenceRole('修饰后面的名词短语')).toBe('修饰后面的名词短语');
    expect(summarizeSentenceRole('并非主语；具体作用取决于上下文')).toBe('并非主语');
    expect(summarizeSentenceRole('未知。需要上下文')).toBe('未知');
    expect(summarizeSentenceRole('Custom role\nMore information')).toBe('Custom role');
    expect(summarizeSentenceRole('，无简短标题')).toBe('，无简短标题');
    expect(summarizeSentenceRole('   ')).toBe('');
});

it('normalizes explicit role names without guessing from an explanation or negation', () => {
    for (const [value, id, label] of [
        ['SUBJECT, identifies the reader', 'subject', '主语'], ['谓语', 'predicate', '谓语'],
        ['direct object', 'object', '宾语'], ['indirect_object', 'indirect-object', '间接宾语'],
        ['post-modifier', 'postmodifier', '后置定语'], ['attribute', 'attribute', '定语'],
        ['adverbial', 'adverbial', '状语'], ['complement', 'complement', '补语'],
        ['modifier', 'modifier', '修饰语'], ['determiner', 'determiner', '限定语'],
        ['主語', 'subject', '主语'], ['후치 수식어', 'postmodifier', '后置定语'],
    ]) expect(describeSentenceRole(value)).toEqual({id, label});
    for (const value of ['', 'not a subject', '并非主语；需结合上下文', 'describes the object', '<img src=x>', '修饰 reader']) {
        expect(describeSentenceRole(value)).toEqual({id: 'other', label: '其他'});
    }
});
it('keeps the reference sentence in four ordered units with punctuation outside the annotations', () => {
    const annotations = anchorSentenceAnalysis(readingAnswerBlocks(sentenceAnalysis)[0], sentenceSource)!;
    expect(annotations.map(item => `${describeSentenceRole(item.role).label} · ${item.part.label}`))
        .toEqual(['主语 · 名词短语', '谓语 · 动词', '宾语 · 名词短语', '后置定语 · 不定式短语']);
    expect(annotations.map(item => item.text)).toEqual(['Every language', 'offers', 'a new way', 'to see the world']);
    expect(sentenceSource.slice(annotations.at(-1)!.end)).toBe('.');
});

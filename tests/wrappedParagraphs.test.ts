/**
 * @file tests/wrappedParagraphs.test.ts
 * 文件职责：验证手动折行多行段落（Markdown 与 git commit message）的软换行与硬换行自动展开算法。
 * 主要内容：覆盖 Issue #1383 示例的 git commit message、行内代码跨折行、中日韩无空格折行、空行分段、Markdown 显式硬换行（双空格与反斜杠）、围栏代码块、数学块、标题与 Setext 下划线、引用块与 callout、列表项及缩进续行、表格、容器指令、独立 HTML、git trailer、代码行、全大写标题、短行与独立单句的保护。
 * 模块边界：只测试 src/core/translation/wrappedParagraphs 的纯文本函数，不涉及 DOM、存储或网络请求。
 */
import {describe, expect, it} from 'vitest';
import {normalizeParagraphTranslationSource, unwrapSoftLineBreaks, unwrapWrappedParagraphs} from '@/src/core/translation/public';

const ISSUE_1383_COMMIT_MESSAGE = [
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

const ISSUE_1383_EXPECTED = [
    'The opaque rect that we report to the compositor is derived from the opaque rectangle of the render node, shrunk to whole surface pixels. The surface contents are rendered into a buffer that is scaled by the ratio between the buffer and the surface, so that ratio is often fractional, and the edges of the rect then land within buffer pixels: the outermost buffer pixel is only partially covered even though the rect claims that it is opaque. A compositor that disables blending for the opaque region then shows that partial coverage as a line along the window edges.',
    '',
    'Keep the edges that cannot be proven opaque out of the region in `gdk_surface_set_opaque_rect()`, using the exact buffer to surface ratio. Only the misaligned edges are affected, so a window that fills its buffer exactly - such as a maximized window - keeps reporting its full opaque area, and compositors can still cull windows that it covers.',
].join('\n');

describe('unwrapSoftLineBreaks', () => {
    it('returns single-line text unchanged and unwraps HTML soft line breaks across scripts', () => {
        expect(unwrapSoftLineBreaks('Plain line without breaks.')).toBe('Plain line without breaks.');
        expect(unwrapSoftLineBreaks('First part of a sentence\nsecond part of a sentence.')).toBe('First part of a sentence second part of a sentence.');
        expect(unwrapSoftLineBreaks('第一行中文内容\r\n第二行中文内容。')).toBe('第一行中文内容第二行中文内容。');
        expect(unwrapSoftLineBreaks('𠀀𠀀\r𠀁𠀁')).toBe('𠀀𠀀𠀁𠀁');
        expect(unwrapSoftLineBreaks('中文接英文\nword continues.')).toBe('中文接英文 word continues.');
        expect(normalizeParagraphTranslationSource('Single line', false)).toBe('Single line');
        expect(normalizeParagraphTranslationSource('First line\nsecond line', false)).toBe('First line second line');
        expect(normalizeParagraphTranslationSource('Short\nline', true)).toBe('Short\nline');
        expect(normalizeParagraphTranslationSource(ISSUE_1383_COMMIT_MESSAGE, true)).toBe(ISSUE_1383_EXPECTED);
    });
});

describe('unwrapWrappedParagraphs', () => {
    it('unwraps the Issue #1383 git commit message into two clean paragraphs across line ending styles', () => {
        expect(unwrapWrappedParagraphs('Single line only.')).toBe('Single line only.');
        expect(unwrapWrappedParagraphs(ISSUE_1383_COMMIT_MESSAGE)).toBe(ISSUE_1383_EXPECTED);
        expect(unwrapWrappedParagraphs(ISSUE_1383_COMMIT_MESSAGE.replaceAll('\n', '\r\n')))
            .toBe(ISSUE_1383_EXPECTED.replaceAll('\n', '\r\n'));
        expect(unwrapWrappedParagraphs(ISSUE_1383_COMMIT_MESSAGE.replaceAll('\n', '\r')))
            .toBe(ISSUE_1383_EXPECTED.replaceAll('\n', '\r'));
    });

    it('unwraps early-wrapped lines before long identifiers, colon continuations, CJK prose, and inline code spans', () => {
        expect(unwrapWrappedParagraphs('Keep the edges out of the region in\n`gdk_surface_set_opaque_rect()`, using exact ratios.'))
            .toBe('Keep the edges out of the region in `gdk_surface_set_opaque_rect()`, using exact ratios.');
        expect(unwrapWrappedParagraphs('The edges of the rect land within buffer pixels:\nthe outermost buffer pixel is only partially covered.'))
            .toBe('The edges of the rect land within buffer pixels: the outermost buffer pixel is only partially covered.');
        expect(unwrapWrappedParagraphs('有些 markdown 内容或者 git commit message 为了避免单行过长，\n会对单段落进行手动换行，我们翻译的时候应该将其视作一段。'))
            .toBe('有些 markdown 内容或者 git commit message 为了避免单行过长，会对单段落进行手动换行，我们翻译的时候应该将其视作一段。');
        expect(unwrapWrappedParagraphs('在继续配置之前请参阅 https://example.com/帮助\n然后继续阅读其余段落内容并保持正常语序。'))
            .toBe('在继续配置之前请参阅 https://example.com/帮助 然后继续阅读其余段落内容并保持正常语序。');
        expect(unwrapWrappedParagraphs('This paragraph wraps inside a `multi\nline` inline code span and keeps wrapping\nonto the final line of prose.'))
            .toBe('This paragraph wraps inside a `multi line` inline code span and keeps wrapping onto the final line of prose.');
        expect(unwrapWrappedParagraphs('This paragraph uses ``double `backtick`\nwrapped code`` in the middle of a long\nwrapped sentence here.'))
            .toBe('This paragraph uses ``double `backtick` wrapped code`` in the middle of a long wrapped sentence here.');
        expect(unwrapWrappedParagraphs('\tIndented with a tab counts as four columns so\n\tit stays untouched as an indented code block.'))
            .toBe('\tIndented with a tab counts as four columns so\n\tit stays untouched as an indented code block.');
        expect(unwrapWrappedParagraphs('Some paragraph text that ends right before a blank\n   \nAnother paragraph starts here.'))
            .toBe('Some paragraph text that ends right before a blank\n   \nAnother paragraph starts here.');
    });

    it('unwraps wrapped blockquotes and indented list item continuations while preserving sibling items', () => {
        const quoted = [
            '> The opaque rect that we report to the compositor is derived from the',
            '> opaque rectangle of the render node, shrunk to whole surface pixels.',
            '>',
            '> [!NOTE]',
            '> Keep the callout header separate from the wrapped body line that is',
            '> long enough to wrap cleanly onto a second line.',
            '> > Nested quote line stays untouched.',
        ].join('\n');
        expect(unwrapWrappedParagraphs(quoted)).toBe([
            '> The opaque rect that we report to the compositor is derived from the opaque rectangle of the render node, shrunk to whole surface pixels.',
            '>',
            '> [!NOTE]',
            '> Keep the callout header separate from the wrapped body line that is long enough to wrap cleanly onto a second line.',
            '> > Nested quote line stays untouched.',
        ].join('\n'));

        const list = [
            '- First list item is long enough to wrap cleanly onto the next',
            '  indented continuation line in Markdown.',
            '  ```js',
            '  const x = 1;',
            '  ```',
            '- Second short item',
            '- Third item',
            '  short tail',
            '- Fourth item followed by nested list and quote and math and deep indent',
            '  - Nested child item',
            '- Fifth item before quote',
            '  > Quoted child line',
            '- Sixth item before math',
            '  $$',
            '  x = 1',
            '  $$',
            '- Seventh item before structure',
            '  Signed-off-by: Alice <alice@example.com>',
            '- Eighth item before deep code indent',
            '      indented code block inside list',
        ].join('\n');
        expect(unwrapWrappedParagraphs(list)).toBe([
            '- First list item is long enough to wrap cleanly onto the next indented continuation line in Markdown.',
            '  ```js',
            '  const x = 1;',
            '  ```',
            '- Second short item',
            '- Third item',
            '  short tail',
            '- Fourth item followed by nested list and quote and math and deep indent',
            '  - Nested child item',
            '- Fifth item before quote',
            '  > Quoted child line',
            '- Sixth item before math',
            '  $$',
            '  x = 1',
            '  $$',
            '- Seventh item before structure',
            '  Signed-off-by: Alice <alice@example.com>',
            '- Eighth item before deep code indent',
            '      indented code block inside list',
        ].join('\n'));
    });

    it('preserves fenced code blocks, math blocks, hard breaks, headings, tables, trailers, code lines, and short lines', () => {
        const doc = [
            'Short title',
            '===========',
            '',
            'MEETING NOTES FOR THE COMPOSITOR ARCHITECTURE REVIEW',
            'Attendees: Dana, Luis, Mei',
            '',
            'Explicit trailing-space hard break that is long enough to look wrapped  ',
            'Second line after two spaces.',
            'Explicit backslash hard break that is long enough to look wrapped\\',
            'Third line after backslash.',
            '',
            '```ts',
            'const opaqueRectThatWeReportToTheCompositor = shrinkToWholeSurfacePixels(',
            '  renderNodeOpaqueRect',
            ')',
            '```',
            '',
            '~~~',
            'unclosed tilde fence line one that is quite long and should stay untouched',
            'unclosed tilde fence line two',
            '~~~',
            '',
            '$$',
            'a + b + c + d + e + f + g + h + i + j + k + l + m + n',
            'x + y + z',
            '$$',
            '',
            '| Column A that is quite long to look wrapped | Column B |',
            '| --- | --- |',
            '| Cell text that is long enough to wrap | Another |',
            '',
            'Signed-off-by: Alice <alice@example.com>',
            'Reviewed-by: Bob <bob@example.com>',
            'Closes: #1383',
            '',
            '    Indented four spaces code block line that is quite long in width',
            '    continues on a second indented four spaces code line.',
            '',
            'const value = computeOpaqueRect(surface, buffer);',
            'return value;',
            '',
            'hello world',
            'again',
            '',
            'This line is long enough and ends its sentence here.',
            'This one starts another sentence of similar length.',
        ].join('\n');
        expect(unwrapWrappedParagraphs(doc)).toBe(doc);
    });

    it('keeps mid-block sentence endings split when a short sentence ends well before the wrap column', () => {
        const text = [
            'The first line is long enough to wrap cleanly onto the following line',
            'here.',
            'Then a new sentence starts on its own line after the short ending.',
        ].join('\n');
        expect(unwrapWrappedParagraphs(text)).toBe([
            'The first line is long enough to wrap cleanly onto the following line here.',
            'Then a new sentence starts on its own line after the short ending.',
        ].join('\n'));

        const trailingHardBreakAfterMidWrap = [
            'The first line is long enough to wrap cleanly onto the following line',
            'and the second line is also long enough but ends with a hard break  ',
            'so this third line stays separated.',
        ].join('\n');
        expect(unwrapWrappedParagraphs(trailingHardBreakAfterMidWrap)).toBe([
            'The first line is long enough to wrap cleanly onto the following line and the second line is also long enough but ends with a hard break  ',
            'so this third line stays separated.',
        ].join('\n'));

        // 未闭合的代码块与数学块保持原样到末尾。
        expect(unwrapWrappedParagraphs('```\nlong unclosed fence line one that should never unwrap\nline two')).toBe(
            '```\nlong unclosed fence line one that should never unwrap\nline two',
        );
        expect(unwrapWrappedParagraphs('$$\nlong unclosed math line one that should never unwrap\nline two')).toBe(
            '$$\nlong unclosed math line one that should never unwrap\nline two',
        );
        // 含未闭合的反引号时也能安全合并，不抛错。
        expect(unwrapWrappedParagraphs('A wrapped paragraph with an unmatched `backtick token that is long\nenough to continue onto the next line.')).toBe(
            'A wrapped paragraph with an unmatched `backtick token that is long enough to continue onto the next line.',
        );
        // 短段落总宽度低于整块门槛时，句末换行不会强行合并。
        expect(unwrapWrappedParagraphs('Short wrap before a verylongidentifiertoken.\nNext sentence here.\nShort wrap before a verylongidentifiertoken\ncontinues.')).toBe(
            'Short wrap before a verylongidentifiertoken.\nNext sentence here.\nShort wrap before a verylongidentifiertoken continues.',
        );
        // 围栏内嵌套更短或不同字符的围栏标记不提前闭合；正文后紧邻各类块边界立即断开。
        const fenceAndBoundaries = [
            '````md',
            '```',
            '~~~',
            '````',
            'Prose line before fence that is long enough to look wrapped',
            '```',
            'code',
            '```',
            'Prose line before math that is long enough to look wrapped',
            '$$',
            'x = 1',
            '$$',
            'Prose line before quote that is long enough to look wrapped',
            '> Quoted line',
            'Prose line before list that is long enough to look wrapped',
            '- List item',
            'Prose line before heading that is long enough to look wrapped',
            '# Heading',
            'Prose line before indented line that is long enough to look wrapped',
            '  Indented differently',
        ].join('\n');
        expect(unwrapWrappedParagraphs(fenceAndBoundaries)).toBe(fenceAndBoundaries);
    });
});

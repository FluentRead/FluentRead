import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';
import {
    PARAGRAPH_COPY_BLOCK_SELECTOR,
    composeParagraphCopyText,
    findCopyableBlock,
    readParagraphTexts,
} from '@/src/features/paragraph-copy/core';

function domFrom(html: string) {
    const {document} = parseHTML(`<html><body>${html}</body></html>`);
    return document;
}

describe('段落复制取词', () => {
    it('空代码块与空双语工件不制造译文形态或额外正文', () => {
        const document = domFrom('<div id="target"><pre>\n  \n</pre><p>Plain text<span class="fluent-read-bilingual-content" data-fr-translation-owned="true"> \n </span></p></div>');
        expect(readParagraphTexts(document.getElementById('target')!)).toEqual({original: 'Plain text', translation: '', display: 'original'});
    });
    it('极深的行内 DOM 仍完整复制文字，不耗尽调用栈', () => {
        const document = domFrom('<p id="target"></p>');
        const root = document.getElementById('target')!;
        let leaf = root;
        for (let depth = 0; depth < 12_000; depth++) {
            const next = document.createElement('span');
            leaf.appendChild(next);
            leaf = next;
        }
        leaf.textContent = 'Deep text';
        expect(readParagraphTexts(root)).toEqual({original: 'Deep text', translation: '', display: 'original'});
    });

    it('大量独立译文保持文档顺序，归属检查工作量随节点数线性增长', () => {
        const count = 300;
        const document = domFrom(`<article id="target">${Array.from({length: count}, (_, i) =>
            `<p>Original ${i}<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文 ${i}</span></p>`,
        ).join('')}</article>`);
        const root = document.getElementById('target')!;
        const owners = [...root.querySelectorAll('.fluent-read-bilingual-content')];
        const probes = owners.map((owner) => vi.spyOn(owner, 'contains'));
        try {
            const texts = readParagraphTexts(root);
            expect(texts.translation).toBe(Array.from({length: count}, (_, i) => `译文 ${i}`).join('\n'));
            expect(texts.original).toBe(Array.from({length: count}, (_, i) => `Original ${i}`).join('\n'));
            expect(probes.reduce((total, probe) => total + probe.mock.calls.length, 0)).toBeLessThanOrEqual(count);
        } finally {
            for (const probe of probes) probe.mockRestore();
        }
    });

    it('原文跳过译文包裹层、加载指示器和插件界面', () => {
        const document = domFrom(`<p id="target">Hello <em>world</em>
            <span class="fluent-read-loading">…</span>
            <span class="fluent-read-bilingual-content" data-fr-translation-owned="true">你好世界</span>
            <span data-fluent-read-ui="toolbar">设置</span>
        </p>`);
        const texts = readParagraphTexts(document.getElementById('target')!);

        expect(texts.original).toBe('Hello world');
        expect(texts.translation).toBe('你好世界');
        expect(texts.display).toBe('bilingual');
    });

    it('仅译文模式从轻 DOM 读原文，从 aria-label 读译文', () => {
        const document = domFrom(`<p id="target"><span class="fluent-read-single-slot" data-fr-translation-owned="true" aria-label="你好">Hello</span> <span class="fluent-read-single-slot" data-fr-translation-owned="true" aria-label="世界">world</span></p>`);
        const texts = readParagraphTexts(document.getElementById('target')!);

        expect(texts.original).toBe('Hello world');
        expect(texts.translation).toBe('你好\n世界');
        expect(texts.display).toBe('translation');
    });

    it('未翻译段落只有原文，空的译文槽不改变显示形态', () => {
        const document = domFrom(`<p id="target">Plain text<span class="fluent-read-single-slot" data-fr-translation-owned="true" aria-label="  ">slot</span></p>`);
        const texts = readParagraphTexts(document.getElementById('target')!);

        expect(texts).toEqual({original: 'Plain textslot', translation: '', display: 'original'});
    });

    it('块级元素之间换行，代码块保留原有缩进和空行', () => {
        const document = domFrom(`<div id="target"><h2>标题</h2><p>第一段</p><pre>
const a = 1;
  const b = 2;
</pre><ul><li>甲</li><li>乙</li></ul></div>`);
        const texts = readParagraphTexts(document.getElementById('target')!);

        expect(texts.original).toBe('标题\n第一段\nconst a = 1;\n  const b = 2;\n甲\n乙');
    });

    it.each(['', '<p> 说明 </p>'])('代码块在段落开头或说明之后保留首行缩进及连续空行：%s', prefix => {
        const code = '    first line\n\n\n    fourth line';
        const document = domFrom(`<div id="target">${prefix}<pre>${code}</pre><p> 结束 </p></div>`);
        const root = document.getElementById('target')!;
        expect(readParagraphTexts(root).original).toBe(`${prefix ? '说明\n' : ''}${code}\n结束`);
        expect(readParagraphTexts(root.querySelector('pre')!).original).toBe(code);
    });

    it('不重复采集嵌套在译文内部的插件节点，并忽略脚本与样式', () => {
        const document = domFrom(`<div id="target"><script>var a = 1;</script><style>.x{}</style>原文<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文<span class="fluent-read-single-slot" data-fr-translation-owned="true" aria-label="忽略">inner</span></span></div>`);
        const texts = readParagraphTexts(document.getElementById('target')!);

        expect(texts.original).toBe('原文');
        expect(texts.translation).toBe('译文inner');
    });

    it('<br> 换行成为段落内的换行，缺少 aria-label 的译文槽被忽略', () => {
        const document = domFrom('<p id="target">第一行<br>第二行<span class="fluent-read-single-slot" data-fr-translation-owned="true">槽</span></p>');
        const texts = readParagraphTexts(document.getElementById('target')!);

        expect(texts.original).toBe('第一行\n第二行槽');
        expect(texts.translation).toBe('');
    });

    it('异常节点不会中断取词：标签名缺失、文本为空都按空白处理', () => {
        const strange = {
            nodeType: 1,
            childNodes: [{nodeType: 3, nodeValue: null}, {nodeType: 8}],
        } as unknown as Element;

        expect(readParagraphTexts(strange)).toEqual({original: '', translation: '', display: 'original'});
    });

    it('读取译文时同样跳过嵌在其中的插件界面节点', () => {
        const document = domFrom('<p id="target">原文<span class="fluent-read-bilingual-content" data-fr-translation-owned="true">译文<span data-fluent-read-ui="retry">重试</span></span></p>');
        const texts = readParagraphTexts(document.getElementById('target')!);

        expect(texts.translation).toBe('译文');
    });

    it('没有 querySelectorAll 的节点按未翻译处理', () => {
        const document = domFrom('<p id="target">Text</p>');
        const element = document.getElementById('target')!;
        Object.defineProperty(element, 'querySelectorAll', {value: undefined});

        expect(readParagraphTexts(element)).toEqual({original: 'Text', translation: '', display: 'original'});
    });
});

describe('段落复制的候选兜底', () => {
    it('从命中的行内节点向上取最近的块级元素', () => {
        const document = domFrom('<article><p id="target">Hello <em id="inner">world</em></p></article>');

        expect(PARAGRAPH_COPY_BLOCK_SELECTOR).toContain('pre');
        expect(findCopyableBlock(document.getElementById('inner'))).toBe(document.getElementById('target'));
    });

    it('命中 FluentRead 自己的界面时不复制', () => {
        const document = domFrom('<div id="fluent-read-floating-ball-container"><button id="inner">翻译</button></div>');

        expect(findCopyableBlock(document.getElementById('inner'))).toBeNull();
        expect(findCopyableBlock(document.getElementById('fluent-read-floating-ball-container'))).toBeNull();
        expect(findCopyableBlock(null)).toBeNull();
        expect(findCopyableBlock(undefined)).toBeNull();
    });

    it('没有块级祖先时，只有本身带文字才作为复制目标', () => {
        const document = domFrom('<span id="with-text">文字</span>');
        const withText = document.getElementById('with-text')!;
        const empty = document.createElement('span');

        expect(findCopyableBlock(withText)).toBe(withText);
        expect(findCopyableBlock(empty)).toBeNull();
        expect(findCopyableBlock({} as unknown as Element)).toBeNull();
        expect(findCopyableBlock({closest: () => null} as unknown as Element)).toBeNull();
    });
});

describe('段落复制的内容口径', () => {
    const translated = {original: '原文', translation: '译文', display: 'bilingual'} as const;

    it('跟随显示形态：双语复制两段，仅译文复制译文，未翻译复制原文', () => {
        expect(composeParagraphCopyText(translated, 'auto')).toEqual({text: '原文\n译文', kind: 'bilingual', missingTranslation: false});
        expect(composeParagraphCopyText({...translated, display: 'translation'}, 'auto'))
            .toEqual({text: '译文', kind: 'translation', missingTranslation: false});
        expect(composeParagraphCopyText({original: '原文', translation: '', display: 'original'}, 'auto'))
            .toEqual({text: '原文', kind: 'original', missingTranslation: false});
    });

    it('双语顺序跟随译文位置设置', () => {
        expect(composeParagraphCopyText(translated, 'bilingual', true)?.text).toBe('译文\n原文');
        expect(composeParagraphCopyText(translated, 'bilingual', false)?.text).toBe('原文\n译文');
    });

    it('显式选择译文而段落尚未翻译时回退原文并标记出来', () => {
        const untranslated = {original: '原文', translation: '', display: 'original'} as const;

        expect(composeParagraphCopyText(untranslated, 'translation'))
            .toEqual({text: '原文', kind: 'original', missingTranslation: true});
        expect(composeParagraphCopyText(untranslated, 'bilingual'))
            .toEqual({text: '原文', kind: 'original', missingTranslation: true});
    });

    it('强制复制原文，并在原文为空时只给出译文', () => {
        expect(composeParagraphCopyText(translated, 'original'))
            .toEqual({text: '原文', kind: 'original', missingTranslation: false});
        expect(composeParagraphCopyText({original: '', translation: '译文', display: 'bilingual'}, 'auto'))
            .toEqual({text: '译文', kind: 'translation', missingTranslation: false});
    });

    it('既没有原文也没有译文时不写入剪贴板', () => {
        expect(composeParagraphCopyText({original: '', translation: '', display: 'original'}, 'auto')).toBeNull();
    });
});

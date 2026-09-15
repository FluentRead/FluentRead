import {parseHTML} from 'linkedom';
import {describe, expect, it} from 'vitest';

import {
    applyTranslationsToSnapshot,
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
    extractTranslationText,
} from '@/src/core/translation/public';
import {isForeignTranslationBoundary} from '@/src/core/translation/dom';
import {isTranslationTextNodeProtected} from '@/src/core/translation/text';

describe('translation snapshot mapping performance', () => {
    it('maps a large flat candidate with linear tree-walker work and no sibling path scans', () => {
        const {document} = parseHTML('<html><body><div id="target"></div></body></html>');
        const target = document.querySelector('#target') as HTMLElement;
        const slotCount = 4000;
        for (let index = 0; index < slotCount; index += 1) {
            const span = document.createElement('span');
            span.appendChild(document.createTextNode(`  Source ${index}  `));
            target.appendChild(span);
        }

        const code = document.createElement('code');
        code.textContent = 'PROTECTED_CODE';
        target.appendChild(code);
        const noTranslate = document.createElement('span');
        noTranslate.setAttribute('translate', 'no');
        noTranslate.textContent = 'PROTECTED_LABEL';
        target.appendChild(noTranslate);
        const artifact = document.createElement('span');
        artifact.className = 'fluent-read-bilingual-content';
        artifact.textContent = 'OLD_TRANSLATION';
        target.appendChild(artifact);

        const originalCreateTreeWalker = document.createTreeWalker.bind(document);
        const originalIndexOf = Array.prototype.indexOf;
        let treeWalkerSteps = 0;
        let siblingPathScans = 0;
        document.createTreeWalker = ((...args: Parameters<Document['createTreeWalker']>) => {
            const walker = originalCreateTreeWalker(...args);
            const nextNode = walker.nextNode.bind(walker);
            walker.nextNode = () => {
                treeWalkerSteps += 1;
                return nextNode();
            };
            return walker;
        }) as Document['createTreeWalker'];
        Array.prototype.indexOf = function instrumentedIndexOf(...args: Parameters<typeof originalIndexOf>) {
            if (this?.constructor?.name === 'NodeList') siblingPathScans += 1;
            return originalIndexOf.apply(this, args);
        };

        let snapshot: ReturnType<typeof createTranslationSourceSnapshot>;
        try {
            snapshot = createTranslationSourceSnapshot(target);
        } finally {
            document.createTreeWalker = originalCreateTreeWalker;
            Array.prototype.indexOf = originalIndexOf;
        }

        const totalTextNodes = slotCount + 3;
        expect(treeWalkerSteps).toBe((totalTextNodes + 1) * 2);
        expect(siblingPathScans).toBe(0);
        expect(snapshot.slots).toHaveLength(slotCount);
        expect(snapshot.slots[0]).toMatchObject({prefix: '  ', source: 'Source 0', suffix: '  '});
        expect(snapshot.slots.at(-1)).toMatchObject({source: `Source ${slotCount - 1}`});
        expect(snapshot.slots[0]?.node).not.toBe(target.querySelector('span')?.firstChild);
        expect(snapshot.clone.querySelector('code')?.textContent).toBe('PROTECTED_CODE');
        expect(snapshot.clone.querySelector('[translate="no"]')?.textContent).toBe('PROTECTED_LABEL');
        expect(snapshot.clone.querySelector('.fluent-read-bilingual-content')).toBeNull();

        const rendered = applyTranslationsToSnapshot(
            snapshot,
            snapshot.slots.map((_, index) => `Translated ${index}`),
        );
        expect(rendered).toContain('  Translated 0  ');
        expect(rendered).toContain(`  Translated ${slotCount - 1}  `);
        expect(target.querySelector('span')?.textContent).toBe('  Source 0  ');
    });

    it('长文章提取只为共享祖先读取一次样式，外部译文边界不扫描整棵后代树', () => {
        const {document, window} = parseHTML('<html><body><main><article id="article"></article></main></body></html>');
        const article = document.querySelector('#article') as HTMLElement;
        const paragraphs = 300;
        for (let index = 0; index < paragraphs; index += 1) {
            const paragraph = document.createElement('p');
            paragraph.innerHTML = `Paragraph ${index} has <a href="#">a link</a>, <strong>strong text</strong> and <em>emphasis</em> to read.`;
            article.append(paragraph);
        }
        const hidden = document.createElement('p');
        hidden.setAttribute('aria-hidden', 'true');
        hidden.textContent = 'HIDDEN_TEXT';
        article.append(hidden);
        const foreign = document.createElement('p');
        foreign.innerHTML = 'Foreign source.<font class="immersive-translate-target-wrapper"><font>外部译文</font></font>';
        article.append(foreign);
        const nested = document.createElement('div');
        nested.innerHTML = '<span>Nested owner keeps text.<font class="immersive-translate-target-wrapper">嵌套外部译文</font></span>';
        article.append(nested);

        let styleReads = 0;
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: () => {
            styleReads += 1;
            return {display: 'block', visibility: 'visible', position: 'static', fontFamily: 'serif'};
        }});
        const originalQuerySelector = window.Element.prototype.querySelector;
        let subtreeQueries = 0;
        window.Element.prototype.querySelector = function instrumented(this: Element, selector: string) {
            subtreeQueries += 1;
            return originalQuerySelector.call(this, selector);
        };
        let text = '';
        let slots: ReturnType<typeof collectLiveTranslationTextSlots> = [];
        try {
            text = extractTranslationText(article);
            const afterExtraction = styleReads;
            slots = collectLiveTranslationTextSlots(article);
            // 元素总数只有 1 个 article + 每段 4 个元素 + 3 个附加块的规模；旧实现会按
            // “文本节点 × 祖先深度” 反复读取 article/main 的样式并扫描整篇文章。
            const elementCount = article.querySelectorAll('*').length + 1;
            expect(afterExtraction).toBeLessThanOrEqual(elementCount + 3);
            expect(styleReads - afterExtraction).toBeLessThanOrEqual(elementCount + 3);
            expect(subtreeQueries).toBe(0);
        } finally {
            window.Element.prototype.querySelector = originalQuerySelector;
        }

        expect(text).toContain('Paragraph 0 has a link , strong text and emphasis to read.');
        expect(text).toContain(`Paragraph ${paragraphs - 1} has`);
        expect(text).not.toMatch(/HIDDEN_TEXT|Foreign source|外部译文/u);
        // 外部 wrapper 只接管直属父级；更外层的包裹块仍保留自己的其他文本。
        expect(isForeignTranslationBoundary(nested)).toBe(false);
        expect(isForeignTranslationBoundary(nested.firstElementChild!)).toBe(true);
        expect(slots.map(slot => slot.source)).not.toContain('Foreign source.');
        expect(slots.filter(slot => slot.source.startsWith('Paragraph '))).toHaveLength(paragraphs);
    });

    it('缓存后的文本保护仍只放行调用方指定的扩展元素自身', () => {
        const {document} = parseHTML('<html><body><div data-fluent-read-ui="true" id="panel"><p>Panel copy for translation.</p><span class="notranslate">Brand</span></div></body></html>');
        const panel = document.querySelector('#panel') as HTMLElement;
        expect(extractTranslationText(panel)).toBe('');
        expect(extractTranslationText(panel, undefined, panel)).toBe('Panel copy for translation.');
        const brand = panel.querySelector('.notranslate')!.firstChild as Text;
        expect(isTranslationTextNodeProtected(brand, undefined, panel)).toBe(true);
        expect(collectLiveTranslationTextSlots(panel, undefined, panel).map(slot => slot.source)).toEqual(['Panel copy for translation.']);
    });
});

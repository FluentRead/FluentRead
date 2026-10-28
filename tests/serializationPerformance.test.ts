import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';

import {
    applyTranslationsToSnapshot,
    collectLiveTranslationTextSlots,
    createTranslationSourceSnapshot,
    extractTranslationText,
    parseTranslationSlots,
    serializeTranslationSlots,
} from '@/src/core/translation/public';
import {isForeignTranslationBoundary} from '@/src/core/translation/dom';
import {rebuildTranslationSlots} from '@/src/core/translation/slotProtocol';
import {
    createTranslationTextProtectionCache,
    isTranslationTextElementProtected,
    isTranslationTextNodeProtected,
} from '@/src/core/translation/text';

describe('translation snapshot mapping performance', () => {
    it('大段纯空白不运行可能反复回溯的文本槽正则，可读文本仍保留精确空白', () => {
        const {document} = parseHTML('<html><body><div id="root"></div></body></html>');
        const root = document.querySelector('#root')! as HTMLElement;
        const blank = ' \n\t\u00a0\ufeff'.repeat(2400);
        root.append(document.createTextNode(blank));
        root.append(document.createTextNode(' \u00a0Visible\u200b text\ufeff '));
        const match = String.prototype.match;
        let expensiveWhitespaceMatches = 0;
        const spy = vi.spyOn(String.prototype, 'match').mockImplementation(function (this: string, pattern) {
            if (String(this) === blank && pattern instanceof RegExp && pattern.source === '^(\\s*)([\\s\\S]*?\\S)(\\s*)$') expensiveWhitespaceMatches += 1;
            return match.call(this, pattern);
        });
        try {
            const slots = collectLiveTranslationTextSlots(root);
            expect(slots).toHaveLength(1);
            expect(slots[0]).toMatchObject({prefix: ' \u00a0', source: 'Visible\u200b text', suffix: '\ufeff '});
            const snapshot = createTranslationSourceSnapshot(root);
            expect(snapshot.slots).toHaveLength(1);
            expect(snapshot.slots[0]).toMatchObject({prefix: ' \u00a0', source: 'Visible\u200b text', suffix: '\ufeff '});
            expect(expensiveWhitespaceMatches).toBe(0);
        } finally { spy.mockRestore(); }
    });

    it('空白预检边界仍保留长缩进、零宽字符和尾部空格', () => {
        const {document} = parseHTML('<html><body><div id="root"></div></body></html>');
        const root = document.querySelector('#root')! as HTMLElement;
        for (const size of [63, 64, 65]) root.append(document.createTextNode(' '.repeat(size)));
        root.append(document.createTextNode(`${' '.repeat(65)}Hello\u200b world\u00a0`));
        const slots = collectLiveTranslationTextSlots(root);
        expect(slots).toHaveLength(1);
        expect(slots[0]).toMatchObject({prefix: ' '.repeat(65), source: 'Hello\u200b world', suffix: '\u00a0'});
    });

    it('rebuilds translated slots with the original packet, including empty and whitespace values', () => {
        const literal = '___FLUENTREAD_literal_0_BEGIN___文字___FLUENTREAD_literal_0_END___';
        const packet = serializeTranslationSlots(['First', 'Second', 'Third'], 'fixed');
        const original = structuredClone(packet);
        const values = [literal, '', ' \n\t '];
        const payload = rebuildTranslationSlots(packet, values)!;
        expect(parseTranslationSlots(packet, payload)).toEqual(values);
        expect(packet).toEqual(original);
        expect(rebuildTranslationSlots(serializeTranslationSlots([]), [])).toBe('');
        const custom = {payload: '', starts: ['<a>'], ends: ['</a>']};
        expect(rebuildTranslationSlots(custom, ['文字'])).toBe('<a>文字</a>');
    });

    it('rejects wrong cardinality, missing ends and active markers rather than renaming the result namespace', () => {
        const packet = serializeTranslationSlots(['First', 'Second'], 'fixed');
        expect(rebuildTranslationSlots(packet, ['one'])).toBeNull();
        expect(rebuildTranslationSlots({...packet, ends: []}, ['one', 'two'])).toBeNull();
        for (const marker of [...packet.starts, ...packet.ends]) {
            expect(rebuildTranslationSlots(packet, [`one${marker}`, 'two'])).toBeNull();
        }
        expect(rebuildTranslationSlots(packet, [`${packet.starts[1]}one${packet.ends[0]}`, 'two'])).toBeNull();
        expect(rebuildTranslationSlots({payload: '', starts: [''], ends: ['</a>']}, ['one'])).toBeNull();
    });

    it('共享父级已判定后仍复核普通叶子和禁译元素，下一轮读取宿主变化', () => {
        const {document} = parseHTML('<html><body><p>Source <span>inline</span><code>code</code><span translate="no">label</span></p></body></html>');
        const owner = document.querySelector('p')!;
        const originalHTML = owner.innerHTML;
        const cache = createTranslationTextProtectionCache();
        const checked: Element[] = [];
        const shouldStayOriginal = (element: Element) => {checked.push(element); return false;};
        expect(isTranslationTextElementProtected(owner, shouldStayOriginal, cache)).toBe(false);
        checked.length = 0;
        const nodes = [owner.firstChild!, ...Array.from(owner.children).map(element => element.firstChild!)] as Text[];
        expect(nodes.map(node => isTranslationTextNodeProtected(node, shouldStayOriginal, undefined, undefined, cache)))
            .toEqual([false, false, true, true]);
        expect(checked).toEqual([owner.children[0]]);
        expect(owner.innerHTML).toBe(originalHTML);
        expect(nodes.every((node, index) => node === (index === 0 ? owner.firstChild : owner.children[index - 1]!.firstChild)))
            .toBe(true);
        expect(extractTranslationText(owner)).toBe('Source inline');
        owner.children[0]!.setAttribute('translate', 'no');
        expect(extractTranslationText(owner)).toBe('Source');
    });

    it('已缓存父级仍调用站点叶子保护回调，并使用来源节点自己的文档', () => {
        const {document} = parseHTML('<html><body><p><span>Allowed source</span><em>Keep original</em></p></body></html>');
        const owner = document.querySelector('p')!;
        const checked: Element[] = [];
        const shouldStayOriginal = (element: Element) => {
            checked.push(element);
            return element === owner.lastElementChild;
        };
        expect(extractTranslationText(owner, shouldStayOriginal)).toBe('Allowed source');
        expect(checked.indexOf(owner.firstElementChild!)).toBeLessThan(checked.indexOf(owner.lastElementChild!));
        const {document: hiddenDocument, window} = parseHTML('<html><body><p><span>Other document</span></p></body></html>');
        const style = vi.fn(() => ({display: 'none', visibility: 'visible', fontFamily: 'serif'}));
        const previous = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
        try {
            Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: style});
            expect(extractTranslationText(hiddenDocument.querySelector('p')!)).toBe('');
            expect(style).toHaveBeenCalled();
        } finally {
            if (previous) Object.defineProperty(window, 'getComputedStyle', previous);
            else Reflect.deleteProperty(window, 'getComputedStyle');
        }
    });

    it('父级缓存继承仍跨 Shadow host 保护并仅放行指定原文槽，MathML 保持受保护', () => {
        const {document} = parseHTML('<html><body><section></section><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></body></html>');
        const host = document.querySelector('section')!;
        const shadow = host.attachShadow({mode: 'open'});
        const leaf = document.createElement('span');
        leaf.textContent = 'Shadow source';
        shadow.append(leaf);
        const cache = createTranslationTextProtectionCache();
        expect(isTranslationTextElementProtected(host, undefined, cache)).toBe(false);
        expect(isTranslationTextNodeProtected(leaf.firstChild as Text, undefined, undefined, undefined, cache)).toBe(false);
        host.setAttribute('translate', 'no');
        expect(isTranslationTextNodeProtected(leaf.firstChild as Text)).toBe(true);
        host.setAttribute('data-fr-translation-owned', 'true');
        const options = {sourceTextSlotHosts: new Set([host])};
        const slotCache = createTranslationTextProtectionCache();
        expect(isTranslationTextElementProtected(host, undefined, slotCache, options)).toBe(false);
        expect(isTranslationTextNodeProtected(leaf.firstChild as Text, undefined, undefined, options, slotCache)).toBe(false);
        leaf.setAttribute('translate', 'no');
        expect(isTranslationTextNodeProtected(leaf.firstChild as Text, undefined, undefined, options)).toBe(true);
        const math = document.querySelector('math')!;
        const mathCache = createTranslationTextProtectionCache();
        expect(isTranslationTextElementProtected(math, undefined, mathCache)).toBe(true);
        expect(isTranslationTextNodeProtected(math.firstChild!.firstChild as Text, undefined, undefined, undefined, mathCache)).toBe(true);
    });

    it('已缓存父级的第 513 层叶子仍保守保护且不调用站点放行回调', () => {
        const {document} = parseHTML('<html><body></body></html>');
        const root = document.createElement('span');
        let parent = root;
        for (let depth = 1; depth < 512; depth += 1) {
            const child = document.createElement('span');
            parent.append(child);
            parent = child;
        }
        const leaf = document.createElement('span');
        leaf.textContent = 'Deep source';
        parent.append(leaf);
        const cache = createTranslationTextProtectionCache();
        const shouldStayOriginal = vi.fn(() => false);
        expect(isTranslationTextElementProtected(parent, shouldStayOriginal, cache)).toBe(false);
        shouldStayOriginal.mockClear();
        expect(isTranslationTextNodeProtected(leaf.firstChild as Text, shouldStayOriginal, undefined, undefined, cache)).toBe(true);
        expect(shouldStayOriginal).not.toHaveBeenCalled();
    });

    it.each(['BEGIN', 'END'])('原文包含另一槽的 %s 完整标记时避让 nonce，自己生成的包仍可完整往返', (kind) => {
        const sources = [`A literal ___FLUENTREAD_cross_slot_1_${kind}___ appears here.`, 'Second source.'];
        const packet = serializeTranslationSlots(sources, 'cross_slot');
        expect(packet.starts[0]).toBe('___FLUENTREAD_cross_slot_1_0_BEGIN___');
        expect(parseTranslationSlots(packet, packet.payload)).toEqual(sources);
    });

    it('500 个文本槽的有效协议不会为每个标记重新搜索整包文本', () => {
        const sources = Array.from({length: 500}, (_, index) => `Paragraph ${index}: ${'Readable prose. '.repeat(40)}`);
        const packet = serializeTranslationSlots(sources, 'large_packet');
        const originalIndexOf = String.prototype.indexOf;
        let fullPacketSearchSpan = 0;
        const search = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (this: string, marker, offset = 0) {
            if (String(this) === packet.payload) fullPacketSearchSpan += packet.payload.length - offset;
            return originalIndexOf.call(this, marker, offset);
        });
        let results: ReturnType<typeof parseTranslationSlots>;
        try {
            results = parseTranslationSlots(packet, packet.payload);
        } finally {
            search.mockRestore();
        }
        expect(results).toEqual(sources);
        expect(fullPacketSearchSpan).toBeLessThanOrEqual(packet.payload.length * 4);
    });

    it('超范围或非标准数字标记作为字面内容保留，标记尾部共享下划线时仍拒绝包外正文', () => {
        const source = 'Literal ___FLUENTREAD_overlap_5_BEGIN___ and ___FLUENTREAD_overlap_01_END___.';
        const packet = serializeTranslationSlots([source], 'overlap');
        expect(parseTranslationSlots(packet, packet.payload)).toEqual([source]);
        const duplicate = `${packet.payload}FLUENTREAD_overlap_0_END___`;
        expect(parseTranslationSlots(packet, duplicate)).toBeNull();
        const crossOverlap = '___FLUENTREAD_overlap_5_BEGIN___FLUENTREAD_overlap_1_END___';
        const avoided = serializeTranslationSlots([crossOverlap, 'Second.'], 'overlap');
        expect(avoided.starts[0]).toBe('___FLUENTREAD_overlap_1_0_BEGIN___');
        expect(parseTranslationSlots(avoided, avoided.payload)).toEqual([crossOverlap, 'Second.']);
    });

    it('公开的非标准字面标记继续严格拒绝缺项、重复、交错、前后正文与空标记', () => {
        const packet = {payload: '', starts: ['<a>', '<b>'], ends: ['</a>', '</b>']};
        const valid = '<a>First</a>\n<b>Second</b>';
        expect(parseTranslationSlots(packet, valid)).toEqual(['First', 'Second']);
        for (const invalid of [
            '<a>First</a>', '<a>First<a></a><b>Second</b>',
            '<a>First<b></a>Second</b>', '<a>First</b></a><b>Second', '</a><a>First<b>Second</b>',
            `Note ${valid}`, `${valid} Note`, '',
        ]) expect(parseTranslationSlots(packet, invalid)).toBeNull();
        expect(parseTranslationSlots({...packet, starts: ['', '<b>']}, valid)).toBeNull();
        const mixed = {payload: '', starts: ['___FLUENTREAD_mix_0_BEGIN___'], ends: ['</a>']};
        expect(parseTranslationSlots(mixed, `${mixed.starts[0]}Mixed</a>`)).toEqual(['Mixed']);
        const empty = serializeTranslationSlots([]);
        expect(parseTranslationSlots(empty, ' \n ')).toEqual([]);
        expect(parseTranslationSlots(empty, 'Note')).toBeNull();
    });

    it('标准标记在译文各位置的插入、删除和重叠符合严格字面协议', () => {
        const packet = serializeTranslationSlots(['First', 'Second'], 'compatibility');
        const markers = [packet.starts[0]!, packet.ends[0]!, packet.starts[1]!, packet.ends[1]!];
        const literalProtocol = (text: string): string[] | null => {
            if (markers.some(marker => text.split(marker).length !== 2)) return null;
            let cursor = 0;
            const result: string[] = [];
            for (let index = 0; index < 2; index += 1) {
                const start = text.indexOf(packet.starts[index]!, cursor);
                if (start < 0 || text.slice(cursor, start).trim()) return null;
                const valueStart = start + packet.starts[index]!.length;
                const end = text.indexOf(packet.ends[index]!, valueStart);
                if (end < 0) return null;
                result.push(text.slice(valueStart, end));
                cursor = end + packet.ends[index]!.length;
            }
            return text.slice(cursor).trim() ? null : result;
        };
        const variants = [packet.payload, '', `Note ${packet.payload}`, `${packet.payload} Note`];
        for (const marker of markers) {
            variants.push(packet.payload.replace(marker, ''));
            for (let at = 0; at <= packet.payload.length; at += 1) {
                variants.push(packet.payload.slice(0, at) + marker + packet.payload.slice(at));
            }
        }
        variants.push(`${packet.starts[0]}FLUENTREAD_compatibility_0_END___${packet.ends[0]}\n${packet.starts[1]}Second${packet.ends[1]}`);
        for (const text of variants) expect(parseTranslationSlots(packet, text), text).toEqual(literalProtocol(text));
    });

    it('标记各出现一次但第二槽结束标记落在第一槽内部时拒绝交错协议', () => {
        const packet = serializeTranslationSlots(['First', 'Second']);
        const crossed = `${packet.starts[0]}First${packet.ends[1]}${packet.ends[0]}${packet.starts[1]}Second`;
        expect(parseTranslationSlots(packet, crossed)).toBeNull();
        expect(parseTranslationSlots(packet, packet.payload)).toEqual(['First', 'Second']);
    });
    it('旧 WebView 只探测一次 :has 能力，回退仍识别直属外部译文和同任务 DOM 变更', () => {
        const {document} = parseHTML('<html><body><article><p id="source">Source text.</p></article></body></html>');
        const source = document.querySelector('#source')!;
        const article = source.parentElement!;
        const unsupported = vi.spyOn(source, 'matches').mockImplementation(() => { throw new SyntaxError('Unsupported :has'); });
        expect(isForeignTranslationBoundary(source)).toBe(false);
        const wrapper = document.createElement('font');
        wrapper.className = 'immersive-translate-target-wrapper';
        source.append(wrapper);
        expect(isForeignTranslationBoundary(source)).toBe(true);
        expect(isForeignTranslationBoundary(article)).toBe(false);
        wrapper.remove();
        expect(isForeignTranslationBoundary(source)).toBe(false);
        expect(unsupported).toHaveBeenCalledTimes(1);
        unsupported.mockRestore();
    });
    it('外部译文边界在同一任务的插入、改类、移动和删除后立即更新', () => {
        const {document} = parseHTML('<html><body><article><p id="a">First source.</p><div id="b"><p>Nested source.</p></div></article></body></html>');
        const article = document.querySelector('article')!;
        const a = document.querySelector('#a')!;
        const b = document.querySelector('#b')!;
        const wrapper = document.createElement('font');
        expect(isForeignTranslationBoundary(a)).toBe(false);
        a.append(wrapper);
        wrapper.className = 'immersive-translate-target-wrapper';
        expect(isForeignTranslationBoundary(a)).toBe(true);
        expect(isForeignTranslationBoundary(article)).toBe(false);
        b.firstElementChild!.append(wrapper);
        expect(isForeignTranslationBoundary(a)).toBe(false);
        expect(isForeignTranslationBoundary(b)).toBe(false);
        expect(isForeignTranslationBoundary(b.firstElementChild!)).toBe(true);
        wrapper.className = '';
        expect(isForeignTranslationBoundary(b.firstElementChild!)).toBe(false);
        wrapper.className = 'immersive-translate-target-wrapper';
        wrapper.remove();
        expect(isForeignTranslationBoundary(b.firstElementChild!)).toBe(false);
    });

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

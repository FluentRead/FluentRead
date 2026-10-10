import {parseHTML} from 'linkedom';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({
    config: {style: 1, to: 'zh-Hans'},
}));
vi.mock('@/src/core/config/catalog', () => ({
    options: {styles: []},
}));

import {
    applyTranslationsToSnapshot,
    createTranslationSourceSnapshot,
    hasActiveTranslationLineClamp,
    hasActiveTranslationTruncation,
    translationTruncationStyleOverrides,
} from '@/src/core/translation/public';
import {config} from '@/src/services/config/store';
import {options} from '@/src/core/config/catalog';
import {
    acquireTranslationLayoutOverride,
    beginTranslation,
    getTranslationState,
    hasTranslationLayoutOverride,
    hasBilingualArtifactHostWriteBudget,
    isTranslationLayoutOverrideMutation,
    markTranslationComplete,
    reconcileTranslationLayoutOverrides,
    restoreTranslation,
    setBilingualContent,
    setBilingualOwnerRemountHandler,
    setSingleTextSlotHosts,
} from '@/src/features/full-page-translation/content/state';
import {transferEquivalentBilingualOwners} from
    '@/src/features/full-page-translation/content/bilingualRemount';
import {ensureTranslationTruncationLayout} from '@/src/features/full-page-translation/content/layout';
import {
    appendBilingualTranslation,
    materializeCandidate,
    materializeVisualTranslationCandidate,
    appendSingleTranslationSlots,
} from '@/src/features/full-page-translation/content/renderer';
import {
    clearOrphanedTranslationArtifacts,
    consumeOrphanedOwnerClassMutation,
    isTextEquivalentHostReplacement,
    normalizeOrphanedTranslationArtifacts,
} from
    '@/src/features/full-page-translation/content/orphanArtifacts';
import {
    hasTranslationHeightOverflow,
    isTranslationHeightBoundary,
    translationHeightStyleOverrides,
} from '@/src/core/translation/serialization';

function openRouterFixture() {
    const {document} = parseHTML(`
        <html><body>
            <div id="ordinary-overflow">
                <div id="clamp">
                    <div class="prose"><p id="first">A long model description for the first card.</p></div>
                    <p id="second">A second translated paragraph sharing the same clamp.</p>
                </div>
            </div>
        </body></html>
    `);
    const clamp = document.querySelector<HTMLElement>('#clamp')!;
    const ordinary = document.querySelector<HTMLElement>('#ordinary-overflow')!;
    const first = document.querySelector<HTMLElement>('#first')!;
    const second = document.querySelector<HTMLElement>('#second')!;
    const getComputedStyle = (element: Element) => {
        const lineClamp = element === clamp ? '2' : 'none';
        return {
            webkitLineClamp: lineClamp,
            getPropertyValue: (property: string) =>
                property === '-webkit-line-clamp' || property === 'line-clamp' ? lineClamp : '',
        } as unknown as CSSStyleDeclaration;
    };
    Object.defineProperty(document.defaultView, 'getComputedStyle', {
        configurable: true,
        value: getComputedStyle,
    });
    return {document, clamp, ordinary, first, second};
}

/** linkedom 未实现 CSS priority API，因此显式记录真实的 setProperty 调用。 */
function trackStylePriorities(element: HTMLElement) {
    const style = element.style;
    const priorities = new Map<string, string>();
    const calls: Array<{property: string; value: string; priority: string}> = [];
    const initialStyle = element.getAttribute('style') ?? '';
    initialStyle.split(';').forEach((declaration) => {
        const separator = declaration.indexOf(':');
        if (separator < 0 || !/!important\s*$/iu.test(declaration)) return;
        priorities.set(declaration.slice(0, separator).trim().toLowerCase(), 'important');
    });
    const originalSetProperty = style.setProperty.bind(style);
    const originalRemoveProperty = style.removeProperty.bind(style);

    Object.defineProperties(style, {
        getPropertyPriority: {
            configurable: true,
            value: (property: string) => priorities.get(property.toLowerCase()) ?? '',
        },
        setProperty: {
            configurable: true,
            value: (property: string, value: string, priority = '') => {
                const normalizedPriority = priority.toLowerCase();
                calls.push({property, value, priority: normalizedPriority});
                originalSetProperty(property, value);
                if (normalizedPriority) priorities.set(property.toLowerCase(), normalizedPriority);
                else priorities.delete(property.toLowerCase());
            },
        },
        removeProperty: {
            configurable: true,
            value: (property: string) => {
                priorities.delete(property.toLowerCase());
                return originalRemoveProperty(property);
            },
        },
    });

    return {
        calls,
        getPriority: (property: string) => priorities.get(property.toLowerCase()) ?? '',
    };
}

async function flushMutationObservers(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
}

async function withDocumentRealm<T>(
    document: Document,
    callback: () => Promise<T>,
): Promise<T> {
    const realm = document.defaultView as unknown as Record<string, unknown>;
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const realmBindings: Record<string, unknown> = {
        document,
        window: document.defaultView,
        DOMParser: class FixtureDOMParser {
            parseFromString(source: string): Document {
                return parseHTML(`<html><head></head><body>${source}</body></html>`).document;
            }
        },
        Element: realm.Element,
        HTMLElement: realm.HTMLElement,
        MutationObserver: realm.MutationObserver,
        Node: realm.Node,
        ShadowRoot: realm.ShadowRoot,
    };
    const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

    Object.entries(realmBindings).forEach(([name, value]) => {
        previousDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        if (value !== undefined) {
            Object.defineProperty(globalRecord, name, {
                configurable: true,
                writable: true,
                value,
            });
        }
    });

    try {
        return await callback();
    } finally {
        Object.keys(realmBindings).forEach((name) => {
            const descriptor = previousDescriptors.get(name);
            if (descriptor) Object.defineProperty(globalRecord, name, descriptor);
            else delete globalRecord[name];
        });
    }
}

function commitBilingualTranslation(owner: HTMLElement): HTMLElement {
    const attempt = beginTranslation(owner, 'bilingual')!;
    attempt.state.phase = 'translated';
    expect(ensureTranslationTruncationLayout(owner)).toBe(true);

    const wrapper = owner.ownerDocument.createElement('span');
    wrapper.className = 'fluent-read-bilingual-content';
    wrapper.setAttribute('data-fr-translation-owned', 'true');
    wrapper.textContent = 'Translated text.';
    owner.appendChild(wrapper);
    setBilingualContent(owner, wrapper);
    return wrapper;
}

function dynamicClampFixture() {
    const {document} = parseHTML(`
        <html><body>
            <div id="late-clamp"><p id="owner">A translated paragraph.</p></div>
        </body></html>
    `);
    const clamp = document.querySelector<HTMLElement>('#late-clamp')!;
    const owner = document.querySelector<HTMLElement>('#owner')!;
    Object.defineProperty(document.defaultView, 'getComputedStyle', {
        configurable: true,
        value: (element: Element) => {
            const inlineClamp = (element as HTMLElement).style?.getPropertyValue('-webkit-line-clamp') ?? '';
            const lineClamp = inlineClamp === 'unset'
                ? 'none'
                : inlineClamp || (element === clamp && clamp.classList.contains('line-clamp-2') ? '2' : 'none');
            return {
                webkitLineClamp: lineClamp,
                getPropertyValue: (property: string) =>
                    property === '-webkit-line-clamp' || property === 'line-clamp' ? lineClamp : '',
            } as unknown as CSSStyleDeclaration;
        },
    });
    return {document, clamp, owner};
}

describe('translation truncation layout', () => {
    it.each(['span', 'x-inert'])('本地骨架净化深层 %s 时不递归耗尽调用栈或改写来源', async (tag) => {
        const depth = 4096;
        const {document} = parseHTML('<html><body><p id="owner">Translate the shallow sentence.' +
            `<${tag}>`.repeat(depth) + 'Keep the deeply nested original.' + `</${tag}>`.repeat(depth) + '</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        await withDocumentRealm(document, async () => {
            const originalHTML = owner.innerHTML;
            const snapshot = createTranslationSourceSnapshot(owner);
            let wrapper: HTMLElement | undefined;
            expect(() => {
                wrapper = appendBilingualTranslation(owner, '', {sourceSkeleton: snapshot.clone});
            }).not.toThrow();
            expect(wrapper!.textContent).toBe(snapshot.clone.textContent);
            expect(wrapper!.querySelectorAll(tag)).toHaveLength(tag === 'span' ? depth : 0);
            wrapper!.remove();
            expect(owner.innerHTML).toBe(originalHTML);
        });
    });

    it('本地深层公式克隆保持命名空间和原文且不递归耗尽调用栈', async () => {
        const depth = 4096;
        const {document} = parseHTML('<html><body><p id="owner">Translate around this formula.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const namespace = 'http://www.w3.org/1998/Math/MathML';
        const math = document.createElementNS(namespace, 'math');
        let current = math;
        for (let i = 0; i < depth; i++) {
            const row = document.createElementNS(namespace, 'mrow');
            current.appendChild(row); current = row;
        }
        const symbol = document.createElementNS(namespace, 'mi');
        symbol.setAttribute('onclick', 'unsafe()');
        symbol.textContent = 'x'; current.appendChild(symbol); owner.appendChild(math);
        await withDocumentRealm(document, async () => {
            const snapshot = createTranslationSourceSnapshot(owner);
            let wrapper: HTMLElement | undefined;
            expect(() => {
                wrapper = appendBilingualTranslation(owner, '', {sourceSkeleton: snapshot.clone});
            }).not.toThrow();
            expect(wrapper!.querySelectorAll('mrow')).toHaveLength(depth);
            expect(wrapper!.querySelector('mi')?.textContent).toBe('x');
            expect(wrapper!.querySelector('[onclick]')).toBeNull();
            expect(wrapper!.querySelector('math')?.namespaceURI).toBe(math.namespaceURI);
            wrapper!.remove();
            expect(owner.lastChild).toBe(math);
            expect(symbol.getAttribute('onclick')).toBe('unsafe()');
        });
    });

    it('只识别自然流固定高度容器的真实几何溢出，并提供 height auto 覆盖契约', () => {
        const {document} = parseHTML('<html><body><div id="box"><div id="branch">content</div></div></body></html>');
        const box = document.querySelector<HTMLElement>('#box')!;
        const branch = document.querySelector<HTMLElement>('#branch')!;
        Object.defineProperties(box, {
            clientHeight: {configurable: true, value: 176},
            scrollHeight: {configurable: true, value: 176},
        });
        Object.defineProperty(box, 'getBoundingClientRect', {
            configurable: true, value: () => ({top: 100, bottom: 276}),
        });
        Object.defineProperty(branch, 'getBoundingClientRect', {
            configurable: true, value: () => ({top: 90, bottom: 290}),
        });
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                height: element === box ? '176px' : '200px', display: element === box ? 'flex' : 'block',
                overflowY: 'visible', overflow: 'visible', position: 'static', transform: 'none',
            } as unknown as CSSStyleDeclaration),
        });

        expect(isTranslationHeightBoundary(box)).toBe(false);
        expect(hasTranslationHeightOverflow(box, branch)).toBe(true);
        expect(translationHeightStyleOverrides).toEqual([
            {property: 'height', value: 'auto', priority: 'important'},
        ]);
    });

    it('拒绝滚动容器、文档表面和脱离自然流的译文分支', () => {
        const {document} = parseHTML('<html><body><div id="box"><div id="branch">content</div></div></body></html>');
        const box = document.querySelector<HTMLElement>('#box')!;
        const branch = document.querySelector<HTMLElement>('#branch')!;
        Object.defineProperties(box, {
            clientHeight: {configurable: true, value: 20}, scrollHeight: {configurable: true, value: 200},
        });
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                height: '20px', display: 'flex', overflowY: element === box ? 'auto' : 'visible',
                overflow: 'visible', position: element === branch ? 'absolute' : 'static', transform: 'none',
            } as unknown as CSSStyleDeclaration),
        });
        expect(isTranslationHeightBoundary(box)).toBe(true);
        expect(isTranslationHeightBoundary(document.body)).toBe(true);
        expect(hasTranslationHeightOverflow(box, branch)).toBe(false);
    });

    it('允许向上检查 hidden/clip 内层解除后的外层几何，但不直接扩高该内层', () => {
        const {document} = parseHTML('<html><body><div id="box"><div id="branch">content</div></div></body></html>');
        const box = document.querySelector<HTMLElement>('#box')!;
        const branch = document.querySelector<HTMLElement>('#branch')!;
        Object.defineProperties(box, {
            clientHeight: {configurable: true, value: 40}, scrollHeight: {configurable: true, value: 200},
        });
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                height: '40px', display: 'block', overflowY: element === box ? 'hidden' : 'visible',
                overflow: 'visible', position: 'static', transform: 'none',
            } as unknown as CSSStyleDeclaration),
        });
        expect(isTranslationHeightBoundary(box)).toBe(false);
        expect(hasTranslationHeightOverflow(box, branch)).toBe(false);
    });

    it('无 computed style 时保持保守阴性', () => {
        const {document} = parseHTML('<html><body><div id="box"><div id="branch">content</div></div></body></html>');
        const box = document.querySelector<HTMLElement>('#box')!;
        const branch = document.querySelector<HTMLElement>('#branch')!;
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true, value: () => undefined,
        });
        expect(isTranslationHeightBoundary(box)).toBe(true);
        expect(hasTranslationHeightOverflow(box, branch)).toBe(false);
    });

    it('可使用 scrollHeight 作为几何 API 不完整时的溢出依据，并拒绝变换分支', () => {
        const {document} = parseHTML('<html><body><div id="box"><div id="branch">content</div></div></body></html>');
        const box = document.querySelector<HTMLElement>('#box')!;
        const branch = document.querySelector<HTMLElement>('#branch')!;
        Object.defineProperties(box, {
            clientHeight: {configurable: true, value: 40}, scrollHeight: {configurable: true, value: 80},
            getBoundingClientRect: {configurable: true, value: () => { throw new Error('layout'); }},
        });
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => ({
                height: '40px', display: 'grid', overflowY: 'visible', overflow: 'visible',
                position: 'static', transform: element === branch ? 'translateY(1px)' : 'none',
            } as unknown as CSSStyleDeclaration),
        });
        expect(hasTranslationHeightOverflow(box, box)).toBe(true);
        expect(hasTranslationHeightOverflow(box, branch)).toBe(false);
    });

    it('布局矩形或 scrollHeight 读取异常时保守回退，不抛出异常', () => {
        const {document} = parseHTML('<html><body><div id="box"><div id="branch">content</div></div></body></html>');
        const box = document.querySelector<HTMLElement>('#box')!;
        const branch = document.querySelector<HTMLElement>('#branch')!;
        Object.defineProperty(box, 'getBoundingClientRect', {
            configurable: true, value: () => { throw new Error('layout'); },
        });
        Object.defineProperty(box, 'scrollHeight', {
            configurable: true, get: () => { throw new Error('layout'); },
        });
        Object.defineProperty(box, 'clientHeight', {configurable: true, value: 40});
        Object.defineProperty(branch, 'getBoundingClientRect', {
            configurable: true, value: () => ({top: 0, bottom: 80}),
        });
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: () => ({
                height: '40px', display: 'block', overflowY: 'visible', overflow: 'visible',
                position: 'static', transform: 'none',
            } as unknown as CSSStyleDeclaration),
        });
        expect(hasTranslationHeightOverflow(box, branch)).toBe(false);
        expect(hasTranslationHeightOverflow(box, box)).toBe(false);
    });

    it('分支或二次元素样式读取不可用时保守返回阴性', () => {
        const {document} = parseHTML('<html><body><div id="box"><div id="branch">content</div></div></body></html>');
        const box = document.querySelector<HTMLElement>('#box')!;
        const branch = document.querySelector<HTMLElement>('#branch')!;
        const style = {
            height: '40px', display: 'block', overflowY: 'visible', overflow: 'visible',
            position: 'static', transform: 'none',
        } as unknown as CSSStyleDeclaration;
        vi.spyOn(document.defaultView!, 'getComputedStyle')
            .mockReturnValueOnce(style)
            .mockReturnValueOnce(undefined as unknown as CSSStyleDeclaration);
        expect(hasTranslationHeightOverflow(box, branch)).toBe(false);

        const second = vi.spyOn(document.defaultView!, 'getComputedStyle');
        second.mockReset().mockReturnValueOnce(style).mockReturnValueOnce(style).mockReturnValueOnce(undefined as unknown as CSSStyleDeclaration);
        expect(hasTranslationHeightOverflow(box, branch)).toBe(false);
    });

    it('清理以产物自身为 root 的直属孤儿，并忽略无 HTML owner 的 SVG 产物', async () => {
        const {document} = parseHTML('<html><body></body></html>');

        await withDocumentRealm(document, async () => {
            const artifactClasses = [
                'fluent-read-bilingual-content',
                'fluent-read-loading',
                'fluent-read-retry-wrapper',
            ];
            let detachedArtifact: HTMLElement | undefined;
            artifactClasses.forEach((artifactClass, index) => {
                const owner = document.createElement('p');
                owner.className = `${index === 0 ? 'host-class ' : ''}fluent-read-bilingual fluent-read-failure`;
                const artifact = document.createElement('span');
                artifact.className = artifactClass;
                artifact.setAttribute('data-fr-translation-owned', 'true');
                owner.appendChild(artifact);
                document.body.appendChild(owner);

                normalizeOrphanedTranslationArtifacts(artifact);

                expect(artifact.isConnected).toBe(false);
                if (index === 0) expect(owner.className).toBe('host-class');
                else expect(owner.hasAttribute('class')).toBe(false);
                expect(consumeOrphanedOwnerClassMutation(owner)).toBe(true);
                expect(consumeOrphanedOwnerClassMutation(owner)).toBe(false);
                if (index === 0) detachedArtifact = artifact;
            });

            expect(() => normalizeOrphanedTranslationArtifacts(detachedArtifact!)).not.toThrow();

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'fluent-read-bilingual');
            const svgArtifact = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            svgArtifact.setAttribute('class', 'fluent-read-bilingual-content');
            svgArtifact.setAttribute('data-fr-translation-owned', 'true');
            svg.appendChild(svgArtifact);
            document.body.appendChild(svg);

            normalizeOrphanedTranslationArtifacts(svgArtifact);

            expect(svgArtifact.parentElement).toBe(svg);
            expect(svg.getAttribute('class')).toBe('fluent-read-bilingual');
        });
    });

    it('全文遗留产物清理保护活动状态、片段原文和宿主同步移除的节点', () => {
        const {document} = parseHTML('<html><body><p id="active" data-fr-translation-segment="true">Live source<span data-fr-translation-owned="true">Live translation</span></p><span id="orphan" data-fr-translation-segment="true">Original text</span><span id="removed" data-fr-translation-segment="true">Removed by host</span><svg><g data-fr-translation-owned="true"></g></svg></body></html>');
        const active = document.querySelector<HTMLElement>('#active')!;
        beginTranslation(active, 'bilingual');
        const orphan = document.querySelector<HTMLElement>('#orphan')!;
        const removed = document.querySelector<HTMLElement>('#removed')!;
        const replaceWith = orphan.replaceWith.bind(orphan);
        // 自定义元素的断连回调可以在解包前一个片段时同步移除下一个片段。
        orphan.replaceWith = (...nodes) => { replaceWith(...nodes); removed.remove(); };
        clearOrphanedTranslationArtifacts(document.createTextNode('No query surface'));
        clearOrphanedTranslationArtifacts(document.body);
        expect(active.textContent).toBe('Live sourceLive translation');
        expect(active.parentElement).toBe(document.body);
        expect(document.body.textContent).toContain('Original text');
        expect(document.body.textContent).not.toContain('Removed by host');
        expect(document.querySelector('svg > g')).toBeNull();
        restoreTranslation(active);
        const fragment = document.createDocumentFragment();
        const artifact = document.createElement('span');
        artifact.setAttribute('data-fr-translation-owned', 'true'); fragment.append(artifact);
        clearOrphanedTranslationArtifacts(fragment);
        expect(fragment.childNodes.length).toBe(0);
    });

    it('只把同文本 childList 替换识别为页面上下文不变的框架重挂', () => {
        const {document} = parseHTML('<html><body></body></html>');
        const source = document.createElement('p');
        source.textContent = 'Same   source';
        const clone = document.createElement('p');
        clone.textContent = 'Same source';
        const record = (type: MutationRecordType, added: Node[], removed: Node[]) => ({
            type,
            addedNodes: added as unknown as NodeList,
            removedNodes: removed as unknown as NodeList,
        } as MutationRecord);

        expect(isTextEquivalentHostReplacement(record('childList', [clone], [source]))).toBe(false);
        const artifact = document.createElement('span');
        artifact.setAttribute('data-fr-translation-owned', 'true');
        source.appendChild(artifact);
        clone.appendChild(artifact.cloneNode(true));
        expect(isTextEquivalentHostReplacement(record('childList', [clone], [source]))).toBe(true);
        expect(isTextEquivalentHostReplacement(record(
            'childList',
            [clone, document.createComment('new framework marker')],
            [source, document.createComment('old framework marker')],
        ))).toBe(true);
        clone.textContent = 'Changed source';
        expect(isTextEquivalentHostReplacement(record('childList', [clone], [source]))).toBe(false);
        expect(isTextEquivalentHostReplacement(record('childList', [], [source]))).toBe(false);
        expect(isTextEquivalentHostReplacement(record('attributes', [source], [source]))).toBe(false);
    });

    it('detects the active OpenRouter-style clamp but ignores ordinary overflow clipping', () => {
        const {clamp, ordinary} = openRouterFixture();

        expect(hasActiveTranslationLineClamp(clamp)).toBe(true);
        expect(hasActiveTranslationLineClamp(ordinary)).toBe(false);
    });

    it('只把真实溢出的 max-height 容器识别为截断，不改写未溢出的普通 owner', () => {
        const {document} = parseHTML('<html><body><div id="owner"></div></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        let overflowY = 'hidden';
        let overflow = 'hidden';
        let clientHeight = 40;
        Object.defineProperties(owner, {
            scrollHeight: {configurable: true, get: () => 120},
            clientHeight: {configurable: true, get: () => clientHeight},
        });
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: () => ({
                webkitLineClamp: 'none', maxHeight: '40px', overflowY, overflow,
                getPropertyValue: () => '',
            } as unknown as CSSStyleDeclaration),
        });

        expect(hasActiveTranslationTruncation(owner)).toBe(true);
        clientHeight = 120;
        expect(hasActiveTranslationTruncation(owner)).toBe(false);
        clientHeight = 40;
        overflowY = 'visible';
        expect(hasActiveTranslationTruncation(owner)).toBe(false);
        overflowY = 'auto';
        expect(hasActiveTranslationTruncation(owner)).toBe(false);
        overflowY = 'scroll';
        expect(hasActiveTranslationTruncation(owner)).toBe(false);
        overflowY = '';
        overflow = 'hidden';
        expect(hasActiveTranslationTruncation(owner)).toBe(true);
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: () => undefined,
        });
        expect(hasActiveTranslationTruncation(owner)).toBe(false);
    });

    it('逐行标记保留内联译文骨架，恢复时不改变原文节点', async () => {
        for (const [style, className] of [[10, 'fluent-display-learning-mode'], [11, 'fluent-display-marker'], [48, 'fluent-display-spoiler']] as const) {
            const {document, first} = openRouterFixture();
            const originalText = first.firstChild;
            const originalHTML = first.innerHTML;
            options.styles.push({value: style, label: '', class: className, inlineText: true} as never);
            try {
                await withDocumentRealm(document, async () => {
                    beginTranslation(first, 'bilingual');
                    const wrapper = appendBilingualTranslation(first, '一段多行译文。<a href="https://example.com">参考链接</a><strong>重点文字</strong>', {style});
                    setBilingualContent(first, wrapper);
                    expect(wrapper.querySelector('.fluent-read-translation-text > a')?.textContent).toBe('参考链接');
                    expect(wrapper.querySelector('.fluent-read-translation-text > strong')?.textContent).toBe('重点文字');
                    expect(wrapper.children).toHaveLength(1);
                    expect(first.firstChild).toBe(originalText);
                    restoreTranslation(first);
                    expect(first.innerHTML).toBe(originalHTML);
                    expect(first.firstChild).toBe(originalText);
                });
            } finally { options.styles.pop(); }
        }
    });

    it('wires OpenRouter ancestor unclamping through the real bilingual renderer', async () => {
        const {document, clamp, first} = openRouterFixture();
        const originalClampStyle = '-webkit-line-clamp: 2 !important; max-height: 40px; color: red;';
        clamp.setAttribute('style', originalClampStyle);
        const priorityTracking = trackStylePriorities(clamp);

        await withDocumentRealm(document, async () => {
            const attempt = beginTranslation(first, 'bilingual')!;
            attempt.state.phase = 'translated';
            expect(ensureTranslationTruncationLayout(first)).toBe(true);
            const wrapper = appendBilingualTranslation(first, '模型介绍已翻译。');
            setBilingualContent(first, wrapper);

            expect(wrapper.parentElement).toBe(first);
            expect(wrapper.textContent).toBe('模型介绍已翻译。');
            expect(wrapper.getAttribute('translate')).toBe('no');
            expect(first.classList.contains('fluent-read-bilingual')).toBe(false);
            expect(hasTranslationLayoutOverride(first)).toBe(false);
            expect(first.getAttribute('style')).toBeNull();
            expect(hasTranslationLayoutOverride(clamp)).toBe(true);
            expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
            expect(priorityTracking.calls).toContainEqual({
                property: '-webkit-line-clamp',
                value: 'unset',
                priority: 'important',
            });

            expect(restoreTranslation(first)).toBe(true);
            expect(wrapper.isConnected).toBe(false);
            expect(hasTranslationLayoutOverride(clamp)).toBe(false);
            expect(clamp.getAttribute('style')).toBe(originalClampStyle);
        });
    });

    it('expands a fixed-height line-clamped translation owner and restores its host style', async () => {
        const {document} = parseHTML(`
            <html><body><p id="owner" class="line-clamp-4" style="color: red;">
                This long mod description occupies the original four-line card height.
            </p></body></html>
        `);
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const originalStyle = owner.getAttribute('style');
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: HTMLElement) => {
                const activeClamp = element === owner && element.style.getPropertyValue('-webkit-line-clamp') !== 'unset';
                return {
                    webkitLineClamp: activeClamp ? '3' : 'none',
                    maxHeight: 'none',
                    height: element === owner ? owner.style.getPropertyValue('height') || '4em' : 'auto',
                    display: element === owner ? '-webkit-box' : 'block',
                    overflowY: element === owner ? 'hidden' : 'visible',
                    overflow: element === owner ? 'hidden' : 'visible',
                    getPropertyValue: (property: string) => property === '-webkit-line-clamp'
                        ? activeClamp ? '3' : 'none' : '',
                } as unknown as CSSStyleDeclaration;
            },
        });

        await withDocumentRealm(document, async () => {
            const wrapper = commitBilingualTranslation(owner);
            expect(wrapper.isConnected).toBe(true);
            expect(owner.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
            expect(owner.style.getPropertyValue('height')).toBe('auto');
            expect(ensureTranslationTruncationLayout(owner)).toBe(true);
            expect(owner.style.getPropertyValue('height')).toBe('auto');

            expect(restoreTranslation(owner)).toBe(true);
            expect(owner.getAttribute('style')).toBe(originalStyle);
            expect(hasTranslationLayoutOverride(owner)).toBe(false);
        });
    });

    it('sanitizes renderer HTML while preserving safe inline markup and configured style class', async () => {
        const {document} = parseHTML('<html><body><p id="owner">Readable paragraph.</p></body></html>');
        Object.defineProperty(document, 'baseURI', {
            configurable: true,
            value: 'https://host.example/page',
        });
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const previousConfig = {...config};
        const previousStyles = [...options.styles];

        await withDocumentRealm(document, async () => {
            try {
                Object.assign(config, {style: 7, to: ''});
                options.styles = [
                    {value: 7, class: 'fr-rendered-style'},
                    {value: 7, class: 'fr-disabled-style', disabled: true},
                ] as typeof options.styles;

                const attempt = beginTranslation(owner, 'bilingual')!;
                attempt.state.phase = 'translated';
                const wrapper = appendBilingualTranslation(owner, [
                    '<a href="https://example.com/read" title="Read"><strong>safe link</strong></a>',
                    '<a href="javascript:alert(1)" title="Unsafe">bad href</a>',
                    '<a href="http://[">bad url</a>',
                    '<div>block wrapper <em>keeps text</em></div>',
                    '<script>alert(1)</script>',
                    '<!--ignored comment-->',
                ].join(''));

                expect(wrapper.classList.contains('fr-rendered-style')).toBe(true);
                expect(wrapper.classList.contains('fr-disabled-style')).toBe(false);
                expect(wrapper.lang).toBe('');
                expect(wrapper.querySelector('script')).toBeNull();
                expect(wrapper.querySelector('div')).toBeNull();
                expect(wrapper.textContent).toContain('block wrapper keeps text');

                const links = wrapper.querySelectorAll('a');
                expect(links).toHaveLength(3);
                expect(links[0]!.getAttribute('href')).toBe('https://example.com/read');
                expect(links[0]!.getAttribute('title')).toBe('Read');
                expect(links[1]!.hasAttribute('href')).toBe(false);
                expect(links[1]!.getAttribute('title')).toBe('Unsafe');
                expect(links[2]!.hasAttribute('href')).toBe(false);

                restoreTranslation(owner);
            } finally {
                Object.assign(config, previousConfig);
                options.styles = previousStyles;
            }
        });
    });

    it('preserves source MathML, KaTeX, MathJax SVG and image formulas through the actual renderer', async () => {
        const {document} = parseHTML(`<html><body><p id="owner">The velocity
            <math xmlns="http://www.w3.org/1998/Math/MathML"><msub><mi>v</mi><mi>t</mi></msub></math>
            and <span class="katex"><span class="katex-html" aria-hidden="true" style="height:1em"><span class="mord">x</span></span></span>
            with <mjx-container class="MathJax" jax="CHTML"><mjx-msub><mjx-mi>x</mjx-mi><mjx-script><mjx-mn size="s">1</mjx-mn></mjx-script></mjx-msub><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><defs><path id="glyph" d="M0 0L10 10"/></defs><use href="#glyph"/></svg></mjx-container>
            and <span class="mwe-math-element"><img src="https://example.org/math.svg" alt="y"></span> remains stable.
        </p></body></html>`);
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const originalHTML = owner.innerHTML;
        const originalMath = owner.querySelector('math');
        await withDocumentRealm(document, async () => {
            for (let cycle = 0; cycle < 2; cycle += 1) {
                const snapshot = createTranslationSourceSnapshot(owner);
                const html = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(() => '译文'));
                const wrapper = appendBilingualTranslation(owner, html, {sourceSkeleton: snapshot.clone});
                expect(wrapper.querySelectorAll('math')).toHaveLength(1);
                expect(wrapper.querySelector('msub')?.textContent).toBe('vt');
                expect(wrapper.querySelector('.katex .mord')?.textContent).toBe('x');
                expect(wrapper.querySelector('.katex-html')?.getAttribute('style')).toContain('height');
                expect(wrapper.querySelector('mjx-container')?.getAttribute('jax')).toBe('CHTML');
                expect(wrapper.querySelector('mjx-mn')?.getAttribute('size')).toBe('s');
                expect(wrapper.querySelector('svg use')?.getAttribute('href')).toBe(`#${wrapper.querySelector('svg path')?.id}`);
                expect(wrapper.querySelector('svg path')?.id).not.toBe('glyph');
                expect(wrapper.querySelector('.mwe-math-element img')?.getAttribute('src')).toContain('math.svg');
                wrapper.remove();
                expect(owner.innerHTML).toBe(originalHTML);
                expect(owner.querySelector('math')).toBe(originalMath);
            }
        });
    });

    it('issue #492 keeps the MathJax v2 nobr visual tree without a second assistive formula', async () => {
        const {document} = parseHTML(`<html><body><p id="owner">For each integer
            <span class="MathJax"><nobr aria-hidden="true"><span class="mi" style="font-family: serif">i</span></nobr><span class="MJX_Assistive_MathML"><math><mi>i</mi></math></span></span><script type="math/tex">i</script>
            satisfying <span class="MathJax"><nobr aria-hidden="true"><span>1≤i≤n</span></nobr><span class="MJX_Assistive_MathML"><math><mrow>1≤i≤n</mrow></math></span></span><script type="math/tex">1 \\le i \\le n</script>, find the answer.
            <span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">x</span></span>
            <mjx-container><mjx-mi>y</mjx-mi><mjx-assistive-mml><math><mi>y</mi></math></mjx-assistive-mml></mjx-container>
        </p></body></html>`);
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const original = owner.innerHTML;
        await withDocumentRealm(document, async () => {
            for (let cycle = 0; cycle < 2; cycle++) {
                const snapshot = createTranslationSourceSnapshot(owner);
                expect(snapshot.slots.every(slot => !/1≤i≤n|^i$|^x$|^y$/.test(slot.source))).toBe(true);
                const html = applyTranslationsToSnapshot(snapshot, snapshot.slots.map(() => '中文'));
                const wrapper = appendBilingualTranslation(owner, html, {sourceSkeleton: snapshot.clone});
                expect([...wrapper.querySelectorAll('.MathJax')].map(node => node.textContent)).toEqual(['i', '1≤i≤n']);
                expect(wrapper.querySelectorAll('.MathJax > nobr')).toHaveLength(2);
                expect(wrapper.querySelector('.katex')?.textContent).toBe('x');
                expect(wrapper.querySelector('mjx-container')?.textContent).toBe('y');
                expect(wrapper.querySelector('.MJX_Assistive_MathML, .katex-mathml, mjx-assistive-mml, script')).toBeNull();
                wrapper.remove();
                expect(owner.innerHTML).toBe(original);
            }
        });
    });

    it('rejects active formula content and keeps formula privileges out of provider HTML', async () => {
        const {document} = parseHTML(`<html><head><base href="https://example.org/paper"></head><body><p id="owner">Prose</p></body></html>`);
        const owner = document.querySelector<HTMLElement>('#owner')!;
        await withDocumentRealm(document, async () => {
            const skeleton = document.createElement('p');
            skeleton.innerHTML = `<span class="katex" onclick="alert(1)" tabindex="0">
                <span id="safe" style="height:1em;position:relative;left:0;bad;1bad:value;background:url(https://bad);position:fixed" data-mjx-test="yes">x</span>
                <span style="background:url(https://bad)" fill="url(https://bad)">y</span>
                <script>alert(1)</script><iframe src="https://bad"></iframe><button>bad control</button>
                <a href="javascript:alert(1)">link</a><img src="javascript:alert(1)"><img src="http://[">
                <svg><use xlink:href="#external-glyph"/><use href="https://bad/glyph"/><foreignObject>bad</foreignObject></svg>
                <!-- comment -->
            </span><section class="MathJax">unsupported wrapper</section>`;
            const wrapper = appendBilingualTranslation(owner, '', {sourceSkeleton: skeleton});
            expect(wrapper.querySelectorAll('script, iframe, button, foreignObject, section')).toHaveLength(0);
            expect(wrapper.querySelector('[onclick], [tabindex], [href]')).toBeNull();
            expect(wrapper.querySelector('use')?.getAttribute('xlink:href')).toBe('#external-glyph');
            expect([...wrapper.querySelectorAll('img')].every(img => !img.hasAttribute('src'))).toBe(true);
            expect(wrapper.querySelector('[data-mjx-test]')?.getAttribute('style')).toBe('height:1em;position:relative;left:0');
            expect(wrapper.querySelector('[fill]')).toBeNull();
            wrapper.remove();
            const provider = appendBilingualTranslation(owner, '<span class="katex" style="height:100vh"><math><mi>x</mi></math><img src="https://bad"></span>');
            expect(provider.querySelector('math, img, .katex, [style]')).toBeNull();
            expect(provider.textContent).toBe('x');
        });
    });

    it('双语 renderer 只替换直属 owned 孤儿 wrapper，并保留后代独立译文与非 owned 节点', async () => {
        const {document} = parseHTML(`
            <html><body>
                <p id="owner" class="fluent-read-bilingual">
                    Source text.
                    <span id="direct-owned" class="fluent-read-bilingual-content"
                        data-fr-translation-owned="true" translate="no">旧直属译文</span>
                    <span id="direct-unowned" class="fluent-read-bilingual-content">宿主同名节点</span>
                    <span id="nested-owner">
                        <span id="nested-owned" class="fluent-read-bilingual-content"
                            data-fr-translation-owned="true" translate="no">独立后代译文</span>
                    </span>
                </p>
            </body></html>
        `);
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const directOwned = document.querySelector<HTMLElement>('#direct-owned')!;
        const directUnowned = document.querySelector<HTMLElement>('#direct-unowned')!;
        const nestedOwned = document.querySelector<HTMLElement>('#nested-owned')!;

        await withDocumentRealm(document, async () => {
            const wrapper = appendBilingualTranslation(owner, '新的直属译文');
            const directOwnedWrappers = Array.from(owner.children).filter((child) =>
                child.matches('.fluent-read-bilingual-content[data-fr-translation-owned="true"]'));

            expect(directOwned.isConnected).toBe(false);
            expect(directOwnedWrappers).toEqual([wrapper]);
            expect(wrapper.textContent).toBe('新的直属译文');
            expect(directUnowned.parentElement).toBe(owner);
            expect(nestedOwned.isConnected).toBe(true);
            expect(nestedOwned.textContent).toBe('独立后代译文');
            expect(owner.querySelectorAll(
                '.fluent-read-bilingual-content[data-fr-translation-owned="true"]',
            )).toHaveLength(2);
        });
    });

    it('仅译文 renderer 在闭合 ShadowRoot 显示译文，不改写宿主 textContent', async () => {
        const {document} = parseHTML('<html><body><relative-time id="time">12 hours ago</relative-time></body></html>');
        const owner = document.querySelector<HTMLElement>('#time')!;
        const source = owner.firstChild as Text;

        await withDocumentRealm(document, async () => {
            beginTranslation(owner, 'single', 'content', false, '12 hours ago', [source]);
            const hosts = appendSingleTranslationSlots(owner, [{node: source, text: '12 小时前'}], {
                targetLanguage: 'zh-Hans',
            });
            setSingleTextSlotHosts(owner, hosts);

            expect(hosts).toHaveLength(1);
            expect(hosts[0]!.firstChild).toBe(source);
            expect(hosts[0]!.shadowRoot).toBeNull();
            expect(hosts[0]!.lang).toBe('zh-Hans');
            expect(hosts[0]!.getAttribute('translate')).toBe('no');
            expect(hosts[0]!.getAttribute('aria-label')).toBe('12 小时前');
            expect(owner.textContent).toBe('12 hours ago');
            expect(source.nodeValue).toBe('12 hours ago');

            expect(restoreTranslation(owner)).toBe(true);
            expect(owner.firstChild).toBe(source);
            expect(owner.textContent).toBe('12 hours ago');
        });
    });

    it('仅译文 renderer 原子拒绝失效文本槽，并覆盖空语言回退', async () => {
        const {document} = parseHTML('<html><body><p id="owner">Owner</p><p id="foreign">Foreign</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const foreign = document.querySelector<HTMLElement>('#foreign')!;
        const ownerSource = owner.firstChild as Text;
        const foreignSource = foreign.firstChild as Text;
        const detached = document.createTextNode('Detached');
        const previousTo = config.to;

        await withDocumentRealm(document, async () => {
            expect(appendSingleTranslationSlots(owner, [])).toEqual([]);
            expect(appendSingleTranslationSlots(owner, [{node: detached, text: '脱离'}])).toEqual([]);
            expect(appendSingleTranslationSlots(owner, [{node: foreignSource, text: '外部'}])).toEqual([]);
            expect(owner.textContent).toBe('Owner');
            expect(foreign.textContent).toBe('Foreign');

            try {
                config.to = '';
                beginTranslation(owner, 'single', 'content', false, 'Owner', [ownerSource]);
                const hosts = appendSingleTranslationSlots(owner, [{node: ownerSource, text: '所有者'}]);
                setSingleTextSlotHosts(owner, hosts);
                expect(hosts[0]!.lang).toBe('');
                expect(restoreTranslation(owner)).toBe(true);
            } finally {
                config.to = previousTo;
            }
        });
    });

    it('优先使用全文会话冻结的目标语言和译文样式，不受实时配置切换影响', async () => {
        const {document} = parseHTML('<html><body><p id="owner">Readable paragraph.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const previousConfig = {...config};
        const previousStyles = [...options.styles];

        await withDocumentRealm(document, async () => {
            try {
                Object.assign(config, {style: 7, to: 'ja'});
                options.styles = [
                    {value: 7, class: 'fr-live-style'},
                    {value: 9, class: 'fr-session-style'},
                ] as typeof options.styles;

                const wrapper = appendBilingualTranslation(owner, '会话译文', {
                    targetLanguage: 'zh-Hans',
                    style: 9,
                });
                expect(wrapper.lang).toBe('zh-Hans');
                expect(wrapper.classList.contains('fr-session-style')).toBe(true);
                expect(wrapper.classList.contains('fr-live-style')).toBe(false);
            } finally {
                Object.assign(config, previousConfig);
                options.styles = previousStyles;
            }
        });
    });

    it('accepts empty renderer text and ignores parser nodes that are not element or text', async () => {
        const {document} = parseHTML('<html><body><p id="owner">Readable paragraph.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;

        await withDocumentRealm(document, async () => {
            const previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
            class FixtureDOMParser {
                parseFromString(): Document {
                    return {
                        body: {
                            childNodes: [
                                {nodeType: Node.TEXT_NODE, nodeValue: null},
                                {nodeType: Node.COMMENT_NODE, nodeValue: 'ignored'},
                            ],
                        },
                    } as unknown as Document;
                }
            }

            try {
                Object.defineProperty(globalThis, 'DOMParser', {
                    configurable: true,
                    value: FixtureDOMParser,
                });
                const attempt = beginTranslation(owner, 'bilingual')!;
                attempt.state.phase = 'translated';
                const wrapper = appendBilingualTranslation(owner, '');

                expect(wrapper.textContent).toBe('');
                expect(wrapper.childNodes).toHaveLength(1);
                expect(restoreTranslation(owner)).toBe(true);
            } finally {
                if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser);
                else Reflect.deleteProperty(globalThis, 'DOMParser');
            }
        });
    });

    it('shares one clamp lease and restores its properties only after the last owner exits', () => {
        const {clamp, first, second} = openRouterFixture();
        clamp.setAttribute(
            'style',
            '-webkit-line-clamp: 2 !important; max-height: 40px; color: red;',
        );
        const firstAttempt = beginTranslation(first, 'bilingual')!;
        const secondAttempt = beginTranslation(second, 'bilingual')!;

        expect(acquireTranslationLayoutOverride(
            first,
            clamp,
            translationTruncationStyleOverrides,
        )).toBe(true);
        expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
        expect(isTranslationLayoutOverrideMutation(clamp)).toBe(true);

        expect(acquireTranslationLayoutOverride(
            second,
            clamp,
            translationTruncationStyleOverrides,
        )).toBe(true);
        expect(hasTranslationLayoutOverride(clamp)).toBe(true);

        firstAttempt.state.phase = 'translated';
        expect(restoreTranslation(first)).toBe(true);
        expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
        expect(hasTranslationLayoutOverride(clamp)).toBe(true);

        clamp.style.setProperty('background-color', 'blue');
        secondAttempt.state.phase = 'translated';
        expect(restoreTranslation(second)).toBe(true);
        expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toMatch(/^2(?: !important)?$/u);
        expect(clamp.style.getPropertyValue('max-height')).toBe('40px');
        expect(clamp.style.getPropertyValue('color')).toBe('red');
        expect(clamp.style.getPropertyValue('background-color')).toBe('blue');
        expect(clamp.style.getPropertyValue('line-clamp') ?? '').toBe('');
        expect(hasTranslationLayoutOverride(clamp)).toBe(false);
    });

    it('preserves a host clamp rewrite instead of restoring the stale pre-translation value', () => {
        const {clamp, first} = openRouterFixture();
        clamp.style.setProperty('-webkit-line-clamp', '2');
        const attempt = beginTranslation(first, 'bilingual')!;
        acquireTranslationLayoutOverride(first, clamp, translationTruncationStyleOverrides);

        clamp.style.setProperty('-webkit-line-clamp', '4', 'important');
        expect(isTranslationLayoutOverrideMutation(clamp)).toBe(false);
        attempt.state.phase = 'translated';
        expect(restoreTranslation(first)).toBe(true);

        expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('4');
    });

    it('reapplies an overridden host clamp and restores the host rewrite as the new baseline', () => {
        const {clamp, first} = openRouterFixture();
        clamp.style.setProperty('-webkit-line-clamp', '2');
        commitBilingualTranslation(first);

        clamp.setAttribute('style', '-webkit-line-clamp: 4; background-color: blue;');
        expect(reconcileTranslationLayoutOverrides(first)).toBe(true);
        expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
        expect(clamp.style.getPropertyValue('background-color')).toBe('blue');

        expect(restoreTranslation(first)).toBe(true);
        expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('4');
        expect(clamp.style.getPropertyValue('background-color')).toBe('blue');
    });

    it('releases a hover-style lease when its translated owner is detached', async () => {
        const {document, clamp, first} = openRouterFixture();
        await withDocumentRealm(document, async () => {
            clamp.style.setProperty('-webkit-line-clamp', '2');
            commitBilingualTranslation(first);
            await flushMutationObservers();
            first.remove();
            await flushMutationObservers();

            try {
                expect(getTranslationState(first)).toBeUndefined();
                expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
                expect(hasTranslationLayoutOverride(clamp)).toBe(false);
            } finally {
                if (getTranslationState(first)) restoreTranslation(first);
            }
        });
    });

    it('keeps a connected hover owner when the host removes its bilingual wrapper', async () => {
        const {document, clamp, first} = openRouterFixture();
        await withDocumentRealm(document, async () => {
            clamp.style.setProperty('-webkit-line-clamp', '2');
            const wrapper = commitBilingualTranslation(first);
            await flushMutationObservers();

            wrapper.remove();
            await flushMutationObservers();

            try {
                expect(getTranslationState(first)?.phase).toBe('translated');
                expect(first.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
                expect(first.querySelector('.fluent-read-bilingual-content')).toBe(wrapper);
                expect(wrapper.isConnected).toBe(true);
                expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
            } finally {
                if (getTranslationState(first)) restoreTranslation(first);
            }
        });
    });

    it('hover-only observer 收养等价 owned wrapper clone，保持同一 generation 与译文', async () => {
        const {document, first} = openRouterFixture();
        await withDocumentRealm(document, async () => {
            const wrapper = commitBilingualTranslation(first);
            await flushMutationObservers();
            const initialState = getTranslationState(first)!;
            const clonedWrapper = wrapper.cloneNode(true) as HTMLElement;

            wrapper.replaceWith(clonedWrapper);
            await flushMutationObservers();

            try {
                expect(getTranslationState(first)).toBe(initialState);
                expect(initialState.phase).toBe('translated');
                expect(initialState.bilingualContent).toBe(clonedWrapper);
                expect(first.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
                expect(first.textContent).toContain('Translated text.');
                expect(wrapper.isConnected).toBe(false);
                expect(clonedWrapper.isConnected).toBe(true);
            } finally {
                if (getTranslationState(first)) restoreTranslation(first);
            }
        });
    });

    it('hover-only observer 接受宿主仅给 owned wrapper 添加 class，不闪回原文', async () => {
        const {document, first} = openRouterFixture();
        await withDocumentRealm(document, async () => {
            const wrapper = commitBilingualTranslation(first);
            await flushMutationObservers();
            const initialState = getTranslationState(first)!;

            wrapper.classList.add('host-layout-class');
            await flushMutationObservers();

            try {
                expect(getTranslationState(first)).toBe(initialState);
                expect(initialState.phase).toBe('translated');
                expect(initialState.bilingualContent).toBe(wrapper);
                expect(wrapper.classList.contains('host-layout-class')).toBe(true);
                expect(first.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
                expect(first.textContent).toContain('Translated text.');
            } finally {
                if (getTranslationState(first)) restoreTranslation(first);
            }
        });
    });

    it.each(['attribute', 'class'])('字体脚本反复补写 %s 标记时保留同一译文节点和 generation', async (mode) => {
        const {document, first} = openRouterFixture();
        await withDocumentRealm(document, async () => {
            // 字体脚本先监听新增内容，再在 FluentRead 保存快照后补写粗体标记。
            let fontPasses = 0;
            const fontObserver = new MutationObserver(() => {
                if (++fontPasses > 12) { fontObserver.disconnect(); return; }
                first.querySelectorAll('.fluent-read-bilingual-content, .fluent-read-bilingual-content strong').forEach((el) => {
                    if (mode === 'attribute') el.setAttribute('ultimate-bold-correct', '');
                    else el.classList.add('ultimate-bold-correct');
                });
            });
            fontObserver.observe(first, {childList: true, subtree: true});
            const attempt = beginTranslation(first, 'bilingual')!;
            attempt.state.phase = 'translated';
            expect(ensureTranslationTruncationLayout(first)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.innerHTML = '<strong>译文粗体</strong>和普通译文';
            first.appendChild(wrapper);
            setBilingualContent(first, wrapper);
            try {
                for (let round = 0; round < 8; round += 1) {
                    await flushMutationObservers();
                    expect(getTranslationState(first)).toBe(attempt.state);
                    expect(first.querySelector('.fluent-read-bilingual-content')).toBe(wrapper);
                    expect(attempt.state.phase).toBe('translated');
                    expect(hasBilingualArtifactHostWriteBudget(first)).toBe(false);
                }
            } finally {
                fontObserver.disconnect();
                if (getTranslationState(first)) restoreTranslation(first);
            }
            expect(first.querySelector('.fluent-read-bilingual-content')).toBeNull();
        });
    });

    it('hover-only observer 不收养内容被宿主篡改的 owned wrapper clone', async () => {
        const {document, first} = openRouterFixture();
        await withDocumentRealm(document, async () => {
            const wrapper = commitBilingualTranslation(first);
            await flushMutationObservers();
            const tamperedWrapper = wrapper.cloneNode(true) as HTMLElement;
            tamperedWrapper.textContent = 'Host-forged translation.';

            wrapper.replaceWith(tamperedWrapper);
            await flushMutationObservers();

            try {
                const nextState = getTranslationState(first);
                expect(nextState?.bilingualContent).not.toBe(tamperedWrapper);
                expect(tamperedWrapper.isConnected).toBe(false);
                expect(first.textContent).not.toContain('Host-forged translation.');
                if (nextState) {
                    expect(nextState.phase).toBe('translated');
                    expect(nextState.bilingualContent?.textContent).toBe('Translated text.');
                }
            } finally {
                if (getTranslationState(first)) restoreTranslation(first);
            }
        });
    });

    it('hover-only observer 在原位 href 变化时丢弃旧输出骨架并保留宿主链接', async () => {
        const {document} = parseHTML(
            '<html><body><p id="owner"><a href="/before">Readable link.</a></p></body></html>',
        );
        await withDocumentRealm(document, async () => {
            const owner = document.querySelector<HTMLElement>('#owner')!;
            const link = owner.querySelector<HTMLAnchorElement>('a')!;
            const wrapper = commitBilingualTranslation(owner);
            await flushMutationObservers();

            link.setAttribute('href', '/after');
            await flushMutationObservers();

            expect(getTranslationState(owner)).toBeUndefined();
            expect(wrapper.isConnected).toBe(false);
            expect(link.getAttribute('href')).toBe('/after');
            expect(owner.textContent).toBe('Readable link.');
        });
    });

    it('hover-only 已译 owner 的祖先变为 contenteditable 时立即恢复原文并清理状态', async () => {
        const {document} = parseHTML(
            '<html><body><section id="editor-shell"><p id="owner">Editable source.</p></section></body></html>',
        );
        await withDocumentRealm(document, async () => {
            const ancestor = document.querySelector<HTMLElement>('#editor-shell')!;
            const owner = document.querySelector<HTMLElement>('#owner')!;
            const wrapper = commitBilingualTranslation(owner);
            await flushMutationObservers();

            ancestor.setAttribute('contenteditable', 'true');
            await flushMutationObservers();

            try {
                expect(getTranslationState(owner)).toBeUndefined();
                expect(wrapper.isConnected).toBe(false);
                expect(owner.querySelector('.fluent-read-bilingual-content')).toBeNull();
                expect(owner.textContent).toBe('Editable source.');
            } finally {
                if (getTranslationState(owner)) restoreTranslation(owner);
            }
        });
    });

    it('hover-only owner 的祖先仅变更普通 class/style 时不触发资格清理', async () => {
        const {document} = parseHTML(
            '<html><body><section id="shell"><p id="owner">Stable source.</p></section></body></html>',
        );
        await withDocumentRealm(document, async () => {
            const ancestor = document.querySelector<HTMLElement>('#shell')!;
            const owner = document.querySelector<HTMLElement>('#owner')!;
            const wrapper = commitBilingualTranslation(owner);
            await flushMutationObservers();
            const initialState = getTranslationState(owner);

            ancestor.classList.add('host-hover');
            ancestor.style.color = 'red';
            await flushMutationObservers();

            try {
                expect(getTranslationState(owner)).toBe(initialState);
                expect(wrapper.isConnected).toBe(true);
                expect(owner.querySelector('.fluent-read-bilingual-content')).toBe(wrapper);
            } finally {
                if (getTranslationState(owner)) restoreTranslation(owner);
            }
        });
    });

    it.each(['semantic class', 'semantic style'] as const)(
        'hover-only owner 的祖先出现 %s 保护时恢复原文',
        async (guard) => {
            const {document} = parseHTML(
                '<html><body><section id="shell"><p id="owner">Protected source.</p></section></body></html>',
            );
            Object.defineProperty(document.defaultView, 'getComputedStyle', {
                configurable: true,
                value: (element: Element) => ({
                    display: (element as HTMLElement).style.display || 'block',
                    visibility: (element as HTMLElement).style.visibility || 'visible',
                    webkitLineClamp: 'none',
                    getPropertyValue: (property: string) => property === 'display'
                        ? (element as HTMLElement).style.display || 'block'
                        : property === 'visibility'
                            ? (element as HTMLElement).style.visibility || 'visible'
                            : '',
                }) as unknown as CSSStyleDeclaration,
            });
            await withDocumentRealm(document, async () => {
                const ancestor = document.querySelector<HTMLElement>('#shell')!;
                const owner = document.querySelector<HTMLElement>('#owner')!;
                const wrapper = commitBilingualTranslation(owner);
                await flushMutationObservers();

                if (guard === 'semantic class') ancestor.classList.add('notranslate');
                else ancestor.style.display = 'none';
                await flushMutationObservers();

                expect(getTranslationState(owner)).toBeUndefined();
                expect(wrapper.isConnected).toBe(false);
                expect(owner.textContent).toBe('Protected source.');
            });
        },
    );

    it('hover 显式放行的顶层 translate=no 应用壳不会被语义复验误清理', async () => {
        const {document} = parseHTML(
            '<html><body><section id="app" translate="no"><p id="owner">Explicit source.</p></section></body></html>',
        );
        await withDocumentRealm(document, async () => {
            const app = document.querySelector<HTMLElement>('#app')!;
            const owner = document.querySelector<HTMLElement>('#owner')!;
            const source = owner.firstChild as Text;
            const attempt = beginTranslation(
                owner, 'bilingual', 'content', false, source.data, [source], true,
            )!;
            attempt.state.phase = 'translated';
            expect(ensureTranslationTruncationLayout(owner)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '显式译文。';
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
            await flushMutationObservers();

            app.setAttribute('lang', 'en');
            await flushMutationObservers();

            try {
                expect(getTranslationState(owner)).toBe(attempt.state);
                expect(wrapper.isConnected).toBe(true);
                expect(owner.textContent).toContain('显式译文。');
            } finally {
                if (getTranslationState(owner)) restoreTranslation(owner);
            }
        });
    });

    it('keeps an overflow owner through ordinary hover class changes, then restores on real source mutation', async () => {
        const {document} = parseHTML('<html><body><div id="owner"></div></body></html>');
        await withDocumentRealm(document, async () => {
            const owner = document.querySelector<HTMLElement>('#owner')!;
            let deepest = owner;
            for (let depth = 0; depth < 140; depth += 1) {
                const child = document.createElement('span');
                deepest.appendChild(child);
                deepest = child;
            }
            deepest.textContent = 'Deep source.';
            const wrapper = commitBilingualTranslation(owner);
            await flushMutationObservers();
            expect(getTranslationState(owner)?.sourceStructureSignature).toBe('overflow');

            owner.className = 'host-hovered';
            await flushMutationObservers();
            expect(getTranslationState(owner)?.phase).toBe('translated');
            expect(wrapper.isConnected).toBe(true);

            owner.style.color = 'red';
            await flushMutationObservers();
            expect(getTranslationState(owner)?.phase).toBe('translated');
            expect(wrapper.isConnected).toBe(true);

            owner.setAttribute('lang', 'fr');
            await flushMutationObservers();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(wrapper.isConnected).toBe(false);
            expect(owner.textContent).toBe('Deep source.');
            expect(owner.getAttribute('lang')).toBe('fr');
        });
    });

    it.each([
        ['MathJax class', (target: HTMLElement): void => { target.classList.add('MathJax'); }],
        ['inline display', (target: HTMLElement): void => { target.style.display = 'none'; }],
    ] as const)('overflow owner 在 %s 语义变化后恢复而不保留旧骨架', async (_name, mutate) => {
        const {document} = parseHTML('<html><body><div id="owner">Readable source.</div></body></html>');
        await withDocumentRealm(document, async () => {
            const owner = document.querySelector<HTMLElement>('#owner')!;
            let deepest = owner;
            for (let depth = 0; depth < 140; depth += 1) {
                const child = document.createElement('span');
                deepest.appendChild(child);
                deepest = child;
            }
            const target = document.createElement('span');
            target.textContent = 'Deep source.';
            deepest.appendChild(target);
            const wrapper = commitBilingualTranslation(owner);
            await flushMutationObservers();
            expect(getTranslationState(owner)?.sourceStructureSignature).toBe('overflow');

            mutate(target);
            await flushMutationObservers();

            expect(getTranslationState(owner)).toBeUndefined();
            expect(wrapper.isConnected).toBe(false);
            expect(owner.textContent).not.toContain('Translated text.');
        });
    });

    it('overflow mutation 的祖先查找在异常深 DOM 上保持有界', async () => {
        const {document} = parseHTML('<html><body><div id="owner">Readable source.</div></body></html>');
        await withDocumentRealm(document, async () => {
            const owner = document.querySelector<HTMLElement>('#owner')!;
            let deepest = owner;
            for (let depth = 0; depth < 540; depth += 1) {
                const child = document.createElement('span');
                deepest.appendChild(child);
                deepest = child;
            }
            deepest.textContent = 'Protected extreme-depth source.';
            const wrapper = commitBilingualTranslation(owner);
            await flushMutationObservers();
            expect(getTranslationState(owner)?.sourceStructureSignature).toBe('overflow');

            deepest.classList.add('MathJax');
            await flushMutationObservers();

            expect(getTranslationState(owner)).toBeUndefined();
            expect(wrapper.isConnected).toBe(false);
        });
    });

    it('overflow owner 同位重建完全相同的 source DOM 时重绑 Text 并保留译文', async () => {
        const {document} = parseHTML('<html><body><div id="owner"></div></body></html>');
        await withDocumentRealm(document, async () => {
            const owner = document.querySelector<HTMLElement>('#owner')!;
            let deepest = owner;
            for (let depth = 0; depth < 140; depth += 1) {
                const child = document.createElement('span');
                deepest.appendChild(child);
                deepest = child;
            }
            deepest.textContent = 'Exact overflow source.';
            commitBilingualTranslation(owner);
            await flushMutationObservers();
            const originalState = getTranslationState(owner)!;
            const originalTextNode = originalState.sourceTextNodes?.at(-1);
            const sourceHTML = originalState.sourceHTML;

            owner.innerHTML = sourceHTML;
            await flushMutationObservers();

            const reboundState = getTranslationState(owner)!;
            expect(reboundState).toBe(originalState);
            expect(reboundState.phase).toBe('translated');
            expect(reboundState.sourceStructureDirty).toBe(false);
            expect(reboundState.sourceTextNodes?.at(-1)).not.toBe(originalTextNode);
            expect(reboundState.sourceTextNodes?.every((node) => node.isConnected)).toBe(true);
            expect(owner.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
        });
    });

    it('atomically hands a hover-only translation to an equivalent remounted owner', async () => {
        const {document} = parseHTML(
            '<html><body><article id="row"><p id="owner">Hover-only remount stays translated.</p></article></body></html>',
        );
        await withDocumentRealm(document, async () => {
            const row = document.querySelector<HTMLElement>('#row')!;
            const owner = document.querySelector<HTMLElement>('#owner')!;
            const source = owner.firstChild as Text;
            const attempt = beginTranslation(
                owner, 'bilingual', 'content', false, source.data, [source],
            )!;
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            expect(ensureTranslationTruncationLayout(owner)).toBe(true);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '仅悬停重挂仍保留译文。';
            owner.appendChild(wrapper);
            setBilingualContent(owner, wrapper);
            await flushMutationObservers();

            setBilingualOwnerRemountHandler((mutations) => {
                transferEquivalentBilingualOwners(mutations, (_old, replacement) => ({
                    sourceTextNodes: [replacement.firstChild as Text],
                    reconcileLayout: ensureTranslationTruncationLayout,
                }));
            });
            const replacement = document.createElement('p');
            replacement.id = 'owner';
            replacement.textContent = source.data;
            owner.replaceWith(replacement);
            await flushMutationObservers();

            try {
                expect(getTranslationState(owner)).toBeUndefined();
                expect(getTranslationState(replacement)?.phase).toBe('translated');
                expect(replacement.querySelectorAll('.fluent-read-bilingual-content')).toHaveLength(1);
                expect(replacement.textContent).toContain('仅悬停重挂仍保留译文。');
            } finally {
                setBilingualOwnerRemountHandler(undefined);
                if (getTranslationState(replacement)) restoreTranslation(replacement);
                row.replaceChildren();
            }
        });
    });

    it('restores and reacquires a cloned ancestor clamp during whole-subtree remount', async () => {
        const {document} = parseHTML(
            '<html><body><article id="row" style="-webkit-line-clamp: 2"><p id="owner">Cloned clamp stays reversible.</p></article></body></html>',
        );
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => {
                const inlineClamp = (element as HTMLElement).style?.getPropertyValue('-webkit-line-clamp') ?? '';
                const lineClamp = inlineClamp === 'unset' ? 'none' : inlineClamp || 'none';
                return {
                    webkitLineClamp: lineClamp,
                    getPropertyValue: (property: string) =>
                        property === '-webkit-line-clamp' || property === 'line-clamp' ? lineClamp : '',
                } as unknown as CSSStyleDeclaration;
            },
        });
        await withDocumentRealm(document, async () => {
            const row = document.querySelector<HTMLElement>('#row')!;
            const owner = document.querySelector<HTMLElement>('#owner')!;
            commitBilingualTranslation(owner);
            await flushMutationObservers();
            expect(row.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');

            setBilingualOwnerRemountHandler((mutations) => {
                transferEquivalentBilingualOwners(mutations, (_old, replacement) => ({
                    sourceTextNodes: [replacement.firstChild as Text],
                    reconcileLayout: ensureTranslationTruncationLayout,
                }));
            });
            const replacementRow = row.cloneNode(true) as HTMLElement;
            const replacementOwner = replacementRow.querySelector<HTMLElement>('#owner')!;
            row.replaceWith(replacementRow);
            await flushMutationObservers();

            try {
                expect(getTranslationState(owner)).toBeUndefined();
                expect(getTranslationState(replacementOwner)?.phase).toBe('translated');
                expect(replacementRow.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
                expect(hasTranslationLayoutOverride(replacementRow)).toBe(true);
                expect(restoreTranslation(replacementOwner)).toBe(true);
                expect(replacementRow.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
            } finally {
                setBilingualOwnerRemountHandler(undefined);
                if (getTranslationState(replacementOwner)) restoreTranslation(replacementOwner);
            }
        });
    });

    it('moves a connected hover owner lease from clamp A to clamp B', async () => {
        const {document} = parseHTML(`
            <html><body>
                <div id="clamp-a" style="-webkit-line-clamp: 2"><p id="owner">Moved prose.</p></div>
                <div id="clamp-b" style="-webkit-line-clamp: 3"></div>
            </body></html>
        `);
        const clampA = document.querySelector<HTMLElement>('#clamp-a')!;
        const clampB = document.querySelector<HTMLElement>('#clamp-b')!;
        const owner = document.querySelector<HTMLElement>('#owner')!;
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => {
                const inlineClamp = (element as HTMLElement).style?.getPropertyValue('-webkit-line-clamp') ?? '';
                const lineClamp = inlineClamp === 'unset' ? 'none' : inlineClamp || 'none';
                return {
                    webkitLineClamp: lineClamp,
                    getPropertyValue: (property: string) =>
                        property === '-webkit-line-clamp' || property === 'line-clamp' ? lineClamp : '',
                } as unknown as CSSStyleDeclaration;
            },
        });

        await withDocumentRealm(document, async () => {
            const wrapper = commitBilingualTranslation(owner);
            await flushMutationObservers();
            expect(clampA.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');

            clampB.appendChild(owner);
            await flushMutationObservers();

            try {
                expect(getTranslationState(owner)?.phase).toBe('translated');
                expect(wrapper.isConnected).toBe(true);
                expect(clampA.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
                expect(clampB.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
            } finally {
                if (getTranslationState(owner)) restoreTranslation(owner);
            }
        });
    });

    it.each([
        {
            trigger: 'class',
            activate: (clamp: HTMLElement) => clamp.classList.add('line-clamp-2'),
            restoredClamp: '',
        },
        {
            trigger: 'inline style',
            activate: (clamp: HTMLElement) => clamp.style.setProperty('-webkit-line-clamp', '2'),
            restoredClamp: '2',
        },
    ])('automatically acquires an ancestor clamp activated through $trigger', async ({activate, restoredClamp}) => {
        const {document, clamp, owner} = dynamicClampFixture();
        await withDocumentRealm(document, async () => {
            commitBilingualTranslation(owner);
            await flushMutationObservers();
            expect(clamp.style.getPropertyValue('-webkit-line-clamp') ?? '').toBe('');

            activate(clamp);
            await flushMutationObservers();

            try {
                expect(getTranslationState(owner)?.phase).toBe('translated');
                expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
            } finally {
                if (getTranslationState(owner)) restoreTranslation(owner);
            }
            expect(clamp.style.getPropertyValue('-webkit-line-clamp') ?? '').toBe(restoredClamp);
        });
    });

    it('reapplies a hover owner override after the host rewrites its inline clamp', async () => {
        const {document, first} = openRouterFixture();
        await withDocumentRealm(document, async () => {
            Object.defineProperty(document.defaultView, 'getComputedStyle', {
                configurable: true,
                value: (element: Element) => {
                    const lineClamp = (element as HTMLElement).style
                        ?.getPropertyValue('-webkit-line-clamp') || 'none';
                    return {
                        webkitLineClamp: lineClamp, maxHeight: 'none', overflowY: 'visible', overflow: 'visible',
                        getPropertyValue: (property: string) =>
                            property === '-webkit-line-clamp' || property === 'line-clamp' ? lineClamp : '',
                    } as unknown as CSSStyleDeclaration;
                },
            });
            commitBilingualTranslation(first);
            await flushMutationObservers();

            first.setAttribute('style', '-webkit-line-clamp: 2; color: blue;');
            await flushMutationObservers();

            try {
                expect(hasTranslationLayoutOverride(first)).toBe(true);
                expect(first.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
                expect(first.style.getPropertyValue('color')).toBe('blue');
            } finally {
                if (getTranslationState(first)) restoreTranslation(first);
            }
            expect(first.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
            expect(first.style.getPropertyValue('color')).toBe('blue');
        });
    });

    it('真实 max-height 溢出 owner 仍会展开，并在恢复时保留宿主原样式', async () => {
        const {document} = parseHTML(
            '<html><body><p id="owner" style="max-height:40px;overflow:hidden;color:blue">Long source.</p></body></html>',
        );
        const owner = document.querySelector<HTMLElement>('#owner')!;
        Object.defineProperties(owner, {
            scrollHeight: {configurable: true, value: 120},
            clientHeight: {configurable: true, value: 40},
        });
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: HTMLElement) => ({
                webkitLineClamp: 'none',
                maxHeight: element.style.getPropertyValue('max-height') || 'none',
                overflowY: element.style.getPropertyValue('overflow-y') || element.style.overflow || 'visible',
                overflow: element.style.overflow || 'visible',
                getPropertyValue: () => '',
            } as unknown as CSSStyleDeclaration),
        });

        await withDocumentRealm(document, async () => {
            commitBilingualTranslation(owner);
            expect(owner.style.getPropertyValue('max-height')).toBe('unset');
            expect(owner.style.getPropertyValue('color')).toBe('blue');
            expect(hasTranslationLayoutOverride(owner)).toBe(true);

            expect(restoreTranslation(owner)).toBe(true);
            expect(owner.style.getPropertyValue('max-height')).toBe('40px');
            expect(owner.style.overflow).toBe('hidden');
            expect(owner.style.getPropertyValue('color')).toBe('blue');
        });
    });

    it('automatically releases a hover lease when its owner is removed inside an open ShadowRoot', async () => {
        const {document} = parseHTML('<html><body><div id="host"></div></body></html>');
        const host = document.querySelector<HTMLElement>('#host')!;
        const shadowRoot = host.attachShadow({mode: 'open'});
        const clamp = document.createElement('div');
        const owner = document.createElement('p');
        clamp.style.setProperty('-webkit-line-clamp', '2');
        owner.textContent = 'Shadow-root model description.';
        clamp.appendChild(owner);
        shadowRoot.appendChild(clamp);
        Object.defineProperty(document.defaultView, 'getComputedStyle', {
            configurable: true,
            value: (element: Element) => {
                const inlineClamp = (element as HTMLElement).style?.getPropertyValue('-webkit-line-clamp') ?? '';
                const lineClamp = inlineClamp === 'unset' ? 'none' : inlineClamp || 'none';
                return {
                    webkitLineClamp: lineClamp,
                    getPropertyValue: (property: string) =>
                        property === '-webkit-line-clamp' || property === 'line-clamp' ? lineClamp : '',
                } as unknown as CSSStyleDeclaration;
            },
        });

        await withDocumentRealm(document, async () => {
            commitBilingualTranslation(owner);
            await flushMutationObservers();
            expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');

            owner.remove();
            await flushMutationObservers();

            try {
                expect(getTranslationState(owner)).toBeUndefined();
                expect(clamp.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
            } finally {
                if (getTranslationState(owner)) restoreTranslation(owner);
            }
        });
    });

    it('restores the exact original style attribute when the host did not mutate it', () => {
        const {clamp, first} = openRouterFixture();
        const originalStyle = 'COLOR: red; -webkit-line-clamp: 2; max-height: 40px';
        clamp.setAttribute('style', originalStyle);
        const attempt = beginTranslation(first, 'bilingual')!;
        acquireTranslationLayoutOverride(first, clamp, translationTruncationStyleOverrides);
        attempt.state.phase = 'translated';

        expect(restoreTranslation(first)).toBe(true);
        expect(clamp.getAttribute('style')).toBe(originalStyle);
    });

    it('removes a temporary style attribute when the unclamped ancestor originally had none', () => {
        const {clamp, first} = openRouterFixture();
        expect(clamp.getAttribute('style')).toBeNull();
        const attempt = beginTranslation(first, 'bilingual')!;
        acquireTranslationLayoutOverride(first, clamp, translationTruncationStyleOverrides);
        expect(clamp.getAttribute('style')).not.toBeNull();

        attempt.state.phase = 'translated';
        expect(restoreTranslation(first)).toBe(true);
        expect(clamp.getAttribute('style')).toBeNull();
    });
});


describe('source line materialization', () => {
    it('owns only the selected line, preserving the original break and links', () => {
        for (const sourceLine of [true, false]) {
            const {document} = parseHTML('<html><body><p>First <a href="/guide">linked line</a>.<br>Second line.</p></body></html>');
            const paragraph = document.querySelector('p')!;
            const original = paragraph.innerHTML;
            const nodes = Array.from(paragraph.childNodes).slice(0, 3);
            const link = paragraph.querySelector('a')!;
            const lineBreak = paragraph.querySelector('br')!;
            const candidate = {element: paragraph, nodes, kind: 'content' as const, reason: 'test', sourceLine};
            const rendered = materializeCandidate(candidate)!;
            expect(rendered.synthetic).toBe(true);
            expect(rendered.node.classList.contains('fluent-read-source-line')).toBe(sourceLine);
            expect(Array.from(rendered.node.childNodes)).toEqual(nodes);
            expect(link.parentElement).toBe(rendered.node);
            expect(lineBreak.parentElement).toBe(paragraph);
            rendered.node.replaceWith(...Array.from(rendered.node.childNodes));
            expect(paragraph.innerHTML).toBe(original);
        }
    });

    it('leaves complete paragraphs alone and rejects stale source nodes', () => {
        const {document} = parseHTML('<html><body><p>Original line.</p></body></html>');
        const paragraph = document.querySelector('p')!;
        const candidate = {element: paragraph, kind: 'content' as const, reason: 'test'};
        expect(materializeCandidate(candidate)).toEqual({node: paragraph, synthetic: false});
        const stale = paragraph.firstChild!;
        paragraph.textContent = 'Replacement line.';
        expect(materializeCandidate({...candidate, nodes: [stale], sourceLine: true})).toBeNull();
        expect(materializeCandidate({...candidate, nodes: new Array<ChildNode>(1)})).toBeNull();
        expect(paragraph.innerHTML).toBe('Replacement line.');
    });
});

describe('visual hover chunk materialization', () => {
    function stubRange(document: Document, text: Text, options: {throwOnInsert?: boolean} = {}) {
        Object.defineProperty(document, 'createRange', {
            configurable: true,
            value: () => {
                let start = 0;
                let end = 0;
                return {
                    setStart: (_node: Node, offset: number) => { start = offset; },
                    setEnd: (_node: Node, offset: number) => { end = offset; },
                    toString: () => text.data.slice(start, end),
                    extractContents: () => {
                        // linkedom 没有 Text.splitText；按浏览器语义手动拆成前、中、后三个文本节点。
                        const fragment = document.createDocumentFragment();
                        const source = text.data;
                        text.data = source.slice(0, start);
                        text.after(document.createTextNode(source.slice(end)));
                        fragment.appendChild(document.createTextNode(source.slice(start, end)));
                        return fragment;
                    },
                    insertNode: (node: Node) => {
                        if (options.throwOnInsert) throw new Error('host rejected range');
                        text.after(node);
                    },
                } as unknown as Range;
            },
        });
    }

    it('wraps only the visual range as a manual chunk and keeps non-visual candidates unchanged', () => {
        const {document} = parseHTML('<html><body><div id="owner">Lead text. Chosen sentence here. Tail text.</div></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const text = owner.firstChild as Text;
        const plain = {element: owner, kind: 'content' as const, reason: 'generic-readable-block'};
        expect(materializeVisualTranslationCandidate(plain)).toBe(plain);

        stubRange(document, text);
        const start = text.data.indexOf('Chosen');
        const end = text.data.indexOf(' Tail');
        const visual = {...plain, visualRange: {startContainer: text, startOffset: start, endContainer: text, endOffset: end}, visualSourceText: 'Chosen sentence here.'};
        const materialized = materializeVisualTranslationCandidate(visual)!;
        expect(materialized).toMatchObject({manualChunk: true, visualRange: undefined, visualSourceText: undefined});
        expect(materialized.element.getAttribute('data-fr-translation-manual')).toBe('true');
        expect(materialized.element.textContent).toBe('Chosen sentence here.');
        expect(owner.textContent).toBe('Lead text. Chosen sentence here. Tail text.');
        expect(materializeCandidate(materialized)).toEqual({node: materialized.element, synthetic: true});
    });

    it('rejects disconnected owners, foreign boundaries, blank ranges and host range failures', () => {
        const {document} = parseHTML('<html><body><div id="owner">Lead text.   Tail text.</div><p id="other">Other</p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const text = owner.firstChild as Text;
        const foreign = document.querySelector('#other')!.firstChild as Text;
        const base = {element: owner, kind: 'content' as const, reason: 'generic-readable-block'};
        const range = (startOffset: number, endOffset: number, endContainer: Text = text) => ({startContainer: text, startOffset, endContainer, endOffset});

        stubRange(document, text);
        expect(materializeVisualTranslationCandidate({...base, visualRange: range(0, 4, foreign)})).toBeNull();
        expect(materializeVisualTranslationCandidate({...base, visualRange: range(10, 13)})).toBeNull();
        stubRange(document, text, {throwOnInsert: true});
        expect(materializeVisualTranslationCandidate({...base, visualRange: range(0, 4)})).toBeNull();

        const detached = document.createElement('div');
        detached.textContent = 'Detached';
        expect(materializeVisualTranslationCandidate({...base, element: detached, visualRange: {
            startContainer: detached.firstChild as Text, startOffset: 0, endContainer: detached.firstChild as Text, endOffset: 3,
        }})).toBeNull();
    });
});

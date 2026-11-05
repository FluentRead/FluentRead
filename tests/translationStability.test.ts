import {collectLiveTranslationTextSlots, extractTranslationText, getCurrentTranslationCore} from '@/src/core/translation/public';
import {identifyTextLanguage} from '@/src/core/language/identify';
import {getSupplementalLanguageCandidate} from '@/src/core/language/supplement';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {
    canKeepTranslationAttempt,
    getCurrentTranslationStateSourceSnapshot,
    getCurrentTranslationStateTextNodes,
    createCurrentTranslationStateSourceSnapshotBatch,
    createTranslationMutationStabilityChecks,
    createAcceptedUnchangedCompletion,
    createLifecycleRetry,
    readAcceptedUnchangedCompletion,
    sameLifecycleRetry,
    hasCurrentTranslationSource,
    isBilingualArtifactKept,
    isOwnCurrentArtifactAddition,
    isOwnStateArtifactMutation,
    isOwnSingleTextSlotMove,
    isTranslationArtifact,
    isTranslationArtifactCurrent,
    isTranslationCandidateCurrent,
    isTranslationStateCandidateCurrent,
    isTranslationStateSourceCurrent,
    mutationTouchesCurrentTranslationArtifact,
    reboundLiveTextResult,
    statefulSourceAndTextSlotsAreCurrent,
} from '@/src/features/full-page-translation/content/translationStability';
import {
    beginTranslation,
    discardTranslation,
    getTranslationState,
    markTranslationComplete,
    setSingleTextSlotHosts,
    restoreTranslation,
    getTranslationOverflowGenerationIdentity,
    getTranslationSourceStructureSignature,
    type TranslationState,
} from '@/src/features/full-page-translation/content/state';

function state(overrides: Partial<TranslationState> = {}): TranslationState {
    return {
        mode: 'bilingual',
        kind: 'content',
        phase: 'loading',
        generation: 1,
        sourceText: 'source',
        sourceHTML: 'source',
        syntheticSegment: false,
        originalStyleAttribute: null,
        originalClassAttribute: null,
        originalTextValues: [],
        controller: new AbortController(),
        ...overrides,
    };
}

function childListRecord(
    target: Node,
    addedNodes: readonly Node[] = [],
    removedNodes: readonly Node[] = [],
): MutationRecord {
    return {
        type: 'childList',
        target,
        addedNodes: addedNodes as unknown as NodeList,
        removedNodes: removedNodes as unknown as NodeList,
    } as MutationRecord;
}

describe('动态翻译稳定性判定', () => {
    it('来源 HTML 回退复验保留图片与相对链接原属性、实时 Text 身份及宿主节点', () => {
        const {document} = parseHTML('<html><body><p id="owner"><a href="../paper">Source text.</a>' +
            '<img src="../icon.png" srcset="../icon@2x.png 2x"></p></body></html>');
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const link = owner.querySelector('a')!;
        const image = owner.querySelector('img')!;
        const source = link.firstChild as Text;
        const current = state({phase: 'translated', sourceText: 'Source text.', sourceHTML: owner.innerHTML,
            sourceTextNodes: [source], sourceStructureSignature: undefined});
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content'; wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文'; owner.appendChild(wrapper);
        const before = owner.outerHTML;
        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(true);
        expect(owner.outerHTML).toBe(before);
        expect(current.sourceTextNodes).toEqual([source]);
        expect(owner.querySelector('a')).toBe(link); expect(owner.querySelector('img')).toBe(image);
        expect(link.getAttribute('href')).toBe('../paper');
        expect(image.getAttribute('srcset')).toBe('../icon@2x.png 2x');
        image.setAttribute('src', '../changed-icon.png');
        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(false);
        expect(link.firstChild).toBe(source); expect(image.parentElement).toBe(owner);
    });

    it('单个直接文本重挂时只遍历一次，并同时取得规范化原文与精确槽身份', () => {
        const {document} = parseHTML('<html><body><p>  Read\n the source.  </p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const walk = vi.spyOn(document, 'createTreeWalker');
        expect(getCurrentTranslationStateSourceSnapshot(owner, state())).toEqual({
            sourceText: 'Read the source.', sourceTextNodes: [owner.firstChild],
        });
        expect(walk).toHaveBeenCalledOnce();
    });

    it.each([
        {html: '<p><em>Read the source.</em></p>', source: 'Read the source.', slots: 1},
        {html: '<p translate="no">Protected source.</p>', source: '', slots: 0},
        {html: '<input type="button" value="Read the source">', source: 'Read the source', slots: 0},
        {html: '<p>Read <a href="https://example.test">https://example.test</a> carefully.<code>protected()</code></p>',
            source: 'Read https://example.test carefully.', slots: 2},
        {html: '<p>Read the source.<span data-fr-translation-owned="true">译文</span></p>', source: 'Read the source.', slots: 1},
    ])('复杂或受保护骨架保留独立的原文与槽提取政策：$html', ({html, source, slots}) => {
        const {document} = parseHTML(`<html><body>${html}</body></html>`);
        const snapshot = getCurrentTranslationStateSourceSnapshot(document.body.firstElementChild as HTMLElement, state());
        expect(snapshot.sourceText).toBe(source);
        expect(snapshot.sourceTextNodes).toHaveLength(slots);
        expect(snapshot.sourceTextNodes.every(node => node.isConnected)).toBe(true);
    });

    it('来源候选移出文档后失效，显式应用外壳例外仍不能穿过新增的局部禁译边界', () => {
        const {document} = parseHTML('<html><body><div translate="no"><p>Readable application source.</p></div></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const candidate = {element: owner, kind: 'content' as const, reason: 'explicit-source',
            allowTopLevelApplicationShell: true};
        expect(isTranslationCandidateCurrent(candidate)).toBe(true);
        owner.setAttribute('translate', 'no');
        expect(isTranslationCandidateCurrent(candidate)).toBe(false);
        owner.removeAttribute('translate');
        expect(isTranslationCandidateCurrent(candidate)).toBe(true);
        owner.remove();
        expect(isTranslationCandidateCurrent(candidate)).toBe(false);
    });

    it('先前自动外壳许可不适用于当前页面时，同值来源也不能提供重绑文本槽', () => {
        const {document} = parseHTML('<html><body><main><p>Readable public source.</p></main></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const source = owner.firstChild as Text;
        const current = state({sourceText: source.data});
        expect(isTranslationStateSourceCurrent(owner, current)).toBe(true);
        expect(getCurrentTranslationStateTextNodes(owner, current)).toEqual([source]);

        // 当前普通页面没有原自动站点的授权；原文相同不能把过期能力降级成手动外壳例外。
        const previousAutomatic = state({sourceText: source.data,
            allowTopLevelApplicationShell: true, applicationShellPolicyId: 'mastodon'});
        expect(isTranslationStateSourceCurrent(owner, previousAutomatic)).toBe(false);
        expect(getCurrentTranslationStateTextNodes(owner, previousAutomatic)).toEqual([]);
        source.data = 'The website replaced this public source.';
        expect(isTranslationStateSourceCurrent(owner, current)).toBe(false);
        expect(getCurrentTranslationStateTextNodes(owner, previousAutomatic)).toEqual([]);
    });

    it('视觉手动分块只要仍是已标记的合成段且挂在文档中就保持有效', () => {
        const {document} = parseHTML('<html><body><div id="host"><span data-fr-translation-manual="true">Chunk text.</span></div></body></html>');
        const chunk = document.querySelector<HTMLElement>('span')!;
        const candidate = {element: chunk, kind: 'content' as const, reason: 'visual-text-chunk', manualChunk: true};
        // 物化后尚未标记为合成段时不能被当作当前手动块。
        expect(isTranslationCandidateCurrent(candidate)).toBe(false);
        chunk.setAttribute('data-fr-translation-segment', 'true');
        expect(isTranslationCandidateCurrent(candidate)).toBe(true);
        const detachedHost = document.createElement('div');
        const detachedChunk = chunk.cloneNode(true) as HTMLElement;
        detachedHost.append(detachedChunk);
        expect(isTranslationCandidateCurrent({...candidate, element: detachedChunk})).toBe(false);
        chunk.remove();
        expect(isTranslationCandidateCurrent(candidate)).toBe(false);
    });

    it('只在连接、内容候选且原文仍匹配时认为来源稳定', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const readSource = vi.fn(() => true);
        expect(hasCurrentTranslationSource(node, state(), readSource)).toBe(true);
        expect(readSource).toHaveBeenCalledWith(node, expect.anything());
        expect(hasCurrentTranslationSource(node, state({syntheticSegment: true}), readSource)).toBe(false);
        expect(hasCurrentTranslationSource(node, state({kind: 'control'}), readSource)).toBe(false);
        expect(hasCurrentTranslationSource(node, state(), () => false)).toBe(false);
        const detached = document.createElement('p');
        expect(hasCurrentTranslationSource(detached, state(), readSource)).toBe(false);
    });

    it('覆盖 loading、双语和仅译文状态的 artifact/slot 分支', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const readSource = () => true;
        const readSlots = vi.fn(() => true);

        expect(canKeepTranslationAttempt(node, state(), readSource, readSlots)).toBe(true);

        const bilingual = document.createElement('span');
        bilingual.className = 'fluent-read-bilingual-content';
        bilingual.setAttribute('data-fr-translation-owned', 'true');
        bilingual.textContent = '译文';
        node.appendChild(bilingual);
        const bilingualState = state({
            phase: 'translated',
            bilingualContent: bilingual,
            bilingualHTML: '译文',
            bilingualOuterHTML: bilingual.outerHTML,
        });
        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(true);
        expect(canKeepTranslationAttempt(node, bilingualState, readSource, readSlots)).toBe(true);
        expect(canKeepTranslationAttempt(node, state({
            phase: 'translated',
            bilingualContent: bilingual,
            bilingualHTML: '译文',
            bilingualOuterHTML: bilingual.outerHTML,
        }), readSource, readSlots, false)).toBe(false);
        expect(canKeepTranslationAttempt(node, state({
            phase: 'translated',
        }), readSource, readSlots)).toBe(false);
        const duplicate = bilingual.cloneNode(true) as HTMLElement;
        node.appendChild(duplicate);
        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(false);
        duplicate.remove();
        bilingual.textContent = '被站点篡改';
        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(false);
        bilingual.textContent = '译文';
        bilingual.classList.add('site-tampered');
        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(false);
        bilingual.classList.remove('site-tampered');

        const sourceNode = document.createTextNode('source');
        const slotHost = document.createElement('span');
        slotHost.appendChild(sourceNode);
        node.appendChild(slotHost);
        expect(canKeepTranslationAttempt(node, state({
            mode: 'single',
            phase: 'translated',
            sourceTextNodes: [sourceNode],
            singleTextSlotHosts: [{host: slotHost, source: sourceNode, sourceValue: 'source'}],
        }), readSource, readSlots)).toBe(true);
        expect(canKeepTranslationAttempt(node, state({
            mode: 'single',
            phase: 'translated',
            sourceTextNodes: [sourceNode],
            singleTextSlotHosts: [],
        }), readSource, readSlots)).toBe(false);
        expect(canKeepTranslationAttempt(node, state({phase: 'error'}), readSource, readSlots)).toBe(false);

        expect(isTranslationArtifactCurrent(node, state({
            kind: 'control',
            phase: 'translated',
            textSlotsApplied: true,
        }))).toBe(true);
        expect(isTranslationArtifactCurrent(node, state({
            mode: 'single',
            kind: 'control',
            phase: 'translated',
            textSlotsApplied: false,
        }))).toBe(false);
        expect(readSlots).toHaveBeenCalled();
    });

    it('完整 outerHTML 快照会拒绝 wrapper 任一展示属性被篡改', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const bilingual = document.createElement('span');
        bilingual.className = 'fluent-read-bilingual-content baseline-style';
        bilingual.setAttribute('data-fr-translation-owned', 'true');
        bilingual.setAttribute('style', 'color: inherit');
        bilingual.setAttribute('lang', 'zh-CN');
        bilingual.setAttribute('dir', 'ltr');
        bilingual.setAttribute('translate', 'no');
        bilingual.textContent = '译文';
        node.appendChild(bilingual);
        const bilingualState = state({
            phase: 'translated',
            bilingualContent: bilingual,
            bilingualHTML: bilingual.innerHTML,
            bilingualOuterHTML: bilingual.outerHTML,
        });

        expect(isTranslationArtifactCurrent(node, bilingualState)).toBe(true);
        const mutations = [
            ['class', 'fluent-read-bilingual-content baseline-style site-tampered'],
            ['style', 'color: red'],
            ['lang', 'fr'],
            ['dir', 'rtl'],
            ['translate', 'yes'],
        ] as const;
        mutations.forEach(([name, tamperedValue]) => {
            const originalValue = bilingual.getAttribute(name)!;
            bilingual.setAttribute(name, tamperedValue);
            expect(isTranslationArtifactCurrent(node, bilingualState), `${name} 篡改`).toBe(false);
            bilingual.setAttribute(name, originalValue);
            expect(isTranslationArtifactCurrent(node, bilingualState), `${name} 恢复`).toBe(true);
        });
    });

    it.each(['attribute', 'class', 'both'])('允许字体脚本在 wrapper 和行内后代添加或移除 %s 标记', (mode) => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.innerHTML = '<strong>粗体译文</strong><a href="/original" class="host-link">链接</a>';
        owner.appendChild(wrapper);
        const snapshot = state({phase: 'translated', bilingualContent: wrapper,
            bilingualHTML: wrapper.innerHTML, bilingualOuterHTML: wrapper.outerHTML,
            bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
        for (const element of [wrapper, ...Array.from(wrapper.querySelectorAll('*'))]) {
            if (mode !== 'class') element.setAttribute('ultimate-bold-correct', '');
            if (mode !== 'attribute') element.classList.add('ultimate-bold-correct');
        }
        wrapper.querySelector('a')!.setAttribute('tabindex', '-1');
        expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(true);
        // 初次渲染快照也可能从原文继承字体标记，脚本移除标记同样不应使译文失效。
        const marked = state({...snapshot, bilingualHTML: wrapper.innerHTML,
            bilingualOuterHTML: wrapper.outerHTML, bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
        for (const element of [wrapper, ...Array.from(wrapper.querySelectorAll('*'))]) {
            element.removeAttribute('ultimate-bold-correct');
            element.classList.remove('ultimate-bold-correct');
            if (!element.getAttribute('class')) element.removeAttribute('class');
        }
        expect(isTranslationArtifactCurrent(owner, marked)).toBe(true);
    });

    it.each([
        ['href', '/other'], ['title', 'Changed meaning'], ['role', 'button'],
        ['aria-hidden', 'true'], ['style', 'display:none'], ['class', 'hidden'],
        ['onclick', 'run()'], ['lang', 'fr'], ['tabindex', '2'], ['tabindex', 'invalid'],
    ])('接受焦点管理前仍拒绝译文链接的 %s=%s 篡改', (attribute, value) => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.innerHTML = '<a href="/original">译文链接</a>';
        owner.appendChild(wrapper);
        const snapshot = state({phase: 'translated', bilingualContent: wrapper,
            bilingualHTML: wrapper.innerHTML, bilingualOuterHTML: wrapper.outerHTML,
            bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
        const link = wrapper.querySelector('a')!;
        link.setAttribute('tabindex', '-1');
        link.setAttribute('ultimate-bold-correct', '');
        link.classList.add('ultimate-bold-correct');
        wrapper.setAttribute('ultimate-bold-correct', '');
        expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(true);
        link.setAttribute(attribute, value);
        expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(false);
    });

    it('复制节点的属性漂移仍算当前工件尝试，译文内容或外层属性被改写才失效', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.innerHTML = '<a href="/original">译文链接</a>';
        owner.appendChild(wrapper);
        const snapshot = state({phase: 'translated', bilingualContent: wrapper,
            bilingualHTML: wrapper.innerHTML, bilingualOuterHTML: wrapper.outerHTML,
            bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
        const readSource = () => true;
        const readSlots = () => true;

        // 悬停预览改写的 title 只改变复制节点的属性，译文与来源都没有变化。
        wrapper.querySelector('a')!.setAttribute('title', 'Host tooltip');
        expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(false);
        expect(isBilingualArtifactKept(owner, snapshot)).toBe(true);
        expect(canKeepTranslationAttempt(owner, snapshot, readSource, readSlots)).toBe(true);

        // 即使 title 同时漂移，也不能掩盖只落在译文上的链接目的地变化。
        wrapper.querySelector('a')!.setAttribute('href', '/unrelated');
        expect(isBilingualArtifactKept(owner, snapshot)).toBe(false);
        expect(canKeepTranslationAttempt(owner, snapshot, readSource, readSlots)).toBe(false);
        wrapper.querySelector('a')!.setAttribute('href', '/original');

        // wrapper 外层属性仍按篡改处理，不能被容忍分支保留。
        wrapper.setAttribute('style', 'display:none');
        expect(isBilingualArtifactKept(owner, snapshot)).toBe(false);
        wrapper.removeAttribute('style');
        wrapper.querySelector('a')!.textContent = 'HOST INJECTED';
        expect(isBilingualArtifactKept(owner, snapshot)).toBe(false);
    });

    it.each(['text', 'extra-node', 'missing-node', 'non-link-tabindex', 'root-tabindex', 'missing-template', 'stale-template']) (
        '焦点属性例外不接受 %s', (mutation) => {
            const {document} = parseHTML('<html><body><p>source</p></body></html>');
            const owner = document.querySelector<HTMLElement>('p')!;
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.innerHTML = '<a href="/original">译文链接</a><span>译文内容</span>';
            owner.appendChild(wrapper);
            const snapshot = state({phase: 'translated', bilingualContent: wrapper,
                bilingualHTML: wrapper.innerHTML, bilingualOuterHTML: wrapper.outerHTML,
                bilingualContentTemplate: wrapper.cloneNode(true) as HTMLElement});
            wrapper.querySelector('a')!.setAttribute('tabindex', '-1');
            wrapper.querySelector('span')!.setAttribute('ultimate-bold-correct', '');
            if (mutation === 'text') wrapper.querySelector('a')!.textContent = 'Changed';
            if (mutation === 'extra-node') wrapper.appendChild(document.createElement('span'));
            if (mutation === 'missing-node') wrapper.querySelector('span')!.remove();
            if (mutation === 'non-link-tabindex') wrapper.querySelector('span')!.setAttribute('tabindex', '-1');
            if (mutation === 'root-tabindex') wrapper.setAttribute('tabindex', '-1');
            if (mutation === 'missing-template') snapshot.bilingualContentTemplate = undefined;
            if (mutation === 'stale-template') snapshot.bilingualContentTemplate!.textContent = 'Changed template';
            expect(isTranslationArtifactCurrent(owner, snapshot)).toBe(false);
        },
    );

    it('双语仅在语义与精确原文结构一致时重绑文本节点', () => {
        const {document} = parseHTML('<html><body><p><span>source</span></p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const originalText = node.querySelector('span')!.firstChild as Text;
        const current = state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
            sourceTextNodes: [originalText],
        });

        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(current.sourceTextNodes).toEqual([originalText]);

        const replacement = document.createTextNode('source');
        originalText.replaceWith(replacement);
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(current.sourceTextNodes).toEqual([replacement]);

        const stateWithoutCapturedNodes = state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
            sourceTextNodes: undefined,
            allowTopLevelApplicationShell: true,
        });
        expect(statefulSourceAndTextSlotsAreCurrent(node, stateWithoutCapturedNodes)).toBe(true);
        expect(stateWithoutCapturedNodes.sourceTextNodes).toEqual([replacement]);

        replacement.replaceWith(document.createElement('strong'));
        node.querySelector('strong')!.textContent = 'source';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);

        node.querySelector('strong')!.textContent = 'changed';
        expect(statefulSourceAndTextSlotsAreCurrent(node, state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
        }))).toBe(false);
    });

    it('结构签名忽略 hover 展示属性，但拒绝译文骨架内容或链接变化', () => {
        const {document} = parseHTML(`
            <html><body><p id="owner"><a id="link" href="/before">source</a><span class="MathJax">render 1</span></p></body></html>
        `);
        const node = document.querySelector<HTMLElement>('#owner')!;
        const link = document.querySelector<HTMLAnchorElement>('#link')!;
        const source = link.firstChild as Text;
        const current = state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
            sourceTextNodes: [source],
            sourceStructureSignature: getTranslationSourceStructureSignature(node),
        });

        node.className = 'hovered';
        node.style.color = 'red';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(current.sourceTextNodes).toEqual([source]);

        node.querySelector<HTMLElement>('.MathJax')!.textContent = 'render 2';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        node.querySelector<HTMLElement>('.MathJax')!.textContent = 'render 1';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);

        const replacementLink = document.createElement('a');
        replacementLink.href = '/after';
        replacementLink.appendChild(source);
        link.replaceWith(replacementLink);
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
    });

    it('有界结构快照溢出时同 owner 保持稳定，但真实 mutation 或 Text 换代立即失效', () => {
        const {document} = parseHTML('<html><body><div id="owner"></div></body></html>');
        const node = document.querySelector<HTMLElement>('#owner')!;
        let deepest = node;
        for (let depth = 0; depth < 140; depth += 1) {
            const child = document.createElement('span');
            deepest.appendChild(child);
            deepest = child;
        }
        const source = document.createTextNode('source');
        deepest.appendChild(source);
        const current = state({
            phase: 'translated',
            sourceText: 'source',
            sourceHTML: node.innerHTML,
            sourceTextNodes: [source],
            sourceStructureSignature: getTranslationSourceStructureSignature(node),
            sourceOverflowGenerationIdentity: getTranslationOverflowGenerationIdentity(node),
        });

        expect(current.sourceStructureSignature).toBe('overflow');
        expect(getTranslationOverflowGenerationIdentity(node)).toBe(current.sourceOverflowGenerationIdentity);
        const cloneSpy = vi.spyOn(node, 'cloneNode');
        for (let check = 0; check < 20; check += 1) {
            expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        }
        expect(cloneSpy).not.toHaveBeenCalled();
        expect(statefulSourceAndTextSlotsAreCurrent(node, {
            ...current,
            sourceTextNodes: undefined,
        })).toBe(true);

        current.sourceStructureDirty = true;
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);

        current.sourceStructureDirty = false;
        const replacementSource = document.createTextNode('source');
        source.replaceWith(replacementSource);
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(current.sourceTextNodes).toEqual([replacementSource]);

        replacementSource.data = 'changed';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
    });

    it('仅译文合成段只忽略自身扩展标记，持续尊重父级和内部原文保护区', () => {
        const {document} = parseHTML('<html><body><div id="app"><span data-fr-translation-segment="true"><span data-fr-translation-owned="true" translate="no">source</span></span></div></body></html>');
        const parent = document.querySelector<HTMLElement>('#app')!;
        const node = parent.firstElementChild as HTMLElement;
        const host = node.firstElementChild as HTMLElement;
        const source = host.firstChild as Text;
        const current = state({mode: 'single', phase: 'translated', syntheticSegment: true,
            sourceTextNodes: [source], singleTextSlotHosts: [{host, source, sourceValue: 'source'}]});

        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        parent.className = 'notranslate';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        current.allowTopLevelApplicationShell = true;
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        node.className = 'notranslate';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        node.className = '';
        node.hidden = true;
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        node.hidden = false;
        parent.className = '';
        node.remove();
        // 此纯判定只比较来源；是否仍连接由调用处的 generation/artifact 检查负责。
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
    });

    it('仅译文既有槽完整但新正文变为可译时，拒绝沿用遗漏新增内容的来源快照', () => {
        const {document} = parseHTML('<html><body><p><span data-fr-translation-owned="true" translate="no">source</span><em class="notranslate">new source</em></p></body></html>');
        const node = document.querySelector<HTMLElement>('p')!;
        const host = node.firstElementChild as HTMLElement;
        const source = host.firstChild as Text;
        const addition = node.querySelector<HTMLElement>('em')!;
        const current = state({mode: 'single', phase: 'translated', sourceTextNodes: [source],
            singleTextSlotHosts: [{host, source, sourceValue: 'source'}]});
        const cloneSpy = vi.spyOn(node, 'cloneNode');

        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        addition.className = '';
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(false);
        addition.hidden = true;
        expect(statefulSourceAndTextSlotsAreCurrent(node, current)).toBe(true);
        expect(cloneSpy).not.toHaveBeenCalled();
    });

    it('校验仅译文与控件文本槽的节点身份和译文值', () => {
        const {document} = parseHTML('<html><body><p><span>source</span></p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const host = node.querySelector('span') as HTMLElement;
        const source = host.firstChild as Text;
        const slotState = state({
            mode: 'single',
            phase: 'translated',
            sourceTextNodes: [source],
            singleTextSlotHosts: [{host, source, sourceValue: 'source'}],
        });

        expect(statefulSourceAndTextSlotsAreCurrent(node, slotState)).toBe(true);
        expect(statefulSourceAndTextSlotsAreCurrent(node, {
            ...slotState,
            sourceTextNodes: undefined,
        })).toBe(false);

        const translatedValues = new WeakMap<Text, string>([[source, 'source']]);
        const controlState = state({
            mode: 'single',
            kind: 'control',
            phase: 'translated',
            sourceTextNodes: [source],
            translatedTextNodes: [source],
            textSlotsApplied: true,
            translatedTextValues: translatedValues,
        });
        expect(statefulSourceAndTextSlotsAreCurrent(node, controlState)).toBe(true);
        translatedValues.set(source, 'different');
        expect(statefulSourceAndTextSlotsAreCurrent(node, controlState)).toBe(false);
        expect(statefulSourceAndTextSlotsAreCurrent(node, {
            ...controlState,
            translatedTextValues: undefined,
        })).toBe(false);

        const button = document.createElement('button');
        button.innerHTML = '<span aria-hidden="true">★</span><span>保存更改</span>';
        document.body.appendChild(button);
        const buttonText = button.lastElementChild!.firstChild as Text;
        expect(statefulSourceAndTextSlotsAreCurrent(button, state({
            mode: 'single',
            kind: 'control',
            phase: 'translated',
            sourceTextNodes: [buttonText],
            translatedTextNodes: [buttonText],
            textSlotsApplied: true,
            translatedTextValues: new WeakMap([[buttonText, '保存更改']]),
        }))).toBe(true);

        const singleState = state({
            mode: 'single',
            phase: 'translated',
            sourceTextNodes: [source],
            translatedTextNodes: [source],
            textSlotsApplied: true,
            translatedTextValues: new WeakMap([[source, 'source']]),
        });
        expect(statefulSourceAndTextSlotsAreCurrent(node, singleState)).toBe(true);
        expect(statefulSourceAndTextSlotsAreCurrent(node, state({
            mode: 'single',
            sourceText: 'source',
            sourceTextNodes: [source],
        }))).toBe(true);
        expect(statefulSourceAndTextSlotsAreCurrent(node, state({
            mode: 'single',
            sourceTextNodes: undefined,
        }))).toBe(false);
    });

    it('只接受当前控件 generation 的 spinner 事务与最终 Text 写入', () => {
        const {document} = parseHTML('<html><body><button>Save changes</button><aside></aside></body></html>');
        const button = document.querySelector('button') as HTMLElement;
        const other = document.querySelector('aside') as HTMLElement;
        const source = button.firstChild as Text;
        const spinner = document.createElement('span');
        spinner.setAttribute('data-fr-translation-owned', 'true');
        button.appendChild(spinner);
        const loading = state({
            kind: 'control', sourceText: 'Save changes', sourceTextNodes: [source], spinner,
        });

        expect(isOwnStateArtifactMutation(childListRecord(button, [spinner]), button, loading)).toBe(true);
        expect(isOwnStateArtifactMutation(childListRecord(button, [spinner], [source]), button, loading)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(other, [spinner]), button, loading)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(button, [other]), button, loading)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(button, [spinner]), button,
            {...loading, kind: 'content'})).toBe(true);

        spinner.remove();
        source.data = '保存更改';
        const translated = state({
            kind: 'control', phase: 'translated', settledSpinner: spinner,
            sourceTextNodes: [source], translatedTextNodes: [source], textSlotsApplied: true,
            translatedTextValues: new WeakMap([[source, '保存更改']]),
        });
        const characterMutation = {
            type: 'characterData', target: source,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord;
        expect(isOwnStateArtifactMutation(characterMutation, button, translated)).toBe(true);
        translated.translatedTextValues!.set(source, '被篡改');
        expect(isOwnStateArtifactMutation(characterMutation, button, translated)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(button, [], [spinner]), button, translated)).toBe(true);
        expect(isOwnStateArtifactMutation(childListRecord(button), button, translated)).toBe(false);
        expect(isOwnStateArtifactMutation(childListRecord(other, [], [spinner]), button, translated)).toBe(false);
        expect(isOwnStateArtifactMutation({...characterMutation, type: 'attributes'} as MutationRecord,
            button, translated)).toBe(false);
        expect(isOwnStateArtifactMutation(characterMutation, button, {...translated, phase: 'error'})).toBe(false);

        expect(isOwnStateArtifactMutation(
            childListRecord(button, [], [spinner]),
            button,
            {...translated, kind: 'content'},
        )).toBe(true);
    });

    it('按钮型 input 的属性译文按已记录值复验，宿主改回原标签即判为失效', () => {
        const {document} = parseHTML(
            '<html><body><input id="save" type="button" value="保存草稿"></body></html>');
        const node = document.querySelector<HTMLElement>('#save')!;
        const translated = state({
            kind: 'control', phase: 'translated', mode: 'bilingual', sourceText: 'Save draft',
            sourceHTML: node.innerHTML, sourceTextNodes: [], translatedTextNodes: [],
            textSlotsApplied: true, translatedTextValues: new WeakMap(),
            sourceStructureSignature: getTranslationSourceStructureSignature(node),
            controlValue: {attribute: 'value', original: 'Save draft', translated: '保存草稿'},
        });
        const valueMutation = {
            type: 'attributes', attributeName: 'value', target: node,
            addedNodes: [] as unknown as NodeList,
            removedNodes: [] as unknown as NodeList,
        } as unknown as MutationRecord;

        expect(statefulSourceAndTextSlotsAreCurrent(node, translated)).toBe(true);
        expect(isTranslationArtifactCurrent(node, translated)).toBe(true);
        expect(isOwnStateArtifactMutation(valueMutation, node, translated)).toBe(true);
        expect(isOwnStateArtifactMutation(
            {...valueMutation, attributeName: 'class'} as MutationRecord, node, translated)).toBe(false);

        node.setAttribute('value', 'Save draft');
        expect(statefulSourceAndTextSlotsAreCurrent(node, translated)).toBe(false);
        expect(isOwnStateArtifactMutation(valueMutation, node, translated)).toBe(false);
    });

    it('只把当前 single-slot host 和完整双语 wrapper 识别为自身新增工件', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const source = owner.firstChild as Text;
        const slotHost = document.createElement('span');
        slotHost.appendChild(source);
        owner.appendChild(slotHost);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文';
        owner.appendChild(wrapper);
        const current = state({
            phase: 'translated',
            sourceTextNodes: [source],
            singleTextSlotHosts: [{host: slotHost, source, sourceValue: 'source'}],
            bilingualContent: wrapper,
            bilingualOuterHTML: wrapper.outerHTML,
        });

        expect(isOwnCurrentArtifactAddition(childListRecord(owner, [slotHost]), current)).toBe(true);
        expect(isOwnCurrentArtifactAddition(childListRecord(owner, [wrapper]), current)).toBe(true);
        wrapper.setAttribute('lang', 'ja');
        expect(isOwnCurrentArtifactAddition(childListRecord(owner, [wrapper]), current)).toBe(false);
        expect(isOwnCurrentArtifactAddition(
            childListRecord(owner, [document.createElement('aside')]),
            current,
        )).toBe(false);
        expect(isOwnCurrentArtifactAddition(childListRecord(owner), current)).toBe(false);
    });

    it('识别当前译文工件 mutation，并严格识别自身 single-slot 搬移', () => {
        const {document} = parseHTML('<html><body><p><span>source</span></p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        const host = node.querySelector('span') as HTMLElement;
        const source = host.firstChild as Text;
        const emptyState = state();
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(node), emptyState)).toBe(false);

        const artifact = document.createElement('span');
        artifact.setAttribute('data-fr-translation-owned', 'true');
        const child = document.createElement('em');
        artifact.appendChild(child);
        node.appendChild(artifact);
        const artifactState = state({spinner: artifact});
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(artifact), artifactState)).toBe(true);
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(child), artifactState)).toBe(true);
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(node, [artifact]), artifactState)).toBe(true);
        expect(mutationTouchesCurrentTranslationArtifact(childListRecord(node, [node]), artifactState)).toBe(true);
        expect(mutationTouchesCurrentTranslationArtifact(
            childListRecord(node, [document.createTextNode('other')]),
            artifactState,
        )).toBe(false);

        const slotState = state({
            mode: 'single',
            sourceTextNodes: [source],
            singleTextSlotHosts: [{host, source, sourceValue: 'source'}],
        });
        expect(isOwnSingleTextSlotMove(
            childListRecord(host, [source], [source]),
            node,
            slotState,
        )).toBe(true);
        expect(isOwnSingleTextSlotMove(childListRecord(host), node, slotState)).toBe(false);
        expect(isOwnSingleTextSlotMove(
            {...childListRecord(host, [source]), type: 'attributes'} as MutationRecord,
            node,
            slotState,
        )).toBe(false);
        expect(isOwnSingleTextSlotMove(childListRecord(host, [source]), node, state())).toBe(false);
        expect(isOwnSingleTextSlotMove(
            childListRecord(source, [source]),
            node,
            slotState,
        )).toBe(false);
        expect(isOwnSingleTextSlotMove(
            childListRecord(node, [source]),
            node,
            slotState,
        )).toBe(false);
        expect(isOwnSingleTextSlotMove(
            childListRecord(host, [document.createTextNode('other')]),
            node,
            slotState,
        )).toBe(false);
    });

    it('仅把标记工件及其后代当作 FluentRead 产物', () => {
        const {document} = parseHTML(`
            <html><body>
                <span id="segment" data-fr-translation-segment="true"><em id="child">translated</em></span>
                <span id="owned" data-fr-translation-owned="true">owned</span>
                <span id="plain">plain</span>
            </body></html>
        `);
        const segment = document.querySelector('#segment')!;
        const child = document.querySelector('#child')!;
        const ownedText = document.querySelector('#owned')!.firstChild!;
        const plain = document.querySelector('#plain')!;

        expect(isTranslationArtifact(segment)).toBe(true);
        expect(isTranslationArtifact(child)).toBe(true);
        expect(isTranslationArtifact(ownedText)).toBe(true);
        expect(isTranslationArtifact(plain)).toBe(false);
        expect(isTranslationArtifact(document.createTextNode('detached'))).toBe(false);
    });

    it('复用同一 Text、重绑定等价重建 Text，并拒绝数量或来源不一致', () => {
        const {document} = parseHTML('<html><body></body></html>');
        const original = document.createTextNode('source');
        const replacement = document.createTextNode('source');
        const result = {
            sources: ['source'],
            translations: ['译文'],
            nodes: [original],
            slots: [{node: original, text: '译文'}],
        };
        const currentPart = {node: replacement, prefix: '(', source: 'source', suffix: ')'};

        expect(reboundLiveTextResult([original], result, [{...currentPart, node: original}])).toEqual({
            nodes: [original],
            slots: [{node: original, text: '(译文)'}],
        });
        expect(reboundLiveTextResult([replacement], result, [currentPart])).toEqual({
            nodes: [replacement],
            slots: [{node: replacement, text: '(译文)'}],
        });
        expect(reboundLiveTextResult([replacement], {...result, translations: []}, [currentPart])).toEqual({
            nodes: [replacement],
            slots: [{node: replacement, text: '(source)'}],
        });
        expect(reboundLiveTextResult([], result, [])).toBeNull();
        expect(reboundLiveTextResult([replacement], result, [{...currentPart, source: 'other'}])).toBeNull();
    });

    it('相同 Text 身份但分槽原文变化时拒绝迟到结果，即使整段拼接原文相同', () => {
        const {document} = parseHTML('<html><body><p><b>Hello world</b> again</p></body></html>');
        const first = document.querySelector('b')!.firstChild as Text;
        const second = document.querySelector('p')!.lastChild as Text;
        const result = {
            sources: ['Hello world', 'again'],
            translations: ['你好世界', '再次'],
            nodes: [first, second],
            slots: [{node: first, text: '你好世界'}, {node: second, text: ' 再次'}],
        };
        first.data = 'Hello';
        second.data = ' world again';
        const parts = [
            {node: first, prefix: '', source: 'Hello', suffix: ''},
            {node: second, prefix: ' ', source: 'world again', suffix: ''},
        ];

        expect(document.querySelector('p')!.textContent).toBe('Hello world again');
        expect(reboundLiveTextResult([first, second], result, parts)).toBeNull();
        expect(first.data).toBe('Hello');
        expect(second.data).toBe(' world again');
    });

    it('相同 Text 身份的空白更新使用最新前后缀，不把旧展示快照写回宿主', () => {
        const {document} = parseHTML('<html><body><p>source</p></body></html>');
        const source = document.querySelector('p')!.firstChild as Text;
        const result = {
            sources: ['source'], translations: ['译文'], nodes: [source],
            slots: [{node: source, text: '译文'}],
        };
        source.data = '\n source  ';
        const parts = [{node: source, prefix: '\n ', source: 'source', suffix: '  '}];

        expect(reboundLiveTextResult([source], result, parts)).toEqual({
            nodes: [source], slots: [{node: source, text: '\n 译文  '}],
        });
        expect(reboundLiveTextResult([], result, parts)).toBeNull();
        expect(reboundLiveTextResult([document.createTextNode('source')], result, parts)).toBeNull();
        expect(reboundLiveTextResult([source], result, [])).toBeNull();
    });
});

// Direct epoch tests use registered production state, actual core predicates
// and live DOM. Only call-through operation spies are added; no checker stub.
const epochUnitOwners = new Set<HTMLElement>();
function beginEpochUnitState(owner: HTMLElement, scope: 'content' | 'all' = 'content', allowShell = false, kind: 'content' | 'control' = 'content') {
    const sourceNodes = collectLiveTranslationTextSlots(owner, getCurrentTranslationCore(scope).shouldStayOriginal,
        undefined, allowShell ? {allowTopLevelApplicationShell: true, protectedElement: owner} : undefined)
        .map(slot => slot.node);
    const attempt = beginTranslation(owner, 'bilingual', kind, false,
        owner.textContent ?? '', sourceNodes, allowShell, undefined, scope);
    expect(attempt).not.toBeNull();
    epochUnitOwners.add(owner);
    expect(getTranslationState(owner)).toBe(attempt!.state);
    return attempt!;
}
function spyEpochUnitSourceText(text: Text) {
    let prototype = Object.getPrototypeOf(text);
    while (!Object.getOwnPropertyDescriptor(prototype, 'data')) prototype = Object.getPrototypeOf(prototype);
    return vi.spyOn(prototype as Text, 'data', 'get');
}

describe('observer epoch 的真实 owner/state 与独立只读边界', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        epochUnitOwners.forEach(owner => restoreTranslation(owner));
        epochUnitOwners.clear();
    });

    it('旧 state 传给不同 owner 时不能借用安全结果，回到原 owner 仍按其真实来源判断', () => {
        const {document} = parseHTML('<html><body><main><p id="first">First readable source.</p><p id="second">Second readable source.</p></main></body></html>');
        const first = document.querySelector<HTMLElement>('#first')!;
        const second = document.querySelector<HTMLElement>('#second')!;
        const {state: current} = beginEpochUnitState(first);
        second.setAttribute('translate', 'no');
        const reads = createTranslationMutationStabilityChecks();
        expect(reads.scopeIsCurrent(first, current)).toBe(true);
        expect(reads.sourceIsCurrent(first, current)).toBe(true);
        // A stale caller can hold the previous owner/state pair during a host
        // remount. Matching state alone must never authorize a different DOM.
        expect(reads.scopeIsCurrent(second, current)).toBe(false);
        expect(reads.sourceIsCurrent(second, current)).toBe(false);
        expect(reads.sourceIsCurrent(first, current)).toBe(true);
        expect(reads.scopeIsCurrent(first, current)).toBe(true);
        expect(getTranslationState(first)).toBe(current);
        expect(getTranslationState(second)).toBeUndefined();
    });

    it('同 owner 的真实新 state/generation 不继承旧来源的 false，旧 state 也不借用新结果', () => {
        const {document} = parseHTML('<html><body><p>Initial readable source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const previous = beginEpochUnitState(owner);
        expect(markTranslationComplete(owner, previous.state, previous.generation)).toBe(true);
        const oldText = owner.firstChild as Text;
        const replacement = document.createTextNode('Replacement source with different live words.');
        owner.replaceChildren(replacement);
        const reads = createTranslationMutationStabilityChecks();
        expect(reads.sourceIsCurrent(owner, previous.state)).toBe(false);
        expect(reads.scopeIsCurrent(owner, previous.state)).toBe(true);
        const next = beginEpochUnitState(owner);
        expect(next.state).not.toBe(previous.state);
        expect(next.generation).toBeGreaterThan(previous.generation);
        expect(previous.state.controller.signal.aborted).toBe(true);
        expect(next.state.sourceTextNodes).toEqual([replacement]);
        expect(oldText.isConnected).toBe(false);
        const inspect = vi.spyOn(getCurrentTranslationCore('content'), 'inspect');
        expect(reads.sourceIsCurrent(owner, next.state)).toBe(true);
        expect(reads.scopeIsCurrent(owner, next.state)).toBe(true);
        expect(inspect).toHaveBeenCalledOnce();
        expect(reads.sourceIsCurrent(owner, previous.state)).toBe(false);
        expect(reads.scopeIsCurrent(owner, next.state)).toBe(true);
        expect(inspect).toHaveBeenCalledOnce();
    });

    it('两个 false 都会缓存：真实 role 边界和已编辑来源不为重复读取重跑 inspector/Text 读取', () => {
        const {document} = parseHTML('<html><body><p>Original readable source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const {state: current} = beginEpochUnitState(owner);
        const text = owner.firstChild as Text;
        text.data = 'Host edited these words before the observer checkpoint.';
        owner.setAttribute('role', 'button');
        const reads = createTranslationMutationStabilityChecks();
        const inspect = vi.spyOn(getCurrentTranslationCore('content'), 'inspect');
        const textReads = spyEpochUnitSourceText(text);
        expect(reads.scopeIsCurrent(owner, current)).toBe(false);
        expect(reads.sourceIsCurrent(owner, current)).toBe(false);
        expect(inspect).toHaveBeenCalledOnce();
        const initialTextReads = textReads.mock.contexts.filter(context => context === text).length;
        expect(initialTextReads).toBeGreaterThan(0);
        for (let index = 0; index < 4; index += 1) {
            expect(reads.scopeIsCurrent(owner, current)).toBe(false);
            expect(reads.sourceIsCurrent(owner, current)).toBe(false);
        }
        expect(inspect).toHaveBeenCalledOnce();
        expect(textReads.mock.contexts.filter(context => context === text)).toHaveLength(initialTextReads);
    });

    it.each([
        {change: 'source', first: 'scope', scopeCurrent: true, sourceCurrent: false},
        {change: 'source', first: 'source', scopeCurrent: true, sourceCurrent: false},
        {change: 'role', first: 'scope', scopeCurrent: false, sourceCurrent: true},
        {change: 'role', first: 'source', scopeCurrent: false, sourceCurrent: true},
    ] as const)('$change 在 $first 先读时仍保留相反的 scope/source 结果', ({change, first, scopeCurrent, sourceCurrent}) => {
        const {document} = parseHTML('<html><body><p>Readable original words.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const {state: current} = beginEpochUnitState(owner);
        if (change === 'source') (owner.firstChild as Text).data = 'Edited source still qualifies as readable prose.';
        else owner.setAttribute('role', 'button');
        const reads = createTranslationMutationStabilityChecks();
        if (first === 'scope') {
            expect(reads.scopeIsCurrent(owner, current)).toBe(scopeCurrent);
            expect(reads.sourceIsCurrent(owner, current)).toBe(sourceCurrent);
        } else {
            expect(reads.sourceIsCurrent(owner, current)).toBe(sourceCurrent);
            expect(reads.scopeIsCurrent(owner, current)).toBe(scopeCurrent);
        }
        expect(reads.scopeIsCurrent(owner, current)).toBe(scopeCurrent);
        expect(reads.sourceIsCurrent(owner, current)).toBe(sourceCurrent);
        expect(owner.textContent).toBe(change === 'source'
            ? 'Edited source still qualifies as readable prose.' : 'Readable original words.');
    });

    it('写前 invalidate 同时释放两种读取，新的独立 checkpoint 也必须读取当前 DOM', () => {
        const {document} = parseHTML('<html><body><p>Readable original source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const {state: current} = beginEpochUnitState(owner);
        const text = owner.firstChild as Text;
        const reads = createTranslationMutationStabilityChecks();
        const inspect = vi.spyOn(getCurrentTranslationCore('content'), 'inspect');
        const textReads = spyEpochUnitSourceText(text);
        expect(reads.scopeIsCurrent(owner, current)).toBe(true);
        expect(reads.sourceIsCurrent(owner, current)).toBe(true);
        const priorTextReads = textReads.mock.contexts.filter(context => context === text).length;
        reads.invalidate();
        owner.setAttribute('role', 'button');
        text.data = 'This new source invalidates the captured original words.';
        expect(reads.scopeIsCurrent(owner, current)).toBe(false);
        expect(reads.sourceIsCurrent(owner, current)).toBe(false);
        expect(inspect).toHaveBeenCalledTimes(2);
        expect(textReads.mock.contexts.filter(context => context === text).length).toBeGreaterThan(priorTextReads);
        reads.invalidate();
        owner.removeAttribute('role');
        text.data = 'Readable original source.';
        const nextCheckpoint = createTranslationMutationStabilityChecks();
        expect(nextCheckpoint.scopeIsCurrent(owner, current)).toBe(true);
        expect(nextCheckpoint.sourceIsCurrent(owner, current)).toBe(true);
        expect(inspect).toHaveBeenCalledTimes(3);
        // The explicitly invalidated previous object must also re-read;
        // constructing another epoch cannot refill or share its reader cache.
        expect(reads.scopeIsCurrent(owner, current)).toBe(true);
        expect(reads.sourceIsCurrent(owner, current)).toBe(true);
        expect(inspect).toHaveBeenCalledTimes(4);
    });

    it('stateless state 谓词保留正文/全部 scope 的实际边界，脱离文档不进入 inspector', () => {
        const {document} = parseHTML('<html><body><main><p>Readable sidebar source.</p></main></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const previous = beginEpochUnitState(owner, 'content');
        expect(markTranslationComplete(owner, previous.state, previous.generation)).toBe(true);
        // A host moves unchanged content into its navigation shell.
        const aside = document.createElement('aside');
        document.body.appendChild(aside); aside.appendChild(owner);
        // All-scope navigation uses the real control kind, rather than carrying
        // a prior content kind into a semantically different page region.
        expect(getCurrentTranslationCore('all').inspect(owner).candidate?.kind).toBe('control');
        const next = beginEpochUnitState(owner, 'all', false, 'control');
        expect(isTranslationStateCandidateCurrent(owner, previous.state)).toBe(false);
        expect(isTranslationStateCandidateCurrent(owner, next.state)).toBe(true);
        const inspect = vi.spyOn(getCurrentTranslationCore('all'), 'inspect');
        owner.remove();
        expect(isTranslationStateCandidateCurrent(owner, next.state)).toBe(false);
        expect(inspect).not.toHaveBeenCalled();
    });

    it.each([false, true])('stateless allowShell=%s 仅作用于外层壳，不能绕过 owner 的 translate/hidden 和 kind 变化', allowShell => {
        const {document} = parseHTML(`<html><body><div id="shell"${allowShell ? ' translate="no"' : ''}><p>Readable application source.</p></div></body></html>`);
        const owner = document.querySelector<HTMLElement>('p')!;
        const shell = document.querySelector<HTMLElement>('#shell')!;
        const {state: current} = beginEpochUnitState(owner, 'content', allowShell);
        expect(current.allowTopLevelApplicationShell).toBe(allowShell ? true : undefined);
        expect(isTranslationStateCandidateCurrent(owner, current)).toBe(true);
        if (allowShell) {
            // Line 136's true branch must preserve the actual shell-bypass
            // identity through the cached scope reader, not merely the source
            // extraction options. Observe the real resolve result unchanged.
            const resolve = vi.spyOn(getCurrentTranslationCore('content'), 'resolve');
            const reads = createTranslationMutationStabilityChecks();
            expect(reads.scopeIsCurrent(owner, current)).toBe(true);
            expect(resolve).toHaveBeenCalledOnce();
            expect(resolve).toHaveBeenCalledWith(owner);
            expect(resolve.mock.results[0]!.value).toMatchObject({
                element: owner, kind: 'content', allowTopLevelApplicationShell: true,
            });
            expect(reads.scopeIsCurrent(owner, current)).toBe(true);
            expect(resolve).toHaveBeenCalledOnce();
            resolve.mockRestore();
            // Removal of the actual bypass changes candidate metadata; a stale
            // allow-shell identity must not silently become an ordinary one.
            shell.removeAttribute('translate');
            expect(isTranslationStateCandidateCurrent(owner, current)).toBe(false);
            shell.setAttribute('translate', 'no');
        } else {
            shell.setAttribute('translate', 'no');
            expect(isTranslationStateCandidateCurrent(owner, current)).toBe(false);
            shell.removeAttribute('translate');
        }
        expect(isTranslationStateCandidateCurrent(owner, current)).toBe(true);
        for (const [attribute, value] of [['translate', 'no'], ['hidden', ''], ['role', 'button']] as const) {
            owner.setAttribute(attribute, value);
            expect(isTranslationStateCandidateCurrent(owner, current)).toBe(false);
            owner.removeAttribute(attribute);
            expect(isTranslationStateCandidateCurrent(owner, current)).toBe(true);
        }
        owner.remove();
        expect(isTranslationStateCandidateCurrent(owner, current)).toBe(false);
    });

    it('stateless inline candidate 首 Text 仍相同时也拒绝节点重排/扩张及来源移出 owner', () => {
        const {document} = parseHTML('<html><body><main><div id="mixed">Intro <strong>readable words</strong><p>Child paragraph.</p>Tail words.</div></main></body></html>');
        const owner = document.querySelector<HTMLElement>('#mixed')!;
        const first = owner.firstChild!;
        const strong = owner.querySelector('strong')!;
        const core = getCurrentTranslationCore('content');
        const original = core.resolve(first)!;
        expect(original.element).toBe(owner);
        expect(original.nodes).toContain(first);
        expect(isTranslationCandidateCurrent(original)).toBe(true);
        owner.insertBefore(strong, first);
        expect(first.parentNode).toBe(owner);
        expect(isTranslationCandidateCurrent(original)).toBe(false);
        const reordered = core.resolve(first)!;
        expect(isTranslationCandidateCurrent(reordered)).toBe(true);
        const added = document.createTextNode(' Newly appended inline words.');
        owner.insertBefore(added, owner.querySelector('p'));
        expect(isTranslationCandidateCurrent(reordered)).toBe(false);
        const expanded = core.resolve(first)!;
        expect(isTranslationCandidateCurrent(expanded)).toBe(true);
        strong.remove();
        expect(isTranslationCandidateCurrent(expanded)).toBe(false);
    });
});


describe('仅译文合成段原文搬移回归', () => {
    it('数字旁的仅译文槽保持稳定，真实来源变化仍会使其失效', () => {
        const {document} = parseHTML('<html><body><div class="count"><span>0</span> Comments</div></body></html>');
        const owner = document.querySelector<HTMLElement>('.count')!;
        const count = owner.firstElementChild!.firstChild as Text;
        const source = owner.lastChild as Text;
        const host = document.createElement('span');
        host.className = 'fluent-read-single-slot';
        host.setAttribute('data-fr-translation-owned', 'true');
        host.setAttribute('translate', 'no');
        owner.insertBefore(host, source);
        host.appendChild(source);
        const current = state({mode: 'single', phase: 'translated', sourceText: 'Comments',
            sourceTextNodes: [source], singleTextSlotHosts: [{host, source, sourceValue: ' Comments'}]});

        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(true);
        expect(isOwnSingleTextSlotMove(childListRecord(owner, [], [source]), owner, current)).toBe(true);
        count.data = '1';
        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(true);
        count.data = 'New';
        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(false);
        count.data = '1';
        const added = document.createTextNode(' added by the page');
        host.appendChild(added);
        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(false);
        added.remove();
        source.data = ' Replies';
        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(false);
    });

    it('Latest 原父移除与槽内加入均属于自身操作，真实内容变动仍需重译', () => {
        const {document} = parseHTML('<html><body><div><span data-fr-translation-segment="true"><a href="/releases/latest"><span class="Label">Latest</span></a></span></div></body></html>');
        const owner = document.querySelector<HTMLElement>('[data-fr-translation-segment]')!;
        const label = document.querySelector<HTMLElement>('.Label')!;
        const source = label.firstChild as Text;
        const host = document.createElement('span');
        host.className = 'fluent-read-single-slot';
        host.setAttribute('data-fr-translation-owned', 'true');
        host.setAttribute('translate', 'no');
        label.insertBefore(host, source);
        host.appendChild(source);
        const current = state({
            mode: 'single', phase: 'translated', sourceText: 'Latest', syntheticSegment: true,
            syntheticHost: owner.parentElement!, sourceTextNodes: [source],
            singleTextSlotHosts: [{host, source, sourceValue: 'Latest'}],
        });
        const removal = childListRecord(label, [], [source]);
        expect(statefulSourceAndTextSlotsAreCurrent(owner, current)).toBe(true);
        expect(isTranslationArtifact(label)).toBe(true);
        expect(canKeepTranslationAttempt(owner, current, () => true, () => true)).toBe(false);
        expect(isOwnSingleTextSlotMove(removal, owner, current)).toBe(true);
        expect(isOwnSingleTextSlotMove(childListRecord(host, [source]), owner, current)).toBe(true);
        const replacement = document.createTextNode('Latest');
        expect(isOwnSingleTextSlotMove(childListRecord(label, [], [replacement]), owner, current)).toBe(false);
        expect(isOwnSingleTextSlotMove(childListRecord(label, [replacement], [source]), owner, current)).toBe(false);
        expect(isOwnSingleTextSlotMove(childListRecord(label), owner, current)).toBe(false);
        expect(isOwnSingleTextSlotMove(childListRecord(label, [], [source, replacement]), owner, current)).toBe(false);
        source.data = 'Changed';
        expect(isOwnSingleTextSlotMove(removal, owner, current)).toBe(false);
        source.data = 'Latest';
        expect(isOwnSingleTextSlotMove(removal, owner, current)).toBe(true);
        host.remove();
        expect(isOwnSingleTextSlotMove(removal, owner, current)).toBe(false);
    });
});

function remountState(overrides: Partial<TranslationState> = {}): TranslationState {
    return {
        mode: 'bilingual', kind: 'content', phase: 'translated', generation: 1,
        sourceText: 'source', sourceHTML: 'source', syntheticSegment: false,
        originalStyleAttribute: null, originalClassAttribute: null,
        originalTextValues: [], controller: new AbortController(), scope: 'all', ...overrides,
    };
}

function installStyle(window: Window, read: (element: Element) => object): () => void {
    const previous = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
    Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: read});
    return () => {
        if (previous) Object.defineProperty(window, 'getComputedStyle', previous);
        else Reflect.deleteProperty(window, 'getComputedStyle');
    };
}

describe('重挂来源快照的祖先预算和隔离', () => {
    it('500 个普通 owner 共享祖先资格，每一段仍返回精确原文和当前 Text 身份', () => {
        const {document, window} = parseHTML('<html><body><main>' +
            Array.from({length: 500}, (_, index) => '<p>Readable remount paragraph ' + index + '.</p>').join('') +
            '</main></body></html>');
        const main = document.querySelector('main')!;
        const reads = new Map<Element, number>();
        const restore = installStyle(window, element => {
            reads.set(element, (reads.get(element) ?? 0) + 1);
            return {display: 'block', visibility: 'visible', position: 'static', fontFamily: 'serif'};
        });
        try {
            const readSource = createCurrentTranslationStateSourceSnapshotBatch();
            [...document.querySelectorAll<HTMLElement>('p')].forEach((owner, index) => {
                expect(readSource(owner, remountState())).toEqual({
                    sourceText: 'Readable remount paragraph ' + index + '.',
                    sourceTextNodes: [owner.firstChild],
                });
            });
            expect(reads.get(main)).toBe(1);
            expect(reads.get(document.body)).toBe(1);
            expect(reads.get(document.documentElement)).toBe(1);
            // 原文 owner 的实时资格不能省掉；预算是 500 个 owner 加 3 个共享祖先。
            expect([...reads.values()].reduce((sum, count) => sum + count, 0)).toBe(503);
        } finally { restore(); }
    });

    it('一次批次不漏掉兄弟的局部保护，DOM 写入后新批次重新判定共享祖先', () => {
        const {document, window} = parseHTML('<html><body><main>' +
            '<p>First readable source.</p><p translate="no">Protected second source.</p>' +
            '</main></body></html>');
        const main = document.querySelector('main')!;
        const owners = [...document.querySelectorAll<HTMLElement>('p')];
        const restore = installStyle(window, () => ({
            display: 'block', visibility: 'visible', position: 'static', fontFamily: 'serif',
        }));
        try {
            const readSource = createCurrentTranslationStateSourceSnapshotBatch();
            expect(readSource(owners[0]!, remountState()).sourceTextNodes).toEqual([owners[0]!.firstChild]);
            expect(readSource(owners[1]!, remountState())).toEqual({sourceText: '', sourceTextNodes: []});
            main.setAttribute('translate', 'no');
            const readAfterWrite = createCurrentTranslationStateSourceSnapshotBatch();
            expect(readAfterWrite(owners[0]!, remountState())).toEqual({sourceText: '', sourceTextNodes: []});
        } finally { restore(); }
    });

    it('同批显式外壳和 synthetic 仍按各自边界计算，不能泄漏放行结果', () => {
        const {document, window} = parseHTML('<html><body><div translate="no" id="shell">' +
            '<p>Readable application source.</p></div>' +
            '<span data-fr-translation-segment="true" id="segment">Readable synthetic source.</span>' +
            '</body></html>');
        const shell = document.querySelector<HTMLElement>('#shell')!;
        const inside = shell.querySelector<HTMLElement>('p')!;
        const segment = document.querySelector<HTMLElement>('#segment')!;
        const restore = installStyle(window, () => ({
            display: 'block', visibility: 'visible', position: 'static', fontFamily: 'serif',
        }));
        try {
            const readSource = createCurrentTranslationStateSourceSnapshotBatch();
            const explicit = remountState({allowTopLevelApplicationShell: true, scope: 'content'});
            expect(readSource(inside, explicit).sourceText).toBe('Readable application source.');
            expect(readSource(shell, explicit)).toEqual({sourceText: '', sourceTextNodes: []});
            expect(readSource(inside, remountState())).toEqual({sourceText: '', sourceTextNodes: []});
            expect(readSource(segment, remountState({syntheticSegment: true})).sourceText)
                .toBe('Readable synthetic source.');
            expect(readSource(segment, remountState())).toEqual({sourceText: '', sourceTextNodes: []});
            expect(readSource(segment, remountState({syntheticSegment: true})).sourceTextNodes)
                .toEqual([segment.firstChild]);
        } finally { restore(); }
    });

    it('不同 core 的 shouldStayOriginal 资格隔离，复杂骨架仍保留原来的独立来源政策', () => {
        const {document, window} = parseHTML('<html><body><main><p>' +
            'Read <a href="https://example.test">https://example.test</a> carefully.<code>protected()</code>' +
            '</p></main></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const main = document.querySelector('main')!;
        const allCore = getCurrentTranslationCore('all');
        const contentCore = getCurrentTranslationCore('content');
        const allOriginal = vi.spyOn(allCore, 'shouldStayOriginal').mockReturnValue(false);
        const contentOriginal = vi.spyOn(contentCore, 'shouldStayOriginal').mockImplementation(element => element === main);
        const restore = installStyle(window, () => ({
            display: 'block', visibility: 'visible', position: 'static', fontFamily: 'serif',
        }));
        try {
            const readSource = createCurrentTranslationStateSourceSnapshotBatch();
            const allState = remountState();
            const actual = readSource(owner, allState);
            expect(actual).toEqual(getCurrentTranslationStateSourceSnapshot(owner, allState));
            expect(actual.sourceText).toBe('Read https://example.test carefully.');
            expect(actual.sourceTextNodes).toHaveLength(2);
            expect(readSource(owner, remountState({scope: 'content'})))
                .toEqual({sourceText: '', sourceTextNodes: []});
            expect(readSource(owner, allState)).toEqual(actual);
        } finally { allOriginal.mockRestore(); contentOriginal.mockRestore(); restore(); }
    });
});

// Completion evidence exercises registered lifecycle state and the actual core
// source reader. A successful identical result is captured before discard;
// reading it afterwards must prove the live owner still has those exact slots.
const completionUnitOwners = new Set<HTMLElement>();
function beginCompletionUnit(
    markup = '<p id="completion">Read the same English source.</p>',
    options: {mode?: 'bilingual' | 'single'; scope?: 'content' | 'all'; synthetic?: boolean; withoutSourceNodes?: boolean; shell?: boolean; prepareDocument?: (document: Document) => void} = {},
) {
    const {document} = parseHTML('<html><body><main' + (options.shell ? ' translate="no"' : '') + '>' + markup + '</main></body></html>');
    options.prepareDocument?.(document as unknown as Document);
    const owner = document.querySelector<HTMLElement>('#completion')!;
    const scope = options.scope ?? 'content';
    const core = getCurrentTranslationCore(scope);
    const candidate = core.resolve(owner)!;
    expect(candidate?.element).toBe(owner);
    const protection = candidate.allowTopLevelApplicationShell
        ? {allowTopLevelApplicationShell: true, protectedElement: owner} : undefined;
    const slots = collectLiveTranslationTextSlots(owner, core.shouldStayOriginal, undefined, protection);
    const source = extractTranslationText(owner, core.shouldStayOriginal, undefined, protection);
    const attempt = beginTranslation(owner, options.mode ?? 'bilingual', candidate.kind,
        options.synthetic ?? false, source, options.withoutSourceNodes ? undefined : slots.map(slot => slot.node),
        candidate.allowTopLevelApplicationShell, undefined, scope);
    expect(attempt).not.toBeNull();
    completionUnitOwners.add(owner);
    expect(getTranslationState(owner)).toBe(attempt!.state);
    const config = {sessionId: 101, renderCommitGeneration: 7, configIdentity: 'google:zh-CN:content:bilingual',
        service: 'google', targetLanguage: 'zh-CN', excludedLanguages: [] as readonly string[]};
    return {document, owner, candidate, slots, config, ...attempt!};
}
function captureCompletionUnit(fixture: ReturnType<typeof beginCompletionUnit>,
    outputs: readonly string[] = [fixture.state.sourceText],
    config: Partial<ReturnType<typeof beginCompletionUnit>['config']> = {}) {
    return createAcceptedUnchangedCompletion(fixture.owner, fixture.candidate, fixture.state,
        fixture.generation, [fixture.state.sourceText], outputs, {...fixture.config, ...config});
}
function finishCompletionUnit(fixture: ReturnType<typeof beginCompletionUnit>) {
    const proof = captureCompletionUnit(fixture);
    expect(proof).toBeDefined();
    const record = createLifecycleRetry(fixture.candidate, fixture.state.sourceText, 0, proof);
    const query = {sessionId: fixture.config.sessionId, currentSessionId: fixture.config.sessionId,
        renderCommitGeneration: fixture.config.renderCommitGeneration, configIdentity: fixture.config.configIdentity,
        source: fixture.state.sourceText, cancelled: false};
    expect(discardTranslation(fixture.owner, fixture.state)).toBe(true);
    expect(getTranslationState(fixture.owner)).toBeUndefined();
    return {proof: proof!, record, query,
        read: (changes: Partial<typeof query> = {}) => readAcceptedUnchangedCompletion(fixture.owner, record, {...query, ...changes})};
}

describe('同值完成证据的真实来源与会话边界', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        completionUnitOwners.forEach(owner => restoreTranslation(owner));
        completionUnitOwners.clear();
    });

    it('retry 规范化原文，但相同字句的另一个 owner、重新分类的 kind 和新的 reason 都不是同一工作', () => {
        const fixture = beginCompletionUnit();
        const record = createLifecycleRetry(fixture.candidate, '  Read\n the same English source.　', 2);
        expect(record.source).toBe(fixture.state.sourceText);
        expect(record.attempts).toBe(2);
        expect(sameLifecycleRetry(record, fixture.candidate, fixture.state.sourceText)).toBe(true);
        expect(sameLifecycleRetry(undefined, fixture.candidate, fixture.state.sourceText)).toBe(false);
        expect(sameLifecycleRetry(record, fixture.candidate, 'Other readable words.')).toBe(false);
        const other = beginCompletionUnit();
        expect(sameLifecycleRetry(record, other.candidate, other.state.sourceText)).toBe(false);
        fixture.owner.setAttribute('role', 'button');
        const control = getCurrentTranslationCore('all').resolve(fixture.owner)!;
        expect(control.kind).toBe('control');
        expect(sameLifecycleRetry(record, control, record.source)).toBe(false);
        expect(sameLifecycleRetry(record, {...fixture.candidate, reason: 'site-boundary-change'}, record.source)).toBe(false);
    });

    it('同值另一 owner 的真实 candidate 不授予当前 state 完成证据', () => {
        const fixture = beginCompletionUnit();
        const other = beginCompletionUnit();
        expect(createAcceptedUnchangedCompletion(fixture.owner, other.candidate, fixture.state,
            fixture.generation, [fixture.state.sourceText], [fixture.state.sourceText], fixture.config)).toBeUndefined();
        expect(captureCompletionUnit(fixture)).toBeDefined();
    });

    it.each([
        {source: '$$$Spec$$$', accepted: false},
        {source: 'Spec', accepted: true},
    ])('实际来源 $source 的本地同值回填 accepted=$accepted，公式不能冒充已接收结果', ({source, accepted}) => {
        const fixture = beginCompletionUnit('<h2 id="completion">' + source + '</h2>');
        expect(fixture.state.sourceText).toBe(source);
        expect(fixture.slots.map(slot => slot.source)).toEqual([source]);
        const proof = captureCompletionUnit(fixture);
        expect(Boolean(proof)).toBe(accepted);
        const record = createLifecycleRetry(fixture.candidate, source, 0, proof);
        expect(discardTranslation(fixture.owner, fixture.state)).toBe(true);
        expect(readAcceptedUnchangedCompletion(fixture.owner, record, {sessionId: 101, currentSessionId: 101,
            renderCommitGeneration: 7, configIdentity: fixture.config.configIdentity, source, cancelled: false}).status)
            .toBe(accepted ? 'available' : 'unavailable');
    });

    it('未配置 excludedLanguages 的正常 Spec 同值响应仍可建立真实完成证据', () => {
        const fixture = beginCompletionUnit('<h2 id="completion">Spec</h2>');
        const {excludedLanguages: _excluded, ...config} = fixture.config;
        const proof = createAcceptedUnchangedCompletion(fixture.owner, fixture.candidate, fixture.state,
            fixture.generation, [fixture.state.sourceText], [fixture.state.sourceText], config);
        expect(proof).toBeDefined();
    });

    it('真实顶层应用壳 allowance 随证明复验，不能绕过 owner 保护或继承已移除的壳身份', () => {
        const fixture = beginCompletionUnit(undefined, {shell: true});
        expect(fixture.candidate.allowTopLevelApplicationShell).toBe(true);
        expect(fixture.state.allowTopLevelApplicationShell).toBe(true);
        const completion = finishCompletionUnit(fixture);
        expect(completion.proof.allowTopLevelApplicationShell).toBe(true);
        expect(completion.read().status).toBe('available');
        fixture.owner.setAttribute('translate', 'no');
        expect(completion.read().status).toBe('unavailable');
        fixture.owner.removeAttribute('translate');
        expect(completion.read().status).toBe('available');
        fixture.owner.parentElement!.removeAttribute('translate');
        expect(completion.read().status).toBe('unavailable');
    });

    it.each(['freeTranslation', 'microsoft', 'google'])('%s 的非空同值结果只在 discard 后成为历史结果证据，数组不与调用者共享', service => {
        const fixture = beginCompletionUnit();
        const sources = [fixture.state.sourceText];
        const outputs = ['\n ' + fixture.state.sourceText + '　'];
        const proof = createAcceptedUnchangedCompletion(fixture.owner, fixture.candidate, fixture.state,
            fixture.generation, sources, outputs, {...fixture.config, service})!;
        expect(proof).toBeDefined();
        const acceptedOutput = outputs[0];
        sources[0] = 'Caller mutated the input array.';
        outputs[0] = 'Caller mutated the output array.';
        const record = createLifecycleRetry(fixture.candidate, fixture.state.sourceText, 0, proof);
        const query = {sessionId: 101, currentSessionId: 101, renderCommitGeneration: 7,
            configIdentity: fixture.config.configIdentity, source: '  ' + fixture.state.sourceText + '\n', cancelled: false};
        expect(readAcceptedUnchangedCompletion(fixture.owner, record, query).status).toBe('unavailable');
        expect(discardTranslation(fixture.owner, fixture.state)).toBe(true);
        const read = readAcceptedUnchangedCompletion(fixture.owner, record, query);
        expect(read).toMatchObject({status: 'available', generation: fixture.generation,
            sources: [fixture.state.sourceText], outputs: [acceptedOutput], configuredService: service,
            sourceCurrent: true, requestBoundary: 'accepted-same-session-result-reuse', upstreamDispatchAndRoute: 'unavailable'});
        if (read.status !== 'available') throw new Error('Expected accepted identical result after discard');
        expect(Reflect.set(read.outputs, '0', 'Consumer mutated its returned copy.')).toBe(true);
        expect(readAcceptedUnchangedCompletion(fixture.owner, record, query)).toMatchObject({outputs: [acceptedOutput]});
        expect(fixture.owner.textContent).toBe(fixture.state.sourceText);
        expect(proof.sourceNodes).toEqual([fixture.owner.firstChild]);
    });

    it.each(['', ' \n\t　', 'Different translated content.', 'READ THE SAME ENGLISH SOURCE.'])('空结果或实际不同的结果 %j 不生成同值证明', output => {
        const fixture = beginCompletionUnit();
        expect(captureCompletionUnit(fixture, [output])).toBeUndefined();
        const retry = createLifecycleRetry(fixture.candidate, fixture.state.sourceText, 1);
        expect(discardTranslation(fixture.owner, fixture.state)).toBe(true);
        expect(readAcceptedUnchangedCompletion(fixture.owner, retry, {sessionId: 101, currentSessionId: 101,
            source: fixture.state.sourceText, cancelled: false}).status).toBe('unavailable');
    });

    it('缺失或批量错配的实际响应不能把请求状态误当成单槽完成结果', () => {
        const fixture = beginCompletionUnit();
        expect(captureCompletionUnit(fixture, [])).toBeUndefined();
        expect(captureCompletionUnit(fixture, [fixture.state.sourceText, fixture.state.sourceText])).toBeUndefined();
        for (const sources of [[], [fixture.state.sourceText, fixture.state.sourceText], ['Different request source.']]) {
            expect(createAcceptedUnchangedCompletion(fixture.owner, fixture.candidate, fixture.state,
                fixture.generation, sources, [fixture.state.sourceText], fixture.config)).toBeUndefined();
        }
        expect(captureCompletionUnit(fixture)).toBeDefined();
    });

    it('语言预检会跳过的同值结果和未支持的客户端不能提供已接收完成证据', () => {
        const chinese = beginCompletionUnit('<p id="completion">这是已经属于目标语言的完整中文句子。</p>');
        expect(captureCompletionUnit(chinese)).toBeUndefined();
        const english = beginCompletionUnit('<p id="completion">This paragraph explains how the translation extension keeps the original text and shows the translated sentence below it.</p>');
        expect(identifyTextLanguage(english.state.sourceText).status).toBe('identified');
        expect(captureCompletionUnit(english, undefined, {excludedLanguages: ['en']})).toBeUndefined();
        for (const service of ['openai', 'unknown-client']) {
            expect(captureCompletionUnit(english, undefined, {service})).toBeUndefined();
        }
        expect(captureCompletionUnit(english)).toBeDefined();
    });

    it('符合补充检测资格的真实长未知正文同值回填不能认证为供应商完成结果', () => {
        const source = 'Astronomical instruments capture electromagnetic radiation across distant interstellar regions enabling detailed spectroscopic measurements alongside sophisticated computational simulations.';
        const fixture = beginCompletionUnit('<p id="completion">' + source + '</p>');
        expect(fixture.state.sourceText).toBe(source);
        expect(identifyTextLanguage(source).status).toBe('unknown');
        expect(getSupplementalLanguageCandidate(source)).toBe('en');
        expect(captureCompletionUnit(fixture, [source], {targetLanguage: 'en'})).toBeUndefined();
        expect(captureCompletionUnit(fixture, [source])).toBeUndefined();
        expect(getTranslationState(fixture.owner)).toBe(fixture.state);
        expect(fixture.owner.textContent).toBe(source);
    });

    it('仅译文、按钮、合成段和多个真实槽均不提供 direct single-slot bilingual content 证据', () => {
        const single = beginCompletionUnit(undefined, {mode: 'single'});
        const control = beginCompletionUnit('<button id="completion">Read the same English source.</button>', {scope: 'all'});
        const synthetic = beginCompletionUnit('<p id="completion" data-fr-translation-segment="true" data-fr-translation-manual="true">Read the same English source.</p>', {synthetic: true});
        const multiple = beginCompletionUnit('<p id="completion">Read <strong>the same English source.</strong></p>');
        expect(single.state.mode).toBe('single');
        expect(control.state.kind).toBe('control');
        expect(synthetic.state.syntheticSegment).toBe(true);
        expect(multiple.slots).toHaveLength(2);
        for (const fixture of [single, control, synthetic, multiple]) expect(captureCompletionUnit(fixture)).toBeUndefined();
    });

    it('真实 inline run candidate 不因其原文可折叠成一个字符串而成为 direct completion', () => {
        const {document} = parseHTML('<html><body><main><div>Readable inline words.<p>Separate block words.</p></div></main></body></html>');
        const owner = document.querySelector<HTMLElement>('div')!;
        const core = getCurrentTranslationCore('content');
        const candidate = core.resolve(owner.firstChild!)!;
        expect(candidate.element).toBe(owner);
        expect(candidate.nodes).toEqual([owner.firstChild]);
        const source = (owner.firstChild as Text).data;
        const attempt = beginTranslation(owner, 'bilingual', candidate.kind, false, source, [owner.firstChild as Text], false, undefined, 'content')!;
        completionUnitOwners.add(owner);
        const config = beginCompletionUnit().config;
        expect(createAcceptedUnchangedCompletion(owner, candidate, attempt.state, attempt.generation,
            [source], [source], config)).toBeUndefined();
    });

    it('没有精确槽快照、超长来源和实际结构溢出的 state 都拒绝轻量证明', () => {
        const unknown = beginCompletionUnit(undefined, {withoutSourceNodes: true});
        expect(unknown.state.sourceTextNodes).toBeUndefined();
        expect(captureCompletionUnit(unknown)).toBeUndefined();
        const long = beginCompletionUnit('<p id="completion">' + 'Readable English words. '.repeat(100) + '</p>');
        expect(long.state.sourceText.length).toBeGreaterThan(2048);
        expect(captureCompletionUnit(long)).toBeUndefined();
        const overflow = beginCompletionUnit('<p id="completion" title="' + 'Host description. '.repeat(8000) + '">Read the same English source.</p>');
        expect(overflow.slots).toHaveLength(1);
        expect(overflow.state.sourceStructureSignature).not.toBe(unknown.state.sourceStructureSignature);
        expect(captureCompletionUnit(overflow)).toBeUndefined();
    });

    it('请求 generation 必须精确匹配，取消的真实旧 state 和新请求不能混用', () => {
        const fixture = beginCompletionUnit();
        expect(createAcceptedUnchangedCompletion(fixture.owner, fixture.candidate, fixture.state,
            fixture.generation + 1, [fixture.state.sourceText], [fixture.state.sourceText], fixture.config)).toBeUndefined();
        fixture.state.controller.abort();
        expect(captureCompletionUnit(fixture)).toBeUndefined();
        expect(markTranslationComplete(fixture.owner, fixture.state, fixture.generation)).toBe(false);
        expect(discardTranslation(fixture.owner, fixture.state)).toBe(true);
        const next = beginEpochUnitState(fixture.owner);
        completionUnitOwners.add(fixture.owner);
        expect(next.state).not.toBe(fixture.state);
        expect(captureCompletionUnit(fixture)).toBeUndefined();
        expect(createAcceptedUnchangedCompletion(fixture.owner, fixture.candidate, next.state,
            next.generation, [next.state.sourceText], [next.state.sourceText], fixture.config)).toBeDefined();
        epochUnitOwners.delete(fixture.owner);
    });

    it.each([
        {label: 'cancelled', change: {cancelled: true}},
        {label: 'requested session', change: {sessionId: 102}},
        {label: 'current session', change: {currentSessionId: 102}},
        {label: 'unknown current session', change: {currentSessionId: undefined}},
        {label: 'render generation', change: {renderCommitGeneration: 8}},
        {label: 'unknown render generation', change: {renderCommitGeneration: undefined}},
        {label: 'config identity', change: {configIdentity: 'google:en:content:bilingual'}},
        {label: 'unknown config identity', change: {configIdentity: undefined}},
    ])('$label 换代或未知时拒绝旧证据，即使 DOM/source 完全未变', ({change}) => {
        const fixture = beginCompletionUnit();
        const completion = finishCompletionUnit(fixture);
        expect(completion.read().status).toBe('available');
        expect(completion.read(change).status).toBe('unavailable');
        expect(completion.read().status).toBe('available');
    });

    it('当前注册的新请求使旧完成证据不可读，失败或尚未完成不能伪装为同值完成', () => {
        const fixture = beginCompletionUnit();
        const completion = finishCompletionUnit(fixture);
        expect(completion.read().status).toBe('available');
        const next = beginEpochUnitState(fixture.owner);
        expect(getTranslationState(fixture.owner)).toBe(next.state);
        expect(completion.read().status).toBe('unavailable');
        const retryWithoutResult = createLifecycleRetry(fixture.candidate, next.state.sourceText, 1);
        expect(readAcceptedUnchangedCompletion(fixture.owner, retryWithoutResult, completion.query).status).toBe('unavailable');
        expect(readAcceptedUnchangedCompletion(fixture.owner, undefined, completion.query).status).toBe('unavailable');
        expect(markTranslationComplete(fixture.owner, next.state, next.generation)).toBe(true);
        expect(completion.read().status).toBe('unavailable');
        epochUnitOwners.delete(fixture.owner);
    });

    it('每次由真实 core 读取当前来源，改字后返回相同语义才可复用历史结果', () => {
        const fixture = beginCompletionUnit();
        const completion = finishCompletionUnit(fixture);
        const text = fixture.slots[0]!.node;
        const inspect = vi.spyOn(getCurrentTranslationCore('content'), 'inspect');
        const data = spyEpochUnitSourceText(text);
        expect(completion.read().status).toBe('available');
        const firstReads = data.mock.contexts.filter(context => context === text).length;
        expect(firstReads).toBeGreaterThan(0);
        text.data = 'Host changed these original words.';
        expect(completion.read().status).toBe('unavailable');
        expect(completion.read({source: text.data}).status).toBe('unavailable');
        text.data = fixture.state.sourceText;
        expect(completion.read()).toMatchObject({status: 'available', requestBoundary: 'accepted-same-session-result-reuse'});
        expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(data.mock.contexts.filter(context => context === text).length).toBeGreaterThan(firstReads);
    });

    it('同值 Text 替换、槽扩张和相同 outerHTML 的 owner 替换都不能继承旧来源身份', () => {
        const fixture = beginCompletionUnit();
        const completion = finishCompletionUnit(fixture);
        const original = fixture.slots[0]!.node;
        const replacement = fixture.document.createTextNode(original.data);
        fixture.owner.replaceChildren(replacement);
        expect(completion.read().status).toBe('unavailable');
        fixture.owner.replaceChildren(original);
        expect(completion.read().status).toBe('available');
        fixture.owner.appendChild(fixture.document.createTextNode(' Extra readable words.'));
        expect(completion.read().status).toBe('unavailable');
        fixture.owner.replaceChildren(original);
        const clone = fixture.owner.cloneNode(true) as HTMLElement;
        fixture.owner.replaceWith(clone);
        expect(clone.textContent).toBe(fixture.state.sourceText);
        expect(completion.read().status).toBe('unavailable');
        expect(readAcceptedUnchangedCompletion(clone, completion.record, completion.query).status).toBe('unavailable');
    });

    it('原文和 Text 身份相同时，安全链接骨架、role/translate/hidden 边界仍要重新验证', () => {
        const fixture = beginCompletionUnit('<p id="completion"><a href="/original">Read the same English source.</a></p>');
        const completion = finishCompletionUnit(fixture);
        const text = fixture.slots[0]!.node;
        const link = fixture.owner.querySelector('a')!;
        expect(completion.read().status).toBe('available');
        link.setAttribute('href', '/different-route');
        expect(fixture.slots[0]!.node).toBe(text);
        expect(completion.read().status).toBe('unavailable');
        link.setAttribute('href', '/original');
        expect(completion.read().status).toBe('available');
        for (const [name, value] of [['role', 'button'], ['translate', 'no'], ['hidden', '']] as const) {
            fixture.owner.setAttribute(name, value);
            expect(completion.read().status).toBe('unavailable');
            fixture.owner.removeAttribute(name);
            expect(completion.read().status).toBe('available');
        }
    });

    it('译文 owned 工件即使不改变原文槽和骨架也阻止重复宣称无译文完成，移除后才可复用', () => {
        const fixture = beginCompletionUnit();
        const completion = finishCompletionUnit(fixture);
        const artifact = fixture.document.createElement('span');
        artifact.setAttribute('data-fr-translation-owned', 'true');
        fixture.owner.appendChild(artifact);
        expect(collectLiveTranslationTextSlots(fixture.owner, getCurrentTranslationCore('content').shouldStayOriginal)
            .map(slot => slot.node)).toEqual(completion.proof.sourceNodes);
        expect(getTranslationSourceStructureSignature(fixture.owner, false, completion.proof.sourceNodes, 'content'))
            .toBe(completion.proof.sourceStructureSignature);
        expect(completion.read().status).toBe('unavailable');
        artifact.remove();
        expect(completion.read().status).toBe('available');
    });
});

// Regression for exact completion-source matching when clipboard feedback is
// CSS-hidden. Provider output is controlled; no live-provider causation is assumed.
describe('pubdev caption identical-result source boundary diagnostic', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        completionUnitOwners.forEach(owner => restoreTranslation(owner));
        completionUnitOwners.clear();
    });
    const markup = '<h1 id="completion" class="title pub-monochrome-icon-hoverable">provider 6.1.5+1 ' +
        '<span class="pkg-page-title-copy"><img data-copy-content="provider: ^6.1.5+1" tabindex="0">' +
        '<div class="pkg-page-title-copy-feedback" style="display:none"><span class="code">provider: ^6.1.5+1</span> copied to clipboard</div></span></h1>';
    function makeCaption() {
        return beginCompletionUnit(markup, {prepareDocument(document) {
            Object.defineProperty(document.defaultView!, 'getComputedStyle', {configurable: true,
                value: (element: Element) => ({
                    display: element.matches('.pkg-page-title-copy-feedback')
                        ? (element as HTMLElement).style.display
                        : ['SPAN', 'IMG'].includes(element.tagName) ? 'inline' : 'block',
                    visibility: 'visible', position: 'static', overflow: 'visible', fontFamily: 'Arial',
                })});
        }});
    }
    it('real source accepts the clean identical caption but cannot certify the raw feedback-polluted query', () => {
        const fixture = makeCaption();
        const rawCloneSource = (fixture.owner.cloneNode(true).textContent || '').replace(/\s+/gu, ' ').trim();
        expect(fixture.state.sourceText).toBe('provider 6.1.5+1');
        expect(fixture.slots).toHaveLength(1);
        expect(rawCloneSource).toBe('provider 6.1.5+1 provider: ^6.1.5+1 copied to clipboard');
        const completion = finishCompletionUnit(fixture);
        expect(completion.read()).toMatchObject({status: 'available', reason: 'accepted-result-identical',
            sources: ['provider 6.1.5+1'], outputs: ['provider 6.1.5+1']});
        expect(completion.read({source: rawCloneSource})).toEqual({status: 'unavailable', reason: 'no-current-accepted-completion'});
        expect(fixture.owner.querySelector('[data-fr-translation-owned="true"]')).toBeNull();
    });
    it('copy-feedback becoming visible invalidates the clean historical receipt; exact source return can reuse it', () => {
        const fixture = makeCaption(), completion = finishCompletionUnit(fixture);
        const feedback = fixture.owner.querySelector<HTMLElement>('.pkg-page-title-copy-feedback')!;
        const exactStyle = feedback.getAttribute('style')!;
        expect(completion.read().status).toBe('available');
        feedback.style.display = 'block';
        expect(completion.read().status).toBe('unavailable');
        feedback.setAttribute('style', exactStyle);
        expect(completion.read()).toMatchObject({status: 'available', requestBoundary: 'accepted-same-session-result-reuse'});
        expect(fixture.owner.querySelector('[data-fr-translation-owned="true"]')).toBeNull();
    });
});

describe('仅译文 flex/grid 标签的候选范围复验', () => {
    it.each(['flex', 'grid'])('%s 原文槽不会使 Latest 失去候选身份，恢复后可再次翻译', (display) => {
        const {document, window} = parseHTML('<html><body><main><span id="latest">Latest</span></main></body></html>');
        const owner = document.querySelector<HTMLElement>('#latest')!;
        const source = owner.firstChild as Text;
        const originalHTML = owner.innerHTML;
        const descriptor = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
        // 真实浏览器会把 flex/grid 的直接子项 blockify；linkedom 不计算布局。
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: (element: Element) => ({
            display: element === owner ? display : element.classList.contains('fluent-read-single-slot') ? 'block'
                : element.localName === 'span' ? 'inline' : 'block',
        })});
        const core = getCurrentTranslationCore('content');
        const render = () => {
            const candidate = core.inspect(owner).candidate!;
            expect(candidate).toMatchObject({element: owner, kind: 'content'});
            const attempt = beginTranslation(owner, 'single', candidate.kind, false, 'Latest', [source], false, undefined, 'content')!;
            const host = document.createElement('span');
            host.className = 'fluent-read-single-slot';
            host.setAttribute('data-fr-translation-owned', 'true');
            host.setAttribute('translate', 'no');
            owner.insertBefore(host, source);
            host.appendChild(source);
            setSingleTextSlotHosts(owner, [host]);
            expect(markTranslationComplete(owner, attempt.state, attempt.generation, false)).toBe(true);
            return {host, state: attempt.state};
        };
        try {
            const current = render();
            expect(statefulSourceAndTextSlotsAreCurrent(owner, current.state)).toBe(true);
            for (let index = 0; index < 3; index += 1) {
                expect(isTranslationStateCandidateCurrent(owner, current.state)).toBe(true);
            }
            expect(restoreTranslation(owner)).toBe(true);
            expect(owner.innerHTML).toBe(originalHTML);
            expect(owner.firstChild).toBe(source);
            expect(current.host.isConnected).toBe(false);
            const next = render();
            expect(isTranslationStateCandidateCurrent(owner, next.state)).toBe(true);

            // 真实新增正文块仍改变候选边界，不能因为存在自有槽而忽略。
            const paragraph = document.createElement('p');
            paragraph.textContent = 'A new readable paragraph.';
            owner.appendChild(paragraph);
            expect(isTranslationStateCandidateCurrent(owner, next.state)).toBe(false);
            paragraph.remove();
            expect(isTranslationStateCandidateCurrent(owner, next.state)).toBe(true);

            // 来源修改和禁译仍拒绝原候选；同字克隆不继承已验证槽身份。
            source.data = 'Changed';
            expect(isTranslationStateCandidateCurrent(owner, next.state)).toBe(false);
            source.data = 'Latest';
            owner.setAttribute('translate', 'no');
            expect(isTranslationStateCandidateCurrent(owner, next.state)).toBe(false);
            owner.removeAttribute('translate');
            const clone = next.host.cloneNode(true);
            next.host.replaceWith(clone);
            expect(isTranslationStateCandidateCurrent(owner, next.state)).toBe(false);
        } finally {
            restoreTranslation(owner);
            if (descriptor) Object.defineProperty(window, 'getComputedStyle', descriptor);
            else Reflect.deleteProperty(window, 'getComputedStyle');
        }
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {parseHTML} from "linkedom";
import {
    acquireTranslationLayoutOverride,
    beginTranslation,
    subscribeTranslationStateChanges,
    detachFailedTranslationUi,
    discardTranslation,
    ensureTranslationTruncationLayout,
    getOwnedTranslationCandidateAtPoint,
    getTranslationOwnersForIndexedNode,
    getTranslationOwnersForRemovedNode,
    getTranslationOwnersWithin,
    getTranslationSourceStructureSignature,
    getTranslationState,
    isTranslationSourceStructureOverflow,
    isCurrentTranslation,
    markTranslationComplete,
    markTranslationError,
    restoreAllTranslations,
    restoreTranslation,
    setBilingualContent,
    setBilingualLifecycleExternalManager,
    setRenderedStyleAttribute,
    setRetryWrapper,
    setSingleTextSlotHosts,
    setSpinner,
    setTextSlotsApplied,
    tryRepairBilingualTranslationArtifact,
    unwrapUnownedSingleTextSlots,
    type TranslationState,
} from "@/src/features/full-page-translation/content/state";

/**
 * 用最小的 DOM 替身测试状态机，不把 jsdom 引入生产依赖。
 * 这些对象只实现 translationState.ts 真正使用的节点能力。
 */
class FakeElement {
    isConnected = true;
    textContent = "Original text";
    innerHTML = "Original text";
    outerHTML = "<p>Original text</p>";
    childNodes: object[] = [{ type: "original-child" }];
    classList = { remove: vi.fn() };
    attributes = new Map<string, string>();
    controller?: AbortController;
    ownerDocument?: Document;

    get firstChild(): object | undefined {
        return this.childNodes[0];
    }

    removeChild(child: object): object {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) this.childNodes.splice(index, 1);
        return child;
    }

    appendChild(child: object): object {
        this.childNodes.push(child);
        return child;
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name);
    }

    querySelectorAll(): object[] {
        return [];
    }
}

describe("指定节点翻译状态机", () => {
    let node: FakeElement;

    beforeEach(() => {
        node = new FakeElement();
    });

    it("阶段订阅按真实转换发布，异常观察者不影响完成和恢复，解除后不持有通知", () => {
        const target = node as unknown as HTMLElement;
        const phases: Array<string | undefined> = [];
        const bad = subscribeTranslationStateChanges(() => { throw new Error('observer'); });
        const stop = subscribeTranslationStateChanges((owner, state) => {
            expect(owner).toBe(target);
            expect(getTranslationState(owner)).toBe(state);
            phases.push(state?.phase);
        });
        try {
            const first = beginTranslation(target, 'single')!;
            expect(beginTranslation(target, 'single')).toBeNull();
            markTranslationError(target, first.state, first.generation);
            const next = beginTranslation(target, 'single')!;
            markTranslationComplete(target, next.state, next.generation);
            restoreTranslation(target);
            expect(phases).toEqual(['loading', 'error', 'loading', 'translated', undefined]);
            stop();
            beginTranslation(target, 'single');
            restoreTranslation(target);
            expect(phases).toHaveLength(5);
        } finally {stop(); bad();}
    });

    it("同一个节点在 loading 期间不会重复发起请求", () => {
        const first = beginTranslation(node as unknown as HTMLElement, "single");

        expect(first).not.toBeNull();
        expect(beginTranslation(node as unknown as HTMLElement, "single")).toBeNull();
        expect(getTranslationState(node as unknown as HTMLElement)).toBe(first?.state);
    });

    it("保存候选提取后的精确 source，而不是包含扩展 artifact 的 textContent", () => {
        const attempt = beginTranslation(
            node as unknown as HTMLElement,
            "bilingual",
            "content",
            false,
            "Exact protected-aware source",
            [],
        );

        expect(attempt?.state.sourceText).toBe("Exact protected-aware source");
        expect(attempt?.state.sourceTextNodes).toEqual([]);
    });

    it("synthetic source children 在 spinner 插入前归档到同一代状态", () => {
        const firstSource = {type: "first-source"};
        const secondSource = {type: "second-source"};
        node.childNodes = [firstSource, secondSource];

        const attempt = beginTranslation(
            node as unknown as HTMLElement,
            "bilingual",
            "content",
            true,
        );
        const spinner = {type: "spinner"};
        node.appendChild(spinner);

        expect(attempt?.state.syntheticSourceNodes).toEqual([firstSource, secondSource]);
        expect(attempt?.state.syntheticSourceNodes).not.toContain(spinner);
    });

    it("原文结构签名忽略展示抖动，但跟踪会复制到译文骨架的公式与链接语义", () => {
        const {document} = parseHTML(`
            <html><body><p id="owner"><a href="/before">Readable link</a><span class="MathJax">v1</span></p></body></html>
        `);
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const signature = getTranslationSourceStructureSignature(owner);

        owner.className = 'hover-state';
        owner.style.color = 'red';
        expect(getTranslationSourceStructureSignature(owner)).toBe(signature);

        owner.querySelector<HTMLElement>('.MathJax')!.textContent = 'v2';
        const formulaSignature = getTranslationSourceStructureSignature(owner);
        expect(formulaSignature).not.toBe(signature);

        owner.querySelector('a')!.setAttribute('href', '/after');
        expect(getTranslationSourceStructureSignature(owner)).not.toBe(formulaSignature);

        const attempt = beginTranslation(owner, 'bilingual')!;
        expect(attempt.state.sourceStructureSignature).toBe(
            getTranslationSourceStructureSignature(owner),
        );
    });

    it("结构签名跟踪 code/no-translate 内容与 pre 空白，并以有界迭代处理深树", () => {
        const {document} = parseHTML(`
            <html><body><div id="owner"><code>foo()</code><span translate="no">literal</span><pre>a  b</pre></div></body></html>
        `);
        const owner = document.querySelector<HTMLElement>('#owner')!;
        let signature = getTranslationSourceStructureSignature(owner);

        owner.querySelector('code')!.textContent = 'bar()';
        expect(getTranslationSourceStructureSignature(owner)).not.toBe(signature);
        signature = getTranslationSourceStructureSignature(owner);
        owner.querySelector('[translate="no"]')!.textContent = 'changed literal';
        expect(getTranslationSourceStructureSignature(owner)).not.toBe(signature);
        signature = getTranslationSourceStructureSignature(owner);
        owner.querySelector('pre')!.textContent = 'a b';
        expect(getTranslationSourceStructureSignature(owner)).not.toBe(signature);

        let deepest: HTMLElement = owner;
        for (let depth = 0; depth < 140; depth += 1) {
            const child = document.createElement('span');
            deepest.appendChild(child);
            deepest = child;
        }
        deepest.textContent = 'deep value';
        const deepSignature = getTranslationSourceStructureSignature(owner);
        expect(isTranslationSourceStructureOverflow(deepSignature)).toBe(true);
        expect(getTranslationSourceStructureSignature(owner)).toBe(deepSignature);
        deepest.textContent = 'different deep value';
        expect(getTranslationSourceStructureSignature(owner)).toBe(deepSignature);

        const longOwner = document.createElement('div');
        longOwner.textContent = 'x'.repeat(140_000);
        const longSignature = getTranslationSourceStructureSignature(longOwner);
        expect(isTranslationSourceStructureOverflow(longSignature)).toBe(true);
        expect(getTranslationSourceStructureSignature(longOwner)).toBe(longSignature);
    });

    it("结构签名区分相同文本槽的保护位置，而不纳入普通 hover class", () => {
        const {document} = parseHTML(`
            <html><body><p id="owner"><span class="notranslate">same</span><span>same</span></p></body></html>
        `);
        const owner = document.querySelector<HTMLElement>('#owner')!;
        const spans = owner.querySelectorAll<HTMLElement>('span');
        const signature = getTranslationSourceStructureSignature(owner);

        owner.className = 'hovered';
        expect(getTranslationSourceStructureSignature(owner)).toBe(signature);
        spans[0]!.className = '';
        spans[1]!.className = 'notranslate';
        expect(getTranslationSourceStructureSignature(owner)).not.toBe(signature);
    });

    it("旧一代请求在重新开始后不再被视为当前请求", () => {
        const first = beginTranslation(node as unknown as HTMLElement, "bilingual");
        expect(first).not.toBeNull();

        markTranslationError(
            node as unknown as HTMLElement,
            first!.state,
            first!.generation,
        );
        const second = beginTranslation(node as unknown as HTMLElement, "bilingual");

        expect(second?.generation).toBe(first!.generation + 1);
        expect(isCurrentTranslation(
            node as unknown as HTMLElement,
            first!.state,
            first!.generation,
        )).toBe(false);
        expect(isCurrentTranslation(
            node as unknown as HTMLElement,
            second!.state,
            second!.generation,
        )).toBe(true);
    });

    it("single 在尚未写入译文时恢复，不会断开宿主子节点", () => {
        const originalChild = node.childNodes[0];
        const attempt = beginTranslation(node as unknown as HTMLElement, "single");
        expect(attempt).not.toBeNull();

        expect(restoreTranslation(node as unknown as HTMLElement)).toBe(true);
        expect(node.childNodes).toEqual([originalChild]);
        expect(getTranslationState(node as unknown as HTMLElement)).toBeUndefined();
        expect(attempt!.state.controller.signal.aborted).toBe(true);
    });

    it("站点在异步请求期间重渲染时，全局恢复也不覆盖站点的新节点", () => {
        const attempt = beginTranslation(node as unknown as HTMLElement, "single");
        expect(attempt).not.toBeNull();

        const hostChild = { type: "host-rerendered-child" };
        node.childNodes = [hostChild];
        node.innerHTML = "Host rerendered text";
        attempt!.state.phase = "translated";

        expect(restoreTranslation(node as unknown as HTMLElement)).toBe(true);
        expect(node.childNodes).toEqual([hostChild]);
        expect(getTranslationState(node as unknown as HTMLElement)).toBeUndefined();
    });

    it('恢复父 owner 只移除自身精确工件，不破坏嵌套 child owner 的状态和译文', () => {
        const {document} = parseHTML(
            '<html><body><section id="parent">Parent text.<p id="child">Child text.</p></section></body></html>',
        );
        const parent = document.querySelector<HTMLElement>('#parent')!;
        const child = document.querySelector<HTMLElement>('#child')!;
        const childAttempt = beginTranslation(child, 'bilingual')!;
        expect(markTranslationComplete(child, childAttempt.state, childAttempt.generation)).toBe(true);
        const childWrapper = document.createElement('span');
        childWrapper.className = 'fluent-read-bilingual-content';
        childWrapper.setAttribute('data-fr-translation-owned', 'true');
        childWrapper.textContent = '子级译文。';
        child.appendChild(childWrapper);
        setBilingualContent(child, childWrapper);

        const parentAttempt = beginTranslation(parent, 'bilingual')!;
        expect(markTranslationComplete(parent, parentAttempt.state, parentAttempt.generation)).toBe(true);
        const parentWrapper = document.createElement('span');
        parentWrapper.className = 'fluent-read-bilingual-content';
        parentWrapper.setAttribute('data-fr-translation-owned', 'true');
        parentWrapper.textContent = '父级译文。';
        parent.appendChild(parentWrapper);
        setBilingualContent(parent, parentWrapper);

        expect(restoreTranslation(parent)).toBe(true);
        expect(getTranslationState(parent)).toBeUndefined();
        expect(parentWrapper.isConnected).toBe(false);
        expect(getTranslationState(child)).toBe(childAttempt.state);
        expect(childWrapper.isConnected).toBe(true);
        expect(child.querySelector('.fluent-read-bilingual-content')).toBe(childWrapper);
    });

    it("站点在请求期间重渲染时，不把失败状态写入新内容", () => {
        const attempt = beginTranslation(node as unknown as HTMLElement, "bilingual");
        expect(attempt).not.toBeNull();

        node.innerHTML = "Host rerendered text";

        expect(markTranslationError(
            node as unknown as HTMLElement,
            attempt!.state,
            attempt!.generation,
        )).toBe(false);
        expect(getTranslationState(node as unknown as HTMLElement)).toBe(attempt!.state);
        expect(attempt!.state.phase).toBe("loading");
    });

    it("调用方完成精确 source 校验后，可忽略仅属性导致的 innerHTML 差异", () => {
        const attempt = beginTranslation(node as unknown as HTMLElement, "bilingual");
        expect(attempt).not.toBeNull();
        node.innerHTML = '<span class="animated">Original text</span>';

        expect(markTranslationComplete(
            node as unknown as HTMLElement,
            attempt!.state,
            attempt!.generation,
            false,
        )).toBe(true);
    });

    it("恢复双语翻译时还原插件临时修改的内联样式", () => {
        node.setAttribute("style", "display: -webkit-box; -webkit-line-clamp: 2; max-height: 4px;");
        const attempt = beginTranslation(node as unknown as HTMLElement, "bilingual");
        expect(attempt).not.toBeNull();

        node.setAttribute("style", "display: -webkit-box; -webkit-line-clamp: unset; max-height: unset;");
        setRenderedStyleAttribute(node as unknown as HTMLElement);

        expect(restoreTranslation(node as unknown as HTMLElement)).toBe(true);
        expect(node.getAttribute("style")).toBe("display: -webkit-box; -webkit-line-clamp: 2; max-height: 4px;");
    });

    it("网站在翻译后更新样式时，恢复不会覆盖网站的新值", () => {
        node.setAttribute("style", "max-height: 4px;");
        const attempt = beginTranslation(node as unknown as HTMLElement, "bilingual");
        expect(attempt).not.toBeNull();

        node.setAttribute("style", "max-height: unset;");
        setRenderedStyleAttribute(node as unknown as HTMLElement);
        node.setAttribute("style", "max-height: none;");

        expect(restoreTranslation(node as unknown as HTMLElement)).toBe(true);
        expect(node.getAttribute("style")).toBe("max-height: none;");
    });

    it('provider 在途期间新增的宿主 hover class 在提交与恢复后仍保留', () => {
        const {document} = parseHTML('<html><body><p class="base">Source</p></body></html>');
        const target = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(target, 'bilingual')!;

        target.classList.add('host-hover');
        expect(markTranslationComplete(target, attempt.state, attempt.generation, false)).toBe(true);
        setRenderedStyleAttribute(target);
        expect(restoreTranslation(target)).toBe(true);

        expect(target.classList.contains('base')).toBe(true);
        expect(target.classList.contains('host-hover')).toBe(true);
        expect(target.classList.contains('fluent-read-bilingual')).toBe(false);
        expect(target.classList.contains('fluent-read-failure')).toBe(false);
    });

    it("原节点没有 style 属性时，恢复会移除插件临时创建的 style", () => {
        const attempt = beginTranslation(node as unknown as HTMLElement, "bilingual");
        expect(attempt).not.toBeNull();

        node.setAttribute("style", "-webkit-line-clamp: unset; max-height: unset;");
        setRenderedStyleAttribute(node as unknown as HTMLElement);

        expect(restoreTranslation(node as unknown as HTMLElement)).toBe(true);
        expect(node.getAttribute("style")).toBeNull();
    });

    it("live text 恢复保留节点身份，并且不覆盖宿主更新后的文本", () => {
        const {document} = parseHTML('<html><body><p id="target">Open <a href="/guide">the guide</a>.</p></body></html>');
        const target = document.querySelector('#target') as HTMLElement;
        const link = target.querySelector('a')!;
        const attempt = beginTranslation(target, 'single');
        expect(attempt).not.toBeNull();
        const originalNodes = attempt!.state.originalTextValues.map(({node: textNode}) => textNode);

        originalNodes[0]!.nodeValue = '打开 ';
        originalNodes[1]!.nodeValue = '指南';
        setTextSlotsApplied(target, [originalNodes[0]!]);
        expect(attempt!.state.translatedTextNodes).toEqual([originalNodes[0]]);
        originalNodes[1]!.nodeValue = 'Host updated link';

        expect(restoreTranslation(target)).toBe(true);
        expect(target.firstChild).toBe(originalNodes[0]);
        expect(target.querySelector('a')).toBe(link);
        expect(originalNodes[0]!.nodeValue).toBe('Open ');
        expect(originalNodes[1]!.nodeValue).toBe('Host updated link');
    });

    it("仅译文视觉槽恢复原 Text 身份，并保留宿主在槽内的实时更新", () => {
        const {document} = parseHTML('<html><body><relative-time id="time">12 hours ago</relative-time></body></html>');
        const target = document.querySelector<HTMLElement>('#time')!;
        const source = target.firstChild as Text;
        beginTranslation(target, 'single', 'content', false, '12 hours ago', [source]);

        const host = document.createElement('span');
        host.setAttribute('data-fr-translation-owned', 'true');
        target.insertBefore(host, source);
        host.appendChild(source);
        setSingleTextSlotHosts(target, [host]);

        source.nodeValue = '11 hours ago';
        expect(restoreTranslation(target)).toBe(true);

        expect(target.firstChild).toBe(source);
        expect(target.textContent).toBe('11 hours ago');
        expect(host.isConnected).toBe(false);
    });

    it('恢复外层 owner 时解包无主槽，但保留其中另一活跃 owner 的真实槽和来源身份', () => {
        const {document} = parseHTML('<html><body><section id="outer">Outer source.</section><p id="foreign">Foreign source.</p></body></html>');
        const outer = document.querySelector<HTMLElement>('#outer')!;
        const foreign = document.querySelector<HTMLElement>('#foreign')!;
        beginTranslation(outer, 'single');
        const source = foreign.firstChild as Text;
        const foreignAttempt = beginTranslation(foreign, 'single', 'content', false, source.data, [source])!;
        const activeSlot = document.createElement('span');
        activeSlot.className = 'fluent-read-single-slot';
        activeSlot.setAttribute('data-fr-translation-owned', 'true');
        foreign.insertBefore(activeSlot, source);
        activeSlot.appendChild(source);
        setSingleTextSlotHosts(foreign, [activeSlot]);
        const clone = activeSlot.cloneNode(true) as HTMLElement;
        clone.replaceChildren(activeSlot);
        outer.appendChild(clone);

        expect(restoreTranslation(outer)).toBe(true);
        expect(clone.isConnected).toBe(false);
        expect(activeSlot.parentElement).toBe(outer);
        expect(activeSlot.firstChild).toBe(source);
        expect(getTranslationState(foreign)).toBe(foreignAttempt.state);
        expect(foreignAttempt.state.controller.signal.aborted).toBe(false);
        expect(outer.textContent).toBe('Outer source.Foreign source.');

        restoreTranslation(foreign);
        unwrapUnownedSingleTextSlots(outer);
        expect(activeSlot.isConnected).toBe(false);
        expect(source.parentElement).toBe(outer);
    });

    it('无主槽清理只匹配 class 与 owned 组合，并保留嵌套来源 Text 的原始身份', () => {
        const {document} = parseHTML('<html><body><section><span class="fluent-read-single-slot">Host lookalike.</span><span data-fr-translation-owned="true">Other owned node.</span><span id="orphan" class="fluent-read-single-slot" data-fr-translation-owned="true"><span class="fluent-read-single-slot" data-fr-translation-owned="true">Cloned source.</span></span></section></body></html>');
        const outer = document.querySelector<HTMLElement>('section')!;
        const lookalike = outer.children[0]!;
        const unrelatedOwned = outer.children[1]!;
        const orphan = document.querySelector<HTMLElement>('#orphan')!;
        const source = orphan.firstElementChild!.firstChild as Text;

        unwrapUnownedSingleTextSlots(orphan);
        expect(orphan.isConnected).toBe(false);
        expect(source.parentElement).toBe(outer);
        expect(lookalike.parentElement).toBe(outer);
        expect(unrelatedOwned.parentElement).toBe(outer);
        expect(outer.textContent).toBe('Host lookalike.Other owned node.Cloned source.');
        unwrapUnownedSingleTextSlots(outer);
        expect(source.parentElement).toBe(outer);
    });

    it("仅译文 closed-shadow slot 命中可通过所有权索引找回状态 owner", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector<HTMLElement>('#target')!;
        const source = target.firstChild as Text;
        beginTranslation(target, 'single', 'content', false, source.nodeValue ?? '', [source]);
        const host = document.createElement('span');
        host.setAttribute('data-fr-translation-owned', 'true');
        target.insertBefore(host, source);
        host.appendChild(source);
        setSingleTextSlotHosts(target, [host]);
        Object.defineProperty(document, 'elementsFromPoint', {configurable: true, value: () => [host, target]});

        const candidate = getOwnedTranslationCandidateAtPoint(document, 20, 20);
        expect(candidate).toMatchObject({
            element: target,
            kind: 'content',
            reason: 'existing-translation-at-point',
        });
        expect(candidate).not.toHaveProperty('nodes');
        Object.defineProperty(document, 'elementsFromPoint', {value: () => []});
        expect(getOwnedTranslationCandidateAtPoint(document, 999, 999)).toBeNull();
    });

    it("按组合树列出区域内的译文所有者，不包含区域外、脱离文档或已恢复的节点", () => {
        const {document} = parseHTML('<html><body><article id="section"><p id="inside">One.</p><div id="host"></div></article><p id="outside">Two.</p></body></html>');
        const section = document.querySelector('#section')!;
        const inside = document.querySelector<HTMLElement>('#inside')!;
        const outside = document.querySelector<HTMLElement>('#outside')!;
        const shadowRoot = document.querySelector('#host')!.attachShadow({mode: 'open'});
        const shadowParagraph = document.createElement('p');
        shadowRoot.appendChild(shadowParagraph);
        const detached = document.createElement('p');
        for (const node of [inside, outside, shadowParagraph, detached]) expect(beginTranslation(node, 'bilingual')).not.toBeNull();

        expect(getTranslationOwnersWithin(section)).toHaveLength(2);
        expect(getTranslationOwnersWithin(section)).toEqual(expect.arrayContaining([inside, shadowParagraph]));
        expect(getTranslationOwnersWithin(document)).toHaveLength(3);
        restoreTranslation(inside);
        expect(getTranslationOwnersWithin(section)).toEqual([shadowParagraph]);
        for (const node of [outside, shadowParagraph, detached]) restoreTranslation(node);
        expect(getTranslationOwnersWithin(document)).toEqual([]);
    });

    it("能在宿主移除双语 wrapper 后找到并清理其 owner", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector('#target') as HTMLElement;
        const attempt = beginTranslation(target, 'bilingual');
        expect(attempt).not.toBeNull();
        const wrapper = document.createElement('span');
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        target.appendChild(wrapper);
        setBilingualContent(target, wrapper);
        wrapper.remove();

        expect(getTranslationOwnersForRemovedNode(wrapper)).toEqual([target]);
        expect(restoreTranslation(target)).toBe(true);
        expect(getTranslationOwnersForRemovedNode(wrapper)).toEqual([]);
    });

    it("短时窗口内宿主持续删除双语 wrapper 时最多重挂三次，耗尽后本代持续熔断", async () => {
        vi.useFakeTimers();
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector<HTMLElement>('#target')!;
        const attempt = beginTranslation(target, 'bilingual')!;
        expect(markTranslationComplete(target, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '可读段落。';
        target.appendChild(wrapper);
        setBilingualContent(target, wrapper);

        try {
            for (let repair = 0; repair < 3; repair += 1) {
                wrapper.remove();
                expect(tryRepairBilingualTranslationArtifact(target, attempt.state)).toBe('repaired');
                expect(wrapper.parentNode).toBe(target);
            }

            wrapper.remove();
            expect(tryRepairBilingualTranslationArtifact(target, attempt.state)).toBe('capitulated');
            expect(wrapper.parentNode).toBeNull();

            await vi.advanceTimersByTimeAsync(1_000);
            expect(tryRepairBilingualTranslationArtifact(target, attempt.state)).toBe('capitulated');
            expect(wrapper.parentNode).toBeNull();
        } finally {
            if (getTranslationState(target)) restoreTranslation(target);
            vi.useRealTimers();
        }
    });

    it("宿主保留同一 Text 身份但改变链接结构时不重挂旧译文", () => {
        const {document} = parseHTML(`
            <html><body><p id="target"><a id="before" href="/before">Readable link.</a></p></body></html>
        `);
        const target = document.querySelector<HTMLElement>('#target')!;
        const before = document.querySelector<HTMLAnchorElement>('#before')!;
        const source = before.firstChild as Text;
        const attempt = beginTranslation(
            target,
            'bilingual',
            'content',
            false,
            'Readable link.',
            [source],
        )!;
        expect(markTranslationComplete(target, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '可读链接。';
        target.appendChild(wrapper);
        setBilingualContent(target, wrapper);

        wrapper.remove();
        const after = document.createElement('a');
        after.setAttribute('href', '/after');
        after.appendChild(source);
        before.replaceWith(after);

        expect(tryRepairBilingualTranslationArtifact(target, attempt.state)).toBe('not-repairable');
        expect(wrapper.parentNode).toBeNull();
        expect(restoreTranslation(target)).toBe(true);
    });

    it("布局拒绝已计费的重挂返回独立结果，避免同一事件重复消费", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector<HTMLElement>('#target')!;
        const attempt = beginTranslation(target, 'bilingual')!;
        expect(markTranslationComplete(target, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文';
        target.appendChild(wrapper);
        setBilingualContent(target, wrapper);
        wrapper.remove();

        expect(tryRepairBilingualTranslationArtifact(target, attempt.state, () => false))
            .toBe('rejected-after-write');
        expect(wrapper.parentNode).toBeNull();
        expect(restoreTranslation(target)).toBe(true);
    });

    it("失败重试 wrapper 被宿主移除后仍能通过 ownership 索引找到 owner", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector('#target') as HTMLElement;
        const attempt = beginTranslation(target, 'bilingual')!;
        expect(markTranslationError(target, attempt.state, attempt.generation)).toBe(true);
        const retryWrapper = document.createElement('span');
        retryWrapper.setAttribute('data-fr-translation-owned', 'true');
        target.appendChild(retryWrapper);
        setRetryWrapper(target, retryWrapper);

        retryWrapper.remove();

        expect(getTranslationOwnersForRemovedNode(retryWrapper)).toEqual([target]);
        expect(discardTranslation(target, attempt.state)).toBe(true);
        expect(getTranslationOwnersForRemovedNode(retryWrapper)).toEqual([]);
    });

    it("宿主移除失败 UI 后保留 error tombstone，但清除 UI ownership 和失败 class", () => {
        const {document} = parseHTML('<html><body><p id="target" class="host">Readable paragraph.</p></body></html>');
        const target = document.querySelector('#target') as HTMLElement;
        const attempt = beginTranslation(target, 'bilingual')!;
        expect(markTranslationError(target, attempt.state, attempt.generation)).toBe(true);
        const retryWrapper = document.createElement('span');
        retryWrapper.setAttribute('data-fr-translation-owned', 'true');
        target.appendChild(retryWrapper);
        target.setAttribute('data-fr-translation-failed', 'true');
        setRetryWrapper(target, retryWrapper);
        setRenderedStyleAttribute(target);
        retryWrapper.remove();

        expect(detachFailedTranslationUi(target, attempt.state)).toBe(true);
        expect(getTranslationState(target)).toBe(attempt.state);
        expect(attempt.state.phase).toBe('error');
        expect(attempt.state.retryWrapper).toBeUndefined();
        expect(target.className).toBe('host');
        expect(target.hasAttribute('data-fr-translation-failed')).toBe(false);
        expect(getTranslationOwnersForRemovedNode(retryWrapper)).toEqual([]);
        expect(restoreTranslation(target)).toBe(true);
    });

    it("removed ancestor 和 owner 自身移除都能通过 subtree 索引找到 owner", () => {
        const {document} = parseHTML(`
            <html><body>
                <section id="removed"><div><p id="target">Readable paragraph.</p></div></section>
            </body></html>
        `);
        const removed = document.querySelector("#removed") as HTMLElement;
        const target = document.querySelector("#target") as HTMLElement;
        const attempt = beginTranslation(target, "bilingual");
        expect(attempt).not.toBeNull();

        removed.remove();

        expect(getTranslationOwnersForRemovedNode(removed)).toEqual([target]);
        expect(getTranslationOwnersForRemovedNode(target)).toEqual([target]);
        expect(restoreTranslation(target)).toBe(true);
    });

    it("removed subtree 查询不会读取大批无关 active owner 的状态", () => {
        const {document} = parseHTML(`
            <html><body>
                <section id="removed"><p id="target">Target paragraph.</p></section>
                <main id="unrelated"></main>
            </body></html>
        `);
        const removed = document.querySelector("#removed") as HTMLElement;
        const target = document.querySelector("#target") as HTMLElement;
        const unrelatedRoot = document.querySelector("#unrelated") as HTMLElement;
        const targetAttempt = beginTranslation(target, "bilingual")!;
        const unrelatedAttempts: Array<{owner: HTMLElement; state: TranslationState}> = [];
        let unrelatedStateReads = 0;

        for (let index = 0; index < 1_000; index += 1) {
            const owner = document.createElement("p");
            owner.textContent = `Unrelated paragraph ${index}.`;
            unrelatedRoot.appendChild(owner);
            const attempt = beginTranslation(owner, "bilingual")!;
            Object.defineProperty(attempt.state, "spinner", {
                configurable: true,
                get: () => {
                    unrelatedStateReads += 1;
                    return undefined;
                },
            });
            unrelatedAttempts.push({owner, state: attempt.state});
        }

        try {
            removed.remove();
            expect(getTranslationOwnersForRemovedNode(removed)).toEqual([target]);
            expect(unrelatedStateReads).toBe(0);
        } finally {
            discardTranslation(target, targetAttempt.state);
            unrelatedAttempts.forEach(({owner, state}) => discardTranslation(owner, state));
        }
    });

    it("状态与 artifact 刷新复用 owner 索引桶，仍同步移除旧 artifact", () => {
        const {document} = parseHTML('<html><body><p>Readable source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const source = owner.firstChild;
        // 观察实际反向索引桶的创建，避免用受 JIT/机器影响的耗时阈值。
        const writes = vi.spyOn(WeakMap.prototype, 'set');
        const ownerBucketWrites = () => writes.mock.calls.filter(([key, value]) =>
            key === owner && value instanceof Set &&
            [...value].some(member => member instanceof WeakRef));
        try {
            const attempt = beginTranslation(owner, 'bilingual')!;
            expect(ownerBucketWrites()).toHaveLength(1);
            writes.mockClear();
            expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
            const first = document.createElement('span');
            const second = document.createElement('span');
            owner.append(first);
            setSpinner(owner, first);
            expect(getTranslationOwnersForIndexedNode(first)).toEqual([owner]);
            first.remove();
            owner.append(second);
            setSpinner(owner, second);
            expect(getTranslationOwnersForIndexedNode(first)).toEqual([]);
            expect(getTranslationOwnersForIndexedNode(second)).toEqual([owner]);
            expect(getTranslationOwnersForIndexedNode(owner)).toEqual([owner]);
            expect(ownerBucketWrites()).toHaveLength(0);
            expect(owner.firstChild).toBe(source);
            expect(source?.textContent).toBe('Readable source.');
        } finally {
            writes.mockRestore();
            restoreTranslation(owner);
        }
        expect(getTranslationOwnersForIndexedNode(owner)).toEqual([]);
    });

    it("同一 artifact 同时属于 spinner 和 retry 时，完成阶段只移除失去全部用途的索引", () => {
        const {document} = parseHTML('<html><body><p>Readable source.</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const source = owner.firstChild;
        const attempt = beginTranslation(owner, 'bilingual')!;
        const sharedArtifact = document.createElement('span');
        try {
            setSpinner(owner, sharedArtifact);
            setRetryWrapper(owner, sharedArtifact);
            expect(getTranslationOwnersForIndexedNode(sharedArtifact)).toEqual([owner]);
            expect(markTranslationError(owner, attempt.state, attempt.generation)).toBe(true);
            expect(attempt.state.spinner).toBeUndefined();
            expect(getTranslationOwnersForIndexedNode(sharedArtifact)).toEqual([owner]);
            expect(detachFailedTranslationUi(owner, attempt.state)).toBe(true);
            expect(getTranslationOwnersForIndexedNode(sharedArtifact)).toEqual([]);
            for (let index = 0; index < 4; index += 1) {
                const replacement = document.createElement('span');
                setRetryWrapper(owner, replacement);
                expect(getTranslationOwnersForIndexedNode(replacement)).toEqual([owner]);
                expect(getTranslationOwnersForIndexedNode(sharedArtifact)).toEqual([]);
                expect(detachFailedTranslationUi(owner, attempt.state)).toBe(true);
                expect(getTranslationOwnersForIndexedNode(replacement)).toEqual([]);
            }
            expect(owner.firstChild).toBe(source);
            expect(owner.textContent).toBe('Readable source.');
        } finally {
            discardTranslation(owner, attempt.state);
        }
        expect(getTranslationOwnersForIndexedNode(owner)).toEqual([]);
    });

    it("共享桶在 artifact 和 complete 阶段仍重排，过期代次不改变枚举顺序", () => {
        const {document} = parseHTML('<html><body><main><p id="a">First source.</p><p id="b">Second source.</p><p id="c">Third source.</p></main></body></html>');
        const root = document.querySelector<HTMLElement>('main')!;
        const owners = Array.from(root.querySelectorAll<HTMLElement>('p'));
        const attempts = owners.map(owner => beginTranslation(owner, 'bilingual')!);
        const [first, second, third] = owners;
        const firstSource = first.firstChild;
        const spinner = document.createElement('span');
        try {
            owners.forEach(owner => expect(acquireTranslationLayoutOverride(owner, root, [])).toBe(true));
            expect(getTranslationOwnersForIndexedNode(root)).toEqual([first, second, third]);
            setSpinner(first, spinner);
            expect(getTranslationOwnersForIndexedNode(root)).toEqual([second, third, first]);
            expect(markTranslationComplete(second, attempts[1].state, attempts[1].generation + 1)).toBe(false);
            expect(getTranslationOwnersForIndexedNode(root)).toEqual([second, third, first]);
            expect(markTranslationComplete(second, attempts[1].state, attempts[1].generation)).toBe(true);
            expect(getTranslationOwnersForIndexedNode(root)).toEqual([third, first, second]);
            expect(markTranslationComplete(first, attempts[0].state, attempts[0].generation)).toBe(true);
            expect(getTranslationOwnersForIndexedNode(spinner)).toEqual([]);
            expect(getTranslationOwnersForIndexedNode(root)).toEqual([third, second, first]);
            const wrapper = document.createElement('span');
            second.append(wrapper);
            setBilingualContent(second, wrapper);
            expect(getTranslationOwnersForIndexedNode(root)).toEqual([third, first, second]);
            expect(getTranslationOwnersForIndexedNode(wrapper)).toEqual([second]);
            expect(discardTranslation(first, attempts[0].state)).toBe(true);
            expect(getTranslationOwnersForIndexedNode(root)).toEqual([third, second]);
            expect(first.firstChild).toBe(firstSource);
            expect(first.textContent).toBe('First source.');
        } finally {
            owners.forEach((owner, index) => discardTranslation(owner, attempts[index].state));
        }
        expect(getTranslationOwnersForIndexedNode(root)).toEqual([]);
    });

    it("共享祖先刷新保持 owner 枚举顺序，移走 owner 后仅删除过期关联", () => {
        const {document} = parseHTML('<html><body><main id="old"><p id="a">First source.</p><p id="b">Second source.</p></main><main id="new"></main></body></html>');
        const oldRoot = document.querySelector<HTMLElement>('#old')!;
        const newRoot = document.querySelector<HTMLElement>('#new')!;
        const first = document.querySelector<HTMLElement>('#a')!;
        const second = document.querySelector<HTMLElement>('#b')!;
        const firstText = first.firstChild;
        try {
            for (const owner of [first, second]) {
                const attempt = beginTranslation(owner, 'bilingual')!;
                expect(markTranslationComplete(owner, attempt.state, attempt.generation)).toBe(true);
                expect(ensureTranslationTruncationLayout(owner)).toBe(true);
            }
            expect(getTranslationOwnersForIndexedNode(oldRoot)).toEqual([first, second]);
            expect(ensureTranslationTruncationLayout(first)).toBe(true);
            expect(getTranslationOwnersForIndexedNode(oldRoot)).toEqual([second, first]);
            newRoot.append(first);
            expect(ensureTranslationTruncationLayout(first)).toBe(true);
            expect(getTranslationOwnersForIndexedNode(oldRoot)).toEqual([second]);
            expect(getTranslationOwnersForIndexedNode(newRoot)).toEqual([first]);
            expect(first.firstChild).toBe(firstText);
            expect(first.textContent).toBe('First source.');
            expect(restoreTranslation(first)).toBe(true);
            expect(getTranslationOwnersForIndexedNode(newRoot)).toEqual([]);
            expect(getTranslationOwnersForIndexedNode(oldRoot)).toEqual([second]);
        } finally {
            restoreTranslation(first);
            restoreTranslation(second);
        }
        expect(getTranslationOwnersForIndexedNode(oldRoot)).toEqual([]);
    });

    it("discard 后 owner 和已脱离的 artifact 都不再命中索引", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector("#target") as HTMLElement;
        const attempt = beginTranslation(target, "bilingual")!;
        const wrapper = document.createElement("span");
        target.appendChild(wrapper);
        setBilingualContent(target, wrapper);
        wrapper.remove();

        expect(discardTranslation(target, attempt.state)).toBe(true);
        expect(getTranslationOwnersForRemovedNode(target)).toEqual([]);
        expect(getTranslationOwnersForRemovedNode(wrapper)).toEqual([]);
    });

    it("替换 spinner 时 ownership 索引只保留当前 artifact", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector("#target") as HTMLElement;
        const attempt = beginTranslation(target, "bilingual")!;
        const firstSpinner = document.createElement("span");
        const secondSpinner = document.createElement("span");
        target.appendChild(firstSpinner);
        setSpinner(target, firstSpinner);

        firstSpinner.remove();
        target.appendChild(secondSpinner);
        setSpinner(target, secondSpinner);

        expect(getTranslationOwnersForRemovedNode(firstSpinner)).toEqual([]);
        expect(getTranslationOwnersForRemovedNode(secondSpinner)).toEqual([target]);
        expect(discardTranslation(target, attempt.state)).toBe(true);
        expect(getTranslationOwnersForRemovedNode(secondSpinner)).toEqual([]);
    });

    it("请求完成并清除 spinner 后同步移除 artifact ownership", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector("#target") as HTMLElement;
        const attempt = beginTranslation(target, "bilingual")!;
        const spinner = document.createElement("span");
        target.appendChild(spinner);
        setSpinner(target, spinner);
        spinner.remove();

        expect(markTranslationComplete(target, attempt.state, attempt.generation)).toBe(true);
        expect(getTranslationOwnersForRemovedNode(spinner)).toEqual([]);
        expect(restoreTranslation(target)).toBe(true);
    });

    it("新一代 begin 会移除旧 artifact 的 ownership", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector("#target") as HTMLElement;
        const first = beginTranslation(target, "bilingual")!;
        const oldWrapper = document.createElement("span");
        target.appendChild(oldWrapper);
        setBilingualContent(target, oldWrapper);
        first.state.phase = "error";

        const second = beginTranslation(target, "bilingual")!;

        expect(getTranslationOwnersForRemovedNode(oldWrapper)).toEqual([]);
        expect(getTranslationOwnersForRemovedNode(target)).toEqual([target]);
        expect(discardTranslation(target, second.state)).toBe(true);
    });

    it("synthetic segment restore 解包后不会残留 ownership", () => {
        const {document} = parseHTML(`
            <html><body><p id="parent">Before <span id="synthetic">inline segment</span> after.</p></body></html>
        `);
        const parent = document.querySelector("#parent") as HTMLElement;
        const synthetic = document.querySelector("#synthetic") as HTMLElement;
        const attempt = beginTranslation(synthetic, "bilingual", "content", true);
        expect(attempt).not.toBeNull();
        expect(getTranslationOwnersForRemovedNode(synthetic)).toEqual([synthetic]);

        expect(restoreTranslation(synthetic)).toBe(true);

        expect(parent.querySelector("#synthetic")).toBeNull();
        expect(parent.textContent).toContain("inline segment");
        expect(getTranslationOwnersForRemovedNode(synthetic)).toEqual([]);
    });

    it("未注册节点的 artifact setter 和失败 UI detach 都安全降级", () => {
        const {document} = parseHTML('<html><body><p id="target">Readable paragraph.</p></body></html>');
        const target = document.querySelector("#target") as HTMLElement;
        const artifact = document.createElement("span");
        const attempt = beginTranslation(target, "bilingual")!;

        expect(restoreTranslation(artifact as HTMLElement)).toBe(false);
        expect(discardTranslation(artifact as HTMLElement, attempt.state)).toBe(false);
        expect(detachFailedTranslationUi(target, attempt.state)).toBe(false);
        setSpinner(artifact as HTMLElement, artifact);
        setBilingualContent(artifact as HTMLElement, artifact);
        setRetryWrapper(artifact as HTMLElement, artifact);
        setRenderedStyleAttribute(artifact as HTMLElement);
        setTextSlotsApplied(artifact as HTMLElement);

        expect(getTranslationState(artifact as HTMLElement)).toBeUndefined();
        expect(discardTranslation(target, attempt.state)).toBe(true);
    });

    it("begin 对空 textContent 和空 Text.nodeValue 使用空字符串快照", () => {
        const node = new FakeElement();
        const textNode = {nodeValue: null};
        node.textContent = null as unknown as string;
        node.ownerDocument = {
            createTreeWalker: () => {
                let returned = false;
                return {
                    nextNode: () => {
                        if (returned) return null;
                        returned = true;
                        return textNode;
                    },
                };
            },
        } as unknown as Document;

        const attempt = beginTranslation(node as unknown as HTMLElement, "single")!;

        expect(attempt.state.sourceText).toBe("");
        expect(attempt.state.originalTextValues).toEqual([{node: textNode, value: ""}]);
        expect(discardTranslation(node as unknown as HTMLElement, attempt.state)).toBe(true);
    });

    it("text-slot 默认记录所有原始文本节点，restoreAllTranslations 可统一清理活跃状态", () => {
        const {document} = parseHTML(`
            <html><body>
                <p id="first">Open <a href="/guide">the guide</a>.</p>
                <p id="second">Another paragraph.</p>
            </body></html>
        `);
        const first = document.querySelector("#first") as HTMLElement;
        const second = document.querySelector("#second") as HTMLElement;
        const firstAttempt = beginTranslation(first, "single")!;
        beginTranslation(second, "bilingual");
        const originalTextNodes = firstAttempt.state.originalTextValues.map(({node: textNode}) => textNode);

        originalTextNodes.forEach((textNode, index) => {
            textNode.nodeValue = `译文 ${index}`;
        });
        setTextSlotsApplied(first);

        expect(firstAttempt.state.translatedTextNodes).toEqual(originalTextNodes);
        expect(firstAttempt.state.translatedTextValues?.get(originalTextNodes[0]!)).toBe("译文 0");

        restoreAllTranslations();

        expect(getTranslationState(first)).toBeUndefined();
        expect(getTranslationState(second)).toBeUndefined();
        expect(first.textContent).toBe("Open the guide.");
    });

    it("恢复时移除插件 class 且不留下空 class 属性", () => {
        const target = new FakeElement();
        target.classList = {
            remove: vi.fn(() => target.setAttribute("class", "")),
        };
        beginTranslation(target as unknown as HTMLElement, "bilingual");
        target.setAttribute("class", "fluent-read-bilingual");
        setRenderedStyleAttribute(target as unknown as HTMLElement);
        target.setAttribute("class", "fluent-read-bilingual fluent-read-failure");

        expect(restoreTranslation(target as unknown as HTMLElement)).toBe(true);
        expect(target.getAttribute("class")).toBeNull();
    });
});

describe('state 观察根迁移、宿主边界与 overflow 交接', () => {
    async function flushObservers() {
        await Promise.resolve(); await Promise.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await Promise.resolve();
    }

    function commit(owner: HTMLElement) {
        const attempt = beginTranslation(owner, 'bilingual')!;
        const wrapper = owner.ownerDocument.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文';
        owner.append(wrapper); setBilingualContent(owner, wrapper);
        expect(markTranslationComplete(owner, attempt.state, attempt.generation, false)).toBe(true);
        expect(ensureTranslationTruncationLayout(owner)).toBe(true);
        return {attempt, wrapper};
    }

    it.each(['document-shadow', 'shadow-document', 'shadow-shadow'] as const)(
        '%s 迁移后新根继续观察来源，旧祖先租约释放且恢复不覆盖宿主写入', async (direction) => {
            const {document, window} = parseHTML('<html><body><article style="height:24px"><p>Source</p></article><div id="a"></div><div id="b"></div></body></html>');
            const oldAncestor = document.querySelector<HTMLElement>('article')!;
            const owner = document.querySelector<HTMLElement>('p')!;
            const source = owner.firstChild as Text;
            const firstRoot = document.querySelector('#a')!.attachShadow({mode: 'open'});
            const secondRoot = document.querySelector('#b')!.attachShadow({mode: 'open'});
            if (direction !== 'document-shadow') firstRoot.append(oldAncestor);
            const destination = document.createElement('section');
            if (direction === 'shadow-document') document.body.append(destination);
            else secondRoot.append(destination);
            const observe = vi.spyOn(window.MutationObserver.prototype, 'observe');
            const disconnect = vi.spyOn(window.MutationObserver.prototype, 'disconnect');
            try {
                const {attempt, wrapper} = commit(owner);
                acquireTranslationLayoutOverride(owner, oldAncestor, [{property: 'height', value: 'auto', priority: 'important'}]);
                await flushObservers();
                destination.append(owner);
                await flushObservers();
                expect(getTranslationState(owner)).toBe(attempt.state);
                expect(wrapper.parentNode).toBe(owner);
                expect(oldAncestor.style.height).toBe('24px');
                expect(getTranslationOwnersForIndexedNode(oldAncestor)).not.toContain(owner);
                // linkedom 把 Text 写入报告为根 childList；使用真实 title 属性通知确认新根观察。
                source.data = 'Host changed source';
                owner.setAttribute('title', 'host changed title');
                destination.setAttribute('style', 'color:blue');
                await flushObservers();
                expect(getTranslationState(owner)).toBeUndefined();
                expect(attempt.state.controller.signal.aborted).toBe(true);
                expect(wrapper.parentNode).toBeNull();
                expect(owner.firstChild).toBe(source);
                expect(owner.textContent).toBe('Host changed source');
                expect(destination.style.color).toBe('blue');
                expect(observe).toHaveBeenCalledTimes(direction === 'shadow-shadow' ? 3 : 2);
                expect(disconnect).toHaveBeenCalledTimes(observe.mock.calls.length);
            } finally {
                restoreTranslation(owner); observe.mockRestore(); disconnect.mockRestore();
            }
        },
    );

    it.each(['scroll', 'position'] as const)(
        '共享 height 租约变为 %s 边界时保留宿主新高度与剩余截断租约', async (boundary) => {
            const {document, window} = parseHTML('<html><body><article style="height:24px;-webkit-line-clamp:2"><p>First source</p><p>Second source</p></article></body></html>');
            const ancestor = document.querySelector<HTMLElement>('article')!;
            const owners = Array.from(document.querySelectorAll<HTMLElement>('p'));
            const descriptor = Object.getOwnPropertyDescriptor(document, 'defaultView');
            // 只替代 linkedom 缺失的布局样式读数，值随宿主 style 实时变化。
            Object.defineProperty(document, 'defaultView', {configurable: true, value: {
                HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver,
                addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
                getComputedStyle: (element: HTMLElement) => ({
                    height: element.style.height || 'auto', display: 'block',
                    position: element.style.position || 'static', transform: 'none',
                    overflowY: element.style.overflow || 'visible',
                    webkitLineClamp: element.style.getPropertyValue('-webkit-line-clamp') || 'none',
                    getPropertyValue: (property: string) => element.style.getPropertyValue(property),
                }),
            }});
            try {
                owners.forEach(commit);
                await flushObservers();
                expect(ancestor.style.height).toBe('auto');
                // 同批重新引入 clamp，检验撤销 height 后追加截断属性是否又误接管高度。
                ancestor.setAttribute('style', `height:72px;color:green;-webkit-line-clamp:3;${boundary === 'scroll' ? 'overflow:auto' : 'position:fixed'}`);
                await flushObservers();
                expect(ancestor.style.height).toBe('72px');
                expect(ancestor.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
                restoreTranslation(owners[0]);
                expect(getTranslationState(owners[1])?.phase).toBe('translated');
                expect(ancestor.style.height).toBe('72px');
                expect(ancestor.style.getPropertyValue('-webkit-line-clamp')).toBe('unset');
                restoreTranslation(owners[1]);
                expect(ancestor.style.getPropertyValue('-webkit-line-clamp')).toBe('3');
                expect(ancestor.style.height).toBe('72px');
                expect(ancestor.style.color).toBe('green');
                expect(ancestor.style.overflow || ancestor.style.position).toBe(boundary === 'scroll' ? 'auto' : 'fixed');
                expect(owners.map((owner) => owner.textContent)).toEqual(['First source', 'Second source']);
            } finally {
                owners.forEach((owner) => restoreTranslation(owner));
                if (descriptor) Object.defineProperty(document, 'defaultView', descriptor);
                else Reflect.deleteProperty(document, 'defaultView');
            }
        },
    );

    it.each(['decoration', 'source'] as const)(
        '超出祖先快速查找深度的 overflow %s mutation 仍按来源语义收敛', async (change) => {
            const {document} = parseHTML('<html><body><p></p></body></html>');
            const owner = document.querySelector<HTMLElement>('p')!;
            let deepest = owner;
            for (let depth = 0; depth < 540; depth += 1) {
                const child = document.createElement('span'); deepest.append(child); deepest = child;
            }
            deepest.textContent = 'Deep source';
            const source = deepest.firstChild as Text;
            const {attempt, wrapper} = commit(owner);
            try {
                expect(isTranslationSourceStructureOverflow(attempt.state.sourceStructureSignature)).toBe(true);
                await flushObservers();
                if (change === 'decoration') deepest.setAttribute('class', 'host-hover');
                else {
                    source.data = 'Host deep update';
                    deepest.setAttribute('title', 'host source title');
                }
                await flushObservers();
                if (change === 'decoration') {
                    expect(getTranslationState(owner)).toBe(attempt.state);
                    expect(wrapper.parentNode).toBe(owner);
                    expect(attempt.state.controller.signal.aborted).toBe(false);
                } else {
                    expect(getTranslationState(owner)).toBeUndefined();
                    expect(wrapper.parentNode).toBeNull();
                    expect(attempt.state.controller.signal.aborted).toBe(true);
                }
                expect(deepest.firstChild).toBe(source);
                expect(source.data).toBe(change === 'decoration' ? 'Deep source' : 'Host deep update');
                restoreTranslation(owner);
                expect(deepest.getAttribute(change === 'decoration' ? 'class' : 'title'))
                    .toBe(change === 'decoration' ? 'host-hover' : 'host source title');
            } finally { restoreTranslation(owner); }
        },
    );

    it('外部 manager 接管期间不重复处理 overflow，交还后的来源事件恢复且保留宿主 Text', async () => {
        const {document} = parseHTML('<html><body><p></p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        owner.textContent = 'Readable source. '.repeat(9000);
        const source = owner.firstChild as Text;
        const {attempt, wrapper} = commit(owner);
        let externallyManaged = true;
        setBilingualLifecycleExternalManager(() => externallyManaged);
        try {
            expect(isTranslationSourceStructureOverflow(attempt.state.sourceStructureSignature)).toBe(true);
            source.data += 'Host update';
            owner.setAttribute('title', 'host source title while externally managed');
            await flushObservers();
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(wrapper.parentNode).toBe(owner);
            expect(attempt.state.controller.signal.aborted).toBe(false);
            externallyManaged = false;
            source.data += ' after handoff';
            owner.setAttribute('title', 'host source title after handoff');
            await flushObservers();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(wrapper.parentNode).toBeNull();
            expect(attempt.state.controller.signal.aborted).toBe(true);
            expect(owner.firstChild).toBe(source);
            expect(source.data.endsWith('Host update after handoff')).toBe(true);
        } finally { setBilingualLifecycleExternalManager(undefined); restoreTranslation(owner); }
    });
});

describe("synthetic 双语工件的真实 observer 生命周期", () => {
    it('批量恢复共享祖先的段落时以线性引用访问释放索引和观察器', () => {
        const {document} = parseHTML('<html><body><article></article></body></html>');
        const article = document.querySelector('article')!;
        const owners: HTMLElement[] = [];
        for (let index = 0; index < 120; index += 1) {
            const owner = document.createElement('p');
            owner.textContent = `Source paragraph ${index}.`;
            article.append(owner); owners.push(owner);
            const attempt = beginTranslation(owner, 'bilingual')!;
            markTranslationComplete(owner, attempt.state, attempt.generation);
            const wrapper = document.createElement('span');
            wrapper.className = 'fluent-read-bilingual-content';
            wrapper.setAttribute('data-fr-translation-owned', 'true');
            wrapper.textContent = '译文'; owner.append(wrapper);
            setBilingualContent(owner, wrapper);
            expect(ensureTranslationTruncationLayout(owner)).toBe(true);
            acquireTranslationLayoutOverride(owner, article, [{property: 'height', value: 'auto', priority: 'important'}]);
        }
        const deref = vi.spyOn(WeakRef.prototype, 'deref');
        try {
            owners.forEach(owner => restoreTranslation(owner));
            expect(deref.mock.calls.length).toBeLessThan(owners.length * 20);
        } finally { deref.mockRestore(); }
        expect(article.querySelector('.fluent-read-bilingual-content')).toBeNull();
        owners.forEach((owner, index) => {
            expect(getTranslationState(owner)).toBeUndefined();
            expect(owner.textContent).toBe(`Source paragraph ${index}.`);
        });
    });

    function committedSyntheticSegment() {
        const {document} = parseHTML(`
            <html><body><div id="host"><span id="segment" data-fr-translation-segment="true">Inline source.</span></div></body></html>
        `);
        const segment = document.querySelector<HTMLElement>("#segment")!;
        const source = segment.firstChild as Text;
        const attempt = beginTranslation(
            segment,
            "bilingual",
            "content",
            true,
            "Inline source.",
            [source],
        )!;
        expect(markTranslationComplete(segment, attempt.state, attempt.generation)).toBe(true);
        const wrapper = document.createElement("span");
        wrapper.className = "fluent-read-bilingual-content";
        wrapper.setAttribute("data-fr-translation-owned", "true");
        wrapper.setAttribute("translate", "no");
        wrapper.textContent = "行内译文。";
        segment.appendChild(wrapper);
        setBilingualContent(segment, wrapper);
        expect(ensureTranslationTruncationLayout(segment)).toBe(true);
        return {document, segment, attempt, wrapper};
    }

    it("首次提交后的宿主 class mutation 不会让当前 synthetic generation 在 observer flush 中自清", async () => {
        const {segment, attempt, wrapper} = committedSyntheticSegment();

        segment.classList.add("host-hover-state");
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(getTranslationState(segment)).toBe(attempt.state);
        expect(attempt.state.controller.signal.aborted).toBe(false);
        expect(segment.isConnected).toBe(true);
        expect(segment.querySelector(".fluent-read-bilingual-content")).toBe(wrapper);
        restoreTranslation(segment);
    });

    it("同一 synthetic owner 等价 replaceChildren 后在 observer 检查点重挂可信译文", async () => {
        const {document, segment, attempt, wrapper} = committedSyntheticSegment();
        const replacementSource = document.createTextNode("Inline source.");

        segment.replaceChildren(replacementSource);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(getTranslationState(segment)).toBe(attempt.state);
        expect(attempt.state.controller.signal.aborted).toBe(false);
        expect(wrapper.parentNode).toBe(segment);
        expect(segment.querySelectorAll(".fluent-read-bilingual-content")).toHaveLength(1);
        restoreTranslation(segment);
    });
});


describe('tooltip 翻译生命周期命中保护', () => {
    it.each([
        ['普通正文', '<p id="target">Ordinary English paragraph.</p>', false],
        ['tooltip 内层', '<div class="tooltip"><div class="tooltip-inner" id="target">Support monthly</div></div>', true],
        ['包含 tooltip 的控件', '<button id="target"><div class="tooltip"><div class="tooltip-inner">Support monthly</div></div></button>', true],
        ['ARIA tooltip', '<div role="tooltip" id="target">Support monthly</div>', true],
        ['没有直接内层的同名类', '<div class="tooltip" id="target"><span><span class="tooltip-inner">Other content</span></span></div>', false],
    ])('旧版 WebView 不支持 :has 时仍可翻译%s', (_label, markup, isTooltip) => {
        const {document} = parseHTML(`<html><body>${markup}</body></html>`);
        const node = document.querySelector('#target') as HTMLElement;
        const originalClosest = node.closest.bind(node);
        const originalQuerySelector = node.querySelector.bind(node);
        const originalQuerySelectorAll = node.querySelectorAll.bind(node);
        const rejectHas = (selector: string) => {
            if (selector.includes(':has(')) throw new SyntaxError('Unsupported selector :has');
        };
        const closest = vi.spyOn(node, 'closest').mockImplementation((selector) => {
            rejectHas(selector);
            return originalClosest(selector);
        });
        const querySelector = vi.spyOn(node, 'querySelector').mockImplementation((selector) => {
            rejectHas(selector);
            return originalQuerySelector(selector);
        });
        const querySelectorAll = vi.spyOn(node, 'querySelectorAll').mockImplementation((selector) => {
            rejectHas(selector);
            return originalQuerySelectorAll(selector);
        });

        try {
            const attempt = beginTranslation(node, 'bilingual', 'content');
            expect(attempt).not.toBeNull();
            expect(node.hasAttribute('data-fr-tooltip-translation-active')).toBe(isTooltip);
            restoreTranslation(node);
        } finally {
            closest.mockRestore();
            querySelector.mockRestore();
            querySelectorAll.mockRestore();
        }
    });

    it.each(['inside', 'self', 'ancestor'])('覆盖 %s 的直接控件翻译并在取消后清理', (placement) => {
        const {document} = parseHTML('<html><body><div role="button" id="control"><div class="tooltip"><div class="tooltip-inner">Support ThinkStu monthly</div></div></div></body></html>');
        const node = document.querySelector(placement === 'inside' ? '.tooltip-inner' : placement === 'self' ? '.tooltip' : '#control') as HTMLElement;
        const attempt = beginTranslation(node, 'bilingual', 'control')!;
        expect(node.getAttribute('data-fr-tooltip-translation-active')).toBe('true');
        expect(beginTranslation(node, 'bilingual', 'control')).toBeNull();
        markTranslationComplete(node, attempt.state, attempt.generation, false);
        expect(node.getAttribute('data-fr-tooltip-translation-active')).toBe('true');
        restoreTranslation(node);
        expect(node.hasAttribute('data-fr-tooltip-translation-active')).toBe(false);
        const retry = beginTranslation(node, 'bilingual', 'control')!;
        discardTranslation(node, retry.state);
        expect(node.hasAttribute('data-fr-tooltip-translation-active')).toBe(false);
    });

    it('重试继承原属性快照，且不回滚宿主后续写入', () => {
        const {document} = parseHTML('<html><body><div role="tooltip" data-fr-tooltip-translation-active="host">Support monthly</div></body></html>');
        const node = document.querySelector('[role="tooltip"]') as HTMLElement;
        const first = beginTranslation(node, 'single', 'control')!;
        markTranslationError(node, first.state, first.generation, false);
        const retry = beginTranslation(node, 'single', 'control')!;
        discardTranslation(node, retry.state);
        expect(node.getAttribute('data-fr-tooltip-translation-active')).toBe('host');
        beginTranslation(node, 'single', 'control');
        node.setAttribute('data-fr-tooltip-translation-active', 'new-host-value');
        restoreTranslation(node);
        expect(node.getAttribute('data-fr-tooltip-translation-active')).toBe('new-host-value');
    });

    it('普通正文不增加 tooltip 状态属性', () => {
        const {document} = parseHTML('<html><body><p>Ordinary content</p></body></html>');
        const node = document.querySelector('p') as HTMLElement;
        beginTranslation(node, 'bilingual');
        expect(node.hasAttribute('data-fr-tooltip-translation-active')).toBe(false);
        restoreTranslation(node);
    });
});


it('tooltip 的插入、内容变化和移除不使外层按钮来源失效', () => {
    const {document} = parseHTML('<html><body><button>Monthly</button></body></html>');
    const node = document.querySelector('button') as HTMLElement;
    const before = getTranslationSourceStructureSignature(node);
    const tooltip = document.createElement('div');
    tooltip.setAttribute('role', 'tooltip');
    tooltip.textContent = 'Support ThinkStu monthly';
    node.appendChild(tooltip);
    expect(getTranslationSourceStructureSignature(node)).toBe(before);
    tooltip.textContent = '支持 ThinkStu';
    expect(getTranslationSourceStructureSignature(node)).toBe(before);
    tooltip.remove();
    expect(getTranslationSourceStructureSignature(node)).toBe(before);
});


// 公共入口的故障能力与弱引用清理契约；WeakRef 桩只模拟 deref 失效，不证明真实 GC。
describe('state 公共入口的降级与资源恢复边界', () => {
    it.each([null, 'host-tooltip'])('失败 UI 分离恢复 tooltip 原属性 %s，并保留 error tombstone', (original) => {
        const {document} = parseHTML('<html><body><div role="tooltip">Support monthly</div></body></html>');
        const owner = document.querySelector<HTMLElement>('[role="tooltip"]')!;
        if (original !== null) owner.setAttribute('data-fr-tooltip-translation-active', original);
        const attempt = beginTranslation(owner, 'bilingual', 'control')!;
        const retry = document.createElement('span');
        owner.append(retry);
        setRetryWrapper(owner, retry);
        try {
            expect(markTranslationError(owner, attempt.state, attempt.generation, false)).toBe(true);
            expect(detachFailedTranslationUi(owner, attempt.state)).toBe(true);
            expect(owner.getAttribute('data-fr-tooltip-translation-active')).toBe(original);
            expect(retry.parentNode).toBeNull();
            expect(getTranslationOwnersForIndexedNode(retry)).toEqual([]);
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(attempt.state.phase).toBe('error');
            expect(detachFailedTranslationUi(owner, attempt.state)).toBe(true);
            expect(owner.getAttribute('data-fr-tooltip-translation-active')).toBe(original);
        } finally { restoreTranslation(owner); }
    });

    it('失败 tooltip UI 分离保留宿主后来写入的属性', () => {
        const {document} = parseHTML('<html><body><p role="tooltip">Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(owner, 'bilingual', 'control')!;
        try {
            markTranslationError(owner, attempt.state, attempt.generation, false);
            owner.setAttribute('data-fr-tooltip-translation-active', 'host-new');
            expect(detachFailedTranslationUi(owner, attempt.state)).toBe(true);
            expect(owner.getAttribute('data-fr-tooltip-translation-active')).toBe('host-new');
        } finally { restoreTranslation(owner); }
        expect(owner.getAttribute('data-fr-tooltip-translation-active')).toBe('host-new');
    });

    it('索引读取清理模拟已回收 owner 的死引用，同时保留共享 artifact 的活 owner', () => {
        const {document} = parseHTML('<html><body><p id="dead">First source</p><p id="live">Second source</p><span></span></body></html>');
        const dead = document.querySelector<HTMLElement>('#dead')!;
        const live = document.querySelector<HTMLElement>('#live')!;
        const artifact = document.querySelector<HTMLElement>('span')!;
        beginTranslation(dead, 'bilingual'); beginTranslation(live, 'bilingual');
        setSpinner(dead, artifact); setSpinner(live, artifact);
        const nativeDeref = WeakRef.prototype.deref;
        const deref = vi.spyOn(WeakRef.prototype, 'deref').mockImplementation(function (this: WeakRef<object>) {
            const value = nativeDeref.call(this);
            return value === dead ? undefined : value;
        });
        try {
            expect(getTranslationOwnersForIndexedNode(dead)).toEqual([]);
            expect(getTranslationOwnersForIndexedNode(artifact)).toEqual([live]);
            // 恢复能力后再次读取，已清掉的死引用不会重新出现在索引中。
            deref.mockRestore();
            expect(getTranslationOwnersForIndexedNode(dead)).toEqual([]);
            expect(getTranslationOwnersForIndexedNode(artifact)).toEqual([live]);
        } finally {
            deref.mockRestore(); restoreTranslation(dead); restoreTranslation(live);
        }
    });

    it('区域盘点清理模拟死 WeakRef，全局恢复仍能中止其余活请求', () => {
        const {document} = parseHTML('<html><body><article><p id="dead">First</p><p id="live">Second</p></article></body></html>');
        const dead = document.querySelector<HTMLElement>('#dead')!;
        const live = document.querySelector<HTMLElement>('#live')!;
        beginTranslation(dead, 'bilingual');
        const attempt = beginTranslation(live, 'bilingual')!;
        const nativeDeref = WeakRef.prototype.deref;
        const deref = vi.spyOn(WeakRef.prototype, 'deref').mockImplementation(function (this: WeakRef<object>) {
            const value = nativeDeref.call(this);
            return value === dead ? undefined : value;
        });
        try {
            expect(getTranslationOwnersWithin(document.querySelector('article')!)).toEqual([live]);
            deref.mockRestore();
            expect(getTranslationOwnersWithin(document.querySelector('article')!)).toEqual([live]);
            restoreAllTranslations();
            expect(attempt.state.controller.signal.aborted).toBe(true);
            expect(getTranslationState(live)).toBeUndefined();
        } finally {
            deref.mockRestore(); restoreTranslation(dead); restoreTranslation(live);
        }
    });

    it('共享布局查询释放模拟已回收的最后租户，精确恢复宿主样式', async () => {
        const {hasTranslationLayoutOverride} = await import('@/src/features/full-page-translation/content/state');
        const {document} = parseHTML('<html><body><article style="height:24px"><p>Source</p></article></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const ancestor = document.querySelector<HTMLElement>('article')!;
        const originalStyle = ancestor.getAttribute('style');
        beginTranslation(owner, 'bilingual');
        expect(acquireTranslationLayoutOverride(owner, ancestor, [{property: 'height', value: 'auto', priority: 'important'}])).toBe(true);
        expect(hasTranslationLayoutOverride(ancestor)).toBe(true);
        const nativeDeref = WeakRef.prototype.deref;
        const deref = vi.spyOn(WeakRef.prototype, 'deref').mockImplementation(function (this: WeakRef<object>) {
            const value = nativeDeref.call(this);
            return value === owner ? undefined : value;
        });
        try {
            expect(hasTranslationLayoutOverride(ancestor)).toBe(false);
            expect(ancestor.getAttribute('style')).toBe(originalStyle);
            deref.mockRestore();
            expect(hasTranslationLayoutOverride(ancestor)).toBe(false);
        } finally { deref.mockRestore(); restoreTranslation(owner); }
    });

    it('恢复活租户时清理观察器及共享布局中的模拟死租户', () => {
        const {document, window} = parseHTML('<html><body><article style="height:24px"><p id="dead">First</p><p id="live">Second</p></article></body></html>');
        const dead = document.querySelector<HTMLElement>('#dead')!;
        const live = document.querySelector<HTMLElement>('#live')!;
        const ancestor = document.querySelector<HTMLElement>('article')!;
        const originalStyle = ancestor.getAttribute('style');
        const disconnect = vi.spyOn(window.MutationObserver.prototype, 'disconnect');
        beginTranslation(dead, 'bilingual'); beginTranslation(live, 'bilingual');
        ensureTranslationTruncationLayout(dead); ensureTranslationTruncationLayout(live);
        for (const owner of [dead, live]) acquireTranslationLayoutOverride(owner, ancestor, [{property: 'height', value: 'auto', priority: 'important'}]);
        const nativeDeref = WeakRef.prototype.deref;
        const deref = vi.spyOn(WeakRef.prototype, 'deref').mockImplementation(function (this: WeakRef<object>) {
            const value = nativeDeref.call(this);
            return value === dead ? undefined : value;
        });
        try {
            expect(restoreTranslation(live)).toBe(true);
            expect(ancestor.getAttribute('style')).toBe(originalStyle);
            expect(disconnect).toHaveBeenCalledTimes(1);
        } finally {
            deref.mockRestore(); restoreTranslation(dead); restoreTranslation(live);
            disconnect.mockRestore();
        }
    });

    it('MutationObserver 不可用时布局入口可降级，恢复仍释放样式租约', () => {
        const {document, window} = parseHTML('<html><body><article style="height:24px"><p>Source</p></article></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const ancestor = document.querySelector<HTMLElement>('article')!;
        const descriptor = Object.getOwnPropertyDescriptor(window, 'MutationObserver');
        const originalStyle = ancestor.getAttribute('style');
        try {
            // linkedom 的 window 代理回退至 globalThis；同时隐藏两处能力，finally 精确恢复。
            vi.stubGlobal('MutationObserver', undefined);
            Object.defineProperty(window, 'MutationObserver', {configurable: true, value: undefined});
            beginTranslation(owner, 'bilingual');
            expect(ensureTranslationTruncationLayout(owner)).toBe(true);
            expect(acquireTranslationLayoutOverride(owner, ancestor, [{property: 'height', value: 'auto', priority: 'important'}])).toBe(true);
            expect(restoreTranslation(owner)).toBe(true);
            expect(ancestor.getAttribute('style')).toBe(originalStyle);
        } finally {
            restoreTranslation(owner);
            if (descriptor) Object.defineProperty(window, 'MutationObserver', descriptor);
            else Reflect.deleteProperty(window, 'MutationObserver');
            vi.unstubAllGlobals();
        }
    });

    it('缺少 CSS priority API 时布局租约与宿主修改仍可协调恢复', async () => {
        const {reconcileTranslationLayoutOverrides} = await import('@/src/features/full-page-translation/content/state');
        const {document} = parseHTML('<html><body><p style="height:24px">Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const style = owner.style;
        const descriptor = Object.getOwnPropertyDescriptor(style, 'getPropertyPriority');
        try {
            Object.defineProperty(style, 'getPropertyPriority', {configurable: true, value: undefined});
            beginTranslation(owner, 'bilingual');
            expect(acquireTranslationLayoutOverride(owner, owner, [{property: 'height', value: 'auto', priority: 'important'}])).toBe(true);
            style.setProperty('height', '48px'); style.setProperty('color', 'red');
            expect(reconcileTranslationLayoutOverrides(owner)).toBe(true);
            expect(style.getPropertyValue('height')).toBe('auto');
            restoreTranslation(owner);
            expect(style.getPropertyValue('height')).toBe('48px');
            expect(style.getPropertyValue('color')).toBe('red');
        } finally {
            restoreTranslation(owner);
            if (descriptor) Object.defineProperty(style, 'getPropertyPriority', descriptor);
            else Reflect.deleteProperty(style, 'getPropertyPriority');
        }
    });

    it('queueMicrotask 不可用时 resize 仍用 Promise 检查点清理被宿主移走的加载工件', async () => {
        const {document, window} = parseHTML('<html><body><p>Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(owner, 'bilingual')!;
        const spinner = document.createElement('span'); owner.append(spinner); setSpinner(owner, spinner);
        try {
            ensureTranslationTruncationLayout(owner);
            spinner.remove();
            vi.stubGlobal('queueMicrotask', undefined);
            window.dispatchEvent(new window.Event('resize'));
            await Promise.resolve(); await Promise.resolve();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(attempt.state.controller.signal.aborted).toBe(true);
            expect(owner.textContent).toBe('Source');
        } finally { vi.unstubAllGlobals(); restoreTranslation(owner); }
    });

    it('来源结构签名忽略注释变化，超宽子树明确进入 overflow', () => {
        const {document} = parseHTML('<html><body><p>Readable<!--host marker--></p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const signature = getTranslationSourceStructureSignature(owner);
        owner.lastChild!.nodeValue = 'updated host marker';
        expect(getTranslationSourceStructureSignature(owner)).toBe(signature);
        for (let index = 0; index < 4200; index += 1) owner.append(document.createElement('span'));
        expect(isTranslationSourceStructureOverflow(getTranslationSourceStructureSignature(owner))).toBe(true);
    });

    it('已移走的原始 Text 在恢复时保持宿主当前位置和译值', () => {
        const {document} = parseHTML('<html><body><p>Source</p><aside></aside></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const destination = document.querySelector<HTMLElement>('aside')!;
        const source = owner.firstChild as Text;
        beginTranslation(owner, 'single');
        try {
            source.nodeValue = '译文'; setTextSlotsApplied(owner);
            destination.append(source);
            expect(restoreTranslation(owner)).toBe(true);
            expect(destination.firstChild).toBe(source);
            expect(source.nodeValue).toBe('译文');
            expect(owner.childNodes.length).toBe(0);
        } finally { restoreTranslation(owner); }
    });

    it('仅译文槽登记忽略没有来源 Text 的空槽，并恢复后安全忽略迟到写入', async () => {
        const {setLiveTranslationSourceSnapshot, setControlValueApplied} = await import('@/src/features/full-page-translation/content/state');
        const {document} = parseHTML('<html><body><p>Source<span><b>Nested</b></span><i></i></p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const empty = document.querySelector<HTMLElement>('i')!;
        const nested = document.querySelector<HTMLElement>('span')!;
        beginTranslation(owner, 'single');
        try {
            setSingleTextSlotHosts(owner, [empty, nested]);
            expect(getTranslationOwnersForIndexedNode(empty)).toEqual([]);
            expect(getTranslationOwnersForIndexedNode(nested)).toEqual([]);
            setControlValueApplied(owner, 'invalid control translation');
            expect(getTranslationState(owner)?.textSlotsApplied).toBeUndefined();
            restoreTranslation(owner);
            const html = owner.innerHTML;
            setLiveTranslationSourceSnapshot(owner, []); setSingleTextSlotHosts(owner, [empty]);
            setTextSlotsApplied(owner); setControlValueApplied(owner, 'late translation');
            expect(owner.innerHTML).toBe(html);
            expect(getTranslationState(owner)).toBeUndefined();
        } finally { restoreTranslation(owner); }
    });

    it('坐标命中已登记 synthetic owner 时保留作用域和应用外壳许可', () => {
        const {document} = parseHTML('<html><body><div><span data-fr-translation-segment="true">Source</span></div></body></html>');
        const owner = document.querySelector<HTMLElement>('span')!;
        const source = owner.firstChild as Text;
        beginTranslation(owner, 'bilingual', 'content', true, 'Source', [source], true, undefined, 'all');
        try {
            const root = {elementsFromPoint: () => [owner]} as unknown as Document;
            expect(getOwnedTranslationCandidateAtPoint(root, 3, 4)).toMatchObject({element: owner, scope: 'all', nodes: [source], allowTopLevelApplicationShell: true});
        } finally { restoreTranslation(owner); }
    });
});


// 这些回归只经过导出的状态与 DOM 入口，不访问或篡改模块私有集合。
describe('state 克隆、重挂与能力缺失的公共契约', () => {
    it('克隆展示回滚移除空 style，但过期 generation 不回滚新克隆', async () => {
        const {restoreClonedTranslationOwnerPresentation} = await import('@/src/features/full-page-translation/content/state');
        const {document} = parseHTML('<html><body><p>Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(owner, 'bilingual')!;
        try {
            acquireTranslationLayoutOverride(owner, owner, [{property: 'height', value: 'auto', priority: 'important'}]);
            const clone = owner.cloneNode(true) as HTMLElement;
            restoreClonedTranslationOwnerPresentation(owner, clone, attempt.state);
            expect(clone.hasAttribute('style')).toBe(false);
            expect(owner.style.height).toBe('auto');
            const lateClone = owner.cloneNode(true) as HTMLElement;
            restoreTranslation(owner);
            const before = lateClone.outerHTML;
            restoreClonedTranslationOwnerPresentation(owner, lateClone, attempt.state);
            expect(lateClone.outerHTML).toBe(before);
        } finally { restoreTranslation(owner); }
    });

    it('布局能力不可用时保留原样式与请求，并安全拒绝无状态 owner 的租约', async () => {
        const {reconcileTranslationLayoutOverrides} = await import('@/src/features/full-page-translation/content/state');
        const {document, window} = parseHTML('<html><body><p style="height:24px">Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const descriptor = Object.getOwnPropertyDescriptor(document, 'defaultView');
        const originalStyle = owner.getAttribute('style');
        const attempt = beginTranslation(owner, 'bilingual')!;
        try {
            Object.defineProperty(document, 'defaultView', {configurable: true, value: {
                HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver,
                addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
                getComputedStyle: undefined,
            }});
            expect(ensureTranslationTruncationLayout(owner)).toBe(true);
            expect(owner.getAttribute('style')).toBe(originalStyle);
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(attempt.state.controller.signal.aborted).toBe(false);
            restoreTranslation(owner);
            expect(acquireTranslationLayoutOverride(owner, owner, [{property: 'height', value: 'auto', priority: ''}])).toBe(false);
            expect(reconcileTranslationLayoutOverrides(owner)).toBe(false);
            expect(owner.getAttribute('style')).toBe(originalStyle);
        } finally {
            restoreTranslation(owner);
            if (descriptor) Object.defineProperty(document, 'defaultView', descriptor);
            else Reflect.deleteProperty(document, 'defaultView');
        }
    });

    it('overflow 来源身份忽略装饰样式，保留可见性语义变化', async () => {
        const {getTranslationOverflowGenerationIdentity} = await import('@/src/features/full-page-translation/content/state');
        const {document} = parseHTML('<html><body><p><span style="visibility:hidden;color:red">Protected source</span></p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const child = owner.querySelector<HTMLElement>('span')!;
        const before = getTranslationOverflowGenerationIdentity(owner);
        child.style.color = 'blue'; child.className = 'hover';
        expect(getTranslationOverflowGenerationIdentity(owner)).toBe(before);
        child.style.visibility = 'visible';
        expect(getTranslationOverflowGenerationIdentity(owner)).not.toBe(before);
        expect(child.style.color).toBe('blue');
    });

    it('可信译文 wrapper 接受 ShortPixel 扫描标记，但拒绝属性与 class 丢失', async () => {
        const {isTrustedBilingualArtifactWithHostClass, isOwnedBilingualArtifactAttached} = await import('@/src/features/full-page-translation/content/state');
        const {document} = parseHTML('<html><body><p>Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(owner, 'bilingual')!;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content'; wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.setAttribute('lang', 'zh'); wrapper.textContent = '译文'; owner.append(wrapper); setBilingualContent(owner, wrapper);
        try {
            markTranslationComplete(owner, attempt.state, attempt.generation, false);
            wrapper.setAttribute('data-spai-bg-prepared', '1');
            expect(isTrustedBilingualArtifactWithHostClass(wrapper, attempt.state)).toBe(true);
            wrapper.setAttribute('lang', 'en');
            expect(isTrustedBilingualArtifactWithHostClass(wrapper, attempt.state)).toBe(false);
            wrapper.setAttribute('lang', 'zh'); wrapper.classList.remove('fluent-read-bilingual-content');
            expect(isTrustedBilingualArtifactWithHostClass(wrapper, attempt.state)).toBe(false);
            expect(isOwnedBilingualArtifactAttached(owner, attempt.state)).toBe(false);
        } finally { restoreTranslation(owner); }
    });

    it('overflow 等价 Text 重挂在真实 observer 检查点绑定新节点并保留译文', async () => {
        const {document} = parseHTML('<html><body><p></p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        owner.textContent = 'Readable source. '.repeat(9000);
        const source = owner.firstChild as Text;
        const attempt = beginTranslation(owner, 'bilingual', 'content', false, owner.textContent, [source], true)!;
        const wrapper = document.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content'; wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文'; owner.append(wrapper); setBilingualContent(owner, wrapper);
        try {
            expect(isTranslationSourceStructureOverflow(attempt.state.sourceStructureSignature)).toBe(true);
            markTranslationComplete(owner, attempt.state, attempt.generation, false);
            ensureTranslationTruncationLayout(owner);
            const replacement = document.createTextNode(source.data);
            owner.replaceChild(replacement, source);
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(attempt.state.sourceTextNodes).toEqual([replacement]);
            expect(wrapper.parentNode).toBe(owner);
        } finally { restoreTranslation(owner); }
    });

    it('失败态 retry wrapper 被移走时 resize 检查点清理请求和索引', async () => {
        const {document, window} = parseHTML('<html><body><p>Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const attempt = beginTranslation(owner, 'bilingual')!;
        const wrapper = document.createElement('span'); owner.append(wrapper); setRetryWrapper(owner, wrapper);
        try {
            markTranslationError(owner, attempt.state, attempt.generation, false);
            ensureTranslationTruncationLayout(owner);
            wrapper.remove(); window.dispatchEvent(new window.Event('resize'));
            await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(getTranslationOwnersForIndexedNode(wrapper)).toEqual([]);
            expect(attempt.state.controller.signal.aborted).toBe(true);
        } finally { restoreTranslation(owner); }
    });
});


describe('公共 state 入口的跨 document 与 manager 根交还边界', () => {
    async function checkpoint() {
        await Promise.resolve(); await Promise.resolve();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        await Promise.resolve();
    }

    function commit(owner: HTMLElement) {
        const source = owner.firstChild as Text;
        const attempt = beginTranslation(owner, 'bilingual', 'content', false, source.data, [source])!;
        const wrapper = owner.ownerDocument.createElement('span');
        wrapper.className = 'fluent-read-bilingual-content';
        wrapper.setAttribute('data-fr-translation-owned', 'true');
        wrapper.textContent = '译文';
        owner.append(wrapper); setBilingualContent(owner, wrapper);
        expect(markTranslationComplete(owner, attempt.state, attempt.generation, false)).toBe(true);
        expect(ensureTranslationTruncationLayout(owner)).toBe(true);
        return {source, attempt, wrapper};
    }

    // linkedom 0.18.12 没有 adoptNode，append 也不会递归更新 ownerDocument。
    // 只适配 DOM adoption 的身份和文档归属；不模拟 state、观察回调或原生 iframe realm。
    function adoptForLinkedom(document: Document, owner: HTMLElement) {
        owner.remove();
        const pending: Node[] = [owner];
        while (pending.length) {
            const node = pending.pop()!;
            Object.defineProperty(node, 'ownerDocument', {configurable: true, writable: true, value: document});
            pending.push(...Array.from(node.childNodes));
        }
        return owner;
    }

    function instrumentWindow({document, window}: ReturnType<typeof parseHTML>) {
        const descriptor = Object.getOwnPropertyDescriptor(document, 'defaultView');
        // window 是 Proxy，vi.spyOn 无法枚举其虚拟成员；只包装真实事件方法来记录监听归属。
        const add = vi.fn(window.addEventListener.bind(window));
        const remove = vi.fn(window.removeEventListener.bind(window));
        Object.defineProperty(document, 'defaultView', {configurable: true, value: {
            HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver,
            addEventListener: add, removeEventListener: remove,
        }});
        return {add, remove, restore: () => {
            if (descriptor) Object.defineProperty(document, 'defaultView', descriptor);
            else Reflect.deleteProperty(document, 'defaultView');
        }};
    }

    it.each([false, true])('跨 document adoption 模型迁移释放旧窗口监听并保留来源身份（旧根共享=%s）', async shared => {
        const oldRealm = parseHTML('<html><body><article style="height:24px"><p>Source</p><p>Sibling</p></article></body></html>');
        const newRealm = parseHTML('<html><body><section style="color:blue"></section></body></html>');
        const owner = oldRealm.document.querySelector<HTMLElement>('p')!;
        const sibling = oldRealm.document.querySelectorAll<HTMLElement>('p')[1]!;
        const oldAncestor = oldRealm.document.querySelector<HTMLElement>('article')!;
        const destination = newRealm.document.querySelector<HTMLElement>('section')!;
        const oldView = instrumentWindow(oldRealm);
        const newView = instrumentWindow(newRealm);
        const {add: oldAdd, remove: oldRemove} = oldView;
        const {add: newAdd, remove: newRemove} = newView;
        const oldDisconnect = vi.spyOn(oldRealm.window.MutationObserver.prototype, 'disconnect');
        const newDisconnect = vi.spyOn(newRealm.window.MutationObserver.prototype, 'disconnect');
        const oldResize = () => oldAdd.mock.calls.filter(([type]) => type === 'resize');
        const newResize = () => newAdd.mock.calls.filter(([type]) => type === 'resize');
        try {
            const {source, attempt, wrapper} = commit(owner);
            if (shared) commit(sibling);
            acquireTranslationLayoutOverride(owner, oldAncestor, [{property: 'height', value: 'auto', priority: 'important'}]);
            await checkpoint();
            expect(oldResize()).toHaveLength(1);
            destination.append(adoptForLinkedom(newRealm.document, owner));
            await checkpoint();
            expect(owner.ownerDocument).toBe(newRealm.document);
            expect(source.ownerDocument).toBe(newRealm.document);
            expect(owner.firstChild).toBe(source);
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(isCurrentTranslation(owner, attempt.state, attempt.generation, false)).toBe(true);
            expect(attempt.state.controller.signal.aborted).toBe(false);
            expect(wrapper.parentNode).toBe(owner);
            expect(attempt.state.layoutObserverRoots).toEqual(new Set([newRealm.document]));
            expect(oldAncestor.style.height).toBe('24px');
            expect(getTranslationOwnersForIndexedNode(oldAncestor)).not.toContain(owner);
            expect(newResize()).toHaveLength(1);
            expect(oldDisconnect).toHaveBeenCalledTimes(shared ? 0 : 1);
            expect(oldRemove.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(shared ? 0 : 1);
            restoreTranslation(sibling);
            expect(oldRemove).toHaveBeenCalledWith('resize', oldResize()[0][1]);
            expect(oldDisconnect).toHaveBeenCalledTimes(1);
            // 旧窗口已释放：仅改 Text（linkedom 不准确报告 characterData），旧 resize 不应清理新根。
            source.data = 'Host changed in destination';
            oldRealm.window.dispatchEvent(new oldRealm.window.Event('resize'));
            await checkpoint();
            expect(getTranslationState(owner)).toBe(attempt.state);
            newRealm.window.dispatchEvent(new newRealm.window.Event('resize'));
            await checkpoint();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(attempt.state.controller.signal.aborted).toBe(true);
            expect(isCurrentTranslation(owner, attempt.state, attempt.generation, false)).toBe(false);
            expect(wrapper.parentNode).toBeNull();
            expect(owner.firstChild).toBe(source);
            expect(source.data).toBe('Host changed in destination');
            expect(destination.style.color).toBe('blue');
            expect(newRemove).toHaveBeenCalledWith('resize', newResize()[0][1]);
            expect(newDisconnect).toHaveBeenCalledTimes(1);
        } finally {
            restoreTranslation(owner); restoreTranslation(sibling);
            oldView.restore(); newView.restore();
            oldDisconnect.mockRestore(); newDisconnect.mockRestore();
        }
    });

    it('manager 接管期间 resize 不能独立恢复或中止当前代控制器', async () => {
        const {document, window} = parseHTML('<html><body><p>Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const {source, attempt, wrapper} = commit(owner);
        await checkpoint();
        let managed = true;
        setBilingualLifecycleExternalManager(() => managed);
        try {
            source.data = 'Host update while managed';
            owner.setAttribute('title', 'host update');
            await checkpoint();
            expect(getTranslationState(owner)).toBe(attempt.state);
            window.dispatchEvent(new window.Event('resize'));
            await checkpoint();
            expect({active: getTranslationState(owner) === attempt.state, aborted: attempt.state.controller.signal.aborted,
                artifactAttached: wrapper.parentNode === owner, sameText: owner.firstChild === source, value: source.data})
                .toEqual({active: true, aborted: false, artifactAttached: true, sameText: true, value: 'Host update while managed'});
            managed = false;
            window.dispatchEvent(new window.Event('resize'));
            await checkpoint();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(attempt.state.controller.signal.aborted).toBe(true);
            expect(owner.firstChild).toBe(source);
        } finally { setBilingualLifecycleExternalManager(undefined); restoreTranslation(owner); }
    });

    it('manager 管理来源时 resize 仍复核纯计算布局边界，保留控制器与原 Text', async () => {
        const {document, window} = parseHTML('<html><body><article style="height:24px"><p>Source</p></article></body></html>');
        const ancestor = document.querySelector<HTMLElement>('article')!;
        const owner = document.querySelector<HTMLElement>('p')!;
        const previous = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
        let position = 'static';
        Object.defineProperty(window, 'getComputedStyle', {configurable: true, value: (element: HTMLElement) => ({
            position: element === ancestor ? position : 'static', transform: 'none',
            overflow: 'visible', overflowY: 'visible', display: 'block', height: element.style.height || '100px',
            maxHeight: 'none', webkitLineClamp: 'none', getPropertyValue: () => '',
        })});
        const {source, attempt, wrapper} = commit(owner);
        acquireTranslationLayoutOverride(owner, ancestor, [{property: 'height', value: 'auto', priority: 'important'}]);
        await checkpoint();
        setBilingualLifecycleExternalManager(() => true);
        try {
            position = 'fixed'; // 媒体查询只改变计算样式，不改 style/class，不产生 DOM record。
            window.dispatchEvent(new window.Event('resize'));
            await checkpoint();
            expect(ancestor.style.height).toBe('24px');
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(attempt.state.controller.signal.aborted).toBe(false);
            expect(attempt.state.generation).toBe(attempt.generation);
            expect(owner.firstChild).toBe(source);
            expect(source.data).toBe('Source');
            expect(wrapper.parentNode).toBe(owner);
        } finally {
            setBilingualLifecycleExternalManager(undefined); restoreTranslation(owner);
            if (previous) Object.defineProperty(window, 'getComputedStyle', previous);
            else Reflect.deleteProperty(window, 'getComputedStyle');
        }
    });

    it('resize 已排队后 manager 接管，延迟 flush 不越权且明确交还后重新校验', async () => {
        const {document, window} = parseHTML('<html><body><p>Source</p></body></html>');
        const owner = document.querySelector<HTMLElement>('p')!;
        const {source, attempt, wrapper} = commit(owner);
        await checkpoint();
        let managed = false;
        setBilingualLifecycleExternalManager(() => managed);
        try {
            source.data = 'Host source changed before takeover';
            window.dispatchEvent(new window.Event('resize'));
            managed = true; // resize 已排队，flush 尚未进入当前代次的恢复路径。
            await checkpoint();
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(attempt.state.controller.signal.aborted).toBe(false);
            expect(wrapper.parentNode).toBe(owner);
            managed = false;
            setBilingualLifecycleExternalManager(undefined);
            await checkpoint();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(attempt.state.controller.signal.aborted).toBe(true);
            expect(owner.firstChild).toBe(source);
            expect(source.data).toBe('Host source changed before takeover');
        } finally {setBilingualLifecycleExternalManager(undefined); restoreTranslation(owner);}
    });

    it('manager 移动到新 shadow 根后交还，新根来源事件应恢复而不依赖旧窗口 resize', async () => {
        const realm = parseHTML('<html><body><article style="height:24px"><p>Source</p></article><div></div></body></html>');
        const {document, window} = realm;
        const owner = document.querySelector<HTMLElement>('p')!;
        const ancestor = document.querySelector<HTMLElement>('article')!;
        const root = document.querySelector('div')!.attachShadow({mode: 'open'});
        const disconnect = vi.spyOn(window.MutationObserver.prototype, 'disconnect');
        const {source, attempt, wrapper} = commit(owner);
        acquireTranslationLayoutOverride(owner, ancestor, [{property: 'height', value: 'auto', priority: 'important'}]);
        await checkpoint();
        let managed = true;
        setBilingualLifecycleExternalManager(() => managed);
        try {
            root.append(owner);
            await checkpoint();
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(attempt.state.controller.signal.aborted).toBe(false);
            managed = false;
            setBilingualLifecycleExternalManager(undefined);
            await checkpoint();
            expect(attempt.state.layoutObserverRoots).toEqual(new Set([root, document]));
            expect(ancestor.style.height).toBe('24px');
            source.data = 'Host changed after root handoff';
            owner.setAttribute('title', 'host writes in new root');
            await checkpoint();
            expect({active: getTranslationState(owner) === attempt.state, aborted: attempt.state.controller.signal.aborted,
                artifactAttached: wrapper.parentNode === owner, sameText: owner.firstChild === source, value: source.data,
                oldHeight: ancestor.style.height, disconnects: disconnect.mock.calls.length})
                .toEqual({active: false, aborted: true, artifactAttached: false, sameText: true,
                    value: 'Host changed after root handoff', oldHeight: '24px', disconnects: 2});
        } finally { setBilingualLifecycleExternalManager(undefined); restoreTranslation(owner); disconnect.mockRestore(); }
    });

    it('manager 交还后公共 layout 入口显式接管新根，恢复保留宿主写入并释放全部监听', async () => {
        const realm = parseHTML('<html><body><article style="height:24px"><p>Source</p></article><div></div></body></html>');
        const {document, window} = realm;
        const owner = document.querySelector<HTMLElement>('p')!;
        const ancestor = document.querySelector<HTMLElement>('article')!;
        const root = document.querySelector('div')!.attachShadow({mode: 'open'});
        const destination = document.createElement('section'); root.append(destination);
        const view = instrumentWindow(realm);
        const {add, remove} = view;
        const disconnect = vi.spyOn(window.MutationObserver.prototype, 'disconnect');
        const {source, attempt, wrapper} = commit(owner);
        acquireTranslationLayoutOverride(owner, ancestor, [{property: 'height', value: 'auto', priority: 'important'}]);
        await checkpoint();
        let managed = true;
        setBilingualLifecycleExternalManager(() => managed);
        try {
            destination.append(owner);
            ancestor.setAttribute('style', 'height:73px;color:green');
            await checkpoint();
            managed = false; setBilingualLifecycleExternalManager(undefined);
            expect(ensureTranslationTruncationLayout(owner)).toBe(true);
            await checkpoint();
            expect(attempt.state.layoutObserverRoots).toEqual(new Set([root, document]));
            expect(getTranslationState(owner)).toBe(attempt.state);
            expect(isCurrentTranslation(owner, attempt.state, attempt.generation, false)).toBe(true);
            expect(ancestor.style.height).toBe('73px');
            source.data = 'Host update after explicit handoff';
            owner.setAttribute('title', 'changed'); destination.style.color = 'blue';
            await checkpoint();
            expect(getTranslationState(owner)).toBeUndefined();
            expect(attempt.state.controller.signal.aborted).toBe(true);
            expect(wrapper.parentNode).toBeNull(); expect(owner.firstChild).toBe(source);
            expect(source.data).toBe('Host update after explicit handoff');
            expect(ancestor.style.height).toBe('73px'); expect(ancestor.style.color).toBe('green');
            expect(destination.style.color).toBe('blue');
            const listeners = add.mock.calls.filter(([type]) => type === 'resize');
            expect(listeners).toHaveLength(2);
            listeners.forEach(([, listener]) => expect(remove).toHaveBeenCalledWith('resize', listener));
            expect(disconnect).toHaveBeenCalledTimes(2);
        } finally {
            setBilingualLifecycleExternalManager(undefined); restoreTranslation(owner);
            view.restore(); disconnect.mockRestore();
        }
    });
});

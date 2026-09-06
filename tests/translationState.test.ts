import { beforeEach, describe, expect, it, vi } from "vitest";
import {parseHTML} from "linkedom";
import {
    beginTranslation,
    detachFailedTranslationUi,
    discardTranslation,
    ensureTranslationTruncationLayout,
    getOwnedTranslationCandidateAtPoint,
    getTranslationOwnersForRemovedNode,
    getTranslationSourceStructureSignature,
    getTranslationState,
    isTranslationSourceStructureOverflow,
    isCurrentTranslation,
    markTranslationComplete,
    markTranslationError,
    restoreAllTranslations,
    restoreTranslation,
    setBilingualContent,
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
        target.classList.add('fluent-read-failure');
        setRetryWrapper(target, retryWrapper);
        setRenderedStyleAttribute(target);
        retryWrapper.remove();

        expect(detachFailedTranslationUi(target, attempt.state)).toBe(true);
        expect(getTranslationState(target)).toBe(attempt.state);
        expect(attempt.state.phase).toBe('error');
        expect(attempt.state.retryWrapper).toBeUndefined();
        expect(target.className).toBe('host');
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

describe("synthetic 双语工件的真实 observer 生命周期", () => {
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

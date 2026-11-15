/**
 * @file src/features/full-page-translation/content/modalPriority.ts
 * 文件职责：识别全文翻译时当前真正阻塞页面交互的弹窗，并提供跨开放 Shadow DOM 的归属判断。
 * 主要内容：支持原生 dialog:modal、明确 aria-modal 的对话框以及带遮罩/滚动锁证据的常见组件弹窗；按可见性、遮挡证据和堆叠顺序选择最顶层弹窗，并判断 DOM mutation 是否可能改变检测结果。
 * 模块边界：本文件只读取既有 DOM 和样式，不创建节点、观察器、计时器或修改宿主页面；扩展运行时、翻译队列和弹窗内容渲染由上层负责。
 */

const MODAL_SELECTOR = '[role="dialog"],[role="alertdialog"],dialog,.modal,.ant-modal,.el-dialog';
const OWNED_SELECTOR = [
    '[data-fluent-read-ui]',
    '[data-fr-translation-owned="true"]',
    '[data-fr-translation-segment="true"]',
    '.fluent-read-bilingual-content',
].join(',');
const MASK_SELECTOR = [
    '.modal-backdrop', '.ant-modal-mask', '.el-overlay', '.el-dialog__wrapper',
    '[class*="backdrop" i]', '[class*="mask" i]', '[class*="overlay" i]',
    '[data-modal-backdrop]', '[data-modal-mask]',
].join(',');
const RELEVANT_ATTRIBUTES = new Set([
    'aria-hidden', 'aria-modal', 'class', 'hidden', 'inert', 'open', 'role', 'style',
]);

function composedParent(node: Node): Node | null {
    if (node.parentNode) return node.parentNode;
    const root = node.getRootNode?.();
    return root && root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host : null;
}

function composedAncestors(node: Node): Generator<Node> {
    return (function* () {
        let current: Node | null = node;
        while (current) {
            yield current;
            current = composedParent(current);
        }
    })();
}

function matches(element: Element, selector: string): boolean {
    try { return element.matches(selector); } catch { return false; }
}

function isOwned(element: Element): boolean {
    return matches(element, OWNED_SELECTOR) || Boolean(element.closest?.(OWNED_SELECTOR));
}

function computed(element: Element): CSSStyleDeclaration | null {
    try { return element.ownerDocument.defaultView!.getComputedStyle(element); } catch { return null; }
}

function isVisible(element: HTMLElement): boolean {
    if (element.isConnected === false || isOwned(element)) return false;
    const ancestors: HTMLElement[] = [];
    for (const ancestor of composedAncestors(element)) {
        if (ancestor.nodeType !== 1) continue;
        const current = ancestor as HTMLElement;
        if (current.hidden || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false;
        ancestors.push(current);
    }
    // 先排除整条组合祖先链的显式隐藏状态，避免解析不可见宿主组件的样式。
    for (const current of ancestors) {
        const style = computed(current);
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') return false;
    }
    const rect = element.getBoundingClientRect?.();
    const view = element.ownerDocument.defaultView;
    if (!rect || rect.width <= 0 || rect.height <= 0 || !view) return false;
    return rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
}

function isNativeModal(element: HTMLElement): boolean {
    if (element.tagName.toLowerCase() !== 'dialog' || !(element as HTMLDialogElement).open) return false;
    try { return element.matches(':modal'); } catch { return false; }
}

function isAriaModal(element: HTMLElement): boolean {
    return ['dialog', 'alertdialog'].includes(element.getAttribute('role')?.toLowerCase() ?? '') &&
        element.getAttribute('aria-modal')?.toLowerCase() === 'true';
}

function isScrollLocked(element: HTMLElement): boolean {
    const document = element.ownerDocument;
    return [document.body!, document.documentElement].some((node) => {
        const style = computed(node);
        return style?.overflow === 'hidden' || style?.overflowY === 'hidden';
    });
}

function isFixedOrAbsolute(element: HTMLElement): boolean {
    const style = computed(element);
    return style?.position === 'fixed' || style?.position === 'absolute' ||
        element.style.position === 'fixed' || element.style.position === 'absolute';
}

function hasBlockingMask(element: HTMLElement): boolean {
    const document = element.ownerDocument;
    const candidates = new Set<Element>();
    const root = element.parentElement ?? element.getRootNode();
    if (root.nodeType === 1 && matches(root as Element, MASK_SELECTOR)) candidates.add(root as Element);
    // HTMLElement 的根只能是 Element、Document 或 DocumentFragment，均实现 ParentNode。
    (root as ParentNode).querySelectorAll(MASK_SELECTOR).forEach((node) => candidates.add(node));
    for (const mask of candidates) {
        if (mask === element) continue;
        if (isOwned(mask)) continue;
        if (!isVisible(mask as HTMLElement)) continue;
        if (!isFixedOrAbsolute(mask as HTMLElement)) continue;
        const rect = (mask as HTMLElement).getBoundingClientRect()!;
        const view = document.defaultView!;
        const width = view.innerWidth;
        const height = view.innerHeight;
        if (width > 0 && height > 0 && rect.width >= width * 0.8 && rect.height >= height * 0.8 &&
            rect.left < width && rect.right > 0 && rect.top < height && rect.bottom > 0) return true;
    }
    return false;
}

function coversViewportCenter(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView!;
    const x = view.innerWidth / 2;
    const y = view.innerHeight / 2;
    return rect.left <= x && rect.right >= x && rect.top <= y && rect.bottom >= y;
}

function isModalCandidate(element: HTMLElement): boolean {
    if (!matches(element, MODAL_SELECTOR) || !isVisible(element)) return false;
    if (isNativeModal(element)) return true;
    const role = element.getAttribute('role')?.toLowerCase();
    if ((role === 'dialog' || role === 'alertdialog') && element.getAttribute('aria-modal')?.toLowerCase() === 'false') return false;
    if (isAriaModal(element)) return true;
    return (isFixedOrAbsolute(element) && (hasBlockingMask(element) || isScrollLocked(element)) && coversViewportCenter(element));
}

function zIndex(element: Element): number {
    const value = Number.parseInt(String(computed(element)?.zIndex), 10);
    return Number.isFinite(value) ? value : 0;
}

function isHitAtCenter(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect?.();
    const view = element.ownerDocument.defaultView;
    const elementsFromPoint = element.ownerDocument.elementsFromPoint;
    if (!rect || !view || typeof elementsFromPoint !== 'function') return false;
    const hits = elementsFromPoint.call(element.ownerDocument, rect.left + rect.width / 2, rect.top + rect.height / 2);
    const firstPageHit = hits.find((hit) => !isOwned(hit));
    return firstPageHit === element || (firstPageHit ? isDescendant(element, firstPageHit) : false);
}

function collectElements(roots: Iterable<Node>): HTMLElement[] {
    const result: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    for (const root of roots) {
        if (root.nodeType === 11 && (root as ShadowRoot).host?.isConnected === false) continue;
        const candidates: Element[] = [];
        if (root.nodeType === 1) candidates.push(root as Element);
        const queryRoot = root as Node & ParentNode;
        queryRoot.querySelectorAll?.(MODAL_SELECTOR).forEach((node) => candidates.push(node));
        candidates.forEach((node) => {
            const element = node as HTMLElement;
            if (!seen.has(element) && isModalCandidate(element)) { seen.add(element); result.push(element); }
        });
    }
    return result;
}

function isDescendant(ancestor: Node, node: Node): boolean {
    for (const current of composedAncestors(node)) if (current === ancestor) return true;
    return false;
}

/** 查找可见且阻塞页面的最顶层全文翻译弹窗；扫描只穿透 open ShadowRoot。 */
export function findActiveTranslationModal(roots: Iterable<Node>): HTMLElement | null {
    const candidates = collectElements(roots);
    let winner: HTMLElement | null = null;
    candidates.forEach((candidate) => {
        if (!winner) { winner = candidate; return; }
        const candidateNative = isNativeModal(candidate);
        const winnerNative = isNativeModal(winner);
        if (candidateNative !== winnerNative) { if (candidateNative) winner = candidate; return; }
        if (isDescendant(winner, candidate)) { winner = candidate; return; }
        if (isDescendant(candidate, winner)) return;
        const candidateHit = isHitAtCenter(candidate);
        const winnerHit = isHitAtCenter(winner);
        if (candidateHit !== winnerHit) { if (candidateHit) winner = candidate; return; }
        if (zIndex(candidate) >= zIndex(winner)) winner = candidate;
    });
    return winner;
}

/** 判断节点是否位于 modal 自身或其开放 Shadow DOM 后代。 */
export function isWithinTranslationModal(modal: HTMLElement, node: Node): boolean {
    return isDescendant(modal, node);
}

function mayContainModal(node: Node): boolean {
    if (node.nodeType !== 1) return false;
    const element = node as Element;
    return matches(element, MODAL_SELECTOR) || Boolean(element.querySelector?.(MODAL_SELECTOR)) ||
        Boolean(element.shadowRoot?.querySelector(MODAL_SELECTOR));
}

/** 判断一次非自有 mutation 是否可能改变 active modal，需要上层重新探测。 */
export function mayChangeTranslationModal(mutation: MutationRecord, current: HTMLElement | null): boolean {
    const target = mutation.target;
    if (current && (isWithinTranslationModal(current, target) || isDescendant(target, current))) return true;
    if (mutation.type === 'attributes') {
        if (mutation.attributeName && RELEVANT_ATTRIBUTES.has(mutation.attributeName)) {
            return target.nodeType === 1 && (mayContainModal(target) || Boolean((target as Element).closest?.(MODAL_SELECTOR)) || target === target.ownerDocument?.body || target === target.ownerDocument?.documentElement);
        }
        return false;
    }
    if (mutation.type === 'childList') {
        if (target.nodeType === 1 && matches(target as Element, MODAL_SELECTOR)) return true;
        return [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)].some(mayContainModal);
    }
    return false;
}

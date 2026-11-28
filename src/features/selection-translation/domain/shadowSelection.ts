/**
 * @file src/features/selection-translation/domain/shadowSelection.ts
 *
 * 文件职责：实现页面与开放 Shadow DOM 的活动选区解析，兼容 Chromium shadowRoot.getSelection 与 W3C Selection.getComposedRanges 接口。
 * 主要内容：导出 collectEventShadowRoots 与 resolveActiveSelection，支持从事件 composedPath、焦点链和有界文档扫描中定位非扩展宿主的开放 ShadowRoot 选区。
 * 模块边界：仅读取传入 Window/Document/Event 的只读选区信息，不注册事件监听器、不修改 DOM，也不触发翻译流程。
 */

const FLUENT_READ_SHADOW_HOST_IDS = new Set([
    'fluent-read-selection-translator-container',
    'fluent-read-floating-ball-container',
    'fluent-read-share-card-container',
    'fluent-read-translation-status-container',
]);
const MAX_SHADOW_SCAN_ELEMENTS = 4000;
const MAX_SHADOW_SCAN_ROOTS = 256;

export interface ResolvedSelection {
    selection: Selection;
    range: Range;
    nativeText: string;
    isForward: boolean;
}

export interface ResolveActiveSelectionOptions {
    shadowRoots?: Iterable<ShadowRoot>;
    isIgnoredSelection?: (selection: Selection) => boolean;
}

type ShadowRootWithSelection = ShadowRoot & {getSelection?: () => Selection | null};
type SelectionWithComposedRanges = Selection & {
    direction?: string;
    getComposedRanges?: (options?: {shadowRoots?: ShadowRoot[]} | ShadowRoot, ...rest: ShadowRoot[]) => StaticRange[];
};

export function isShadowRootNode(value: unknown): value is ShadowRoot {
    return typeof value === 'object' && value !== null && (value as Node).nodeType === 11 && 'host' in value;
}

export function getShadowHostElement(node: Node): Element | null {
    const root = node.getRootNode?.();
    return isShadowRootNode(root) && root.host?.nodeType === 1 ? root.host : null;
}

function isUsablePageShadowRoot(value: unknown, ownerDocument?: Document): value is ShadowRoot {
    if (!isShadowRootNode(value)) return false;
    const host = value.host;
    if (!host || host.nodeType !== 1 || !host.isConnected) return false;
    if (ownerDocument && host.ownerDocument !== ownerDocument) return false;
    return !FLUENT_READ_SHADOW_HOST_IDS.has(host.id) && !host.hasAttribute?.('data-fluent-read-ui');
}

/** 从事件 composedPath 提取已连接的页面开放 ShadowRoot（保持由深到浅顺序，跳过扩展自身宿主）。 */
export function collectEventShadowRoots(event: Event | null | undefined, ownerDocument?: Document): ShadowRoot[] {
    const path = event?.composedPath?.();
    if (!path?.length) return [];
    const roots: ShadowRoot[] = [];
    const seen = new Set<ShadowRoot>();
    for (const entry of path) {
        if (!isUsablePageShadowRoot(entry, ownerDocument) || seen.has(entry)) continue;
        seen.add(entry);
        roots.push(entry);
    }
    return roots;
}

function isSelectionForward(selection: Selection, range: Range): boolean {
    if (selection.anchorNode === range.startContainer && selection.anchorOffset === range.startOffset) return true;
    if (selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset) return false;
    return (selection as SelectionWithComposedRanges).direction !== 'backward';
}

function readUsableSelection(
    selection: Selection | null | undefined,
    isIgnored?: (selection: Selection) => boolean,
): ResolvedSelection | null | 'ignored' {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    if (isIgnored?.(selection)) return 'ignored';
    const range = selection.getRangeAt(0);
    const nativeText = selection.toString();
    if (!nativeText.trim()) return null;
    return {selection, range, nativeText, isForward: isSelectionForward(selection, range)};
}

function addShadowRootCandidate(target: ShadowRoot[], seen: Set<ShadowRoot>, root: unknown, doc: Document): void {
    if (!isUsablePageShadowRoot(root, doc) || seen.has(root)) return;
    seen.add(root);
    target.push(root);
}

function addNodeShadowCandidates(target: ShadowRoot[], seen: Set<ShadowRoot>, node: Node | null | undefined, offset: number, doc: Document): void {
    if (!node) return;
    addShadowRootCandidate(target, seen, node.getRootNode?.(), doc);
    if (node.nodeType !== 1) return;
    const element = node as Element;
    addShadowRootCandidate(target, seen, element.shadowRoot, doc);
    for (const index of [offset, offset - 1]) {
        const child = element.childNodes?.[index];
        if (child?.nodeType === 1) addShadowRootCandidate(target, seen, (child as Element).shadowRoot, doc);
    }
}

function collectHintedShadowRoots(doc: Document, rootSelection: Selection | null, hints?: Iterable<ShadowRoot>): ShadowRoot[] {
    const candidates: ShadowRoot[] = [];
    const seen = new Set<ShadowRoot>();
    if (hints) {
        for (const root of hints) addShadowRootCandidate(candidates, seen, root, doc);
    }
    const activeRoots: ShadowRoot[] = [];
    let active = doc.activeElement as (Element & {shadowRoot?: ShadowRoot | null}) | null;
    while (active?.shadowRoot && isUsablePageShadowRoot(active.shadowRoot, doc)) {
        activeRoots.push(active.shadowRoot);
        active = active.shadowRoot.activeElement as (Element & {shadowRoot?: ShadowRoot | null}) | null;
    }
    for (let index = activeRoots.length - 1; index >= 0; index -= 1) {
        addShadowRootCandidate(candidates, seen, activeRoots[index], doc);
    }
    if (rootSelection) {
        addNodeShadowCandidates(candidates, seen, rootSelection.anchorNode, rootSelection.anchorOffset, doc);
        addNodeShadowCandidates(candidates, seen, rootSelection.focusNode, rootSelection.focusOffset, doc);
        if (rootSelection.rangeCount > 0) {
            const range = rootSelection.getRangeAt(0);
            addNodeShadowCandidates(candidates, seen, range.startContainer, range.startOffset, doc);
            addNodeShadowCandidates(candidates, seen, range.endContainer, range.endOffset, doc);
        }
    }
    return candidates;
}

function collectDocumentOpenShadowRoots(doc: Document, excluded: Set<ShadowRoot>): ShadowRoot[] {
    const startRoot = doc.body ?? doc.documentElement;
    if (!startRoot || typeof doc.createTreeWalker !== 'function') return [];
    const discovered: ShadowRoot[] = [];
    const seen = new Set<ShadowRoot>(excluded);
    const pending: Node[] = [startRoot, ...excluded];
    let visitedElements = 0;
    const recordHost = (element: Element) => {
        if (!element.shadowRoot || !isUsablePageShadowRoot(element.shadowRoot, doc) || seen.has(element.shadowRoot)) return;
        seen.add(element.shadowRoot);
        discovered.push(element.shadowRoot);
        pending.push(element.shadowRoot);
    };
    for (let queueIndex = 0; queueIndex < pending.length && discovered.length < MAX_SHADOW_SCAN_ROOTS && visitedElements < MAX_SHADOW_SCAN_ELEMENTS; queueIndex += 1) {
        const root = pending[queueIndex]!;
        if (root.nodeType === 1) recordHost(root as Element);
        const walker = doc.createTreeWalker(root, 1);
        let current = walker.nextNode();
        while (current && discovered.length < MAX_SHADOW_SCAN_ROOTS && visitedElements < MAX_SHADOW_SCAN_ELEMENTS) {
            visitedElements += 1;
            recordHost(current as Element);
            current = walker.nextNode();
        }
    }
    return discovered.reverse();
}

function readComposedRanges(selection: SelectionWithComposedRanges, shadowRoots: ShadowRoot[]): StaticRange[] {
    if (typeof selection.getComposedRanges !== 'function') return [];
    try {
        return selection.getComposedRanges({shadowRoots}) ?? [];
    } catch {
        try {
            return selection.getComposedRanges(...shadowRoots) ?? [];
        } catch {
            return [];
        }
    }
}

function resolveFromShadowRoots(
    rootSelection: Selection | null,
    doc: Document,
    selectionRoots: ShadowRoot[],
    composedRoots: ShadowRoot[],
    isIgnored?: (selection: Selection) => boolean,
): ResolvedSelection | null | 'ignored' {
    for (const shadowRoot of selectionRoots) {
        const reader = (shadowRoot as ShadowRootWithSelection).getSelection;
        if (typeof reader !== 'function') continue;
        const resolved = readUsableSelection(reader.call(shadowRoot), isIgnored);
        if (resolved) return resolved;
    }
    if (!rootSelection || typeof doc.createRange !== 'function') return null;
    for (const staticRange of readComposedRanges(rootSelection as SelectionWithComposedRanges, composedRoots)) {
        if (staticRange.collapsed
            || !staticRange.startContainer.isConnected || !staticRange.endContainer.isConnected
            || staticRange.startContainer.ownerDocument !== doc
            || staticRange.startContainer.getRootNode() !== staticRange.endContainer.getRootNode()) continue;
        const range = doc.createRange();
        range.setStart(staticRange.startContainer, staticRange.startOffset);
        range.setEnd(staticRange.endContainer, staticRange.endOffset);
        const rangeText = range.toString();
        if (range.collapsed || !rangeText.trim()) continue;
        const selectionText = rootSelection.toString();
        return {
            selection: rootSelection,
            range,
            nativeText: selectionText.trim() ? selectionText : rangeText,
            isForward: isSelectionForward(rootSelection, range),
        };
    }
    return null;
}

/**
 * 读取当前活动选区：优先普通文档选区；当选区位于开放 Shadow DOM 中被宿主重定位或折叠时，
 * 依次尝试 Chromium shadowRoot.getSelection() 与标准 Selection.getComposedRanges()。
 */
export function resolveActiveSelection(
    view: Window,
    doc: Document,
    options: ResolveActiveSelectionOptions = {},
): ResolvedSelection | null {
    const rootSelection = view.getSelection?.() ?? null;
    const light = readUsableSelection(rootSelection, options.isIgnoredSelection);
    if (light === 'ignored') return null;
    if (light) return light;

    const hinted = collectHintedShadowRoots(doc, rootSelection, options.shadowRoots);
    if (hinted.length > 0) {
        const fromHints = resolveFromShadowRoots(rootSelection, doc, hinted, hinted, options.isIgnoredSelection);
        if (fromHints === 'ignored') return null;
        if (fromHints) return fromHints;
    }

    const discovered = collectDocumentOpenShadowRoots(doc, new Set(hinted));
    if (discovered.length === 0) return null;
    const fromScan = resolveFromShadowRoots(rootSelection, doc, discovered, [...discovered, ...hinted], options.isIgnoredSelection);
    return fromScan === 'ignored' ? null : fromScan;
}

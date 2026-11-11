/**
 * @file src/features/selection-translation/core.ts
 * 文件职责：集中划词翻译的纯交互与内容算法，包括请求代次、词典回退、触发展示状态、选区过滤、上下文摘要、弹窗锚点和语音语言规范化。
 * 主要内容：定义 SelectionRequestTokenGate、Presentation 状态机、选区/视口类型，处理中英划词反向目标、同语种判断、文本清理、公式单份文本提取、正文中的行内代码片段保护、主动代码选区提取、文档根禁译外壳放行、同一编辑区内显式选区放行、按实际 Range 边界遍历的敏感区域排除、无文本装饰图标放行及单遍祖先保护检查（不扫描未选中的共同祖先子树）、多矩形选择与完整选区避让、按页面缩放补偿并在空间不足时约束高度的弹窗定位及仅用于朗读的普通话语言别名。
 * 模块边界：本模块不监听 document selection、不发消息、不渲染 Vue 或播放音频；组件负责连接 DOM，词典和 TTS 由 services/background 提供，函数保持确定性以供单元测试。DOM 安全判断直接复用 translation/dom 的同一实现，不初始化翻译候选或站点规则 registry。
 */
import {getElementTagName, isDocumentSurfaceNoTranslateShell, isTopLevelApplicationShell} from '@/src/core/translation/dom';
import {getChineseScript, normalizeChineseLanguageCode} from '@/src/core/language/chinese';
import {isLanguageCodeMatch, normalizeDetectedLanguageCode} from '@/src/core/language/codes';
import {isTextInLanguage, shouldSkipChineseSelection} from '@/src/core/language/detect';

export interface SelectionRect {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
}

export interface PopupSize {
    width: number;
    height: number;
}

export interface ViewportSize {
    width: number;
    height: number;
    left?: number;
    top?: number;
}

export interface PopupPosition {
    left: number;
    top: number;
    placement: 'top' | 'bottom';
    /** 两侧都无法容纳原高度时，返回所选一侧的可用高度，避免弹窗夹边后覆盖选区。 */
    maxHeight?: number;
}

export interface SelectionContentRequest {
    text: string;
    sourceLanguage?: string;
    targetLanguage: string;
    generation: number;
}

/** 只在选区可信地属于当前目标语言时反向；不对短歧义词或其他语言猜测方向。 */
export function selectionReverseTarget(text: string, targetLanguage: string, sourceLanguage: string): string | null {
    if (getChineseScript(targetLanguage) && shouldSkipChineseSelection(text, targetLanguage)) return 'en';
    if (targetLanguage === 'en' && isTextInLanguage(text, 'en')) {
        return getChineseScript(sourceLanguage) ? normalizeChineseLanguageCode(sourceLanguage) : 'zh-Hans';
    }
    return null;
}

export interface SelectionAnswerCandidate extends SelectionContentRequest {
    answer: string;
}

/** 为每条异步通道维护独立代次，避免一种请求的完成结果误废弃另一种请求。 */
export class SelectionRequestTokenGate {
    private generation = 0;

    begin(): number {
        this.generation += 1;
        return this.generation;
    }

    invalidate(): void {
        this.generation += 1;
    }

    isCurrent(token: number): boolean {
        return token === this.generation;
    }
}

function normalizeSelectionRequestLanguage(value: string): string {
    return normalizeChineseLanguageCode(String(value || '')).replace(/_/g, '-').toLowerCase();
}

/** ECDICT 随包附带的辅助释义是简体中文，仅在目标语言兼容时参与回退。 */
export function canUseBundledDictionaryFallback(targetLanguage: string): boolean {
    return normalizeSelectionRequestLanguage(targetLanguage) === 'zh-hans';
}

export function resolveSelectionDictionaryFallback(targetLanguage: string, translatedDefinitions: readonly unknown[]): string {
    if (!canUseBundledDictionaryFallback(targetLanguage)) return '';
    return translatedDefinitions
        .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
        .map(value => value.trim())
        .slice(0, 4)
        .join('；');
}

export function resolveSelectionVocabularyAnswer(
    current: SelectionContentRequest | null,
    translation: SelectionAnswerCandidate | null,
    dictionary: SelectionAnswerCandidate | null,
): string {
    if (!current) return '';
    const matches = (candidate: SelectionAnswerCandidate | null): candidate is SelectionAnswerCandidate => Boolean(
        candidate
        && candidate.generation === current.generation
        && candidate.text === current.text
        && normalizeSelectionRequestLanguage(candidate.targetLanguage) === normalizeSelectionRequestLanguage(current.targetLanguage)
        && candidate.answer.trim(),
    );
    if (matches(translation)) return translation.answer.trim();
    return matches(dictionary) ? dictionary.answer.trim() : '';
}

export interface SelectionPresentationState {
    showIndicator: boolean;
    showTooltip: boolean;
}

export type SelectionPresentationTrigger = 'direct' | 'icon' | 'dot' | 'shortcut' | 'contextMenu';

/** 延迟配置变化仍以当前选区稳定时刻为起点，避免刷新配置后重新等待完整时长。 */
export function getSelectionPresentationDelayRemaining(
    delay: number,
    selectionSettledAt: number,
    now: number,
): number {
    const elapsed = Math.max(0, now - selectionSettledAt);
    return Math.max(0, delay - elapsed);
}

/** 与展示无关的配置刷新不能关闭用户已经明确打开的翻译浮层。 */
export function reconcileSelectionPresentation(
    current: SelectionPresentationState,
    trigger: SelectionPresentationTrigger,
    triggerChanged: boolean,
): SelectionPresentationState {
    if (!triggerChanged) return current;
    if (trigger === 'direct') return { showIndicator: false, showTooltip: true };
    if (trigger === 'shortcut' || trigger === 'contextMenu') return { showIndicator: false, showTooltip: false };
    return { showIndicator: true, showTooltip: false };
}

/** 选区检测结果与目标语言使用统一标签规则比较；中文必须具有一致的明确书写体系。 */
export function isSameLanguage(detectedLanguage: string | undefined, targetLanguage: string | undefined): boolean {
    return isLanguageCodeMatch(detectedLanguage, targetLanguage);
}

const DEFAULT_PADDING = 12;
const DEFAULT_GAP = 10;

/** 规范化浏览器选区文本，同时保留对阅读有意义的换行。 */
export function normalizeSelectionText(value: string): string {
    return value
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .trim();
}

export function summarizeSelectionContext(
    containerText: string,
    selectedText: string,
    maxLength = 500,
    selectedIndex?: number,
): string {
    const normalized = String(containerText || '').replace(/\s+/gu, ' ').trim();
    const selected = String(selectedText || '').trim();
    if (!normalized || !selected || maxLength < 16) return '';
    if (normalized.length <= maxLength) return normalized;
    const normalizedLower = normalized.toLocaleLowerCase();
    const selectedLower = selected.toLocaleLowerCase();
    const firstIndex = normalizedLower.indexOf(selectedLower);
    if (firstIndex < 0) return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    let matchedIndex = firstIndex;
    if (typeof selectedIndex === 'number' && Number.isFinite(selectedIndex)) {
        const preferredIndex = Math.max(0, Math.min(normalized.length, selectedIndex));
        const leftIndex = normalizedLower.lastIndexOf(selectedLower, preferredIndex);
        const rightIndex = normalizedLower.indexOf(selectedLower, preferredIndex);
        if (leftIndex < 0) matchedIndex = rightIndex;
        else if (rightIndex < 0) matchedIndex = leftIndex;
        else matchedIndex = preferredIndex - leftIndex <= rightIndex - preferredIndex ? leftIndex : rightIndex;
    }
    const contentLength = Math.max(1, maxLength - 2);
    const selectedCenter = matchedIndex + selected.length / 2;
    const start = Math.max(0, Math.min(normalized.length - contentLength, Math.round(selectedCenter - contentLength / 2)));
    const end = Math.min(normalized.length, start + contentLength);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < normalized.length ? '…' : '';
    return `${prefix}${normalized.slice(start, end).trim()}${suffix}`.slice(0, maxLength);
}

// 只把有明确渲染器身份的数学子树视为原子，不能放开普通 aria-hidden/SVG 控件。
const selectionFormulaSelector = 'math, mjx-container, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_CHTML, .katex';
const selectionSemanticSelector = `${selectionFormulaSelector}, code`;

export interface SelectionTextPart {
    kind: 'text' | 'code';
    text: string;
}

/** 冻结选区片段；代码只保留文字与 code 语义，不把宿主属性或 HTML 带入扩展 UI。 */
export function readSelectionParts(range: Range, browserText: string): SelectionTextPart[] {
    const ancestor = elementFromSelectionNode(range.commonAncestorContainer);
    if (ancestor?.closest(selectionFormulaSelector)) return [];
    const plainText = () => [{kind: 'text' as const, text: normalizeSelectionText(browserText)}];
    // 用户主动选中的代码文字可以翻译；正文跨行内代码时仍保留代码快照。
    if (ancestor?.closest('pre, code')) return plainText();
    if (!ancestor || !hasSelectionSemanticParts(range)) return plainText();
    const fragment = ancestor.ownerDocument.createElement('div');
    fragment.append(range.cloneContents());
    const formulas = Array.from(fragment.querySelectorAll(selectionFormulaSelector))
        .filter(element => !element.parentElement?.closest(selectionFormulaSelector));
    if (formulas.length === 0 && !fragment.querySelector('code')) return plainText();
    const prose = fragment.cloneNode(true) as HTMLElement;
    prose.querySelectorAll(`${selectionFormulaSelector}, code, script, style, .MathJax_Preview`).forEach(element => element.remove());
    if (!/\p{L}/u.test(prose.textContent!)) return fragment.querySelector('code') ? plainText() : [];
    for (const formula of formulas) {
        const tex = formula.nextElementSibling?.matches('script[type^="math/tex"]')
            ? formula.nextElementSibling.textContent
            : formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
        formula.querySelectorAll('.MJX_Assistive_MathML, mjx-assistive-mml, .katex-mathml, annotation, annotation-xml').forEach(element => element.remove());
        const text = normalizeSelectionText(tex || formula.textContent!);
        formula.replaceWith(fragment.ownerDocument!.createTextNode(text ? `$${text}$` : ''));
    }
    fragment.querySelectorAll('script, style, .MathJax_Preview').forEach(element => element.remove());
    const parts: SelectionTextPart[] = [];
    const appendText = (text: string) => {
        const previous = parts[parts.length - 1];
        if (previous?.kind === 'text') previous.text += text;
        else parts.push({kind: 'text', text});
    };
    const visit = (node: Node) => {
        if (node.nodeType === 3) { appendText(node.textContent!); return; }
        const tag = getElementTagName(node as Element);
        if (tag === 'code') { parts.push({kind: 'code', text: node.textContent!}); return; }
        const lineBreak = /^(br|p|div|li|h[1-6]|blockquote)$/.test(tag);
        if (lineBreak) appendText('\n');
        node.childNodes.forEach(visit);
        if (lineBreak && tag !== 'br') appendText('\n');
    };
    fragment.childNodes.forEach(visit);
    parts.forEach((part, index) => {
        if (part.kind !== 'text') return;
        part.text = part.text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n');
        if (index === 0) part.text = part.text.trimStart();
        if (index === parts.length - 1) part.text = part.text.trimEnd();
    });
    return parts.filter(part => part.text !== '');
}

/** 选区中的公式只取一份可读表示，代码空白保持原样。 */
export function readSelectionText(range: Range, browserText: string): string {
    return readSelectionParts(range, browserText).map(part => part.text).join('');
}

/** 只把正文交给现有批量翻译通道；代码和边界空白由本地快照恢复。 */
export async function translateSelectionParts(
    parts: readonly SelectionTextPart[],
    translate: (texts: string[]) => Promise<string[]>,
): Promise<SelectionTextPart[]> {
    const prose = parts.filter(part => part.kind === 'text' && /\p{L}/u.test(part.text));
    const results = prose.length ? await translate(prose.map(part => part.text.trim())) : [];
    if (results.length !== prose.length || results.some(text => !text.trim())) throw new Error('Invalid selection translation');
    let index = 0;
    return parts.map(part => {
        if (!prose.includes(part)) return {...part};
        const leading = part.text.match(/^\s*/u)![0];
        const trailing = part.text.match(/\s*$/u)![0];
        return {kind: 'text', text: leading + results[index++].trim() + trailing};
    });
}

/** 相交的公式可留在正文选区内，交互控件与外层显式排除区域仍受原规则保护。 */
function isInlineSelectionFormulaPart(element: Element): boolean {
    const root = element.closest(selectionFormulaSelector);
    if (!root) return false;
    if (isEditableSelectionElement(element)) return false;
    const tag = getElementTagName(element);
    if ((selectionExcludedTagNames.has(tag) && tag !== 'math' && tag !== 'svg') ||
        selectionExcludedRoles.has(element.getAttribute('role')?.trim().toLowerCase() ?? '')) return false;
    const outer = root.parentElement?.closest(selectionFormulaSelector) ?? root;
    return !isSelectionExcludedElement(outer.parentElement);
}

const selectionExcludedTagNames = new Set([
    'audio', 'button', 'canvas', 'embed', 'iframe', 'img', 'input',
    'kbd', 'math', 'object', 'option', 'picture', 'samp', 'select',
    'svg', 'template', 'textarea', 'var', 'video',
]);

const selectionExcludedRoles = new Set([
    'button', 'checkbox', 'combobox', 'listbox', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'radio', 'scrollbar', 'slider', 'spinbutton',
    'switch', 'tab', 'textbox',
]);

const selectionEditableMarkerSelector = [
    '[role="textbox"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
].join(',');
const selectionProtectedMarkerSelector = [
    '.fluent-read-bilingual-content',
    '.fluent-read-loading',
    '.fluent-read-retry-wrapper',
    '[aria-hidden="true"]',
    '[data-fluent-read-ui]',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="scrollbar"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="switch"]',
    '[role="tab"]',
    ...Array.from(selectionExcludedTagNames),
].join(',');
const selectionNonMarkerExcludedSelector = `${selectionProtectedMarkerSelector},${selectionEditableMarkerSelector}`;
const selectionExcludedSelector = `${selectionNonMarkerExcludedSelector},.notranslate,[translate="no"],[data-notranslate="true"]`;
const selectionExcludedDescendantSelector = `${selectionExcludedSelector},[role]`;
export function isSelectionExcludedTagName(tagName: string): boolean {
    return selectionExcludedTagNames.has(tagName.trim().toLowerCase());
}

function isEditableSelectionElement(element: Element): boolean {
    if ((element as HTMLElement).isContentEditable) return true;

    let current: Element | null = element;
    while (current) {
        if (current.hasAttribute('contenteditable')) {
            return current.getAttribute('contenteditable')?.trim().toLowerCase() !== 'false';
        }
        current = current.parentElement;
    }
    return false;
}

function isIntrinsicallyExcludedSelectionElement(element: Element, editableRoot: Element | null): boolean {
    if (isSelectionExcludedTagName(getElementTagName(element))) return true;

    const role = element.getAttribute('role')?.trim().toLowerCase();
    if (role && selectionExcludedRoles.has(role)
        && !(role === 'textbox' && isWithinEditableSelectionRoot(element, editableRoot))) return true;
    return isEditableSelectionElement(element) && !isWithinEditableSelectionRoot(element, editableRoot);
}

function isSelectionExcludedElement(element: Element | null, editableRoot: Element | null = null): boolean {
    if (!element) return false;
    let current: Element | null = element;
    while (current) {
        // 每层只检查自身，不能为每个祖先再次向上寻找编辑状态；仅共享的局部宿主可放行。
        const role = current.getAttribute('role')?.trim().toLowerCase();
        const insideEditableRoot = isWithinEditableSelectionRoot(current, editableRoot);
        if (isSelectionExcludedTagName(getElementTagName(current))
            || role && selectionExcludedRoles.has(role) && !(role === 'textbox' && insideEditableRoot)
            || ((current as HTMLElement).isContentEditable
                || current.hasAttribute('contenteditable') && current.getAttribute('contenteditable')?.trim().toLowerCase() !== 'false')
                && !insideEditableRoot) return true;
        current = current.parentElement;
    }

    let excluded = element.closest(selectionExcludedSelector);
    while (excluded) {
        // DeepSeek 等页面在 html/body 上禁止浏览器整页翻译；显式划词仍可读取正文。
        // 文档根禁译标记可放行；UI、隐藏、本地禁译标记和授权编辑宿主之外的编辑边界仍逐层检查。
        const shell = isDocumentSurfaceNoTranslateShell(excluded) ||
            excluded !== element && isTopLevelApplicationShell(excluded);
        if ((!shell && !isAllowedEditableSelectionMarker(excluded, editableRoot))
            || isSelectionNonMarkerExcluded(excluded, editableRoot)) return true;
        excluded = excluded.parentElement?.closest(selectionExcludedSelector) ?? null;
    }
    return false;
}

function elementFromSelectionNode(node: Node | null): Element | null {
    if (!node) return null;
    return node.nodeType === 1 ? node as Element : node.parentElement;
}

/** 只把两个边界共享的同一个局部编辑宿主视为可放行范围；文档根编辑模式仍保持排除。 */
export function getEditableSelectionRoot(node: Node | null): Element | null {
    const document = node?.nodeType === 9 ? node as Document : node?.ownerDocument ?? null;
    const documentRoot = document?.documentElement ?? null;
    const body = document?.body ?? null;
    let current = elementFromSelectionNode(node);
    let root: Element | null = null;
    while (current) {
        const editable = current.getAttribute('contenteditable');
        const isDocumentRoot = current === documentRoot || current === body;
        if (editable !== null) {
            if (editable.trim().toLowerCase() === 'false') return root;
            if (!isDocumentRoot) root = current;
        } else {
            const role = current.getAttribute('role')?.trim().toLowerCase();
            if (!isDocumentRoot && role === 'textbox') root = current;
            else if (!isDocumentRoot && (current as HTMLElement).isContentEditable
                && !(current.parentElement as HTMLElement | null)?.isContentEditable) root = current;
        }
        current = current.parentElement;
    }
    return root;
}

function isWithinEditableSelectionRoot(element: Element, root: Element | null): boolean {
    if (!root) return false;
    if (element === root) return true;
    if (typeof root.contains === 'function') {
        try {return root.contains(element);}
        catch {/* 使用父链回退，单个宿主代理异常不能放宽选区校验。 */}
    }
    for (let current: Element | null = element; current; current = current.parentElement) {
        if (current === root) return true;
    }
    return false;
}

function isAllowedEditableSelectionMarker(element: Element, root: Element | null): boolean {
    if (!root || !isWithinEditableSelectionRoot(element, root) || !element.matches(selectionEditableMarkerSelector)) return false;
    const editable = element.getAttribute('contenteditable');
    return !(editable !== null && editable.trim().toLowerCase() === 'false')
        && !element.matches(selectionProtectedMarkerSelector)
        && !element.matches('.notranslate,[translate="no"],[data-notranslate="true"]');
}

function isSelectionNonMarkerExcluded(element: Element, root: Element | null): boolean {
    return element.matches(selectionNonMarkerExcludedSelector) && !isAllowedEditableSelectionMarker(element, root);
}

function getSharedEditableSelectionRoot(range: Range): Element | null {
    const start = getEditableSelectionRoot(range.startContainer);
    return start && start === getEditableSelectionRoot(range.endContainer) ? start : null;
}

/** 跳过已访问的子树；只沿祖先回退，绝不越过当前选区的共同祖先。 */
function nextSelectionSibling(node: Node, root: Node): Node | null {
    let current: Node | null = node;
    while (current && current !== root) {
        if (current.nextSibling) return current.nextSibling;
        current = current.parentNode;
    }
    return null;
}

/** 浏览器选中段落时可能将结束点落在下一代码块的起点；跳过完全未选中的分支。 */
function firstUnselectedSelectionEnd(range: Range): Node | null {
    let node = range.endContainer;
    const root = range.commonAncestorContainer;
    if (range.endOffset !== 0 || node === root || !node?.parentNode || !elementFromSelectionNode(node)?.closest('pre')) return null;
    while (node.parentNode && node.parentNode !== root && !node.previousSibling) {
        node = node.parentNode;
    }
    return node;
}

/** 由原生 Range 的半开边界定位遍历区间，不枚举共同祖先内未选中的前后兄弟树。 */
function* selectionRangeNodes(range: Range, unselectedEnd = firstUnselectedSelectionEnd(range)): Generator<Node> {
    const root = range.commonAncestorContainer;
    const start = range.startContainer;
    const end = range.endContainer;
    const stop = unselectedEnd ?? (end.nodeType === 3 ? nextSelectionSibling(end, root)
        : end.childNodes[range.endOffset] ?? nextSelectionSibling(end, root));
    let node: Node | null = start.nodeType === 3 ? start
        : start.childNodes[range.startOffset] ?? nextSelectionSibling(start, root);
    while (node && node !== stop) {
        yield node;
        node = node.firstChild ?? nextSelectionSibling(node, root);
    }
}

/** 部分选区从 code/公式内部起步时，祖先包装不在向前遍历中，须先审核两端语义。 */
function hasSelectionSemanticParts(range: Range): boolean {
    if ([range.startContainer, range.endContainer].some(node => elementFromSelectionNode(node)?.closest(selectionSemanticSelector))) return true;
    for (const node of selectionRangeNodes(range)) {
        if (node.nodeType === 1 && (node as Element).matches(selectionSemanticSelector)) return true;
    }
    return false;
}

function* selectionExcludedDescendants(range: Range, unselectedEnd: Node | null): Generator<Element> {
    for (const node of selectionRangeNodes(range, unselectedEnd)) {
        if (node.nodeType === 1 && node !== range.commonAncestorContainer && (node as Element).matches(selectionExcludedDescendantSelector)) yield node as Element;
    }
}

function containsNonZeroClientRect(rects: DOMRectList): boolean {
    return Array.from(rects).some(rect => rect.width > 0 || rect.height > 0);
}

function hasNonZeroClientRect(element: Element): boolean {
    if (containsNonZeroClientRect(element.getClientRects())) return true;

    const contentRange = element.ownerDocument?.createRange();
    if (!contentRange) return false;
    contentRange.selectNodeContents(element);
    return containsNonZeroClientRect(contentRange.getClientRects());
}

/** 跨段选区经过的空 SVG/隐藏装饰不代表选中了受保护文字；控件和编辑宿主仍严格排除。 */
function isTextlessSelectionDecoration(element: Element): boolean {
    const tag = getElementTagName(element);
    return (tag === 'svg' || element.getAttribute('aria-hidden') === 'true' && !isSelectionExcludedTagName(tag))
        && !selectionExcludedRoles.has(element.getAttribute('role')?.trim().toLowerCase() ?? '')
        && !isEditableSelectionElement(element)
        && !element.textContent?.trim();
}

/**
 * 划词翻译处理用户主动选中的正文与代码文字，不处理交互控件；显式启用编辑区时只放行
 * 完整位于同一宿主内的选区。检查两端与实时 DOM 中相交且具有可见几何的排除元素，跳过空装饰图标。
 */
export function shouldIgnoreSelection(range: Range, allowEditableSelection = false): boolean {
    const editableRoot = allowEditableSelection ? getSharedEditableSelectionRoot(range) : null;
    const unselectedEnd = firstUnselectedSelectionEnd(range);
    const boundaries = [
        elementFromSelectionNode(range.startContainer),
        elementFromSelectionNode(unselectedEnd ? unselectedEnd.parentNode : range.endContainer),
    ];
    if (boundaries.some(element => isSelectionExcludedElement(element, editableRoot) &&
        !(element && isInlineSelectionFormulaPart(element)))) return true;

    try {
        for (const element of selectionExcludedDescendants(range, unselectedEnd)) {
            try {
                if (!isIntrinsicallyExcludedSelectionElement(element, editableRoot) &&
                    (isDocumentSurfaceNoTranslateShell(element) || isTopLevelApplicationShell(element)
                        || isAllowedEditableSelectionMarker(element, editableRoot)) &&
                    !isSelectionNonMarkerExcluded(element, editableRoot)) continue;
                if (!isSelectionExcludedElement(element, editableRoot)) continue;
                if (isInlineSelectionFormulaPart(element)) continue;
                if (isTextlessSelectionDecoration(element)) continue;
                if (range.intersectsNode(element) && hasNonZeroClientRect(element)) return true;
            } catch {
                // 单个失效节点不能阻止后续仍有效的受保护内容被识别。
            }
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * 选择最靠近选区焦点的视觉边缘；使用客户端矩形可以避免把入口放在多行选区中间。
 */
export function chooseSelectionRect(rects: SelectionRect[], isForward = true): SelectionRect | null {
    if (rects.length === 0) return null;
    return isForward ? rects[rects.length - 1] : rects[0];
}

/** 卡片避让完整选区的纵向范围，横向仍对齐选择方向的端点行。 */
export function getSelectionPopupAnchor(rects: SelectionRect[], isForward = true): SelectionRect | null {
    const anchor = chooseSelectionRect(rects, isForward);
    if (!anchor) return null;
    let {top, bottom} = anchor;
    for (const rect of rects) {top = Math.min(top, rect.top); bottom = Math.max(bottom, rect.bottom);}
    return {...anchor, top, bottom, height: bottom - top};
}

/**
 * 以当前选中行作为弹层锚点并限制在视口内。计算保持为纯函数，使滚动和缩放行为
 * 无需挂载 Vue、也不依赖宿主页面 CSS 即可测试。
 */
export function calculateSelectionPopupPosition(
    anchor: SelectionRect,
    popup: PopupSize,
    viewport: ViewportSize,
    padding = DEFAULT_PADDING,
    gap = DEFAULT_GAP,
): PopupPosition {
    const viewportLeft = viewport.left ?? 0;
    const viewportTop = viewport.top ?? 0;
    const minLeft = viewportLeft + padding;
    const minTop = viewportTop + padding;
    const maxLeft = Math.max(minLeft, viewportLeft + viewport.width - popup.width - padding);
    const left = clamp(anchor.left, minLeft, maxLeft);
    const viewportBottom = viewportTop + viewport.height - padding;
    const aboveBottom = Math.min(anchor.top - gap, viewportBottom);
    const belowTop = Math.max(anchor.bottom + gap, minTop);
    const availableAbove = Math.max(0, aboveBottom - minTop);
    const availableBelow = Math.max(0, viewportBottom - belowTop);
    // 两侧都放不下时，优先较宽裕的一侧并限高；离开可见区的旧锚点也不能放大可用空间。
    const placement = popup.height <= availableAbove ? 'top' : popup.height <= availableBelow ? 'bottom'
        : availableAbove >= availableBelow ? 'top' : 'bottom';
    const height = Math.min(popup.height, Math.max(1, placement === 'top' ? availableAbove : availableBelow));
    const top = placement === 'top' ? aboveBottom - height : belowTop;

    return {
        left,
        top: clamp(top, minTop, Math.max(minTop, viewportBottom - height)),
        placement,
        ...(height < popup.height ? {maxHeight: height} : {}),
    };
}

export function normalizeSpeechLanguage(language: string | undefined, fallback = 'en-US'): string {
    let normalized = String(language ?? '').trim().replace(/_/g, '-');
    // 词书导入和语言检测可能保存 ISO 639-3（如 eng、jpn）；只归一化主语言子标签，
    // 再拼回原来的脚本和地区，避免 zho-Hant 被扩展成 zh-Hant-Hant。
    if (/^[a-z]{3}(?:-|$)/iu.test(normalized)) {
        const [primary, ...subtags] = normalized.split('-');
        const canonical = normalizeDetectedLanguageCode(primary);
        if (canonical) normalized = [canonical, ...subtags].join('-');
    }
    const lower = normalized.toLowerCase();
    if (!normalized || ['auto', 'detect', 'unknown', 'und'].includes(lower)) return fallback;

    const script = getChineseScript(normalized);
    if (script) return script === 'Hans' ? 'zh-CN' : 'zh-TW';

    const aliases: Record<string, string> = {
        // 只选择普通话朗读音色，不据此推断原文的简繁或跳过翻译。
        'cmn': 'zh-CN',
        'zho': 'zh-CN',
        'chi': 'zh-CN',
        'en': 'en-US',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
        'fr': 'fr-FR',
        'de': 'de-DE',
        'es': 'es-ES',
        'it': 'it-IT',
        'pt': 'pt-BR',
        'ru': 'ru-RU',
    };

    if (Object.hasOwn(aliases, lower)) return aliases[lower];
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(normalized) ? normalized : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * @file src/features/writing-assistant/editors.ts
 * 文件职责：识别 Gmail/GitHub 回复编辑器与普通文本框，捕获可审阅上下文并安全填入草稿。
 * 主要内容：按评论容器识别新旧 GitHub 编辑器与原生操作区，限定当前会话正文并排除重复译文；快照编辑器和页面身份，用原生 setter 通知受控输入。
 * 模块边界：只处理显式传入的 DOM，不监听页面、不联网、不发送表单；复杂富文本提供复制回退。
 */
export type WritingSite = 'gmail' | 'github' | null;
const excludedUi = '[data-fluent-read-ui], .read-frog-react-shadow-host, .immersive-translate-ai-writing-container, template';
const hiddenContent = '[hidden], [inert], [aria-hidden="true"], [style*="display:none" i], [style*="display: none" i], [style*="visibility:hidden" i], [style*="visibility: hidden" i]';
const githubComposer = '[data-testid="comment-composer"], [data-testid="comment-box"], .js-inline-comment-form, form';
export function writingSite(url: string): WritingSite {
    try { const host = new URL(url).hostname; return host === 'mail.google.com' ? 'gmail' : host === 'github.com' ? 'github' : null; } catch { return null; }
}
export function isWritingEditor(element: Element | null, site: WritingSite): element is HTMLElement {
    if (!element || element.closest(`${excludedUi}, ${hiddenContent}, fieldset[disabled], fieldset[aria-disabled="true"]`)) return false;
    if (element.matches('textarea, input[type="text"], input:not([type])')) {
        const input = element as HTMLInputElement;
        return !input.disabled && !input.readOnly;
    }
    return element.getAttribute('contenteditable') === 'plaintext-only'
        || (site === 'gmail' && element.matches('[contenteditable="true"][role="textbox"]'));
}
export function findReplyEditors(doc: Document, site: WritingSite): HTMLElement[] {
    const selector = site === 'gmail' ? '[contenteditable="true"][role="textbox"]'
        : site === 'github' ? 'textarea[name="comment[body]"], textarea#new_comment_field, textarea[name="discussion[body]"], textarea[name="discussion_comment[body]"], [data-testid="comment-composer"] textarea, [data-testid="comment-box"] textarea' : '';
    return selector ? Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter(element => isWritingEditor(element, site)).slice(0, 12) : [];
}
/** 返回当前编辑框的原生发送/评论按钮；空稿禁用状态仍可定位，调用方只在按钮前插入自有入口。 */
export function findReplyActionAnchor(editor: HTMLElement, site: WritingSite): HTMLElement | null {
    if (!isWritingEditor(editor, site)) return null;
    const scope = site === 'github' ? editor.closest(githubComposer)
        : site === 'gmail' ? editor.closest('form, [role="dialog"], .M9') : null;
    if (!scope) return null;
    const selector = site === 'github'
        ? '[data-testid="markdown-editor-footer"] button[data-variant="primary"], [data-testid="comment-button"], .js-comment-button, button[type="submit"]:not([name="comment_and_close"]), input[type="submit"]:not([name="comment_and_close"])'
        : '[role="button"][data-tooltip*="Enter"], [role="button"][aria-label*="Enter"], button[type="submit"]';
    return Array.from(scope.querySelectorAll<HTMLElement>(selector)).find(button => !button.closest(`${excludedUi}, ${hiddenContent}`)) ?? null;
}
export function editorText(element: HTMLElement): string {
    return element.matches('input, textarea') ? (element as HTMLInputElement).value : element.innerText ?? element.textContent ?? '';
}
const signature = (element: HTMLElement) => element.matches('input, textarea') ? editorText(element) : element.innerHTML;
export interface EditorSnapshot {element: HTMLElement; signature: string; url: string; site: WritingSite}
export function captureEditor(element: HTMLElement, url: string): EditorSnapshot {
    return {element, signature: signature(element), url, site: writingSite(url)};
}
function replyContextRoot(doc: Document, site: WritingSite, editor?: HTMLElement): ParentNode | null {
    if (!editor) return doc;
    if (editor.ownerDocument !== doc || !editor.isConnected || !isWritingEditor(editor, site)) return null;
    if (site === 'gmail') return editor.closest('[role="dialog"], .M9, [role="main"]');
    return editor.closest('[data-testid="review-thread"], .js-resolvable-timeline-thread-container, .js-inline-comments-container')
        ?? editor.closest('.js-inline-comment-form') ?? editor.closest('main');
}
export function collectReplyContext(doc: Document, site: WritingSite, editor?: HTMLElement): string {
    const selector = site === 'gmail' ? '[role="main"] .a3s' : site === 'github' ? 'main .js-comment-body, main .CommentBody, main [data-testid="markdown-body"]' : '';
    if (!selector) return '';
    const root = replyContextRoot(doc, site, editor);
    if (!root) return '';
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(element => !element.closest(`${hiddenContent}, [contenteditable], ${excludedUi}`) && element.getClientRects().length > 0);
    const snippets = candidates.filter(element => !candidates.some(other => other !== element && other.contains(element)));
    let remaining = 12000;
    const texts: string[] = [];
    // 从最近消息分配预算，再恢复阅读顺序；分隔符也计入总长，避免旧长文挤掉最新问题。
    for (const element of snippets.slice(-12).reverse()) {
        const separatorLength = texts.length ? 2 : 0;
        if (remaining <= separatorLength) break;
        const copy = element.cloneNode(true) as HTMLElement;
        // 仅译文模式的 single-slot 轻 DOM 保存原文，不能连同重复译文一起剔除。
        copy.querySelectorAll(`input, textarea, button, [role="button"], select, script, style, noscript, [contenteditable], ${hiddenContent}, ${excludedUi}, .immersive-translate-target-wrapper, .fluent-read-bilingual-content, [data-fr-translation-owned="true"]:not(.fluent-read-single-slot)`).forEach(node => node.remove());
        const text = (copy.textContent || '').trim().slice(0, remaining - separatorLength);
        if (!text) continue;
        remaining -= text.length + separatorLength;
        texts.unshift(text);
    }
    return texts.join('\n\n');
}
export function applyWritingDraft(snapshot: EditorSnapshot, text: string, url: string): string | undefined {
    const element = snapshot.element;
    if (url !== snapshot.url || !element.isConnected || !isWritingEditor(element, snapshot.site)) return '原编辑框已关闭或页面已变化，请复制正文后自行粘贴。';
    if (signature(element) !== snapshot.signature) return '原草稿已被修改。为保留你的新内容，请复制正文后自行粘贴。';
    if (element.querySelector('a, img, video, audio, table, [contenteditable="false"]')) return '原草稿包含链接、附件或复杂格式，请复制正文后自行粘贴。';
    const win = element.ownerDocument.defaultView!;
    if (element.matches('input, textarea')) {
        const prototype = element.tagName.toLowerCase() === 'textarea' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text);
    } else {
        element.focus();
        const selection = element.ownerDocument.getSelection();
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range);
        const inserted = element.ownerDocument.execCommand?.('insertText', false, text);
        if (!inserted) element.replaceChildren(element.ownerDocument.createTextNode(text));
    }
    element.dispatchEvent(new win.Event('input', {bubbles: true, composed: true}));
    element.dispatchEvent(new win.Event('change', {bubbles: true}));
    snapshot.signature = signature(element);
    return undefined;
}

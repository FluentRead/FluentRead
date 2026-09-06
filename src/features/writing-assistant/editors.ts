/**
 * @file src/features/writing-assistant/editors.ts
 * 文件职责：识别 Gmail/GitHub 回复编辑器与普通文本框，捕获可审阅上下文并安全填入草稿。
 * 主要内容：限制正文选择器与字符数，快照原编辑器和页面身份；使用原生 setter 通知受控输入。
 * 模块边界：只处理显式传入的 DOM，不监听页面、不联网、不发送表单；复杂富文本提供复制回退。
 */
export type WritingSite = 'gmail' | 'github' | null;
export function writingSite(url: string): WritingSite {
    try { const host = new URL(url).hostname; return host === 'mail.google.com' ? 'gmail' : host === 'github.com' ? 'github' : null; } catch { return null; }
}
export function isWritingEditor(element: Element | null, site: WritingSite): element is HTMLElement {
    if (!element || element.closest('[data-fluent-read-ui]') || element.closest('[hidden], [aria-hidden="true"]')) return false;
    if (element.matches('textarea, input[type="text"], input:not([type])')) {
        const input = element as HTMLInputElement;
        return !input.disabled && !input.readOnly;
    }
    return element.getAttribute('contenteditable') === 'plaintext-only'
        || (site === 'gmail' && element.matches('[contenteditable="true"][role="textbox"]'));
}
export function findReplyEditors(doc: Document, site: WritingSite): HTMLElement[] {
    const selector = site === 'gmail' ? '[contenteditable="true"][role="textbox"]'
        : site === 'github' ? 'textarea[name="comment[body]"], textarea#new_comment_field, textarea[name="discussion[body]"], textarea[name="discussion_comment[body]"]' : '';
    return selector ? Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter(element => isWritingEditor(element, site)).slice(0, 12) : [];
}
export function editorText(element: HTMLElement): string {
    return element.matches('input, textarea') ? (element as HTMLInputElement).value : element.innerText ?? element.textContent ?? '';
}
const signature = (element: HTMLElement) => element.matches('input, textarea') ? editorText(element) : element.innerHTML;
export interface EditorSnapshot {element: HTMLElement; signature: string; url: string; site: WritingSite}
export function captureEditor(element: HTMLElement, url: string): EditorSnapshot {
    return {element, signature: signature(element), url, site: writingSite(url)};
}
export function collectReplyContext(doc: Document, site: WritingSite): string {
    const selector = site === 'gmail' ? '[role="main"] .a3s' : site === 'github' ? 'main .js-comment-body, main .CommentBody, main [data-testid="markdown-body"]' : '';
    if (!selector) return '';
    const snippets = Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter(element => !element.closest('[hidden], [aria-hidden="true"], [contenteditable], [data-fluent-read-ui]') && element.getClientRects().length > 0);
    let remaining = 12000;
    return snippets.slice(-12).map(element => {
        const copy = element.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('input, textarea, button, script, style, [hidden], [aria-hidden="true"], [data-fluent-read-ui]').forEach(node => node.remove());
        const text = (copy.textContent || '').trim().slice(0, remaining);
        remaining -= text.length;
        return text;
    }).filter(Boolean).join('\n\n').slice(0, 12000);
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

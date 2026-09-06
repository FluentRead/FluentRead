/**
 * @file src/features/writing-assistant/editors.ts
 * 文件职责：识别 Gmail/GitHub 回复编辑器与普通文本框，捕获可审阅上下文并安全填入草稿。
 * 主要内容：按评论容器识别新旧 GitHub 编辑器与原生操作区，构造项目、标题、原帖和最近回复的有界参考信息；限定当前会话并排除重复译文，快照编辑器和页面身份后安全写回。
 * 模块边界：只处理显式传入的 DOM，不监听页面、不联网、不发送表单；复杂富文本提供复制回退。
 */
export type WritingSite = 'gmail' | 'github' | null;
const excludedUi = '[data-fluent-read-ui], .read-frog-react-shadow-host, .immersive-translate-ai-writing-container, template';
const hiddenContent = '[hidden], [inert], [aria-hidden="true"], [style*="display:none" i], [style*="display: none" i], [style*="visibility:hidden" i], [style*="visibility: hidden" i]';
const githubComposer = '[data-testid="comment-composer"], [data-testid="comment-box"], .js-inline-comment-form, form';
const githubReviewThread = '[data-testid="review-thread"], .js-resolvable-timeline-thread-container, .js-inline-comments-container';
const githubOriginalPost = '[data-testid="issue-body"], [data-testid="issue-body-viewer"], .js-issue';
const contextExcluded = `input, textarea, button, [role="button"], select, script, style, noscript, svg, [contenteditable], ${hiddenContent}, ${excludedUi}, .immersive-translate-target-wrapper, .fluent-read-bilingual-content, [data-fr-translation-owned="true"]:not(.fluent-read-single-slot)`;
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
    return editor.closest(githubReviewThread)
        ?? editor.closest('.js-inline-comment-form') ?? editor.closest('main');
}
function isCssHidden(element: Element): boolean {
    const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
    return style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse';
}
function visibleContextElements(root: ParentNode, selector: string): HTMLElement[] {
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(element => !element.closest(`${hiddenContent}, [contenteditable], ${excludedUi}`) && element.getClientRects().length > 0 && !isCssHidden(element));
    return candidates.filter(element => !candidates.some(other => other !== element && other.contains(element)));
}
function contextText(element: HTMLElement): string {
    const copy = element.cloneNode(true) as HTMLElement;
    const descendants = Array.from(copy.querySelectorAll('*'));
    element.querySelectorAll('*').forEach((source, index) => { if (isCssHidden(source)) descendants[index].remove(); });
    // 仅译文模式的 single-slot 轻 DOM 保存原文，不能连同重复译文一起剔除。
    copy.querySelectorAll(contextExcluded).forEach(node => node.remove());
    return (copy.textContent || '').trim();
}
function firstContextText(root: ParentNode, selector: string, limit: number): string {
    for (const element of visibleContextElements(root, selector)) {
        // 仅显式命名的当前撰写窗口主题字段可以读取 value，其余上下文只读取可见正文。
        const text = element.matches('input[name="subjectbox"]') ? (element as HTMLInputElement).value.trim() : contextText(element);
        if (text) return text.slice(0, limit);
    }
    return '';
}
function githubPageIdentity(url: string): string {
    try {
        const parsed = new URL(url);
        const match = /^\/([\w.-]{1,100})\/([\w.-]{1,100})\/(issues|pull)\/(\d{1,12})(?:\/|$)/.exec(parsed.pathname);
        if (parsed.origin !== 'https://github.com' || !match) return '';
        const [, owner, repo, kind, number] = match;
        return `当前项目：${owner}/${repo}\n帖子类型：${kind === 'issues' ? 'Issue' : 'Pull Request'} #${number}\n页面地址：https://github.com/${owner}/${repo}/${kind}/${number}`;
    } catch { return ''; }
}
function recentContextText(snippets: HTMLElement[], budget: number, site: WritingSite): string {
    let remaining = budget;
    const texts: string[] = [];
    for (const element of snippets.slice(-12).reverse()) {
        const separatorLength = texts.length ? 2 : 0;
        if (remaining <= separatorLength) break;
        const body = contextText(element);
        if (!body) continue;
        const comment = site === 'github' ? element.closest('[data-testid="issue-comment"], .js-comment, .timeline-comment') : null;
        const author = comment ? firstContextText(comment, '[data-testid="issue-comment-header-author"], [data-testid="comment-author"], .timeline-comment-header .author', 100) : '';
        const text = `${author ? `回复作者：${author}\n` : ''}${body}`.slice(0, remaining - separatorLength);
        remaining -= text.length + separatorLength;
        texts.unshift(text);
    }
    return texts.join('\n\n');
}
export function collectReplyContext(doc: Document, site: WritingSite, editor?: HTMLElement, url: string = doc.URL): string {
    const selector = site === 'gmail' ? '[role="main"] .a3s, [role="dialog"] .a3s, .M9 .a3s' : site === 'github' ? 'main .js-comment-body, main .CommentBody, main [data-testid="markdown-body"]' : '';
    if (!selector) return '';
    const root = replyContextRoot(doc, site, editor);
    if (!root) return '';
    const snippets = visibleContextElements(root, selector);
    const inline = site === 'github' && Boolean(editor?.closest(`${githubReviewThread}, .js-inline-comment-form`));
    const titleRoot = site === 'github' && editor ? editor.closest('main') ?? root : root;
    const title = firstContextText(titleRoot, site === 'github' ? 'main [data-testid="issue-title"], main bdi.js-issue-title, main .gh-header-title .js-issue-title' : 'h2.hP, input[name="subjectbox"]', 1000);
    const original = site === 'github' && !inline ? snippets.find(element => element.closest(githubOriginalPost)) ?? snippets[0] : undefined;
    const starter = site === 'github' ? firstContextText(titleRoot, 'main [data-testid="issue-body"] [data-testid="issue-body-header-author"], main .js-issue .timeline-comment-header .author', 100) : '';
    const state = site === 'github' ? firstContextText(titleRoot, 'main [data-testid="header-state"], main .gh-header-meta .State', 100) : '';
    const header = [
        site === 'github' ? githubPageIdentity(url) : '',
        title ? `${site === 'github' ? '帖子标题' : '邮件主题'}：${title}` : '',
        state ? `帖子状态：${state}` : '',
        starter ? `发起人：${starter}` : '',
    ].filter(Boolean).join('\n');
    const sections = header ? [header] : [];
    let remaining = 12000 - header.length;
    const comments = snippets.filter(element => element !== original);
    const originalText = original ? contextText(original) : '';
    if (originalText) {
        const prefixLength = (sections.length ? 2 : 0) + '原帖：'.length;
        // 有回复时为原帖保留最多 4000 字；其余预算从最近回复向前分配，标题永远不参与裁剪。
        const body = originalText.slice(0, comments.length ? Math.min(4000, remaining - prefixLength) : remaining - prefixLength);
        sections.push(`原帖：${body}`); remaining -= prefixLength + body.length;
    }
    if (comments.length) {
        const label = site === 'github' ? '当前讨论' : '当前邮件';
        const text = recentContextText(comments, remaining - (sections.length ? 2 : 0) - label.length - 1, site);
        if (text) sections.push(`${label}：${text}`);
    }
    return sections.join('\n\n');
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
        // insertText 会把空行变成块级 div，额外产生换行并折叠代码空白。
        // 仅序列化 DOM 创建的纯文本，原生插入保留撤销；回退使用相同的空白保留结构。
        const content = element.ownerDocument.createElement('span');
        content.style.whiteSpace = 'pre-wrap';
        content.append(element.ownerDocument.createTextNode(text));
        const inserted = element.ownerDocument.execCommand?.('insertHTML', false, content.outerHTML);
        if (!inserted) element.replaceChildren(content);
    }
    element.dispatchEvent(new win.Event('input', {bubbles: true, composed: true}));
    element.dispatchEvent(new win.Event('change', {bubbles: true}));
    snapshot.signature = signature(element);
    return undefined;
}

/**
 * @file src/features/writing-assistant/editors.ts
 * 文件职责：识别一等写作平台与通用网页的可编辑区域，按预算捕获可审阅上下文并安全写回草稿。
 * 主要内容：复用站点配置支持 Gmail、GitHub、Outlook、X、Reddit、LinkedIn、Slack、Discord、Notion 及通用网页编辑框；解析穿透 Shadow DOM 的当前焦点编辑目标，按剩余字符预算读取主题、原帖、最近讨论或周边段落而不克隆长子树，检测富媒体与框架托管富文本编辑器并提供复制回退。
 * 模块边界：只处理显式传入的 DOM，不监听页面、不联网、不发送表单；复杂富文本和 Slate/ProseMirror/Lexical 编辑器统一回退复制粘贴。
 */
import {isWritingEligibleUrl, isWritingPage, type WritingIntent} from '@/src/core/config/writing';
import {getWritingSiteProfile, matchFirstClassWritingSite, type WritingSite, type WritingSiteProfile} from './siteProfiles';

export type {WritingSite} from './siteProfiles';
export {isPlainTextWritingSite} from './siteProfiles';

const excludedUi = '[data-fluent-read-ui], .read-frog-react-shadow-host, .immersive-translate-ai-writing-container, template';
const hiddenContent = '[hidden], [inert], [aria-hidden="true"], [style*="display:none" i], [style*="display: none" i], [style*="visibility:hidden" i], [style*="visibility: hidden" i]';
const richMediaSelector = 'a, img, video, audio, table, [contenteditable="false"]';
const managedRichEditorSelector = '[data-slate-editor="true"], .ProseMirror, [data-lexical-editor="true"], .public-DraftEditor-content';
const githubReviewThread = '[data-testid="review-thread"], .js-resolvable-timeline-thread-container, .js-inline-comments-container';
const githubOriginalPost = '[data-testid="issue-body"], [data-testid="issue-body-viewer"], .js-issue';
const contextExcluded = `input, textarea, button, [role="button"], select, script, style, noscript, svg, [contenteditable], ${hiddenContent}, ${excludedUi}, .immersive-translate-target-wrapper, .fluent-read-bilingual-content, [data-fr-translation-owned="true"]:not(.fluent-read-single-slot)`;

export function writingSite(url: string): WritingSite {
    return matchFirstClassWritingSite(url);
}

/** 仅对真正的一等写作页面路由返回对应平台；其余常规 HTTP/HTTPS 页面回落为通用编辑模式。 */
export function resolveWritingSite(url: string): WritingSite {
    if (isWritingPage(url)) return matchFirstClassWritingSite(url);
    return isWritingEligibleUrl(url) ? 'generic' : null;
}

export function isWritingEditor(element: Element | null, site: WritingSite): element is HTMLElement {
    if (!element || element.closest(`${excludedUi}, ${hiddenContent}, fieldset[disabled], fieldset[aria-disabled="true"]`)) return false;
    if (element.matches('textarea, input[type="text"], input:not([type])')) {
        const input = element as HTMLInputElement;
        return !input.disabled && !input.readOnly;
    }
    if (element.getAttribute('aria-disabled') === 'true' || element.getAttribute('aria-readonly') === 'true') return false;
    const editable = element.getAttribute('contenteditable')?.toLowerCase();
    if (editable === 'plaintext-only') return true;
    if (site === 'generic') return editable === 'true' || editable === '';
    const profile = getWritingSiteProfile(site);
    if (!profile || !profile.richEditorSelector) return false;
    return (editable === 'true' || editable === '' || element.matches('[role="textbox"][data-slate-editor="true"]'))
        && element.matches(profile.richEditorSelector);
}

/** 从焦点节点向上解析实际可编辑宿主，兼容富文本内部子节点、排除扩展 UI 与防止 Shadow DOM 环路。 */
export function deepActiveElement(doc: Document): Element | null {
    let active: Element | null = doc.activeElement;
    const visited = new Set<Element>();
    for (let depth = 0; active && depth < 16; depth++) {
        if (active.closest(excludedUi)) return null;
        visited.add(active);
        const next = active.shadowRoot?.activeElement;
        if (!next || visited.has(next)) return active;
        active = next;
    }
    return null;
}

export function resolveEditableTarget(element: Element | null, site: WritingSite): HTMLElement | null {
    if (!element) return null;
    if (isWritingEditor(element, site)) return element;
    if (element.matches('input, textarea, select, button, [role="button"]')) return null;
    const nearest = element.closest('[contenteditable], [role="textbox"][data-slate-editor="true"]');
    if (!nearest || nearest.getAttribute('contenteditable')?.toLowerCase() === 'false') return null;
    return isWritingEditor(nearest, site) ? nearest : null;
}

export function hasManagedRichEditor(element: HTMLElement): boolean {
    return Boolean(element.closest(managedRichEditorSelector));
}

export function hasComplexRichEditorStructure(element: HTMLElement): boolean {
    return Boolean(element.querySelector(richMediaSelector)) || hasManagedRichEditor(element);
}

export function findReplyEditors(doc: Document, site: WritingSite, url: string = doc.URL): HTMLElement[] {
    const profile = getWritingSiteProfile(site);
    if (!profile) return [];
    const selector = site === 'github' && githubNewIssueIdentity(url)
        ? `${profile.editorSelector}, textarea[name="issue[body]"], textarea#issue_body`
        : profile.editorSelector;
    return Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter(element => isWritingEditor(element, site)).slice(0, 12);
}

function actionIsVisible(element: HTMLElement): boolean {
    if (element.closest(`${excludedUi}, ${hiddenContent}`)) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) return false;
    return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
}

/** 返回当前编辑框所属操作区的原生发送/评论按钮；空稿禁用状态仍可定位。 */
export function findReplyActionAnchor(editor: HTMLElement, site: WritingSite): HTMLElement | null {
    const profile = getWritingSiteProfile(site);
    if (!profile || !isWritingEditor(editor, site)) return null;
    const scope = editor.closest(profile.composerScopeSelector)
        ?? (site === 'github' ? editor.closest('fieldset') : null);
    if (!scope) return null;
    const candidates = Array.from(scope.querySelectorAll<HTMLElement>(profile.actionSelector)).filter(candidate => {
        if (!actionIsVisible(candidate)) return false;
        const owner = site === 'github' && scope.matches('fieldset')
            ? candidate.closest('fieldset')
            : candidate.closest(profile.composerScopeSelector);
        return owner === scope;
    });
    return candidates[0] ?? null;
}

export function editorText(element: HTMLElement): string {
    return element.matches('input, textarea') ? (element as HTMLInputElement).value : element.innerText ?? element.textContent ?? '';
}

const signature = (element: HTMLElement) => element.matches('input, textarea') ? editorText(element) : element.innerHTML;
export interface EditorSnapshot {element: HTMLElement; signature: string; url: string; site: WritingSite}

export function captureEditor(element: HTMLElement, url: string, site: WritingSite = resolveWritingSite(url)): EditorSnapshot {
    return {element, signature: signature(element), url, site};
}

function replyContextRoot(doc: Document, site: WritingSite, profile: WritingSiteProfile, editor?: HTMLElement): ParentNode | null {
    if (!editor) return doc;
    if (editor.ownerDocument !== doc || !editor.isConnected || !isWritingEditor(editor, site)) return null;
    if (site === 'github') {
        return editor.closest(githubReviewThread)
            ?? editor.closest('.js-inline-comment-form') ?? editor.closest('main');
    }
    return editor.closest(profile.contextRootSelector);
}

function isCssHidden(element: Element): boolean {
    const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
    return style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse';
}

function visibleContextElements(root: ParentNode, selector: string): HTMLElement[] {
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector))
        .filter(element => !element.closest(`${hiddenContent}, [contenteditable], ${excludedUi}`) && element.getClientRects().length > 0 && !isCssHidden(element));
    const candidateSet = new Set(candidates);
    // 嵌套的匹配节点只保留外层；沿祖先链查询避免评论数增长时逐对比较。
    return candidates.filter(element => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (candidateSet.has(parent)) return false;
        }
        return true;
    });
}

function contextText(element: HTMLElement, limit: number): string {
    const fragments: string[] = [];
    let length = 0;
    let node: Node | null = element.firstChild;
    // 不克隆原帖；按文档顺序遍历可见文本，预算耗尽后不再读后续节点或计算其样式。
    while (node && length < limit) {
        if (node.nodeType === 3) {
            const value = node.textContent!;
            const text = (length ? value : value.trimStart()).slice(0, limit - length);
            fragments.push(text); length += text.length;
        } else if (node.nodeType === 1) {
            const child = node as Element;
            if (!child.matches(contextExcluded) && !isCssHidden(child) && child.firstChild) {
                node = child.firstChild;
                continue;
            }
        }
        while (node && node !== element && !node.nextSibling) node = node.parentNode;
        if (!node || node === element) break;
        node = node.nextSibling;
    }
    return fragments.join('').trim();
}

function firstContextText(root: ParentNode, selector: string, limit: number, subjectInputSelector = ''): string {
    if (!selector) return '';
    for (const element of visibleContextElements(root, selector)) {
        // 仅显式命名的当前撰写窗口主题/标题字段可以读取 value，其余上下文只读取可见正文。
        const text = subjectInputSelector && element.matches(subjectInputSelector)
            ? (element as HTMLInputElement).value.trim()
            : contextText(element, limit);
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

function githubNewIssueIdentity(url: string): string {
    try {
        const parsed = new URL(url);
        const match = /^\/([\w.-]{1,100})\/([\w.-]{1,100})\/issues\/new\/?$/.exec(parsed.pathname);
        return parsed.origin === 'https://github.com' && match ? `当前项目：${match[1]}/${match[2]}\n帖子类型：新建 Issue` : '';
    } catch { return ''; }
}

function recentContextText(snippets: HTMLElement[], budget: number, authorContainerSelector: string, authorSelector: string): string {
    let remaining = budget;
    const texts: string[] = [];
    for (const element of snippets.slice(-12).reverse()) {
        const separatorLength = texts.length ? 2 : 0;
        if (remaining <= separatorLength) break;
        const body = contextText(element, remaining - separatorLength);
        if (!body) continue;
        const container = authorContainerSelector ? element.closest(authorContainerSelector) : null;
        const author = container && authorSelector ? firstContextText(container, authorSelector, 100) : '';
        const text = `${author ? `回复作者：${author}\n` : ''}${body}`.slice(0, remaining - separatorLength);
        remaining -= text.length + separatorLength;
        texts.unshift(text);
    }
    return texts.join('\n\n');
}

function genericEditorLabel(doc: Document, editor: HTMLElement): string {
    const aria = editor.getAttribute('aria-label')?.trim();
    if (aria) return aria.slice(0, 200);
    const id = editor.getAttribute('id')?.trim();
    const explicitLabel = id ? Array.from(doc.querySelectorAll<HTMLLabelElement>('label[for]')).find(label => label.getAttribute('for') === id) : undefined;
    const label = explicitLabel ?? editor.closest('label');
    if (label && !label.closest(`${hiddenContent}, ${excludedUi}`) && !isCssHidden(label)) {
        const labelText = contextText(label, 200);
        if (labelText) return labelText;
    }
    return (editor.getAttribute('placeholder') ?? '').trim().slice(0, 200);
}

function collectGenericContext(doc: Document, editor?: HTMLElement): string {
    if (editor && (editor.ownerDocument !== doc || !editor.isConnected || !isWritingEditor(editor, 'generic'))) return '';
    const title = (doc.title || '').trim().slice(0, 300);
    const label = editor ? genericEditorLabel(doc, editor) : '';
    const header = [
        title ? `页面标题：${title}` : '',
        label ? `输入提示：${label}` : '',
    ].filter(Boolean).join('\n');
    const scope = editor?.closest('article, main, section, [role="main"], [role="dialog"], form') ?? doc.body;
    const snippets = scope ? visibleContextElements(scope, 'h1, h2, h3, p, blockquote, li') : [];
    const sections = header ? [header] : [];
    const remaining = Math.min(4000, 12000 - header.length - (sections.length ? 2 : 0) - '页面参考：'.length);
    if (snippets.length && remaining > 0) {
        const text = recentContextText(snippets, remaining, '', '');
        if (text) sections.push(`页面参考：${text}`);
    }
    return sections.join('\n\n');
}

export function collectReplyContext(doc: Document, site: WritingSite, editor?: HTMLElement, url: string = doc.URL): string {
    if (site === 'generic') return collectGenericContext(doc, editor);
    const profile = getWritingSiteProfile(site);
    if (!profile) return '';
    const root = replyContextRoot(doc, site, profile, editor);
    if (!root) return '';
    const snippets = visibleContextElements(root, profile.snippetSelector);
    const inline = site === 'github' && Boolean(editor?.closest(`${githubReviewThread}, .js-inline-comment-form`));
    const titleRoot = (site === 'github' || site === 'reddit') && editor ? editor.closest('main') ?? root : root;
    const newIssue = site === 'github' && editor ? githubNewIssueIdentity(url) : '';
    const titleInput = newIssue ? editor!.closest('form')?.querySelector<HTMLInputElement>('input[name="issue[title]"], input#issue_title') : null;
    const title = newIssue
        ? titleInput && !titleInput.closest(`${hiddenContent}, ${excludedUi}`) && titleInput.getClientRects().length && !isCssHidden(titleInput) ? titleInput.value.trim().slice(0, 1000) : ''
        : firstContextText(titleRoot, profile.titleSelector, 1000, profile.subjectInputSelector);
    const original = site === 'github' && !inline ? snippets.find(element => element.closest(githubOriginalPost)) ?? snippets[0] : undefined;
    const starter = site === 'github' ? firstContextText(titleRoot, 'main [data-testid="issue-body"] [data-testid="issue-body-header-author"], main .js-issue .timeline-comment-header .author', 100) : '';
    const state = site === 'github' ? firstContextText(titleRoot, 'main [data-testid="header-state"], main .gh-header-meta .State', 100) : '';
    const header = [
        site === 'github' ? githubPageIdentity(url) || newIssue : '',
        title && profile.titleLabel ? `${profile.titleLabel}：${title}` : '',
        state ? `帖子状态：${state}` : '',
        starter ? `发起人：${starter}` : '',
    ].filter(Boolean).join('\n');
    const sections = header ? [header] : [];
    let remaining = 12000 - header.length;
    const comments = snippets.filter(element => element !== original);
    const originalLimit = remaining - (sections.length ? 2 : 0) - '原帖：'.length;
    const originalText = original ? contextText(original, comments.length ? Math.min(4000, originalLimit) : originalLimit) : '';
    if (originalText) {
        const prefixLength = (sections.length ? 2 : 0) + '原帖：'.length;
        // 有回复时为原帖保留最多 4000 字；其余预算从最近回复向前分配，标题永远不参与裁剪。
        const body = originalText.slice(0, comments.length ? Math.min(4000, remaining - prefixLength) : remaining - prefixLength);
        sections.push(`原帖：${body}`); remaining -= prefixLength + body.length;
    }
    if (comments.length) {
        const text = recentContextText(
            comments,
            remaining - (sections.length ? 2 : 0) - profile.sectionLabel.length - 1,
            profile.authorContainerSelector,
            profile.authorSelector,
        );
        if (text) sections.push(`${profile.sectionLabel}：${text}`);
    }
    return sections.join('\n\n');
}

export function resolveInitialWritingIntent(site: WritingSite, url: string, draft: string, context: string): WritingIntent {
    if (draft.trim()) return 'polish';
    if (!site || site === 'generic' || site === 'notion') return 'draft';
    if (site === 'gmail' || site === 'outlook') return /(?:^|\n\n)当前邮件：/.test(context) ? 'reply' : 'draft';
    if (site === 'github') return !githubNewIssueIdentity(url) && Boolean(context.trim()) ? 'reply' : 'draft';
    return Boolean(context.trim()) ? 'reply' : 'draft';
}

export function applyWritingDraft(snapshot: EditorSnapshot, text: string, url: string): string | undefined {
    const element = snapshot.element;
    if (url !== snapshot.url || !element.isConnected || !isWritingEditor(element, snapshot.site)) return '原编辑框已关闭或页面已变化，请复制正文后自行粘贴。';
    if (signature(element) !== snapshot.signature) return '原草稿已被修改。为保留你的新内容，请复制正文后自行粘贴。';
    if (hasManagedRichEditor(element)) return '当前富文本编辑器由页面框架托管，请复制正文后自行粘贴。';
    if (element.querySelector(richMediaSelector)) return '原草稿包含链接、附件或复杂格式，请复制正文后自行粘贴。';
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

/**
 * @file src/services/translation/context/browser.ts
 *
 * 文件职责：从当前浏览器页面捕获隐私受限、大小受控的翻译上下文，为页面摘要和大模型翻译提供可读背景。
 * 主要内容：克隆并清洗 DOM，排除表单、隐藏、脚本和敏感属性，优先使用 Defuddle 后回退正文提取，缓存 snapshot，并导出 getPageTranslationContext 与 resetPageTranslationContextCache。 可核对的公开符号包括 getPageTranslationContext、resetPageTranslationContextCache、聚合导出。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import {
    buildPageTranslationContext,
    normalizePageMarkdown,
    normalizePageText,
    pageContextLimits,
    shouldUseBoundedPageCapture,
} from './policy';

interface PageTranslationSnapshot {
    url: string;
    text: string;
    title: string;
    description: string;
}

interface CapturedReadablePage {
    url: string;
    documentSnapshot: Document | null;
    bodySnapshot: HTMLElement | null;
    boundedText: string | null;
}

interface PendingPageTranslationSnapshot {
    url: string;
    token: object;
    promise: Promise<PageTranslationSnapshot>;
}

let cachedSnapshot: PageTranslationSnapshot | null = null;
let pendingSnapshot: PendingPageTranslationSnapshot | null = null;
let snapshotGeneration = 0;
let defuddleModulePromise: Promise<typeof import('defuddle/full')> | null = null;

const PAGE_CONTEXT_EXCLUDED_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'svg', 'math', 'pre', 'code',
    'nav', 'aside', 'footer', 'form', 'button', 'input', 'textarea', 'select', 'option',
    '[hidden]', '[inert]', '[aria-hidden="true"]',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
    '[style*="display: none" i]', '[style*="visibility: hidden" i]',
    '[translate="no"]', '[data-notranslate]',
    '.fluent-read-bilingual-content', '.fluent-read-loading', '.fluent-read-retry-wrapper',
    '[data-fr-translation-owned="true"]', '[data-fr-temp-style]',
].join(',');

const SENSITIVE_SNAPSHOT_ATTRIBUTE = /^(?:value|checked|selected|name|autocomplete|title|aria-label|aria-description|aria-valuetext|href|src|srcset|action|formaction|poster|style|data-.+|on.+)$/iu;

function currentUrl(): string {
    if (typeof window !== 'undefined' && window.location) return window.location.href;
    if (typeof location !== 'undefined') return location.href;
    return '';
}

function sanitizePageContextSnapshot(root: ParentNode): void {
    // 步骤 1：移除表单、草稿、隐藏区、代码与扩展自有节点，避免交给可读性解析器。
    root.querySelectorAll(PAGE_CONTEXT_EXCLUDED_SELECTOR).forEach((node) => node.remove());

    // 步骤 2：剩余文章节点只保留文本结构；URL、data/event 与辅助输入属性都可能携带私密值。
    root.querySelectorAll('*').forEach((node) => {
        const element = node as Element;
        if (!element.attributes || typeof element.removeAttribute !== 'function') return;
        const names: string[] = [];
        for (let index = 0; index < element.attributes.length; index += 1) {
            const attribute = element.attributes.item(index);
            if (attribute && SENSITIVE_SNAPSHOT_ATTRIBUTE.test(attribute.name)) names.push(attribute.name);
        }
        names.forEach((name) => element.removeAttribute(name));
    });
}

function nodeFilterConstants(doc: Document) {
    const constants = doc.defaultView?.NodeFilter;
    return {
        showElement: constants?.SHOW_ELEMENT ?? 1,
        showText: constants?.SHOW_TEXT ?? 4,
        accept: constants?.FILTER_ACCEPT ?? 1,
        reject: constants?.FILTER_REJECT ?? 2,
    };
}

function exceedsDefuddleBudget(doc: Document): boolean {
    if (!doc.documentElement || typeof doc.createTreeWalker !== 'function') return false;
    const {showElement, showText} = nodeFilterConstants(doc);
    const walker = doc.createTreeWalker(doc.documentElement, showElement | showText);
    let elements = 0;
    let characters = 0;
    let markupCharacters = 0;
    let visited = 0;
    let current: Node | null = doc.documentElement;
    while (current) {
        visited += 1;
        if (current.nodeType === 1) {
            elements += 1;
            const attributes = (current as Element).attributes;
            for (let index = 0; index < attributes.length; index += 1) {
                const attribute = attributes.item(index);
                if (attribute) markupCharacters += attribute.name.length + attribute.value.length;
            }
        }
        else if (current.nodeType === 3) characters += current.nodeValue?.length ?? 0;
        if (shouldUseBoundedPageCapture({
            elements,
            textCharacters: characters,
            markupCharacters,
            visitedNodes: visited,
        })) return true;
        current = walker.nextNode();
    }
    return false;
}

function collectBoundedReadableText(doc: Document): string {
    const root = doc.querySelector?.('main, article, [role="main"]') || doc.body || doc.documentElement;
    if (!root) return '';
    if (typeof doc.createTreeWalker !== 'function') {
        return normalizePageText(root.textContent || '').slice(0, pageContextLimits.captureCharacters);
    }

    const {showElement, showText, accept, reject} = nodeFilterConstants(doc);
    const walker = doc.createTreeWalker(root, showElement | showText, {
        acceptNode: (node) => {
            if (node.nodeType !== 1) return accept;
            try {
                return (node as Element).matches(PAGE_CONTEXT_EXCLUDED_SELECTOR) ? reject : accept;
            } catch {
                return accept;
            }
        },
    });
    const parts: string[] = [];
    let visited = 0;
    let characters = 0;
    let current = walker.nextNode();
    while (current && visited < pageContextLimits.captureNodes && characters < pageContextLimits.captureCharacters) {
        visited += 1;
        if (current.nodeType === 3) {
            const value = current.nodeValue || '';
            if (value.trim()) {
                const remaining = pageContextLimits.captureCharacters - characters;
                parts.push(value.slice(0, remaining));
                characters += Math.min(value.length, remaining);
            }
        }
        current = walker.nextNode();
    }
    return normalizePageText(parts.join(' '));
}

function createDefuddleSnapshotDocument(): Document | null {
    if (typeof document === 'undefined') return null;

    // 脱离页面的 document 可防止解析器读取或修改实时页面。
    if (document.implementation?.createHTMLDocument && document.documentElement?.outerHTML) {
        const snapshot = document.implementation.createHTMLDocument(document.title);
        snapshot.documentElement.innerHTML = document.documentElement.outerHTML;
        sanitizePageContextSnapshot(snapshot);
        return snapshot;
    }

    return null;
}

function captureReadablePage(): CapturedReadablePage {
    const url = currentUrl();
    if (exceedsDefuddleBudget(document)) {
        return {
            url,
            documentSnapshot: null,
            bodySnapshot: null,
            boundedText: collectBoundedReadableText(document),
        };
    }
    let documentSnapshot: Document | null = null;
    try {
        documentSnapshot = createDefuddleSnapshotDocument();
    } catch (error) {
        console.warn('[FluentRead] failed to capture detached document snapshot:', error);
    }

    let bodySnapshot: HTMLElement | null = null;
    if (!documentSnapshot) {
        try {
            bodySnapshot = document.body?.cloneNode(true) as HTMLElement | null;
            if (bodySnapshot) sanitizePageContextSnapshot(bodySnapshot);
        } catch (error) {
            console.warn('[FluentRead] failed to capture detached body snapshot:', error);
        }
    }
    return {url, documentSnapshot, bodySnapshot, boundedText: null};
}

function loadDefuddleModule(): Promise<typeof import('defuddle/full')> {
    if (defuddleModulePromise) return defuddleModulePromise;
    const pending = import('defuddle/full');
    const wrapped = pending.catch((error) => {
        if (defuddleModulePromise === wrapped) defuddleModulePromise = null;
        throw error;
    });
    defuddleModulePromise = wrapped;
    return defuddleModulePromise;
}

async function extractReadablePageText(source: CapturedReadablePage): Promise<string> {
    if (source.boundedText !== null) return source.boundedText;
    try {
        const {default: Defuddle, createMarkdownContent} = await loadDefuddleModule();
        const snapshot = source.documentSnapshot;

        if (snapshot) {
            const result = await Promise.resolve(new Defuddle(snapshot, {
                separateMarkdown: true,
                url: source.url,
                useAsync: false,
            }).parse());

            if (result.contentMarkdown) return normalizePageMarkdown(result.contentMarkdown);
            if (result.content && createMarkdownContent) {
                return normalizePageMarkdown(createMarkdownContent(result.content, source.url));
            }
        }
    } catch (error) {
        // 正文提取属于增强能力；解析器或 runtime 失败不能阻止正常翻译请求发送。
        console.warn('[FluentRead] readable page extraction failed; using body text:', error);
    }

    const fallback = source.documentSnapshot?.body || source.bodySnapshot;
    return normalizePageText(fallback?.innerText || fallback?.textContent || '');
}

async function getReadablePageSnapshot(): Promise<PageTranslationSnapshot | null> {
    if (typeof document === 'undefined') return null;

    const url = currentUrl();
    if (cachedSnapshot?.url === url) return cachedSnapshot;
    if (pendingSnapshot?.url === url) return pendingSnapshot.promise;

    const generation = snapshotGeneration;
    const token = {};
    const title = normalizePageText(document.title || '');
    const description = getDocumentDescription();
    // 在第一次 await 前捕获脱离页面的源文档，防止动态导入 Defuddle 期间的 SPA 导航
    // 把旧标题与新路由正文混在一起。
    const source = captureReadablePage();
    const promise = extractReadablePageText(source).then((readableText): PageTranslationSnapshot => {
        const text = readableText.slice(0, pageContextLimits.content);
        const snapshot = {url, text, title, description};
        if (snapshotGeneration === generation &&
            currentUrl() === url &&
            pendingSnapshot?.token === token) {
            cachedSnapshot = snapshot;
        }
        return snapshot;
    });
    const pending = {url, token, promise};
    pendingSnapshot = pending;
    try {
        return await promise;
    } finally {
        if (pendingSnapshot === pending) pendingSnapshot = null;
    }
}

function getDocumentDescription(): string {
    if (typeof document === 'undefined') return '';

    for (const selector of [
        'meta[name="description"]',
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
    ]) {
        const value = normalizePageText(document.querySelector(selector)?.getAttribute('content') || '');
        if (value) return value;
    }
    return '';
}

/**
 * 为 LLM 翻译提取有长度上限的页面级参考上下文。
 * 返回内容仅作为参考数据；template.ts 会补充 prompt 边界，以及不得遵循页面内文本的指令。
 */
export async function getPageTranslationContext(): Promise<string> {
    if (typeof document === 'undefined') return '';

    const snapshot = await getReadablePageSnapshot();
    return buildPageTranslationContext({
        title: snapshot?.title,
        description: snapshot?.description,
        readableText: snapshot?.text,
    });
}

export function resetPageTranslationContextCache(): void {
    snapshotGeneration += 1;
    cachedSnapshot = null;
    pendingSnapshot = null;
}

export {pageContextLimits} from './policy';

/**
 * @file src/services/translation/context/browser.ts
 *
 * 文件职责：从当前浏览器页面捕获隐私受限、大小受控的翻译上下文，为页面摘要和大模型翻译提供可读背景。
 * 主要内容：通过 importNode 克隆并清洗 DOM，排除表单、隐藏、脚本和敏感属性；大型页面有界捕获也检查根节点及祖先，先消耗包含空白的原始字符预算再归一化，避免绕过排除与开销边界。按需加载 Defuddle core 与结构化 Markdown 适配器，失败时回退正文提取，缓存 snapshot，并导出 getPageTranslationContext 与 resetPageTranslationContextCache。
 * 模块边界：本文件位于翻译 application service 层，负责用例编排和端口契约；不挂载页面 UI，且不应把某家供应商的网络细节扩散到 feature，具体 HTTP 协议由 providers/platform 实现。
 */

import {
    buildPageTranslationContext,
    normalizePageMarkdown,
    normalizePageText,
    pageContextLimits,
    shouldUseBoundedPageCapture,
} from './policy';
import {resetPageDiscourseContext} from './pageDiscourse';

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
interface ReadablePageExtractor {
    Defuddle: typeof import('defuddle')['default'];
    createReadablePageMarkdown: typeof import('./markdown')['createReadablePageMarkdown'];
}

let defuddleModulePromise: Promise<ReadablePageExtractor> | null = null;

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
        else if (current.nodeType === 3) characters += current.nodeValue!.length;
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

// Called synchronously after exceedsDefuddleBudget has established a root and TreeWalker.
function collectBoundedReadableText(doc: Document): string {
    const root = doc.querySelector?.('main, article, [role="main"]') || doc.body || doc.documentElement;
    // TreeWalker 的过滤器不检查 root，也看不到 root 外的祖先。
    // 草稿、隐藏文章和扩展自有正文不能因有界捕获选择了它们作为根而进入提示词。
    if (root.closest?.(PAGE_CONTEXT_EXCLUDED_SELECTOR)) return '';

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
            const value = current.nodeValue!;
            const clipped = value.slice(0, pageContextLimits.captureCharacters - characters);
            characters += clipped.length;
            if (clipped.trim()) parts.push(clipped);
        }
        current = walker.nextNode();
    }
    return normalizePageText(parts.join(' '));
}

function createDefuddleSnapshotDocument(): Document | null {

    // 脱离页面的 document 可防止解析器读取或修改实时页面。
    if (document.implementation?.createHTMLDocument && document.documentElement) {
        const snapshot = document.implementation.createHTMLDocument(document.title);
        // 复制节点保留原有 HTML/SVG/MathML 语义，避免序列化后重新解析宿主字符串。
        // 目标 document 没有浏览上下文；清洗后才会交给正文提取器，永不插回 live DOM。
        const root = snapshot.importNode(document.documentElement, true);
        snapshot.replaceChild(root, snapshot.documentElement);
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
            const body = document.body;
            // 克隆后的 body 已脱离祖先；先在原文档检查自身及祖先是否属于排除范围。
            if (body && typeof body.closest === 'function' && !body.closest(PAGE_CONTEXT_EXCLUDED_SELECTOR)) {
                const clone = body.cloneNode(true) as HTMLElement;
                // 只有清洗成功才能发布回退副本；异常时绝不返回部分清洗的正文。
                sanitizePageContextSnapshot(clone);
                bodySnapshot = clone;
            }
        } catch (error) {
            console.warn('[FluentRead] failed to capture detached body snapshot:', error);
        }
    }
    return {url, documentSnapshot, bodySnapshot, boundedText: null};
}

function loadDefuddleModule(): Promise<ReadablePageExtractor> {
    if (defuddleModulePromise) return defuddleModulePromise;
    const pending = Promise.all([import('defuddle'), import('./markdown')])
        .then(([{default: Defuddle}, {createReadablePageMarkdown}]) => ({Defuddle, createReadablePageMarkdown}));
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
        const {Defuddle, createReadablePageMarkdown} = await loadDefuddleModule();
        const snapshot = source.documentSnapshot;

        if (snapshot) {
            const result = await Promise.resolve(new Defuddle(snapshot, {
                url: source.url,
                useAsync: false,
            }).parse());

            if (result.content) return normalizePageMarkdown(createReadablePageMarkdown(result.content, snapshot));
        }
    } catch (error) {
        // 正文提取属于增强能力；解析器或 runtime 失败不能阻止正常翻译请求发送。
        console.warn('[FluentRead] readable page extraction failed; using body text:', error);
    }

    const fallback = source.documentSnapshot?.body || source.bodySnapshot;
    return normalizePageText(fallback?.innerText || fallback?.textContent || '');
}

async function getReadablePageSnapshot(): Promise<PageTranslationSnapshot> {

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
        title: snapshot.title,
        description: snapshot.description,
        readableText: snapshot.text,
    });
}

export function resetPageTranslationContextCache(): void {
    resetPageDiscourseContext();
    invalidatePageTranslationSnapshotCache();
}

/** 原文已变化时使页面快照/摘要身份重建，保留调用方正在准备的篇章所有权。 */
export function invalidatePageTranslationSnapshotCache(): void {
    snapshotGeneration += 1;
    cachedSnapshot = null;
    pendingSnapshot = null;
}

export {pageContextLimits} from './policy';

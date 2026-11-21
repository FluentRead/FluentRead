/**
 * @file src/features/document-translation/content/extractWebArticle.ts
 * 文件职责：为文档翻译从用户当前打开的网页提取一份有界的正文 HTML 快照。
 * 主要内容：同步复制仍可见的原文节点，排除交互区和插件译文，保留仅译文模式藏在轻 DOM 的原文；在脱离页面的文档中运行 Defuddle，并在送入文档工作台前重新清洗并保留标题、链接和结构。超出完整捕获预算时可缩小到语义正文区，无法完整捕获时返回明确状态。
 * 模块边界：只读取已经加载的页面，不改变原站 DOM、不加载第三方资源、不持久化内容、不调用翻译服务；触发时机和路由有效性由内容消息入口负责。
 */
import {
    getElementTagName, hasContentEditableMarker, hasNoTranslateMarker, isDocumentSurfaceNoTranslateShell,
    isExtensionElementSelf, isHiddenTranslationElement,
} from '@/src/core/translation/dom';
import {
    MAX_WEB_ARTICLE_BYTES, MAX_WEB_ARTICLE_TITLE_LENGTH, normalizeWebArticleUrl, type WebArticleSnapshot,
} from '@/src/features/document-translation/core/webArticle';

export type WebArticleExtraction =
    | ({status: 'ok'} & WebArticleSnapshot)
    | {status: 'no-article' | 'too-large' | 'unavailable'};

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MATH_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const MAX_CAPTURE_NODES = 12_000;
const MAX_CAPTURE_DEPTH = 192;
const EXCLUDED = 'script,style,noscript,template,link,meta,base,iframe,object,embed,svg,canvas,audio,video,nav,aside,footer,form,button,input,textarea,select,option,[role="navigation"],[role="complementary"],[role="contentinfo"],[role="dialog"],[role="textbox"],[role="searchbox"],[role="combobox"],[hidden],[inert],[aria-hidden="true"]';
const ORIGINAL_WRAPPER = 'span.fluent-read-single-slot[data-fr-translation-owned="true"], span[data-fr-translation-segment="true"]';
const ARTICLE_ROOT = 'article,[itemprop="articleBody"]';
const CONTENT_ROOT = 'main,[role="main"]';
const HEADINGS = 'h1,h2,h3,h4,h5,h6';
const ARTICLE_HTML = new Set('a abbr article b blockquote br caption cite code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p pre q s samp section small span strong sub summary sup table tbody td th thead tfoot tr u ul var'.split(' '));
const ARTICLE_MATH = new Set('math annotation merror mfenced mfrac mi mmultiscripts mn mo mover mpadded mphantom mprescripts mroot mrow ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover none semantics'.split(' '));
const TABLE_ATTRS = ['rowspan', 'colspan', 'span', 'start'];
const EXPANDED_TAGS = new Map([['details', 'div'], ['summary', 'p']]);

function isExcluded(element: Element, ownSourceWrapper = false): boolean {
    return element.matches(EXCLUDED) || hasContentEditableMarker(element) ||
        // 文档翻译把 Markdown 代码作为原文保护；技术网站常标记代码不译，阅读页仍需保留。
        (!ownSourceWrapper && hasNoTranslateMarker(element) && !isDocumentSurfaceNoTranslateShell(element) && !element.matches('pre,code')) ||
        isHiddenTranslationElement(element);
}

interface CopyFrame {next: ChildNode | null; destination: Element;}

/** 使用逐层游标限制空间与总遍历开销，跳过整个排除子树，不将页面的原始属性复制到脱离文档。 */
function copyArticleTree(source: Element, target: Element, sourceUrl: string, isLiveCapture: boolean): boolean {
    const document = target.ownerDocument;
    const frames: CopyFrame[] = [{next: source.firstChild, destination: target}];
    let nodes = 0, characters = 0;
    while (frames.length) {
        const frame = frames[frames.length - 1];
        const node = frame.next;
        if (!node) { frames.pop(); continue; }
        frame.next = node.nextSibling;
        if (++nodes > MAX_CAPTURE_NODES || frames.length > MAX_CAPTURE_DEPTH) return false;
        if (node.nodeType === 3) {
            const text = (node as Text).data;
            characters += text.length;
            if (characters > MAX_WEB_ARTICLE_BYTES) return false;
            frame.destination.appendChild(document.createTextNode(text));
            continue;
        }
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        const unwrapOriginal = isLiveCapture && element.matches(ORIGINAL_WRAPPER);
        if (isExcluded(element, unwrapOriginal) || (isLiveCapture && !unwrapOriginal && isExtensionElementSelf(element))) continue;
        const sourceTag = getElementTagName(element);
        const html = element.namespaceURI === HTML_NAMESPACE;
        const math = element.namespaceURI === MATH_NAMESPACE;
        if (!html && !math) continue;
        const tag = isLiveCapture && html && element.matches(ARTICLE_ROOT) ? 'article' :
            isLiveCapture && html && element.matches(CONTENT_ROOT) ? 'main' : sourceTag;
        if (math && !ARTICLE_MATH.has(tag)) continue;

        let destination = frame.destination;
        if (!unwrapOriginal && (math || ARTICLE_HTML.has(tag) || isLiveCapture)) {
            // 折叠区转换为展开的正文，队列和导出可以使用同一份文本结构。
            const projectedTag = isLiveCapture ? tag : EXPANDED_TAGS.get(tag) ?? tag;
            destination = document.createElementNS(element.namespaceURI, html && !ARTICLE_HTML.has(tag) ? 'div' : projectedTag);
            if (html) {
                if (tag === 'a') {
                    const href = normalizeWebArticleUrl(element.getAttribute('href'), sourceUrl);
                    if (href) {
                        characters += href.length;
                        if (characters > MAX_WEB_ARTICLE_BYTES) return false;
                        destination.setAttribute('href', href);
                    }
                }
                // 类名供 Defuddle 判断非语义页面的侧栏等。最终输出只保留投影器识别的提示块和脚注标识。
                const className = element.classList.value;
                if (className) {
                    const articleClass = isLiveCapture ? className.slice(0, 256) :
                        className.split(/\s+/u).filter(value => /^callout(?:-title|-title-inner|-content)?$/u.test(value)).join(' ');
                    if (articleClass) destination.setAttribute('class', articleClass);
                }
                for (const name of TABLE_ATTRS) {
                    const value = element.getAttribute(name) ?? '';
                    if (/^\d{1,5}$/u.test(value)) destination.setAttribute(name, value);
                }
                const alt = tag === 'img' ? element.getAttribute('alt') : null;
                if (alt) destination.setAttribute('alt', alt.slice(0, 512));
                const id = element.getAttribute('id') ?? '';
                if (/^(?:footnotes|fn(?:ref)?:[\w-]{1,64})$/u.test(id)) destination.setAttribute('id', id);
                const callout = element.getAttribute('data-callout') ?? '';
                if (/^[\w-]{1,24}$/u.test(callout)) destination.setAttribute('data-callout', callout);
            } else {
                if (tag === 'annotation' && element.getAttribute('encoding') === 'application/x-tex') {
                    destination.setAttribute('encoding', 'application/x-tex');
                }
                if (tag === 'math' && element.getAttribute('display') === 'block') destination.setAttribute('display', 'block');
            }
            frame.destination.appendChild(destination);
        }
        if (element.firstChild) frames.push({next: element.firstChild, destination});
    }
    return true;
}

function canCaptureRoot(root: Element): boolean {
    let ancestor: Element | null = root;
    for (let depth = 0; ancestor; depth += 1, ancestor = ancestor.parentElement) {
        if (depth > MAX_CAPTURE_DEPTH || isExcluded(ancestor) || isExtensionElementSelf(ancestor)) return false;
    }
    return true;
}

function captureArticle(source: Document, sourceUrl: string) {
    const body = source.body;
    if (!body || !canCaptureRoot(body)) return {status: 'no-article'} as const;
    const snapshot = source.implementation.createHTMLDocument(source.title.slice(0, MAX_WEB_ARTICLE_TITLE_LENGTH));
    if (copyArticleTree(body, snapshot.body, sourceUrl, true)) {
        return {status: 'captured', snapshot, hasArticleLandmark: snapshot.querySelectorAll('article').length === 1 || Boolean(snapshot.querySelector('main h1'))} as const;
    }
    const article = body.querySelector('main article, [role="main"] article') ?? body.querySelector(ARTICLE_ROOT);
    const candidate = article ?? body.querySelector(CONTENT_ROOT);
    if (!candidate || !canCaptureRoot(candidate)) return {status: 'too-large'} as const;
    // 失败的前半页不参与导入，重新从完整语义区捕获。
    snapshot.body.replaceChildren();
    const section = snapshot.createElement(article ? 'article' : 'main');
    snapshot.body.appendChild(section);
    return copyArticleTree(candidate, section, sourceUrl, true)
        ? {status: 'captured', snapshot, hasArticleLandmark: article !== null} as const
        : {status: 'too-large'} as const;
}

/** 短文章可由显式正文地标佐证；无地标时要求至少一段可阅读的连续正文。 */
function hasReadableProse(root: Element, hasArticleLandmark: boolean): boolean {
    const minimumLength = hasArticleLandmark ? 24 : 96;
    return Array.from(root.querySelectorAll('p,blockquote,li,dd,td')).some((block) => {
        // 元素的 textContent 恒为字符串。以字符权重适配连续书写的文本，避免英文阈值误筛。
        const text = block.textContent!.replace(/\s+/gu, ' ').trim();
        const weightedText = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, '$&$&');
        return weightedText.length >= minimumLength;
    });
}

function headingText(heading: Element): string {
    return heading.textContent!.replace(/\s+/gu, ' ').trim();
}

export async function extractWebArticle(source: Document, sourceUrl: string): Promise<WebArticleExtraction> {
    try {
        // 先快照再等待解析器，路由在 await 期间变化时也不能读到另一个页面的 DOM。
        const capture = captureArticle(source, sourceUrl);
        if (capture.status !== 'captured') return capture;
        const {snapshot, hasArticleLandmark} = capture;
        const sourceHeading = snapshot.querySelector('article h1') ?? snapshot.querySelector('main h1');
        const heading = snapshot.createElement('h1');
        if (sourceHeading) copyArticleTree(sourceHeading, heading, sourceUrl, false);
        const sourceTitle = headingText(heading);
        const {default: Defuddle} = await import('defuddle');
        const result = new Defuddle(snapshot, {url: sourceUrl, useAsync: false}).parse();
        if (result.content.length > MAX_WEB_ARTICLE_BYTES * 4) return {status: 'too-large'};

        const parsed = snapshot.createElement('div');
        parsed.innerHTML = result.content;
        const safe = snapshot.createElement('article');
        if (!copyArticleTree(parsed, safe, sourceUrl, false)) return {status: 'too-large'};
        if (!hasReadableProse(safe, hasArticleLandmark)) return {status: 'no-article'};
        const parsedTitle = result.title.trim();
        const extractedHeadings = safe.querySelectorAll(HEADINGS);
        const matchingHeading = sourceTitle && Array.from(extractedHeadings).find(item => headingText(item) === sourceTitle);
        const title = (matchingHeading ? sourceTitle : parsedTitle || snapshot.title).trim().slice(0, MAX_WEB_ARTICLE_TITLE_LENGTH);
        // 沿用已有标题级别并恢复行内结构。没有原文标题可恢复且正文完全没有标题时，使用安全的页面标题纯文本。
        if (matchingHeading) matchingHeading.replaceChildren(...Array.from(heading.childNodes));
        else if (sourceTitle && sourceTitle === parsedTitle.replace(/\s+/gu, ' ')) safe.prepend(heading);
        else if (!extractedHeadings.length && title) {
            heading.textContent = title;
            safe.prepend(heading);
        }
        const html = '<!doctype html>' + safe.outerHTML;
        if (new TextEncoder().encode(html).length > MAX_WEB_ARTICLE_BYTES) return {status: 'too-large'};
        return {status: 'ok', title, html, sourceUrl};
    } catch {
        return {status: 'unavailable'};
    }
}

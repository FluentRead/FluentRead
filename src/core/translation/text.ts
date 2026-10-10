/**
 * @file src/core/translation/text.ts
 *
 * 文件职责：提取和校验候选中的可读文本，拒绝标识符、独立时间与数值（含拆分行内节点的展示）、空白、扩展译文及脚本、表单或敏感区域的节点。
 * 主要内容：提供文本规范化、仅确认至少两个 Unicode 字母的 meaningful 判定与共享的 identifier 模式判定、元素与文本节点保护检查、嵌套 tooltip 来源隔离、WeakMap 状态缓存和受预算约束的深度扫描；语言预检副本保留真实行内邻接，在换行、语义块和保护省略处保留边界，不改动翻译槽。 可核对的公开符号包括 normalizeTranslationText、isIdentifierLikeText、isMeaningfulTranslationText、setMinimumTranslationTextLength、isTranslationTextNodeProtected、TranslationTextProtectionCache、createTranslationTextProtectionCache、isTranslationTextElementProtected、hasMeaningfulTranslationTextInNodes。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期；文本语言与同目标跳过统一由 src/core/language 判断。
 */

import {
    getTranslatableControlValueAttribute,
    isTextInNestedTranslationTooltip,
    getComposedParent,
    getElementTagName,
    isProtectedDescendantElement,
    maxComposedAncestorDepth,
} from './dom';
import type {TranslationTextProtectionOptions} from './dom';
import {isNonTranslatableLiveData} from './liveData';
import {isAcronymWord, isMixedCaseName, isNameVariantWord, isTechnicalAbbreviation} from '@/src/core/language/technicalTokens';
import {FUNCTION_WORDS} from '@/src/core/language/lexicon';
import {
    DEFAULT_MIN_TRANSLATION_TEXT_LENGTH,
    normalizeMinTranslationTextLength,
} from '@/src/core/config/pageTranslation';

const identifierPatterns = [
    /^https?:\/\/\S+$/iu,
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:/?#]\S*)?$/iu,
    /^\S+@\S+\.\S+$/u,
    /^@[\p{L}\p{N}_-]+$/u,
    /^u\/[\p{L}\p{N}_-]+$/u,
    /^#[0-9]+$/u,
    /^[a-f0-9]{7,40}$/iu,
    /^\d+(?:[.,:/-]\d+)*(?:%|[a-z]+)?$/iu,
    /^[\p{L}\p{N}_.-]+\.(?:js|ts|tsx|jsx|vue|json|css|html|md|py|rs|go|java|c|cpp|h)$/iu,
];

export function normalizeTranslationText(value: string): string {
    return value.replace(/[\s\u3000]+/gu, ' ').trim();
}

function matchesIdentifierPatterns(text: string): boolean {
    return identifierPatterns.some((pattern) => pattern.test(text));
}

export function isIdentifierLikeText(value: string): boolean {
    const text = normalizeTranslationText(value);
    return Boolean(text && matchesIdentifierPatterns(text));
}

// 非全局匹配确认第二个字母后即可结束，不为长正文分配全部字母的结果数组。
const meaningfulLetters = /\p{L}.*?\p{L}/u;

// 阈值由应用层在读取配置后注入；core 自身不访问存储，默认与历史行为一致。
let minimumTranslationTextLength = DEFAULT_MIN_TRANSLATION_TEXT_LENGTH;

/** 设置段落参与翻译所需的最少字符数，返回归一化后的实际阈值。 */
export function setMinimumTranslationTextLength(value: unknown): number {
    minimumTranslationTextLength = normalizeMinTranslationTextLength(value);
    return minimumTranslationTextLength;
}

export function isMeaningfulTranslationText(value: string): boolean {
    const text = normalizeTranslationText(value);
    if (!text || matchesIdentifierPatterns(text) || isNonTranslatableLiveData(text)) return false;
    // 字符长度按用户设定过滤短碎片；字母数仍保留原有的纯符号与编号防护。
    if (text.length < minimumTranslationTextLength) return false;
    return meaningfulLetters.test(text);
}

export function isTranslationTextNodeProtected(
    node: Text,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
    protectionCache = createTranslationTextProtectionCache(),
): boolean {
    const parent = node.parentElement;
    if (!parent || isNonTranslatableLiveData(node.nodeValue ?? '')) return true;
    // 同一次同步提取中的文本节点共享祖先；调用方传入缓存时只在相同判定参数下复用。
    return isTranslationTextElementProtected(
        parent,
        shouldStayOriginal,
        protectionCache,
        protectionOptions,
        ignoredExtensionElement,
    );
}

const languageContextBlockTags = /^(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)$/u;

/** 只供识别副本区分相邻行内文字和不同语义块；不反向依赖候选 layout 模块。 */
function languageContextBlockOwner(element: Element, cache: WeakMap<Element, Element | null>): Element | null {
    const chain: Element[] = [];
    let current: Element | null = element;
    while (current && !cache.has(current) && chain.length < maxComposedAncestorDepth) {
        if (languageContextBlockTags.test(getElementTagName(current))) break;
        try {
            const display = current.ownerDocument.defaultView?.getComputedStyle(current).display;
            if (display && display !== 'none' && display !== 'contents' && !/^(?:inline|ruby)/u.test(display)) break;
        } catch {
            // 无布局能力的文档仍沿语义标签寻找边界。
        }
        chain.push(current);
        current = getComposedParent(current);
    }
    const owner = current && cache.has(current) ? cache.get(current)! : current;
    for (const item of chain) cache.set(item, owner);
    if (current) cache.set(current, owner);
    return owner;
}

/** 与文本保护使用同一 composed 祖先，跨 ShadowRoot host 且只读取当前候选 roots；每个祖先只查询一次。 */
function languageContextCodeOwner(element: Element, cache: WeakMap<Element, Element | null>): Element | null {
    const chain: Element[] = [];
    let current: Element | null = element;
    while (current && !cache.has(current) && chain.length < maxComposedAncestorDepth) {
        if (getElementTagName(current) === 'code') break;
        chain.push(current);
        current = getComposedParent(current);
    }
    const owner = current && cache.has(current) ? cache.get(current)! : current && getElementTagName(current) === 'code' ? current : null;
    for (const item of chain) cache.set(item, owner);
    if (current) cache.set(current, owner);
    return owner;
}

type InlineCodeLanguageContext = 'name' | 'identifier' | 'neutral';

/** 名称保留字形；明确短标识符成为无字母原子，自然代码只留不串词的中性边界。 */
function inlineCodeLanguageContext(element: Element): InlineCodeLanguageContext {
    const value = element.textContent!.trim();
    if (value.length > 64) return 'neutral';
    const words = value.split(/[ \t/→-]+/u);
    const hasFunctionWord = (word: string): boolean => Object.values(FUNCTION_WORDS.Latin).some(functionWords => functionWords.has(word.toLowerCase()));
    const named = words.length <= 3 && words.every((word, index) => {
        const variant = index > 0 && isNameVariantWord(word) && (isAcronymWord(words[0]!) || isMixedCaseName(words[0]!));
        return (variant || !hasFunctionWord(word))
            && (isTechnicalAbbreviation(word) || isMixedCaseName(word) || isAcronymWord(word) || /^[A-Z][a-z]{1,23}$/u.test(word));
    });
    if (named) return 'name';
    if (!words.some(hasFunctionWord) && (/^[a-z][\w$]{0,23}$/u.test(value)
        || /^[a-z][\w$]*(?:→[a-z][\w$]*(?:[ \t][a-z][\w$]*){0,2})+$/u.test(value))) return 'identifier';
    return 'neutral';
}

function collectReadableText(
    roots: readonly Node[],
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): string {
    const parts: string[] = [];
    const languageContext = protectionOptions?.includeInlineCodeForLanguage === true;
    const blockOwners = new WeakMap<Element, Element | null>();
    const codeOwners = new WeakMap<Element, Element | null>();
    const codeContexts = new WeakMap<Element, InlineCodeLanguageContext>();
    const emittedCodes = new WeakSet<Element>();
    let previousBlock: Element | null | undefined;
    let previousRoot: Node | undefined;
    const append = (node: Text): void => {
        if (!languageContext) {
            const value = normalizeTranslationText(node.nodeValue ?? '');
            if (value) parts.push(value);
            return;
        }
        const block = languageContextBlockOwner(node.parentElement!, blockOwners);
        if (previousBlock !== undefined && previousBlock !== block) parts.push('\n');
        previousBlock = block;
        const code = languageContextCodeOwner(node.parentElement!, codeOwners);
        if (code) {
            let context = codeContexts.get(code);
            if (context === undefined) {
                context = inlineCodeLanguageContext(code);
                codeContexts.set(code, context);
            }
            if (context !== 'name') {
                if (!emittedCodes.has(code)) {
                    // U+FFFC 表示明确代码原子；U+FFFD 只阻断名称串联，不提供技术锚点。
                    parts.push(context === 'identifier' ? '\uFFFC' : '\uFFFD');
                    emittedCodes.add(code);
                }
                return;
            }
        }
        parts.push(node.nodeValue ?? '');
    };
    // 每个文本节点都要复核完整祖先链；长文章中相邻文本共享祖先，逐节点重算会随正文规模二次增长。
    const protectionCache = createTranslationTextProtectionCache();
    for (const root of roots) {
        if (languageContext && previousRoot && previousRoot.nextSibling !== root) parts.push('\n');
        previousRoot = root;
        if (root.nodeType === 3) {
            const textNode = root as Text;
            if (!isTranslationTextNodeProtected(
                textNode,
                shouldStayOriginal,
                ignoredExtensionElement,
                protectionOptions,
                protectionCache,
            )) {
                append(textNode);
            } else if (languageContext) {
                parts.push('\n');
            }
            continue;
        }
        if (root.nodeType !== 1) continue;
        const element = root as Element;
        // 按钮型 input 的可见标签只存在于 value 属性里。仅当它本身就是候选根时才读取：
        // 外层容器的译文经由文本槽或双语骨架渲染，无法写回子元素属性，把属性文本混进去
        // 只会让服务端翻译一段永远显示不出来的内容。
        const controlValueAttribute = getTranslatableControlValueAttribute(element);
        if (controlValueAttribute) {
            // 属性判定已确认该标签存在且非空白，这里只做与文本节点一致的空白归一。
            parts.push(normalizeTranslationText(element.getAttribute(controlValueAttribute)!));
            continue;
        }
        const document = element.ownerDocument;
        if (!document?.createTreeWalker) continue;
        const walker = document.createTreeWalker(element, languageContext ? 5 : 4);
        let current = walker.nextNode();
        while (current) {
            if (current.nodeType === 1) {
                if (getElementTagName(current as Element) === 'br') parts.push('\n');
                current = walker.nextNode();
                continue;
            }
            const textNode = current as Text;
            if (!isTextInNestedTranslationTooltip(textNode, element) && !isTranslationTextNodeProtected(
                textNode,
                shouldStayOriginal,
                ignoredExtensionElement,
                protectionOptions,
                protectionCache,
            )) {
                append(textNode);
            } else if (languageContext) {
                parts.push('\n');
            }
            current = walker.nextNode();
        }
    }
    // 换行分开正文句子，不把不同可见行或保护边界两侧的外语拼成一个名称。
    return languageContext ? parts.join('').replace(/[\t \u3000]+/gu, ' ').trim()
        : normalizeTranslationText(parts.join(' '));
}

const discoveryTextNodeBudget = 256;
const discoveryCharacterBudget = 8192;
const discoveryVisitedNodeBudget = 2048;

interface TranslationTextProtectionState {
    depth: number;
    protected: boolean;
}

export type TranslationTextProtectionCache = WeakMap<Element, TranslationTextProtectionState>;
// 原始 DOM 保护与祖先继承分开缓存；展示扫描提前读取的子元素不会重复强制布局。
const rawProtectionCaches = new WeakMap<TranslationTextProtectionCache, WeakMap<Element, boolean>>();

export function createTranslationTextProtectionCache(): TranslationTextProtectionCache {
    return new WeakMap<Element, TranslationTextProtectionState>();
}

const liveDataInlineTags = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'del', 'em', 'i', 'ins',
    'label', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'wbr']);

/** 有界读取同行内展示值；跳过禁译后代，不跨段落把数值和普通单位拼成时长。 */
function isLiveDataDisplay(element: Element, isProtected: (element: Element) => boolean): boolean {
    const stack: Node[] = [element];
    let text = '';
    let visited = 0;
    while (stack.length) {
        const node = stack.pop()!;
        visited += 1;
        if (node.nodeType === 3) {
            const value = node.nodeValue ?? '';
            if (text.length + value.length > 128) return false;
            text += value;
        } else {
            if (node !== element && node.nodeType === 1) {
                const descendant = node as Element;
                if (isProtected(descendant)) continue;
                if (!liveDataInlineTags.has(getElementTagName(descendant))) return false;
            }
            const children = node.childNodes;
            if (visited + stack.length + children.length > 32) return false;
            for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
        }
    }
    return isNonTranslatableLiveData(text);
}

/**
 * 在一次悬浮或发现操作中缓存继承的文本保护状态。调用方从祖先向子节点遍历时，
 * 根节点之后的每次查询都是 O(1)。若脏子树的外部祖先已经恶意过深，完成一次
 * 有界查询后便保守标记为受保护。
 */
export function isTranslationTextElementProtected(
    element: Element,
    shouldStayOriginal: ((element: Element) => boolean) | undefined,
    protectionCache: TranslationTextProtectionCache,
    protectionOptions?: TranslationTextProtectionOptions,
    ignoredExtensionElement?: Element,
): boolean {
    const cached = protectionCache.get(element);
    if (cached) return cached.protected;

    const rawCache = rawProtectionCaches.get(protectionCache) ?? new WeakMap<Element, boolean>();
    rawProtectionCaches.set(protectionCache, rawCache);
    const isProtected = (item: Element): boolean => {
        const cached = rawCache.get(item);
        if (cached !== undefined) return cached;
        const protectedSelf = isProtectedDescendantElement(item, item === ignoredExtensionElement, protectionOptions);
        rawCache.set(item, protectedSelf);
        return protectedSelf;
    };

    const chain: Element[] = [];
    let current: Element | null = element;
    while (current && !protectionCache.has(current)) {
        if (chain.length >= maxComposedAncestorDepth) {
            protectionCache.set(element, {
                depth: maxComposedAncestorDepth + 1,
                protected: true,
            });
            return true;
        }
        chain.push(current);
        current = getComposedParent(current);
    }

    const inherited = current ? protectionCache.get(current) : undefined;
    let depth = inherited?.depth ?? 0;
    let protectedByAncestor = inherited?.protected ?? false;
    for (let index = chain.length - 1; index >= 0; index -= 1) {
        const item = chain[index]!;
        depth += 1;
        protectedByAncestor = protectedByAncestor ||
            depth > maxComposedAncestorDepth ||
            isProtected(item) ||
            isLiveDataDisplay(item, isProtected) ||
            shouldStayOriginal?.(item) === true;
        protectionCache.set(item, {depth, protected: protectedByAncestor});
    }
    return protectionCache.get(element)?.protected === true;
}

/**
 * 用于候选发现的有界可读性探测。渲染稍后仍会取得精确快照，但单个生成器步骤
 * 绝不能在 runtime 归还宿主页执行权之前遍历无限大的内联子树。
 */
export function hasMeaningfulTranslationTextInNodes(
    roots: readonly Node[],
    shouldStayOriginal?: (element: Element) => boolean,
    protectionCache = createTranslationTextProtectionCache(),
    protectionOptions?: TranslationTextProtectionOptions,
): boolean {
    const stack: Array<{node: Node; nextChildIndex: number; entered: boolean}> = [];
    const parts: string[] = [];
    let textNodes = 0;
    let characters = 0;
    let visitedNodes = 0;
    let rootIndex = 0;

    const elementIsProtected = (element: Element): boolean =>
        isTranslationTextElementProtected(
            element,
            shouldStayOriginal,
            protectionCache,
            protectionOptions,
        );

    while (textNodes < discoveryTextNodeBudget && characters < discoveryCharacterBudget) {
        if (stack.length === 0) {
            if (rootIndex >= roots.length) break;
            const root = roots[rootIndex];
            rootIndex += 1;
            if (root) stack.push({node: root, nextChildIndex: 0, entered: false});
            continue;
        }

        const frame = stack[stack.length - 1]!;
        if (!frame.entered) {
            frame.entered = true;
            visitedNodes += 1;
            // 保留已经收集的证据，但不能把庞大且无文本的子树误作翻译目标；
            // 假阳性只会把无限遍历推迟到服务请求前的精确源文提取阶段。
            if (visitedNodes > discoveryVisitedNodeBudget) {
                return isMeaningfulTranslationText(parts.join(' '));
            }
        }

        const current = frame.node;
        if (current.nodeType === 3) {
            stack.pop();
            const textNode = current as Text;
            if (!textNode.parentElement || elementIsProtected(textNode.parentElement)) continue;
            textNodes += 1;
            const remaining = discoveryCharacterBudget - characters;
            const value = normalizeTranslationText((textNode.nodeValue ?? '').slice(0, remaining));
            if (!value || isNonTranslatableLiveData(value)) continue;
            parts.push(value);
            characters += value.length;
            continue;
        }
        if (current.nodeType !== 1) {
            stack.pop();
            continue;
        }
        const element = current as Element;
        if (elementIsProtected(element)) {
            stack.pop();
            continue;
        }
        const child = current.childNodes[frame.nextChildIndex];
        frame.nextChildIndex += 1;
        if (child) {
            stack.push({node: child, nextChildIndex: 0, entered: false});
        } else {
            stack.pop();
        }
    }

    return isMeaningfulTranslationText(parts.join(' '));
}

export function extractTranslationTextFromNodes(
    nodes: readonly Node[],
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): string {
    return collectReadableText(
        nodes,
        shouldStayOriginal,
        ignoredExtensionElement,
        protectionOptions,
    );
}

/** 无需克隆候选子树，直接提取宿主页中的可读文本。 */
export function extractTranslationText(
    element: Element,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): string {
    return collectReadableText(
        [element],
        shouldStayOriginal,
        ignoredExtensionElement,
        protectionOptions,
    );
}

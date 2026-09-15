/**
 * @file src/core/translation/text.ts
 *
 * 文件职责：提取和校验候选中的可读文本，拒绝标识符、空白、扩展译文及脚本、表单或敏感区域的节点。
 * 主要内容：提供文本规范化、meaningful/identifier 判定、元素与文本节点保护检查、嵌套 tooltip 来源隔离、保守的目标语言字符集快判、WeakMap 状态缓存和受预算约束的深度扫描，避免在大型 DOM 上无限遍历。 可核对的公开符号包括 normalizeTranslationText、isIdentifierLikeText、isMeaningfulTranslationText、setMinimumTranslationTextLength、isClearlyTargetLanguage、isTranslationTextNodeProtected、TranslationTextProtectionCache、createTranslationTextProtectionCache、isTranslationTextElementProtected、hasMeaningfulTranslationTextInNodes。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {
    getTranslatableControlValueAttribute,
    isTextInNestedTranslationTooltip,
    getComposedParent,
    isProtectedDescendantElement,
    maxComposedAncestorDepth,
} from './dom';
import type {TranslationTextProtectionOptions} from './dom';
import {isChineseTextForTarget} from '@/src/core/language/chinese';
import {
    DEFAULT_MIN_TRANSLATION_TEXT_LENGTH,
    normalizeMinTranslationTextLength,
} from '@/src/core/config/pageTranslation';

const identifierPatterns = [
    /^https?:\/\/\S+$/iu,
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

export function isIdentifierLikeText(value: string): boolean {
    const text = normalizeTranslationText(value);
    return Boolean(text && identifierPatterns.some((pattern) => pattern.test(text)));
}

// 阈值由应用层在读取配置后注入；core 自身不访问存储，默认与历史行为一致。
let minimumTranslationTextLength = DEFAULT_MIN_TRANSLATION_TEXT_LENGTH;

/** 设置段落参与翻译所需的最少字符数，返回归一化后的实际阈值。 */
export function setMinimumTranslationTextLength(value: unknown): number {
    minimumTranslationTextLength = normalizeMinTranslationTextLength(value);
    return minimumTranslationTextLength;
}

export function isMeaningfulTranslationText(value: string): boolean {
    const text = normalizeTranslationText(value);
    if (!text || isIdentifierLikeText(text)) return false;
    // 字符长度按用户设定过滤短碎片；字母数仍保留原有的纯符号与编号防护。
    if (text.length < minimumTranslationTextLength) return false;
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    return letters >= 2;
}

export function isTranslationTextNodeProtected(
    node: Text,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
    protectionCache = createTranslationTextProtectionCache(),
): boolean {
    const parent = node.parentElement;
    if (!parent) return true;
    // 同一次同步提取中的文本节点共享祖先；调用方传入缓存时只在相同判定参数下复用。
    return isTranslationTextElementProtected(
        parent,
        shouldStayOriginal,
        protectionCache,
        protectionOptions,
        ignoredExtensionElement,
    );
}

function collectReadableText(
    roots: readonly Node[],
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): string {
    const parts: string[] = [];
    // 每个文本节点都要复核完整祖先链；长文章中相邻文本共享祖先，逐节点重算会随正文规模二次增长。
    const protectionCache = createTranslationTextProtectionCache();
    for (const root of roots) {
        if (root.nodeType === 3) {
            const textNode = root as Text;
            if (!isTranslationTextNodeProtected(
                textNode,
                shouldStayOriginal,
                ignoredExtensionElement,
                protectionOptions,
                protectionCache,
            )) {
                const value = normalizeTranslationText(textNode.nodeValue ?? '');
                if (value) parts.push(value);
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
        const walker = document.createTreeWalker(element, 4);
        let current = walker.nextNode();
        while (current) {
            const textNode = current as Text;
            if (!isTextInNestedTranslationTooltip(textNode, element) && !isTranslationTextNodeProtected(
                textNode,
                shouldStayOriginal,
                ignoredExtensionElement,
                protectionOptions,
                protectionCache,
            )) {
                const value = normalizeTranslationText(textNode.nodeValue ?? '');
                if (value) parts.push(value);
            }
            current = walker.nextNode();
        }
    }
    return normalizeTranslationText(parts.join(' '));
}

const discoveryTextNodeBudget = 256;
const discoveryCharacterBudget = 8192;
const discoveryVisitedNodeBudget = 2048;

interface TranslationTextProtectionState {
    depth: number;
    protected: boolean;
}

export type TranslationTextProtectionCache = WeakMap<Element, TranslationTextProtectionState>;

export function createTranslationTextProtectionCache(): TranslationTextProtectionCache {
    return new WeakMap<Element, TranslationTextProtectionState>();
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
            isProtectedDescendantElement(item, item === ignoredExtensionElement, protectionOptions) ||
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
            if (!value) continue;
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

const hanPattern = /\p{Script=Han}/u;
const kanaPattern = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const hangulPattern = /\p{Script=Hangul}/u;
const cjkLetterPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const latinTokenPattern = /[A-Za-z]+(?:[._/+:#@-][A-Za-z0-9]+)*/gu;
const preservedLatinTokenPattern = /^(?:[A-Z]{2,}|(?:[A-Z][a-z]*[A-Z][A-Za-z]*|[a-z]+[A-Z][A-Za-z]*)|(?:api|cpu|css|dom|gpu|git|html|http|https|json|js|npm|pdf|pnpm|sql|ssh|svg|ts|url|xml|yaml|yarn))$/u;

/** 目标语种中的假名/谚文不能掩盖真正的外语正文；短品牌名、代码和 URL 仍视为可保留内容。 */
function hasForeignLanguageProse(value: string): boolean {
    for (const match of value.matchAll(/\p{L}+/gu)) {
        if ([...match[0]].some((character) => (
            !cjkLetterPattern.test(character) && !/^[A-Za-z]$/u.test(character)
        ))) return true;
    }
    const proseTokens = (value.match(latinTokenPattern) ?? [])
        .filter((token) => !/[._/+:#@\-0-9]/u.test(token) && !preservedLatinTokenPattern.test(token));
    return proseTokens.some((token) => token.length >= 3) || proseTokens.length >= 2;
}

/**
 * 统计式语言检测对短 UI 文本最不可靠。接受假名、谚文、中文特有字形或明确中文词语作为证据；
 * 普通共享 Han 无法可靠区分中日文，夹带的外语正文也不能被目标脚本或品牌名掩盖，均交给后续检测或翻译服务。
 */
export function isClearlyTargetLanguage(value: string, targetLanguage: string): boolean {
    const text = normalizeTranslationText(value);
    if (!text) return true;
    const target = targetLanguage.toLowerCase();
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    if (letters === 0) return true;

    const hasKana = kanaPattern.test(text);
    const hasHangul = hangulPattern.test(text);
    if (hasKana && hasHangul) return false;
    if (hasKana) return target.startsWith('ja') && !hasForeignLanguageProse(text);
    if (hasHangul) return target.startsWith('ko') && !hasForeignLanguageProse(text);
    if (hanPattern.test(text)) {
        return isChineseTextForTarget(text, targetLanguage);
    }
    return false;
}

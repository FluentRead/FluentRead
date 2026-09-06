/**
 * @file src/core/translation/text.ts
 *
 * 文件职责：提取和校验候选中的可读文本，拒绝标识符、空白、扩展译文及脚本、表单或敏感区域的节点。
 * 主要内容：提供文本规范化、meaningful/identifier 判定、元素与文本节点保护检查、嵌套 tooltip 来源隔离、保守的目标语言字符集快判、WeakMap 状态缓存和受预算约束的深度扫描，避免在大型 DOM 上无限遍历。 可核对的公开符号包括 normalizeTranslationText、isIdentifierLikeText、isMeaningfulTranslationText、isClearlyTargetLanguage、isTranslationTextNodeProtected、TranslationTextProtectionCache、createTranslationTextProtectionCache、isTranslationTextElementProtected、hasMeaningfulTranslationTextInNodes。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {
    composedAncestors,
    isTextInNestedTranslationTooltip,
    getComposedParent,
    isProtectedDescendantElement,
    maxComposedAncestorDepth,
} from './dom';
import type {TranslationTextProtectionOptions} from './dom';
import {detectChineseScript, getChineseScript} from '@/src/core/language/chinese';

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

export function isMeaningfulTranslationText(value: string): boolean {
    const text = normalizeTranslationText(value);
    if (!text || isIdentifierLikeText(text)) return false;
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    return letters >= 2;
}

export function isTranslationTextNodeProtected(
    node: Text,
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): boolean {
    const parent = node.parentElement;
    if (!parent) return true;
    let depth = 0;
    for (const ancestor of composedAncestors(parent)) {
        depth += 1;
        if (depth > maxComposedAncestorDepth) return true;
        if (isProtectedDescendantElement(
            ancestor,
            ancestor === ignoredExtensionElement,
            protectionOptions,
        )) return true;
        if (shouldStayOriginal?.(ancestor)) return true;
    }
    return false;
}

function collectReadableText(
    roots: readonly Node[],
    shouldStayOriginal?: (element: Element) => boolean,
    ignoredExtensionElement?: Element,
    protectionOptions?: TranslationTextProtectionOptions,
): string {
    const parts: string[] = [];
    for (const root of roots) {
        if (root.nodeType === 3) {
            const textNode = root as Text;
            if (!isTranslationTextNodeProtected(
                textNode,
                shouldStayOriginal,
                ignoredExtensionElement,
                protectionOptions,
            )) {
                const value = normalizeTranslationText(textNode.nodeValue ?? '');
                if (value) parts.push(value);
            }
            continue;
        }
        if (root.nodeType !== 1) continue;
        const element = root as Element;
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
            isProtectedDescendantElement(item, false, protectionOptions) ||
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

/**
 * 统计式语言检测对短 UI 文本最不可靠。只接受假名、谚文或中文特有字形作为明确证据；
 * 普通共享 Han 无法可靠区分中日文，拉丁字母也无法区分英法德等语言，均交给后续检测或翻译服务。
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
    if (hasKana) return target.startsWith('ja');
    if (hasHangul) return target.startsWith('ko');
    if (hanPattern.test(text)) {
        const script = detectChineseScript(text);
        return script !== undefined && script === getChineseScript(targetLanguage);
    }
    return false;
}

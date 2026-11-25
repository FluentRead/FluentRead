/**
 * @file src/core/translation/adapters/declarative.ts
 *
 * 文件职责：把站点选择器规则编译为类型化 TranslationSiteAdapter，供多个站点以声明方式调整候选发现而不复制遍历算法。
 * 主要内容：定义 host、target、skip、prune 与双语快照省略规则结构，缓存组合选择器，安全处理无效 selector，并由 createDeclarativeAdapter 生成匹配 URL 和节点决策的适配器。 可核对的公开符号包括 SelectorList、DeclarativeSelectorRule、DeclarativeTargetRule、DeclarativeHostRule、DeclarativeSiteAdapterDefinition、createDeclarativeAdapter。
 * 模块边界：本文件位于 core 的站点规则层，只表达 URL 与 DOM 候选决策；不发送翻译请求、不渲染译文、不监听业务生命周期，通用安全守卫仍由 TranslationCandidateCore 执行。
 */

import {maxComposedAncestorDepth, safeMatches} from '../dom';
import type {
    AdapterContext,
    AdapterDecision,
    TranslationGenericCandidatePolicy,
    TranslationCandidateKind,
    TranslationSiteAdapter,
} from '../types';

export type SelectorList = string | readonly string[];

export interface DeclarativeSelectorRule {
    selector: SelectorList;
    reason: string;
}

export interface DeclarativeTargetRule extends DeclarativeSelectorRule {
    /** 匹配后代节点时，是否解析到规则声明的语义容器。 */
    match?: 'self' | 'closest';
    candidateKind?: TranslationCandidateKind;
    atomic?: boolean;
    /** 按直接子级 br 拆分正文，保留每行的链接、强调与代码。 */
    splitOnBr?: boolean;
}

export interface DeclarativeHostRule {
    hostname: string;
    includeSubdomains?: boolean;
}

export interface DeclarativeSiteAdapterDefinition {
    id: string;
    priority?: number;
    genericCandidatePolicy?: TranslationGenericCandidatePolicy;
    hosts: readonly (string | DeclarativeHostRule)[];
    pathnames?: readonly RegExp[];
    targets?: readonly DeclarativeTargetRule[];
    prune?: readonly DeclarativeSelectorRule[];
    keepOriginal?: readonly DeclarativeSelectorRule[];
    omitFromTranslation?: readonly DeclarativeSelectorRule[];
    mutationExclude?: readonly DeclarativeSelectorRule[];
}

function selectors(value: SelectorList): readonly string[] {
    return typeof value === 'string' ? [value] : value;
}

const combinedSelectorsByDocument = new WeakMap<Document, Map<string, string | null>>();

function combinedSelector(element: Element, value: SelectorList): string | null {
    const document = element.ownerDocument;
    if (!document) return null;
    const items = [...new Set(selectors(value))];
    const cacheKey = items.join('\u0000');
    let documentCache = combinedSelectorsByDocument.get(document);
    if (!documentCache) {
        documentCache = new Map();
        combinedSelectorsByDocument.set(document, documentCache);
    }
    if (documentCache.has(cacheKey)) return documentCache.get(cacheKey) ?? null;

    const probe = document.createElement('div');
    const valid = items.filter((item) => {
        try {
            probe.matches(item);
            return true;
        } catch {
            return false;
        }
    });
    const combined = valid.length > 0 ? valid.join(',') : null;
    documentCache.set(cacheKey, combined);
    return combined;
}

function matchesSelector(element: Element, selector: SelectorList): boolean {
    const combined = combinedSelector(element, selector);
    return combined ? safeMatches(element, combined) : false;
}

function closestSelector(
    element: Element, selector: SelectorList, context: AdapterContext,
): Element | null {
    const misses = context.closestSelectorMisses;
    if (misses?.get(element)?.has(selector)) return null;
    const combined = combinedSelector(element, selector);
    if (!combined) return null;
    let closest: Element | null = null;
    let cachedAncestor = false;
    const unchecked: Element[] = [];
    if (misses) {
        let current: Element | null = element;
        for (let depth = 0; current && depth < maxComposedAncestorDepth; depth += 1) {
            if (misses.get(current)?.has(selector)) {
                cachedAncestor = true;
                break;
            }
            unchecked.push(current);
            current = current.parentElement;
        }
    }
    try {
        if (cachedAncestor) {
            // 已证实的祖先 miss 已排除其上全部 light-DOM 祖先；仅逐层检查未缓存节点，
            // 避免重复对顶层大型容器执行 closest() 与 :has() 选择器匹配。
            for (const node of unchecked) {
                if (node.matches(combined)) {
                    closest = node;
                    break;
                }
            }
        } else {
            closest = element.closest(combined);
        }
    } catch {
        // 失败不是已证实的 miss；不能据此跳过祖先上的查询。
        return null;
    }
    if (closest || !misses || combined.includes('\\') || combined.includes('&') || /:scope\b/iu.test(combined)) return closest;
    // 对固定 scope 的成功 miss 已覆盖整条 light-DOM 祖先链。只复用 miss，
    // 保留命中 target 的身份与优先级；:scope/转义语法不作这种推断。
    for (const current of unchecked) {
        let selectors = misses.get(current);
        if (!selectors) {
            selectors = new Set();
            misses.set(current, selectors);
        }
        selectors.add(selector);
    }
    return null;
}

function normalizeHostname(hostname: string): string {
    return hostname.toLowerCase().replace(/\.$/u, '');
}

function matchesHost(url: URL, rule: string | DeclarativeHostRule): boolean {
    const hostname = normalizeHostname(url.hostname);
    const expected = normalizeHostname(typeof rule === 'string' ? rule : rule.hostname);
    if (!expected || hostname === expected) return hostname === expected;
    return typeof rule !== 'string' && rule.includeSubdomains === true && hostname.endsWith(`.${expected}`);
}

function matchesPathname(pathname: string, patterns: readonly RegExp[] | undefined): boolean {
    if (!patterns?.length) return true;
    return patterns.some((pattern) => {
        try {
            // 每次克隆正则，避免 global/sticky 表达式的 lastIndex 产生可观察变化。
            return new RegExp(pattern.source, pattern.flags).test(pathname);
        } catch {
            return false;
        }
    });
}

/**
 * 由无副作用的选择器数据构建站点适配器。所有选择器操作均按失败即拒绝处理，
 * 过期或不受支持的站点选择器不能中断候选发现。
 */
export function createDeclarativeAdapter(
    definition: DeclarativeSiteAdapterDefinition,
): TranslationSiteAdapter {
    const pruneRules = definition.prune ?? [];
    const targetRules = definition.targets ?? [];
    const originalRules = definition.keepOriginal ?? [];
    const omitRules = definition.omitFromTranslation ?? [];
    const mutationRules = definition.mutationExclude ?? [];

    return {
        id: definition.id,
        priority: definition.priority,
        genericCandidatePolicy: definition.genericCandidatePolicy,
        matches(url: URL): boolean {
            return definition.hosts.some((host) => matchesHost(url, host)) &&
                matchesPathname(url.pathname, definition.pathnames);
        },
        decide(element: Element, _context: AdapterContext): AdapterDecision {
            for (const rule of pruneRules) {
                if (closestSelector(element, rule.selector, _context)) {
                    return {kind: 'prune-subtree', reason: rule.reason};
                }
            }

            for (const rule of targetRules) {
                const target = rule.match === 'closest'
                    ? closestSelector(element, rule.selector, _context)
                    : matchesSelector(element, rule.selector) ? element : null;
                if (!target) continue;
                return {
                    kind: 'force-target',
                    reason: rule.reason,
                    target,
                    candidateKind: rule.candidateKind ?? 'content',
                    atomic: rule.atomic,
                    splitOnBr: rule.splitOnBr,
                };
            }

            return {kind: 'pass'};
        },
        shouldStayOriginal(element: Element, _context: AdapterContext): boolean {
            return originalRules.some((rule) => Boolean(closestSelector(element, rule.selector, _context)));
        },
        shouldOmitFromTranslation(element: Element, _context: AdapterContext): boolean {
            return omitRules.some((rule) => Boolean(closestSelector(element, rule.selector, _context)));
        },
        shouldIgnoreMutation(element: Element, _context: AdapterContext): boolean {
            return mutationRules.some((rule) => Boolean(closestSelector(element, rule.selector, _context)));
        },
    };
}

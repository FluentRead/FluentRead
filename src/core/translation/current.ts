/**
 * @file src/core/translation/current.ts
 *
 * 文件职责：提供当前文档按翻译范围隔离的 TranslationCandidateCore 便捷访问与候选解析入口，统一悬浮和按坐标发现行为。
 * 主要内容：按当前 URL 和正文/全部节点范围懒加载共享核心实例，由应用层注入适配器、侧边栏范围与不翻译标签选择器并在变更后清空全部范围缓存；同一同步只读批次按范围创建并复用解析器，统一 getCurrentTranslationCore 与 resolveTranslationCandidateAtPoint 的候选政策。 可核对的公开符号包括 getCurrentTranslationCore、createCurrentTranslationResolverBatch、setCurrentTranslationSidebarRegions、setCurrentTranslationExcludedSelectors、resolveTranslationCandidateAtPoint。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {normalizeExcludedTags} from '@/src/core/config/pageTranslation';
import {TranslationCandidateCore} from './engine';
import {defaultTranslationAdapters} from './registry';
import type {TranslationCandidate, TranslationScope, TranslationSiteAdapter} from './types';

let cachedHref = '';
const cachedCores = new Map<TranslationScope, TranslationCandidateCore>();
let currentAdapters: readonly TranslationSiteAdapter[] = defaultTranslationAdapters;
let currentIncludeSidebarRegions = false;
let currentExcludedSelectors: readonly string[] = [];

/** 配置由应用层注入；引用未变时保留核心，更新时同时清除 URL 相同的缓存。 */
export function setCurrentTranslationAdapters(adapters: readonly TranslationSiteAdapter[]): void {
    if (currentAdapters === adapters) return;
    currentAdapters = adapters;
    cachedCores.clear();
}

/** 侧边栏翻译开关由应用层注入；取值变化时重建缓存核心，使下一次发现立即生效。 */
export function setCurrentTranslationSidebarRegions(enabled: boolean): void {
    const next = enabled === true;
    if (currentIncludeSidebarRegions === next) return;
    currentIncludeSidebarRegions = next;
    cachedCores.clear();
}

/** 用户不翻译标签/选择器由应用层注入；列表变化时重建缓存核心，使下一次发现立即生效。 */
export function setCurrentTranslationExcludedSelectors(selectors: unknown): readonly string[] {
    const next = normalizeExcludedTags(selectors);
    if (next.length === currentExcludedSelectors.length
        && next.every((item, index) => item === currentExcludedSelectors[index])) {
        return currentExcludedSelectors;
    }
    currentExcludedSelectors = next;
    cachedCores.clear();
    return currentExcludedSelectors;
}

let lastRawHref: string | undefined;
let lastNormalizedHref = 'https://invalid.local/';

function currentHref(): string {
    const href = globalThis.location?.href ?? 'https://invalid.local/';
    // 全文提交热路径每个候选会多次取核心；地址未变时复用上次规范化结果，不重复解析 URL。
    if (href === lastRawHref) return lastNormalizedHref;
    lastRawHref = href;
    try {
        lastNormalizedHref = new URL(href).href;
    } catch {
        lastNormalizedHref = 'https://invalid.local/';
    }
    return lastNormalizedHref;
}

/** 返回所有内容脚本入口共享、按 URL 和翻译范围隔离的候选核心。 */
export function getCurrentTranslationCore(scope: TranslationScope = 'content'): TranslationCandidateCore {
    const href = currentHref();
    if (cachedHref !== href) {
        cachedHref = href;
        cachedCores.clear();
    }
    let core = cachedCores.get(scope);
    if (!core) {
        core = new TranslationCandidateCore({
            url: new URL(href),
            adapters: currentAdapters,
            scope,
            includeSidebarRegions: currentIncludeSidebarRegions,
            excludedSelectors: currentExcludedSelectors,
        });
        cachedCores.set(scope, core);
    }
    return core;
}

export function resolveTranslationCandidateAtPoint(x: number, y: number, scope?: TranslationScope): TranslationCandidate | null {
    if (typeof document === 'undefined') return null;
    return getCurrentTranslationCore(scope).resolveAtPoint(document, x, y);
}

/** 同一同步只读阶段可混用范围；写 DOM、改变策略或让出任务后重新创建。 */
export function createCurrentTranslationResolverBatch(): (
    start: Node, scope?: TranslationScope,
) => TranslationCandidate | null {
    const resolvers = new Map<TranslationScope, (start: Node) => TranslationCandidate | null>();
    return (start, scope = 'content') => {
        let resolve = resolvers.get(scope);
        if (!resolve) {
            resolve = getCurrentTranslationCore(scope).createSynchronousResolver();
            resolvers.set(scope, resolve);
        }
        return resolve(start);
    };
}

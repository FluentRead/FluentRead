/**
 * @file src/core/translation/current.ts
 *
 * 文件职责：提供当前文档按翻译范围隔离的 TranslationCandidateCore 便捷访问与候选解析入口，统一悬浮和按坐标发现行为。
 * 主要内容：按当前 URL 和正文/全部节点范围懒加载共享核心实例，由应用层注入适配器并在适配器或侧边栏范围变更后清空全部范围缓存，并导出 getCurrentTranslationCore、resolveTranslationCandidate 与 resolveTranslationCandidateAtPoint，把节点或视口坐标交给同一套候选政策。 可核对的公开符号包括 getCurrentTranslationCore、setCurrentTranslationSidebarRegions、getCurrentTranslationSidebarRegions、resolveTranslationCandidate、resolveTranslationCandidateAtPoint。
 * 模块边界：本文件属于可独立测试的 core 候选领域；可以读取传入 DOM 以计算结果，但不访问配置存储、不调用 provider、不注册页面监听器，也不负责译文渲染或 feature 生命周期。
 */

import {TranslationCandidateCore} from './engine';
import {defaultTranslationAdapters} from './registry';
import type {TranslationCandidate, TranslationScope, TranslationSiteAdapter} from './types';

let cachedHref = '';
const cachedCores = new Map<TranslationScope, TranslationCandidateCore>();
let currentAdapters: readonly TranslationSiteAdapter[] = defaultTranslationAdapters;
let currentIncludeSidebarRegions = false;

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

export function getCurrentTranslationSidebarRegions(): boolean {
    return currentIncludeSidebarRegions;
}

function currentHref(): string {
    const href = globalThis.location?.href ?? 'https://invalid.local/';
    try {
        return new URL(href).href;
    } catch {
        return 'https://invalid.local/';
    }
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
        });
        cachedCores.set(scope, core);
    }
    return core;
}

export function resolveTranslationCandidate(node: Node | null | undefined): TranslationCandidate | null {
    return getCurrentTranslationCore().resolve(node);
}

export function resolveTranslationCandidateAtPoint(x: number, y: number, scope?: TranslationScope): TranslationCandidate | null {
    if (typeof document === 'undefined') return null;
    return getCurrentTranslationCore(scope).resolveAtPoint(document, x, y);
}

/**
 * @file src/platform/i18n/uiLanguageBundles.ts
 *
 * 文件职责：在扩展运行时按当前界面语言加载构建期生成的非中文资源包，并注册到 core i18n。
 * 主要内容：createUiLanguageBundleLoader 对同一语言的并发请求去重，同时支持完整本地 JSON（如 en-US）与 delta-v1 增量包（其余五语通过国内外多镜像校验并缓存固定基线后无损合并），失败时回退中文且允许下次重试；
 * ensureUiLanguageBundle 使用扩展自身资源 URL 与统一受校验缓存作为默认实现；renderWithUiLanguageBundle 让非响应式 UI 在资源到达后补一次渲染。
 * 模块边界：这里只负责资源读取和注册，不决定当前语言、不订阅配置，也不修改 DOM；
 * userscript 构建用静态注册全部语言的实现替换本模块，扩展 bundle 不得回退到静态 import 全部语言。
 */

import {
    getUiLanguageBundlePath,
    hasUiLanguageBundle,
    normalizeUiLanguage,
    registerUiLanguageBundle,
    type RegisteredUiLanguage,
    type UiLanguageBundle,
} from '@/src/core/i18n';
import {
    EXTENSION_I18N_BASE_CACHE,
    getRemoteLanguageBaseUrls,
    isDeltaUiLanguageBundle,
    mergeDeltaUiLanguageBundle,
    type DeltaUiLanguageBundle,
} from '@/src/core/i18n/remoteLanguagePacks';
import {detectPreferredMirrorLocale} from '@/src/core/assets/mirrors';
import {fetchVerifiedAsset} from '@/src/platform/assets/verifiedAssetCache';

interface BundleResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export interface UiLanguageBundleLoaderDependencies {
    readonly resolveUrl: (path: string) => string;
    readonly fetch: (url: string) => Promise<BundleResponse>;
    readonly warn: (message: string, error: unknown) => void;
    readonly loadRemoteBase?: (delta: DeltaUiLanguageBundle) => Promise<UiLanguageBundle>;
}

export type EnsureUiLanguageBundle = (language: unknown) => Promise<boolean>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLegacyPatternList(value: unknown): boolean {
    return Array.isArray(value) && value.every((entry) => Array.isArray(entry)
        && typeof entry[0] === 'string'
        && typeof entry[1] === 'string'
        && (entry[2] === undefined || (Array.isArray(entry[2]) && entry[2].every(Number.isSafeInteger))));
}

export function isUiLanguageBundle(value: unknown): value is UiLanguageBundle {
    return isPlainRecord(value) && value.format === undefined && isPlainRecord(value.messages) && isPlainRecord(value.legacyText)
        && Object.values(value.messages).every((message) => typeof message === 'string')
        && Object.values(value.legacyText).every((message) => typeof message === 'string')
        && isPlainRecord(value.legacyPatterns)
        && isLegacyPatternList(value.legacyPatterns.early)
        && isLegacyPatternList(value.legacyPatterns.late);
}

async function defaultLoadRemoteBase(delta: DeltaUiLanguageBundle): Promise<UiLanguageBundle> {
    const bytes = await fetchVerifiedAsset({
        id: `i18n-base:${delta.language}`,
        cacheName: EXTENSION_I18N_BASE_CACHE,
        cacheKey: `https://fluentread.app/__optional_assets__/i18n/${delta.language}/${delta.baseSha256}.json`,
        bytes: delta.baseBytes,
        sha256: delta.baseSha256,
        contentType: 'application/json',
        urls: getRemoteLanguageBaseUrls(delta, detectPreferredMirrorLocale()),
        timeoutMs: 15_000,
    });
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isUiLanguageBundle(parsed)) throw new TypeError(`远程语言基线格式无效：${delta.language}`);
    return parsed;
}

/** 返回的函数只在资源包可用时解析为 true；任何失败都降级为中文界面，而不是阻断页面功能。 */
export function createUiLanguageBundleLoader(dependencies: UiLanguageBundleLoaderDependencies): EnsureUiLanguageBundle {
    const pending = new Map<RegisteredUiLanguage, Promise<boolean>>();
    const loadRemoteBase = dependencies.loadRemoteBase ?? defaultLoadRemoteBase;

    async function load(language: RegisteredUiLanguage): Promise<boolean> {
        const response = await dependencies.fetch(dependencies.resolveUrl(getUiLanguageBundlePath(language)));
        if (!response.ok) throw new Error(`界面语言资源加载失败：HTTP ${response.status}`);
        const payload = await response.json();
        if (isDeltaUiLanguageBundle(payload) && payload.language === language) {
            const baseline = await loadRemoteBase(payload);
            const merged = mergeDeltaUiLanguageBundle(baseline, payload);
            if (!isUiLanguageBundle(merged)) throw new TypeError('合并后的界面语言资源格式无效');
            registerUiLanguageBundle(language, merged);
            return true;
        }
        if (isUiLanguageBundle(payload)) {
            registerUiLanguageBundle(language, payload);
            return true;
        }
        throw new TypeError('界面语言资源格式无效');
    }

    return (value) => {
        const language = normalizeUiLanguage(value);
        if (hasUiLanguageBundle(language)) return Promise.resolve(true);
        const registered = language as RegisteredUiLanguage;
        const existing = pending.get(registered);
        if (existing) return existing;
        const request = Promise.resolve()
            .then(() => load(registered))
            .catch((error: unknown) => {
                dependencies.warn('[FluentRead] UI language bundle unavailable; falling back to Chinese:', error);
                return false;
            })
            .finally(() => pending.delete(registered));
        pending.set(registered, request);
        return request;
    };
}

type ExtensionRuntimeGlobal = typeof globalThis & {
    browser?: {runtime?: {getURL?: (path: string) => string}};
    chrome?: {runtime?: {getURL?: (path: string) => string}};
};

function resolveExtensionUrl(path: string): string {
    const extensionGlobal = globalThis as ExtensionRuntimeGlobal;
    const runtime = extensionGlobal.browser?.runtime ?? extensionGlobal.chrome?.runtime;
    if (typeof runtime?.getURL !== 'function') throw new Error('扩展运行时不可用，无法加载界面语言资源');
    return runtime.getURL(path);
}

export const ensureUiLanguageBundle: EnsureUiLanguageBundle = createUiLanguageBundleLoader({
    resolveUrl: resolveExtensionUrl,
    fetch: (url) => fetch(url),
    warn: (message, error) => console.warn(message, error),
});

/**
 * 立即按当前已可用的资源渲染一次；目标语言资源尚未注册时，加载成功后再渲染一次。
 * 供切换语言时同步重绘的非 Vue 浮层使用，避免在资源到达前停留在中文回退文案。
 */
export function renderWithUiLanguageBundle(
    language: unknown,
    render: () => void,
    ensure: EnsureUiLanguageBundle = ensureUiLanguageBundle,
): void {
    render();
    if (hasUiLanguageBundle(normalizeUiLanguage(language))) return;
    void ensure(language).then((loaded) => { if (loaded) render(); });
}

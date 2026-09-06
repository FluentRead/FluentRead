/**
 * @file src/platform/browser/capabilities.ts
 *
 * 文件职责：集中计算编译目标与运行时浏览器能力，为 Chrome、Edge、Firefox 和 userscript 的功能装配提供确定契约。
 * 主要内容：定义 BrowserBuildTarget、BrowserCapabilities 与 feature 类型，从 import.meta.env 生成构建标记，并结合 userAgent 约束 Chrome Translator、Offscreen、OCR、区域翻译和 TTS。 可核对的公开符号包括 BrowserBuildTarget、BrowserCapabilities、BrowserFeatureCapability、resolveBrowserCapabilities、applyRuntimeBrowserConstraints、readRuntimeUserAgent、browserBuildTargetFromEnv、browserBuildTargetFromImportMeta。
 * 模块边界：本文件属于 platform 基础设施边界，只封装浏览器、网络、存储上下文或 Shadow DOM 机制；不决定翻译业务策略，不直接实现 feature，业务层通过类型化端口消费这里的能力。
 */

export interface BrowserBuildTarget {
    readonly browser: string;
    readonly manifestVersion: 2 | 3;
}

export interface BrowserCapabilities extends BrowserBuildTarget {
    /** 原生 Chrome/Edge Offscreen API，仅用于权限与浏览器容器选择。 */
    readonly offscreenDocument: boolean;
    /** 可承载共享 DOM 运行时：Chromium MV3 Offscreen 或 Firefox MV2 后台 iframe。 */
    readonly extensionDom: boolean;
    readonly chromeTranslation: boolean;
    readonly imageOcr: boolean;
    readonly imageTranslation: boolean;
    readonly areaTranslation: boolean;
    readonly selectionTtsExtensionPlayback: boolean;
    /** Edge TTS 始终能够返回合成音频字节，供内容页面播放。 */
    readonly selectionTtsPageFallback: true;
}

export type BrowserFeatureCapability =
    | 'areaTranslation'
    | 'chromeTranslation'
    | 'imageOcr'
    | 'imageTranslation'
    | 'offscreenDocument'
    | 'extensionDom'
    | 'selectionTtsExtensionPlayback'
    | 'selectionTtsPageFallback';

function normalizeBrowser(browser: string): string {
    return browser.trim().toLocaleLowerCase() || 'unknown';
}

/**
 * 浏览器能力的唯一纯契约。WXT manifest 与扩展各 runtime 都从同一个构建目标解析，
 * 测试可直接注入 browser/MV，不需要伪造真实浏览器全局。
 */
export function resolveBrowserCapabilities(target: BrowserBuildTarget): BrowserCapabilities {
    const browser = normalizeBrowser(target.browser);
    const chromiumMv3 = target.manifestVersion === 3 && (browser === 'chrome' || browser === 'edge');

    const extensionDom = chromiumMv3 || (browser === 'firefox' && target.manifestVersion === 2);

    return Object.freeze({
        browser,
        manifestVersion: target.manifestVersion,
        offscreenDocument: chromiumMv3,
        extensionDom,
        // Offscreen 只是传输前提；offscreen runtime 仍会动态检查 Translator API 就绪状态。
        chromeTranslation: target.manifestVersion === 3 && browser === 'chrome',
        imageOcr: extensionDom,
        imageTranslation: extensionDom,
        areaTranslation: extensionDom,
        selectionTtsExtensionPlayback: extensionDom,
        selectionTtsPageFallback: true as const,
    });
}

/** Chrome 产物也可由 Edge 加载；宿主 UA 必须在运行时关闭 Edge 不提供的 Chrome Translation API。 */
export function applyRuntimeBrowserConstraints(
    capabilities: BrowserCapabilities,
    userAgent: string,
): BrowserCapabilities {
    if (capabilities.browser !== 'chrome' || !/\bEdg(?:A|iOS)?\//i.test(userAgent)) return capabilities;
    return Object.freeze({...capabilities, browser: 'edge', chromeTranslation: false});
}

export function readRuntimeUserAgent(host: {navigator?: {userAgent?: unknown}}): string {
    return typeof host.navigator?.userAgent === 'string' ? host.navigator.userAgent : '';
}

function defaultManifestVersion(browser: string): 2 | 3 {
    return browser === 'chrome' || browser === 'edge' ? 3 : 2;
}

/** 读取 WXT 的编译期常量，无需由 Node/Vitest 提供。 */
export function browserBuildTargetFromEnv(env?: Partial<ImportMetaEnv>): BrowserBuildTarget {
    const browser = normalizeBrowser(typeof env?.BROWSER === 'string' ? env.BROWSER : 'unknown');
    const manifestVersion = env?.MANIFEST_VERSION === 2 || env?.MANIFEST_VERSION === 3
        ? env.MANIFEST_VERSION
        : defaultManifestVersion(browser);
    return {browser, manifestVersion};
}

/** import.meta.env 缺失时采用保守结果，并保持可独立测试。 */
export function browserBuildTargetFromImportMeta(
    meta?: {readonly env?: Partial<ImportMetaEnv>},
): BrowserBuildTarget {
    return browserBuildTargetFromEnv(meta?.env);
}

/**
 * 构建标记同时服务于产物审计。这里必须直接读取静态属性；把整个 import.meta 传给函数会绕过
 * Vite/WXT 的编译期替换，导致 Chrome 生产包被误判为 unknown/MV2。
 */
export const browserCapabilityBuildMarker = `__FLUENTREAD_BROWSER_CAPABILITY_BUILD__:${import.meta.env.BROWSER}:mv${import.meta.env.MANIFEST_VERSION}__`;
const compiledBrowserBuildTarget = browserBuildTargetFromEnv({
    BROWSER: import.meta.env.BROWSER,
    MANIFEST_VERSION: import.meta.env.MANIFEST_VERSION,
});
const runtimeBrowserCapabilities = applyRuntimeBrowserConstraints(
    resolveBrowserCapabilities(compiledBrowserBuildTarget),
    readRuntimeUserAgent(globalThis),
);

/** 生产环境单例；组合根允许覆盖它，以便能力测试获得确定结果。 */
export const browserCapabilities = Object.freeze({
    ...runtimeBrowserCapabilities,
    buildTargetMarker: browserCapabilityBuildMarker,
});

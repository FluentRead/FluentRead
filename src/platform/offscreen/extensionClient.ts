/**
 * @file src/platform/offscreen/extensionClient.ts
 * 文件职责：为需要扩展自有 DOM 的后台功能选择浏览器容器，业务调用共享同一客户端契约。
 * 主要内容：Chrome/Edge 复用原生 Offscreen client；Firefox MV2 使用后台 iframe；Safari MV3 使用扩展自己的后台标签页，并复用相同的 ready 握手、并发准备、截止时间、取消和丢失重建逻辑。
 * 模块边界：浏览器差异只限文档创建和查询；所有消息、OCR、绘图、字幕推理及朗读代码仍由现有共享运行时执行，Chrome Translator 保留自身浏览器限制。
 */
import {browserCapabilities, type BrowserBuildTarget} from '../browser/capabilities';
import {chromeOffscreenClient, createOffscreenClient, type OffscreenRuntimeApi} from './client';
import {createFirefoxBackgroundDocument} from './firefoxDocument';
import {createSafariBackgroundDocument, type SafariStoragePort, type SafariTabsPort} from './safariDocument';

/** 扩展页面里 browser 由 polyfill 提供；用访问器延迟到调用时解析，避免测试环境导入即失败。 */
function safariTabsPort(): SafariTabsPort {
    return browser.tabs as unknown as SafariTabsPort;
}

function safariStoragePort(): SafariStoragePort {
    return browser.storage.local as unknown as SafariStoragePort;
}

export function createExtensionDomClient(
    target: BrowserBuildTarget,
    getRuntime: () => OffscreenRuntimeApi & {getURL(path: string): string},
    getDocument: () => Document | undefined,
) {
    const getUrl = (path: string) => getRuntime().getURL(path);
    if (target.browser === 'safari' && target.manifestVersion === 3) {
        // Safari 没有 offscreen API，MV3 也没有后台页面；后台标签页是官方允许的 DOM 容器。
        const host = createSafariBackgroundDocument(getUrl, {
            tabs: {
                create: properties => safariTabsPort().create(properties),
                get: tabId => safariTabsPort().get(tabId),
                remove: tabId => safariTabsPort().remove(tabId),
            },
            storage: {
                get: key => safariStoragePort().get(key),
                set: items => safariStoragePort().set(items),
                remove: key => safariStoragePort().remove(key),
            },
            onIdleCloseError: error => console.warn('[FluentRead] 关闭后台运行页失败', error),
        });
        return createOffscreenClient({
            getRuntime,
            getOffscreen: () => host,
            getDocumentContexts: host.getContexts,
        });
    }
    if (target.browser !== 'firefox' || target.manifestVersion !== 2) return chromeOffscreenClient;
    const host = createFirefoxBackgroundDocument(getDocument, getUrl);
    return createOffscreenClient({
        getRuntime,
        getOffscreen: () => host,
        getDocumentContexts: host.getContexts,
    });
}

export const extensionDomClient = /* @__PURE__ */ createExtensionDomClient(
    browserCapabilities,
    () => chrome.runtime as unknown as OffscreenRuntimeApi & {getURL(path: string): string},
    () => globalThis.document,
);

/**
 * @file src/platform/offscreen/extensionClient.ts
 * 文件职责：为需要扩展自有 DOM 的后台功能选择浏览器容器，业务调用共享同一客户端契约。
 * 主要内容：Chrome/Edge 复用原生 Offscreen client；Firefox/Safari MV2 使用后台 iframe，Safari 通过同源页面传输避免原生 runtime 跳过发送页；共用 ready 握手、截止时间、取消和重建。
 * 模块边界：浏览器差异只限文档创建和查询；所有消息、OCR、绘图、字幕推理及朗读代码仍由现有共享运行时执行，Chrome Translator 保留自身浏览器限制。
 */
import {browserCapabilities, type BrowserBuildTarget} from '../browser/capabilities';
import {chromeOffscreenClient, createOffscreenClient, type OffscreenRuntimeApi} from './client';
import {createFirefoxBackgroundDocument} from './firefoxDocument';
import {createExtensionPageRuntime} from './extensionPageMessaging';

export function createExtensionDomClient(
    target: BrowserBuildTarget,
    getRuntime: () => OffscreenRuntimeApi & {getURL(path: string): string; readonly id?: string},
    getDocument: () => Document | undefined,
) {
    // Safari MV2 的后台同为页面，缺少 offscreen API 时与 Firefox 共用后台 iframe 容器。
    const hasBackgroundPage = (target.browser === 'firefox' || target.browser === 'safari') && target.manifestVersion === 2;
    if (!hasBackgroundPage) return chromeOffscreenClient;
    const host = createFirefoxBackgroundDocument(getDocument, path => getRuntime().getURL(path));
    const runtime = target.browser === 'safari'
        ? createExtensionPageRuntime(getRuntime, host.getMessageTarget, () => getDocument()!.URL)
        : undefined;
    return createOffscreenClient({
        getRuntime: () => runtime ?? getRuntime(),
        getOffscreen: () => host,
        getDocumentContexts: host.getContexts,
    });
}

export const extensionDomClient = /* @__PURE__ */ createExtensionDomClient(
    browserCapabilities,
    () => chrome.runtime as unknown as OffscreenRuntimeApi & {getURL(path: string): string},
    () => globalThis.document,
);

/**
 * @file src/platform/offscreen/extensionClient.ts
 * 文件职责：为需要扩展自有 DOM 的后台功能选择浏览器容器，业务调用共享同一客户端契约。
 * 主要内容：Chrome/Edge 复用原生 Offscreen client；Firefox MV2 使用后台 iframe，并复用相同的 ready 握手、并发准备、截止时间、取消和丢失重建逻辑。
 * 模块边界：浏览器差异只限文档创建和查询；所有消息、OCR、绘图、字幕推理及朗读代码仍由现有共享运行时执行，Chrome Translator 保留自身浏览器限制。
 */
import {browserCapabilities, type BrowserBuildTarget} from '../browser/capabilities';
import {chromeOffscreenClient, createOffscreenClient, type OffscreenRuntimeApi} from './client';
import {createFirefoxBackgroundDocument} from './firefoxDocument';

export function createExtensionDomClient(
    target: BrowserBuildTarget,
    getRuntime: () => OffscreenRuntimeApi & {getURL(path: string): string},
    getDocument: () => Document | undefined,
) {
    if (target.browser !== 'firefox' || target.manifestVersion !== 2) return chromeOffscreenClient;
    const host = createFirefoxBackgroundDocument(getDocument, path => getRuntime().getURL(path));
    return createOffscreenClient({
        getRuntime,
        getOffscreen: () => host,
        getDocumentContexts: host.getContexts,
    });
}

export const extensionDomClient = createExtensionDomClient(
    browserCapabilities,
    () => chrome.runtime as unknown as OffscreenRuntimeApi & {getURL(path: string): string},
    () => globalThis.document,
);

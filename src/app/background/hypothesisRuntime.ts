/**
 * @file src/app/background/hypothesisRuntime.ts
 * 文件职责：组装 Hypothesis 的浏览器本地注入与扩展阅读器消息通路。
 * 主要内容：将站点开关与 MV2/MV3 静态脚本 API 注入来源门禁；阅读器定向消息留给对应扩展标签页应答。
 * 模块边界：只适配浏览器端口，不下载代码、不读取官方账号、不执行批注 API 请求。
 */
import {createHypothesisInjectionHandler} from '@/src/features/hypothesis/public';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {config, configReady} from '@/src/services/config/store';

export function createBrowserHypothesisHandler(manifestVersion: 2 | 3 = import.meta.env.MANIFEST_VERSION) {
    return createHypothesisInjectionHandler({extensionId: browser.runtime.id,
        enabled: async url => {await configReady; return config.on && !isExtensionDisabledOnSite(url, config.disabledExtensionDomains);},
        getTab: id => browser.tabs.get(id),
        inject: async (tabId, documentId) => {
            const file = 'hypothesis/build/scripts/annotator.bundle.js';
            if (manifestVersion === 3) {
                await browser.scripting.executeScript({target: {tabId, ...(documentId ? {documentIds: [documentId]} : {frameIds: [0]})}, files: [file]});
            } else await browser.tabs.executeScript(tabId, {file: `/${file}`, frameId: 0, runAt: 'document_idle'});
        }});
}
export function withHypothesisDocumentPassthrough(next: (message: unknown, sender: unknown) => Promise<unknown>) {
    return (message: unknown, sender: unknown) => (message as {type?: unknown} | null)?.type === 'toggleDocumentHypothesis'
        ? false : next(message, sender);
}

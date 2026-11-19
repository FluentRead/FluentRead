/**
 * @file src/app/background/hypothesisRuntime.ts
 * 文件职责：装配 Hypothesis 的工具栏右键入口和网页静态客户端注入。
 * 主要内容：显式菜单点击只作用于当时的标签页和顶层文档；在线 PDF 交给阅读器；站点开关与 MV2/MV3 静态脚本 API 共同约束网页注入。
 * 模块边界：只适配浏览器端口，不下载代码、不读取官方账号、不执行批注 API 请求。
 */
import {createHypothesisInjectionHandler} from '@/src/features/hypothesis/public';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {config, configReady} from '@/src/services/config/store';
import {translate, type UiLanguage} from '@/src/core/i18n';
import {createPdfReaderUrl, getPdfSourceUrl} from '@/src/features/document-translation/core/pdfSource';
import type {ContextMenuClickTab} from './contextMenuActions';
import {reportContextMenuFailure} from './contextMenuFeedback';
import {isBrowserTabId, type TabTranslationStateStore} from './tabTranslationState';

const TOOLBAR_HYPOTHESIS_MENU_ID = 'fluentread-toolbar-hypothesis';
const ANNOTATION_DOCUMENT_PATTERNS = ['http://*/*', 'https://*/*', 'file:///*'];

export async function createToolbarHypothesisMenu(language: UiLanguage): Promise<void> {
    try {
        const manifest = browser.runtime.getManifest();
        await browser.contextMenus.create({
            id: TOOLBAR_HYPOTHESIS_MENU_ID,
            title: translate('document.pdfReading.hypothesisToggle', language),
            contexts: [manifest.manifest_version === 3 ? 'action' : 'browser_action'],
            documentUrlPatterns: ANNOTATION_DOCUMENT_PATTERNS,
        });
    } catch (error) {
        console.error('[FluentRead] Hypothesis 菜单创建失败', error);
    }
}

export function handleToolbarHypothesisClick(menuItemId: unknown, tab: ContextMenuClickTab | undefined,
    states: TabTranslationStateStore): boolean {
    if (menuItemId !== TOOLBAR_HYPOTHESIS_MENU_ID) return false;
    if (!isBrowserTabId(tab?.id) || !tab.url || !/^(https?|file):\/\//u.test(tab.url)) return true;

    const {id: tabId, url} = tab;
    const currentDocument = states.captureDocument(tabId);
    void configReady.then(async () => {
        if (!currentDocument() || config.on === false) return;
        if (isExtensionDisabledOnSite(url, config.disabledExtensionDomains)) {
            await reportContextMenuFailure(tabId, {}, 'disabled', currentDocument);
            return;
        }
        const pdfSource = getPdfSourceUrl(url);
        if (pdfSource) {
            const readerUrl = createPdfReaderUrl(browser.runtime.getURL('/document.html'), pdfSource);
            await browser.tabs.create({url: `${readerUrl}&hypothesis=1`});
            return;
        }
        await browser.tabs.sendMessage(tabId, {type: 'toggleHypothesis'}, {frameId: 0});
    }).catch(() => reportContextMenuFailure(tabId, {}, 'unavailable', currentDocument));
    return true;
}

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

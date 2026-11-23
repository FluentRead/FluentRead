/**
 * @file src/app/background/documentNavigation.ts
 * 文件职责：装配文档相关后台消息，并处理论文摘要页显式打开 PDF 阅读器的请求。
 * 主要内容：用浏览器提供的顶层发送者和共用的论文身份规则验证来源，按当前站点开关放行，并在来源窗口打开已有 PDF 阅读器。
 * 模块边界：复用通用消息路由、论文 URL 和阅读器入口；不探测或下载远程文件，PDF 加载仍归文档阅读器。
 */
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {resolvePaperPdfUrl} from '@/src/features/document-translation/core/paperPdfSites';
import {createPdfReaderUrl} from '@/src/features/document-translation/core/pdfSource';
import {isBrowserTabId} from '@/src/platform/browser/ids';
import {config, configReady} from '@/src/services/config/store';
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {createNativePdfSelectionHandler} from './nativePdfSelection';

type DocumentNavigationContext = {
    sender?: {
        id?: string;
        url?: string;
        frameId?: number;
        tab?: {id?: number; windowId?: number};
    };
};

type OpenPaperPdfMessage = {type: 'openPaperPdf'; url?: unknown};
type OpenPaperPdfResponse = {status: 'success' | 'invalid-source' | 'disabled' | 'failed'};

interface PaperPdfPorts {
    ready: Promise<unknown>;
    extensionId: string;
    isDisabled(url: string): boolean;
    openPdf(url: string, windowId?: number): Promise<unknown>;
}

export function createPaperPdfHandler(
    ports: PaperPdfPorts,
): BackgroundMessageHandler<DocumentNavigationContext, OpenPaperPdfMessage, OpenPaperPdfResponse> {
    return {
        type: 'openPaperPdf',
        async handle(message, {sender}) {
            const tab = sender?.tab;
            if (sender?.id !== ports.extensionId || sender.frameId !== 0 || !tab || !isBrowserTabId(tab.id)
                || !sender.url || typeof message.url !== 'string') return {status: 'invalid-source'};
            const pdfUrl = resolvePaperPdfUrl(sender.url, message.url);
            if (!pdfUrl) return {status: 'invalid-source'};
            try {
                await ports.ready;
                if (ports.isDisabled(sender.url)) return {status: 'disabled'};
                await ports.openPdf(pdfUrl, tab.windowId);
                return {status: 'success'};
            } catch {
                return {status: 'failed'};
            }
        },
    };
}

export function createDocumentNavigationHandlers<Context extends DocumentNavigationContext>(): readonly BackgroundMessageHandler<Context>[] {
    return [createNativePdfSelectionHandler<Context>(), createPaperPdfHandler({
        ready: configReady,
        extensionId: browser.runtime.id,
        isDisabled: url => config.on === false || isExtensionDisabledOnSite(url, config.disabledExtensionDomains),
        openPdf: (source, windowId) => browser.tabs.create({
            url: createPdfReaderUrl(browser.runtime.getURL('/document.html'), source),
            ...(windowId === undefined ? {} : {windowId}),
        }),
    })];
}

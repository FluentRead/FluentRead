/**
 * @file src/app/background/contextMenuActions.ts
 * 文件职责：执行右键菜单点击后的实际动作，把菜单语义翻译成发往对应 frame 的运行时消息或网站级配置写入。
 * 主要内容：转发划词、整页、圈选和图片四类翻译请求并回收全文翻译状态；原生在线 PDF 的划词保留浏览器查看器并在独立窗口展示本次选区，整页入口仍打开扩展阅读器；按基础域切换当前网站的扩展开关。
 * 模块边界：本文件只负责动作执行，不创建菜单、不计算标题、不缓存标签页状态；菜单结构归 core/context-menu，生命周期与状态同步归 contextMenuRuntime。
 */
import type {ContextMenuActionId} from '@/src/core/context-menu/domain';
import {getSiteBaseDomain, isExtensionDisabledOnSite, normalizeDisabledExtensionDomains} from '@/src/core/site-rules/domain';
import {config, configReady, saveConfig} from '@/src/services/config/store';
import {backgroundConfigMutations} from './configMutationQueue';
import {createPdfReaderUrl, getPdfSourceUrl} from '@/src/features/document-translation/core/pdfSource';
import type {FullPageStateResponse} from './tabTranslationQuery';
import type {ContextMenuFailureReason} from '@/src/core/context-menu/feedback';
import {openNativePdfSelection} from './nativePdfSelection';

export interface ContextMenuClickInfo {
    readonly menuItemId?: unknown;
    readonly srcUrl?: string;
    readonly frameId?: number;
    readonly frameUrl?: string;
    readonly pageUrl?: string;
    readonly selectionText?: string;
}

export interface ContextMenuClickTab {
    readonly id?: number;
    readonly url?: string;
    readonly title?: string;
}

/** 点击结果：翻译类动作回传新的全文翻译状态，网站开关回传该网站之后的禁用状态。 */
export interface ContextMenuActionResult {
    readonly handled: boolean;
    readonly isTranslated?: boolean;
    readonly isSiteDisabled?: boolean;
    readonly reason?: ContextMenuFailureReason;
}

function targetFrameId(info: ContextMenuClickInfo): number {
    return Number.isInteger(info.frameId) && info.frameId! >= 0 ? info.frameId! : 0;
}

async function sendToFrame(tabId: number, info: ContextMenuClickInfo, message: Record<string, unknown>): Promise<unknown> {
    return browser.tabs.sendMessage(tabId, message, {frameId: targetFrameId(info)});
}

/**
 * 切换当前网站的扩展开关，并回传切换之后的禁用状态。
 *
 * 与弹窗一致，只写入基础域名单；必须经后台配置队列 saveConfig 持久化并广播，
 * 直接改写内存 config 既不会落盘也不会通知内容脚本，Service Worker 重启后即丢失。
 */
export async function toggleSiteExtensionDisabled(info: ContextMenuClickInfo, tab: ContextMenuClickTab): Promise<ContextMenuActionResult> {
    const domain = getSiteBaseDomain(info.pageUrl || tab.url || '');
    if (!domain) return {handled: false};
    return backgroundConfigMutations.run(async () => {
        await configReady;
        // 在队列内读取最新名单，避免与并发保存交叉时回写旧值。
        const domains = normalizeDisabledExtensionDomains(config.disabledExtensionDomains);
        const disabled = domains.includes(domain);
        const disabledExtensionDomains = disabled
            ? domains.filter((item) => item !== domain)
            : [...domains, domain];
        await saveConfig({...config, disabledExtensionDomains}, {recordHistory: true});
        return {handled: true, isSiteDisabled: !disabled, isTranslated: disabled ? undefined : false};
    });
}

/** 执行一次菜单动作；isTranslated 表示页面在动作之后的全文翻译状态，未知时返回 undefined。 */
export async function runContextMenuAction(
    action: ContextMenuActionId,
    tabId: number,
    info: ContextMenuClickInfo,
    tab: ContextMenuClickTab,
    wasTranslated: boolean,
): Promise<ContextMenuActionResult> {
    if (action === 'toggleSite') return toggleSiteExtensionDisabled(info, tab);
    // 自有扩展文档页没有 content script；使用带目标页 ID 的运行时消息，仅该阅读页响应。
    if (action === 'translateSelection' && tab.url && tab.url.split(/[?#]/u)[0] === browser.runtime?.getURL?.('/document.html')) {
        const response = await browser.runtime.sendMessage({type: 'documentSelectionTranslate', tabId}) as {status?: unknown} | undefined;
        return {handled: response?.status === 'success'};
    }
    // 原生 PDF 内部选区不向网页脚本暴露；右键菜单提供的文本经一次性票据交给独立结果页。
    // 整页动作只查看顶层 URL；划词动作允许来自嵌入 PDF 的 frame，不能把普通宿主页误当 PDF。
    const pdfCandidates = action === 'translateSelection' ? [info.frameUrl, info.pageUrl, tab.url]
        : action === 'translatePage' ? [info.pageUrl, tab.url] : [];
    const pdfSource = pdfCandidates.map(url => getPdfSourceUrl(url || '')).find(url => url !== null);
    if (pdfSource) {
        if (action === 'translateSelection') {
            if (config.on === false || config.disableSelectionTranslator === true || config.selectionTranslatorMode === 'disabled'
                || isExtensionDisabledOnSite(pdfSource, config.disabledExtensionDomains)) return {handled: false, reason: 'disabled'};
            const handled = await openNativePdfSelection({text: info.selectionText || '', sourceUrl: pdfSource, title: tab.title || ''});
            return handled ? {handled: true} : {handled: false, reason: 'selectionUnavailable'};
        }
        await browser.tabs.create({url: createPdfReaderUrl(browser.runtime.getURL('/document.html'), pdfSource)});
        return {handled: true};
    }
    if (action === 'translateImage') {
        const response = await sendToFrame(tabId, info, {type: 'contextMenuTranslateImage', srcUrl: info.srcUrl}) as FullPageStateResponse | undefined;
        return response?.status === 'success' ? {handled: true}
            : {handled: false, reason: response?.status === 'disabled' ? 'disabled' : 'imageUnavailable'};
    }
    if (action === 'translateSelection' || action === 'translateArea') {
        const response = await sendToFrame(tabId, info, {
            type: 'contextMenuTranslate',
            action: action === 'translateSelection' ? 'selection' : 'area',
            ...(action === 'translateSelection' && typeof info.selectionText === 'string' ? {selectionText: info.selectionText} : {}),
        }) as FullPageStateResponse | undefined;
        return response?.status === 'success' ? {handled: true} : {
            handled: false,
            reason: response?.status === 'disabled' ? 'disabled'
                : action === 'translateSelection' ? 'selectionUnavailable' : 'areaUnavailable',
        };
    }
    // 整页翻译始终作用于顶层文档，不能落到用户右键所在的子 frame。
    const response = await browser.tabs.sendMessage(tabId, {
        type: 'contextMenuTranslate',
        action: wasTranslated ? 'restore' : 'fullPage',
    }, {frameId: 0}) as FullPageStateResponse | undefined;
    if (response?.status !== 'success') return {handled: false};
    return {
        handled: true,
        isTranslated: typeof response.isTranslated === 'boolean' ? response.isTranslated : !wasTranslated,
    };
}

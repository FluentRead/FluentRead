/**
 * @file src/app/background/contextMenuClicks.ts
 * 文件职责：执行右键菜单点击并约束异步动作的文档归属、等待时间与重复点击次序。
 * 主要内容：冷启动点击等待结构就绪；轻量动作直接交付目标 frame，全文与网站开关按标签页串行，导航清除旧队列；状态查询和动作确认使用有界等待，失败只发送有限原因提示，不自动重发翻译。
 * 模块边界：这里只编排点击、状态仓库和动作端口，不创建原生菜单、不推导菜单结构、不调用供应商；结构和配置由安装模块提供，菜单状态写入由 updater 负责。
 */
import {resolveContextMenuPresentation, type ContextMenuPlanItem} from '@/src/core/context-menu/domain';
import {config} from '@/src/services/config/store';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {getPdfSourceUrl} from '@/src/features/document-translation/core/pdfSource';
import {runContextMenuAction, type ContextMenuClickInfo, type ContextMenuClickTab} from './contextMenuActions';
import {reportContextMenuFailure} from './contextMenuFeedback';
import {withContextMenuDeadline} from './contextMenuDelivery';
import {isBrowserTabId, type TabTranslationState, type TabTranslationStateStore} from './tabTranslationState';
import type {TabTranslationStateReader} from './tabTranslationQuery';
import type {ContextMenuSettingsSnapshot} from './contextMenuPreferences';

interface ContextMenuClickDependencies {
    readonly ready: () => Promise<void>;
    readonly getSettings: () => ContextMenuSettingsSnapshot;
    readonly getPlan: () => readonly ContextMenuPlanItem[];
    readonly tabTranslationStates: TabTranslationStateStore;
    readonly readTabTranslationState: TabTranslationStateReader;
    readonly update: (tabId: number, known?: TabTranslationState) => Promise<void>;
}

export function createContextMenuClickHandler({ready, getSettings, getPlan, tabTranslationStates,
    readTabTranslationState, update}: ContextMenuClickDependencies) {
    const pageActions = new Map<number, Promise<void>>();
    const reset = (tabId: number): void => {pageActions.delete(tabId);};
    const handleClick = async (info: ContextMenuClickInfo, tab: ContextMenuClickTab): Promise<void> => {
        if (!isBrowserTabId(tab.id)) return;
        const tabId = tab.id, currentDocument = tabTranslationStates.captureDocument(tabId);
        try {
            await ready();
            const snapshot = getSettings(), items = getPlan();
            const item = items.find(entry => entry.menuItemId === info.menuItemId);
            if (!item || !currentDocument()) return;
            const pageUrl = info.pageUrl || tab.url;
            const siteDisabled = () => pageUrl
                ? isExtensionDisabledOnSite(pageUrl, config.disabledExtensionDomains)
                : tabTranslationStates.get(tabId).isSiteDisabled;
            const execute = async (): Promise<void> => {
                if (!currentDocument() || snapshot !== getSettings() || items !== getPlan()) return;
                const isPdf = item.action === 'translatePage'
                    && [info.pageUrl, tab.url].some(url => getPdfSourceUrl(url || '') !== null);
                // 选区、图片、圈选和 PDF 不依赖顶层全文状态；嵌入 frame 不应多等一次无关查询。
                const state = item.action === 'translatePage' && !isPdf && !siteDisabled()
                    ? await withContextMenuDeadline(readTabTranslationState(tabId, true), 3_000)
                    : tabTranslationStates.get(tabId);
                if (!currentDocument() || snapshot !== getSettings() || items !== getPlan()) return;
                const [presentation] = resolveContextMenuPresentation([item], {...state, isSiteDisabled: siteDisabled()}, snapshot.display);
                if (!presentation.visible) {
                    await reportContextMenuFailure(tabId, info, 'disabled', currentDocument);
                    return;
                }
                const result = await withContextMenuDeadline(runContextMenuAction(presentation.action, tabId, info, tab, state.isTranslated), 5_000);
                if (!currentDocument()) return;
                if (!result.handled) {
                    await reportContextMenuFailure(tabId, info, result.reason ?? 'failed', currentDocument);
                    return;
                }
                if (typeof result.isSiteDisabled === 'boolean') tabTranslationStates.setSiteDisabled(tabId, result.isSiteDisabled);
                if (typeof result.isTranslated === 'boolean') tabTranslationStates.setTranslated(tabId, result.isTranslated);
                if (presentation.action === 'translatePage' || presentation.action === 'toggleSite') {
                    // 展示刷新有自己的顺序与归属门禁，不让原生菜单写入占用已经确认完成的点击队列。
                    void update(tabId, tabTranslationStates.get(tabId)).catch(() => undefined);
                }
            };
            if (item.action === 'translatePage' || item.action === 'toggleSite' || siteDisabled()) {
                // 同一页重复点击读取前一动作后的真值；导航 reset 后新文档不继承旧文档挂起的队列。
                const previous = pageActions.get(tabId) ?? Promise.resolve();
                const queued = previous.catch(() => undefined).then(execute);
                pageActions.set(tabId, queued);
                try {await queued;} finally {if (pageActions.get(tabId) === queued) pageActions.delete(tabId);}
            } else {
                await execute();
            }
        } catch {
            if (currentDocument()) await reportContextMenuFailure(tabId, info, 'unavailable', currentDocument);
        }
    };
    return {handleClick, reset};
}

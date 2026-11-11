/**
 * @file src/app/background/toolbarActionRuntime.ts
 * 文件职责：把浏览器工具栏图标的点击行为与用户的一键翻译偏好同步，并保留快捷面板入口。
 * 主要内容：启动时同步注册 action/browserAction 监听，配置就绪后串行更新原生 popup；逐标签页排队点击，回源读取当前全文状态，复用翻译、恢复、PDF 与失败反馈；导航和关闭后废弃旧操作。
 * 模块边界：只编排浏览器入口和现有全文消息，不实现翻译、不增加权限；快捷面板以固定来源标签页打开，持久化仍由统一配置服务负责。
 */
import {config, configReady, subscribeConfig} from '@/src/services/config/store';
import {isExtensionDisabledOnSite} from '@/src/core/site-rules/domain';
import {getPdfSourceUrl} from '@/src/features/document-translation/core/pdfSource';
import {translate, type UiLanguage} from '@/src/core/i18n';
import {runContextMenuAction, type ContextMenuClickTab} from './contextMenuActions';
import {reportContextMenuFailure} from './contextMenuFeedback';
import {withContextMenuDeadline} from './contextMenuDelivery';
import {isBrowserTabId, type TabTranslationStateStore} from './tabTranslationState';
import type {FullPageStateResponse} from './tabTranslationQuery';

export const TOOLBAR_QUICK_PANEL_MENU_ID = 'fluentread-toolbar-quick-panel';

/** 单独打开面板时绑定原网页，避免面板新标签页成为翻译目标。 */
export async function openToolbarQuickPanel(tabId: number): Promise<void> {
    const url = new URL(browser.runtime.getURL('/popup.html'));
    url.searchParams.set('sourceTabId', String(tabId));
    await browser.tabs.create({url: url.href});
}

/** 与网页菜单共用重建周期，但仅显示在浏览器工具栏图标的右键菜单中。 */
export async function createToolbarQuickPanelMenu(language: UiLanguage): Promise<void> {
    await browser.contextMenus.create({id: TOOLBAR_QUICK_PANEL_MENU_ID,
        title: translate('toolbar.openPopup', language),
        contexts: [browser.runtime.getManifest().manifest_version === 3 ? 'action' : 'browser_action']});
}

/** 冷启动菜单点击先水合配置，之后确认当前偏好仍允许独立面板。 */
export function handleToolbarQuickPanelClick(menuItemId: unknown, tab: ContextMenuClickTab | undefined): boolean {
    if (menuItemId !== TOOLBAR_QUICK_PANEL_MENU_ID) return false;
    void configReady.then(async () => {
        if (config.toolbarClickAction === 'translate' && isBrowserTabId(tab?.id)) await openToolbarQuickPanel(tab.id);
    }).catch(error => console.error('[FluentRead] 快捷面板打开失败', error));
    return true;
}

export function installToolbarActionRuntime(states: TabTranslationStateStore): void {
    const action = browser.action ?? browser.browserAction;
    if (!action?.setPopup || !action.onClicked) return;
    const manifest = browser.runtime.getManifest();
    const defaultPopup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
    // Thunderbird 邮件按钮已有独立运行时；没有默认快捷面板的宿主不改写其入口。
    if (!defaultPopup) return;
    let popupQueue = Promise.resolve();
    const syncPopup = (): void => {
        const popup = config.toolbarClickAction === 'translate' ? '' : defaultPopup;
        popupQueue = popupQueue.then(() => action.setPopup({popup}))
            .catch(error => console.error('[FluentRead] 工具栏点击设置同步失败', error));
    };
    const ready = configReady.then(() => {
        syncPopup();
        let previous = config.toolbarClickAction;
        subscribeConfig(() => {
            if (previous === config.toolbarClickAction) return;
            previous = config.toolbarClickAction;
            syncPopup();
        });
    });
    const queues = new Map<number, Promise<void>>();
    action.onClicked.addListener((tab: ContextMenuClickTab) => {
        if (!isBrowserTabId(tab.id)) return;
        const tabId = tab.id, current = states.captureDocument(tabId);
        const enabled = () => current() && config.toolbarClickAction === 'translate';
        const execute = async (): Promise<void> => {
            await ready;
            if (!enabled()) return;
            if (config.on === false) {
                await openToolbarQuickPanel(tabId);
                return;
            }
            if (isExtensionDisabledOnSite(tab.url || '', config.disabledExtensionDomains)) {
                await reportContextMenuFailure(tabId, {}, 'disabled', current);
                return;
            }
            let translated = false;
            if (!getPdfSourceUrl(tab.url || '')) {
                const response = await withContextMenuDeadline(browser.tabs.sendMessage(tabId,
                    {type: 'getFullPageTranslationState'}, {frameId: 0}), 3000) as FullPageStateResponse | undefined;
                if (!enabled()) return;
                if (response?.status !== 'success') {
                    await reportContextMenuFailure(tabId, {}, response?.status === 'disabled' ? 'disabled' : 'unavailable', current);
                    return;
                }
                translated = response.isTranslated === true;
            }
            const result = await withContextMenuDeadline(runContextMenuAction('translatePage', tabId, {}, tab, translated), 5000);
            if (enabled() && !result.handled) await reportContextMenuFailure(tabId, {}, result.reason ?? 'failed', current);
        };
        const job = (queues.get(tabId) ?? Promise.resolve()).then(execute).catch(async () => {
            // 内部页和失去内容脚本的网页无法接收通知；打开面板供用户查看状态和更换设置。
            if (enabled()) await openToolbarQuickPanel(tabId).catch(error => console.error('[FluentRead] 快捷面板打开失败', error));
        }).finally(() => {if (queues.get(tabId) === job) queues.delete(tabId);});
        queues.set(tabId, job);
    });
    // 文档身份由共享状态仓库的导航监听失效；新页面不等待旧页面的未完成消息。
    browser.tabs.onUpdated.addListener((tabId: number, change: {status?: string}) => {if (change.status === 'loading') queues.delete(tabId);});
    browser.tabs.onRemoved.addListener((tabId: number) => {queues.delete(tabId);});
}

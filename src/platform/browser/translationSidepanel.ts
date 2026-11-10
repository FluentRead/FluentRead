/**
 * @file src/platform/browser/translationSidepanel.ts
 * 文件职责：封装工具栏弹窗打开原生翻译侧边栏的浏览器边界。
 * 主要内容：按构建目标探测 Chromium sidePanel 与 Firefox sidebarAction；在当前标签页注册并打开独立面板，或清理当前窗口中旧的标签页面板后打开窗口面板。
 * 模块边界：只适配原生浏览器 API，不创建替代页面或保存翻译内容；调用者提供用户手势、范围、目标和失败提示。
 */
import browser from 'webextension-polyfill';
import type {TranslationSidepanelScope} from '@/src/core/config/model';
import {browserCapabilities} from './capabilities';
import {isBrowserTabId} from './ids';

const SIDEPANEL_PATH = 'sidepanel.html';

type PanelOptions = {tabId?: number; path?: string; enabled?: boolean};
type ChromiumSidepanel = {
    getOptions(options: {tabId: number}): Promise<PanelOptions>;
    setOptions(options: PanelOptions): Promise<void>;
    open(options: {tabId: number} | {windowId: number}): Promise<void>;
};

function chromiumSidepanel(): ChromiumSidepanel | undefined {
    if (browserCapabilities.browser !== 'chrome' && browserCapabilities.browser !== 'edge') return;
    return (globalThis as typeof globalThis & {chrome?: {sidePanel?: ChromiumSidepanel}}).chrome?.sidePanel;
}

/** 仅在产物和实际宿主都支持原生面板时提供入口。 */
export function canOpenTranslationSidepanel(): boolean {
    if (browserCapabilities.browser === 'firefox') return typeof browser.sidebarAction?.open === 'function';
    const panel = chromiumSidepanel();
    return typeof panel?.open === 'function' && typeof panel.setOptions === 'function' && typeof panel.getOptions === 'function';
}

export async function openTranslationSidepanel(
    target: {scope: TranslationSidepanelScope; tabId: number | null; windowId?: number},
    isCurrent: () => boolean,
): Promise<void> {
    if (!canOpenTranslationSidepanel()) throw new Error('Native translation sidepanel is unavailable');
    if (browserCapabilities.browser === 'firefox') return browser.sidebarAction.open();

    const panel = chromiumSidepanel()!;
    const {scope, tabId, windowId} = target;
    if (scope === 'tab') {
        if (!isBrowserTabId(tabId)) throw new Error('Translation sidepanel requires a current tab');
        // Chromium 按顺序处理这些请求；在同一次点击内提交 open，保留用户激活。
        await Promise.all([
            panel.setOptions({enabled: false}),
            panel.setOptions({tabId, path: SIDEPANEL_PATH, enabled: true}),
            panel.open({tabId}),
        ]);
        return;
    }

    if (!isBrowserTabId(windowId)) throw new Error('Translation sidepanel requires a current window');
    // 原生标签页面板会优先于窗口面板。先找出此窗口内的旧注册，再切换范围。
    const tabs = await browser.tabs.query({windowId});
    const tabOptions = await Promise.all(tabs.flatMap(tab => isBrowserTabId(tab.id) ? [panel.getOptions({tabId: tab.id})] : []));
    if (!isCurrent()) return;
    const previousTabs = tabOptions.flatMap(options => isBrowserTabId(options.tabId) && options.enabled ? [options.tabId] : []);
    await Promise.all([
        ...previousTabs.map(tabId => panel.setOptions({tabId, enabled: false})),
        // Edge 会在禁用过的标签页上屏蔽窗口面板。关闭旧面板后重新允许该标签页。
        ...(browserCapabilities.browser === 'edge' ? previousTabs.map(tabId => panel.setOptions({tabId, enabled: true})) : []),
        panel.setOptions({path: SIDEPANEL_PATH, enabled: true}),
        panel.open({windowId}),
    ]);
}

/**
 * @file src/platform/browser/translationSidepanel.ts
 * 文件职责：封装工具栏弹窗打开原生翻译侧边栏的浏览器边界。
 * 主要内容：按构建目标探测 Chromium sidePanel 与 Firefox sidebarAction，直接在点击调用栈内打开指定窗口的面板，拒绝缺失的窗口身份与不支持的平台。
 * 模块边界：只适配原生浏览器 API，不查询标签页、不创建替代页面、不保存翻译内容；调用者持有用户手势、窗口身份和失败提示。
 */
import browser from 'webextension-polyfill';
import {browserCapabilities} from './capabilities';
import {isBrowserTabId} from './ids';

type ChromiumSidepanel = {open(options: {windowId: number}): Promise<void>};
function chromiumSidepanel(): ChromiumSidepanel | undefined {
    return (globalThis as typeof globalThis & {chrome?: {sidePanel?: ChromiumSidepanel}}).chrome?.sidePanel;
}

/** 仅在产物和实际宿主都支持原生面板时提供入口。 */
export function canOpenTranslationSidepanel(): boolean {
    if (browserCapabilities.browser === 'firefox') return typeof browser.sidebarAction?.open === 'function';
    return ['chrome', 'edge'].includes(browserCapabilities.browser) && typeof chromiumSidepanel()?.open === 'function';
}

/** 不在原生 open 前 await，保留 Chromium 与 Firefox 要求的用户手势。 */
export async function openTranslationSidepanel(windowId?: number): Promise<void> {
    if (!canOpenTranslationSidepanel()) throw new Error('Native translation sidepanel is unavailable');
    if (browserCapabilities.browser === 'firefox') return browser.sidebarAction.open();
    if (!isBrowserTabId(windowId)) throw new Error('Translation sidepanel requires a current window');
    return chromiumSidepanel()!.open({windowId});
}

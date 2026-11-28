/**
 * @file src/app/background/popupNavigation.ts
 * 文件职责：装配默认 popup 的页内授权端口与完整设置页的现有导航端口。
 * 主要内容：从清单读取精确默认页面，用加密随机数签发短期凭据，并组装白名单设置分区、生词本子页及同分区表单锚点的导航 URL。
 * 模块边界：仅装配浏览器能力；凭据与设置目标校验属于各 feature，不将悬浮球的默认 popup 请求导航到完整设置页。
 */
import {createFloatingPopupHandlers} from '@/src/features/floating-ball/background/popupHandler';
import {createCommandPaletteNavigationHandlers} from './commandPaletteNavigation';
import {createOpenOptionsPageHandler} from './handlers/openOptions';
export type {PopupContext} from '@/src/features/floating-ball/background/popupHandler';

type NativeSidepanelHost = typeof globalThis & {
    chrome?: {sidePanel?: {open?: (options: {tabId: number} | {windowId: number}) => Promise<void>}};
};

export function createPopupNavigationHandlers() {
    const manifest = browser.runtime.getManifest();
    const popup = manifest.action?.default_popup || manifest.browser_action?.default_popup;
    if (!popup) throw new Error('未配置扩展快捷面板');
    return [...createFloatingPopupHandlers({
        runtimeId: browser.runtime.id,
        popupUrl: browser.runtime.getURL(popup),
        now: Date.now,
        randomToken: () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
    }), createOpenOptionsPageHandler({
        openDefaultPage: () => browser.runtime.openOptionsPage(),
        openSection: async (section, destination, target) => {
            const params = new URLSearchParams();
            if (destination) params.set(section === 'settings-vocabulary' ? 'learningTab' : 'service', destination);
            if (target) params.set('target', target);
            const encoded = params.toString();
            const query = encoded ? `?${encoded}` : '';
            await browser.tabs.create({url: `${browser.runtime.getURL('/options.html')}${query}#${section}`});
        },
    }), ...createCommandPaletteNavigationHandlers({
        extensionId: browser.runtime.id,
        openDocumentWorkspace: async (windowId) => {
            await browser.tabs.create({
                url: browser.runtime.getURL('/document.html'),
                ...(windowId === undefined ? {} : {windowId}),
            });
        },
        openSidepanel: async (tabId, windowId) => {
            const chromeSidePanel = (globalThis as NativeSidepanelHost).chrome?.sidePanel;
            if (typeof chromeSidePanel?.open === 'function') {
                if (typeof tabId === 'number') {
                    await chromeSidePanel.open({tabId});
                    return true;
                }
                if (typeof windowId === 'number') {
                    await chromeSidePanel.open({windowId});
                    return true;
                }
            }
            if (typeof browser.sidebarAction?.open === 'function') {
                await browser.sidebarAction.open();
                return true;
            }
            return false;
        },
        openTranslationCenterFallback: async () => {
            await browser.tabs.create({url: `${browser.runtime.getURL('/options.html')}#settings-translation-center`});
        },
    })] as const;
}

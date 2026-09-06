/**
 * @file src/app/background/imageContextMenu.ts
 * 文件职责：管理图片右键入口的能力和配置门禁，并把点击定向转发到原始 frame。
 * 主要内容：创建本地化图片菜单、检查总开关和图片入口偏好、转发原生菜单的资源地址。
 * 模块边界：只负责后台菜单适配；图片身份确认及翻译恢复由内容脚本负责，不在后台扫描 DOM。
 */
import {CONTEXT_MENU_IDS} from '@/src/core/config/constants';
import {translate, type UiLanguage} from '@/src/core/i18n';
import {browserCapabilities} from '@/src/platform/browser/capabilities';
import {config} from '@/src/services/config/store';
import {isBrowserTabId} from './tabTranslationState';

export const imageMenuEnabled = (): boolean => browserCapabilities.imageTranslation && config.on !== false
    && !config.disableImageTranslator && config.imageTranslationContextMenuEnabled !== false;

export async function createImageContextMenu(language: UiLanguage): Promise<void> {
    if (!imageMenuEnabled()) return;
    await browser.contextMenus.create({id: CONTEXT_MENU_IDS.TRANSLATE_IMAGE,
        title: translate('contextMenu.image', language), contexts: ['image']});
}

export function routeImageContextMenu(info: {menuItemId: unknown; srcUrl?: string; frameId?: number}, tab?: {id?: number}): boolean {
    if (info.menuItemId !== CONTEXT_MENU_IDS.TRANSLATE_IMAGE) return false;
    if (imageMenuEnabled() && isBrowserTabId(tab?.id)) {
        void browser.tabs.sendMessage(tab!.id!, {type: 'contextMenuTranslateImage', srcUrl: info.srcUrl},
            {frameId: Number.isInteger(info.frameId) && info.frameId! >= 0 ? info.frameId : 0})
            .catch((error: unknown) => console.error('Failed to translate context image:', error));
    }
    return true;
}

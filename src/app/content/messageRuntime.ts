/**
 * @file src/app/content/messageRuntime.ts
 * 文件职责：创建 content 侧 runtime 消息处理函数，把 popup/background 的设置变化和功能命令映射为当前页面上的精确 mount、unmount 或状态响应。
 * 主要内容：处理悬浮球、划词模式与延迟、区域/图片能力、进度面板、站点禁用及旧缓存清理消息；结合 BrowserCapabilities 对不支持功能确定性拒绝，并更新共享运行时状态。
 * 模块边界：本文件只做消息到 feature 生命周期的适配，不注册全局监听器、不执行供应商翻译，也不实现组件 UI；监听安装及配置订阅由 content/runtime 负责。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {normalizeSelectionTranslatorDelay} from '@/src/core/config/model';
import {config} from '@/src/services/config/store';
import {
    autoTranslateEnglishPage,
    invalidateFullPageTranslationSessionCache,
    isFullPageTranslationActive,
    mountAreaTranslator,
    mountFloatingBall,
    toggleContextMenuImage,
    mountImageTranslator,
    mountSelectionTranslator,
    mountTranslationProgressPanel,
    restoreOriginalContent,
    unmountAreaTranslator,
    unmountFloatingBall,
    unmountImageTranslator,
    unmountSelectionTranslator,
    unmountTranslationProgressPanel,
} from './features';
import {forwardLegacyCacheClear} from './cacheMessage';
import {browserCapabilities, type BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {rejectUnsupportedContentFeature} from './featureRegistry';
export interface ContentRuntimeMessageState {
    isSiteDisabled(): boolean;
    updateSiteDisabled(disabled: boolean): Promise<void>;
}
export type ContentRuntimeMessageHandler = (
    message: unknown, sender: unknown,
    sendResponse: (response?: unknown) => void,
) => boolean;
/** 创建当前 document 私有的 runtime message handler，避免跨生命周期共享可变状态。 */
export function createContentRuntimeMessageHandler(ctx: ContentScriptContext, state: ContentRuntimeMessageState,
    capabilities: BrowserCapabilities = browserCapabilities): ContentRuntimeMessageHandler {
    return (message, _sender, sendResponse) => {
        if (!message || typeof message !== 'object') return false;
        const payload = message as Record<string, unknown>;
        if (payload.type === 'qqMailFrameCommand' || payload.type === 'qqMailFrameRefresh') return false;
        if (payload.message === 'clearCache') {
            forwardLegacyCacheClear(
                (request) => browser.runtime.sendMessage(request),
                sendResponse,
            );
            return true;
        }
        if (payload.type === 'translationCacheCleared') {
            invalidateFullPageTranslationSessionCache();
            sendResponse({status: 'success'});
            return true;
        }
        if (payload.type === 'updateSiteExtensionDisabled') {
            if (typeof payload.isDisabled !== 'boolean') return false;
            void state.updateSiteDisabled(payload.isDisabled)
                .then(() => sendResponse({status: 'success'}))
                .catch(() => sendResponse({status: 'failed'}));
            return true;
        }
        if (state.isSiteDisabled() && payload.type !== 'getFullPageTranslationState') {
            sendResponse({status: 'disabled'});
            return true;
        }
        if (payload.type === 'toggleFloatingBall') {
            const requestedEnabled = payload.isEnabled === true;
            config.disableFloatingBall = !requestedEnabled;
            if (requestedEnabled && config.on !== false) void mountFloatingBall(ctx);
            else unmountFloatingBall();
            sendResponse();
            return true;
        }
        if (payload.type === 'updateSelectionTranslatorMode') {
            const mode = payload.mode;
            if (mode !== 'disabled' && mode !== 'bilingual' && mode !== 'translation-only') return false;
            config.selectionTranslatorMode = mode;
            config.disableSelectionTranslator = mode === 'disabled';
            if ((mode === 'disabled' && !config.harness?.enabled) || config.on === false) unmountSelectionTranslator();
            else if (!document.getElementById('fluent-read-selection-translator-container')) {
                void mountSelectionTranslator(ctx);
            }
            sendResponse();
            return true;
        }
        if (payload.type === 'updateSelectionTranslatorSettings') {
            const {trigger, hotkey, customHotkey, delay} = payload;
            if (trigger !== 'direct' && trigger !== 'icon' && trigger !== 'dot'
                && trigger !== 'Control' && trigger !== 'Alt' && trigger !== 'Shift' && trigger !== 'custom') return false;
            if (hotkey !== undefined && hotkey !== 'none' && hotkey !== 'Control'
                && hotkey !== 'Alt' && hotkey !== 'Shift' && hotkey !== 'custom') return false;
            if (customHotkey !== undefined && typeof customHotkey !== 'string') return false;
            if (delay !== undefined && typeof delay !== 'number' && typeof delay !== 'string') return false;
            // trigger 是唯一运行时真源；hotkey 仅兼容旧消息结构。
            config.selectionTranslatorTrigger = trigger;
            config.selectionTranslatorHotkey = trigger === 'Control' || trigger === 'Alt'
                || trigger === 'Shift' || trigger === 'custom'
                ? trigger
                : 'none';
            config.customSelectionTranslatorHotkey = typeof customHotkey === 'string' ? customHotkey : '';
            if (delay !== undefined) config.selectionTranslatorDelay = normalizeSelectionTranslatorDelay(delay);
            sendResponse();
            return true;
        }
        if (payload.type === 'toggleSelectionAreaTranslator') {
            if (rejectUnsupportedContentFeature(capabilities.areaTranslation, unmountAreaTranslator,
                sendResponse, '当前浏览器暂不支持圈选翻译')) return true;
            const requestedEnabled = payload.isEnabled === true;
            config.selectionAreaEnabled = requestedEnabled;
            if (requestedEnabled && config.on !== false) void mountAreaTranslator(ctx);
            else unmountAreaTranslator();
            sendResponse();
            return true;
        }
        if (payload.type === 'contextMenuTranslateImage') {
            sendResponse({status: capabilities.imageTranslation && toggleContextMenuImage(payload.srcUrl) ? 'success' : 'disabled'});
            return true;
        }
        if (payload.type === 'toggleImageTranslator') {
            if (rejectUnsupportedContentFeature(capabilities.imageTranslation, unmountImageTranslator,
                sendResponse, '当前浏览器暂不支持图片翻译与 OCR')) return true;
            const requestedEnabled = payload.isEnabled === true;
            config.disableImageTranslator = !requestedEnabled;
            if (requestedEnabled && config.on !== false) mountImageTranslator();
            else unmountImageTranslator();
            sendResponse();
            return true;
        }
        if (payload.type === 'toggleTranslationProgressPanel') {
            const requestedEnabled = payload.isEnabled === true;
            config.translationProgressPanelEnabled = requestedEnabled;
            if (requestedEnabled && config.on !== false) void mountTranslationProgressPanel(ctx);
            else unmountTranslationProgressPanel();
            sendResponse();
            return true;
        }
        if (payload.type === 'getFullPageTranslationState') {
            sendResponse({
                status: 'success',
                isTranslated: config.on !== false && !state.isSiteDisabled() && isFullPageTranslationActive(),
                isSiteDisabled: state.isSiteDisabled(),
            });
            return true;
        }
        if (payload.type === 'contextMenuTranslate') {
            if (config.on === false || state.isSiteDisabled()) {
                sendResponse({status: 'disabled'});
                return true;
            }
            if (payload.action === 'fullPage') {
                autoTranslateEnglishPage();
                const isTranslated = isFullPageTranslationActive();
                sendResponse({
                    status: isTranslated ? 'success' : 'failed',
                    action: isTranslated ? 'translated' : 'unchanged',
                    isTranslated,
                });
                return true;
            }
            if (payload.action === 'restore') {
                restoreOriginalContent();
                const isTranslated = isFullPageTranslationActive();
                sendResponse({
                    status: isTranslated ? 'failed' : 'success',
                    action: isTranslated ? 'unchanged' : 'restored',
                    isTranslated,
                });
                return true;
            }
        }
        return false;
    };
}

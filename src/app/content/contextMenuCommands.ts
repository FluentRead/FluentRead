/**
 * @file src/app/content/contextMenuCommands.ts
 * 文件职责：将右键菜单命令转给对应翻译功能，并通过现有页面通知解释未启动操作的原因。
 * 主要内容：严格校验失败原因与选区文本，绑定通知的文档生命周期，回收图片、选区、圈选及全文翻译的实际启动状态，成功后撤销同组过期提示。
 * 模块边界：只适配生产消息和 feature 公共入口，不执行供应商请求、不读写菜单；停用与页面挂起门禁由消息组合根统一执行。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config} from '@/src/services/config/store';
import {isContextMenuFailureReason} from '@/src/core/context-menu/feedback';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {dismissPageNotice, showPageNotice} from '@/src/features/page-notice/public';
import type {BrowserCapabilities} from '@/src/platform/browser/capabilities';
import {autoTranslateEnglishPage, isFullPageTranslationActive, restoreOriginalContent,
    startAreaTranslationFromContextMenu, startSectionTranslationPicker, translateSelectionFromContextMenu, toggleContextMenuImage} from './features';
import {respondToAreaContextMenu} from './areaContextMenuResponse';

type Respond = (response?: unknown) => void;
interface PageState {isSiteDisabled(): boolean; isPageSuspended?(): boolean;}

/** 反馈允许在停用站点显示，以便解释操作为什么不可用。 */
export function handleContextMenuNotice(payload: Record<string, unknown>, ctx: ContentScriptContext,
    state: PageState, sendResponse: Respond): boolean | undefined {
    if (payload.type === 'contextMenuNotice') {
        if (!isContextMenuFailureReason(payload.reason)) return false;
        if (ctx.isInvalid || state.isPageSuspended?.()) {
            sendResponse({status: 'failed'});
            return true;
        }
        showPageNotice(translate(`contextMenu.notice.${payload.reason}`, normalizeUiLanguage(config.uiLanguage)),
            'error', {key: 'context-menu', signal: ctx.signal, durationMs: 6000});
        sendResponse({status: 'success'});
        return true;
    }
    return undefined;
}

/** undefined 表示不是本模块可识别的命令，组合根继续分发。 */
export function handleContextMenuTranslation(payload: Record<string, unknown>, state: PageState,
    capabilities: BrowserCapabilities, sendResponse: Respond): boolean | undefined {
    const respond = import.meta.env.BROWSER === 'userscript' ? sendResponse
        : (response: {status: string; action?: string; isTranslated?: boolean}): void => {
            if (response.status === 'success') dismissPageNotice('context-menu');
            sendResponse(response);
        };
    if (payload.type === 'contextMenuTranslateImage') {
        const status = !capabilities.imageTranslation ? 'disabled'
            : toggleContextMenuImage(payload.srcUrl) ? 'success' : 'failed';
        respond({status});
        return true;
    }
    if (payload.type === 'contextMenuTranslate') {
        if (config.on === false || state.isSiteDisabled()) {
            respond({status: 'disabled'});
            return true;
        }
        if (payload.action === 'selection' || payload.action === 'section') {
            const started = payload.action === 'section' ? startSectionTranslationPicker()
                : translateSelectionFromContextMenu(typeof payload.selectionText === 'string' ? payload.selectionText : undefined);
            respond({status: started ? 'success' : 'failed'});
            return true;
        }
        if (payload.action === 'area') {
            respondToAreaContextMenu(capabilities.areaTranslation, startAreaTranslationFromContextMenu, respond);
            return true;
        }
        if (payload.action === 'fullPage' || payload.action === 'restore') {
            const restoring = payload.action === 'restore';
            if (restoring) restoreOriginalContent();
            else autoTranslateEnglishPage();
            const isTranslated = isFullPageTranslationActive();
            const changed = isTranslated !== restoring;
            respond({status: changed ? 'success' : 'failed',
                action: changed ? (restoring ? 'restored' : 'translated') : 'unchanged', isTranslated});
            return true;
        }
    }
    return undefined;
}

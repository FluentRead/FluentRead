/**
 * @file src/app/content/hypothesisMessage.ts
 * 文件职责：接收当前网页的 Hypothesis 状态查询和工具栏开关命令。
 * 主要内容：校验消息来源和文档是否可用，将官方侧栏的失败原因显示在当前网页，页面失效后丢弃迟到提示。
 * 模块边界：只适配当前文档的消息与通知，侧栏的创建、注入和卸载交给 Hypothesis 客户端。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {config} from '@/src/services/config/store';
import type {HypothesisResult} from '@/src/features/hypothesis/public';
import {dismissPageNotice, showPageNotice} from '@/src/features/page-notice/public';

export interface HypothesisMessageState {
    isSiteDisabled(): boolean;
    isPageSuspended?(): boolean;
    hypothesis?: {isActive(): boolean; toggle(): Promise<HypothesisResult>};
}

export function handleHypothesisMessage(payload: Record<string, unknown>, sender: unknown, ctx: ContentScriptContext,
    state: HypothesisMessageState, sendResponse: (response?: unknown) => void): boolean | undefined {
    if (payload.type !== 'toggleHypothesis' && payload.type !== 'getHypothesisState') return undefined;
    const senderId = (sender as {id?: string} | undefined)?.id;
    const isAvailable = () => !ctx.isInvalid && config.on !== false && !state.isSiteDisabled() && !state.isPageSuspended?.();
    const client = state.hypothesis;
    if (senderId !== browser.runtime.id || !client || !isAvailable()) {
        sendResponse({status: 'unavailable', active: false});
        return true;
    }
    if (payload.type === 'getHypothesisState') {
        sendResponse({status: 'success', active: client.isActive()});
        return true;
    }
    const respond = (result: HypothesisResult) => {
        if (isAvailable()) {
            if (result.status === 'success') dismissPageNotice('hypothesis');
            else {
                const key = result.status === 'external' ? 'document.pdfReading.hypothesisExternal' : 'document.pdfReading.hypothesisFailed';
                showPageNotice(translate(key, normalizeUiLanguage(config.uiLanguage)), 'error', {key: 'hypothesis', signal: ctx.signal});
            }
        }
        sendResponse(result);
    };
    void client.toggle().then(respond, () => respond({status: 'failed', active: false}));
    return true;
}

/**
 * @file src/app/content/webArticleMessage.ts
 * 文件职责：把一次由扩展发起的正文打开请求绑定到当前网页实例。
 * 主要内容：核对发送扩展、页面地址和状态，按需加载正文抽取，并拒绝跨导航或停用后的结果。
 * 模块边界：只转发有界正文快照，不打开标签页、不持久化、不发翻译请求。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config} from '@/src/services/config/store';
import type {WebArticleExtraction} from '@/src/features/document-translation/content/extractWebArticle';

interface WebArticlePageState {isSiteDisabled(): boolean; isPageSuspended?(): boolean;}

export function handleWebArticleMessage(
    payload: Record<string, unknown>, sender: unknown, ctx: ContentScriptContext,
    state: WebArticlePageState, sendResponse: (response: WebArticleExtraction) => void,
): boolean | undefined {
    if (payload.type !== 'extractWebArticle') return undefined;
    const unavailable = {status: 'unavailable'} as const;
    const expectedUrl = payload.expectedUrl;
    const current = () => !ctx.isInvalid && config.on !== false && !state.isSiteDisabled() &&
        !state.isPageSuspended?.() && window.location.href === expectedUrl;
    const id = (sender as {id?: unknown} | null)?.id;
    if (typeof id !== 'string' || !id || !current() || id !== browser.runtime.id ||
        typeof expectedUrl !== 'string' || !/^https?:\/\//u.test(expectedUrl)) {
        sendResponse(unavailable);
        return true;
    }
    void import('@/src/features/document-translation/content/extractWebArticle').then(module =>
        current() ? module.extractWebArticle(document, expectedUrl) : unavailable,
    ).then(result => sendResponse(current() ? result : unavailable), () => sendResponse(unavailable));
    return true;
}

/**
 * @file src/app/content/fullPageCompletionQuery.ts
 * 文件职责：响应 content 侧全文翻译状态与精确 unchanged completion 只读查询。
 * 主要内容：按原顺序校验可信 sender、配置、WXT 上下文和页面状态，完整验证批量参数，再逐项读取当前 DOM owner 的完成凭据并返回结果；普通状态查询附文档实例标识和脱敏诊断，停用或挂起时隐藏旧诊断。
 * 模块边界：只消费 content features 与全文翻译 public 契约，不启动翻译、不修改 DOM 或配置、不注册监听器；只依赖最小页面状态结构，不反向导入 messageRuntime。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {config} from '@/src/services/config/store';
import {
    isFullPageTranslationActive,
    getTranslationToolbarStatus,
    getFullPageTranslationDiagnostic,
    getFullPageTranslationDocumentToken,
    readFullPageUnchangedCompletion,
    getFullPageTranslationFrameState,
} from '@/src/app/content/features';

interface FullPageCompletionQueryState {
    isSiteDisabled(): boolean;
    isPageSuspended?(): boolean;
}

/** 处理已分派的 getFullPageTranslationState 消息，沿用同步响应与 boolean 协议。 */
export function handleFullPageCompletionQuery(
    payload: Record<string, unknown>,
    _sender: unknown,
    ctx: ContentScriptContext,
    state: FullPageCompletionQueryState,
    sendResponse: (response?: unknown) => void,
): boolean {
    if (payload.unchangedQueries !== undefined) {
        const sender = _sender as {id?: unknown} | null;
        if (!sender || typeof browser.runtime.id !== 'string' || sender.id !== browser.runtime.id ||
            config.on === false || ctx.isInvalid ||
            state.isSiteDisabled() || state.isPageSuspended?.()) {
            sendResponse({status: 'unavailable', reason: 'query-unavailable'});
            return true;
        }
        if (!Array.isArray(payload.unchangedQueries) || payload.unchangedQueries.length > 16) return false;
        const queries = payload.unchangedQueries as Array<Record<string, unknown>>;
        if (queries.some(q => !q || typeof q !== 'object' || typeof q.selector !== 'string' ||
            q.selector.length > 512 || typeof q.source !== 'string' || q.source.length > 2048 ||
            !Number.isInteger(q.index) || Number(q.index) < 0 || Number(q.index) > 1024 ||
            !Number.isInteger(q.sessionId) || Number(q.sessionId) <= 0)) return false;
        const outcomes = queries.map(q => {
            try {
                const owner = document.querySelectorAll<HTMLElement>(q.selector as string)[q.index as number];
                return owner ? readFullPageUnchangedCompletion(owner, q.sessionId as number, q.source as string)
                    : {status: 'unavailable', reason: 'owner-unavailable'};
            } catch {return {status: 'unavailable', reason: 'owner-unavailable'};}
        });
        sendResponse({status: 'success', sessionId: getFullPageTranslationFrameState().sessionId, outcomes});
        return true;
    }
    const diagnostic = config.on !== false && !state.isSiteDisabled() && !state.isPageSuspended?.()
        ? getFullPageTranslationDiagnostic() : undefined;
    sendResponse({
        status: 'success',
        documentToken: getFullPageTranslationDocumentToken(),
        isTranslated: config.on !== false && !state.isSiteDisabled() && isFullPageTranslationActive(),
        isSiteDisabled: state.isSiteDisabled(), toolbarStatus: getTranslationToolbarStatus(),
        ...(diagnostic ? {diagnostic} : {}),
    });
    return true;
}

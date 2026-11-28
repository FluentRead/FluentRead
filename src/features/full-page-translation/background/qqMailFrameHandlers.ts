/**
 * @file src/features/full-page-translation/background/qqMailFrameHandlers.ts
 * 文件职责：在旧版 QQ 邮箱 top frame 与 readmail 子 frame 之间转发全文状态和切换命令。
 * 主要内容：校验 frame URL、sender frameId/tabId 与消息协议，向 frameId=0 转发命令，并广播邮件切换刷新通知。
 * 模块边界：本文件只编排注入的 sendTabMessage，不读取 sid、不解析邮件正文、不保存会话状态；页面状态快照由 content composition root 管理。
 */
import type {BackgroundMessageHandler} from '@/src/services/messaging/backgroundRouter';
import {isBrowserTabId} from '@/src/platform/browser/ids';
import {
    isQqMailReadmailUrl,
    isQqMailLegacyTopUrl,
    makeQQMailFrameCommand,
    parseQQMailFrameChanged,
    parseQQMailFrameRequest,
    QQ_MAIL_FRAME_CHANGED_MESSAGE_TYPE,
    QQ_MAIL_FRAME_REQUEST_MESSAGE_TYPE,
    type QQMailFrameChangedMessage,
    type QQMailFrameRequestMessage,
} from '../qqMailFrames';

export interface QQMailFrameSender {
    frameId?: number;
    url?: string;
    tab?: {id?: number; url?: string};
}

export interface QQMailFrameBackgroundContext {
    sender?: QQMailFrameSender;
}

export interface QQMailFrameHandlerDependencies {
    sendTabMessage(tabId: number, message: unknown, options?: {frameId: number}): Promise<unknown>;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readSenderTab(context: QQMailFrameBackgroundContext): {tabId: number; sender: QQMailFrameSender} | null {
    const sender = context.sender;
    const tabId = sender?.tab?.id;
    return sender && isBrowserTabId(tabId) ? {tabId, sender} : null;
}

function isLegacyReadSender(context: QQMailFrameBackgroundContext): {tabId: number} | null {
    const value = readSenderTab(context);
    if (!value || !isPositiveInteger(value.sender.frameId) ||
        !isQqMailReadmailUrl(value.sender.url) || !isQqMailLegacyTopUrl(value.sender.tab?.url)) return null;
    return {tabId: value.tabId};
}

function isLegacyTopSender(context: QQMailFrameBackgroundContext): {tabId: number} | null {
    const value = readSenderTab(context);
    if (!value || value.sender.frameId !== 0 ||
        !isQqMailLegacyTopUrl(value.sender.url) || !isQqMailLegacyTopUrl(value.sender.tab?.url)) return null;
    return {tabId: value.tabId};
}

function requestHandler(dependencies: QQMailFrameHandlerDependencies): BackgroundMessageHandler<QQMailFrameBackgroundContext, QQMailFrameRequestMessage> {
    return {
        type: QQ_MAIL_FRAME_REQUEST_MESSAGE_TYPE,
        async handle(message, context) {
            const sender = isLegacyReadSender(context);
            const request = parseQQMailFrameRequest(message);
            if (!sender || !request) return {success: false};
            try {
                return await dependencies.sendTabMessage(sender.tabId, makeQQMailFrameCommand(request.action, request.invocation), {frameId: 0});
            } catch {
                return {success: false};
            }
        },
    };
}

function changedHandler(dependencies: QQMailFrameHandlerDependencies): BackgroundMessageHandler<QQMailFrameBackgroundContext, QQMailFrameChangedMessage> {
    return {
        type: QQ_MAIL_FRAME_CHANGED_MESSAGE_TYPE,
        async handle(message, context) {
            const sender = isLegacyTopSender(context);
            if (!sender || !parseQQMailFrameChanged(message)) return {success: false};
            const tabId = sender.tabId;
            try {
                await dependencies.sendTabMessage(tabId, {type: 'qqMailFrameRefresh'});
            } catch {
                // 邮件 frame 可能尚未加载；刷新广播是尽力而为，不能让 top frame 失败。
            }
            return {success: true};
        },
    };
}

export function createQqMailFrameBackgroundHandlers(
    dependencies: QQMailFrameHandlerDependencies,
): [
    BackgroundMessageHandler<QQMailFrameBackgroundContext, QQMailFrameRequestMessage>,
    BackgroundMessageHandler<QQMailFrameBackgroundContext, QQMailFrameChangedMessage>,
] {
    return [requestHandler(dependencies), changedHandler(dependencies)];
}

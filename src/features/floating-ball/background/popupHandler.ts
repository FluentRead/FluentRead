/**
 * @file src/features/floating-ball/background/popupHandler.ts
 * 文件职责：为悬浮球的页内默认 popup 签发和兑换一次性授权，避免任意网页直接嵌入扩展配置界面。
 * 主要内容：仅接受本扩展顶层内容脚本申请，将短期凭据绑定浏览器发送方标签页；仅允许同一网页的默认 popup 子框架兑换一次。
 * 模块边界：不读取 payload 中的网页标识、不保存用户配置、不调用浏览器导航；扩展身份、默认页面、随机数和时钟由 app 注入。
 */
import {isBrowserTabId as isTabId} from '@/src/platform/browser/ids';

export interface PopupContext {
    sender?: {id?: string; url?: string; frameId?: number; tab?: {id?: number; windowId?: number}};
}

export interface FloatingPopupAuthorization {
    runtimeId: string;
    popupUrl: string;
    randomToken(): string;
    now(): number;
}

export const FLOATING_POPUP_AUTHORIZATION_TTL_MS = 30_000;

function isContentUrl(value: string | undefined): boolean {
    try {
        return ['http:', 'https:', 'file:'].includes(new URL(value ?? '').protocol);
    } catch {
        return false;
    }
}

/** 凭据仅存在于后台内存中；后台重启、过期、重复申请和成功兑换都会使旧凭据失效。 */
export function createFloatingPopupHandlers(authorization: FloatingPopupAuthorization) {
    const tickets = new Map<string, {tabId: number; expiresAt: number}>();
    const prune = () => {
        const now = authorization.now();
        for (const [token, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(token);
    };
    return [{
        type: 'requestFloatingPopup' as const,
        async handle(_message: {type: 'requestFloatingPopup'}, context: PopupContext): Promise<{success: true; token: string}> {
            prune();
            const sender = context.sender;
            const tabId = sender?.tab?.id;
            if (sender?.id !== authorization.runtimeId || sender.frameId !== 0
                || !isTabId(tabId) || !isContentUrl(sender.url)) {
                throw new TypeError('无法授权悬浮球所在网页');
            }
            for (const [token, ticket] of tickets) if (ticket.tabId === tabId) tickets.delete(token);
            const token = authorization.randomToken();
            tickets.set(token, {tabId, expiresAt: authorization.now() + FLOATING_POPUP_AUTHORIZATION_TTL_MS});
            return {success: true, token};
        },
    }, {
        type: 'authorizeFloatingPopup' as const,
        async handle(message: {type: 'authorizeFloatingPopup'; token?: unknown}, context: PopupContext): Promise<{success: true; sourceTabId: number}> {
            prune();
            const sender = context.sender;
            const token = message.token;
            const ticket = typeof token === 'string' ? tickets.get(token) : undefined;
            if (!ticket || sender?.id !== authorization.runtimeId || sender.url !== authorization.popupUrl
                || !isTabId(sender.frameId) || sender.frameId === 0 || sender.tab?.id !== ticket.tabId) {
                throw new TypeError('页内快捷面板授权无效或已过期');
            }
            // 同步删除后才返回，不在验证和消费之间留下异步重放窗口。
            tickets.delete(token as string);
            return {success: true, sourceTabId: ticket.tabId};
        },
    }] as const;
}

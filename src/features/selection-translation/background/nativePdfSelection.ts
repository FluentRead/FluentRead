/**
 * @file src/features/selection-translation/background/nativePdfSelection.ts
 * 文件职责：把原生 PDF 右键选区暂存为仅能由本次结果窗口兑换的一次性票据。
 * 主要内容：校验显式菜单输入，以六十秒和十六条限制管理票据及未完成窗口创建；等待目标身份落地后核对扩展页面与发送方，拒绝重放并清除失效正文。
 * 模块边界：不读取原生 PDF DOM、不下载文件、不调用翻译或磁盘存储；窗口、随机数与时钟均由应用层注入。
 */
import {normalizeOnlinePdfUrl} from '@/src/features/document-translation/public';

export interface NativePdfSelectionInput {text: string; sourceUrl: string; title: string;}
export interface NativePdfSelectionSender {id?: string; url?: string; frameId?: number; tab?: {id?: number; windowId?: number};}
interface ResultWindow {id?: number; tabs?: Array<{id?: number; windowId?: number}>;}
export interface NativePdfSelectionDependencies {
    extensionId: string;
    resultUrl: string;
    now(): number;
    wallNow(): number;
    randomToken(): string;
    openWindow(options: {url: string; type: 'popup'; width: number; height: number}): Promise<ResultWindow>;
}
export const NATIVE_PDF_SELECTION_TTL_MS = 60_000;
export const NATIVE_PDF_SELECTION_MAX_PENDING = 16;
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** 原文只去掉首尾空白；不猜测排版连字符或改写段落，以菜单原文为准。 */
export function createNativePdfSelectionBridge(dependencies: NativePdfSelectionDependencies) {
    interface Ticket {input: NativePdfSelectionInput | null; expiresAt: number; wallExpiresAt: number; ready: Promise<boolean>; cancel(): void; timer?: ReturnType<typeof setTimeout>; target?: {windowId: number; tabId?: number};}
    const tickets = new Map<string, Ticket>();
    let unfinishedCreations = 0;
    const page = dependencies.resultUrl.split(/[?#]/u)[0];
    const discard = (token: string, ticket: Ticket) => {
        tickets.delete(token); clearTimeout(ticket.timer); ticket.input = null; ticket.cancel();
    };
    const expired = (ticket: Ticket) => ticket.expiresAt <= dependencies.now() || ticket.wallExpiresAt <= dependencies.wallNow();
    const prune = () => {for (const [token, ticket] of tickets) if (expired(ticket)) discard(token, ticket);};
    const scheduleExpiry = (token: string, ticket: Ticket): void => {
        ticket.timer = setTimeout(() => {
            if (tickets.get(token) !== ticket) return;
            // 到期后页面可能已经被用户导航，清除正文但不主动关闭已创建窗口。
            if (expired(ticket)) discard(token, ticket);
            else scheduleExpiry(token, ticket);
        }, Math.min(2_147_483_647, Math.max(0, Math.min(ticket.expiresAt - dependencies.now(), ticket.wallExpiresAt - dependencies.wallNow()))));
    };
    return {
        async open(input: NativePdfSelectionInput): Promise<boolean> {
            const text = typeof input.text === 'string' ? input.text.trim() : '';
            const sourceUrl = typeof input.sourceUrl === 'string' ? normalizeOnlinePdfUrl(input.sourceUrl) : null;
            if (!text || text.length > 4096 || !sourceUrl || typeof input.title !== 'string') return false;
            prune();
            if (unfinishedCreations >= NATIVE_PDF_SELECTION_MAX_PENDING) return false;
            const token = dependencies.randomToken();
            if (!/^[a-f0-9]{32}$/u.test(token) || tickets.has(token)) return false;
            if (tickets.size >= NATIVE_PDF_SELECTION_MAX_PENDING) {const [oldToken, oldTicket] = tickets.entries().next().value!; discard(oldToken, oldTicket);}
            let cancel!: () => void;
            const cancelled = new Promise<boolean>(resolve => {cancel = () => resolve(false);});
            const ticket: Ticket = {input: {text, sourceUrl, title: input.title.trim().slice(0, 512)}, expiresAt: dependencies.now() + NATIVE_PDF_SELECTION_TTL_MS,
                wallExpiresAt: dependencies.wallNow() + NATIVE_PDF_SELECTION_TTL_MS, ready: Promise.resolve(false), cancel};
            tickets.set(token, ticket);
            scheduleExpiry(token, ticket);
            const creation = Promise.resolve().then(async () => {
                if (tickets.get(token) !== ticket || expired(ticket) || unfinishedCreations >= NATIVE_PDF_SELECTION_MAX_PENDING) return null;
                unfinishedCreations += 1;
                try {return await dependencies.openWindow({url: `${page}#${new URLSearchParams({token})}`, type: 'popup', width: 520, height: 680});}
                finally {unfinishedCreations -= 1;}
            }).then(window => {
                if (!window || !validId(window.id)) return false;
                const firstTab = window.tabs?.[0];
                ticket.target = {windowId: window.id, ...(validId(firstTab?.id) ? {tabId: firstTab.id} : {})};
                if (tickets.get(token) !== ticket || expired(ticket)) return false;
                return true;
            }).catch(() => false);
            ticket.ready = Promise.race([creation, cancelled]);
            const opened = await ticket.ready;
            if (!opened && tickets.get(token) === ticket) discard(token, ticket);
            return opened;
        },
        async claim(token: unknown, sender: NativePdfSelectionSender | undefined): Promise<NativePdfSelectionInput | null> {
            prune();
            const ticket = typeof token === 'string' ? tickets.get(token) : undefined;
            if (!ticket || sender?.id !== dependencies.extensionId || typeof sender.url !== 'string'
                || sender.url.split(/[?#]/u)[0] !== page || sender.frameId !== 0) return null;
            if (!await ticket.ready || tickets.get(token as string) !== ticket) return null;
            if (expired(ticket)) {discard(token as string, ticket); return null;}
            const target = ticket.target!;
            if (sender.tab?.windowId !== target.windowId || (target.tabId !== undefined && sender.tab.id !== target.tabId)) return null;
            const input = ticket.input!;
            tickets.delete(token as string); clearTimeout(ticket.timer); ticket.input = null; ticket.cancel();
            return {...input};
        },
    };
}

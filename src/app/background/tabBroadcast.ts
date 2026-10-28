/**
 * @file src/app/background/tabBroadcast.ts
 * 文件职责：为后台无值变更通知选择实际内容脚本接收者，避免 Safari 的全标签查询触发额外站点授权。
 * 主要内容：由可信配置读取发送方登记标签，Safari 仅在 storage.session 保存整数标签 ID，以串行队列合并后台唤醒、并发登记、关闭及存储重试；五种失效意图按可取消安装所有者在内存合并，其他浏览器保留原标签查询。
 * 模块边界：不存储 URL、正文或凭据，不按顶层网址或 TTL 丢弃接收者，不建立端口或定时器；真实浏览器事件和会话存储由 composition root 注入。
 */
import {CONFIG_STORAGE_CHANGED_MESSAGE} from '@/src/platform/storage/configStorage';
import {TRANSLATION_CACHE_CLEARED_MESSAGE} from './handlers/translationCache';
import {VOCABULARY_BOOK_CHANGED_MESSAGE, type VocabularyBookChangedMessage} from '@/src/features/vocabulary/protocol';
import {PERSONAL_CORRECTIONS_CHANGED} from '@/src/services/personal-corrections/protocol';

export const TAB_BROADCAST_SESSION_KEY = 'fluentReadBroadcastRecipientTabIds' as const;
export interface TabBroadcastSender {id?: string; url?: string; tab?: {id?: number}}
export interface TabBroadcastRuntime {
    queryTabs(): Promise<Array<{id?: number}>>;
    sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
    broadcastTabMessage(message: unknown, signal?: AbortSignal): Promise<void>;
    registerContentReceiver(sender: TabBroadcastSender | undefined): Promise<void>;
    removeTab(tabId: number): Promise<void>;
}
export interface TabBroadcastDependencies {
    browserName: string;
    extensionId: string;
    isExtensionUrl(url: string): boolean;
    queryTabs(): Promise<Array<{id?: number}>>;
    sendTabMessage(tabId: number, message: unknown): Promise<unknown>;
    readSessionRecipients(): Promise<unknown>;
    writeSessionRecipients(tabIds: number[]): Promise<void>;
    warn(message: string): void;
}
type Invalidation = {type: string; key?: 'local:config'; reason?: VocabularyBookChangedMessage['reason']; entryId?: string};
interface InvalidationOwner {message: Invalidation; sequence: number; signal?: AbortSignal; waiters: Array<() => void>}
const VOCABULARY_REASONS = new Set<VocabularyBookChangedMessage['reason']>([
    'upsert', 'note', 'review', 'manual-mastered', 'relearn', 'remove', 'undo', 'clear', 'import',
]);
function invalidationIntent(message: unknown): Invalidation {
    if (message && typeof message === 'object' && !Array.isArray(message)) {
        const {type, key, reason, entryId} = message as {type?: unknown; key?: unknown; reason?: unknown; entryId?: unknown};
        if (type === CONFIG_STORAGE_CHANGED_MESSAGE && key === 'local:config') return {type, key};
        if (type === 'fluentReadReadingModelInputsChanged' || type === TRANSLATION_CACHE_CLEARED_MESSAGE
            || type === PERSONAL_CORRECTIONS_CHANGED) return {type};
        if (type === VOCABULARY_BOOK_CHANGED_MESSAGE && VOCABULARY_REASONS.has(reason as VocabularyBookChangedMessage['reason'])) {
            return {type, reason: reason as VocabularyBookChangedMessage['reason'], ...(typeof entryId === 'string' ? {entryId} : {})};
        }
    }
    throw new TypeError('不支持的网页失效通知');
}
function isTabId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 会话存储跨非持久后台唤醒保留，但随浏览器会话清空，避免跨会话复用标签 ID。 */
export function createTabBroadcastRuntime(dependencies: TabBroadcastDependencies): TabBroadcastRuntime {
    const send = async (tabIds: number[], messages: unknown[], signal?: AbortSignal): Promise<void> => {
        await Promise.allSettled(messages.flatMap(message => tabIds.map(id => (
            Promise.resolve().then(() => signal?.aborted ? undefined : dependencies.sendTabMessage(id, message))
        ))));
    };
    if (dependencies.browserName !== 'safari') {
        return {
            queryTabs: dependencies.queryTabs,
            sendTabMessage: dependencies.sendTabMessage,
            async broadcastTabMessage(message, signal) {
                if (signal?.aborted) return;
                const tabs = await dependencies.queryTabs();
                await send(tabs.map(tab => tab.id).filter(isTabId), [message], signal);
            },
            registerContentReceiver: async () => undefined,
            removeTab: async () => undefined,
        };
    }

    let loaded = false;
    let storedIds = new Set<number>();
    const pending = new Map<number, {present: boolean}>();
    const closedIds = new Set<number>();
    // 严格限制为四处广播的五种无值通知；任何消息字段都不写入会话存储。
    const pendingIntents = new Map<string, Map<AbortSignal | undefined, InvalidationOwner>>();
    let intentSequence = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const currentIds = (): Set<number> => {
        const ids = new Set(storedIds);
        pending.forEach(({present}, id) => {if (present) ids.add(id); else ids.delete(id);});
        return ids;
    };
    const synchronize = async (): Promise<void> => {
        if (!loaded) {
            // 读取失败时保留未加载态，不能以空集合覆盖未知旧接收者。
            const value = await dependencies.readSessionRecipients();
            if (value !== undefined && !Array.isArray(value)) throw new TypeError('网页通知接收者会话记录无效');
            storedIds = new Set((value ?? []).filter(isTabId));
            loaded = true;
        }
        if (!pending.size) return;
        const writing = new Map(pending);
        const nextIds = currentIds();
        await dependencies.writeSessionRecipients([...nextIds].sort((left, right) => left - right));
        storedIds = nextIds;
        // 写入期间到达的同 ID 新操作仍保留，不能被旧完成回调删除。
        writing.forEach((change, id) => {if (pending.get(id) === change) pending.delete(id);});
    };
    const enqueue = () => {
        const result = queue.then(async () => {
            try {await synchronize();}
            catch {dependencies.warn('[FluentRead] Safari 网页通知接收者暂未同步，将在下次读取或广播时重试');}
            const notifications: InvalidationOwner[][] = [];
            pendingIntents.forEach((owners, key) => {
                const notification: InvalidationOwner[] = [];
                owners.forEach((owner, signal) => {
                    const waiters = owner.waiters.splice(0);
                    if (signal?.aborted) {
                        waiters.forEach(finish => finish());
                        owners.delete(signal);
                    } else notification.push({...owner, waiters});
                });
                if (notification.length) notifications.push(notification);
                if (loaded || !owners.size) pendingIntents.delete(key);
            });
            return {tabIds: [...currentIds()].sort((left, right) => left - right), notifications};
        });
        queue = result.then(() => undefined, () => undefined);
        return result;
    };
    const deliver = async (plan: Awaited<ReturnType<typeof enqueue>>): Promise<void> => {
        await Promise.allSettled(plan.notifications.flatMap(owners => plan.tabIds.map(id => (
            Promise.resolve().then(() => {
                const owner = owners.filter(candidate => !candidate.signal?.aborted)
                    .sort((left, right) => right.sequence - left.sequence)[0];
                return owner ? dependencies.sendTabMessage(id, owner.message) : undefined;
            })
        ))));
        // 被同一轮合并的调用者都等待实际投递尝试，不能由空的后续队列提前确认成功。
        plan.notifications.forEach(owners => owners.forEach(owner => owner.waiters.forEach(finish => finish())));
    };
    const change = async (id: number, present: boolean): Promise<void> => {
        const previous = pending.get(id);
        if (previous ? previous.present !== present : !loaded || storedIds.has(id) !== present) pending.set(id, {present});
        const plan = await enqueue();
        // 不在 registry 队列内等待内容响应，避免内容回读配置时互相等待。
        void deliver(plan);
    };

    return {
        async queryTabs() {
            const plan = await enqueue();
            void deliver(plan);
            return plan.tabIds.map(id => ({id}));
        },
        // 暂时挂起或接收失败的页面仍保留登记，下一次广播继续尝试。
        sendTabMessage: dependencies.sendTabMessage,
        async broadcastTabMessage(message, signal) {
            if (signal?.aborted) return;
            const intent = invalidationIntent(message);
            const key = `${intent.type}:${intent.key ?? ''}`;
            const owners = pendingIntents.get(key) ?? new Map<AbortSignal | undefined, InvalidationOwner>();
            const owner: InvalidationOwner = owners.get(signal) ?? {message: intent, sequence: 0, signal, waiters: []};
            owner.message = intent;
            owner.sequence = ++intentSequence;
            const completion = new Promise<void>(resolve => {owner.waiters.push(resolve);});
            owners.set(signal, owner);
            pendingIntents.set(key, owners);
            const plan = await enqueue();
            void deliver(plan);
            await completion;
        },
        async registerContentReceiver(sender) {
            const id = sender?.tab?.id;
            if (sender?.id !== dependencies.extensionId || !isTabId(id)
                || dependencies.isExtensionUrl(sender.url ?? '') || closedIds.has(id)) return;
            // 不检查 URL scheme、frame 或顶层权限，覆盖临时授权页、iframe 与 about:blank。
            await change(id, true);
        },
        async removeTab(id) {
            if (!isTabId(id)) return;
            // 本后台尚在等待 configReady 的旧 handler 不能复活已关闭标签；后台销毁即释放。
            closedIds.add(id);
            await change(id, false);
        },
    };
}

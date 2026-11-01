/**
 * @file src/platform/offscreen/safariDocument.ts
 * 文件职责：在 Safari MV3 后台（service worker，无 DOM）中，用扩展自己的后台标签页承载共用 offscreen.html 运行时。
 * 主要内容：标签页的创建、复用、存活检查和空闲回收；标签页 ID 同时保存在 worker 内存和 storage.local，worker 被系统回收后不会重复开页。
 * 模块边界：只拥有 Safari 的文档容器，不实现 OCR、翻译、音频、模型或消息协议；不向宿主网页插入节点，也不依赖 Chrome 独有 API。
 */
import type {OffscreenDocumentApi} from './client';

/** Safari 后台可用的最小 tabs 端口；只需要创建、查询与关闭扩展自己的页面。 */
export interface SafariTabsPort {
    create(properties: {url: string; active: boolean}): Promise<{id?: number} | undefined>;
    get(tabId: number): Promise<{id?: number} | undefined>;
    remove(tabId: number): Promise<void>;
}

/** 只读写一个键，避免与配置存储的命名空间混用。 */
export interface SafariStoragePort {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
}

export interface SafariDocumentOptions {
    readonly tabs: SafariTabsPort;
    readonly storage: SafariStoragePort;
    /** 空闲多久后关闭后台页；Safari 的标签页对用户可见，长时间驻留不礼貌。 */
    readonly idleTimeoutMs?: number;
    readonly setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
    readonly clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
    readonly onIdleCloseError?: (error: unknown) => void;
}

const TAB_ID_KEY = 'fluentreadSafariDocumentTabId';
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 该容器与 Chrome offscreen、Firefox 后台 iframe 共用同一份 OffscreenClient 契约：
 * prepare 前用 getContexts 判断存活，消息丢失接收端时由 client 关闭并重建。
 */
export function createSafariBackgroundDocument(
    getUrl: (path: string) => string,
    options: SafariDocumentOptions,
): OffscreenDocumentApi & {getContexts(): Promise<unknown[]>} {
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const schedule = options.setTimeout ?? setTimeout;
    const cancel = options.clearTimeout ?? clearTimeout;
    let tabId: number | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const clearIdleTimer = (): void => {
        if (idleTimer === undefined) return;
        cancel(idleTimer);
        idleTimer = undefined;
    };

    const closeTab = async (id: number): Promise<void> => {
        try {
            await options.tabs.remove(id);
        } catch {
            // 用户可能已经手动关闭；这里只需保证本地状态不再指向它。
        }
    };

    const forget = async (): Promise<void> => {
        clearIdleTimer();
        tabId = undefined;
        try {
            await options.storage.remove(TAB_ID_KEY);
        } catch {
            // 存储不可用时仍以 worker 内存为准，下一次 getContexts 会重新探测。
        }
    };

    const scheduleIdleClose = (id: number): void => {
        clearIdleTimer();
        idleTimer = schedule(() => {
            idleTimer = undefined;
            if (tabId !== id) return;
            tabId = undefined;
            void options.storage.remove(TAB_ID_KEY).catch(() => undefined);
            void closeTab(id).catch(error => options.onIdleCloseError?.(error));
        }, idleTimeoutMs);
        // Safari 的 service worker 可能先于定时器被回收；未触发的关闭不会影响正确性。
        (idleTimer as unknown as {unref?: () => void}).unref?.();
    };

    const readTabId = async (): Promise<number | undefined> => {
        if (tabId !== undefined) return tabId;
        try {
            const stored = await options.storage.get(TAB_ID_KEY);
            const value = stored?.[TAB_ID_KEY];
            if (typeof value === 'number' && Number.isInteger(value)) tabId = value;
        } catch {
            // 读取失败按“没有后台页”处理，随后重建一次即可。
        }
        return tabId;
    };

    return {
        async getContexts() {
            const id = await readTabId();
            if (id === undefined) return [];
            try {
                const tab = await options.tabs.get(id);
                if (!tab) {
                    await forget();
                    return [];
                }
                scheduleIdleClose(id);
                return [{url: getUrl('offscreen.html')}];
            } catch {
                await forget();
                return [];
            }
        },
        async createDocument({url}) {
            const existing = await readTabId();
            if (existing !== undefined) {
                try {
                    if (await options.tabs.get(existing)) {
                        scheduleIdleClose(existing);
                        return;
                    }
                } catch {
                    // 已失效，继续创建。
                }
                await forget();
            }
            const tab = await options.tabs.create({url: getUrl(url), active: false});
            const created = tab?.id;
            if (typeof created !== 'number') throw new Error('Safari 未能创建后台运行页');
            tabId = created;
            scheduleIdleClose(created);
            try {
                await options.storage.set({[TAB_ID_KEY]: created});
            } catch {
                // 无法持久化时最多在 worker 重启后多开一个页面，不影响功能。
            }
        },
        async closeDocument() {
            const id = await readTabId();
            await forget();
            if (id !== undefined) await closeTab(id);
        },
    };
}

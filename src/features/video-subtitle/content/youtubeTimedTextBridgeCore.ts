/**
 * @file src/features/video-subtitle/content/youtubeTimedTextBridgeCore.ts
 * 文件职责：实现可注入、可测试的 YouTube timedtext 网络桥核心，安全包裹页面 fetch 与 XMLHttpRequest 并发布成功字幕响应，同时支持完整恢复。
 * 主要内容：定义环境端口、状态键和生命周期事件，识别目标 URL、构造 payload，保存原始方法，处理 XHR 复用/同步失败/迟到响应，克隆正文统一限制为 8MB 和 15 秒读取预算，并为显式开启的站点提供有界二进制文本适配与资源回放；卸载后不再克隆迟到响应。
 * 模块边界：核心不直接引用全局 window、不解析字幕内容也不操作扩展 UI；页面适配器注入真实环境，video runtime 消费消息，所有猴补只属于 MAIN-world bridge 所有权。
 */
export const YOUTUBE_TIMED_TEXT_MESSAGE = 'fluent-read-youtube-timedtext';
export const YOUTUBE_BRIDGE_DISPOSE_EVENT = 'fluentread-youtube-bridge-dispose';
export const YOUTUBE_BRIDGE_ENABLE_EVENT = 'fluentread-youtube-bridge-enable';
export const YOUTUBE_BRIDGE_REPLAY_EVENT = 'fluentread-youtube-bridge-replay';
export const YOUTUBE_BRIDGE_STATE_KEY = '__fluentReadYoutubeTimedTextBridgeState__';
export const YOUTUBE_BRIDGE_LIFECYCLE_STATE_KEY = '__fluentReadYoutubeTimedTextBridgeLifecycleState__';

export interface TimedTextPayload {
    readonly source: 'fluent-read';
    readonly type: string;
    readonly url: string;
    readonly responseText: string;
    readonly pageHref?: string;
}

export interface YoutubeBridgeMethodSlot<T extends (...args: never[]) => unknown> {
    get(): T;
    set(value: T): void;
}

export interface YoutubeFetchResponsePort {
    clone(): {text(): Promise<string>; body?: ReadableStream<Uint8Array> | null; headers?: {get(name: string): string | null}};
}

export type YoutubeFetchPort = (
    this: unknown,
    input: unknown,
    init?: unknown,
) => Promise<YoutubeFetchResponsePort>;

export interface YoutubeXhrPort {
    readonly responseText: unknown;
    readonly response?: unknown;
    readonly responseType?: string;
    addEventListener(type: string, listener: () => void, options?: {once?: boolean}): void;
}

export type YoutubeXhrOpenPort = (
    this: YoutubeXhrPort,
    method: string,
    url: unknown,
    ...rest: unknown[]
) => unknown;
export type YoutubeXhrSendPort = (this: YoutubeXhrPort, body?: unknown) => unknown;

export interface YoutubeBridgeEventTarget {
    addEventListener(type: string, listener: (event?: {persisted?: boolean}) => void): void;
    removeEventListener(type: string, listener: (event?: {persisted?: boolean}) => void): void;
}

export interface YoutubeTimedTextBridgeEnvironment {
    /** X 与 YouTube 共享可卸载的网络桥，站点策略只决定捕获范围和消息数据。 */
    readonly resourcePolicy?: {
        matches(url: string, href: string): boolean;
        payload(url: string, text: unknown, href: string): TimedTextPayload | null;
        /** 判定两个页面地址是否仍属于同一视频/文档上下文，避免播放期参数漂移丢弃响应。 */
        isSamePage?: (left: string, right: string) => boolean;
        /** 仅站点适配器可选择在消费方晚于网络响应时回放最近资源。 */
        replayLatest?: boolean;
        /** X 的 HLS loader 常用 arraybuffer/blob，按站点显式允许后才转成有界文本。 */
        binaryText?: boolean;
        /** 在 clone 读取过程中限流，避免先复制整个时间线再按文本长度拒绝。 */
        maxResponseBytes?: number;
    };
    readonly stateHost: Record<string, unknown>;
    readonly fetch: YoutubeBridgeMethodSlot<YoutubeFetchPort>;
    readonly xhrOpen: YoutubeBridgeMethodSlot<YoutubeXhrOpenPort>;
    readonly xhrSend: YoutubeBridgeMethodSlot<YoutubeXhrSendPort>;
    readonly pageEvents: YoutubeBridgeEventTarget;
    readonly documentEvents: YoutubeBridgeEventTarget;
    readonly getHref: () => string;
    readonly getOrigin: () => string;
    readonly postMessage: (payload: TimedTextPayload, targetOrigin: string) => void;
}

interface YoutubeBridgeState {
    readonly owner: symbol;
    readonly dispose: () => void;
}

interface YoutubeBridgeLifecycleState {
    readonly owner: symbol;
    readonly dispose: () => void;
}

const MAX_CLONED_RESPONSE_BYTES = 8_000_000;
const CLONED_RESPONSE_TIMEOUT_MS = 15_000;
const MAX_REPLAY_RESOURCE_COUNT = 16;
const MAX_REPLAY_RESPONSE_CHARS = 2_000_000;

export function getYoutubeRequestUrl(input: unknown): string {
    if (typeof input === 'string') return input;
    if (!input || typeof input !== 'object') return '';
    const record = input as {href?: unknown; url?: unknown};
    if (typeof record.href === 'string') return record.href;
    return typeof record.url === 'string' ? record.url : '';
}

function getYoutubePageVideoId(url: URL): string {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    const host = url.hostname.toLowerCase();
    const isNoCookie = host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
    const isYoutube = host === 'youtube.com' || host.endsWith('.youtube.com');
    if (isNoCookie) return url.pathname.match(/^\/embed\/([\w-]{11})\/?$/u)?.[1] || '';
    if (!isYoutube) return '';
    if (url.pathname === '/watch') return url.searchParams.get('v') || '';
    if (url.pathname.startsWith('/shorts/')) return url.pathname.match(/^\/shorts\/([^/]+)\/?$/u)?.[1] || '';
    if (url.pathname.startsWith('/embed/')) return url.pathname.match(/^\/embed\/([\w-]{11})\/?$/u)?.[1] || '';
    if (url.pathname.startsWith('/live/')) return url.pathname.match(/^\/live\/([\w-]{11})\/?$/u)?.[1] || '';
    return '';
}

function defaultIsSamePage(left: string, right: string): boolean {
    if (left === right) return true;
    try {
        const leftUrl = new URL(left);
        const rightUrl = new URL(right);
        if (leftUrl.origin !== rightUrl.origin) return false;
        const leftId = getYoutubePageVideoId(leftUrl);
        return Boolean(leftId && leftId === getYoutubePageVideoId(rightUrl));
    } catch {
        return false;
    }
}

export function isYoutubeTimedTextUrl(value: string, baseHref: string): boolean {
    try {
        const url = new URL(value, baseHref);
        const host = url.hostname.toLowerCase();
        return (host === 'youtube.com' || host.endsWith('.youtube.com')
            || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com'))
            && url.pathname.includes('/api/timedtext');
    } catch {
        return false;
    }
}

export function createYoutubeTimedTextPayload(
    url: string,
    responseText: unknown,
    baseHref: string,
): TimedTextPayload | null {
    if (typeof responseText !== 'string' || !responseText || !isYoutubeTimedTextUrl(url, baseHref)) return null;
    return {
        source: 'fluent-read',
        type: YOUTUBE_TIMED_TEXT_MESSAGE,
        url,
        responseText,
    };
}

function installMethod<T extends (...args: never[]) => unknown>(
    slot: YoutubeBridgeMethodSlot<T>,
    wrapper: T,
): boolean {
    try {
        slot.set(wrapper);
        return slot.get() === wrapper;
    } catch {
        return false;
    }
}

function restoreMethod<T extends (...args: never[]) => unknown>(
    slot: YoutubeBridgeMethodSlot<T>,
    wrapper: T,
    original: T,
): void {
    try {
        if (slot.get() === wrapper) slot.set(original);
    } catch {
        // 页面在运行期间锁定宿主 API 时，不能让卸载异常逃逸到站点代码。
    }
}

/** 安装可卸载、不会嵌套包装的 MAIN world timedtext bridge。 */
export function installYoutubeTimedTextBridgeCore(
    environment: YoutubeTimedTextBridgeEnvironment,
): () => void {
    const previous = environment.stateHost[YOUTUBE_BRIDGE_STATE_KEY] as YoutubeBridgeState | undefined;
    previous?.dispose?.();

    const owner = Symbol('fluentread-youtube-timedtext-bridge');
    const originalFetch = environment.fetch.get();
    const originalOpen = environment.xhrOpen.get();
    const originalSend = environment.xhrSend.get();
    const requestUrls = new WeakMap<YoutubeXhrPort, string>();
    const requestGenerations = new WeakMap<YoutubeXhrPort, number>();
    let active = true;
    const matches = environment.resourcePolicy?.matches ?? isYoutubeTimedTextUrl;
    const payloadFor = environment.resourcePolicy?.payload ?? createYoutubeTimedTextPayload;
    const isSamePage = environment.resourcePolicy?.isSamePage ?? defaultIsSamePage;
    const replayCache = new Map<string, {payload: TimedTextPayload; pageHref: string}>();
    let replayResponseChars = 0;
    const replayEnabled = environment.resourcePolicy?.replayLatest === true;
    const responseScope = new AbortController();
    const readResponseText = async (response: ReturnType<YoutubeFetchResponsePort['clone']>): Promise<string | null> => {
        const limit = environment.resourcePolicy?.maxResponseBytes ?? MAX_CLONED_RESPONSE_BYTES;
        if (Number(response.headers?.get('content-length')) > limit) {
            void response.body?.cancel().catch(() => undefined);
            return null;
        }
        if (!response.body) {
            // 测试端口或不提供流的宿主保留 text 兼容；在发布前仍限制字符与 UTF-8 字节。
            const text = await response.text();
            return text.length <= limit && new TextEncoder().encode(text).length <= limit ? text : null;
        }
        const reader = response.body.getReader();
        let cancelled = false;
        const cancel = () => {
            if (cancelled) return;
            cancelled = true;
            void reader.cancel().catch(() => undefined);
        };
        responseScope.signal.addEventListener('abort', cancel, {once: true});
        const timer = setTimeout(cancel, CLONED_RESPONSE_TIMEOUT_MS);
        const decoder = new TextDecoder();
        const parts: string[] = [];
        let bytes = 0;
        try {
            while (!responseScope.signal.aborted && !cancelled) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > limit) return null;
                parts.push(decoder.decode(part.value, {stream: true}));
            }
            if (responseScope.signal.aborted || cancelled) return null;
            parts.push(decoder.decode());
            return parts.join('');
        } finally {
            clearTimeout(timer);
            responseScope.signal.removeEventListener('abort', cancel);
            cancel();
            reader.releaseLock();
        }
    };
    const clearReplayCache = () => {
        replayCache.clear();
        replayResponseChars = 0;
    };
    const rememberReplayPayload = (payload: TimedTextPayload, href: string) => {
        if (!replayEnabled) return;
        const pageHref = payload.pageHref || href;
        const previous = replayCache.get(payload.url);
        if (previous) replayResponseChars -= previous.payload.responseText.length;
        replayCache.delete(payload.url);
        if (payload.responseText.length > MAX_REPLAY_RESPONSE_CHARS) return;
        replayCache.set(payload.url, {
            payload: payload.pageHref ? payload : {...payload, pageHref},
            pageHref,
        });
        replayResponseChars += payload.responseText.length;
        while (replayCache.size > MAX_REPLAY_RESOURCE_COUNT || replayResponseChars > MAX_REPLAY_RESPONSE_CHARS) {
            // 进入淘汰循环时缓存一定非空；Map 的不变量由上面的 set 和循环条件保证。
            const oldestUrl = replayCache.keys().next().value as string;
            const oldest = replayCache.get(oldestUrl);
            replayCache.delete(oldestUrl);
            replayResponseChars -= oldest!.payload.responseText.length;
        }
    };
    const replayLatest = () => {
        if (!replayEnabled) return;
        const currentHref = environment.getHref();
        for (const {payload, pageHref} of replayCache.values()) {
            if (!isSamePage(pageHref, currentHref)) continue;
            try {
                environment.postMessage(payload, environment.getOrigin());
            } catch {
                // 回放是旁路能力，消费方或页面导航失败不能影响宿主 API。
            }
        }
    };
    const publish = (url: string, responseText: unknown, href = environment.getHref()) => {
        if (!active) return;
        if (!isSamePage(href, environment.getHref())) return;
        const payload = payloadFor(url, responseText, href);
        if (!payload) return;
        rememberReplayPayload(payload, href);
        try {
            environment.postMessage(payload, environment.getOrigin());
        } catch {
            // 页面导航或 CSP 边界变化时丢弃诊断消息，不影响原始网络请求。
        }
    };

    const fetchWrapper: YoutubeFetchPort = async function fetch(input, init) {
        const requestUrl = getYoutubeRequestUrl(input);
        const requestHref = environment.getHref();
        const response = await Reflect.apply(originalFetch, this, [input, init]);
        if (active && isSamePage(requestHref, environment.getHref()) && matches(requestUrl, requestHref)) {
            try {
                void readResponseText(response.clone())
                    .then((responseText) => publish(requestUrl, responseText, requestHref))
                    .catch(() => undefined);
            } catch {
                // 不可 clone 的响应只跳过旁路采集，原 response 仍原样返回。
            }
        }
        return response;
    };
    const openWrapper: YoutubeXhrOpenPort = function open(method, url, ...rest) {
        // 步骤 1：XHR 对象允许复用；每次 open 必须先清掉旧 timedtext URL。
        requestUrls.delete(this);
        requestGenerations.set(this, (requestGenerations.get(this) ?? 0) + 1);
        const requestUrl = getYoutubeRequestUrl(url);
        if (matches(requestUrl, environment.getHref())) requestUrls.set(this, requestUrl);
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    };
    const sendWrapper: YoutubeXhrSendPort = function send(body) {
        const requestUrl = requestUrls.get(this);
        const requestHref = environment.getHref();
        const requestGeneration = requestGenerations.get(this) ?? 0;
        requestUrls.delete(this);
        if (requestUrl) {
            this.addEventListener('load', () => {
                if (requestGenerations.get(this) !== requestGeneration) return;
                try {
                    publish(requestUrl, this.responseText, requestHref);
                } catch {
                    // HLS loader 的 arraybuffer/blob responseText getter 会抛异常；
                    // 只让显式启用此能力的站点按小型文本资源解码，不能读取媒体段。
                    if (!environment.resourcePolicy?.binaryText) return;
                    try {
                        const response = this.response;
                        const emit = (text: unknown) => {
                            if (requestGenerations.get(this) === requestGeneration) publish(requestUrl, text, requestHref);
                        };
                        if (response instanceof ArrayBuffer && response.byteLength <= MAX_REPLAY_RESPONSE_CHARS) {
                            emit(new TextDecoder().decode(response));
                        } else if (typeof Blob !== 'undefined' && response instanceof Blob && response.size <= MAX_REPLAY_RESPONSE_CHARS) {
                            void response.text().then(emit).catch(() => undefined);
                        }
                    } catch {
                        // 不兼容、不可读或异常响应只跳过旁路，不影响页面播放器。
                    }
                }
            }, {once: true});
        }
        try {
            return Reflect.apply(originalSend, this, [body]);
        } catch (error) {
            // 同步 send 失败后作废已挂 listener；同一个 XHR 再 open 时不会发布旧 URL。
            requestGenerations.set(this, requestGeneration + 1);
            throw error;
        }
    };
    const dispose = () => {
        const current = environment.stateHost[YOUTUBE_BRIDGE_STATE_KEY] as YoutubeBridgeState | undefined;
        if (current?.owner !== owner) return;
        active = false;
        responseScope.abort();
        restoreMethod(environment.fetch, fetchWrapper, originalFetch);
        restoreMethod(environment.xhrOpen, openWrapper, originalOpen);
        restoreMethod(environment.xhrSend, sendWrapper, originalSend);
        environment.pageEvents.removeEventListener('pagehide', handlePageHide);
        environment.documentEvents.removeEventListener(YOUTUBE_BRIDGE_DISPOSE_EVENT, dispose);
        environment.documentEvents.removeEventListener(YOUTUBE_BRIDGE_REPLAY_EVENT, replayLatest);
        clearReplayCache();
        delete environment.stateHost[YOUTUBE_BRIDGE_STATE_KEY];
    };
    const handlePageHide = (event?: {persisted?: boolean}) => {
        // BFCache pagehide 会保留 document；返回时 MAIN world 入口不会重跑，因此必须保留包装。
        if (event?.persisted !== true) dispose();
    };

    // 步骤 2：某个宿主 API 不可写时保留其他采集通道，避免桥整体失效。
    installMethod(environment.fetch, fetchWrapper);
    installMethod(environment.xhrOpen, openWrapper);
    installMethod(environment.xhrSend, sendWrapper);
    environment.pageEvents.addEventListener('pagehide', handlePageHide);
    environment.documentEvents.addEventListener(YOUTUBE_BRIDGE_DISPOSE_EVENT, dispose);
    environment.documentEvents.addEventListener(YOUTUBE_BRIDGE_REPLAY_EVENT, replayLatest);
    environment.stateHost[YOUTUBE_BRIDGE_STATE_KEY] = {owner, dispose};
    return dispose;
}

/** 站点禁用时恢复宿主 API，恢复启用时在同一 document 内无嵌套地重装 bridge。 */
export function installYoutubeTimedTextBridgeLifecycleCore(
    environment: YoutubeTimedTextBridgeEnvironment,
): () => void {
    const previous = environment.stateHost[YOUTUBE_BRIDGE_LIFECYCLE_STATE_KEY] as YoutubeBridgeLifecycleState | undefined;
    previous?.dispose?.();

    const owner = Symbol('fluentread-youtube-timedtext-bridge-lifecycle');
    let disposeBridge = installYoutubeTimedTextBridgeCore(environment);
    const disable = () => disposeBridge();
    const enable = () => {
        if (environment.stateHost[YOUTUBE_BRIDGE_STATE_KEY]) return;
        disposeBridge = installYoutubeTimedTextBridgeCore(environment);
    };
    const dispose = () => {
        const current = environment.stateHost[YOUTUBE_BRIDGE_LIFECYCLE_STATE_KEY] as YoutubeBridgeLifecycleState | undefined;
        if (current?.owner !== owner) return;
        environment.documentEvents.removeEventListener(YOUTUBE_BRIDGE_DISPOSE_EVENT, disable);
        environment.documentEvents.removeEventListener(YOUTUBE_BRIDGE_ENABLE_EVENT, enable);
        disposeBridge();
        delete environment.stateHost[YOUTUBE_BRIDGE_LIFECYCLE_STATE_KEY];
    };

    environment.documentEvents.addEventListener(YOUTUBE_BRIDGE_DISPOSE_EVENT, disable);
    environment.documentEvents.addEventListener(YOUTUBE_BRIDGE_ENABLE_EVENT, enable);
    environment.stateHost[YOUTUBE_BRIDGE_LIFECYCLE_STATE_KEY] = {owner, dispose};
    return dispose;
}

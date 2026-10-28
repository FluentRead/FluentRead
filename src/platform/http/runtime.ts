/**
 * @file src/platform/http/runtime.ts
 *
 * 文件职责：抽象运行时 fetch 边界，使 provider 请求在扩展、userscript 和测试环境中使用可替换的网络实现。
 * 主要内容：定义 RuntimeFetch，setRuntimeFetch 安装或恢复覆盖实现，runtimeFetch 始终通过当前端口发起请求并默认委托 globalThis.fetch；合并 caller signal 与局部 timeout，保留最先发生的取消来源并立即释放计时器和监听；错误出口取消尚未消费的响应正文或已放弃的 reader，不克隆排空，也不等待底层取消握手，并立即释放读取锁。 可核对的公开符号包括 RuntimeFetch、RuntimeAbortContext、createRuntimeAbortContext、abortErrorFromSignal、setRuntimeFetch、runtimeFetch。
 * 模块边界：本文件属于 platform 基础设施边界，只封装浏览器、网络、存储上下文或 Shadow DOM 机制；不决定翻译业务策略，不直接实现 feature，业务层通过类型化端口消费这里的能力。
 */

/**
 * 可按运行环境替换的 HTTP transport。
 *
 * 浏览器扩展默认使用原生 Fetch；userscript 等运行环境可以在 provider 请求前
 * 注入兼容 transport，从而复用同一套 provider adapter，而不改变扩展网络边界。
 */
/** 仅供本地 transport 使用；不得将该策略序列化为网络请求头。 */
export interface RuntimeFetchPolicy {
    readonly errorBodyLimit?: {readonly maxBytes: number; readonly replacement: string};
}

export type RuntimeFetch = (input: RequestInfo | URL, init?: RequestInit, policy?: RuntimeFetchPolicy) => Promise<Response>;

export interface RuntimeAbortContext {
    readonly signal: AbortSignal;
    readonly didTimeout: () => boolean;
    readonly cleanup: () => void;
}

/** 把调用方取消与 provider 局部 timeout 合并为一个可传给 fetch 的 signal。 */
export function createRuntimeAbortContext(
    timeoutMs: number,
    callerSignal?: AbortSignal,
): RuntimeAbortContext {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
    };
    const onCallerAbort = () => {
        cleanup();
        controller.abort(callerSignal?.reason);
    };
    if (callerSignal?.aborted) onCallerAbort();
    else {
        callerSignal?.addEventListener('abort', onCallerAbort, {once: true});
        timer = setTimeout(() => {
            cleanup();
            timedOut = true;
            controller.abort();
        }, timeoutMs);
    }
    return {
        signal: controller.signal,
        didTimeout: () => timedOut,
        cleanup,
    };
}

/** 保留 Error 类型的取消原因；其他原因统一转换为标准 AbortError。 */
export function abortErrorFromSignal(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('The request was aborted.', 'AbortError');
}

const nativeFetch: RuntimeFetch = (input, init) => globalThis.fetch(input, init);
let activeFetch: RuntimeFetch = nativeFetch;

export function setRuntimeFetch(nextFetch?: RuntimeFetch): void {
    activeFetch = nextFetch || nativeFetch;
}

export function runtimeFetch(input: RequestInfo | URL, init?: RequestInit, policy?: RuntimeFetchPolicy): Promise<Response> {
    return policy ? activeFetch(input, init, policy) : activeFetch(input, init);
}

/**
 * 终止已放弃响应的未读正文，避免错误页或迟到响应继续占用网络与上层传输容量。
 * 直接取消原始流，不使用 clone 产生仍需消费的 tee 分支；底层取消握手可能迟迟
 * 不结算，因此不把它加入业务 deadline，清理错误也不能覆盖原始 HTTP/取消原因。
 * 已读取或持有 reader 的正文由读取方清理，这里只处理尚未消费的响应。
 */
export function cancelUnreadResponseBody(response: Partial<Pick<Response, 'body' | 'bodyUsed'>>): void {
    if (response.bodyUsed) return;
    try { void response.body?.cancel().catch(() => undefined); }
    catch { /* 兼容同步抛错的 transport，保留调用方的原始结果。 */ }
}

/** 读取失败或超限时发起取消并释放锁；底层清理失败不得阻塞或覆盖原始错误。 */
export function cancelResponseReader(reader: Pick<ReadableStreamDefaultReader, 'cancel' | 'releaseLock'>): void {
    try { void reader.cancel().catch(() => undefined); }
    catch { /* 自定义 transport 也可能同步抛错。 */ }
    finally {
        try { reader.releaseLock(); }
        catch { /* reader 的自定义锁清理也不能覆盖原始错误。 */ }
    }
}

import type {RuntimeFetch} from '@/src/platform/http/runtime';

export function parseResponseHeaders(rawHeaders = ''): Headers {
    const headers = new Headers();
    for (const line of rawHeaders.split(/\r?\n/u)) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!name) continue;
        try {
            headers.append(name, value);
        } catch {
            // 脚本管理器可能按 UTF-8 解码出非 ByteString 值；单个无法表示的头不应作废响应。
        }
    }
    return headers;
}

// Fetch 规范禁止这些状态携带响应体，即使脚本管理器给出空 responseText。
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function responseFromUserscript(response: UserscriptXmlHttpResponse): Response {
    const status = response.status >= 200 && response.status <= 599 ? response.status : 200;
    // Via 只明确支持 responseText，未声明桌面脚本管理器提供的可选
    // responseType/anonymous 扩展，因此以文本作为可移植基线。
    const body = NULL_BODY_STATUSES.has(status) ? null : response.responseText ?? String(response.response || '');
    const statusText = /^[\t\x20-\x7e\x80-\xff]*$/u.test(response.statusText || '') ? response.statusText || '' : '';
    return new Response(body as BodyInit | null, {
        status,
        statusText,
        headers: parseResponseHeaders(response.responseHeaders),
    });
}

function abortError(): DOMException {
    return new DOMException('The request was aborted.', 'AbortError');
}

function errorFromResponse(prefix: string, response?: UserscriptXmlHttpResponse): Error {
    const details = response?.statusText || (response?.status ? `HTTP ${response.status}` : 'unknown error');
    return new Error(`${prefix}: ${details}`);
}

function headersToRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
        result[key] = value;
    });
    return result;
}

/** 合并 Request 与 RequestInit；必要时先克隆并读取一次性请求体，供 GM API 复用。 */
async function resolveRequest(input: RequestInfo | URL, init?: RequestInit): Promise<{
    url: string;
    method: string;
    headers: Headers;
    body?: BodyInit | null;
    credentials?: RequestCredentials;
    signal?: AbortSignal | null;
}> {
    if (input instanceof Request) {
        const request = input.clone();
        const headers = new Headers(request.headers);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        let body = init?.body;
        if (body === undefined && request.method !== 'GET' && request.method !== 'HEAD') {
            body = await request.arrayBuffer();
        }
        return {
            url: request.url,
            method: init?.method || request.method,
            headers,
            body,
            credentials: init?.credentials || request.credentials,
            signal: init?.signal || request.signal,
        };
    }

    return {
        url: input instanceof URL ? input.href : String(input),
        method: init?.method || 'GET',
        headers: new Headers(init?.headers),
        body: init?.body,
        credentials: init?.credentials,
        signal: init?.signal,
    };
}

function shouldUseNativeFetch(url: string): boolean {
    try {
        const baseUrl = typeof location === 'undefined' ? 'https://localhost/' : location.href;
        const protocol = new URL(url, baseUrl).protocol;
        return protocol !== 'http:' && protocol !== 'https:';
    } catch {
        return true;
    }
}

/** 以 Via 支持的旧式 GM API 实现兼容 fetch 的传输层。 */
export const userscriptFetch: RuntimeFetch = async (input, init) => {
    const request = await resolveRequest(input, init);
    const gmRequest = globalThis.GM_xmlhttpRequest;
    // GM_xmlhttpRequest 只接管 HTTP(S) 跨域请求；blob/data 等协议仍交给网页原生 fetch。
    if (!gmRequest || shouldUseNativeFetch(request.url)) {
        return globalThis.fetch(input, init);
    }

    if (request.signal?.aborted) throw abortError();

    return new Promise<Response>((resolve, reject) => {
        let settled = false;
        let handle: UserscriptXmlHttpRequestHandle | void;
        // 所有 GM 回调与 AbortSignal 共用一次性完成门，避免取消后迟到回调重复结算。
        const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            request.signal?.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => {
            handle?.abort?.();
            finish(() => reject(abortError()));
        };

        request.signal?.addEventListener('abort', onAbort, {once: true});
        try {
            handle = gmRequest({
                method: request.method,
                url: request.url,
                headers: headersToRecord(request.headers),
                data: request.body ?? undefined,
                onload(response) {
                    // 完成门先关闭再构造 Response；构造失败必须 reject，否则调用方与后续 abort 都无法结算。
                    finish(() => {
                        try {
                            resolve(responseFromUserscript(response));
                        } catch (error) {
                            reject(error);
                        }
                    });
                },
                onerror(response) {
                    finish(() => reject(errorFromResponse('GM_xmlhttpRequest failed', response)));
                },
                ontimeout(response) {
                    finish(() => reject(errorFromResponse('GM_xmlhttpRequest timed out', response)));
                },
                onabort() {
                    finish(() => reject(abortError()));
                },
            });
        } catch (error) {
            finish(() => reject(error));
        }
    });
};

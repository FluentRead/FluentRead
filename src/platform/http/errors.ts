/**
 * @file src/platform/http/errors.ts
 *
 * 文件职责：封装 provider HTTP 与 JSON 响应的安全错误构造，统一状态文案和外部错误码长度限制。
 * 主要内容：提供 createHttpStatusError、getSafeProviderErrorCode、createProviderCodeError 与 readJsonResponse，在协议适配器中复用并避免直接信任任意响应字段；图片错误仅保留明确模态拒绝的布尔标记，绝不回显第三方正文。 可核对的公开符号包括 createHttpStatusError、getSafeProviderErrorCode、createProviderCodeError、readJsonResponse。
 * 模块边界：本文件属于 platform 基础设施边界，只封装浏览器、网络、存储上下文或 Shadow DOM 机制；不决定翻译业务策略，不直接实现 feature，业务层通过类型化端口消费这里的能力。
 */

type HttpStatus = Pick<Response, 'status' | 'statusText'> & {headers?: Pick<Headers, 'get'>};
type JsonResponse = Pick<Response, 'json'>;
import {isExplicitImageInputRejection} from '@/src/core/config/visionProbe';
import {abortErrorFromSignal, cancelResponseReader} from './runtime';

const MAX_PROVIDER_CODE_LENGTH = 16;
const MAX_IMAGE_ERROR_BYTES = 32_768;
const IMAGE_ERROR_READ_TIMEOUT_MS = 1000;

/**
 * 构造不回显第三方响应正文的 HTTP 错误。
 * 正文可能包含原文、译文、provider 诊断或代理回显的凭据，因此只暴露协议状态码。
 */
export function createHttpStatusError(response: HttpStatus, label = '请求失败'): Error {
    const retryAfter = response.headers?.get('Retry-After');
    let retryAfterMs: number | undefined;
    if (retryAfter?.trim()) {
        const value = retryAfter.trim();
        const duration = /^\d+(?:\.\d+)?$/u.test(value)
            ? Number(value) * 1000 : Date.parse(value) - Date.now();
        if (Number.isFinite(duration) && duration > 0) retryAfterMs = Math.min(duration, 7 * 86_400_000);
    }
    return Object.assign(new Error(`${label}: ${response.status}`), {
        statusCode: response.status,
        ...(retryAfterMs === undefined ? {} : {retryAfterMs}),
    });
}

/** 图片错误只提取可验证的能力标记，第三方正文不进入错误、日志或能力缓存。 */
export async function createImageInputHttpError(response: Response, label = '请求失败'): Promise<Error> {
    const error = createHttpStatusError(response, label);
    if (response.status !== 400 && response.status !== 422) return error;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelTimer: (() => void) | undefined;
    try {
        // 原始响应仍可能由 SDK 读取；只检查克隆分支，限制未知错误正文的体积和等待时间。
        const body = response.clone().body;
        if (!body) return error;
        reader = body.getReader();
        const current = reader;
        const collect = async (): Promise<string | undefined> => {
            const decoder = new TextDecoder(); let bytes = 0, text = '';
            while (true) {
                const part = await current.read();
                if (part.done) return text + decoder.decode();
                bytes += part.value.byteLength;
                if (bytes > MAX_IMAGE_ERROR_BYTES) return undefined;
                text += decoder.decode(part.value, {stream: true});
            }
        };
        const text = await Promise.race([
            collect(),
            new Promise<undefined>(resolve => {
                const timer = setTimeout(() => resolve(undefined), IMAGE_ERROR_READ_TIMEOUT_MS);
                cancelTimer = () => clearTimeout(timer);
            }),
        ]);
        if (text === undefined) return error;
        const parsed = JSON.parse(text);
        const detail = parsed?.error?.message ?? parsed?.message;
        if (typeof detail === 'string' && detail.length <= 2048 && isExplicitImageInputRejection(response.status, detail)) {
            Object.assign(error, {imageInputUnsupported: true});
        }
    } catch { /* 非 JSON、过大或无法读取时只保留状态，不能认定模型没有视觉能力。 */ }
    finally {
        cancelTimer?.();
        if (reader) cancelResponseReader(reader);
    }
    return error;
}

/** 只有短小且确实形似数字错误码的 provider 字段可以回显。 */
export function getSafeProviderErrorCode(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;

    const code = String(value).trim();
    if (
        code.length === 0
        || code.length > MAX_PROVIDER_CODE_LENGTH
        || !/^\d+$/.test(code)
    ) {
        return undefined;
    }
    return code;
}

export function createProviderCodeError(label: string, value: unknown): Error {
    const code = getSafeProviderErrorCode(value);
    return new Error(code ? `${label}（错误码 ${code}）` : label);
}

/**
 * 解析第三方 JSON，但不传播 parser 自带的输入预览。
 * V8 的 SyntaxError 可能包含损坏 JSON 的片段，其中可能有原文或代理诊断。
 * 仅明确传入的 signal 已取消时保留调用方原因；不提前结束或释放不合作的读取。
 */
export async function readJsonResponse<T = unknown>(
    response: JsonResponse,
    label = '返回的不是有效 JSON',
    signal?: AbortSignal,
): Promise<T> {
    try {
        return await response.json() as T;
    } catch {
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        throw new Error(label);
    }
}

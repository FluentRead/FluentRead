/**
 * @file src/features/image-translation/background/operationRegistry.ts
 * 文件职责：封装图片与圈选翻译后台任务的请求字段校验、超时与取消所有权登记表及统一中止错误工厂。
 * 主要内容：校验 data URL、非空字符串、标题、requestId 格式、正数超时上限、文本数组和 OCR 语言白名单；维护活跃任务映射与有界预取消集合，防止重入或迟到取消误杀后续任务。
 * 模块边界：仅处理后台消息参数校验与任务取消生命周期，不直接触发翻译、OCR、网络请求或浏览器 runtime 通信。
 */
import {
    IMAGE_OCR_LANGUAGE_PACKS,
    normalizeImageOcrLanguageCodes,
    type ImageOcrLanguageCode,
} from '@/src/features/image-translation/ocrLanguages';
import type {ImageViewport} from '@/src/shared/image/types';

export const IMAGE_OPERATION_TIMEOUT_MS = 180_000;

export interface ImageOperationOptions {
    readonly ocrEngine?: 'paddle';
    readonly inferenceBackend?: 'auto' | 'cpu';
    /** 仅由已复核的消息 sender 提供，不接受消息体自报来源。 */
    readonly documentUrl?: string;
    readonly manga?: true;
    readonly mangaViewport?: ImageViewport;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
}

export interface ImageOperationMessage {
    readonly requestId?: unknown;
    readonly timeoutMs?: unknown;
}

export interface ImageOperationRegistry {
    run<T>(message: ImageOperationMessage, operation: (options: ImageOperationOptions) => Promise<T>): Promise<T>;
    cancel(requestId: unknown): {success: true; cancelled: boolean; requestId: string};
}

const SUPPORTED_OCR_LANGUAGES = new Set(IMAGE_OCR_LANGUAGE_PACKS.map((pack) => pack.code));
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_IMAGE_OPERATION_TIMEOUT_MS = 300_000;

export function parseDataImage(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith('data:image/')) {
        throw new TypeError('图片数据无效');
    }
    return value;
}

export function parseRequiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`图片翻译 ${field} 必须是非空字符串`);
    }
    return value;
}

export function parseOptionalTitle(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new TypeError('图片翻译 title 必须是字符串');
    return value;
}

export function parseRequestId(value: unknown): string {
    const requestId = parseRequiredString(value, 'requestId');
    if (!REQUEST_ID_PATTERN.test(requestId)) throw new TypeError('图片翻译 requestId 格式无效');
    return requestId;
}

export function parseTimeoutMs(value: unknown): number {
    if (value === undefined) return IMAGE_OPERATION_TIMEOUT_MS;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError('图片翻译 timeoutMs 必须是正数');
    }
    return Math.min(MAX_IMAGE_OPERATION_TIMEOUT_MS, Math.floor(value));
}

export function imageAbortError(timedOut: boolean): Error {
    const error = new Error(timedOut ? '图片 OCR 请求超时' : '图片 OCR 请求已取消');
    error.name = timedOut ? 'TimeoutError' : 'AbortError';
    return error;
}

/** 图片与圈选 feature 共用的后台取消所有权，确保它们不会各自遗漏共享 OCR 队列。 */
export function createImageOperationRegistry(legacyPrefix = 'image'): ImageOperationRegistry {
    const activeOperations = new Map<string, AbortController>();
    const cancelledBeforeStart = new Set<string>();
    let legacyRequestSequence = 0;

    const rememberCancellation = (requestId: string) => {
        if (cancelledBeforeStart.has(requestId)) return;
        cancelledBeforeStart.add(requestId);
        // Set 只保留未消费的取消及其插入顺序，避免已消费 ID 的旧队列项误删后续取消。
        if (cancelledBeforeStart.size > 512) {
            cancelledBeforeStart.delete(cancelledBeforeStart.values().next().value!);
        }
    };

    return {
        async run<T>(
            message: ImageOperationMessage,
            operation: (options: ImageOperationOptions) => Promise<T>,
        ): Promise<T> {
            const requestId = message.requestId === undefined
                ? `legacy-${legacyPrefix}-${++legacyRequestSequence}`
                : parseRequestId(message.requestId);
            if (cancelledBeforeStart.delete(requestId)) throw imageAbortError(false);
            if (activeOperations.has(requestId)) throw new Error('图片 OCR requestId 正在执行');
            const timeoutMs = parseTimeoutMs(message.timeoutMs);
            const controller = new AbortController();
            activeOperations.set(requestId, controller);
            let timedOut = false;
            const timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeoutMs);

            try {
                const pending = Promise.resolve().then(() => operation({
                    requestId,
                    signal: controller.signal,
                    timeoutMs,
                }));
                return await new Promise<T>((resolve, reject) => {
                    let settled = false;
                    const cleanup = () => controller.signal.removeEventListener('abort', handleAbort);
                    const finish = (callback: () => void) => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        callback();
                    };
                    const handleAbort = () => finish(() => reject(imageAbortError(timedOut)));
                    controller.signal.addEventListener('abort', handleAbort, {once: true});
                    void pending.then(
                        result => finish(() => resolve(result)),
                        error => finish(() => reject(error)),
                    );
                });
            } finally {
                clearTimeout(timer);
                // 重复身份在准入时拒绝；取消只abort，本次run退出并释放身份后，重试才能成为新的owner。
                activeOperations.delete(requestId);
            }
        },
        cancel(requestIdValue) {
            const requestId = parseRequestId(requestIdValue);
            const controller = activeOperations.get(requestId);
            if (controller) controller.abort();
            else rememberCancellation(requestId);
            return {success: true, cancelled: Boolean(controller), requestId};
        },
    };
}

export function parseTexts(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError('图片中没有可翻译文字');
    if (!value.every((text): text is string => typeof text === 'string' && text.trim().length > 0)) {
        throw new TypeError('图片翻译 texts 只能包含非空字符串');
    }
    return [...value];
}

export function parseOcrLanguages(value: unknown): ImageOcrLanguageCode[] {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError('OCR 语言包列表不能为空');
    if (!value.every((language): language is ImageOcrLanguageCode =>
        typeof language === 'string' && SUPPORTED_OCR_LANGUAGES.has(language as ImageOcrLanguageCode))) {
        throw new TypeError('OCR 语言包列表包含不支持的语言');
    }
    return normalizeImageOcrLanguageCodes(value);
}

export function parseObjectResult(value: unknown, operation: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${operation}结果无效`);
    }
    return value as Record<string, unknown>;
}

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * @file src/core/translation/nativeBatch.ts
 *
 * 文件职责：定义机器翻译原生数组响应的完整性契约与保守分包上限。
 * 主要内容：提供 NativeBatchResponseError、跨消息错误识别和等长稠密字符串校验；非空原文不能对应空译文，异常响应不得作为部分成功发布。
 * 模块边界：只处理传入文本与响应，不访问配置、浏览器、网络或缓存；provider 负责供应商字段映射，broker 负责失败后的逐段恢复。
 */

import {hasTranslationContent} from './result';

export const NATIVE_BATCH_MAX_ITEMS = 32;
export const NATIVE_BATCH_MAX_CHARACTERS = 4_000;

export class NativeBatchResponseError extends Error {
    readonly kind = 'response';
    readonly code = 'NATIVE_BATCH_RESPONSE_INVALID';
    readonly retryable = false;

    constructor(message = '原生批量翻译返回格式异常，已切换为逐段翻译') {
        super(message);
        this.name = 'NativeBatchResponseError';
    }
}

/** runtime 消息会复制错误字段，不能只依赖跨边界失效的 instanceof。 */
export function isNativeBatchResponseError(error: unknown): boolean {
    return error instanceof NativeBatchResponseError || Boolean(error && typeof error === 'object'
        && (error as {kind?: unknown}).kind === 'response'
        && (error as {code?: unknown}).code === 'NATIVE_BATCH_RESPONSE_INVALID');
}

/** 拒绝缺项、额外项、稀疏数组、非字符串及非空原文对应的空译文。 */
export function validateNativeBatchResults(
    origins: readonly string[],
    results: unknown,
    invalidResponseMessage?: string,
): string[] {
    if (!Array.isArray(results) || results.length !== origins.length) {
        throw new NativeBatchResponseError(invalidResponseMessage);
    }
    const validated = Array.from({length: origins.length}, (_, index) => results[index]);
    if (validated.some((value, index) => typeof value !== 'string'
        || (hasTranslationContent(origins[index]) && !hasTranslationContent(value)))) {
        throw new NativeBatchResponseError(invalidResponseMessage);
    }
    return validated as string[];
}

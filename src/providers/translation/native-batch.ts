/**
 * @file src/providers/translation/native-batch.ts
 *
 * 文件职责：为支持原生文本数组的机器翻译适配器顺序分包并按源槽位原子回填。
 * 主要内容：复制输入、在本地保留空白槽、按 32 项和 4000 字符限制常规组，关闭合批时每组只有一项；超长单槽独立请求且不切割正文，逐组检查完整响应和取消，所有组成功才返回对应形状；JSON 语法、网页拦截与读取故障分类避免网络异常拆批。
 * 模块边界：不选择供应商、不读取凭据、不重试、不拼接占位符；供应商 callback 只转换原生协议，broker 统一处理恢复、缓存和总截止时间。
 */

import {
    NATIVE_BATCH_MAX_CHARACTERS,
    NATIVE_BATCH_MAX_ITEMS,
    validateNativeBatchResults,
    NativeBatchResponseError,
} from '@/src/core/translation/nativeBatch';
import {abortErrorFromSignal} from '@/src/platform/http/runtime';
import {hasTranslationContent} from '@/src/core/translation/result';

interface NativeBatchEntry {
    readonly index: number;
    readonly origin: string;
}

/** JSON 语法损坏可拆批；读取中断、网络与取消不能冒充结构错误放大请求。 */
export async function readNativeBatchJson<T>(
    response: Pick<Response, 'json'> & Partial<Pick<Response, 'headers'>>,
    invalidResponseMessage: string,
    signal?: AbortSignal,
): Promise<T> {
    throwIfNativeBatchAborted(signal);
    if (/\b(?:html|xml)\b/iu.test(response.headers?.get('content-type') ?? '')) {
        throw new Error('翻译服务返回网页或验证页，请稍后重试');
    }
    try {
        return await response.json() as T;
    } catch (error) {
        throwIfNativeBatchAborted(signal);
        if (error instanceof SyntaxError) throw new NativeBatchResponseError(invalidResponseMessage);
        throw new Error('翻译响应读取失败');
    }
}

function throwIfNativeBatchAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortErrorFromSignal(signal);
}

export async function translateNativeTextBatch(
    origin: string | readonly string[],
    translateGroup: (origins: readonly string[]) => Promise<unknown>,
    signal?: AbortSignal,
    invalidResponseMessage?: string,
    enableNativeBatch = true,
): Promise<string | string[]> {
    throwIfNativeBatchAborted(signal);
    const single = typeof origin === 'string';
    const origins = single ? [origin] : Array.from(origin);
    const result = [...origins];
    const groups: NativeBatchEntry[][] = [];
    let group: NativeBatchEntry[] = [];
    let characters = 0;
    for (const [index, text] of origins.entries()) {
        if (!hasTranslationContent(text)) continue;
        if (group.length > 0 && (!enableNativeBatch || group.length >= NATIVE_BATCH_MAX_ITEMS
            || characters + text.length > NATIVE_BATCH_MAX_CHARACTERS)) {
            groups.push(group);
            group = [];
            characters = 0;
        }
        group.push({index, origin: text});
        characters += text.length;
    }
    if (group.length > 0) groups.push(group);

    for (const entries of groups) {
        throwIfNativeBatchAborted(signal);
        const sources = entries.map(entry => entry.origin);
        const translated = await translateGroup(sources);
        throwIfNativeBatchAborted(signal);
        const validated = validateNativeBatchResults(sources, translated, invalidResponseMessage);
        entries.forEach((entry, index) => { result[entry.index] = validated[index]; });
    }
    throwIfNativeBatchAborted(signal);
    return single ? result[0] : result;
}

/**
 * @file src/core/translation/localInference.ts
 *
 * 文件职责：约束本地小模型的输入长度和异常输出。
 * 主要内容：按句或在同一行内合并连续句子分段，保留原文换行和边界空白；提供混元翻译提示词与重复输出检查。
 * 模块边界：只处理文本，不加载模型、不修改宿主 DOM，也不把无效结果标记为成功。
 */
import {HUNYUAN_LANGUAGE_NAMES} from '@/src/core/config/localTranslation';

export function splitLocalTranslationText(
    text: string,
    maxLength = 480,
    mode: 'sentence' | 'paragraph' = 'sentence',
): string[] {
    // 至少容纳一个 UTF-16 代理对，否则退让边界会得到零长度并反复切同一段。
    if (!Number.isSafeInteger(maxLength) || maxLength < 2) throw new RangeError('LOCAL_TRANSLATION_INVALID_CHUNK_LENGTH');
    const result: string[] = [];
    const segments = new Intl.Segmenter(undefined, {granularity: 'sentence'}).segment(text);
    let chunk = '';
    for (const {segment} of segments) {
        if (chunk && chunk.length + segment.length > maxLength) {
            result.push(chunk);
            chunk = '';
        }
        let rest = segment;
        while (rest.length > maxLength) {
            const prefix = rest.slice(0, maxLength);
            const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('，') + 1, prefix.lastIndexOf(',') + 1);
            let end = boundary > maxLength / 2 ? boundary : maxLength;
            if (/[\uD800-\uDBFF]/u.test(rest[end - 1]!)) end--;
            result.push(rest.slice(0, end));
            rest = rest.slice(end);
        }
        chunk += rest;
        if (mode === 'sentence' || /[\r\n\u2028\u2029]/u.test(rest)) {
            result.push(chunk);
            chunk = '';
        }
    }
    if (chunk) result.push(chunk);
    return result;
}

export function hunyuanTranslationPrompt(text: string, source: string, target: string): string {
    const targetName = HUNYUAN_LANGUAGE_NAMES[target];
    if (!targetName) throw new Error('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
    if (source.startsWith('zh') || target.startsWith('zh')) {
        return `将以下文本翻译成${targetName}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`;
    }
    return `Translate the following segment into ${targetName}, without additional explanation.\n\n${text}`;
}

export function assertLocalTranslationOutput(text: string, source: string): void {
    if (!text.trim()) throw new Error('LOCAL_TRANSLATION_EMPTY');
    const repeated = /(.{1,32}?)\1{9,}/gu;
    for (const match of text.matchAll(repeated)) {
        if (match[0].trim().length >= 16 && !source.includes(match[0])) {
            throw new Error('LOCAL_TRANSLATION_REPETITION');
        }
    }
}

/**
 * @file src/core/translation/localInference.ts
 *
 * 文件职责：约束本地小模型的输入长度和异常输出。
 * 主要内容：保留句间空白的分段、混元官方翻译提示词和重复输出检查，避免小模型陷入重复生成。
 * 模块边界：只处理文本，不加载模型、不修改宿主 DOM，也不把无效结果标记为成功。
 */
import {getHunyuanLanguageNames} from '@/src/core/config/localTranslation';

export function splitLocalTranslationText(text: string, maxLength = 480): string[] {
    // 至少容纳一个 UTF-16 代理对，否则退让边界会得到零长度并反复切同一段。
    if (!Number.isSafeInteger(maxLength) || maxLength < 2) throw new RangeError('LOCAL_TRANSLATION_INVALID_CHUNK_LENGTH');
    const result: string[] = [];
    const segments = new Intl.Segmenter(undefined, {granularity: 'sentence'}).segment(text);
    for (const {segment} of segments) {
        let rest = segment;
        while (rest.length > maxLength) {
            const prefix = rest.slice(0, maxLength);
            const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('，') + 1, prefix.lastIndexOf(',') + 1);
            let end = boundary > maxLength / 2 ? boundary : maxLength;
            if (/[\uD800-\uDBFF]/u.test(rest[end - 1]!)) end--;
            result.push(rest.slice(0, end));
            rest = rest.slice(end);
        }
        result.push(rest);
    }
    return result;
}

export function hunyuanTranslationPrompt(text: string, source: string, target: string, model?: unknown): string {
    const targetName = getHunyuanLanguageNames(model)[target];
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

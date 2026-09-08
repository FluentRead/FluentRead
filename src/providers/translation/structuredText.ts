/**
 * @file src/providers/translation/structuredText.ts
 * 文件职责：为小额公开翻译接口保留文本结构并限制单次请求大小。
 * 主要内容：顺序处理数组、全文文本槽、换行和边缘空白；按 Unicode 码点分块，在每次请求前后检查取消。
 * 模块边界：只编排传入的文本回调，不读取配置、发送网络请求或操作宿主页面。
 */
import {getTranslationGlossarySourceText} from '@/src/services/translation/requestSnapshot';
import {serializeTranslationSlots} from '@/src/core/translation/serialization';
import {abortErrorFromSignal} from '@/src/platform/http/runtime';

export async function translateStructuredText(
    origin: unknown,
    translate: (text: string) => Promise<string>,
    signal?: AbortSignal,
): Promise<string | string[]> {
    const check = () => { if (signal?.aborted) throw abortErrorFromSignal(signal); };
    const one = async (text: unknown): Promise<string> => {
        check();
        if (typeof text !== 'string') throw Object.assign(new Error('翻译服务仅支持文本输入'), {statusCode: 400});
        const plain = getTranslationGlossarySourceText(text);
        if (Array.isArray(plain)) {
            const translated: string[] = [];
            for (const slot of plain) translated.push(await one(slot));
            const nonce = text.match(/^___FLUENTREAD_([a-z0-9_-]+)_0_BEGIN___/iu)![1]!;
            return serializeTranslationSlots(translated, nonce).payload;
        }
        let result = '';
        for (const line of text.split(/([\r\n]+)/u)) {
            const characters = Array.from(line);
            for (let index = 0; index < characters.length; index += 1000) {
                check();
                const chunk = characters.slice(index, index + 1000).join('');
                const content = chunk.trim();
                if (!content) { result += chunk; continue; }
                const prefix = chunk.slice(0, chunk.indexOf(content));
                const suffix = chunk.slice(prefix.length + content.length);
                const value = await translate(content);
                check();
                if (typeof value !== 'string' || !value.trim()) throw new Error('翻译服务未返回有效译文');
                result += prefix + value.trim() + suffix;
            }
        }
        return result;
    };
    if (!Array.isArray(origin)) return one(origin);
    const results: string[] = [];
    for (const text of origin) results.push(await one(text));
    check();
    return results;
}

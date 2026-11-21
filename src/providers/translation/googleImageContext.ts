/**
 * @file src/providers/translation/googleImageContext.ts
 * 文件职责：为同一图片的 Google HTML 批译提供有界邻文和可核对的位置协议。
 * 主要内容：最多四个相邻完整句子共享段落，标题和残句保持独立；原图确认同栏的短标签可借前后各一行，传输中临时补句号并在对应译文槽恢复原标点形式。保留大小写、编号和拒绝异常响应的契约。
 * 模块边界：纯字符串协议，不发请求、不读取配置、不访问 DOM；取消、缓存与回退由 broker 和 Google adapter 管理，未知的返回形式回退到独立翻译。
 */

function boundary(text: string): number {
    const end = text.trimEnd().replace(/["'”’»）)\]】」』]+$/u, '').match(/[.!?。！？؟۔…।॥,，、:：;；]+$/u)?.[0];
    if (!end) return 0;
    if (/[,，、:：;；]$/u.test(end)) return -1;
    return (/[?？؟]/u.test(end) ? 1 : 0) + (/[!！]/u.test(end) ? 2 : 0) || 4;
}

export function createGoogleImageContext(
    texts: readonly string[], escape: (text: string) => string, allowedLabels?: readonly number[],
): {documents: string[]; labelSlots: ReadonlySet<number>} {
    const documents: string[] = [];
    const allowed = new Set(allowedLabels);
    const labelSlots = new Set<number>();
    const render = (index: number, text: string) => `<span data-fr-slot="${index}">${escape(text)}</span>`;
    let rows: string[] = [], characters = 0;
    const flush = () => {
        if (rows.length) documents.push(`<p>${rows.join(' ')}</p>`);
        rows = []; characters = 0;
    };
    for (let index = 0; index < texts.length; index++) {
        const text = texts[index];
        if (allowed.has(index + 1) && index + 2 < texts.length) {
            const label = texts[index + 1], after = texts[index + 2];
            if (boundary(text) > 0 && /^[\p{L} ]+$/u.test(label) && boundary(after) > 0
                && text.length + label.length + after.length + 1 <= 1200 && !/[\r\n]/u.test(text + label + after)) {
                flush();
                const chosen = [render(index, text), render(index + 1, label + '.'), render(index + 2, after)];
                documents.push(`<p>${chosen.join(' ')}</p>`);
                labelSlots.add(index + 1);
                index += 2;
                continue;
            }
        }
        const row = render(index, text);
        if (boundary(text) <= 0 || /[\r\n]/u.test(text)) {
            flush(); documents.push(`<pre>${row}</pre>`);
        } else {
            if (rows.length === 4 || characters + text.length > 1200) flush();
            rows.push(row); characters += text.length;
        }
    }
    flush();
    return {documents, labelSlots};
}

export function parseGoogleImageContext(
    documents: readonly string[], texts: readonly string[], decode: (text: string) => string, labelSlots?: ReadonlySet<number>,
): string[] {
    const translated = new Map<number, string>();
    const invalid = () => {throw new Error('图片批译的槽位或句末边界异常');};
    for (const document of documents) {
        const body = document.match(/^<(p|pre)>([\s\S]*)<\/\1>$/u);
        if (!body) invalid();
        const rest = body![2].replace(/<span data-fr-slot="(0|[1-9][0-9]*)">([^<>]*)<\/span>/gu, (_, slot: string, encoded: string) => {
            const index = Number(slot);
            const decoded = decode(encoded);
            const value = labelSlots?.has(index) ? decoded.trimEnd().replace(/[.。]$/u, '') : decoded;
            if (index >= texts.length || translated.has(index) || !value.trim() || boundary(texts[index]) !== boundary(value)) invalid();
            translated.set(index, value);
            return '';
        });
        if (rest.trim()) invalid();
    }
    if (translated.size !== texts.length) invalid();
    return texts.map((_, index) => translated.get(index)!);
}

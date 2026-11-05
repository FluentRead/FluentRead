/**
 * @file src/core/translation/subtitleContext.ts
 * 文件职责：为字幕翻译生成有界、按原时间顺序排列的相邻 cue 参考。
 * 主要内容：识别带时间轴的片段，优先保留请求两端并向每个请求 cue 的前后六条查找；单条参考最多160字符，总参考不超过1200字符，避免长 cue 挤走全部邻句。
 * 模块边界：只读取结构化原文与位置，不合并、修改字幕或时间戳，不调用模型、缓存、文件解析或浏览器 API。
 */
export const SUBTITLE_CONTEXT_LIMIT = 1_200;
const SUBTITLE_REFERENCE_TEXT_LIMIT = 160;

export interface SubtitleContextCue {
    id: number;
    source: string;
    timeStart?: string;
    timeEnd?: string;
}

export function isTimedSubtitleCue(cue: SubtitleContextCue): boolean {
    return Boolean(cue.timeStart && cue.timeEnd);
}

export function buildSubtitleContext(
    segments: readonly SubtitleContextCue[],
    batch: readonly SubtitleContextCue[],
    positions: ReadonlyMap<number, number>,
): string | undefined {
    if (!batch.length || batch.some(cue => !isTimedSubtitleCue(cue))) return undefined;
    const indexes = batch.map(cue => positions.get(cue.id)).filter((index): index is number => index !== undefined);
    if (indexes.length !== batch.length) return undefined;
    let first = indexes[0], last = first;
    for (const index of indexes) { first = Math.min(first, index); last = Math.max(last, index); }
    const requested = new Set(indexes);
    const header = `Context anchor cue positions: ${indexes.map(index => index + 1).join(', ')}\n`;
    const candidates = [first, last];
    for (let distance = 1; distance <= 6; distance += 1) {
        for (const index of indexes) for (const neighbor of [index - distance, index + distance]) {
            if (!requested.has(neighbor)) candidates.push(neighbor);
        }
    }
    const selected: Array<{index: number; text: string}> = [];
    const seen = new Set<number>();
    let length = header.length;
    for (const index of candidates) {
        if (seen.has(index)) continue;
        seen.add(index);
        const cue = segments[index];
        if (!cue || !isTimedSubtitleCue(cue) || !cue.source.trim()) continue;
        const prefix = `[cue ${index + 1} | ${cue.timeStart} --> ${cue.timeEnd}]\n`;
        const available = SUBTITLE_CONTEXT_LIMIT - length - prefix.length - 2;
        if (available <= 0) continue;
        const text = prefix + cue.source.trim().slice(0, Math.min(available, SUBTITLE_REFERENCE_TEXT_LIMIT));
        selected.push({index, text});
        length += text.length + 2;
    }
    if (!selected.length) return undefined;
    return header + selected.sort((left, right) => left.index - right.index).map(item => item.text).join('\n\n');
}

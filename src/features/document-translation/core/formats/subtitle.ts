/**
 * @file src/features/document-translation/core/formats/subtitle.ts
 * 文件职责：负责 SRT、WebVTT、ASS/SSA 与 LRC 字幕及歌词文档的解析切分、样式标签还原、硬换行恢复与导出边界保护。
 * 主要内容：按时间轴与对话字段抽取待译文本并保留原生时间戳元数据；导出时恢复被改写的实体/括号样式标签、按原文行数补回 ASS 硬换行并规避 SRT/VTT 箭头和空行破坏 cue 边界。
 * 模块边界：仅处理字幕与歌词纯文本格式的解析和译文整形，不处理浏览器视频字幕 DOM 或二进制文档。
 */
import {
    addLiteral,
    addSegment,
    splitWithEndings,
    type DocumentFormat,
    type DocumentPart,
    type DocumentSegment,
    type ParsedDocument,
} from './shared';

const TIMED_SUBTITLE_PATTERN = /^\s*(?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3}\s*-->\s*(?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3}(?:\s+.*)?$/u;
const LRC_TIME_PATTERN = /^(\s*(?:\[[^\]\r\n]+\])+)/u;

export function parseTimedSubtitleDocument(content: string, format: 'srt' | 'vtt'): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);
    let cursorLine = 0;

    while (cursorLine < lines.length) {
        const timestampLine = lines[cursorLine];
        if (format === 'vtt' && /^NOTE(?:[ \t].*)?$/u.test(timestampLine.text)) {
            const start = timestampLine.start;
            while (cursorLine < lines.length && lines[cursorLine].text.trim()) cursorLine += 1;
            addLiteral(parts, content.slice(start, lines[cursorLine - 1].end));
            continue;
        }
        if (!timestampLine || !TIMED_SUBTITLE_PATTERN.test(timestampLine.text)) {
            addLiteral(parts, content.slice(timestampLine.start, timestampLine.end));
            cursorLine += 1;
            continue;
        }

        const timeMatch = timestampLine.text.match(/^\s*((?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[,.]\d{3})/u);
        addLiteral(parts, content.slice(timestampLine.start, timestampLine.end));
        cursorLine += 1;
        const textStartLine = cursorLine;
        while (cursorLine < lines.length && lines[cursorLine].text.trim() && !TIMED_SUBTITLE_PATTERN.test(lines[cursorLine].text)) {
            const nextLineStartsCue = format === 'srt'
                && /^\s*\d+\s*$/u.test(lines[cursorLine].text)
                && TIMED_SUBTITLE_PATTERN.test(lines[cursorLine + 1]?.text || '');
            if (nextLineStartsCue) break;
            cursorLine += 1;
        }

        if (cursorLine === textStartLine) continue;
        const textStart = lines[textStartLine].start;
        const textEnd = lines[cursorLine - 1].textEnd;
        const source = content.slice(textStart, textEnd);
        // 将完整字幕提示作为一个翻译单元，使服务能保留 `<i>...</i>` 等行内标签或 ASS
        // 覆盖代码，同时不把时间戳和提示边界发送给翻译请求。
        addSegment(parts, segments, source, {
            timeStart: timeMatch?.[1],
            timeEnd: timeMatch?.[2],
        });

        if (cursorLine < lines.length) {
            addLiteral(parts, content.slice(textEnd, lines[cursorLine].start));
        } else {
            addLiteral(parts, content.slice(textEnd));
        }
    }

    return {parts, segments};
}

export function parseAssDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);

    lines.forEach((line) => {
        if (!/^\s*Dialogue\s*:/iu.test(line.text)) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const colon = line.text.indexOf(':');
        const prefix = line.text.slice(0, colon + 1);
        const dialogue = line.text.slice(colon + 1);
        let commaCount = 0;
        let textStart = -1;
        for (let index = 0; index < dialogue.length; index += 1) {
            if (dialogue[index] !== ',') continue;
            commaCount += 1;
            if (commaCount === 9) {
                textStart = index + 1;
                break;
            }
        }

        if (textStart < 0) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const fields = dialogue.slice(0, textStart - 1).split(',');
        addLiteral(parts, prefix + dialogue.slice(0, textStart));
        addSegment(parts, segments, dialogue.slice(textStart), {
            timeStart: fields[1]?.trim(),
            timeEnd: fields[2]?.trim(),
        });
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments};
}

export function parseLrcDocument(content: string): Pick<ParsedDocument, 'parts' | 'segments'> {
    const parts: DocumentPart[] = [];
    const segments: DocumentSegment[] = [];
    const lines = splitWithEndings(content);

    lines.forEach((line) => {
        const match = line.text.match(LRC_TIME_PATTERN);
        if (!match) {
            addLiteral(parts, content.slice(line.start, line.end));
            return;
        }

        const prefix = match[1];
        addLiteral(parts, prefix);
        const firstTimestamp = prefix.match(/\[((?:\d{1,3}:)?\d{2}(?:\.\d{1,3})?)\]/u)?.[1];
        addSegment(parts, segments, line.text.slice(prefix.length), {
            bilingualPrefix: prefix,
            timeStart: firstTimestamp,
        });
        addLiteral(parts, content.slice(line.textEnd, line.end));
    });

    return {parts, segments};
}

/**
 * 原文用 \N 硬换行分成几行、而翻译服务把换行丢掉时，按同样的行数把译文重新断开：优先断在标点或空格之后，
 * 中日韩文字之间在词的边界也可以断；不在样式代码 {…} 里面断，也不拆开一个拉丁单词。找不到合适的位置就保持一行。
 */
function restoreSubtitleBreaks(source: string, translation: string): string {
    const breaks = source.split('\\N').length - 1;
    if (!breaks || /\\[Nn]/u.test(translation)) return translation;
    const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    // 中日韩文字之间只在词的边界断开；环境不提供分词时退回任意两个字之间。
    const words = typeof Intl.Segmenter === 'function' ? new Set(Array.from(new Intl.Segmenter(undefined, {granularity: 'word'}).segment(translation), entry => entry.index)) : undefined;
    // 候选断点：断在这个下标之前；值越小越好（标点后 0，空格处 1，中日韩文字之间 2）。
    const candidates: Array<{index: number; cost: number}> = [];
    let depth = 0;
    for (let index = 1; index < translation.length; index += 1) {
        const previous = translation[index - 1], current = translation[index];
        if (previous === '{') depth += 1;
        if (previous === '}') depth = Math.max(0, depth - 1);
        if (depth || current === '{' && translation.indexOf('}', index) < 0) continue;
        if (/[，。！？；、,.!?;:：]/u.test(previous) && !/[\s，。！？；、,.!?;:：]/u.test(current)) candidates.push({index, cost: 0});
        else if (/\s/u.test(previous) && !/\s/u.test(current)) candidates.push({index, cost: 1});
        else if (wide.test(previous) && wide.test(current) && (words?.has(index) ?? true)) candidates.push({index, cost: 2});
    }
    const chosen: number[] = [];
    for (let line = 1; line <= breaks; line += 1) {
        const target = translation.length * line / (breaks + 1), floor = chosen.at(-1) ?? 0;
        // 偏离理想位置越远越差；标点和空格可以多偏离几个字。
        const best = candidates.filter(candidate => candidate.index > floor)
            .sort((left, right) => Math.abs(left.index - target) + left.cost * 2 - (Math.abs(right.index - target) + right.cost * 2))[0];
        if (!best) return translation;
        chosen.push(best.index);
    }
    return chosen.reduceRight((text, index) => `${text.slice(0, index).trimEnd()}\\N${text.slice(index)}`, translation);
}

/**
 * 有的翻译服务把字幕里的样式标签改写后再返回：转成实体（&lt;i&gt; … &lt;/i&gt;），或换成括号（(i) … (/i)、（i）…（/i））。
 * 原文里确实有同名标签时还原成标签，并去掉服务加在标签内侧的空格；括号写法还要求译文里同时有它的闭合形式，
 * 原文没有的写法不动，避免把正文里的“&lt;”或“(a)”误当成标签。
 */
export function restoreSubtitleTags(source: string, translation: string): string {
    if (!/&lt;|[(（＜]\s*\/?\s*[a-z]/iu.test(translation)) return translation;
    const names = new Set(Array.from(source.matchAll(/<\s*\/?\s*([a-z][\w.]*)/giu), match => match[1].toLowerCase()));
    const closed = new Set(Array.from(translation.matchAll(/[(（＜]\s*[/／]\s*([a-z][\w.]*)\s*[)）＞]/giu), match => match[1].toLowerCase()));
    return translation.replace(/(\s?)(&lt;|[(（＜])\s*([\/／]?)\s*([a-z][\w.]*)([^&<>()（）＜＞]*?)\s*(?:&gt;|[)）＞])(\s?)/giu,
        (whole, before: string, open: string, slash: string, name: string, rest: string, after: string) =>
            names.has(name.toLowerCase()) && (open === '&lt;' || closed.has(name.toLowerCase().split('.')[0])) ? `${slash ? '' : before}<${slash ? '/' : ''}${name}${rest}>${slash ? after : ''}` : whole);
}

function preserveSubtitleMarkup(source: string, received: string): string {
    const translation = restoreSubtitleTags(source, received);
    const assPrefix = source.match(/^(?:\{[^}]*\})+/u)?.[0];
    if (assPrefix && !translation.startsWith(assPrefix)) return restoreSubtitleBreaks(source, `${assPrefix}${translation}`);

    const htmlOpen = source.match(/^(?:<([a-z][a-z0-9-]*)\b[^>]*>)+/iu)?.[0];
    const htmlClose = source.match(/(?:<\/([a-z][a-z0-9-]*)>)+(?=\s|$)/iu)?.[0];
    if (htmlOpen && htmlClose && !translation.includes(htmlOpen)) {
        return `${htmlOpen}${translation}${htmlClose}`;
    }
    return restoreSubtitleBreaks(source, translation);
}

export function formatSubtitleExport(format: DocumentFormat, source: string, received: string): string {
    const styled = preserveSubtitleMarkup(source, received);
    if (format === 'ass') return styled.replace(/\r\n?|\n/gu, '\\N');
    // 空行会结束 SRT/VTT cue；WebVTT 也禁止时间箭头出现在任何 cue 文本行内。
    return styled.split(/\r\n?|\n/u).filter(line => line.trim()).map(line => {
        if (format === 'vtt') return line.replaceAll('-->', '--&gt;');
        return TIMED_SUBTITLE_PATTERN.test(line) ? line.replace('-->', '→') : line;
    }).join('\n');
}

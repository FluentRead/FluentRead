/**
 * @file src/core/tts/speechProgress.ts
 * 文件职责：把真实音频播放位置和可用句段时间映射成安全的跟读文字范围。
 * 主要内容：校验跨上下文句段、进度和媒体时钟，保留原始字符索引；统一完整词边界与稳定文字片段，没有词时间戳时按句段时长估算；允许调用方复用同一文本的分词，避免每个媒体事件重复正则扫描；跳转按实际音频时间限制在首尾范围内。
 * 模块边界：纯计算，不操作 DOM、不生成音频、不推断墙钟播放进度。
 */
export interface SpeechCue {startChar: number; endChar: number; startTime: number; endTime: number}
export interface SpeechProgress {start: number; end: number; fraction: number; estimated: boolean}
export interface SpeechPlaybackPosition {currentTime: number; duration: number}
export interface SpeechTextToken {text: string; start: number; end: number; word: boolean}

/** 连续覆盖原文；空白、标点和 emoji 不参与高亮，英文缩写保持完整。 */
export function speechTextTokens(text: string): SpeechTextToken[] {
    const tokens: SpeechTextToken[] = [];
    let cursor = 0;
    for (const match of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{P}\p{S}\p{C}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+(?:['’][^\s\p{P}\p{S}\p{C}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+)*/gu)) {
        if (match.index > cursor) tokens.push({text: text.slice(cursor, match.index), start: cursor, end: match.index, word: false});
        cursor = match.index + match[0].length;
        tokens.push({text: match[0], start: match.index, end: cursor, word: true});
    }
    if (cursor < text.length) tokens.push({text: text.slice(cursor), start: cursor, end: text.length, word: false});
    return tokens;
}

export function parseSpeechPlaybackPosition(value: unknown): SpeechPlaybackPosition | null {
    if (!value || typeof value !== 'object') return null;
    const {currentTime, duration} = value as SpeechPlaybackPosition;
    if (!Number.isFinite(currentTime) || currentTime < 0 || !Number.isFinite(duration) || duration <= 0) return null;
    return {currentTime: Math.min(currentTime, duration), duration};
}

export function seekSpeechTime(currentTime: number, duration: number, offsetSeconds: number): number | null {
    const position = parseSpeechPlaybackPosition({currentTime, duration});
    if (!position || !Number.isFinite(offsetSeconds)) return null;
    return Math.max(0, Math.min(duration, position.currentTime + offsetSeconds));
}

export function parseSpeechCues(value: unknown): SpeechCue[] {
    if (!Array.isArray(value) || value.length > 2048) return [];
    let previousChar = 0, previousTime = 0;
    const cues: SpeechCue[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') return [];
        const {startChar, endChar, startTime, endTime} = item;
        if (![startChar,endChar].every(Number.isSafeInteger) || startChar < previousChar || endChar <= startChar
            || ![startTime,endTime].every(Number.isFinite) || startTime < previousTime || endTime <= startTime) return [];
        cues.push({startChar,endChar,startTime,endTime}); previousChar=endChar; previousTime=endTime;
    }
    return cues;
}

export function parseSpeechProgress(value: unknown): SpeechProgress | null {
    if (!value || typeof value !== 'object') return null;
    const p = value as SpeechProgress;
    if (!Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end) || p.start < 0 || p.end <= p.start
        || !Number.isFinite(p.fraction) || p.fraction < 0 || p.fraction > 1 || typeof p.estimated !== 'boolean') return null;
    return {start:p.start,end:p.end,fraction:p.fraction,estimated:p.estimated};
}

export function audioSpeechProgress(text: string, time: number, duration: number, cues: readonly SpeechCue[] = [], tokens?: readonly SpeechTextToken[]): SpeechProgress | null {
    if (!text || !Number.isFinite(time) || !Number.isFinite(duration) || time < 0 || duration <= 0) return null;
    // 句段间隙保持上一个句段，结束后保持最后一个词，避免进度跳回整篇文字。
    const cue = cues.findLast(c => time >= c.startTime) ?? cues[0];
    const start = cue?.startChar ?? 0, end = Math.min(text.length, cue?.endChar ?? text.length);
    const begin = cue?.startTime ?? 0, finish = cue?.endTime ?? duration;
    if (start >= end) return null;
    const fraction = Math.min(1,Math.max(0,(time-begin)/(finish-begin)));
    const reached = start + (end-start)*fraction;
    // 汉字按字推进，其他文字按词推进；标点与空白保持原样。时间仍是估算，不能当作词时间戳。
    const words = (tokens ?? speechTextTokens(text)).filter(token => token.word && token.end > start && token.start < end);
    const word = words.find(w => w.end > reached) ?? words.at(-1);
    if (!word) return {start,end,fraction,estimated:true};
    const wordStart = word.start, wordEnd = word.end;
    return {start:wordStart,end:wordEnd,fraction:Math.min(1,Math.max(0,(reached-wordStart)/(wordEnd-wordStart))),estimated:true};
}

export function boundarySpeechProgress(text: string, start: number, _length: number, tokens?: readonly SpeechTextToken[]): SpeechProgress | null {
    if (!Number.isSafeInteger(start) || start < 0 || start >= text.length) return null;
    // 某些声音只报告词的一部分或整句长度，显示仍锁定 charIndex 所在的完整词。
    const word = (tokens ?? speechTextTokens(text)).find(token => token.word && token.end > start);
    return word ? {start:word.start,end:word.end,fraction:1,estimated:false} : null;
}

/**
 * @file src/features/selection-translation/services/edgeTtsPolicy.ts
 * 文件职责：提供 Edge TTS 与在线多源合成复用的纯策略规则，包括语言归一化、多语种音色候选链、语速格式化、XML 转义 SSML 构建、智能断句分段、音频拼接与 JWT 过期解析。
 * 主要内容：定义字符与分段上限及 22+ 常用语种音色目录，兼容普通话统计别名与无地区语言码的方言偏好回退，导出 formatEdgeTtsRate、edgeTtsVoiceCandidatesForLanguage、buildEdgeTtsSsml、splitEdgeTtsText、splitTtsTextByChars、concatEdgeTtsAudio 与 edgeTtsTokenExpiry。
 * 模块边界：本文件保持纯策略，不发起网络请求、不缓存 token 也不操作浏览器存储或音频播放；edgeTts.ts、youdaoTts.ts 与 googleTts.ts 消费这些规则完成远程合成，调用方负责熔断与错误展示。
 */
import {
    normalizeSelectionTtsRate,
    normalizeSelectionTtsVoiceOrder,
    selectionTtsVoiceLocale,
} from '@/src/core/config/selectionTts';
import {getChineseScript} from '@/src/core/language/chinese';

export const edgeTtsLimits = Object.freeze({
    chunkBytes: 1_800,
    chunks: 8,
    fallbackTokenLifetimeMs: 8 * 60 * 1_000,
});

const VOICE_CANDIDATES_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
    'en-US': ['en-US-AvaMultilingualNeural', 'en-US-AriaNeural', 'en-US-JennyNeural', 'en-US-GuyNeural'],
    'en-GB': ['en-GB-SoniaNeural', 'en-GB-RyanNeural'],
    'en-AU': ['en-AU-NatashaNeural', 'en-AU-WilliamNeural'],
    'zh-CN': ['zh-CN-XiaoxiaoMultilingualNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural'],
    'zh-TW': ['zh-TW-YunJheMultilingualNeural', 'zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural'],
    'zh-HK': ['zh-HK-HiuMaanNeural', 'zh-HK-WanLungNeural'],
    'ja-JP': ['ja-JP-MasaruMultilingualNeural', 'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural'],
    'ko-KR': ['ko-KR-HyunsuMultilingualNeural', 'ko-KR-SunHiNeural', 'ko-KR-InJoonNeural'],
    'fr-FR': ['fr-FR-RemyMultilingualNeural'],
    'de-DE': ['de-DE-FlorianMultilingualNeural', 'de-DE-KatjaNeural'],
    'es-ES': ['es-ES-TristanMultilingualNeural', 'es-ES-ElviraNeural'],
    'es-MX': ['es-MX-DaliaNeural'],
    'it-IT': ['it-IT-AlessioMultilingualNeural', 'it-IT-ElsaNeural'],
    'pt-BR': ['pt-BR-MacerioMultilingualNeural', 'pt-BR-FranciscaNeural'],
    'ru-RU': ['ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural'],
    'ar-SA': ['ar-SA-ZariyahNeural'],
    'hi-IN': ['hi-IN-SwaraNeural'],
    'vi-VN': ['vi-VN-HoaiMyNeural'],
    'th-TH': ['th-TH-PremwadeeNeural'],
    'id-ID': ['id-ID-GadisNeural'],
    'nl-NL': ['nl-NL-ColetteNeural'],
    'pl-PL': ['pl-PL-ZofiaNeural'],
    'tr-TR': ['tr-TR-EmelNeural'],
    'uk-UA': ['uk-UA-PolinaNeural'],
};

const SENTENCE_BOUNDARIES = ['\n', '。', '！', '？', '.', '!', '?'] as const;
const CLAUSE_BOUNDARIES = ['；', '，', ';', ','] as const;

export function normalizeEdgeTtsLanguage(language: string): string {
    const normalized = String(language || '').replace(/_/gu, '-').trim();
    if (!normalized || normalized === 'auto' || normalized === 'detect') return 'en-US';
    const script = getChineseScript(normalized);
    if (script) return script === 'Hans' ? 'zh-CN' : 'zh-TW';
    // 未确定字形的普通话仍能朗读；这一别名不参与翻译语言检测。
    if (['cmn', 'zho', 'chi'].includes(normalized.toLowerCase())) return 'zh-CN';
    if (normalized.toLowerCase() === 'en') return 'en-US';
    return normalized;
}

/** 将倍率语速（0.5~2.0）格式化为 SSML prosody rate 百分比字符串（如 1 -> +0%、1.25 -> +25%）。 */
export function formatEdgeTtsRate(rate?: number): string {
    const normalized = normalizeSelectionTtsRate(rate);
    const percentDelta = Math.round((normalized - 1) * 100);
    return percentDelta >= 0 ? `+${percentDelta}%` : `${percentDelta}%`;
}

/**
 * 用户音色优先，同语言的内置候选随后兜底，并保持稳定顺序与去重。
 * 当调用方仅传入基础语言码（如 en 或 auto，未显式指定地区子标签）且没有精确地区偏好音色时，
 * 允许用户已选的同主语种方言音色（如 en-GB / en-AU）排在自动候选之前。
 */
export function edgeTtsVoiceCandidatesForLanguage(
    language: string,
    preferredVoices: unknown = [],
): string[] {
    const raw = String(language || '').replace(/_/gu, '-').trim();
    const targetLocale = raw.toLowerCase() === 'zh-hk' ? 'zh-HK' : normalizeEdgeTtsLanguage(raw);
    const targetLower = targetLocale.toLowerCase();
    const baseLower = targetLower.split('-')[0];
    const exactAutomatic = Object.entries(VOICE_CANDIDATES_BY_LANGUAGE)
        .find(([locale]) => locale.toLowerCase() === targetLower)?.[1];
    const automatic = exactAutomatic
        || Object.entries(VOICE_CANDIDATES_BY_LANGUAGE)
            .find(([locale]) => locale.toLowerCase().startsWith(`${baseLower}-`))?.[1]
        || [];
    const orderedPreferred = normalizeSelectionTtsVoiceOrder(preferredVoices);
    const exactPreferred = orderedPreferred
        .filter((voice) => selectionTtsVoiceLocale(voice).toLowerCase() === targetLower);
    const hasExplicitSubtag = raw.includes('-');
    const preferred = exactPreferred.length > 0 || hasExplicitSubtag
        ? exactPreferred
        : orderedPreferred.filter((voice) => selectionTtsVoiceLocale(voice).split('-')[0]?.toLowerCase() === baseLower);
    return [...new Set([...preferred, ...automatic])];
}

function escapeXml(text: string): string {
    return text
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&apos;');
}

export function buildEdgeTtsSsml(
    text: string,
    voice: string,
    rate = '+0%',
    pitch = '+0Hz',
    volume = '+0%',
): string {
    const locale = voice.split('-').slice(0, 2).join('-') || 'en-US';
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(locale)}"><voice name="${escapeXml(voice)}"><prosody rate="${escapeXml(rate)}" pitch="${escapeXml(pitch)}" volume="${escapeXml(volume)}">${escapeXml(text.trim())}</prosody></voice></speak>`;
}

function lastIndexOfAny(text: string, needles: readonly string[], fromIndex: number): number {
    let best = -1;
    for (const needle of needles) {
        const index = text.lastIndexOf(needle, fromIndex);
        if (index > best) best = index;
    }
    return best;
}

/** 优先在句末标点断开，其次子句标点，再次空格，保证每段停顿自然。 */
function findPreferredTtsBoundary(text: string, end: number): number {
    const minBoundary = Math.floor(end * 0.6);
    const sentence = lastIndexOfAny(text, SENTENCE_BOUNDARIES, end - 1);
    if (sentence > minBoundary) return sentence + 1;
    const clause = lastIndexOfAny(text, CLAUSE_BOUNDARIES, end - 1);
    if (clause > minBoundary) return clause + 1;
    const space = text.lastIndexOf(' ', end - 1);
    if (space > minBoundary) return space + 1;
    return end;
}

/** 按 UTF-8 字节预算切分，优先在句界、子句或空格处断开。 */
export function splitEdgeTtsText(text: string): string[] {
    const chunks: string[] = [];
    let remaining = text.trim();
    while (remaining) {
        if (chunks.length >= edgeTtsLimits.chunks) throw new Error('Edge TTS text is too long');
        // 只扫描本段预算内的码点，避免反复编码整段余文和逐字符缩短前缀；
        // 码点长度也保证不会把代理对拆到两个 SSML 请求里。
        let end = 0;
        let bytes = 0;
        for (const point of remaining) {
            const code = point.codePointAt(0)!;
            const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
            if (bytes + size > edgeTtsLimits.chunkBytes) break;
            bytes += size;
            end += point.length;
        }
        if (end < remaining.length) {
            end = findPreferredTtsBoundary(remaining, end);
        }
        chunks.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
    }
    return chunks;
}

/** 按字符预算与分段上限智能断句（不拆代理对），供有道与 Google TTS 复用。 */
export function splitTtsTextByChars(
    text: string,
    maxChars: number,
    maxChunks: number,
    createTooLongError: () => Error,
): string[] {
    const chunks: string[] = [];
    let remaining = text.trim();
    while (remaining) {
        if (chunks.length >= maxChunks) throw createTooLongError();
        let end = 0;
        for (const point of remaining) {
            if (end + point.length > maxChars) break;
            end += point.length;
        }
        if (end === 0) end = Array.from(remaining)[0]!.length;
        if (end < remaining.length) {
            end = findPreferredTtsBoundary(remaining, end);
        }
        chunks.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
    }
    return chunks;
}

export function concatEdgeTtsAudio(buffers: readonly ArrayBuffer[]): ArrayBuffer {
    const total = buffers.reduce((size, buffer) => size + buffer.byteLength, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const buffer of buffers) {
        output.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return output.buffer;
}

/** JWT 无法解析或缺少 exp 时使用短生命周期，避免长期复用未知 token。 */
export function edgeTtsTokenExpiry(token: string, now = Date.now()): number {
    const fallback = now + edgeTtsLimits.fallbackTokenLifetimeMs;
    try {
        const payload = token.split('.')[1];
        if (!payload) return fallback;
        const padded = payload
            .replace(/-/gu, '+')
            .replace(/_/gu, '/')
            .padEnd(Math.ceil(payload.length / 4) * 4, '=');
        const decoded = JSON.parse(atob(padded)) as {exp?: unknown};
        const expiresAt = typeof decoded.exp === 'number' ? decoded.exp * 1_000 : NaN;
        return Number.isFinite(expiresAt) ? expiresAt : fallback;
    } catch {
        return fallback;
    }
}

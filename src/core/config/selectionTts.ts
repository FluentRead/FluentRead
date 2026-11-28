/**
 * @file src/core/config/selectionTts.ts
 *
 * 文件职责：维护划词朗读可选语音、多源在线合成顺序、语速及 OpenAI 兼容语音的领域目录与纯归一化规则。
 * 主要内容：定义 SelectionTtsVoiceOption、SELECTION_TTS_VOICE_OPTIONS（覆盖 22+ 常用语种）、在线多源配置、语速档位与归一化、OpenAI TTS 模型/音色目录、分组视图及试听样例文本。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

/**
 * 用户可选的划词朗读音色。顺序由多选控件保留；Edge TTS 当前音色失效
 * 时，后台会按该顺序继续尝试，同一语言没有可用自定义音色时再使用内置候选。
 */
export interface SelectionTtsVoiceOption {
    readonly value: string;
    readonly label: string;
    readonly locale: string;
    readonly gender: 'Female' | 'Male';
    readonly multilingual?: boolean;
}

export type SelectionTtsOnlineSourceId = 'edge' | 'youdao' | 'google' | 'openai';

export interface SelectionTtsOnlineSourceOption {
    readonly value: SelectionTtsOnlineSourceId;
    readonly label: string;
    readonly description: string;
    readonly requiresApiKey?: boolean;
}

export const SELECTION_TTS_ONLINE_SOURCE_OPTIONS: readonly SelectionTtsOnlineSourceOption[] = [
    {
        value: 'edge',
        label: 'Edge 神经语音',
        description: '免费、多语言自然音色，支持 SSML 语速控制，无需 API Key。',
    },
    {
        value: 'youdao',
        label: '有道发音',
        description: '响应极快，适合英语美式/英式、日语、韩语、法语和中文短句与单词。',
    },
    {
        value: 'google',
        label: 'Google 朗读',
        description: '语种覆盖最广，自动分段合成，适合作为免费兜底来源。',
    },
    {
        value: 'openai',
        label: 'OpenAI / 兼容 TTS',
        description: '复用已配置的 OpenAI 密钥与代理（支持兼容接口或本地自托管 /v1/audio/speech）。',
        requiresApiKey: true,
    },
] as const;

export const DEFAULT_SELECTION_TTS_ONLINE_SOURCES: readonly SelectionTtsOnlineSourceId[] = [
    'edge',
    'youdao',
    'google',
] as const;

const KNOWN_ONLINE_SOURCES = new Set<SelectionTtsOnlineSourceId>(
    SELECTION_TTS_ONLINE_SOURCE_OPTIONS.map((item) => item.value),
);

export const SELECTION_TTS_RATE_LIMITS = Object.freeze({
    min: 0.5,
    max: 2.0,
    step: 0.05,
});

export const DEFAULT_SELECTION_TTS_RATE = 1;

export const SELECTION_TTS_RATE_PRESETS: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export const SELECTION_TTS_OPENAI_MODEL_OPTIONS = [
    {value: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts'},
    {value: 'tts-1', label: 'tts-1'},
    {value: 'tts-1-hd', label: 'tts-1-hd'},
] as const;

export type SelectionTtsOpenAiModel = typeof SELECTION_TTS_OPENAI_MODEL_OPTIONS[number]['value'];
export const DEFAULT_SELECTION_TTS_OPENAI_MODEL: SelectionTtsOpenAiModel = 'gpt-4o-mini-tts';

export const SELECTION_TTS_OPENAI_VOICE_OPTIONS = [
    {value: 'alloy', label: 'Alloy'},
    {value: 'ash', label: 'Ash'},
    {value: 'coral', label: 'Coral'},
    {value: 'echo', label: 'Echo'},
    {value: 'fable', label: 'Fable'},
    {value: 'nova', label: 'Nova'},
    {value: 'onyx', label: 'Onyx'},
    {value: 'sage', label: 'Sage'},
    {value: 'shimmer', label: 'Shimmer'},
] as const;

export type SelectionTtsOpenAiVoice = typeof SELECTION_TTS_OPENAI_VOICE_OPTIONS[number]['value'];
export const DEFAULT_SELECTION_TTS_OPENAI_VOICE: SelectionTtsOpenAiVoice = 'alloy';

export const SELECTION_TTS_VOICE_OPTIONS: readonly SelectionTtsVoiceOption[] = [
    {value: 'en-US-AvaMultilingualNeural', label: 'Ava', locale: 'en-US', gender: 'Female', multilingual: true},
    {value: 'en-US-AndrewMultilingualNeural', label: 'Andrew', locale: 'en-US', gender: 'Male', multilingual: true},
    {value: 'en-US-EmmaMultilingualNeural', label: 'Emma', locale: 'en-US', gender: 'Female', multilingual: true},
    {value: 'en-US-AriaNeural', label: 'Aria', locale: 'en-US', gender: 'Female'},
    {value: 'en-US-JennyNeural', label: 'Jenny', locale: 'en-US', gender: 'Female'},
    {value: 'en-US-GuyNeural', label: 'Guy', locale: 'en-US', gender: 'Male'},
    {value: 'en-GB-SoniaNeural', label: 'Sonia', locale: 'en-GB', gender: 'Female'},
    {value: 'en-GB-RyanNeural', label: 'Ryan', locale: 'en-GB', gender: 'Male'},
    {value: 'en-AU-NatashaNeural', label: 'Natasha', locale: 'en-AU', gender: 'Female'},
    {value: 'en-AU-WilliamNeural', label: 'William', locale: 'en-AU', gender: 'Male'},
    {value: 'zh-CN-XiaoxiaoMultilingualNeural', label: '晓晓', locale: 'zh-CN', gender: 'Female', multilingual: true},
    {value: 'zh-CN-XiaoyiNeural', label: '晓伊', locale: 'zh-CN', gender: 'Female'},
    {value: 'zh-CN-YunxiNeural', label: '云希', locale: 'zh-CN', gender: 'Male'},
    {value: 'zh-CN-YunyangNeural', label: '云扬', locale: 'zh-CN', gender: 'Male'},
    {value: 'zh-TW-YunJheMultilingualNeural', label: '雲哲', locale: 'zh-TW', gender: 'Male', multilingual: true},
    {value: 'zh-TW-HsiaoChenNeural', label: '曉臻', locale: 'zh-TW', gender: 'Female'},
    {value: 'zh-TW-HsiaoYuNeural', label: '曉雨', locale: 'zh-TW', gender: 'Female'},
    {value: 'zh-HK-HiuMaanNeural', label: '曉曼', locale: 'zh-HK', gender: 'Female'},
    {value: 'zh-HK-WanLungNeural', label: '雲龍', locale: 'zh-HK', gender: 'Male'},
    {value: 'ja-JP-MasaruMultilingualNeural', label: 'Masaru', locale: 'ja-JP', gender: 'Male', multilingual: true},
    {value: 'ja-JP-NanamiNeural', label: 'Nanami', locale: 'ja-JP', gender: 'Female'},
    {value: 'ja-JP-KeitaNeural', label: 'Keita', locale: 'ja-JP', gender: 'Male'},
    {value: 'ko-KR-HyunsuMultilingualNeural', label: 'Hyunsu', locale: 'ko-KR', gender: 'Male', multilingual: true},
    {value: 'ko-KR-SunHiNeural', label: 'SunHi', locale: 'ko-KR', gender: 'Female'},
    {value: 'ko-KR-InJoonNeural', label: 'InJoon', locale: 'ko-KR', gender: 'Male'},
    {value: 'fr-FR-RemyMultilingualNeural', label: 'Rémy', locale: 'fr-FR', gender: 'Male', multilingual: true},
    {value: 'fr-FR-DeniseNeural', label: 'Denise', locale: 'fr-FR', gender: 'Female'},
    {value: 'de-DE-FlorianMultilingualNeural', label: 'Florian', locale: 'de-DE', gender: 'Male', multilingual: true},
    {value: 'de-DE-KatjaNeural', label: 'Katja', locale: 'de-DE', gender: 'Female'},
    {value: 'es-ES-TristanMultilingualNeural', label: 'Tristan', locale: 'es-ES', gender: 'Male', multilingual: true},
    {value: 'es-ES-ElviraNeural', label: 'Elvira', locale: 'es-ES', gender: 'Female'},
    {value: 'es-MX-DaliaNeural', label: 'Dalia', locale: 'es-MX', gender: 'Female'},
    {value: 'it-IT-AlessioMultilingualNeural', label: 'Alessio', locale: 'it-IT', gender: 'Male', multilingual: true},
    {value: 'it-IT-ElsaNeural', label: 'Elsa', locale: 'it-IT', gender: 'Female'},
    {value: 'pt-BR-MacerioMultilingualNeural', label: 'Macerio', locale: 'pt-BR', gender: 'Male', multilingual: true},
    {value: 'pt-BR-FranciscaNeural', label: 'Francisca', locale: 'pt-BR', gender: 'Female'},
    {value: 'ru-RU-SvetlanaNeural', label: 'Svetlana', locale: 'ru-RU', gender: 'Female'},
    {value: 'ru-RU-DmitryNeural', label: 'Dmitry', locale: 'ru-RU', gender: 'Male'},
    {value: 'ar-SA-ZariyahNeural', label: 'Zariyah', locale: 'ar-SA', gender: 'Female'},
    {value: 'hi-IN-SwaraNeural', label: 'Swara', locale: 'hi-IN', gender: 'Female'},
    {value: 'vi-VN-HoaiMyNeural', label: 'HoaiMy', locale: 'vi-VN', gender: 'Female'},
    {value: 'th-TH-PremwadeeNeural', label: 'Premwadee', locale: 'th-TH', gender: 'Female'},
    {value: 'id-ID-GadisNeural', label: 'Gadis', locale: 'id-ID', gender: 'Female'},
    {value: 'nl-NL-ColetteNeural', label: 'Colette', locale: 'nl-NL', gender: 'Female'},
    {value: 'pl-PL-ZofiaNeural', label: 'Zofia', locale: 'pl-PL', gender: 'Female'},
    {value: 'tr-TR-EmelNeural', label: 'Emel', locale: 'tr-TR', gender: 'Female'},
    {value: 'uk-UA-PolinaNeural', label: 'Polina', locale: 'uk-UA', gender: 'Female'},
] as const;

const KNOWN_SELECTION_TTS_VOICES = new Set(SELECTION_TTS_VOICE_OPTIONS.map((option) => option.value));

export function normalizeSelectionTtsVoiceOrder(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const result: string[] = [];
    for (const candidate of value) {
        if (typeof candidate !== 'string' || !KNOWN_SELECTION_TTS_VOICES.has(candidate) || result.includes(candidate)) continue;
        result.push(candidate);
    }
    return result;
}

export function selectionTtsVoiceLocale(voice: string): string {
    return voice.split('-').slice(0, 2).join('-');
}

export function normalizeSelectionTtsRate(value: unknown): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) return DEFAULT_SELECTION_TTS_RATE;
    const clamped = Math.min(SELECTION_TTS_RATE_LIMITS.max, Math.max(SELECTION_TTS_RATE_LIMITS.min, parsed));
    return Math.round(clamped * 100) / 100;
}

/** 在快捷倍速档位间循环切换（供播放栏单键变速）。 */
export function nextSelectionTtsRatePreset(currentRate: unknown): number {
    const normalized = normalizeSelectionTtsRate(currentRate);
    const next = SELECTION_TTS_RATE_PRESETS.find((preset) => preset > normalized + 0.01);
    return next ?? SELECTION_TTS_RATE_PRESETS[0]!;
}

export function normalizeSelectionTtsOnlineSources(value: unknown): SelectionTtsOnlineSourceId[] {
    if (!Array.isArray(value)) return [...DEFAULT_SELECTION_TTS_ONLINE_SOURCES];
    const result: SelectionTtsOnlineSourceId[] = [];
    for (const item of value) {
        if (typeof item !== 'string' || !KNOWN_ONLINE_SOURCES.has(item as SelectionTtsOnlineSourceId)) continue;
        const source = item as SelectionTtsOnlineSourceId;
        if (!result.includes(source)) result.push(source);
    }
    return result.length > 0 ? result : [...DEFAULT_SELECTION_TTS_ONLINE_SOURCES];
}

export function normalizeSelectionTtsOpenAiModel(value: unknown): SelectionTtsOpenAiModel {
    return SELECTION_TTS_OPENAI_MODEL_OPTIONS.some((item) => item.value === value)
        ? value as SelectionTtsOpenAiModel
        : DEFAULT_SELECTION_TTS_OPENAI_MODEL;
}

export function normalizeSelectionTtsOpenAiVoice(value: unknown): SelectionTtsOpenAiVoice {
    return SELECTION_TTS_OPENAI_VOICE_OPTIONS.some((item) => item.value === value)
        ? value as SelectionTtsOpenAiVoice
        : DEFAULT_SELECTION_TTS_OPENAI_VOICE;
}

const PREVIEW_TEXT_BY_PREFIX: Readonly<Record<string, string>> = {
    'zh-tw': '你好，這是流暢閱讀的語音試聽。',
    'zh-hk': '你好，呢個係流暢閱讀嘅語音試聽。',
    'zh': '你好，这是流畅阅读的语音试听。',
    'en': 'Hello, this is a voice preview from FluentRead.',
    'ja': 'こんにちは、FluentReadの音声プレビューです。',
    'ko': '안녕하세요, FluentRead 음성 미리 듣기입니다.',
    'fr': 'Bonjour, ceci est un aperçu vocal de FluentRead.',
    'de': 'Hallo, dies ist eine Sprachvorschau von FluentRead.',
    'es': 'Hola, esta es una vista previa de voz de FluentRead.',
    'it': 'Ciao, questa è un’anteprima vocale di FluentRead.',
    'pt': 'Olá, esta é uma prévia de voz do FluentRead.',
    'ru': 'Здравствуйте, это предпросмотр голоса FluentRead.',
    'ar': 'مرحبًا، هذه معاينة صوتية من FluentRead.',
    'hi': 'नमस्ते, यह FluentRead का वॉइस प्रीव्यू है।',
    'vi': 'Xin chào, đây là bản nghe thử giọng nói của FluentRead.',
    'th': 'สวัสดี นี่คือตัวอย่างเสียงจาก FluentRead',
    'id': 'Halo, ini adalah pratinjau suara dari FluentRead.',
    'nl': 'Hallo, dit is een stemvoorbeeld van FluentRead.',
    'pl': 'Cześć, to jest podgląd głosu z FluentRead.',
    'tr': 'Merhaba, bu FluentRead ses önizlemesidir.',
    'uk': 'Привіт, це попередній перегляд голосу FluentRead.',
};

/** 按语种或地区码返回简短自然的语音试听文本。 */
export function selectionTtsPreviewText(locale: string): string {
    const normalized = String(locale || '').trim().replace(/_/gu, '-').toLowerCase();
    if (normalized && Object.hasOwn(PREVIEW_TEXT_BY_PREFIX, normalized)) {
        return PREVIEW_TEXT_BY_PREFIX[normalized]!;
    }
    const base = normalized.split('-')[0] || 'en';
    return Object.hasOwn(PREVIEW_TEXT_BY_PREFIX, base)
        ? PREVIEW_TEXT_BY_PREFIX[base]!
        : PREVIEW_TEXT_BY_PREFIX.en!;
}

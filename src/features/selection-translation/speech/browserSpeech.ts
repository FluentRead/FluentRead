/**
 * @file src/features/selection-translation/speech/browserSpeech.ts
 * 文件职责：提供浏览器原生 Web Speech（speechSynthesis）兜底朗读的纯选声策略、冷启动异步声音列表等待与单词发音语种推断。
 * 主要内容：导出 selectBrowserSpeechVoice（按精确地区与自然神经音色启发式排序）、loadBrowserSpeechVoices（解决 Chromium 冷启动 getVoices 为空竞态并确保清理监听与定时器）与 inferWordSpeechLanguage（区分英/美音标标签及常见文字脚本）。
 * 模块边界：本文件仅封装浏览器语音选择与只读查询辅助，不主动调用 speechSynthesis.speak、不发起网络请求也不读写扩展配置；由划词弹窗与词书页面在回退到浏览器语音时按需调用。
 */
import {normalizeSpeechLanguage} from '../core';

const PREFERRED_VOICE_NAME_PATTERN = /\b(?:natural|neural|online|enhanced|premium)\b|\b(?:ava|aria|jenny|andrew|emma|guy|sonia|ryan|samantha|daniel|karen|moira|tessa|serena|alex)\b|xiaoxiao|xiaoyi|yunxi|ting-?ting|mei-?jia|sin-?ji|nanami|kyoko|yuna|sunhi|google/iu;
const NEURAL_PRIORITY_PATTERN = /\b(?:natural|neural|online)\b|google/iu;
const UK_LABEL_PATTERN = /\b(?:uk|gb|brit(?:ish)?)\b|英/iu;
const US_LABEL_PATTERN = /\b(?:us|am(?:erican)?)\b|美/iu;

export type SpeechSynthesisVoiceSource = Pick<
    SpeechSynthesis,
    'getVoices' | 'addEventListener' | 'removeEventListener'
>;

function normalizeVoiceLang(lang: string): string {
    return lang.replace(/_/gu, '-').trim().toLowerCase();
}

function scoreBrowserSpeechVoice(
    voice: SpeechSynthesisVoice,
    targetLocaleLower: string,
    targetBaseLower: string,
): number {
    const voiceLang = normalizeVoiceLang(voice.lang);
    if (!voiceLang) return 0;

    const voiceBase = voiceLang.split('-')[0]!;
    const isExactLocale = voiceLang === targetLocaleLower;
    const isSameBase = voiceBase === targetBaseLower;
    if (!isExactLocale && !isSameBase) return 0;

    const name = voice.name;
    const isPreferredName = PREFERRED_VOICE_NAME_PATTERN.test(name);
    const isNeural = NEURAL_PRIORITY_PATTERN.test(name);

    let tierScore = 0;
    if (isExactLocale && isPreferredName) tierScore = 400;
    else if (isExactLocale) tierScore = 300;
    else if (isSameBase && isPreferredName) tierScore = 200;
    else tierScore = 100;

    return tierScore + (isNeural ? 20 : 0) + (voice.default ? 5 : 0);
}

/** 按精确地区与自然/神经音色启发式从系统声音列表中选出最佳浏览器语音。 */
export function selectBrowserSpeechVoice(
    voices: readonly SpeechSynthesisVoice[],
    language: string,
): SpeechSynthesisVoice | undefined {
    if (voices.length === 0) return undefined;
    const targetLocaleLower = normalizeVoiceLang(normalizeSpeechLanguage(language, 'en-US'));
    const targetBaseLower = targetLocaleLower.split('-')[0]!;

    let bestVoice: SpeechSynthesisVoice | undefined;
    let bestScore = 0;
    for (const voice of voices) {
        const score = scoreBrowserSpeechVoice(voice, targetLocaleLower, targetBaseLower);
        if (score > bestScore) {
            bestScore = score;
            bestVoice = voice;
        }
    }
    return bestVoice;
}

/**
 * 读取浏览器语音列表；当 Chromium 冷启动首次返回空数组时，监听一次 voiceschanged 并设置上限超时，
 * 无论何种路径结束都会清理监听器与计时器。
 */
export function loadBrowserSpeechVoices(
    synth: SpeechSynthesisVoiceSource | null | undefined,
    timeoutMs = 400,
): Promise<SpeechSynthesisVoice[]> {
    if (!synth || typeof synth.getVoices !== 'function') return Promise.resolve([]);
    const initial = synth.getVoices();
    if (initial.length > 0) return Promise.resolve([...initial]);
    if (typeof synth.addEventListener !== 'function' || timeoutMs <= 0) {
        return Promise.resolve([]);
    }

    return new Promise<SpeechSynthesisVoice[]>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            synth.removeEventListener('voiceschanged', onVoicesChanged);
            resolve([...synth.getVoices()]);
        };
        const onVoicesChanged = () => {
            finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        synth.addEventListener('voiceschanged', onVoicesChanged, {once: true});
    });
}

/** 根据音标标签（英/UK、美/US）、已检测语种或词形脚本推断单词朗读语言码。 */
export function inferWordSpeechLanguage(
    word: string,
    pronunciationLabel?: string,
    detectedLanguage?: string,
): string {
    const label = String(pronunciationLabel ?? '').trim();
    if (label) {
        if (UK_LABEL_PATTERN.test(label)) return 'en-GB';
        if (US_LABEL_PATTERN.test(label)) return 'en-US';
    }

    const detected = String(detectedLanguage ?? '').trim();
    const detectedLower = detected.toLowerCase();
    if (detected && !['auto', 'detect', 'unknown', 'und'].includes(detectedLower)) {
        return normalizeSpeechLanguage(detected, 'en-US');
    }

    const text = word.trim();
    if (/[\u3040-\u30ff]/u.test(text)) return 'ja-JP';
    if (/[\uac00-\ud7af\u1100-\u11ff]/u.test(text)) return 'ko-KR';
    if (/[\u4e00-\u9fff]/u.test(text)) return 'zh-CN';
    if (/[\u0400-\u04ff]/u.test(text)) return 'ru-RU';
    if (/[\u0600-\u06ff]/u.test(text)) return 'ar-SA';
    if (/[\u0900-\u097f]/u.test(text)) return 'hi-IN';
    if (/[\u0e00-\u0e7f]/u.test(text)) return 'th-TH';
    return 'en-US';
}

/**
 * @file src/core/language/localTranslation.ts
 *
 * 文件职责：把指定或自动识别的翻译语言解析为本地模型 tokenizer 接受的语言码。
 * 主要内容：复用统一文本识别链，按目录声明的 OPUS 语言对与混元 Hy-MT2（38 种）/Hy-MT3（102 种含西里尔脚本变体）语言集合解析别名、简繁映射与不支持语言错误；自动识别只在调用方没有指定语言时运行。
 * 模块边界：本文件属于 core 纯语言规则，不读配置存储、不访问页面或模型运行时；依赖静态模型目录，配置目录不得反向依赖本模块或文本检测。
 */

import {detectlang} from './detect';
import {normalizeChineseLanguageCode} from './chinese';
import {normalizeDetectedLanguageCode} from './codes';
import {
    getLocalTranslationModel,
    normalizeLocalTranslationModel,
    LOCAL_TRANSLATION_MODEL_IDS,
    HUNYUAN2_SUPPORTED_LANGUAGES,
    HUNYUAN_LANGUAGE_NAMES,
    type LocalTranslationModelId,
} from '@/src/core/config/localTranslation';

// 本地模型词表沿用 ISO 639-1 旧写法：挪威语为 no，他加禄语/菲律宾语为 tl。
const LOCAL_MODEL_BASE_ALIASES: Readonly<Record<string, string>> = {nb: 'no', fil: 'tl'};

// Hy-MT3 单独区分西里尔字母书写体的哈萨克语与蒙古语。
const HUNYUAN3_SCRIPTED_LANGUAGES: Readonly<Record<string, string>> = {
    'kk-cyrl': 'kk-Cyrl',
    'mn-cyrl': 'mn-Cyrl',
};

const M2M100_LANGUAGE_CODES: Readonly<Record<string, string>> = {
    af: 'af', ar: 'ar', bg: 'bg', bn: 'bn', cs: 'cs', da: 'da', de: 'de', el: 'el',
    en: 'en', es: 'es', et: 'et', fa: 'fa', fi: 'fi', fr: 'fr', he: 'he', hi: 'hi',
    hr: 'hr', hu: 'hu', id: 'id', it: 'it', ja: 'ja', ko: 'ko', kn: 'kn', lt: 'lt',
    lv: 'lv', ml: 'ml', mr: 'mr', ms: 'ms', nl: 'nl', no: 'no', pa: 'pa', pl: 'pl',
    pt: 'pt', ro: 'ro', ru: 'ru', si: 'si', sk: 'sk', sl: 'sl', sr: 'sr', sv: 'sv',
    sw: 'sw', ta: 'ta', te: 'te', th: 'th', tr: 'tr', uk: 'uk', ur: 'ur', vi: 'vi',
    zh: 'zh',
};

const NLLB_LANGUAGE_CODES: Readonly<Record<string, string>> = {
    af: 'afr_Latn', ar: 'arb_Arab', bg: 'bul_Cyrl', bn: 'ben_Beng', cs: 'ces_Latn',
    da: 'dan_Latn', de: 'deu_Latn', el: 'ell_Grek', en: 'eng_Latn', es: 'spa_Latn',
    et: 'est_Latn', fa: 'pes_Arab', fi: 'fin_Latn', fr: 'fra_Latn', he: 'heb_Hebr',
    hi: 'hin_Deva', hr: 'hrv_Latn', hu: 'hun_Latn', id: 'ind_Latn', it: 'ita_Latn',
    ja: 'jpn_Jpan', kn: 'kan_Knda', ko: 'kor_Hang', lt: 'lit_Latn', lv: 'lvs_Latn',
    ml: 'mal_Mlym', mr: 'mar_Deva', ms: 'zsm_Latn', nl: 'nld_Latn', no: 'nno_Latn',
    pa: 'pan_Guru', pl: 'pol_Latn', pt: 'por_Latn', ro: 'ron_Latn', ru: 'rus_Cyrl',
    si: 'sin_Sinh', sk: 'slk_Latn', sl: 'slv_Latn', sr: 'srp_Cyrl', sv: 'swe_Latn',
    sw: 'swh_Latn', ta: 'tam_Taml', te: 'tel_Telu', th: 'tha_Thai', tr: 'tur_Latn',
    uk: 'ukr_Cyrl', ur: 'urd_Arab', vi: 'vie_Latn',
    'zh-Hans': 'zho_Hans', 'zh-Hant': 'zho_Hant', zh: 'zho_Hans',
};

function resolveHunyuan3ScriptedLanguage(normalized: string): string | undefined {
    const parts = normalized.replace(/_/gu, '-').toLowerCase().split('-');
    return HUNYUAN3_SCRIPTED_LANGUAGES[`${parts[0]}-${parts[1]}`];
}

function languageBase(value: string): string {
    const canonical = normalizeDetectedLanguageCode(value) || value.trim().toLowerCase();
    const base = canonical.split('-')[0]!;
    return LOCAL_MODEL_BASE_ALIASES[base] ?? base;
}

function modelFamily(model: LocalTranslationModelId): 'm2m100' | 'nllb' {
    return model === LOCAL_TRANSLATION_MODEL_IDS.nllb ? 'nllb' : 'm2m100';
}

/** 把 FluentRead 的语言码转换为所选模型 tokenizer 接受的语言码。 */
export function resolveLocalTranslationLanguageCode(
    modelValue: unknown,
    languageValue: unknown,
    textForAutoDetection = '',
): string {
    const model = normalizeLocalTranslationModel(modelValue);
    const raw = typeof languageValue === 'string' ? languageValue.trim() : '';
    let normalized = raw && raw.toLowerCase() !== 'auto'
        ? normalizeChineseLanguageCode(raw)
        : '';
    if (!normalized) {
        if (!textForAutoDetection.trim()) throw new Error('本地模型无法自动识别空文本，请指定源语言');
        normalized = detectlang(textForAutoDetection);
    }

    const base = languageBase(normalized);
    const modelMeta = getLocalTranslationModel(model);
    if (modelMeta.opusLanguages) {
        if (modelMeta.opusLanguages.includes(base)) return base;
        throw new Error('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
    }
    if (modelMeta.engine === 'hunyuan') {
        if (normalized === 'zh-Hant') return 'zh-Hant';
        if (model === LOCAL_TRANSLATION_MODEL_IDS.hunyuan3) {
            const scripted = resolveHunyuan3ScriptedLanguage(normalized);
            if (scripted) return scripted;
            if (HUNYUAN_LANGUAGE_NAMES[base]) return base;
        } else if (HUNYUAN2_SUPPORTED_LANGUAGES.has(base)) {
            return base;
        }
        throw new Error('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
    }
    if (modelFamily(model) === 'nllb') {
        const nllbKey = normalized === 'zh-Hans' || normalized === 'zh-Hant' ? normalized : base;
        const code = NLLB_LANGUAGE_CODES[nllbKey];
        if (code) return code;
    } else {
        const code = M2M100_LANGUAGE_CODES[base];
        if (code) return code;
    }

    throw new Error(`本地模型暂不支持语言：${raw || normalized}`);
}

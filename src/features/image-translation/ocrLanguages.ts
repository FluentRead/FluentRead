/**
 * @file src/features/image-translation/ocrLanguages.ts
 * 文件职责：定义图片 OCR 支持的语言包目录、推荐组合和持久化键，并把用户源语言映射为 Tesseract 实际需要加载的语言代码。
 * 主要内容：维护源语言元数据、推荐简繁中英日集合、按需下载与竖排模型展开。单图与漫画明确选择标准模型字表之外的俄语、韩语、阿拉伯语或希伯来语时使用对应的 Tesseract 包。
 * 模块边界：此文件只描述受支持语言与规范化规则，不下载资源或访问 storage；下载由后台 Offscreen OCR runtime 执行，状态持久化由 ocrLanguageRepository 和设置组件协调。
 */
import {getChineseScript} from '@/src/core/language/chinese';

type MangaTesseractPack = 'kor' | 'rus' | 'ara' | 'heb';
export type ImageOcrLanguageCode = 'eng' | 'chi_sim' | 'chi_tra' | 'jpn' | 'spa' | 'fra' | MangaTesseractPack;

export type ImageOcrLanguagePack = {
    code: ImageOcrLanguageCode;
    label: string;
    icon: string;
    description: string;
    size: string;
    recommended: boolean;
};

/** 源语言选择和语言包准备共用同一目录，保留翻译配置使用的规范语言代码。 */
export const IMAGE_OCR_SOURCE_LANGUAGES = [
    {value: 'auto', label: '自动检测'}, {value: 'en', label: 'English'},
    {value: 'zh-Hans', label: '简体中文'}, {value: 'zh-Hant', label: '繁體中文'},
    {value: 'ja', label: '日本語'}, {value: 'es', label: 'Español'},
    {value: 'ko', label: '한국어'}, {value: 'fr', label: 'Français'}, {value: 'ru', label: 'Русский'},
    {value: 'ar', label: 'العربية'}, {value: 'he', label: 'עברית'},
] as const;

/** 仅公开任务阶段与错误，不保存凭据、图片或用户文本；完成状态以语言仓库为准。 */
export type ImageOcrDownloadState = {phase: 'queued' | 'downloading' | 'removing' | 'error'; error?: string};
export interface ImageOcrStatusResponse {
    success?: boolean;
    languages?: unknown;
    states?: Partial<Record<ImageOcrLanguageCode, ImageOcrDownloadState>>;
    error?: string;
}

export const IMAGE_OCR_LANGUAGE_STATE_KEY = 'fluentReadImageOcrLanguages';

export const IMAGE_OCR_LANGUAGE_PACKS: ImageOcrLanguagePack[] = [
    {
        code: 'chi_sim',
        icon: '简',
        label: '简体中文',
        description: '识别简体中文界面、截图和图片文字',
        size: '约 20 MB',
        recommended: true,
    },
    {
        code: 'chi_tra',
        icon: '繁',
        label: '繁體中文',
        description: '识别繁体中文界面、截图和图片文字',
        size: '约 20 MB',
        recommended: true,
    },
    {
        code: 'eng',
        icon: 'A',
        label: 'English',
        description: '识别英文和拉丁字母文字',
        size: '约 11 MB',
        recommended: true,
    },
    {
        code: 'spa',
        icon: 'ES',
        label: 'Español',
        description: '识别西班牙语图片文字',
        size: '约 11 MB',
        recommended: false,
    },
    {
        code: 'jpn',
        icon: '日',
        label: '日本語',
        description: '识别日文横排、竖排图片和漫画文字',
        size: '约 16 MB',
        recommended: true,
    },
    {code: 'kor', icon: '한', label: '한국어', description: '识别韩语图片文字', size: '约 2 MB', recommended: false},
    {code: 'fra', icon: 'FR', label: 'Français', description: '识别法语图片文字', size: '约 1 MB', recommended: false},
    {code: 'rus', icon: 'RU', label: 'Русский', description: '识别俄语图片文字', size: '约 5 MB', recommended: false},
    {code: 'ara', icon: 'ع', label: 'العربية', description: '识别阿拉伯语图片文字', size: '约 2 MB', recommended: false},
    {code: 'heb', icon: 'א', label: 'עברית', description: '识别希伯来语图片文字', size: '约 1 MB', recommended: false},
];

export const IMAGE_OCR_RECOMMENDED_LANGUAGES: ImageOcrLanguageCode[] = ['chi_sim', 'chi_tra', 'eng', 'jpn'];

/**
 * 语言包附带的竖排模型。Tesseract 竖排文字需要独立的 *_vert 模型；它们随所属语言包一起
 * 下载、加载和删除，用户只管理「日本語」这一张卡片。
 */
const IMAGE_OCR_VERTICAL_MODELS: Readonly<Partial<Record<ImageOcrLanguageCode, string>>> = {jpn: 'jpn_vert'};

const MANGA_TESSERACT_PACKS = new Map<string, MangaTesseractPack>([
    ['ko', 'kor'], ['ru', 'rus'], ['ar', 'ara'], ['he', 'heb'], ['iw', 'heb'],
]);
const OCR_PACK_BY_SOURCE = new Map<string, ImageOcrLanguageCode>([
    ...MANGA_TESSERACT_PACKS, ['en', 'eng'], ['ja', 'jpn'], ['es', 'spa'], ['fr', 'fra'],
]);

/** 把语言包展开为 Tesseract 实际加载的模型；竖排模型紧跟其横排模型，主语言顺序不变。 */
export function getImageOcrModelLanguages(languages: readonly ImageOcrLanguageCode[]): string[] {
    return [...new Set(languages.flatMap(language => {
        const vertical = Object.hasOwn(IMAGE_OCR_VERTICAL_MODELS, language) ? IMAGE_OCR_VERTICAL_MODELS[language] : undefined;
        return vertical ? [language, vertical] : [language];
    }))];
}

export function getRequiredImageOcrLanguages(sourceLanguage: string): ImageOcrLanguageCode[] {
    const source = sourceLanguage.trim().replace(/_/gu, '-').toLowerCase();
    const script = getChineseScript(source);
    if (script === 'Hans') return ['chi_sim', 'eng'];
    if (script === 'Hant') return ['chi_tra', 'eng'];
    const code = OCR_PACK_BY_SOURCE.get(source.split('-')[0]);
    if (code) return code === 'eng' ? ['eng'] : [code, 'eng'];
    // 自动源语言同时覆盖简繁、英文与日文，避免默认配置把繁体识别成简体后丢失脚本信息。
    return [...IMAGE_OCR_RECOMMENDED_LANGUAGES];
}

/** 源语言明确指定标准字表之外的文字时，返回识别与下载提示共用的主语言包。 */
export function getMangaTesseractPack(sourceLanguage: string): MangaTesseractPack | undefined {
    const language = sourceLanguage.trim().replace(/_/gu, '-').toLowerCase().split('-')[0];
    return MANGA_TESSERACT_PACKS.get(language);
}

export function getMangaOcrEngine(sourceLanguage: string): 'paddle' | 'tesseract' {
    return getMangaTesseractPack(sourceLanguage) ? 'tesseract' : 'paddle';
}

/** 单图标准识别使用同一字表，明确选择字表外的受支持语言时沿用轻量语言包。 */
export function getImageOcrEngine(sourceLanguage: string, preferred: 'paddle' | 'tesseract' = 'tesseract'): 'paddle' | 'tesseract' {
    return preferred === 'paddle' ? getMangaOcrEngine(sourceLanguage) : preferred;
}

export function normalizeImageOcrLanguageCodes(value: unknown): ImageOcrLanguageCode[] {
    if (!Array.isArray(value)) return [];
    const supported = new Set(IMAGE_OCR_LANGUAGE_PACKS.map(item => item.code));
    return [...new Set(value.filter((code): code is ImageOcrLanguageCode => typeof code === 'string' && supported.has(code as ImageOcrLanguageCode)))];
}

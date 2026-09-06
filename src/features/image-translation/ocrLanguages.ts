/**
 * @file src/features/image-translation/ocrLanguages.ts
 * 文件职责：定义图片 OCR 支持的语言包目录、推荐组合和持久化键，并把用户源语言映射为 Tesseract 实际需要加载的语言代码。
 * 主要内容：包含与八种源语言对应的类型与展示元数据、推荐简繁中英日集合、getRequiredImageOcrLanguages 选择规则和 normalizeImageOcrLanguageCodes 白名单去重。
 * 模块边界：此文件只描述受支持语言与规范化规则，不下载资源或访问 storage；下载由后台 Offscreen OCR runtime 执行，状态持久化由 ocrLanguageRepository 和设置组件协调。
 */
import {getChineseScript} from '@/src/core/language/chinese';

export type ImageOcrLanguageCode = 'eng' | 'chi_sim' | 'chi_tra' | 'jpn' | 'spa' | 'kor' | 'fra' | 'rus';

export type ImageOcrLanguagePack = {
    code: ImageOcrLanguageCode;
    label: string;
    icon: string;
    description: string;
    size: string;
    recommended: boolean;
};

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
        description: '识别日文图片和漫画文字',
        size: '约 16 MB',
        recommended: true,
    },
    {code: 'kor', icon: '한', label: '한국어', description: '识别韩语图片文字', size: '约 2 MB', recommended: false},
    {code: 'fra', icon: 'FR', label: 'Français', description: '识别法语图片文字', size: '约 1 MB', recommended: false},
    {code: 'rus', icon: 'RU', label: 'Русский', description: '识别俄语图片文字', size: '约 5 MB', recommended: false},
];

export const IMAGE_OCR_RECOMMENDED_LANGUAGES: ImageOcrLanguageCode[] = ['chi_sim', 'chi_tra', 'eng', 'jpn'];

export function getRequiredImageOcrLanguages(sourceLanguage: string): ImageOcrLanguageCode[] {
    const source = sourceLanguage.trim().replace(/_/gu, '-').toLowerCase();
    const script = getChineseScript(source);
    if (script === 'Hans') return ['chi_sim', 'eng'];
    if (script === 'Hant') return ['chi_tra', 'eng'];
    const language = source.split('-')[0];
    const languagePacks: Readonly<Record<string, ImageOcrLanguageCode>> = {
        en: 'eng', ja: 'jpn', es: 'spa', ko: 'kor', fr: 'fra', ru: 'rus',
    };
    const code = Object.hasOwn(languagePacks, language) ? languagePacks[language] : undefined;
    if (code) return code === 'eng' ? ['eng'] : [code, 'eng'];
    // 自动源语言同时覆盖简繁、英文与日文，避免默认配置把繁体识别成简体后丢失脚本信息。
    return [...IMAGE_OCR_RECOMMENDED_LANGUAGES];
}

export function normalizeImageOcrLanguageCodes(value: unknown): ImageOcrLanguageCode[] {
    if (!Array.isArray(value)) return [];
    const supported = new Set(IMAGE_OCR_LANGUAGE_PACKS.map(item => item.code));
    return [...new Set(value.filter((code): code is ImageOcrLanguageCode => typeof code === 'string' && supported.has(code as ImageOcrLanguageCode)))];
}

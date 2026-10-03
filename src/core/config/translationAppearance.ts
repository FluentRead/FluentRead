/**
 * @file src/core/config/translationAppearance.ts
 * 文件职责：定义网页双语译文的样式预设注册表，以及用户对译文颜色、独立背景、字号和自定义 CSS 声明等外观的微调契约。
 * 主要内容：维护预设的稳定编号、页面类名、旧版分组与设置页分类，并标注预设是否使用线条或底色；提供外观默认值、
 * 存储与导入值归一化、精选色板和颜色换算，以及把外观转换为 CSS 声明和页面样式表文本的纯函数，供设置预览与内容脚本共用。
 * 模块边界：只处理纯数据与字符串，不访问 DOM、浏览器存储或配置仓库；预设的视觉规则位于 src/ui/styles/translation-display.css，
 * 页面样式表由 content composition root 注入，设置界面只消费这里导出的元数据与声明。
 */

import {TinyColor} from '@ctrl/tinycolor';

export type TranslationStyleCategory = 'text' | 'line' | 'mark' | 'card';
export type TranslationStyleLegacyGroup = 'basic' | 'underline' | 'card' | 'highlight' | 'background' | 'special' | 'pro' | 'transparent';

export interface TranslationStylePreset {
    /** 持久化到 Config.style 的稳定编号；已发布的编号不得复用或改变含义。 */
    readonly value: number;
    /** 写入译文容器的页面类名，规则定义在共享的 translation-display.css。 */
    readonly className: string;
    /** 中文旧文案；弹窗摘要、配置差异和脚本版下拉经 legacy 词典本地化。 */
    readonly label: string;
    /** 旧版下拉分组，只用于保持脚本版和历史数据的分组顺序。 */
    readonly legacyGroup: TranslationStyleLegacyGroup;
    /** 设置页样式卡片的分类。 */
    readonly category: TranslationStyleCategory;
    /** 预设含下划线、边框或色条，可被“线条颜色”覆盖。 */
    readonly usesLine: boolean;
    /** 预设含标记或底色，可被“标记底色”覆盖。 */
    readonly usesFill: boolean;
}

/** 与 options.styles 兼容的旧版选项：分组标题行 disabled，预设行携带 class 与 group。 */
export interface TranslationStyleOption {
    readonly value: number | TranslationStyleLegacyGroup;
    readonly label: string;
    readonly disabled?: boolean;
    readonly class?: string;
    readonly group?: TranslationStyleLegacyGroup;
}

export const TRANSLATION_STYLE_LEGACY_GROUPS: ReadonlyArray<{readonly value: TranslationStyleLegacyGroup; readonly label: string}> = [
    {value: 'basic', label: '基础样式'},
    {value: 'underline', label: '下划线系列'},
    {value: 'card', label: '卡片系列'},
    {value: 'highlight', label: '高亮系列'},
    {value: 'background', label: '背景色系列'},
    {value: 'special', label: '特殊效果'},
    {value: 'pro', label: '专业样式'},
    {value: 'transparent', label: '透明效果'},
];

export const TRANSLATION_STYLE_CATEGORIES: ReadonlyArray<{readonly value: TranslationStyleCategory; readonly labelKey: string}> = [
    {value: 'text', labelKey: 'settings.translationStyle.category.text'},
    {value: 'line', labelKey: 'settings.translationStyle.category.line'},
    {value: 'mark', labelKey: 'settings.translationStyle.category.mark'},
    {value: 'card', labelKey: 'settings.translationStyle.category.card'},
];

/**
 * 数组顺序即设置页卡片顺序；旧版下拉按分组内编号排序，已有预设的相对位置保持不变。
 * 24 以后的编号为新增预设，线条类改用 text-decoration，使多行译文逐行带线。
 */
export const TRANSLATION_STYLE_PRESETS: readonly TranslationStylePreset[] = [
    {value: 0, className: 'fluent-display-default', label: '朴素模式', legacyGroup: 'basic', category: 'text', usesLine: false, usesFill: false},
    {value: 1, className: 'fluent-display-bold', label: '加粗显示', legacyGroup: 'basic', category: 'text', usesLine: false, usesFill: false},
    {value: 2, className: 'fluent-display-italic', label: '优雅斜体', legacyGroup: 'basic', category: 'text', usesLine: false, usesFill: false},
    {value: 3, className: 'fluent-display-text-shadow', label: '立体阴影', legacyGroup: 'basic', category: 'text', usesLine: false, usesFill: false},
    {value: 21, className: 'fluent-display-elegant', label: '书籍风格', legacyGroup: 'pro', category: 'text', usesLine: false, usesFill: false},
    {value: 22, className: 'fluent-display-dimmed', label: '半透明弱化', legacyGroup: 'transparent', category: 'text', usesLine: false, usesFill: false},
    {value: 23, className: 'fluent-display-transparent-mode', label: '轻透明感', legacyGroup: 'transparent', category: 'text', usesLine: false, usesFill: false},
    {value: 28, className: 'fluent-display-blur-reveal', label: '模糊遮罩', legacyGroup: 'special', category: 'text', usesLine: false, usesFill: false},

    {value: 4, className: 'fluent-display-solid-underline', label: '蓝色实线', legacyGroup: 'underline', category: 'line', usesLine: true, usesFill: false},
    {value: 5, className: 'fluent-display-dot-underline', label: '优雅虚线', legacyGroup: 'underline', category: 'line', usesLine: true, usesFill: false},
    {value: 6, className: 'fluent-display-wavy', label: '活泼波浪', legacyGroup: 'underline', category: 'line', usesLine: true, usesFill: false},
    {value: 24, className: 'fluent-display-double-underline', label: '双下划线', legacyGroup: 'underline', category: 'line', usesLine: true, usesFill: false},
    {value: 25, className: 'fluent-display-dashed-underline', label: '短划虚线', legacyGroup: 'underline', category: 'line', usesLine: true, usesFill: false},
    {value: 19, className: 'fluent-display-clean', label: '简约底线', legacyGroup: 'special', category: 'line', usesLine: true, usesFill: false},
    {value: 16, className: 'fluent-display-quote', label: '典雅引用', legacyGroup: 'special', category: 'line', usesLine: true, usesFill: false},
    {value: 26, className: 'fluent-display-side-bar', label: '侧边色条', legacyGroup: 'special', category: 'line', usesLine: true, usesFill: false},
    {value: 17, className: 'fluent-display-border', label: '轻巧边框', legacyGroup: 'special', category: 'line', usesLine: true, usesFill: false},
    {value: 27, className: 'fluent-display-dashed-border', label: '虚线边框', legacyGroup: 'special', category: 'line', usesLine: true, usesFill: false},

    {value: 10, className: 'fluent-display-learning-mode', label: '学习标记', legacyGroup: 'highlight', category: 'mark', usesLine: false, usesFill: true},
    {value: 11, className: 'fluent-display-marker', label: '荧光标记', legacyGroup: 'highlight', category: 'mark', usesLine: false, usesFill: true},
    {value: 12, className: 'fluent-display-highlight-fade', label: '柔和渐变', legacyGroup: 'highlight', category: 'mark', usesLine: false, usesFill: true},
    {value: 18, className: 'fluent-display-focus', label: '阅读焦点', legacyGroup: 'special', category: 'mark', usesLine: false, usesFill: true},
    {value: 13, className: 'fluent-display-lightyellow', label: '温暖黄底', legacyGroup: 'background', category: 'mark', usesLine: false, usesFill: true},
    {value: 14, className: 'fluent-display-lightblue', label: '清新蓝底', legacyGroup: 'background', category: 'mark', usesLine: false, usesFill: true},
    {value: 15, className: 'fluent-display-lightgray', label: '素雅灰底', legacyGroup: 'background', category: 'mark', usesLine: false, usesFill: true},

    {value: 7, className: 'fluent-display-card-mode', label: '简约卡片', legacyGroup: 'card', category: 'card', usesLine: false, usesFill: true},
    {value: 8, className: 'fluent-display-modern-card', label: '渐变卡片', legacyGroup: 'card', category: 'card', usesLine: false, usesFill: true},
    {value: 9, className: 'fluent-display-paper', label: '纸张卡片', legacyGroup: 'card', category: 'card', usesLine: true, usesFill: false},
    {value: 20, className: 'fluent-display-tech', label: '代码风格', legacyGroup: 'pro', category: 'card', usesLine: true, usesFill: false},
];

export function getTranslationStylePreset(value: unknown): TranslationStylePreset | undefined {
    return TRANSLATION_STYLE_PRESETS.find((preset) => preset.value === value);
}

/** 生成旧版带分组标题的样式选项，供 options.styles、配置差异、弹窗摘要和脚本版设置继续复用。 */
export function buildTranslationStyleOptions(): TranslationStyleOption[] {
    return TRANSLATION_STYLE_LEGACY_GROUPS.flatMap((group) => [
        {value: group.value, label: group.label, disabled: true},
        ...TRANSLATION_STYLE_PRESETS
            .filter((preset) => preset.legacyGroup === group.value)
            .sort((left, right) => left.value - right.value)
            .map((preset) => ({value: preset.value, label: preset.label, class: preset.className, group: preset.legacyGroup})),
    ]);
}

export type TranslationFontWeight = 'default' | 'normal' | 'semibold' | 'bold';
export type TranslationFontFamily = 'default' | 'sans' | 'serif' | 'mono';

export interface TranslationAppearance {
    /** 空字符串沿用网页与样式自带的文字颜色。 */
    textColor: string;
    /** 空字符串沿用样式自带的背景；显式颜色覆盖所有样式的背景，包括普通译文。 */
    backgroundColor: string;
    /** 空字符串沿用样式自带的线条颜色。 */
    lineColor: string;
    /** 空字符串沿用样式自带的标记和底色。 */
    fillColor: string;
    /** 相对原文字号的百分比，100 表示与原文一致。 */
    fontScale: number;
    fontWeight: TranslationFontWeight;
    fontFamily: TranslationFontFamily;
    /** 译文不透明度百分比。 */
    opacity: number;
    /** 只作用于 FluentRead 译文容器的外观 CSS 声明；非法属性和值不会注入网页。 */
    customCss: string;
}

/** 用户保存的译文样式快照；编号仍引用内置样式，外观覆盖单独保存。 */
export interface TranslationStyleProfile {
    id: string;
    name: string;
    style: number;
    appearance: TranslationAppearance;
}

export const MAX_TRANSLATION_STYLE_PROFILES = 12;

export function normalizeTranslationStyleProfiles(value: unknown): TranslationStyleProfile[] {
    if (!Array.isArray(value)) return [];
    const profiles: TranslationStyleProfile[] = [];
    const ids = new Set<string>();
    // 正常界面最多 12 项；导入配置也只扫描有限前缀，避免异常大数组拖慢每次归一化。
    for (const item of value.slice(0, 100)) {
        if (!item || typeof item !== 'object') continue;
        const source = item as Record<string, unknown>;
        const id = typeof source.id === 'string' ? source.id.trim() : '';
        const name = typeof source.name === 'string'
            ? source.name.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 30)
            : '';
        if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(id) || ids.has(id) || !name
            || !TRANSLATION_STYLE_PRESETS.some((preset) => preset.value === source.style)) continue;
        profiles.push({id, name, style: source.style as number, appearance: normalizeTranslationAppearance(source.appearance)});
        ids.add(id);
        if (profiles.length === MAX_TRANSLATION_STYLE_PROFILES) break;
    }
    return profiles;
}

export const TRANSLATION_FONT_SCALE_RANGE = {min: 50, max: 250, step: 1} as const;
export const TRANSLATION_OPACITY_RANGE = {min: 40, max: 100, step: 5} as const;

export const DEFAULT_TRANSLATION_APPEARANCE: Readonly<TranslationAppearance> = Object.freeze({
    textColor: '',
    backgroundColor: '',
    lineColor: '',
    fillColor: '',
    fontScale: 100,
    fontWeight: 'default',
    fontFamily: 'default',
    opacity: 100,
    customCss: '',
});

export const TRANSLATION_FONT_WEIGHT_OPTIONS: ReadonlyArray<{readonly value: TranslationFontWeight; readonly labelKey: string; readonly cssValue: string}> = [
    {value: 'default', labelKey: 'settings.translationStyle.fontWeight.default', cssValue: ''},
    {value: 'normal', labelKey: 'settings.translationStyle.fontWeight.normal', cssValue: '400'},
    {value: 'semibold', labelKey: 'settings.translationStyle.fontWeight.semibold', cssValue: '600'},
    {value: 'bold', labelKey: 'settings.translationStyle.fontWeight.bold', cssValue: '700'},
];

/** 只使用通用字体族结尾，浏览器会按译文 lang 选择对应书写体系的系统字体，避免中日韩字形混用。 */
export const TRANSLATION_FONT_FAMILY_OPTIONS: ReadonlyArray<{readonly value: TranslationFontFamily; readonly labelKey: string; readonly cssValue: string}> = [
    {value: 'default', labelKey: 'settings.translationStyle.fontFamily.default', cssValue: ''},
    {value: 'sans', labelKey: 'settings.translationStyle.fontFamily.sans', cssValue: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'},
    {value: 'serif', labelKey: 'settings.translationStyle.fontFamily.serif', cssValue: '"Iowan Old Style", "Palatino Linotype", Georgia, "Times New Roman", serif'},
    {value: 'mono', labelKey: 'settings.translationStyle.fontFamily.mono', cssValue: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace'},
];

export interface TranslationColorSwatch {
    readonly id: string;
    readonly value: string;
    readonly labelKey: string;
}

function swatch(id: string, value: string): TranslationColorSwatch {
    return {id, value, labelKey: `settings.translationStyle.colors.${id}`};
}

/** 前八种适合浅色网页，最后两种浅色适合深色网页。 */
export const TRANSLATION_TEXT_COLOR_SWATCHES: readonly TranslationColorSwatch[] = [
    swatch('ink', '#1f2937'),
    swatch('slate', '#475569'),
    swatch('navy', '#1d4ed8'),
    swatch('teal', '#0f766e'),
    swatch('forest', '#15803d'),
    swatch('amber', '#b45309'),
    swatch('rose', '#be123c'),
    swatch('violet', '#6d28d9'),
    swatch('snow', '#f1f5f9'),
    swatch('gold', '#fde68a'),
];

/** 独立背景色使用浅色为主，避免色板选中后立即遮住默认深色译文。 */
export const TRANSLATION_BACKGROUND_COLOR_SWATCHES: readonly TranslationColorSwatch[] = [
    swatch('yellow', '#fff8cc'),
    swatch('blue', '#eff6ff'),
    swatch('green', '#ecfdf5'),
    swatch('pink', '#fce7f3'),
    swatch('gray', '#e5e7eb'),
    swatch('slate', '#334155'),
];

export const TRANSLATION_LINE_COLOR_SWATCHES: readonly TranslationColorSwatch[] = [
    swatch('blue', '#2563eb'),
    swatch('pink', '#ef4776'),
    swatch('orange', '#f97316'),
    swatch('yellow', '#eab308'),
    swatch('green', '#16a34a'),
    swatch('cyan', '#0891b2'),
    swatch('purple', '#7c3aed'),
    swatch('gray', '#64748b'),
];

/** 底色使用饱和基色，实际按各预设的强弱换算为半透明或与白色混合的浅色。 */
export const TRANSLATION_FILL_COLOR_SWATCHES: readonly TranslationColorSwatch[] = [
    swatch('yellow', '#facc15'),
    swatch('orange', '#fb923c'),
    swatch('pink', '#f472b6'),
    swatch('green', '#4ade80'),
    swatch('cyan', '#22d3ee'),
    swatch('blue', '#60a5fa'),
    swatch('purple', '#a78bfa'),
    swatch('gray', '#9ca3af'),
];

/** 预设样式读取的自定义属性；未设置时各预设回退到自己的原有配色。 */
export const TRANSLATION_APPEARANCE_VARIABLES = {
    line: '--fluent-read-translation-line',
    fillStrong: '--fluent-read-translation-fill-strong',
    fillSoft: '--fluent-read-translation-fill-soft',
    fillFaint: '--fluent-read-translation-fill-faint',
    surface: '--fluent-read-translation-surface',
    surfaceDeep: '--fluent-read-translation-surface-deep',
} as const;

/** 页面样式表只命中 FluentRead 自建且拥有的双语译文容器，悬浮翻译与全文翻译共用。 */
export const TRANSLATION_APPEARANCE_SELECTOR = '.fluent-read-bilingual-content[data-fr-translation-owned="true"]';

export function normalizeTranslationColor(value: unknown): string {
    if (typeof value !== 'string') return '';
    const color = value.trim().toLowerCase();
    if (/^#[\da-f]{6}$/u.test(color)) return color;
    if (/^#[\da-f]{3}$/u.test(color)) {
        return `#${[...color.slice(1)].map((digit) => digit + digit).join('')}`;
    }
    const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/u.exec(color);
    if (rgb) {
        const values = rgb.slice(1).map(Number);
        return values.every((channel) => channel <= 255)
            ? `#${values.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
            : '';
    }
    // 仅接受单个 CSS 命名色，不让配置值携带任意 CSS 片段进入网页样式表。
    if (!/^[a-z]{3,20}$/u.test(color)) return '';
    const named = new TinyColor(color);
    return named.isValid && named.getAlpha() === 1 ? named.toHexString().toLowerCase() : '';
}

export const MAX_TRANSLATION_CUSTOM_CSS_LENGTH = 2000;

/** 只允许影响译文外观的属性，禁止选择器、定位、外部资源和宿主页面规则。 */
const TRANSLATION_CUSTOM_CSS_PROPERTIES = new Set([
    'color', 'background', 'background-color', 'font-size', 'font-weight', 'font-family', 'font-style',
    'line-height', 'letter-spacing', 'opacity', 'text-decoration', 'text-decoration-color',
    'text-decoration-style', 'text-decoration-thickness', 'text-shadow', 'border', 'border-color',
    'border-radius', 'box-shadow', 'padding',
]);

function normalizeTranslationCustomCss(value: unknown): string {
    return typeof value === 'string'
        ? value.slice(0, MAX_TRANSLATION_CUSTOM_CSS_LENGTH).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
        : '';
}

export interface TranslationCustomCssResult {
    readonly declarations: TranslationAppearanceDeclaration[];
    readonly invalidCount: number;
}

/** 逐条验证声明再重建样式表；调用方可限定高亮绘制属性，绝不直接拼接用户输入的 CSS 文本。 */
export function parseTranslationCustomCss(value: unknown, allowedProperties: ReadonlySet<string> = TRANSLATION_CUSTOM_CSS_PROPERTIES): TranslationCustomCssResult {
    const source = normalizeTranslationCustomCss(value);
    const declarations: TranslationAppearanceDeclaration[] = [];
    let invalidCount = 0;
    for (const part of source.split(';')) {
        const entry = part.trim();
        if (!entry) continue;
        const separator = entry.indexOf(':');
        const property = entry.slice(0, separator).trim().toLowerCase();
        const cssValue = entry.slice(separator + 1).trim();
        if (separator < 1 || !allowedProperties.has(property) || cssValue.length > 200
            || !/^[a-z\d\s#.,()%+'"\/_*-]+$/iu.test(cssValue)
            || /(?:url|image-set|expression|attr|var)\s*\(|\/\*|\*\/|!important/iu.test(cssValue)
            || declarations.length >= 24) {
            invalidCount += 1;
            continue;
        }
        declarations.push({property, value: cssValue});
    }
    return {declarations, invalidCount};
}

function normalizeStep(value: unknown, fallback: number, range: {readonly min: number; readonly max: number; readonly step: number}): number {
    const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : Number.NaN;
    if (!Number.isFinite(number)) return fallback;
    return Math.min(range.max, Math.max(range.min, Math.round(number / range.step) * range.step));
}

function normalizeChoice<T extends string>(value: unknown, choices: ReadonlyArray<{readonly value: T}>): T {
    return choices.find((choice) => choice.value === value)?.value ?? choices[0].value;
}

export function normalizeTranslationAppearance(value: unknown): TranslationAppearance {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return {
        textColor: normalizeTranslationColor(source.textColor),
        backgroundColor: normalizeTranslationColor(source.backgroundColor),
        lineColor: normalizeTranslationColor(source.lineColor),
        fillColor: normalizeTranslationColor(source.fillColor),
        fontScale: normalizeStep(source.fontScale, DEFAULT_TRANSLATION_APPEARANCE.fontScale, TRANSLATION_FONT_SCALE_RANGE),
        fontWeight: normalizeChoice(source.fontWeight, TRANSLATION_FONT_WEIGHT_OPTIONS),
        fontFamily: normalizeChoice(source.fontFamily, TRANSLATION_FONT_FAMILY_OPTIONS),
        opacity: normalizeStep(source.opacity, DEFAULT_TRANSLATION_APPEARANCE.opacity, TRANSLATION_OPACITY_RANGE),
        customCss: normalizeTranslationCustomCss(source.customCss),
    };
}

export function isDefaultTranslationAppearance(value: unknown): boolean {
    const appearance = normalizeTranslationAppearance(value);
    return (Object.keys(DEFAULT_TRANSLATION_APPEARANCE) as Array<keyof TranslationAppearance>)
        .every((key) => appearance[key] === DEFAULT_TRANSLATION_APPEARANCE[key]);
}

function channels(hex: string): [number, number, number] {
    return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
}

function rgba(hex: string, alpha: number): string {
    return `rgba(${channels(hex).join(', ')}, ${alpha})`;
}

/** 与白色混合得到不透明浅色，用于自带深色文字的卡片表面，深色网页上也不会透出背景。 */
function mixWithWhite(hex: string, weight: number): string {
    return `#${channels(hex)
        .map((channel) => Math.round(255 + (channel - 255) * weight).toString(16).padStart(2, '0'))
        .join('')}`;
}

export interface TranslationAppearanceDeclaration {
    readonly property: string;
    readonly value: string;
}

/** 只输出用户改动过的声明；默认外观返回空数组，网页和预设保持原样。 */
export function getTranslationAppearanceDeclarations(value: unknown): TranslationAppearanceDeclaration[] {
    const appearance = normalizeTranslationAppearance(value);
    const declarations: TranslationAppearanceDeclaration[] = [];
    if (appearance.lineColor) {
        declarations.push({property: TRANSLATION_APPEARANCE_VARIABLES.line, value: appearance.lineColor});
    }
    if (appearance.fillColor) {
        declarations.push(
            {property: TRANSLATION_APPEARANCE_VARIABLES.fillStrong, value: rgba(appearance.fillColor, 0.45)},
            {property: TRANSLATION_APPEARANCE_VARIABLES.fillSoft, value: rgba(appearance.fillColor, 0.22)},
            {property: TRANSLATION_APPEARANCE_VARIABLES.fillFaint, value: rgba(appearance.fillColor, 0.12)},
            {property: TRANSLATION_APPEARANCE_VARIABLES.surface, value: mixWithWhite(appearance.fillColor, 0.1)},
            {property: TRANSLATION_APPEARANCE_VARIABLES.surfaceDeep, value: mixWithWhite(appearance.fillColor, 0.24)},
        );
    }
    if (appearance.backgroundColor) declarations.push({property: 'background', value: appearance.backgroundColor});
    if (appearance.textColor) declarations.push({property: 'color', value: appearance.textColor});
    if (appearance.fontScale !== DEFAULT_TRANSLATION_APPEARANCE.fontScale) {
        declarations.push({property: 'font-size', value: `${appearance.fontScale}%`});
    }
    const fontWeight = TRANSLATION_FONT_WEIGHT_OPTIONS.find((option) => option.value === appearance.fontWeight)!.cssValue;
    if (fontWeight) declarations.push({property: 'font-weight', value: fontWeight});
    const fontFamily = TRANSLATION_FONT_FAMILY_OPTIONS.find((option) => option.value === appearance.fontFamily)!.cssValue;
    if (fontFamily) declarations.push({property: 'font-family', value: fontFamily});
    if (appearance.opacity !== DEFAULT_TRANSLATION_APPEARANCE.opacity) {
        declarations.push({property: 'opacity', value: String(appearance.opacity / 100)});
    }
    declarations.push(...parseTranslationCustomCss(appearance.customCss).declarations);
    return declarations;
}

/** 设置页预览以内联样式应用同一组声明，保证与网页效果一致。 */
export function getTranslationAppearanceStyle(value: unknown): Record<string, string> {
    return Object.fromEntries(getTranslationAppearanceDeclarations(value).map(({property, value: cssValue}) => [property, cssValue]));
}

/**
 * 生成注入网页的样式表文本。用户显式选择的外观需要胜过预设、宿主 CSS 和跨书写体系字体修正写入的内联字体，
 * 因此每条声明都带 !important；默认外观返回空字符串，由调用方移除样式节点。
 */
export function buildTranslationAppearanceCss(value: unknown): string {
    const declarations = getTranslationAppearanceDeclarations(value);
    if (!declarations.length) return '';
    const body = declarations.map(({property, value: cssValue}) => `    ${property}: ${cssValue} !important;`).join('\n');
    return `${TRANSLATION_APPEARANCE_SELECTOR} {\n${body}\n}\n`;
}

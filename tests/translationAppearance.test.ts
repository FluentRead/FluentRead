import {describe, expect, it} from 'vitest';
import {options} from '@/src/core/config/catalog';
import {normalizeConfig} from '@/src/core/config/model';
import {
    DEFAULT_TRANSLATION_APPEARANCE,
    TRANSLATION_BACKGROUND_COLOR_SWATCHES,
    MAX_TRANSLATION_STYLE_PROFILES,
    TRANSLATION_APPEARANCE_SELECTOR,
    TRANSLATION_FILL_COLOR_SWATCHES,
    TRANSLATION_FONT_FAMILY_OPTIONS,
    TRANSLATION_FONT_WEIGHT_OPTIONS,
    TRANSLATION_LINE_COLOR_SWATCHES,
    TRANSLATION_STYLE_CATEGORIES,
    TRANSLATION_STYLE_LEGACY_GROUPS,
    TRANSLATION_STYLE_PRESETS,
    TRANSLATION_TEXT_COLOR_SWATCHES,
    buildTranslationAppearanceCss,
    buildTranslationStyleOptions,
    getTranslationAppearanceDeclarations,
    getTranslationAppearanceStyle,
    getTranslationStylePreset,
    isDefaultTranslationAppearance,
    normalizeTranslationAppearance,
    normalizeTranslationColor,
    normalizeTranslationStyleProfiles,
    parseTranslationCustomCss,
} from '@/src/core/config/translationAppearance';

describe('译文样式预设注册表', () => {
    it('保持稳定编号与唯一类名，并按五个分类组织全部预设', () => {
        const values = TRANSLATION_STYLE_PRESETS.map((preset) => preset.value);
        expect([...values].sort((left, right) => left - right)).toEqual(Array.from({length: 49}, (_, index) => index));
        expect(new Set(TRANSLATION_STYLE_PRESETS.map((preset) => preset.className)).size).toBe(49);
        expect(TRANSLATION_STYLE_PRESETS.every((preset) => preset.className.startsWith('fluent-display-'))).toBe(true);
        const counts = Object.fromEntries(TRANSLATION_STYLE_CATEGORIES.map((category) => [
            category.value,
            TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === category.value).length,
        ]));
        expect(counts).toEqual({text: 12, line: 14, mark: 9, card: 5, fun: 9});
        const groups = new Set(TRANSLATION_STYLE_LEGACY_GROUPS.map((group) => group.value));
        expect(TRANSLATION_STYLE_PRESETS.every((preset) => groups.has(preset.legacyGroup))).toBe(true);
        expect(TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === 'line').every((preset) => preset.usesLine)).toBe(true);
        expect(TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === 'mark').every((preset) => preset.usesFill)).toBe(true);
        expect(TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === 'text').some((preset) => preset.usesLine || preset.usesFill)).toBe(false);
    });

    it('按编号查找预设，未知值和字符串编号不命中', () => {
        expect(getTranslationStylePreset(6)?.className).toBe('fluent-display-wavy');
        expect(getTranslationStylePreset(28)).toMatchObject({label: '模糊遮罩', category: 'text'});
        expect(getTranslationStylePreset(48)).toMatchObject({label: '黑幕遮挡', category: 'fun', inlineText: true, revealOnHover: true});
        expect(getTranslationStylePreset(99)).toBeUndefined();
        expect(getTranslationStylePreset('6')).toBeUndefined();
    });

    it('派生的旧版选项保留原有分组与顺序，新预设追加到所属分组末尾', () => {
        const legacy = buildTranslationStyleOptions();
        expect(options.styles).toEqual(legacy);
        expect(legacy.filter((item) => item.disabled).map((item) => [item.value, item.label])).toEqual([
            ['basic', '基础样式'], ['underline', '下划线系列'], ['card', '卡片系列'], ['highlight', '高亮系列'],
            ['background', '背景色系列'], ['special', '特殊效果'], ['pro', '专业样式'], ['transparent', '透明效果'], ['fun', '趣味效果'],
        ]);
        expect(legacy.filter((item) => !item.disabled).map((item) => item.value)).toEqual([
            0, 1, 2, 3, 29, 30, 31, 32, 4, 5, 6, 24, 25, 33, 7, 8, 9, 39, 10, 11, 12, 13, 14, 15, 37, 38,
            16, 17, 18, 19, 26, 27, 28, 34, 35, 36, 20, 21, 22, 23, 40, 41, 42, 43, 44, 45, 46, 47, 48,
        ]);
        expect(legacy.find((item) => item.value === 1)).toEqual({value: 1, label: '加粗显示', class: 'fluent-display-bold', group: 'basic'});
        // 逐行绘制的预设把标记带到旧版选项，渲染器据此包裹行内译文。
        expect(legacy.filter((item) => item.inlineText).map((item) => item.value)).toEqual([10, 11, 38, 42, 43, 48]);
    });
});

describe('译文外观归一化', () => {
    it('颜色名称、RGB 与三位或六位十六进制统一为安全的小写六位色值', () => {
        expect(normalizeTranslationColor('#ABCDEF')).toBe('#abcdef');
        expect(normalizeTranslationColor(' #aBc ')).toBe('#aabbcc');
        expect(normalizeTranslationColor('ReBeccAPurple')).toBe('#663399');
        expect(normalizeTranslationColor('rgb(1, 2, 255)')).toBe('#0102ff');
        for (const invalid of ['banana', 'transparent', '#12', '#12345g', 'rgb(256, 2, 3)', 'red; background: url(https://example.com)', 123, null, undefined]) {
            expect(normalizeTranslationColor(invalid)).toBe('');
        }
    });

    it('缺失、损坏或越界的外观回到默认值并按步长取整', () => {
        expect(normalizeTranslationAppearance(undefined)).toEqual(DEFAULT_TRANSLATION_APPEARANCE);
        expect(normalizeTranslationAppearance('broken')).toEqual(DEFAULT_TRANSLATION_APPEARANCE);
        expect(normalizeTranslationAppearance({
            textColor: '#1D4ED8', backgroundColor: 'rgb(10, 20, 30)', lineColor: 'blue', fillColor: '#abc', fontScale: 107, fontWeight: 'semibold',
            fontFamily: 'serif', opacity: 72,
        })).toEqual({
            textColor: '#1d4ed8', backgroundColor: '#0a141e', lineColor: '#0000ff', fillColor: '#aabbcc', fontScale: 107, fontWeight: 'semibold',
            fontFamily: 'serif', opacity: 70, customCss: '',
        });
        expect(normalizeTranslationAppearance({fontScale: 400, opacity: 10})).toMatchObject({fontScale: 250, opacity: 40});
        expect(normalizeTranslationAppearance({fontScale: 10, opacity: 101})).toMatchObject({fontScale: 50, opacity: 100});
        expect(normalizeTranslationAppearance({fontScale: '120', opacity: ' '})).toMatchObject({fontScale: 120, opacity: 100});
        expect(normalizeTranslationAppearance({fontScale: Number.NaN, opacity: {}})).toMatchObject({fontScale: 100, opacity: 100});
        expect(normalizeTranslationAppearance({fontWeight: 'heavy', fontFamily: 'cursive'})).toMatchObject({fontWeight: 'default', fontFamily: 'default'});
    });

    it('只有全部字段都等于默认值时才视为默认外观', () => {
        expect(isDefaultTranslationAppearance(undefined)).toBe(true);
        expect(isDefaultTranslationAppearance({...DEFAULT_TRANSLATION_APPEARANCE, fontScale: '100'})).toBe(true);
        expect(isDefaultTranslationAppearance({...DEFAULT_TRANSLATION_APPEARANCE, opacity: 95})).toBe(false);
        expect(isDefaultTranslationAppearance({...DEFAULT_TRANSLATION_APPEARANCE, lineColor: '#ef4776'})).toBe(false);
        expect(isDefaultTranslationAppearance({...DEFAULT_TRANSLATION_APPEARANCE, backgroundColor: 'red'})).toBe(false);
        expect(isDefaultTranslationAppearance({...DEFAULT_TRANSLATION_APPEARANCE, customCss: 'border-radius: 6px;'})).toBe(false);
    });

    it('仅解析安全的译文 CSS 声明，拒绝选择器、定位和远程资源', () => {
        expect(parseTranslationCustomCss('color: rebeccapurple; background: rgb(255, 248, 204); font-size: 117%; border-radius: 6px;')).toEqual({
            declarations: [
                {property: 'color', value: 'rebeccapurple'},
                {property: 'background', value: 'rgb(255, 248, 204)'},
                {property: 'font-size', value: '117%'},
                {property: 'border-radius', value: '6px'},
            ], invalidCount: 0,
        });
        const unsafe = parseTranslationCustomCss('color: red; position: fixed; background: url(https://example.com/x); } body { color: blue;');
        expect(unsafe).toEqual({declarations: [{property: 'color', value: 'red'}], invalidCount: 3});
        expect(buildTranslationAppearanceCss({customCss: 'color: red; } body { color: blue;'})).toBe(
            `${TRANSLATION_APPEARANCE_SELECTOR} {\n    color: red !important;\n}\n`,
        );
    });

    it('色板与选项引用存在的 i18n key，且色值已归一化', () => {
        for (const swatch of [...TRANSLATION_TEXT_COLOR_SWATCHES, ...TRANSLATION_BACKGROUND_COLOR_SWATCHES, ...TRANSLATION_LINE_COLOR_SWATCHES, ...TRANSLATION_FILL_COLOR_SWATCHES]) {
            expect(normalizeTranslationColor(swatch.value)).toBe(swatch.value);
            expect(swatch.labelKey).toBe(`settings.translationStyle.colors.${swatch.id}`);
        }
        expect(TRANSLATION_FONT_WEIGHT_OPTIONS.map((option) => option.value)).toEqual(['default', 'normal', 'semibold', 'bold']);
        expect(TRANSLATION_FONT_FAMILY_OPTIONS.map((option) => option.value)).toEqual(['default', 'sans', 'serif', 'mono']);
        // 字体族均以通用族结尾，浏览器才会按译文 lang 选择对应书写体系的系统字体。
        expect(TRANSLATION_FONT_FAMILY_OPTIONS.slice(1).every((option) => /(?:sans-serif|serif|monospace)$/u.test(option.cssValue))).toBe(true);
    });
});

describe('用户保存的译文样式', () => {
    it('只保留有效且不重复的命名快照，并归一化各自的外观', () => {
        const profiles = normalizeTranslationStyleProfiles([
            null,
            42,
            {name: '缺少编号', style: 0},
            {id: 'night', name: '  夜读  ', style: 22, appearance: {textColor: '#ABC', backgroundColor: 'navy', fontScale: 111}},
            {id: 'night', name: '重复', style: 1},
            {id: 'bad id', name: '非法编号', style: 1},
            {id: 'unknown', name: '未知样式', style: 999},
            {id: 'empty', name: '  ', style: 0},
            {id: 'nonstring', name: 123, style: 0},
            {id: 'paper', name: '纸张\u0000样式', style: 9, appearance: {opacity: 73}},
        ]);
        expect(profiles).toEqual([
            {id: 'night', name: '夜读', style: 22, appearance: {...DEFAULT_TRANSLATION_APPEARANCE, textColor: '#aabbcc', backgroundColor: '#000080', fontScale: 111}},
            {id: 'paper', name: '纸张样式', style: 9, appearance: {...DEFAULT_TRANSLATION_APPEARANCE, opacity: 75}},
        ]);
    });

    it('对导入的快照数量设限，并只保留指向现有快照的选择', () => {
        const source = Array.from({length: MAX_TRANSLATION_STYLE_PROFILES + 3}, (_, index) => ({
            id: `style-${index}`, name: `样式 ${index}`, style: index % 2 ? 9 : 22,
            appearance: {opacity: 80},
        }));
        const config = normalizeConfig({translationStyleProfiles: source, activeTranslationStyleProfileId: 'style-2'});
        expect(config.translationStyleProfiles).toHaveLength(MAX_TRANSLATION_STYLE_PROFILES);
        expect(config.activeTranslationStyleProfileId).toBe('style-2');
        expect(normalizeConfig({...config, activeTranslationStyleProfileId: 'style-14'}).activeTranslationStyleProfileId).toBe('');
        expect(normalizeConfig({translationStyleProfiles: 'broken'}).translationStyleProfiles).toEqual([]);
    });
});

describe('译文外观声明与页面样式表', () => {
    it('默认外观不生成声明或样式表，网页保持预设原样', () => {
        expect(getTranslationAppearanceDeclarations(DEFAULT_TRANSLATION_APPEARANCE)).toEqual([]);
        expect(getTranslationAppearanceStyle(undefined)).toEqual({});
        expect(buildTranslationAppearanceCss(undefined)).toBe('');
    });

    it('把线条、底色强弱、文字颜色和排版转换为网页与预览共用的声明', () => {
        expect(getTranslationAppearanceDeclarations({
            textColor: '#1d4ed8', backgroundColor: 'rgb(248, 250, 252)', lineColor: '#EF4776', fillColor: '#4ade80', fontScale: 115,
            fontWeight: 'bold', fontFamily: 'mono', opacity: 80,
        })).toEqual([
            {property: '--fluent-read-translation-line', value: '#ef4776'},
            {property: '--fluent-read-translation-fill-strong', value: 'rgba(74, 222, 128, 0.45)'},
            {property: '--fluent-read-translation-fill-soft', value: 'rgba(74, 222, 128, 0.22)'},
            {property: '--fluent-read-translation-fill-faint', value: 'rgba(74, 222, 128, 0.12)'},
            {property: '--fluent-read-translation-surface', value: '#edfcf2'},
            {property: '--fluent-read-translation-surface-deep', value: '#d4f7e1'},
            {property: 'background', value: '#f8fafc'},
            {property: 'color', value: '#1d4ed8'},
            {property: 'font-size', value: '115%'},
            {property: 'font-weight', value: '700'},
            {property: 'font-family', value: TRANSLATION_FONT_FAMILY_OPTIONS[3].cssValue},
            {property: 'opacity', value: '0.8'},
        ]);
        expect(getTranslationAppearanceStyle({fillColor: '#facc15', fontWeight: 'normal'})).toEqual({
            '--fluent-read-translation-fill-strong': 'rgba(250, 204, 21, 0.45)',
            '--fluent-read-translation-fill-soft': 'rgba(250, 204, 21, 0.22)',
            '--fluent-read-translation-fill-faint': 'rgba(250, 204, 21, 0.12)',
            '--fluent-read-translation-surface': '#fffae8',
            '--fluent-read-translation-surface-deep': '#fef3c7',
            'font-weight': '400',
        });
    });

    it('页面样式表只命中自有双语容器，并以 !important 胜过预设和宿主样式', () => {
        expect(buildTranslationAppearanceCss({lineColor: '#16a34a', fontWeight: 'semibold'})).toBe(
            `${TRANSLATION_APPEARANCE_SELECTOR} {\n`
            + '    --fluent-read-translation-line: #16a34a !important;\n'
            + '    font-weight: 600 !important;\n'
            + '}\n',
        );
        expect(TRANSLATION_APPEARANCE_SELECTOR).toBe('.fluent-read-bilingual-content[data-fr-translation-owned="true"]');
        expect(buildTranslationAppearanceCss({backgroundColor: 'red', fontScale: 117})).toContain('    background: #ff0000 !important;\n    font-size: 117% !important;');
        expect(getTranslationAppearanceStyle({textColor: '#ff0000', customCss: 'color: navy; border-radius: 6px;'})).toMatchObject({
            color: 'navy', 'border-radius': '6px',
        });
    });
});

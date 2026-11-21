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
    getTranslationPresetAppearance,
    getTranslationStylePreset,
    isDefaultTranslationAppearance,
    normalizeTranslationAppearance,
    normalizeTranslationColor,
    normalizeTranslationStyleProfiles,
    parseTranslationCustomCss,
} from '@/src/core/config/translationAppearance';

describe('译文样式预设注册表', () => {
    it('保持稳定编号与唯一类名，并按六个分类组织全部预设', () => {
        const values = TRANSLATION_STYLE_PRESETS.map((preset) => preset.value);
        expect([...values].sort((left, right) => left - right)).toEqual(Array.from({length: 71}, (_, index) => index));
        expect(new Set(TRANSLATION_STYLE_PRESETS.map((preset) => preset.className)).size).toBe(71);
        expect(TRANSLATION_STYLE_PRESETS.every((preset) => preset.className.startsWith('fluent-display-'))).toBe(true);
        expect(TRANSLATION_STYLE_CATEGORIES.map(({value}) => value)).toEqual(['text', 'color', 'line', 'mark', 'card', 'fun']);
        const counts = Object.fromEntries(TRANSLATION_STYLE_CATEGORIES.map((category) => [
            category.value,
            TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === category.value).length,
        ]));
        expect(counts).toEqual({text: 12, color: 12, line: 14, mark: 9, card: 12, fun: 12});
        const groups = new Set(TRANSLATION_STYLE_LEGACY_GROUPS.map((group) => group.value));
        expect(TRANSLATION_STYLE_PRESETS.every((preset) => groups.has(preset.legacyGroup))).toBe(true);
        expect(TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === 'line').every((preset) => preset.usesLine)).toBe(true);
        expect(TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === 'mark').every((preset) => preset.usesFill)).toBe(true);
        expect(TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === 'text').some((preset) => preset.usesLine || preset.usesFill)).toBe(false);
    });

    it('追加的彩色文字单列在颜色分类，旧样式与默认外观保持原意', () => {
        const colors = TRANSLATION_STYLE_PRESETS.filter((preset) => preset.category === 'color');
        expect(colors.map(({value, className, label}) => ({value, className, label}))).toEqual([
            {value: 49, className: 'fluent-display-text-green', label: '森林绿'},
            {value: 50, className: 'fluent-display-text-blue', label: '澄澈蓝'},
            {value: 51, className: 'fluent-display-text-purple', label: '优雅紫'},
            {value: 52, className: 'fluent-display-text-orange', label: '暖橙'},
            {value: 53, className: 'fluent-display-text-teal', label: '青碧'},
            {value: 54, className: 'fluent-display-text-brand', label: 'FluentRead 粉'},
            {value: 55, className: 'fluent-display-text-berry', label: '莓果红'},
            {value: 56, className: 'fluent-display-text-gold', label: '暖金'},
            {value: 57, className: 'fluent-display-text-graphite', label: '石墨灰'},
            {value: 40, className: 'fluent-display-gradient-text', label: '渐变文字'},
            {value: 41, className: 'fluent-display-neon', label: '霓虹微光'},
            {value: 42, className: 'fluent-display-rainbow-marker', label: '彩虹荧光'},
        ]);
        expect(TRANSLATION_STYLE_PRESETS.filter(({category}) => category === 'text').every(({value}) => value < 49)).toBe(true);
        expect(normalizeConfig({}).style).toBe(1);
        expect(DEFAULT_TRANSLATION_APPEARANCE.textColor).toBe('');
        expect(TRANSLATION_TEXT_COLOR_SWATCHES.find(({id}) => id === 'brand')).toMatchObject({
            value: '#ef4776', labelKey: 'settings.translationStyle.colors.brand',
        });
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
            0, 1, 2, 3, 29, 30, 31, 32, 49, 50, 51, 52, 53, 54, 55, 56, 57, 4, 5, 6, 24, 25, 33, 7, 8, 9, 39, 58, 59, 60, 61, 62, 63, 64,
            10, 11, 12, 13, 14, 15, 37, 38, 16, 17, 18, 19, 26, 27, 28, 34, 35, 36, 20, 21, 22, 23,
            40, 41, 42, 43, 44, 45, 46, 47, 48, 65, 66, 67, 68, 69, 70,
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

    it('保留旧配置中仅含字母的裸 hex，仍拒绝带透明度或损坏的值', () => {
        for (const [input, expected] of [
            ['bad', '#bbaadd'], ['abcf', '#aabbcc'], ['ABCDEF', '#abcdef'],
            ['abcdefff', '#abcdef'], [' abcf ', '#aabbcc'],
            ['abcd', ''], ['abcdeffe', ''], ['abcdeg', ''],
        ]) {
            expect(normalizeTranslationColor(input)).toBe(expected);
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
            `${TRANSLATION_APPEARANCE_SELECTOR} {\n    color: red !important;\n    -webkit-text-fill-color: currentColor !important;\n}\n`,
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

describe('选择颜色预设时清理冲突外观', () => {
    it('清理纯色和旧text-fill覆盖，保留非冲突CSS原文、排版、背景与其他颜色微调', () => {
        const original = normalizeTranslationAppearance({
            textColor: '#ef4776', backgroundColor: '#fff8cc', lineColor: '#123456', fillColor: '#654321',
            fontScale: 117, fontFamily: 'serif', fontWeight: 'bold', opacity: 85,
            customCss: 'COLOR: pink; font-size: 123%; -webkit-text-fill-color: pink; text-fill-color: red; border-radius: 6px; position: fixed; color: url(secret)',
        });
        const selected = getTranslationPresetAppearance(49, original);
        expect(selected).toEqual({...original, textColor: '',
            customCss: ' font-size: 123%; border-radius: 6px; position: fixed; color: url(secret)'});
        expect(original.textColor).toBe('#ef4776');
        expect(original.customCss).toContain('COLOR: pink');
        expect(getTranslationAppearanceStyle(selected)).not.toHaveProperty('color');
        expect(getTranslationAppearanceStyle({...selected, textColor: '#1d4ed8'})).toMatchObject({
            color: '#1d4ed8', '-webkit-text-fill-color': 'currentColor',
        });
        expect(getTranslationAppearanceStyle({...selected, customCss: selected.customCss + '; color: navy'})).toMatchObject({
            color: 'navy', '-webkit-text-fill-color': 'currentColor',
        });
    });

    it('渐变仅额外清理背景填色，霓虹仅额外清理其阴影，其他类别和未知样式不改外观', () => {
        const original = normalizeTranslationAppearance({textColor: 'pink', backgroundColor: 'yellow',
            customCss: 'color: pink; background: red; background-color: blue; text-shadow: 1px 1px pink; font-family: Georgia'});
        expect(getTranslationPresetAppearance(40, original)).toMatchObject({textColor: '', backgroundColor: '',
            customCss: ' text-shadow: 1px 1px pink; font-family: Georgia'});
        expect(getTranslationPresetAppearance(41, original)).toMatchObject({textColor: '', backgroundColor: '#ffff00',
            customCss: ' background: red; background-color: blue; font-family: Georgia'});
        expect(getTranslationPresetAppearance(42, original)).toMatchObject({textColor: '', backgroundColor: '#ffff00'});
        expect(getTranslationPresetAppearance(6, original)).toEqual(original);
        expect(getTranslationPresetAppearance('unknown', original)).toEqual(original);
        expect(getTranslationPresetAppearance(49, undefined)).toEqual(DEFAULT_TRANSLATION_APPEARANCE);
        // 分类清理识别旧text-fill片段，但不使这些属性成为可执行的自定义CSS。
        expect(parseTranslationCustomCss('-webkit-text-fill-color: pink; text-fill-color: red').invalidCount).toBe(2);
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

    it('新增文字预设沿用配置和命名快照的保存、导入与颜色覆盖', () => {
        const profiles = [49, 50, 51, 52, 53, 54].map(style => ({
            id: `color-${style}`, name: `Color ${style}`, style, appearance: {textColor: '#ef4776'},
        }));
        const config = normalizeConfig(JSON.parse(JSON.stringify({
            style: 49, translationAppearance: {textColor: '#ef4776'},
            translationStyleProfiles: profiles, activeTranslationStyleProfileId: 'color-54',
        })));
        expect(config.style).toBe(49);
        expect(config.translationAppearance.textColor).toBe('#ef4776');
        expect(config.translationStyleProfiles.map(({style}) => style)).toEqual([49, 50, 51, 52, 53, 54]);
        expect(config.translationStyleProfiles.every(({appearance}) => appearance.textColor === '#ef4776')).toBe(true);
        expect(config.activeTranslationStyleProfileId).toBe('color-54');
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
            {property: '--fluent-read-translation-surface-ink', value: '#000000'},
            {property: '-webkit-text-fill-color', value: 'currentColor'},
        ]);
        expect(getTranslationAppearanceStyle({fillColor: '#facc15', fontWeight: 'normal'})).toEqual({
            '--fluent-read-translation-fill-strong': 'rgba(250, 204, 21, 0.45)',
            '--fluent-read-translation-fill-soft': 'rgba(250, 204, 21, 0.22)',
            '--fluent-read-translation-fill-faint': 'rgba(250, 204, 21, 0.12)',
            '--fluent-read-translation-surface': '#fffae8',
            '--fluent-read-translation-surface-deep': '#fef3c7',
            'font-weight': '400',
            '--fluent-read-translation-surface-ink': '#000000',
        });
    });

    it('不透明背景选择黑白高对比正文，同时保留用户文字与实际背景声明', () => {
        const style = getTranslationAppearanceStyle({
            textColor: '#ef4776', backgroundColor: '#ffffff',
            customCss: 'background: navy; background-color: rgb(255, 248, 204); color: rebeccapurple',
        });
        expect(style).toMatchObject({
            background: 'navy', 'background-color': 'rgb(255, 248, 204)',
            color: 'rebeccapurple', '-webkit-text-fill-color': 'currentColor',
            '--fluent-read-translation-surface-ink': '#000000',
        });
        expect(getTranslationAppearanceStyle({customCss: 'background-color: #fff; background: navy'}))
            .toMatchObject({'--fluent-read-translation-surface-ink': '#ffffff'});
        expect(buildTranslationAppearanceCss({backgroundColor: '#123456'}))
            .toContain('--fluent-read-translation-surface-ink: #ffffff !important;');
    });

    it.each(['transparent', 'inherit', 'linear-gradient(red, blue)', 'rgba(255, 255, 255, 0.5)', 'rgba(0, 0, 0, 50%)',
        'rgba(0, 0, 0, -0.1)', 'hsla(0, 0%, 0%, -10%)', 'rgb(0, 0, 0, .5)', 'oklch(0.8 0.1 200)', 'none'])
    ('最终复杂或透明背景 %s 不借用先前纯色配正文', (background) => {
        const style = getTranslationAppearanceStyle({
            backgroundColor: '#ffffff', customCss: `background-color: navy; background: ${background}`,
        });
        expect(style.background).toBe(background);
        expect(style).not.toHaveProperty('--fluent-read-translation-surface-ink');
    });

    it('无背景微调保留原预设，底色微调使用浅纸面黑字', () => {
        expect(getTranslationAppearanceStyle({fillColor: '#4ade80'}))
            .toHaveProperty('--fluent-read-translation-surface-ink', '#000000');
        expect(getTranslationAppearanceStyle(undefined)).toEqual({});
    });

    it.each([
        {background: 'rgba(255, 255, 255, 1)', ink: '#000000'},
        {background: 'rgba(0, 0, 0, 100%)', ink: '#ffffff'},
        {background: 'rgba(0, 0, 0, 2)', ink: '#ffffff'},
        {background: 'hsl(240, 100%, 10%)', ink: '#ffffff'},
        {background: 'hsla(0, 0%, 100%, 1)', ink: '#000000'},
        {background: '#000f', ink: '#ffffff'},
        {background: '#ffffffff', ink: '#000000'},
    ])('不透明CSS背景 $background 使用 $ink 正文', ({background, ink}) => {
        expect(getTranslationAppearanceStyle({customCss: `background: ${background}`}))
            .toHaveProperty('--fluent-read-translation-surface-ink', ink);
    });

    it('无效背景不覆盖前面纯色，显式图层直到完整背景重置才恢复纯色配对', () => {
        for (const invalid of ['invalid-color', 'abc', '#abcde', 'rgb(1, 2, 3) nonsense']) {
            expect(getTranslationAppearanceStyle({backgroundColor: 'navy', customCss: `background: ${invalid}`}))
                .toHaveProperty('--fluent-read-translation-surface-ink', '#ffffff');
        }
        expect(getTranslationAppearanceStyle({customCss: 'background: linear-gradient(red, blue); background-color: white'}))
            .not.toHaveProperty('--fluent-read-translation-surface-ink');
        expect(getTranslationAppearanceStyle({customCss: 'background: linear-gradient(red, blue); background: white'}))
            .toHaveProperty('--fluent-read-translation-surface-ink', '#000000');
        expect(getTranslationAppearanceStyle({customCss: 'background: none; background-color: navy'}))
            .toHaveProperty('--fluent-read-translation-surface-ink', '#ffffff');
        expect(getTranslationAppearanceStyle({customCss: 'background-color: inherit'}))
            .not.toHaveProperty('--fluent-read-translation-surface-ink');
        expect(getTranslationAppearanceStyle({backgroundColor: 'navy', customCss: 'background-color: invalid-color'}))
            .toHaveProperty('--fluent-read-translation-surface-ink', '#ffffff');
    });

    it.each(['none', 'initial', 'unset', 'currentcolor'])('背景重置 %s 清空图层，后续纯色可以重新配对正文', (reset) => {
        expect(getTranslationAppearanceStyle({
            customCss: `background: linear-gradient(red, blue); background: ${reset}; background-color: white`,
        })).toHaveProperty('--fluent-read-translation-surface-ink', '#000000');
        expect(getTranslationAppearanceStyle({customCss: `background: ${reset}`}))
            .not.toHaveProperty('--fluent-read-translation-surface-ink');
    });

    it('预览对象保留重复背景的最终声明次序，与网页样式表配对一致', () => {
        const dark = getTranslationAppearanceStyle({
            backgroundColor: '#fff', customCss: 'background-color: #fff; background: #000',
        });
        expect(Object.keys(dark).filter(key => key === 'background' || key === 'background-color'))
            .toEqual(['background-color', 'background']);
        expect(dark).toHaveProperty('--fluent-read-translation-surface-ink', '#ffffff');
        const light = getTranslationAppearanceStyle({
            backgroundColor: '#fff', customCss: 'background-color: #000; background: #000; background-color: #fff',
        });
        expect(Object.keys(light).filter(key => key === 'background' || key === 'background-color'))
            .toEqual(['background', 'background-color']);
        expect(light).toHaveProperty('--fluent-read-translation-surface-ink', '#000000');
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

// 直接校验内容脚本与设置预览共同读取的真实 CSS；以下颜色计算只属于回归夹具，不新增生产实现。
describe('共享颜色预设在代表网页配色中的正文对比度', () => {
    const scenarios = [
        {name: '浅色网页深蓝文字', background: '#ffffff', parent: '#172033', forestGreenContrast: 10},
        {name: '浅色网页中性文字', background: '#ffffff', parent: '#1f2328', forestGreenContrast: 10},
        {name: '深色网页浅色文字', background: '#17191e', parent: '#e5e7eb', forestGreenContrast: 7},
    ];

    async function sharedCss(): Promise<string> {
        const {readFileSync} = await import('node:fs');
        return readFileSync(new URL('../src/ui/styles/translation-display.css', import.meta.url), 'utf8');
    }

    function ruleBody(css: string, selector: string): string {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
        expect(match, `缺少共享样式规则 ${selector}`).not.toBeNull();
        return match![1];
    }

    function rgb(hex: string): number[] {
        return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
    }

    function mix(base: readonly number[], parent: readonly number[], weight: number): number[] {
        return base.map((channel, index) => channel * weight + parent[index] * (1 - weight));
    }

    function luminance(color: readonly number[]): number {
        const linear = color.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }

    function contrast(foreground: readonly number[], background: readonly number[]): number {
        const [darker, lighter] = [luminance(foreground), luminance(background)].sort((left, right) => left - right);
        return (lighter + 0.05) / (darker + 0.05);
    }

    function colorMixStops(rule: string): Array<{base: number[]; weight: number}> {
        return [...rule.matchAll(/color-mix\(\s*in\s+srgb,\s*(#[\da-f]{6})\s+(\d+(?:\.\d+)?)%,\s*(?:currentColor|var\(--fluent-read-translation-inherited-color\))\s*\)/giu)]
            .map(match => ({base: rgb(match[1]), weight: Number(match[2]) / 100}));
    }

    function gradientSamples(stops: readonly number[][]): number[][] {
        return stops.slice(1).flatMap((stop, index) => Array.from({length: 257}, (_, sample) => mix(stop, stops[index], sample / 256)));
    }

    it('九种纯色在浅深网页上均达到 4.5 正文对比度，森林绿达到更高对比度', async () => {
        const css = await sharedCss();
        expect(ruleBody(css, '.fluent-read-bilingual-content')).toContain('--fluent-read-translation-inherited-color: currentColor;');
        const solids = TRANSLATION_STYLE_PRESETS.filter(({value}) => value >= 49 && value <= 57);
        expect(solids.map(({value}) => value)).toEqual([49, 50, 51, 52, 53, 54, 55, 56, 57]);
        for (const preset of solids) {
            const body = ruleBody(css, `.fluent-read-bilingual-content.${preset.className}`);
            expect(body).toContain('var(--fluent-read-translation-inherited-color)');
            const stops = colorMixStops(body);
            expect(stops, preset.label).toHaveLength(1);
            const isForestGreen = preset.value === 49;
            expect(stops[0].weight, preset.label).toBe(isForestGreen ? 0.4 : 0.6);
            for (const scenario of scenarios) {
                const foreground = mix(stops[0].base, rgb(scenario.parent), stops[0].weight);
                const minimumContrast = isForestGreen ? scenario.forestGreenContrast : 4.5;
                expect(contrast(foreground, rgb(scenario.background)), `${preset.label} / ${scenario.name}`).toBeGreaterThanOrEqual(minimumContrast);
            }
        }
    });

    it('渐变文字读取真实三色停靠点并检查中间段，避免只检查端点漏掉深色网页的对比度下降', async () => {
        const body = ruleBody(await sharedCss(), '.fluent-display-gradient-text');
        const stops = colorMixStops(body);
        expect(stops).toHaveLength(3);
        expect(stops.map(({weight}) => weight)).toEqual([0.72, 0.72, 0.72]);
        expect(body).toMatch(/(?:-webkit-)?background-clip:\s*text/u);
        expect(body).toContain('-webkit-text-fill-color: transparent;');
        for (const scenario of scenarios) {
            const colors = stops.map(({base, weight}) => mix(base, rgb(scenario.parent), weight));
            const minimum = Math.min(...gradientSamples(colors).map(color => contrast(color, rgb(scenario.background))));
            expect(minimum, `渐变文字 / ${scenario.name}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('霓虹微光沿用可读的网页文字，彩虹荧光在真实半透明渐变背景合成后仍达到 4.5', async () => {
        const css = await sharedCss();
        expect(ruleBody(css, '.fluent-read-bilingual-content')).toMatch(/^\s*color:\s*inherit\s*;/mu);
        const neon = ruleBody(css, '.fluent-display-neon');
        const marker = ruleBody(css, '.fluent-display-rainbow-marker');
        const inlineMarker = ruleBody(css, '.fluent-display-rainbow-marker > .fluent-read-translation-text');
        const foregroundOverride = /(?:^|;)\s*(?:color|-webkit-text-fill-color|opacity|filter)\s*:/u;
        expect(neon).toContain('text-shadow:');
        for (const body of [neon, marker, inlineMarker]) expect(body).not.toMatch(foregroundOverride);
        expect(marker).toContain('background: transparent;');
        expect(inlineMarker).toContain('background: linear-gradient(');
        const stops = [...inlineMarker.matchAll(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0?\.\d+|1)\s*\)/gu)]
            .map(match => ({color: match.slice(1, 4).map(channel => Number(channel) / 255), alpha: Number(match[4])}));
        expect(stops).toHaveLength(5);
        for (const scenario of scenarios) {
            const foreground = rgb(scenario.parent), background = rgb(scenario.background);
            expect(contrast(foreground, background), `霓虹文字 / ${scenario.name}`).toBeGreaterThanOrEqual(4.5);
            // 先按真实 alpha 与页面合成停靠点，再采样相邻段；同一页面背景下等价于预乘 alpha 插值后合成。
            const backgrounds = stops.map(({color, alpha}) => mix(color, background, alpha));
            const minimum = Math.min(...gradientSamples(backgrounds).map(color => contrast(foreground, color)));
            expect(minimum, `彩虹荧光 / ${scenario.name}`).toBeGreaterThanOrEqual(4.5);
        }
    });
});

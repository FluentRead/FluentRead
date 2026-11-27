import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE, getVideoSentenceLearningAppearanceCssVars, normalizeVideoSentenceLearningAppearance} from '@/src/core/config/videoSentenceLearningAppearance';
import {buildConfigDiff, configDiffFieldLabel} from '@/src/core/config/diff';
import {parseStoredConfig, serializeConfig} from '@/src/services/config/schema';
import {filterSettingsSearchTargets, resolveSettingsPanel, settingsPagePanels} from '@/src/features/settings/model/navigation';

describe('完整句学习独立外观配置边界', () => {
    it('旧配置和非对象输入默认紧凑右上，默认对象不会被用户编辑污染', () => {
        for (const value of [undefined, null, 0, true, 'compact', Symbol('invalid'), [], {}]) {
            expect(normalizeVideoSentenceLearningAppearance(value)).toEqual(DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE);
        }
        const first = new Config(), second = new Config();
        first.videoSentenceLearningAppearance.width = 440;
        expect(second.videoSentenceLearningAppearance.width).toBe(360);
        expect(DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE.width).toBe(360);
        expect(normalizeConfig({videoSubtitleAppearance: {fontScale: 300, backgroundOpacity: 0}}).videoSentenceLearningAppearance).toEqual(DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE);
    });

    it('四角与两种布局可以往返，过期枚举和拖动坐标不进入配置', () => {
        for (const position of ['top-right', 'top-left', 'bottom-right', 'bottom-left'] as const) {
            for (const layout of ['compact', 'comfortable'] as const) {
                const input = {position, layout, width: 470, fontScale: 121, backgroundOpacity: 73, x: 400, y: 100};
                const normalized = normalizeVideoSentenceLearningAppearance(input);
                expect(normalized).toEqual({position, layout, width: 470, fontScale: 121, backgroundOpacity: 73});
                expect(normalizeVideoSentenceLearningAppearance(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
                expect(input.x).toBe(400);
            }
        }
        expect(normalizeVideoSentenceLearningAppearance({position: 'center', layout: 'old'})).toEqual(DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE);
    });

    it('数值控件接受整数和数字字符串，有界归一化拒绝非法值与 CSS 注入', () => {
        for (const value of [NaN, Infinity, -Infinity, '', ' ', 'bad', '100; opacity:0', null, {}, true]) {
            expect(normalizeVideoSentenceLearningAppearance({backgroundOpacity: value, fontScale: value, width: value})).toEqual(DEFAULT_VIDEO_SENTENCE_LEARNING_APPEARANCE);
        }
        expect(normalizeVideoSentenceLearningAppearance({backgroundOpacity: ' 78.7 ', fontScale: '119.2', width: '469.5'})).toMatchObject({backgroundOpacity: 79, fontScale: 119, width: 470});
        expect(normalizeVideoSentenceLearningAppearance({backgroundOpacity: -1, fontScale: 0, width: 20})).toMatchObject({backgroundOpacity: 60, fontScale: 90, width: 300});
        expect(normalizeVideoSentenceLearningAppearance({backgroundOpacity: 101, fontScale: 200, width: 1000})).toMatchObject({backgroundOpacity: 100, fontScale: 130, width: 520});
    });

    it('复用背景 alpha 和内容字号，紧凑与舒适间距不影响媒体速度', () => {
        expect(getVideoSentenceLearningAppearanceCssVars(undefined)).toEqual({
            '--fluent-read-video-learning-width': '360px',
            '--fluent-read-video-learning-font-size': '13px',
            '--fluent-read-video-learning-original-font-size': '17px',
            '--fluent-read-video-learning-background': 'rgba(24,24,28,0.94)',
            '--fluent-read-video-learning-gap': '8px',
            '--fluent-read-video-learning-padding': '12px',
            '--fluent-read-video-learning-line-height': '1.45',
            '--fluent-read-video-learning-control-height': '30px',
        });
        expect(getVideoSentenceLearningAppearanceCssVars({layout: 'comfortable', fontScale: 120, width: 420, backgroundOpacity: 60})).toEqual({
            '--fluent-read-video-learning-width': '420px',
            '--fluent-read-video-learning-font-size': '15.6px',
            '--fluent-read-video-learning-original-font-size': '22.8px',
            '--fluent-read-video-learning-background': 'rgba(24,24,28,0.6)',
            '--fluent-read-video-learning-gap': '12px',
            '--fluent-read-video-learning-padding': '16px',
            '--fluent-read-video-learning-line-height': '1.6',
            '--fluent-read-video-learning-control-height': '36px',
        });
    });

    it('公开配置序列化后重开保留独立样式，不改变已有字幕偏好', () => {
        const saved = normalizeConfig({videoSentenceLearningAppearance: {layout: 'comfortable', position: 'bottom-left', width: 430, fontScale: 118, backgroundOpacity: 80}, videoSubtitleAppearance: {fontScale: 300, backgroundOpacity: 56}});
        const reopened = normalizeConfig(parseStoredConfig(serializeConfig(saved)));
        expect(reopened.videoSentenceLearningAppearance).toEqual(saved.videoSentenceLearningAppearance);
        expect(reopened.videoSubtitleAppearance).toEqual(saved.videoSubtitleAppearance);
        expect(configDiffFieldLabel('videoSentenceLearningAppearance')).toBe('完整句学习外观');
        const diff = buildConfigDiff(new Config(), reopened);
        expect(diff.groups.find(group => group.id === 'videoSubtitles')?.changes.some(change => change.key === 'videoSentenceLearningAppearance' && change.label === '完整句学习外观')).toBe(true);
    });

    it('视频字幕页有独立可搜索分类与深链接，不路由到字幕显示样式', () => {
        expect(resolveSettingsPanel('settings-video', 'video-sentence-learning-appearance')).toBe('video-learning');
        expect(settingsPagePanels['settings-video'].find(panel => panel.id === 'video-learning')).toMatchObject({labelKey: 'options.panel.videoLearning', targetIds: ['video-sentence-learning-appearance']});
        for (const query of ['完整句学习外观', '面板宽度', '拖动位置']) {
            expect(filterSettingsSearchTargets(query)).toEqual([expect.objectContaining({sectionId: 'settings-video', targetId: 'video-sentence-learning-appearance'})]);
        }
        expect(resolveSettingsPanel('settings-video', 'appearance')).toBe('appearance');
    });
});

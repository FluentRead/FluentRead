import {describe, expect, it} from 'vitest';
import {
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY,
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY_ACTION,
    VIDEO_SUBTITLE_MODE_HOTKEY_ACTIONS,
    VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS,
    isSupportedCustomVideoSubtitleModeHotkey,
    matchesVideoSubtitleModeHotkey,
    normalizeCustomVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkeyAction,
    resolveNextVideoSubtitleMenuMode,
    resolveReservedVideoSubtitleModeHotkey,
    resolveVideoSubtitleModeHotkey,
    videoSubtitleModeHotkeyDisplayName,
} from '@/src/core/config/videoSubtitleShortcut';
import {
    videoSubtitleShortcutChineseMessages,
    videoSubtitleShortcutMessages,
} from '@/src/core/i18n/messages/videoSubtitleShortcut';
import {DEFAULT_AREA_TRANSLATION_HOTKEY} from '@/src/core/config/areaTranslation';
import {DEFAULT_CLICK_SELECTION_HOTKEY, findClickSelectionHotkeyConflict} from '@/src/core/config/clickSelection';
import {DEFAULT_PARAGRAPH_COPY_HOTKEY} from '@/src/core/config/paragraphCopy';
import {DEFAULT_SECTION_TRANSLATION_HOTKEY} from '@/src/core/config/sectionTranslation';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {buildConfigDiff} from '@/src/core/config/diff';

function keyboardEvent(overrides: Record<string, unknown> = {}): KeyboardEvent {
    return {
        key: 'm',
        code: 'KeyM',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...overrides,
    } as unknown as KeyboardEvent;
}

describe('视频字幕显示模式切换快捷键配置', () => {
    it('默认组合键避开其他功能默认快捷键和浏览器菜单键，预设全部带修饰键', () => {
        expect(DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY).toBe('Alt+M');
        expect(DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY_ACTION).toBe('bilingual-original');
        const presets = VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS.map((option) => option.value);
        expect(presets).toContain(DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY);
        for (const occupied of [
            'Alt+T',
            DEFAULT_PARAGRAPH_COPY_HOTKEY,
            DEFAULT_AREA_TRANSLATION_HOTKEY,
            DEFAULT_SECTION_TRANSLATION_HOTKEY,
            DEFAULT_CLICK_SELECTION_HOTKEY,
            'Alt+E',
            'Alt+F',
            'Alt+S',
        ]) {
            expect(presets).not.toContain(occupied);
        }
        for (const option of VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS) {
            expect(option.value).toMatch(/^(?:Alt|Shift|Ctrl)\+/u);
            expect(option.label.length).toBeGreaterThan(0);
        }
    });

    it('预设只接受列表内的组合键，其余取值回到默认值', () => {
        expect(normalizeVideoSubtitleModeHotkey('custom')).toBe('custom');
        expect(normalizeVideoSubtitleModeHotkey('alt+b')).toBe('Alt+B');
        expect(normalizeVideoSubtitleModeHotkey('Ctrl+Alt+M')).toBe('Ctrl+Alt+M');
        for (const invalid of [undefined, 42, 'none', 'Ctrl+C', 'm']) {
            expect(normalizeVideoSubtitleModeHotkey(invalid)).toBe(DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY);
        }
    });

    it('自定义组合键仅允许带修饰键或功能键，单键与非法值拦截并留空', () => {
        expect(isSupportedCustomVideoSubtitleModeHotkey('alt+k')).toBe(true);
        expect(isSupportedCustomVideoSubtitleModeHotkey('F8')).toBe(true);
        expect(isSupportedCustomVideoSubtitleModeHotkey('ctrl+shift+f12')).toBe(true);
        for (const unsupported of [undefined, null, 7, '', 'm', '0', '/', 'Space', 'Enter', 'Cmd+M', 'Ctrl+Launch']) {
            expect(isSupportedCustomVideoSubtitleModeHotkey(unsupported)).toBe(false);
            expect(normalizeCustomVideoSubtitleModeHotkey(unsupported)).toBe('');
        }
        expect(normalizeCustomVideoSubtitleModeHotkey('alt+k')).toBe('Alt+K');
        expect(normalizeCustomVideoSubtitleModeHotkey('f8')).toBe('F8');
    });

    it('仅在视频翻译未关闭且模式快捷键开启时保留组合键', () => {
        expect(resolveReservedVideoSubtitleModeHotkey({
            videoTranslationEnabled: true,
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'Alt+M',
        })).toBe('Alt+M');
        expect(resolveReservedVideoSubtitleModeHotkey({
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'custom',
            customVideoSubtitleModeHotkey: 'Alt+K',
        })).toBe('Alt+K');
        expect(resolveReservedVideoSubtitleModeHotkey({
            videoTranslationEnabled: false,
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'Alt+M',
        })).toBe('');
        expect(resolveReservedVideoSubtitleModeHotkey({
            videoTranslationEnabled: true,
            videoSubtitleModeHotkeyEnabled: false,
            videoSubtitleModeHotkey: 'Alt+M',
        })).toBe('');
        expect(resolveReservedVideoSubtitleModeHotkey({})).toBe('');
    });

    it('选择自定义却没有录制成功时回到默认值，展示名称跟随平台写法', () => {
        expect(resolveVideoSubtitleModeHotkey('Shift+B', 'Alt+K')).toBe('Shift+B');
        expect(resolveVideoSubtitleModeHotkey('custom', 'alt+k')).toBe('Alt+K');
        expect(resolveVideoSubtitleModeHotkey('custom', '')).toBe(DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY);
        expect(videoSubtitleModeHotkeyDisplayName('custom', 'alt+k')).toMatch(/^(?:Alt|Option)\+K$/u);
        expect(videoSubtitleModeHotkeyDisplayName('Alt+M', '')).toMatch(/^(?:Alt|Option)\+M$/u);
    });

    it('按键匹配要求修饰键完全一致，命中单槽编译缓存、支持 IME Process 回退并在配置变化时失效缓存', () => {
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true}), 'Alt+M', '')).toBe(true);
        // 连续相同参数命中单槽编译缓存
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, key: 'µ'}), 'Alt+M', '')).toBe(true);
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, key: 'Process', code: 'KeyM'}), 'Alt+M', '')).toBe(true);
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, shiftKey: true}), 'Alt+M', '')).toBe(false);
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({ctrlKey: true}), 'Alt+M', '')).toBe(false);
        // rawHotkey 变化失效缓存
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, key: 'k', code: 'KeyK'}), 'custom', 'Alt+K')).toBe(true);
        // rawCustomHotkey 变化失效缓存
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, key: 'j', code: 'KeyJ'}), 'custom', 'Alt+J')).toBe(true);
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, key: 'k', code: 'KeyK'}), 'custom', 'Alt+J')).toBe(false);
    });

    it('切换方式只接受既定取值，异常输入回落到双语与原文往返', () => {
        for (const action of VIDEO_SUBTITLE_MODE_HOTKEY_ACTIONS) {
            expect(normalizeVideoSubtitleModeHotkeyAction(action)).toBe(action);
        }
        for (const invalid of [undefined, null, '', 'invalid', 123]) {
            expect(normalizeVideoSubtitleModeHotkeyAction(invalid)).toBe('bilingual-original');
        }
    });

    it('按切换方式准确计算下一个字幕模式', () => {
        // 双语 ↔ 原文：原文/译文/关闭均直切双语，双语直切原文
        expect(resolveNextVideoSubtitleMenuMode('original-only', true, 'bilingual-original')).toBe('bilingual');
        expect(resolveNextVideoSubtitleMenuMode('bilingual', true, 'bilingual-original')).toBe('original-only');
        expect(resolveNextVideoSubtitleMenuMode('translation-only', true, 'bilingual-original')).toBe('bilingual');
        expect(resolveNextVideoSubtitleMenuMode('bilingual', false, 'bilingual-original')).toBe('bilingual');

        // 听力练习（关 → 原文 → 双语 → 关）；仅译文时切回仅原文
        expect(resolveNextVideoSubtitleMenuMode('bilingual', false, 'listening-cycle')).toBe('original-only');
        expect(resolveNextVideoSubtitleMenuMode('original-only', false, 'listening-cycle')).toBe('original-only');
        expect(resolveNextVideoSubtitleMenuMode('original-only', true, 'listening-cycle')).toBe('bilingual');
        expect(resolveNextVideoSubtitleMenuMode('bilingual', true, 'listening-cycle')).toBe('off');
        expect(resolveNextVideoSubtitleMenuMode('translation-only', true, 'listening-cycle')).toBe('original-only');

        // 显示 ↔ 关闭（保留当前模式）
        expect(resolveNextVideoSubtitleMenuMode('bilingual', true, 'toggle-visibility')).toBe('off');
        expect(resolveNextVideoSubtitleMenuMode('original-only', true, 'toggle-visibility')).toBe('off');
        expect(resolveNextVideoSubtitleMenuMode('translation-only', true, 'toggle-visibility')).toBe('off');
        expect(resolveNextVideoSubtitleMenuMode('bilingual', false, 'toggle-visibility')).toBe('bilingual');
        expect(resolveNextVideoSubtitleMenuMode('original-only', false, 'toggle-visibility')).toBe('original-only');
        expect(resolveNextVideoSubtitleMenuMode('translation-only', false, 'toggle-visibility')).toBe('translation-only');

        // 循环切换（不含关闭）：关闭时先恢复当前显示模式；可见时按 双语 → 译文 → 原文 循环
        expect(resolveNextVideoSubtitleMenuMode('original-only', false, 'cycle-display')).toBe('original-only');
        expect(resolveNextVideoSubtitleMenuMode('bilingual', true, 'cycle-display')).toBe('translation-only');
        expect(resolveNextVideoSubtitleMenuMode('translation-only', true, 'cycle-display')).toBe('original-only');
        expect(resolveNextVideoSubtitleMenuMode('original-only', true, 'cycle-display')).toBe('bilingual');

        // 循环切换（含关闭）：双语 → 译文 → 原文 → 关闭 → 双语
        expect(resolveNextVideoSubtitleMenuMode('bilingual', true, 'cycle-all')).toBe('translation-only');
        expect(resolveNextVideoSubtitleMenuMode('translation-only', true, 'cycle-all')).toBe('original-only');
        expect(resolveNextVideoSubtitleMenuMode('original-only', true, 'cycle-all')).toBe('off');
        expect(resolveNextVideoSubtitleMenuMode('original-only', false, 'cycle-all')).toBe('bilingual');
    });

    it('Config 规范化、两点选取冲突检测和配置差异摘要同步识别视频字幕模式快捷键', () => {
        const normalized = normalizeConfig({
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'custom',
            customVideoSubtitleModeHotkey: '',
            videoSubtitleModeHotkeyAction: 'cycle-all',
            quickTranslationProfiles: [{
                id: 'p1',
                name: 'Quick',
                action: 'full-page',
                enabled: true,
                hotkey: 'Alt+M',
                service: 'google',
                targetLanguage: 'zh-Hans',
                displayMode: 'default',
                fullPageMode: 'default',
                glossaryIds: [],
            }],
        });
        expect(normalized.videoSubtitleModeHotkeyEnabled).toBe(true);
        expect(normalized.videoSubtitleModeHotkey).toBe('Alt+M');
        expect(normalized.videoSubtitleModeHotkeyAction).toBe('cycle-all');
        expect(normalized.quickTranslationProfiles[0]?.enabled).toBe(false);

        const customNormalized = normalizeConfig({
            videoSubtitleModeHotkeyEnabled: 'bad' as unknown as boolean,
            videoSubtitleModeHotkey: 'custom',
            customVideoSubtitleModeHotkey: 'alt+k',
        });
        expect(customNormalized.videoSubtitleModeHotkeyEnabled).toBe(false);
        expect(customNormalized.videoSubtitleModeHotkey).toBe('custom');
        expect(customNormalized.customVideoSubtitleModeHotkey).toBe('Alt+K');

        expect(findClickSelectionHotkeyConflict({
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'Alt+M',
            customVideoSubtitleModeHotkey: '',
        }, 'Alt+M')).toBe('视频字幕显示模式切换');
        expect(findClickSelectionHotkeyConflict({
            videoSubtitleModeHotkeyEnabled: false,
            videoSubtitleModeHotkey: 'Alt+M',
            customVideoSubtitleModeHotkey: '',
        }, 'Alt+M')).toBe('');
        expect(findClickSelectionHotkeyConflict({
            videoTranslationEnabled: false,
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'Alt+M',
            customVideoSubtitleModeHotkey: '',
        }, 'Alt+M')).toBe('');

        const videoDisabledNormalized = normalizeConfig({
            videoTranslationEnabled: false,
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'Alt+M',
            quickTranslationProfiles: [{
                id: 'p1',
                name: 'Quick',
                action: 'full-page',
                enabled: true,
                hotkey: 'Alt+M',
                service: 'google',
                targetLanguage: 'zh-Hans',
                displayMode: 'default',
                fullPageMode: 'default',
                glossaryIds: [],
            }],
        });
        expect(videoDisabledNormalized.quickTranslationProfiles[0]?.enabled).toBe(true);

        const before = new Config();
        const after = normalizeConfig({
            ...before,
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'custom',
            customVideoSubtitleModeHotkey: 'Alt+K',
            videoSubtitleModeHotkeyAction: 'cycle-display',
        });
        const diffs = buildConfigDiff(before, after).groups.flatMap((group) => group.changes);
        expect(diffs.find((item) => item.key === 'videoSubtitleModeHotkeyEnabled')?.after).toBe('开启');
        expect(diffs.find((item) => item.key === 'videoSubtitleModeHotkey')?.after).toBe('自定义快捷键');
        expect(diffs.find((item) => item.key === 'customVideoSubtitleModeHotkey')?.after).toBe('Alt+K');
        expect(diffs.find((item) => item.key === 'videoSubtitleModeHotkeyAction')?.after).toBe('双语 → 译文 → 原文');

        const listeningDiffs = buildConfigDiff(before, normalizeConfig({...before, videoSubtitleModeHotkeyAction: 'listening-cycle'})).groups.flatMap((group) => group.changes);
        expect(listeningDiffs.find((item) => item.key === 'videoSubtitleModeHotkeyAction')?.after).toBe('听力练习（关 → 原文 → 双语）');
        const toggleDiffs = buildConfigDiff(before, normalizeConfig({...before, videoSubtitleModeHotkeyAction: 'toggle-visibility'})).groups.flatMap((group) => group.changes);
        expect(toggleDiffs.find((item) => item.key === 'videoSubtitleModeHotkeyAction')?.after).toBe('显示 ↔ 关闭');
    });

    it('模块化视频字幕快捷键八语文案键集与占位符完全一致且非空', () => {
        const expectedKeys = Object.keys(videoSubtitleShortcutChineseMessages).sort();
        expect(expectedKeys).toHaveLength(16);
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
        for (const [language, catalog] of Object.entries(videoSubtitleShortcutMessages)) {
            expect(Object.keys(catalog).sort(), language).toEqual(expectedKeys);
            for (const key of expectedKeys) {
                expect(catalog[key].trim(), `${language}:${key}`).not.toBe('');
                expect(placeholders(catalog[key]), `${language}:${key}`).toEqual(
                    placeholders(videoSubtitleShortcutChineseMessages[key as keyof typeof videoSubtitleShortcutChineseMessages]),
                );
            }
        }
    });
});

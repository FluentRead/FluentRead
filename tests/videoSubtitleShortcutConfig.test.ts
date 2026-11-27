import {describe, expect, it} from 'vitest';
import {
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY,
    DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY_ACTION,
    VIDEO_SUBTITLE_MODE_HOTKEY_ACTIONS,
    VIDEO_SUBTITLE_MODE_HOTKEY_OPTIONS,
    matchesVideoSubtitleModeHotkey,
    normalizeCustomVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkey,
    normalizeVideoSubtitleModeHotkeyAction,
    resolveNextVideoSubtitleMenuMode,
    resolveVideoSubtitleModeHotkey,
    videoSubtitleModeHotkeyDisplayName,
} from '@/src/core/config/videoSubtitleShortcut';
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

    it('自定义组合键保存为规范写法，无法解析时留空', () => {
        expect(normalizeCustomVideoSubtitleModeHotkey('alt+k')).toBe('Alt+K');
        expect(normalizeCustomVideoSubtitleModeHotkey('')).toBe('');
        expect(normalizeCustomVideoSubtitleModeHotkey(undefined)).toBe('');
        expect(normalizeCustomVideoSubtitleModeHotkey(7)).toBe('');
    });

    it('选择自定义却没有录制成功时回到默认值，展示名称跟随平台写法', () => {
        expect(resolveVideoSubtitleModeHotkey('Shift+B', 'Alt+K')).toBe('Shift+B');
        expect(resolveVideoSubtitleModeHotkey('custom', 'alt+k')).toBe('Alt+K');
        expect(resolveVideoSubtitleModeHotkey('custom', '')).toBe(DEFAULT_VIDEO_SUBTITLE_MODE_HOTKEY);
        expect(videoSubtitleModeHotkeyDisplayName('custom', 'alt+k')).toMatch(/^(?:Alt|Option)\+K$/u);
        expect(videoSubtitleModeHotkeyDisplayName('Alt+M', '')).toMatch(/^(?:Alt|Option)\+M$/u);
    });

    it('按键匹配要求修饰键完全一致，Mac 上 Option 改写的字符按物理键匹配', () => {
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true}), 'Alt+M', '')).toBe(true);
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, key: 'µ'}), 'Alt+M', '')).toBe(true);
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, shiftKey: true}), 'Alt+M', '')).toBe(false);
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({ctrlKey: true}), 'Alt+M', '')).toBe(false);
        expect(matchesVideoSubtitleModeHotkey(keyboardEvent({altKey: true, key: 'k', code: 'KeyK'}), 'custom', 'Alt+K')).toBe(true);
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
    });
});

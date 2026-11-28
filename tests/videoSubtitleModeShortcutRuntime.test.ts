import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const pageNoticeMock = vi.hoisted(() => ({
    showPageNotice: vi.fn(),
    dismissPageNotice: vi.fn(),
}));
vi.mock('@/src/features/page-notice/public', () => pageNoticeMock);

import {
    clearVideoSubtitleModeNotice,
    handleVideoSubtitleModeShortcutKeydown,
    notifyVideoSubtitleModeSwitch,
    videoSubtitleModeLabelKey,
    type VideoSubtitleModeShortcutPorts,
} from '@/src/features/video-subtitle/content/modeShortcut';
import {
    getActiveVideoSubtitleModeController,
    registerActiveVideoSubtitleModeController,
    type ActiveVideoSubtitleModeController,
} from '@/src/features/video-subtitle/content/activeModeController';

function createKeyEvent(overrides: Record<string, unknown> = {}): KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
    stopImmediatePropagation: ReturnType<typeof vi.fn>;
} {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const stopImmediatePropagation = vi.fn();
    return {
        isTrusted: true,
        repeat: false,
        isComposing: false,
        defaultPrevented: false,
        key: 'm',
        code: 'KeyM',
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        preventDefault,
        stopPropagation,
        stopImmediatePropagation,
        composedPath: () => [],
        ...overrides,
    } as unknown as KeyboardEvent & {
        preventDefault: ReturnType<typeof vi.fn>;
        stopPropagation: ReturnType<typeof vi.fn>;
        stopImmediatePropagation: ReturnType<typeof vi.fn>;
    };
}

describe('视频字幕显示模式快捷键运行时处理', () => {
    it('返回与播放器菜单一致的模式文案键，并通过统一提示键展示与清理切换反馈', () => {
        expect(videoSubtitleModeLabelKey('bilingual')).toBe('video.modeBilingual');
        expect(videoSubtitleModeLabelKey('translation-only')).toBe('video.modeTranslation');
        expect(videoSubtitleModeLabelKey('original-only')).toBe('video.modeOriginal');
        expect(videoSubtitleModeLabelKey('off')).toBe('video.modeOff');

        notifyVideoSubtitleModeSwitch('bilingual', (key, params) => params ? `${key}:${params.mode}` : key);
        expect(pageNoticeMock.showPageNotice).toHaveBeenCalledWith(
            'video.modeShortcut.switched:video.modeBilingual',
            'success',
            {key: 'video-subtitle-mode', durationMs: 1600},
        );
        notifyVideoSubtitleModeSwitch('original-only', (key, params) => params ? `${key}:${params.mode}:${params.shortcut ?? ''}` : key, '  ');
        expect(pageNoticeMock.showPageNotice).toHaveBeenLastCalledWith(
            'video.modeShortcut.switched:video.modeOriginal:',
            'success',
            {key: 'video-subtitle-mode', durationMs: 1600},
        );
        notifyVideoSubtitleModeSwitch('original-only', (key, params) => params ? `${key}:${params.mode}:${params.shortcut ?? ''}` : key, 'Alt+M');
        expect(pageNoticeMock.showPageNotice).toHaveBeenLastCalledWith(
            'video.modeShortcut.switchedWithKey:video.modeOriginal:Alt+M',
            'success',
            {key: 'video-subtitle-mode', durationMs: 1600},
        );
        clearVideoSubtitleModeNotice();
        expect(pageNoticeMock.dismissPageNotice).toHaveBeenCalledWith('video-subtitle-mode');
    });

    it('启用快捷键并按下匹配组合键时切换模式、阻止事件并触发提示', () => {
        const {document} = parseHTML('<html><body><div id="player" tabindex="-1"></div></body></html>');
        const applyMode = vi.fn();
        const notify = vi.fn();
        const ports: VideoSubtitleModeShortcutPorts = {
            document: document as unknown as Document,
            config: {
                videoSubtitleModeHotkeyEnabled: true,
                videoSubtitleModeHotkey: 'Alt+M',
                customVideoSubtitleModeHotkey: '',
                videoSubtitleModeHotkeyAction: 'bilingual-original',
                videoSubtitleDisplayMode: 'original-only',
            },
            isActive: () => true,
            isVisible: () => true,
            applyMode,
            notify,
        };

        const event = createKeyEvent();
        expect(handleVideoSubtitleModeShortcutKeydown(event, ports)).toBe(true);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(event.stopImmediatePropagation).toHaveBeenCalledTimes(1);
        expect(applyMode).toHaveBeenCalledWith('bilingual');
        expect(notify).toHaveBeenCalledWith('bilingual');
    });

    it('未提供 notify 且当前模式异常时按默认双语处理，并支持全部循环模式', () => {
        const {document} = parseHTML('<html><body></body></html>');
        const applyMode = vi.fn();
        const event = createKeyEvent({key: 'b', code: 'KeyB', altKey: true});

        const handled = handleVideoSubtitleModeShortcutKeydown(event, {
            document: document as unknown as Document,
            config: {
                videoSubtitleModeHotkeyEnabled: true,
                videoSubtitleModeHotkey: 'Alt+B',
                customVideoSubtitleModeHotkey: '',
                videoSubtitleModeHotkeyAction: 'cycle-all',
                videoSubtitleDisplayMode: 'unexpected-mode',
            },
            isActive: () => true,
            isVisible: () => true,
            applyMode,
        });

        expect(handled).toBe(true);
        expect(applyMode).toHaveBeenCalledWith('translation-only');

        const handledFromTranslation = handleVideoSubtitleModeShortcutKeydown(createKeyEvent({key: 'b', code: 'KeyB', altKey: true}), {
            document: document as unknown as Document,
            config: {
                videoSubtitleModeHotkeyEnabled: true,
                videoSubtitleModeHotkey: 'Alt+B',
                customVideoSubtitleModeHotkey: '',
                videoSubtitleModeHotkeyAction: 'cycle-all',
                videoSubtitleDisplayMode: 'translation-only',
            },
            isActive: () => true,
            isVisible: () => true,
            applyMode,
        });
        expect(handledFromTranslation).toBe(true);
        expect(applyMode).toHaveBeenLastCalledWith('original-only');
    });

    it('忽略不可信、长按重复、输入法合成、停用、无视频、按键不匹配与输入框场景', () => {
        const {document} = parseHTML('<html><body><input id="search" type="text" /></body></html>');
        const input = document.getElementById('search')!;
        const applyMode = vi.fn();
        const basePorts: VideoSubtitleModeShortcutPorts = {
            document: document as unknown as Document,
            config: {
                videoSubtitleModeHotkeyEnabled: true,
                videoSubtitleModeHotkey: 'Alt+M',
                customVideoSubtitleModeHotkey: '',
                videoSubtitleModeHotkeyAction: 'bilingual-original',
                videoSubtitleDisplayMode: 'original-only',
            },
            isActive: () => true,
            isVisible: () => true,
            applyMode,
        };

        const isActive = vi.fn(() => true);
        const hotkeyPorts: VideoSubtitleModeShortcutPorts = {...basePorts, isActive};
        expect(handleVideoSubtitleModeShortcutKeydown(createKeyEvent({isTrusted: false}), hotkeyPorts)).toBe(false);
        expect(handleVideoSubtitleModeShortcutKeydown(createKeyEvent({repeat: true}), hotkeyPorts)).toBe(false);
        expect(handleVideoSubtitleModeShortcutKeydown(createKeyEvent({isComposing: true}), hotkeyPorts)).toBe(false);
        expect(handleVideoSubtitleModeShortcutKeydown(createKeyEvent({defaultPrevented: true}), hotkeyPorts)).toBe(false);
        expect(handleVideoSubtitleModeShortcutKeydown(createKeyEvent({key: 'x', code: 'KeyX'}), hotkeyPorts)).toBe(false);
        expect(isActive).not.toHaveBeenCalled();
        expect(handleVideoSubtitleModeShortcutKeydown(createKeyEvent(), {
            ...hotkeyPorts,
            config: {...basePorts.config, videoSubtitleModeHotkeyEnabled: false},
        })).toBe(false);
        expect(isActive).not.toHaveBeenCalled();
        expect(handleVideoSubtitleModeShortcutKeydown(createKeyEvent(), {
            ...basePorts,
            isActive: () => false,
        })).toBe(false);

        const typingEvent = createKeyEvent({composedPath: () => [input]});
        expect(handleVideoSubtitleModeShortcutKeydown(typingEvent, basePorts)).toBe(false);
        expect(typingEvent.preventDefault).not.toHaveBeenCalled();
        expect(applyMode).not.toHaveBeenCalled();
    });
});

describe('活跃视频字幕模式控制器注册表', () => {
    it('按后注册优先返回首个活跃控制器且注销幂等', () => {
        expect(getActiveVideoSubtitleModeController()).toBeNull();

        let firstActive = false;
        let secondActive = true;
        const first: ActiveVideoSubtitleModeController = {
            isActive: () => firstActive,
            getCurrentMode: () => 'bilingual',
            switchMode: () => 'original-only',
        };
        const second: ActiveVideoSubtitleModeController = {
            isActive: () => secondActive,
            getCurrentMode: () => 'original-only',
            switchMode: () => 'bilingual',
        };

        const unregisterFirst = registerActiveVideoSubtitleModeController(first);
        expect(getActiveVideoSubtitleModeController()).toBeNull();

        firstActive = true;
        expect(getActiveVideoSubtitleModeController()).toBe(first);

        const unregisterSecond = registerActiveVideoSubtitleModeController(second);
        expect(getActiveVideoSubtitleModeController()).toBe(second);

        secondActive = false;
        expect(getActiveVideoSubtitleModeController()).toBe(first);

        unregisterFirst();
        unregisterFirst();
        expect(getActiveVideoSubtitleModeController()).toBeNull();

        secondActive = true;
        expect(getActiveVideoSubtitleModeController()).toBe(second);

        unregisterSecond();
        unregisterSecond();
        expect(getActiveVideoSubtitleModeController()).toBeNull();
    });
});

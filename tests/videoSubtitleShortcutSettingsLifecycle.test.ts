import * as runtime from 'vue';
import {Config} from '@/src/core/config/model';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import VideoSubtitleShortcutSettings from '@/src/features/settings/ui/VideoSubtitleShortcutSettings.vue';
import {useTranslationShortcutSettings} from '@/src/features/settings/ui/useTranslationShortcutSettings';

const feedback = vi.hoisted(() => Object.assign(vi.fn(), {warning: vi.fn()}));
vi.mock('element-plus', () => ({ElMessage: feedback}));
vi.mock('@element-plus/icons-vue', () => ({Edit: {render: () => null}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}));
vi.mock('@/src/features/settings/ui/components/SettingsGroup.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/features/settings/ui/components/SettingsItem.vue', () => ({default: {render: () => null}}));

let app: import('vue').App, state: Record<string, any>, props: {config: Config; active: boolean};
let visible: import('vue').Ref<boolean>;

async function settle() {
    await runtime.nextTick();
    await runtime.nextTick();
}

async function mountEditor() {
    app?.unmount();
    const component = {...VideoSubtitleShortcutSettings, render: () => null} as runtime.Component;
    const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
        patchProp: () => {},
        insert: () => {},
        remove: () => {},
        createElement: () => ({}),
        createText: () => ({}),
        createComment: () => ({}),
        setText: () => {},
        setElementText: () => {},
        parentNode: () => null,
        nextSibling: () => null,
        querySelector: () => null,
        setScopeId: () => {},
        cloneNode: () => ({}),
        insertStaticContent: () => [{}, {}],
    });
    app = renderer.createApp({
        setup: () => () => runtime.h(runtime.KeepAlive, null, {
            default: () => visible.value
                ? runtime.h(component, {...props, ref: (vm: any) => {if (vm) state = vm.$.setupState;}})
                : runtime.h({render: () => null}, {key: 'other'}),
        }),
    });
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
    app.config.warnHandler = () => {};
    app.mount({});
    await settle();
}

beforeEach(async () => {
    vi.clearAllMocks();
    feedback.warning.mockImplementation(feedback);
    props = runtime.reactive({
        active: true,
        config: Object.assign(new Config(), {
            videoTranslationEnabled: true,
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'Alt+M',
            customVideoSubtitleModeHotkey: '',
            videoSubtitleModeHotkeyAction: 'bilingual-original' as const,
            hotkey: 'Control',
            floatingBallHotkey: 'Alt+T',
            selectionTranslatorMode: 'disabled',
            inputBoxTranslationTrigger: 'none',
            selectionAreaEnabled: false,
            paragraphCopyEnabled: false,
            sectionTranslationHotkeyEnabled: false,
            quickTranslationProfiles: [],
        }),
    });
    visible = runtime.ref(true);
    await mountEditor();
});

afterEach(() => {
    app?.unmount();
    vi.unstubAllGlobals();
});

describe('视频字幕显示模式快捷键设置组件生命周期与冲突校验', () => {
    it('支持开启/关闭、选择预设与录制自定义快捷键，清除录制回到默认入口', () => {
        state.handleEnabledChange(false);
        expect(props.config.videoSubtitleModeHotkeyEnabled).toBe(false);
        state.handleEnabledChange(true);
        expect(props.config.videoSubtitleModeHotkeyEnabled).toBe(true);

        state.handleHotkeyChange('Shift+B');
        expect(props.config.videoSubtitleModeHotkey).toBe('Shift+B');

        state.handleHotkeyChange('custom');
        expect(state.showCustomHotkeyDialog).toBe(true);
        state.handleCustomHotkeyConfirm('alt+u');
        expect(props.config.videoSubtitleModeHotkey).toBe('custom');
        expect(props.config.customVideoSubtitleModeHotkey).toBe('Alt+U');
        expect(feedback).toHaveBeenCalledWith(expect.objectContaining({type: 'success'}));

        state.openCustomHotkeyDialog();
        state.handleCustomHotkeyConfirm('none');
        expect(props.config.videoSubtitleModeHotkey).toBe('Alt+M');
        expect(props.config.customVideoSubtitleModeHotkey).toBe('');
    });

    it('离开分区、KeepAlive 失活、关闭总开关或替换配置后关闭草稿并阻止迟到提交', async () => {
        state.handleHotkeyChange('custom');
        props.active = false;
        await settle();
        expect(state.showCustomHotkeyDialog).toBe(false);
        state.handleCustomHotkeyConfirm('Alt+U');
        state.handleEnabledChange(false);
        expect(props.config.videoSubtitleModeHotkey).toBe('Alt+M');
        expect(props.config.videoSubtitleModeHotkeyEnabled).toBe(true);

        props.active = true;
        await settle();
        state.handleHotkeyChange('custom');
        visible.value = false;
        await settle();
        expect(state.showCustomHotkeyDialog).toBe(false);
        state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.videoSubtitleModeHotkey).toBe('Alt+M');

        visible.value = true;
        await settle();
        state.handleHotkeyChange('custom');
        props.config.videoTranslationEnabled = false;
        await settle();
        expect(state.showCustomHotkeyDialog).toBe(false);
        state.handleCustomHotkeyConfirm('Alt+K');
        expect(props.config.videoSubtitleModeHotkey).toBe('Alt+M');
    });

    it('检测与其他功能及快捷方案的快捷键冲突，阻止开启或改键', () => {
        props.config.videoSubtitleModeHotkeyEnabled = false;
        props.config.floatingBallHotkey = 'Alt+M';
        state.handleEnabledChange(true);
        expect(props.config.videoSubtitleModeHotkeyEnabled).toBe(false);
        expect(feedback.warning).toHaveBeenCalledTimes(1);

        props.config.floatingBallHotkey = 'Alt+T';
        state.handleEnabledChange(true);
        expect(props.config.videoSubtitleModeHotkeyEnabled).toBe(true);

        props.config.paragraphCopyEnabled = true;
        props.config.paragraphCopyHotkey = 'Alt+C';
        expect(state.findHotkeyConflict('Alt+C')).toBe('video.modeShortcut.hotkeyConflict');

        state.handleHotkeyChange('custom');
        state.handleCustomHotkeyConfirm('Alt+C');
        expect(props.config.videoSubtitleModeHotkey).toBe('Alt+M');
        state.handleCustomHotkeyCancel();
        expect(state.showCustomHotkeyDialog).toBe(false);
    });

    it('全文/悬浮/划词快捷键协调器也会识别已启用的视频字幕模式快捷键占用', () => {
        const scope = runtime.effectScope();
        const configRef = runtime.ref(Object.assign(new Config(), {
            videoSubtitleModeHotkeyEnabled: true,
            videoSubtitleModeHotkey: 'Alt+M',
            customVideoSubtitleModeHotkey: '',
        }));
        const shortcuts = scope.run(() => useTranslationShortcutSettings(configRef))!;
        expect(shortcuts.quickTranslationConflictMessage('Alt+M')).toBe('quickTranslation.legacyConflictEdit');
        configRef.value.videoSubtitleModeHotkeyEnabled = false;
        expect(shortcuts.quickTranslationConflictMessage('Alt+M')).toBe('');
        scope.stop();
    });
});

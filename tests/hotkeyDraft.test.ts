import {createRenderer, h, KeepAlive, nextTick, reactive, ref, watch, type App} from 'vue';
import {afterEach, describe, expect, it} from 'vitest';
import {Config} from '@/src/core/config/model';
import {useHotkeyDraft} from '@/src/features/settings/ui/useHotkeyDraft';

const renderer = createRenderer<Record<string, never>, Record<string, unknown>>({patchProp: () => {}, insert: () => {},
    remove: () => {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText: () => {},
    setElementText: () => {}, parentNode: () => null, nextSibling: () => null, querySelector: () => null,
    setScopeId: () => {}, cloneNode: () => ({}), insertStaticContent: () => [{}, {}]});
let app: App;
function mount(withContext = false, available = true) {
    const config = ref(new Config()), active = ref(available), visible = ref(true), context = ref(false);
    let draft!: ReturnType<typeof useHotkeyDraft>;
    const component = {setup() {
        draft = useHotkeyDraft(() => config.value, {mode: 'sectionTranslationHotkey', custom: 'customSectionTranslationHotkey'},
            () => active.value, withContext ? () => context.value : undefined);
        return () => null;
    }};
    app = renderer.createApp({setup: () => () => h(KeepAlive, null, {default: () => visible.value
        ? h(component) : h({render: () => null}, {key: 'other'})})});app.mount({});
    return {draft, config, active, visible, context};
}
afterEach(() => app?.unmount());

describe('快捷键草稿所有权与提交边界', () => {
    it('重复打开只创建一次可见状态，确认前保留保存值，成功提交后草稿失效', () => {
        const {draft, config} = mount();const old = config.value.sectionTranslationHotkey;let opens = 0;
        const stop = watch(draft.showCustomHotkeyDialog, value => {if (value) opens++;}, {flush: 'sync'});
        draft.openCustomHotkeyDialog();draft.openCustomHotkeyDialog();expect(opens).toBe(1);expect(draft.isCurrentDraft()).toBe(true);
        expect(config.value.sectionTranslationHotkey).toBe(old);expect(draft.commitHotkeyDraft('custom', 'Alt+K')).toBe(true);
        expect(config.value.customSectionTranslationHotkey).toBe('Alt+K');expect(config.value.sectionTranslationHotkey).toBe('custom');
        expect(draft.isCurrentDraft()).toBe(false);expect(draft.showCustomHotkeyDialog.value).toBe(false);stop();
    });
    it('不可用时不开录制；无草稿或弹窗已关闭时不能提交，恢复后可重新编辑', () => {
        const {draft, active, config} = mount(false, false);draft.openCustomHotkeyDialog();expect(draft.showCustomHotkeyDialog.value).toBe(false);
        expect(draft.commitHotkeyDraft('custom', 'Alt+K')).toBe(false);active.value = true;draft.openCustomHotkeyDialog();
        draft.showCustomHotkeyDialog.value = false;expect(draft.isCurrentDraft()).toBe(false);draft.openCustomHotkeyDialog();
        draft.closeCustomHotkeyDialog();expect(draft.commitHotkeyDraft('custom', 'Alt+K')).toBe(false);expect(config.value.customSectionTranslationHotkey).toBe('');
    });
    it.each(['object', 'mode', 'custom', 'context', 'active'])('外部 %s 变更即时撤销草稿，等待 watch 后弹窗关闭', async field => {
        const {draft, config, context, active} = mount(true);draft.openCustomHotkeyDialog();
        if (field === 'object') config.value = {...config.value};
        if (field === 'mode') config.value.sectionTranslationHotkey = 'Shift+D';
        if (field === 'custom') config.value.customSectionTranslationHotkey = 'Alt+J';
        if (field === 'context') context.value = true;
        if (field === 'active') active.value = false;
        expect(draft.isCurrentDraft()).toBe(false);await nextTick();expect(draft.showCustomHotkeyDialog.value).toBe(false);
        expect(draft.commitHotkeyDraft('custom', 'Alt+K')).toBe(false);expect(config.value.customSectionTranslationHotkey).not.toBe('Alt+K');
        context.value = false;await nextTick(); // 已关闭草稿的后续变化无需回滚配置。
    });
    it('配置字段同步观察器的重入不能二次提交同一草稿', () => {
        const {draft, config} = mount();draft.openCustomHotkeyDialog();const results: boolean[] = [];
        const stop = watch(() => config.value.customSectionTranslationHotkey, () => results.push(draft.commitHotkeyDraft('custom', 'Alt+J')), {flush: 'sync'});
        expect(draft.commitHotkeyDraft('custom', 'Alt+K')).toBe(true);expect(results).toEqual([false]);
        expect(config.value.customSectionTranslationHotkey).toBe('Alt+K');stop();
    });
    it('KeepAlive 停用后不能提交或重新打开，恢复允许新草稿，卸载清理所有入口', async () => {
        const {draft, visible} = mount();draft.openCustomHotkeyDialog();visible.value = false;await nextTick();
        expect(draft.active.value).toBe(false);expect(draft.commitHotkeyDraft('custom', 'Alt+K')).toBe(false);draft.openCustomHotkeyDialog();
        expect(draft.showCustomHotkeyDialog.value).toBe(false);visible.value = true;await nextTick();draft.openCustomHotkeyDialog();
        expect(draft.isCurrentDraft()).toBe(true);app.unmount();expect(draft.showCustomHotkeyDialog.value).toBe(false);
        draft.openCustomHotkeyDialog();expect(draft.isCurrentDraft()).toBe(false);
    });
    it('四个明确字段组合各自提交，圈选功能停用偏好仍可以编辑', () => {
        const scopes = reactive({config: new Config(), enabled: false});
        let area!: ReturnType<typeof useHotkeyDraft>, copy!: ReturnType<typeof useHotkeyDraft>, input!: ReturnType<typeof useHotkeyDraft>;
        app = renderer.createApp({setup() {
            area = useHotkeyDraft(() => scopes.config, {mode: 'selectionAreaHotkey', custom: 'customSelectionAreaHotkey'}, () => true, () => scopes.enabled);
            copy = useHotkeyDraft(() => scopes.config, {mode: 'paragraphCopyHotkey', custom: 'customParagraphCopyHotkey'}, () => true);
            input = useHotkeyDraft(() => scopes.config, {mode: 'inputBoxTranslationTrigger', custom: 'customInputBoxTranslationHotkey'}, () => true);
            return () => null;
        }});app.mount({});area.openCustomHotkeyDialog();copy.openCustomHotkeyDialog();input.openCustomHotkeyDialog();
        expect(area.commitHotkeyDraft('custom', 'Shift+K')).toBe(true);expect(copy.commitHotkeyDraft('custom', 'Alt+K')).toBe(true);
        expect(input.commitHotkeyDraft('custom', 'Alt+Enter')).toBe(true);
        expect(scopes.config.customSelectionAreaHotkey).toBe('Shift+K');expect(scopes.config.customParagraphCopyHotkey).toBe('Alt+K');
        expect(scopes.config.inputBoxTranslationTrigger).toBe('custom');expect(scopes.config.customInputBoxTranslationHotkey).toBe('Alt+Enter');
    });
});

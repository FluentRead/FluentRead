import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {effectScope, nextTick, ref, type EffectScope} from 'vue';
import type {Config} from '@/src/core/config/model';

const notices = vi.hoisted(() => ({message: Object.assign(vi.fn(), {warning: vi.fn()})}));
vi.mock('element-plus', () => ({ElMessage: notices.message}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}`,
    translateLegacy: (value: string) => value,
})}));
import {useTranslationShortcutSettings} from '@/src/features/settings/ui/useTranslationShortcutSettings';

type Settings = ReturnType<typeof useTranslationShortcutSettings>;
const groups = [
    {name: 'page', mode: 'floatingBallHotkey', custom: 'customFloatingBallHotkey', change: 'handleHotkeyChange',
        open: 'openCustomHotkeyDialog', cancel: 'handleCustomHotkeyCancel', confirm: 'handleCustomHotkeyConfirm',
        visible: 'showCustomHotkeyDialog', initial: 'Alt+Q', replacement: 'none'},
    {name: 'hover', mode: 'hotkey', custom: 'customHotkey', change: 'handleMouseHotkeyChange',
        open: 'openCustomMouseHotkeyDialog', cancel: 'handleCustomMouseHotkeyCancel', confirm: 'handleCustomMouseHotkeyConfirm',
        visible: 'showCustomMouseHotkeyDialog', initial: 'Shift', replacement: 'none'},
    {name: 'selection', mode: 'selectionTranslatorTrigger', custom: 'customSelectionTranslatorHotkey', change: 'handleSelectionTriggerChange',
        open: 'openCustomSelectionHotkeyDialog', cancel: 'handleCustomSelectionHotkeyCancel', confirm: 'handleCustomSelectionHotkeyConfirm',
        visible: 'showCustomSelectionHotkeyDialog', initial: 'hover', replacement: 'contextMenu'},
] as const;
let scopes: EffectScope[];
function mount() {
    const config = ref({floatingBallHotkey: 'Alt+Q', customFloatingBallHotkey: '', hotkey: 'Shift', customHotkey: '',
        selectionTranslatorTrigger: 'hover', selectionTranslatorHotkey: 'none', customSelectionTranslatorHotkey: '',
        inputBoxTranslationTrigger: 'ctrl_enter', quickTranslationProfiles: []} as unknown as Config);
    const active = ref(true);
    const scope = effectScope(); scopes.push(scope);
    // 可选的分区可见性约束必须保留旧单参数调用；旧实现忽略第二参数，因而能直接复现换页问题。
    const useWithActivity = useTranslationShortcutSettings as unknown as (configuration: typeof config, active: () => boolean) => Settings;
    const state = scope.run(() => useWithActivity(config, () => active.value))!;
    return {config, active, scope, state};
}
beforeEach(() => {vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal('navigator', {platform: 'Win32'}); scopes = [];});
afterEach(() => {for (const scope of scopes) scope.stop(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();});

describe('快捷键设置草稿生命周期', () => {
    it.each(groups)('$name 已排队的旧录制定时器在卸载后不能重新打开弹窗',group=>{
        const {state,scope,config}=mount(),timer=vi.spyOn(globalThis,'setTimeout');
        state[group.change]('custom');const callback=timer.mock.calls.find(([,delay])=>delay===100)![0] as ()=>void;timer.mockRestore();
        scope.stop();const before=JSON.stringify(config.value);callback();
        expect(state[group.visible].value).toBe(false);expect(JSON.stringify(config.value)).toBe(before);expect(vi.getTimerCount()).toBe(0);
    });
    it.each(groups)('$name 预设、现有自定义与录制确认均保留点选快捷键', group => {
        const {state, config} = mount();
        Object.assign(config.value, {on: false, selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false,
            selectionClickSelectEnabled: true, selectionClickSelectHotkey: 'Alt+Shift+S'});
        if(group.name !== 'selection') {state[group.change]('Alt+Shift+S'); expect(config.value[group.mode]).toBe(group.initial);}
        config.value[group.custom] = 'Alt+Shift+S';state[group.change]('custom');expect(config.value[group.mode]).toBe(group.initial);
        config.value[group.custom] = '';state[group.open]();state[group.confirm]('Alt+Shift+S');
        expect(config.value[group.custom]).toBe('');expect(state[group.visible].value).toBe(true);
        expect(notices.message.warning).toHaveBeenCalled();
    });
    it('输入翻译和父级圈选开启校验同样保留点选组合，停用点选后允许设置', () => {
        const {state, config} = mount();
        Object.assign(config.value, {selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false,
            selectionClickSelectEnabled: true, selectionClickSelectHotkey: 'Ctrl+Enter'});
        config.value.inputBoxTranslationTrigger = 'none';state.handleInputBoxTranslationTriggerChange('ctrl_enter');
        expect(config.value.inputBoxTranslationTrigger).toBe('none');expect(state.quickTranslationConflictMessage('Ctrl+Enter')).toContain('两点选取');
        config.value.selectionClickSelectEnabled = false;state.handleInputBoxTranslationTriggerChange('ctrl_enter');expect(config.value.inputBoxTranslationTrigger).toBe('ctrl_enter');
        config.value.inputBoxTranslationTrigger = 'disabled';config.value.customInputBoxTranslationHotkey = '';
        state.handleInputBoxTranslationTriggerChange('custom');expect(config.value.inputBoxTranslationTrigger).toBe('disabled');
        config.value.customInputBoxTranslationHotkey = 'Alt+Enter';
        state.handleInputBoxTranslationTriggerChange('custom');expect(config.value.inputBoxTranslationTrigger).toBe('custom');
        expect(state.quickTranslationConflictMessage('Alt+Enter')).toContain('输入框翻译');
        state.handleHotkeyChange('Alt+Enter');expect(config.value.floatingBallHotkey).toBe('Alt+Q');
        expect(notices.message.warning).toHaveBeenCalled();
    });
    it.each(groups)('$name 快速改选不会让迟到弹窗重新打开或取消覆盖新选择', async group => {
        const {state, config} = mount();
        state[group.change]('custom'); state[group.change](group.replacement);
        await nextTick(); vi.advanceTimersByTime(100);
        expect(state[group.visible].value).toBe(false);
        state[group.cancel](); expect(config.value[group.mode]).toBe(group.replacement);
    });
    it.each(groups)('$name 重复选择自定义只保留一个定时器和最初的恢复点', group => {
        const {state, config} = mount();
        for (let i = 0; i < 100; i++) state[group.change]('custom');
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(100); state[group.cancel]();
        expect(config.value[group.mode]).toBe(group.initial);
    });
    it.each(groups)('$name 卸载立即清理等待并恢复尚未确认的模式', group => {
        const {state, config, scope} = mount();
        state[group.change]('custom'); scope.stop();
        expect(vi.getTimerCount()).toBe(0);
        expect(config.value[group.mode]).toBe(group.initial);
        vi.advanceTimersByTime(100); expect(state[group.visible].value).toBe(false);
    });
    it.each(groups)('$name 离开分区取消待开弹窗及未确认的临时配置', async group => {
        const {state, config, active} = mount();
        state[group.change]('custom'); active.value = false; await nextTick();
        vi.advanceTimersByTime(100); expect(state[group.visible].value).toBe(false);
        expect(config.value[group.mode]).toBe(group.initial);
    });
    it.each(groups)('$name 替换配置后旧草稿不能打开弹窗或回写新配置', async group => {
        const {state, config} = mount();
        state[group.change]('custom');
        config.value = {...config.value, [group.mode]: 'custom', [group.custom]: '', to: 'fr'};
        const replacement = JSON.stringify(config.value); await nextTick(); vi.advanceTimersByTime(100);
        expect(state[group.visible].value).toBe(false);
        state[group.cancel](); expect(JSON.stringify(config.value)).toBe(replacement);
    });
    it('划词自定义快捷键确认和选择旧自定义值都拒绝已启用快捷方案冲突', () => {
        const {state, config} = mount();
        config.value.quickTranslationProfiles = [{id: 'section-ja', enabled: true, action: 'section', hotkey: 'F9',
            service: '', model: '', targetLanguage: 'ja', displayMode: 'inherit', fullPageMode: 'inherit'}];
        state.handleSelectionTriggerChange('custom'); vi.advanceTimersByTime(100);
        state.handleCustomSelectionHotkeyConfirm('F9');
        expect(config.value.customSelectionTranslatorHotkey).toBe('');
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        state.handleCustomSelectionHotkeyCancel(); config.value.customSelectionTranslatorHotkey = 'F9';
        state.handleSelectionTriggerChange('custom'); expect(config.value.selectionTranslatorTrigger).toBe('hover');
        expect(notices.message.warning).toHaveBeenCalled();
    });
});

const platformEdits = [
    {platform: 'Win32', display: 'Alt+D'},
    {platform: 'MacIntel', display: 'Option+D'},
    {platform: undefined, display: 'Alt+D'},
].flatMap(host => groups.map(group => ({...host, name: group.name, group})));
it.each(platformEdits)('$platform $name 正常编辑、取消、确认与清除保留独立配置和展示', ({platform, display, group}) => {
    // 配置保持跨平台的 Alt 写法，展示按当前平台转换；不依赖运行测试的宿主 Node。
    vi.stubGlobal('navigator', platform === undefined ? undefined : {platform});
    const {state, config} = mount(); config.value[group.mode] = 'custom'; config.value[group.custom] = 'F10';
    const getter = group.name === 'page' ? state.getCustomHotkeyDisplayName : group.name === 'hover' ? state.getCustomMouseHotkeyDisplayName : state.getCustomSelectionHotkeyDisplayName;
    expect(getter()).toBe('F10'); state[group.open](); state[group.cancel]();
    expect(config.value[group.custom]).toBe('F10'); state[group.open](); state[group.confirm]('Alt+D');
    expect(config.value[group.custom]).toBe('Alt+D'); expect(getter()).toBe(display); expect(state[group.visible].value).toBe(false);
    state[group.open](); state[group.confirm]('none');
    expect(config.value[group.custom]).toBe(''); expect(config.value[group.mode]).toBe(group.name === 'selection' ? 'icon' : 'none');
    expect(getter()).toBe(''); config.value[group.custom] = 'none'; expect(getter()).toBe('已禁用');
    config.value[group.custom] = 'broken shortcut'; expect(getter()).toBe('broken shortcut');
    if (group.name === 'selection') expect(config.value.selectionTranslatorHotkey).toBe('none');
});
it.each(groups)('$name 缺失历史原模式的自定义项取消回到有效默认', group => {
    const {state, config} = mount(); config.value[group.mode] = 'custom'; state[group.change]('custom');
    vi.advanceTimersByTime(100); state[group.cancel]();
    expect(config.value[group.mode]).toBe(group.name === 'page' ? 'Alt+T' : group.name === 'hover' ? 'Control' : 'icon');
});
it.each(groups)('$name 等待时外部已经保存快捷键则不再弹窗或覆盖', group => {
    const {state, config} = mount(); state[group.change]('custom'); config.value[group.custom] = 'F8';
    vi.advanceTimersByTime(100); expect(state[group.visible].value).toBe(false); expect(vi.getTimerCount()).toBe(0);
    state[group.cancel](); expect(config.value[group.custom]).toBe('F8'); expect(config.value[group.mode]).toBe('custom');
});
it.each(groups)('$name 关闭分区或卸载后的过期确认与打开入口不改变配置', group => {
    const {state, config, active, scope} = mount(); state[group.open](); active.value = false;
    const saved = JSON.stringify(config.value); state[group.open](); state[group.change]('custom'); state[group.confirm]('F10');
    expect(JSON.stringify(config.value)).toBe(saved); expect(state[group.visible].value).toBe(false);
    active.value = true; scope.stop(); state[group.open](); state[group.change]('custom'); state[group.confirm]('F10');
    expect(JSON.stringify(config.value)).toBe(saved); expect(state[group.visible].value).toBe(false);
});
it('三类录制校验和输入框触发检查都读取快捷方案动作，未占用的触发可直接设置', () => {
    const {state, config, active} = mount();
    for (const action of ['hover', 'full-page', 'section'] as const) {
        config.value.quickTranslationProfiles = [{id: 'occupied', enabled: true, action, hotkey: 'Ctrl+Enter', service: '', model: '', targetLanguage: '', displayMode: 'inherit', fullPageMode: 'inherit'}];
        for (const validate of [state.validateCustomFullPageHotkey, state.validateCustomMouseHotkey, state.validateCustomSelectionHotkey]) expect(validate('Ctrl+Enter')).toContain('quickTranslation.conflictProfile');
        state.handleHotkeyChange('Ctrl+Enter'); expect(config.value.floatingBallHotkey).toBe('Alt+Q');
        state.handleMouseHotkeyChange('Ctrl+Enter'); expect(config.value.hotkey).toBe('Shift');
        state.handleInputBoxTranslationTriggerChange('ctrl_enter'); expect(notices.message.warning).toHaveBeenCalled();
    }
    state.handleInputBoxTranslationTriggerChange('triple_space'); expect(config.value.inputBoxTranslationTrigger).toBe('triple_space');
    state.handleInputBoxTranslationTriggerChange('none'); expect(config.value.inputBoxTranslationTrigger).toBe('none');
    active.value = false; state.handleInputBoxTranslationTriggerChange('triple_equal'); expect(config.value.inputBoxTranslationTrigger).toBe('none');
});
it('单参数旧调用仍可正常设置与取消，手动打开未保存的自定义模式也恢复默认', () => {
    const config = ref({floatingBallHotkey: 'custom', customFloatingBallHotkey: '', hotkey: 'custom', customHotkey: '',
        selectionTranslatorTrigger: 'custom', customSelectionTranslatorHotkey: '', quickTranslationProfiles: []} as unknown as Config);
    const scope = effectScope(); scopes.push(scope); const state = scope.run(() => useTranslationShortcutSettings(config))!;
    state.openCustomHotkeyDialog(); state.handleCustomHotkeyCancel(); expect(config.value.floatingBallHotkey).toBe('Alt+T');
    state.openCustomMouseHotkeyDialog(); state.handleCustomMouseHotkeyCancel(); expect(config.value.hotkey).toBe('Control');
    state.openCustomSelectionHotkeyDialog(); state.handleCustomSelectionHotkeyCancel(); expect(config.value.selectionTranslatorTrigger).toBe('icon');
});

// 追加集成回归：直接使用生产配置模型和 composable，保存/订阅边界沿用 SettingsSections 的同步 watcher 与异步回写。
import {Config as PersistedShortcutConfig, normalizeConfig} from '@/src/core/config/model';
import {onScopeDispose, watch as watchSettingsConfig} from 'vue';

function mountWithNormalizedSettingsEcho(initial: Partial<Config> = {}, initialState: 'normalized' | 'legacy' = 'normalized') {
    const initialConfig = Object.assign(new PersistedShortcutConfig(), {
        floatingBallHotkey: 'Alt+Q', customFloatingBallHotkey: '', hotkey: 'Shift', customHotkey: '',
        selectionTranslatorTrigger: 'hover', customSelectionTranslatorHotkey: '', quickTranslationProfiles: [],
    }, initial);
    const config = ref(initialState === 'legacy' ? initialConfig : normalizeConfig(initialConfig));
    const active = ref(true);
    const scope = effectScope(); scopes.push(scope);
    const writes: {raw: Config; normalized: Config}[] = [];
    const appliedEchoes: Config[] = [];
    const pendingEchoes: Promise<void>[] = [];
    let disposed = false;
    let applyingExternalConfig = false;
    let lastSerialized = JSON.stringify(config.value);

    // 对应 SettingsSections.subscribeConfig；必须 Object.assign 原编辑对象，不能把正常 echo 伪装成配置替换。
    function receiveBackend(nextConfig: Config): Promise<void> {
        return Promise.resolve().then(() => {
            if (disposed) return;
            const serialized = JSON.stringify(nextConfig);
            if (serialized === lastSerialized) return;
            lastSerialized = serialized;
            applyingExternalConfig = true;
            try {
                Object.assign(config.value, normalizeConfig(nextConfig));
                appliedEchoes.push(nextConfig);
            } finally {
                applyingExternalConfig = false;
            }
        });
    }
    const state = scope.run(() => {
        onScopeDispose(() => {disposed = true;});
        const shortcuts = useTranslationShortcutSettings(config, () => active.value, () => applyingExternalConfig);
        // 对应已完成水合的 SettingsSections 保存 watcher，分别记录规范化前和实际提交的完整快照。
        watchSettingsConfig(() => JSON.stringify(config.value), serialized => {
            if (disposed || applyingExternalConfig || serialized === lastSerialized) return;
            lastSerialized = serialized;
            const snapshot = normalizeConfig(config.value);
            writes.push({raw: JSON.parse(serialized) as Config, normalized: snapshot});
            pendingEchoes.push(receiveBackend(snapshot));
        }, {flush: 'sync'});
        return shortcuts;
    })!;
    async function flushEchoes(): Promise<void> {
        await Promise.all(pendingEchoes.splice(0));
        await nextTick();
    }
    return {config, active, scope, state, writes, appliedEchoes, receiveBackend, flushEchoes};
}

describe('划词自定义快捷键与真实设置规范化回写', () => {
    it.each(['direct', 'icon', 'dot', 'hover', 'contextMenu', 'Control', 'Alt', 'Shift'])(
        '从 %s 选择空自定义时保持已确认触发方式和旧快捷键镜像直到录制确认', async trigger => {
            const {config, state, flushEchoes} = mountWithNormalizedSettingsEcho({selectionTranslatorTrigger: trigger});
            const original = {
                trigger: config.value.selectionTranslatorTrigger,
                hotkey: config.value.selectionTranslatorHotkey,
            };
            state.handleSelectionTriggerChange('custom');
            expect(config.value.selectionTranslatorTrigger).toBe(original.trigger);
            expect(config.value.selectionTranslatorHotkey).toBe(original.hotkey);
            expect(config.value.customSelectionTranslatorHotkey).toBe('');
            await flushEchoes();
            vi.advanceTimersByTime(99); expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
            vi.advanceTimersByTime(1); expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
            expect(config.value.selectionTranslatorTrigger).toBe(original.trigger);
            expect(config.value.selectionTranslatorHotkey).toBe(original.hotkey);
        },
    );

    it('同步保存不会产生 custom 加空快捷键的非法快照，也不会把 hover 规范化回 icon', async () => {
        const {config, state, writes, flushEchoes} = mountWithNormalizedSettingsEcho();
        state.handleSelectionTriggerChange('custom');
        config.value.to = 'fr'; // 确保实际保存发生，不能以未提交任何快照冒充边界验证。
        expect(writes.length).toBeGreaterThan(0);
        for (const {raw, normalized} of writes) {
            expect(raw.selectionTranslatorTrigger).toBe('hover');
            expect(raw.selectionTranslatorHotkey).toBe('none');
            expect(raw.customSelectionTranslatorHotkey).toBe('');
            expect(normalized.selectionTranslatorTrigger).toBe('hover');
            expect(normalized.selectionTranslatorHotkey).toBe('none');
        }
        await flushEchoes();
        vi.advanceTimersByTime(100);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        expect(config.value.selectionTranslatorTrigger).toBe('hover');
    });

    it('保存的 normalized 微任务 echo 后 100ms 仍打开划词录制弹窗', async () => {
        const {config, state, flushEchoes} = mountWithNormalizedSettingsEcho();
        state.handleSelectionTriggerChange('custom');
        config.value.to = 'fr';
        await flushEchoes();
        vi.advanceTimersByTime(99); expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        vi.advanceTimersByTime(1); expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        expect(config.value.selectionTranslatorTrigger).toBe('hover');
    });

    it('同触发方式的 normalized 订阅回写既不取消等待，也不关闭已打开的录制弹窗', async () => {
        const {config, state, appliedEchoes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho();
        const owner = config.value;
        state.handleSelectionTriggerChange('custom');
        await flushEchoes();
        await receiveBackend(normalizeConfig(config.value)); // 同全量值时走生产订阅去重分支。
        await receiveBackend(normalizeConfig({...config.value, to: 'fr'})); // 同 trigger、不同无关字段时必须实际 Object.assign。
        expect(appliedEchoes.length).toBeGreaterThan(0);
        expect(config.value).toBe(owner);
        expect(config.value.to).toBe('fr');
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(100); expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        await receiveBackend(normalizeConfig({...config.value, to: 'de'}));
        expect(config.value).toBe(owner);
        expect(config.value.to).toBe('de');
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        expect(config.value.selectionTranslatorTrigger).toBe('hover');
        expect(config.value.selectionTranslatorHotkey).toBe('none');
    });

    it('确认 F9 后真实持久化和 normalized echo 保留有效 custom 与旧字段镜像', async () => {
        const {config, state, writes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho();
        state.handleSelectionTriggerChange('custom');
        await receiveBackend(normalizeConfig({...config.value, to: 'fr'}));
        await flushEchoes();
        vi.advanceTimersByTime(100); expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        state.handleCustomSelectionHotkeyConfirm('F9');
        await flushEchoes();
        expect(config.value.selectionTranslatorTrigger).toBe('custom');
        expect(config.value.selectionTranslatorHotkey).toBe('custom');
        expect(config.value.customSelectionTranslatorHotkey).toBe('F9');
        expect(state.getCustomSelectionHotkeyDisplayName()).toBe('F9');
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(writes.length).toBeGreaterThan(0);
        expect(writes[writes.length - 1].normalized).toMatchObject({
            selectionTranslatorTrigger: 'custom', selectionTranslatorHotkey: 'custom', customSelectionTranslatorHotkey: 'F9',
        });
        for (const {raw, normalized} of writes) {
            if (raw.selectionTranslatorTrigger === 'custom') expect(raw.customSelectionTranslatorHotkey).toBe('F9');
            if (normalized.selectionTranslatorTrigger === 'custom') expect(normalized.selectionTranslatorHotkey).toBe('custom');
        }
        const saved = JSON.stringify(config.value);
        state.handleCustomSelectionHotkeyCancel();
        expect(JSON.stringify(config.value)).toBe(saved);
    });

    it.each([
        {action: 'cancel', opened: false}, {action: 'cancel', opened: true},
        {action: 'leave', opened: false}, {action: 'leave', opened: true},
        {action: 'dispose', opened: false}, {action: 'dispose', opened: true},
    ] as const)('$action / opened=$opened 后仍保留旧 Control，迟到确认不能写入 F9', async ({action, opened}) => {
        const {config, active, scope, state, flushEchoes} = mountWithNormalizedSettingsEcho({selectionTranslatorTrigger: 'Control'});
        state.handleSelectionTriggerChange('custom');
        await flushEchoes();
        if (opened) {
            vi.advanceTimersByTime(100);
            expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        }
        if (action === 'cancel') state.handleCustomSelectionHotkeyCancel();
        else if (action === 'leave') active.value = false;
        else scope.stop();
        await flushEchoes();
        expect(config.value.selectionTranslatorTrigger).toBe('Control');
        expect(config.value.selectionTranslatorHotkey).toBe('Control');
        expect(config.value.customSelectionTranslatorHotkey).toBe('');
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        const saved = JSON.stringify(config.value);
        state.handleCustomSelectionHotkeyConfirm('F9');
        vi.advanceTimersByTime(1000); await flushEchoes();
        expect(JSON.stringify(config.value)).toBe(saved);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
    });

    it.each([false, true])('外部真正改选 contextMenu / opened=%s 会取消草稿且拒绝迟到确认', async opened => {
        const {config, state, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho();
        state.handleSelectionTriggerChange('custom'); await flushEchoes();
        if (opened) {
            vi.advanceTimersByTime(100); expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        }
        await receiveBackend(normalizeConfig({...config.value, selectionTranslatorTrigger: 'contextMenu'}));
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(config.value.selectionTranslatorTrigger).toBe('contextMenu');
        expect(config.value.selectionTranslatorHotkey).toBe('none');
        const saved = JSON.stringify(config.value);
        state.handleCustomSelectionHotkeyCancel(); state.handleCustomSelectionHotkeyConfirm('F9');
        vi.advanceTimersByTime(1000); await flushEchoes();
        expect(JSON.stringify(config.value)).toBe(saved);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
    });

    it.each([false, true])('整份配置替换即使 trigger 同值 / opened=%s 也会取消旧草稿', async opened => {
        const {config, state, flushEchoes} = mountWithNormalizedSettingsEcho({selectionTranslatorTrigger: 'Control'});
        state.handleSelectionTriggerChange('custom'); await flushEchoes();
        if (opened) {
            vi.advanceTimersByTime(100); expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        }
        config.value = normalizeConfig({...config.value, to: 'fr'});
        const replacement = config.value;
        const saved = JSON.stringify(replacement);
        await flushEchoes();
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        state.handleCustomSelectionHotkeyCancel(); state.handleCustomSelectionHotkeyConfirm('F9');
        vi.advanceTimersByTime(1000); await flushEchoes();
        expect(config.value).toBe(replacement);
        expect(JSON.stringify(config.value)).toBe(saved);
        expect(config.value.selectionTranslatorTrigger).toBe('Control');
        expect(config.value.selectionTranslatorHotkey).toBe('Control');
        expect(config.value.customSelectionTranslatorHotkey).toBe('');
    });

    it('等待期间外部保存 F8 仍按旧约定切换 custom，保留镜像并取消待开弹窗', async () => {
        const {config, state, writes, flushEchoes} = mountWithNormalizedSettingsEcho();
        state.handleSelectionTriggerChange('custom'); await flushEchoes();
        // 与原有 pending 外部保存用例相同：只写录制字段，模式切换必须由实际 composable 完成。
        config.value.customSelectionTranslatorHotkey = 'F8';
        await flushEchoes();
        expect(config.value.selectionTranslatorTrigger).toBe('custom');
        expect(config.value.selectionTranslatorHotkey).toBe('custom');
        expect(config.value.customSelectionTranslatorHotkey).toBe('F8');
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(100); expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(writes[writes.length - 1].normalized).toMatchObject({
            selectionTranslatorTrigger: 'custom', selectionTranslatorHotkey: 'custom', customSelectionTranslatorHotkey: 'F8',
        });
        const saved = JSON.stringify(config.value);
        state.handleCustomSelectionHotkeyCancel(); state.handleCustomSelectionHotkeyConfirm('F9');
        await flushEchoes(); expect(JSON.stringify(config.value)).toBe(saved);
    });

    it('legacy custom 空值使用真实 normalizeConfig 回到有效 icon，再次录制取消仍保留有效 fallback', async () => {
        const legacy = Object.assign(new PersistedShortcutConfig(), {
            selectionTranslatorTrigger: 'custom', selectionTranslatorHotkey: 'custom', customSelectionTranslatorHotkey: '',
        });
        expect(normalizeConfig(legacy)).toMatchObject({
            selectionTranslatorTrigger: 'icon', selectionTranslatorHotkey: 'none', customSelectionTranslatorHotkey: '',
        });
        const {config, state, flushEchoes} = mountWithNormalizedSettingsEcho(legacy);
        state.handleSelectionTriggerChange('custom'); await flushEchoes();
        vi.advanceTimersByTime(100); expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        state.handleCustomSelectionHotkeyCancel(); state.handleCustomSelectionHotkeyConfirm('F9');
        await flushEchoes();
        expect(config.value.selectionTranslatorTrigger).toBe('icon');
        expect(config.value.selectionTranslatorHotkey).toBe('none');
        expect(config.value.customSelectionTranslatorHotkey).toBe('');
    });

    it('尚未规范化的 legacy custom 空值在重新选择录制时先保存有效 fallback，echo 不取消弹窗', async () => {
        const legacy = Object.assign(new PersistedShortcutConfig(), {
            selectionTranslatorTrigger: 'custom', selectionTranslatorHotkey: 'custom', customSelectionTranslatorHotkey: '',
        });
        const fallback = normalizeConfig(legacy);
        const {config, state, writes, flushEchoes} = mountWithNormalizedSettingsEcho(legacy, 'legacy');
        state.handleSelectionTriggerChange('custom');
        expect(config.value.selectionTranslatorTrigger).toBe(fallback.selectionTranslatorTrigger);
        expect(config.value.selectionTranslatorHotkey).toBe(fallback.selectionTranslatorHotkey);
        expect(writes.length).toBeGreaterThan(0);
        for (const {raw, normalized} of writes) {
            expect(raw.selectionTranslatorTrigger).toBe(fallback.selectionTranslatorTrigger);
            expect(normalized.selectionTranslatorTrigger).toBe(fallback.selectionTranslatorTrigger);
            expect(normalized.selectionTranslatorHotkey).toBe(fallback.selectionTranslatorHotkey);
        }
        await flushEchoes();
        vi.advanceTimersByTime(100); expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        state.handleCustomSelectionHotkeyCancel(); state.handleCustomSelectionHotkeyConfirm('F9');
        await flushEchoes();
        expect(config.value.selectionTranslatorTrigger).toBe(fallback.selectionTranslatorTrigger);
        expect(config.value.selectionTranslatorHotkey).toBe(fallback.selectionTranslatorHotkey);
        expect(config.value.customSelectionTranslatorHotkey).toBe('');
    });

    it.each(groups.filter(group => group.name !== 'selection'))(
        '$name 在真实 normalized echo 下仍使用原有 custom 空值草稿，并能打开后取消恢复', async group => {
            const {config, state, writes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho();
            state[group.change]('custom');
            expect(config.value[group.mode]).toBe('custom');
            expect(config.value[group.custom]).toBe('');
            expect(writes.some(({raw}) => raw[group.mode] === 'custom' && raw[group.custom] === '')).toBe(true);
            await flushEchoes();
            await receiveBackend(normalizeConfig({...config.value, to: 'fr'}));
            vi.advanceTimersByTime(100); expect(state[group.visible].value).toBe(true);
            state[group.cancel](); await flushEchoes();
            expect(config.value[group.mode]).toBe(group.initial);
            expect(config.value[group.custom]).toBe('');
            expect(state[group.visible].value).toBe(false);
        },
    );
});

describe('划词外部完整配置的触发方式与快捷键值权威性', () => {
    it('等待时完整 Control/F8 外部快照关闭草稿，保留外部触发方式且不静默派生 UI 专属 custom', async () => {
        const {config, state, writes, appliedEchoes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho({
            selectionTranslatorTrigger: 'Control',
        });
        const owner = config.value;
        state.handleSelectionTriggerChange('custom'); await flushEchoes();
        expect(vi.getTimerCount()).toBe(1);
        expect(writes).toEqual([]);
        const external = normalizeConfig({...config.value, to: 'fr', selectionTranslatorTrigger: 'Control',
            selectionTranslatorHotkey: 'Control', customSelectionTranslatorHotkey: 'F8'});
        const serialized = JSON.stringify(external);
        await receiveBackend(external); await flushEchoes();
        expect(appliedEchoes).toEqual([external]);
        expect(config.value).toBe(owner);
        expect(config.value.selectionTranslatorTrigger).toBe('Control');
        expect(config.value.selectionTranslatorHotkey).toBe('Control');
        expect(config.value.customSelectionTranslatorHotkey).toBe('F8');
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(writes).toEqual([]);
        state.handleCustomSelectionHotkeyCancel(); state.handleCustomSelectionHotkeyConfirm('F9');
        vi.advanceTimersByTime(1000); await flushEchoes();
        expect(config.value).toBe(owner);
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(JSON.stringify(external)).toBe(serialized);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(appliedEchoes).toEqual([external]);
        expect(writes).toEqual([]);
    });

    it('录制定时器到期前晚到的 contextMenu/F8 完整快照不被旧 Control 草稿或迟到确认覆盖', async () => {
        const {config, state, writes, appliedEchoes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho({
            selectionTranslatorTrigger: 'Control',
        });
        const owner = config.value;
        state.handleSelectionTriggerChange('custom'); await flushEchoes();
        vi.advanceTimersByTime(99);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
        const external = normalizeConfig({...config.value, to: 'fr', selectionTranslatorTrigger: 'contextMenu',
            selectionTranslatorHotkey: 'none', customSelectionTranslatorHotkey: 'F8'});
        const serialized = JSON.stringify(external);
        await receiveBackend(external); await flushEchoes();
        expect(config.value).toBe(owner);
        expect(config.value.selectionTranslatorTrigger).toBe('contextMenu');
        expect(config.value.selectionTranslatorHotkey).toBe('none');
        expect(config.value.customSelectionTranslatorHotkey).toBe('F8');
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(vi.getTimerCount()).toBe(0);
        state.handleCustomSelectionHotkeyCancel(); state.handleCustomSelectionHotkeyConfirm('F9');
        vi.advanceTimersByTime(1000); await flushEchoes();
        expect(config.value).toBe(owner);
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(JSON.stringify(external)).toBe(serialized);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(appliedEchoes).toEqual([external]);
        expect(writes).toEqual([]);
    });

    it('录制弹窗已打开时外部 Control/F8 快捷键偏好关闭旧草稿，不能自动启用或接受迟到确认', async () => {
        const {config, state, writes, appliedEchoes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho({
            selectionTranslatorTrigger: 'Control',
        });
        const owner = config.value;
        state.handleSelectionTriggerChange('custom'); await flushEchoes();
        vi.advanceTimersByTime(100);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(writes).toEqual([]);
        const external = normalizeConfig({...config.value, to: 'fr', selectionTranslatorTrigger: 'Control',
            selectionTranslatorHotkey: 'Control', customSelectionTranslatorHotkey: 'F8'});
        const serialized = JSON.stringify(external);
        await receiveBackend(external); await flushEchoes();
        expect(config.value).toBe(owner);
        expect(config.value.selectionTranslatorTrigger).toBe('Control');
        expect(config.value.selectionTranslatorHotkey).toBe('Control');
        expect(config.value.customSelectionTranslatorHotkey).toBe('F8');
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        state.handleCustomSelectionHotkeyCancel(); state.handleCustomSelectionHotkeyConfirm('F9');
        vi.advanceTimersByTime(1000); await flushEchoes();
        expect(config.value).toBe(owner);
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(JSON.stringify(external)).toBe(serialized);
        expect(state.showCustomSelectionHotkeyDialog.value).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(appliedEchoes).toEqual([external]);
        expect(writes).toEqual([]);
    });
});


describe('已有自定义录制草稿与其它快捷键的外部回写隔离', () => {
    const groups = [
        {kind: 'page', mode: 'floatingBallHotkey', custom: 'customFloatingBallHotkey',
            open: 'openCustomHotkeyDialog', visible: 'showCustomHotkeyDialog', confirm: 'handleCustomHotkeyConfirm', other: {hotkey: 'Alt'}},
        {kind: 'hover', mode: 'hotkey', custom: 'customHotkey',
            open: 'openCustomMouseHotkeyDialog', visible: 'showCustomMouseHotkeyDialog', confirm: 'handleCustomMouseHotkeyConfirm', other: {floatingBallHotkey: 'F10'}},
        {kind: 'selection', mode: 'selectionTranslatorTrigger', custom: 'customSelectionTranslatorHotkey',
            open: 'openCustomSelectionHotkeyDialog', visible: 'showCustomSelectionHotkeyDialog', confirm: 'handleCustomSelectionHotkeyConfirm', other: {hotkey: 'Alt'}},
    ] as const;

    it.each(groups)('$kind 已打开的 F9 录制草稿不因另一快捷键的完整外部快照而丢失，仍可明确确认', async group => {
        const {config, state, writes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho({
            [group.mode]: 'custom', [group.custom]: 'F9',
        });
        const owner = config.value;
        state[group.open]();
        expect(state[group.visible].value).toBe(true);
        const external = normalizeConfig({...config.value, ...group.other});
        const serialized = JSON.stringify(external);
        await receiveBackend(external); await flushEchoes();
        expect(config.value).toBe(owner);
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(state[group.visible].value).toBe(true);
        expect(writes).toEqual([]);
        state[group.confirm]('F8'); await flushEchoes();
        expect(config.value[group.mode]).toBe('custom');
        expect(config.value[group.custom]).toBe('F8');
        expect(state[group.visible].value).toBe(false);
        expect(writes.length).toBeGreaterThan(0);
        expect(JSON.stringify(external)).toBe(serialized);
    });

    it.each(groups)('$kind 外部实际修改所属 F9 值时关闭旧录制，迟到确认不能覆盖完整快照', async group => {
        const {config, state, writes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho({
            [group.mode]: 'custom', [group.custom]: 'F9',
        });
        const owner = config.value;
        state[group.open]();
        const external = normalizeConfig({...config.value, [group.custom]: 'F8'});
        const serialized = JSON.stringify(external);
        await receiveBackend(external); await flushEchoes();
        expect(config.value).toBe(owner);
        expect(state[group.visible].value).toBe(false);
        state[group.confirm]('F10'); await flushEchoes();
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(JSON.stringify(external)).toBe(serialized);
        expect(writes).toEqual([]);
    });

    it.each(groups)('$kind 外部清空所属值时旧录制也失效，迟到确认不能重新启用', async group => {
        const {config, state, writes, receiveBackend, flushEchoes} = mountWithNormalizedSettingsEcho({
            [group.mode]: 'custom', [group.custom]: 'F9',
        });
        const owner = config.value;
        state[group.open]();
        const external = normalizeConfig({...config.value, [group.custom]: ''});
        const serialized = JSON.stringify(external);
        await receiveBackend(external); await flushEchoes();
        expect(config.value).toBe(owner);
        expect(state[group.visible].value).toBe(false);
        state[group.confirm]('F10'); await flushEchoes();
        expect(JSON.stringify(config.value)).toBe(serialized);
        expect(JSON.stringify(external)).toBe(serialized);
        expect(writes).toEqual([]);
    });
});

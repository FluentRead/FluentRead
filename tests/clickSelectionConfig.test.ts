import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {
    DEFAULT_CLICK_SELECTION_HOTKEY,
    findClickSelectionHotkeyConflict,
    isClickSelectionAvailable,
    matchesClickSelectionShortcut,
    normalizeClickSelectionHotkey,
    resolveReservedClickSelectionHotkey,
} from '@/src/core/config/clickSelection';

function enabled(): Config {
    return Object.assign(new Config(), {on: true, selectionTranslatorMode: 'bilingual', disableSelectionTranslator: false,
        selectionClickSelectEnabled: true});
}
function keyboardEvent(extra: Record<string, unknown> = {}): KeyboardEvent {
    return {key: 'S', code: 'KeyS', ctrlKey: false, altKey: true, shiftKey: true, metaKey: false, ...extra} as KeyboardEvent;
}

describe('两点选取配置与快捷键归属', () => {
    it('设置保留点选组合不随插件暂停释放，实际点选或划词停用才释放', () => {
        const config = {...enabled(), on: false, selectionClickSelectHotkey: 'shift+alt+k'};
        expect(resolveReservedClickSelectionHotkey(config)).toBe('Alt+Shift+K');
        expect(isClickSelectionAvailable(config)).toBe(false);
        expect(resolveReservedClickSelectionHotkey({...config, selectionClickSelectHotkey: undefined})).toBe(DEFAULT_CLICK_SELECTION_HOTKEY);
        for (const patch of [{selectionClickSelectEnabled: false}, {selectionTranslatorMode: 'disabled'}, {disableSelectionTranslator: true}]) {
            expect(resolveReservedClickSelectionHotkey({...config, ...patch})).toBe('');
        }
        expect(resolveReservedClickSelectionHotkey({})).toBe('');
    });
    it('新用户与历史配置保持关闭，显式布尔开启和规范快捷键可往返', () => {
        expect(new Config().selectionClickSelectEnabled).toBe(false);
        expect(new Config().selectionClickSelectHotkey).toBe(DEFAULT_CLICK_SELECTION_HOTKEY);
        for (const selectionClickSelectEnabled of [undefined, null, false, 1, 'true']) {
            expect(normalizeConfig({selectionClickSelectEnabled}).selectionClickSelectEnabled).toBe(false);
        }
        const source = {selectionClickSelectEnabled: true, selectionClickSelectHotkey: 'shift+alt+k'};
        const value = normalizeConfig(source);
        expect(value.selectionClickSelectEnabled).toBe(true);
        expect(value.selectionClickSelectHotkey).toBe('Alt+Shift+K');
        expect(normalizeConfig(JSON.parse(JSON.stringify(value))).selectionClickSelectHotkey).toBe('Alt+Shift+K');
        expect(source.selectionClickSelectHotkey).toBe('shift+alt+k');
    });

    it('只接受含修饰键与主键的组合，不接受 Meta 或正常输入单键', () => {
        expect(DEFAULT_CLICK_SELECTION_HOTKEY).toBe('Alt+Shift+S');
        expect(normalizeClickSelectionHotkey('ctrl+alt+k')).toBe('Ctrl+Alt+K');
        for (const value of [undefined, null, 1, {}, '', 'none', 's', 'Control', 'Alt+Shift', 'Meta+S']) {
            expect(normalizeClickSelectionHotkey(value)).toBe(DEFAULT_CLICK_SELECTION_HOTKEY);
        }
    });

    it('只有插件与划词均可用且显式开启时允许进入，其他状态不占用启动键', () => {
        const config = enabled();
        expect(isClickSelectionAvailable(config)).toBe(true);
        expect(matchesClickSelectionShortcut(keyboardEvent(), config)).toBe(true);
        for (const patch of [{on: false}, {selectionTranslatorMode: 'disabled'}, {disableSelectionTranslator: true}, {selectionClickSelectEnabled: false}]) {
            const unavailable = {...config, ...patch};
            expect(isClickSelectionAvailable(unavailable)).toBe(false);
            expect(matchesClickSelectionShortcut(keyboardEvent(), unavailable)).toBe(false);
        }
        expect(isClickSelectionAvailable({})).toBe(false);
        expect(matchesClickSelectionShortcut(keyboardEvent({shiftKey: false}), config)).toBe(false);
        expect(matchesClickSelectionShortcut(keyboardEvent({key: 'k', code: 'KeyK'}), config)).toBe(false);
        expect(matchesClickSelectionShortcut(keyboardEvent({key: 'Í'}), config)).toBe(true);
        expect(matchesClickSelectionShortcut(keyboardEvent(), {...config, selectionClickSelectHotkey: undefined})).toBe(true);
    });

    it.each([
        ['鼠标悬停翻译', {hotkey: 'custom', customHotkey: 'Alt+Shift+S'}],
        ['全文翻译', {floatingBallHotkey: 'custom', customFloatingBallHotkey: 'Alt+Shift+S'}],
        ['划词翻译', {selectionTranslatorTrigger: 'custom', customSelectionTranslatorHotkey: 'Alt+Shift+S'}],
        ['圈选翻译', {selectionAreaEnabled: true, selectionAreaHotkey: 'custom', customSelectionAreaHotkey: 'Alt+Shift+S'}],
        ['段落复制', {paragraphCopyEnabled: true, paragraphCopyHotkey: 'custom', customParagraphCopyHotkey: 'Alt+Shift+S'}],
        ['局部翻译', {sectionTranslationHotkeyEnabled: true, sectionTranslationHotkey: 'custom', customSectionTranslationHotkey: 'Alt+Shift+S'}],
        ['智能高亮', {informationHighlight: {hotkeyEnabled: true, hotkey: 'shift+alt+s'}}],
        ['额外翻译方案', {quickTranslationProfiles: [{enabled: true, hotkey: 'Alt+Shift+S'}]}],
    ] as const)('与%s冲突时不占用按键，导入配置也不会触发两种功能', (owner, patch) => {
        const config = {...enabled(), ...patch} as Config;
        expect(findClickSelectionHotkeyConflict(config, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe(owner);
        expect(matchesClickSelectionShortcut(keyboardEvent(), config)).toBe(false);
    });

    it('智能高亮快捷键不依赖自动分析与全局暂停，停用快捷键的草稿不占用', () => {
        const config = {...enabled(), on: false, informationHighlight: {enabled: false, hotkeyEnabled: true, hotkey: 'Alt+Shift+S'}};
        expect(findClickSelectionHotkeyConflict(config, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('智能高亮');
        expect(findClickSelectionHotkeyConflict({...config, informationHighlight: {...config.informationHighlight, hotkeyEnabled: false}}, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('');
        expect(findClickSelectionHotkeyConflict({...config, informationHighlight: {hotkeyEnabled: true}}, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('');
        expect(findClickSelectionHotkeyConflict({...config, informationHighlight: {}}, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('');
    });

    it.each([undefined, ''])('已启用但快捷键缺失（%s）的局部高亮配置不阻挡实际点选组合', hotkey => {
        const config = {...enabled(), informationHighlight: {hotkeyEnabled: true, hotkey}};
        expect(findClickSelectionHotkeyConflict(config, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('');
        expect(matchesClickSelectionShortcut(keyboardEvent(), config)).toBe(true);
    });

    it('停用的旧快捷键不阻挡入口，输入翻译与缺失方案列表仍可安全判定', () => {
        const config = {...enabled(), selectionTranslatorMode: 'disabled', disableSelectionTranslator: true,
            selectionTranslatorTrigger: 'custom', customSelectionTranslatorHotkey: DEFAULT_CLICK_SELECTION_HOTKEY,
            selectionAreaEnabled: false, selectionAreaHotkey: 'custom', customSelectionAreaHotkey: DEFAULT_CLICK_SELECTION_HOTKEY,
            paragraphCopyEnabled: false, paragraphCopyHotkey: 'custom', customParagraphCopyHotkey: DEFAULT_CLICK_SELECTION_HOTKEY,
            sectionTranslationHotkeyEnabled: false, sectionTranslationHotkey: 'custom', customSectionTranslationHotkey: DEFAULT_CLICK_SELECTION_HOTKEY,
            quickTranslationProfiles: undefined};
        expect(findClickSelectionHotkeyConflict(config, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('');
        expect(findClickSelectionHotkeyConflict({...config, selectionTranslatorMode: 'bilingual'}, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('');
        expect(findClickSelectionHotkeyConflict({...enabled(), inputBoxTranslationTrigger: 'ctrl_enter'}, 'Ctrl+Enter')).toBe('输入框翻译');
        expect(findClickSelectionHotkeyConflict({
            ...enabled(),
            inputBoxTranslationTrigger: 'custom',
            customInputBoxTranslationHotkey: DEFAULT_CLICK_SELECTION_HOTKEY,
        }, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('输入框翻译');
        expect(findClickSelectionHotkeyConflict({}, DEFAULT_CLICK_SELECTION_HOTKEY)).toBe('');
    });
});

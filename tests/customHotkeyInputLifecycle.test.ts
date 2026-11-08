import {parseHTML} from 'linkedom';
import {createRenderer, h, markRaw, nextTick, reactive, type App} from 'vue';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
vi.mock('@/src/ui/components/UiIcon.vue', () => ({default: {render: () => null}}));
vi.mock('element-plus', async () => ({ElIcon: {setup: (_: unknown, {slots}: any) => () => h('span', {}, slots.default?.())}}));
import component from '@/src/ui/components/CustomHotkeyInput.vue';
import * as hotkeyModule from '@/src/core/hotkey';

let app: App, state: Record<string, any>, props: {modelValue: boolean; currentValue: string; validate?: (value: string) => string};
let doc: Document, active: HTMLElement | null, emitted: Mock, root: HTMLElement;
const handlers = new WeakMap<Element, Record<string, any>>();
async function settle() {await nextTick(); await nextTick();}
async function mount(value = '', initiallyFocused = true, initiallyVisible = true) {
    const parsed = parseHTML('<html><body><button id="prior">prior</button><div id="mount"></div></body></html>');
    doc = parsed.document as unknown as Document;
    const ElementType = parsed.window.HTMLElement;
    vi.stubGlobal('HTMLElement', ElementType); vi.stubGlobal('document', doc);
    active = initiallyFocused ? markRaw(doc.querySelector<HTMLElement>('#prior')!) : null;
    Object.defineProperty(doc, 'activeElement', {configurable: true, get: () => active});
    ElementType.prototype.focus = function () {active = this as unknown as HTMLElement;};
    ElementType.prototype.getClientRects = function () {return [{width: 10, height: 10}] as unknown as DOMRectList;};
    const renderer = createRenderer<any, any>({
        createElement: tag => markRaw(doc.createElement(tag)), createText: text => doc.createTextNode(text),
        createComment: text => doc.createComment(text),
        insert: (child, parent, anchor) => parent.insertBefore(child, anchor || null), remove: node => {if (active && node.contains?.(active)) active = doc.body; node.remove();},
        setText: (node, text) => {node.nodeValue = text;}, setElementText: (node, text) => {node.textContent = text;},
        parentNode: node => node.parentNode, nextSibling: node => node.nextSibling,
        querySelector: selector => doc.querySelector(selector), setScopeId: (node, id) => node.setAttribute(id, ''),
        patchProp: (node, key, _old, value) => {
            if (key.startsWith('on')) {const saved = handlers.get(node) || {}; saved[key] = value; handlers.set(node, saved);}
            else if (key === 'class') node.setAttribute(key, value || '');
            else if (key === 'style') Object.assign(node.style, value || {});
            else if (value === null || value === undefined || value === false) node.removeAttribute(key);
            else node.setAttribute(key, value === true ? '' : String(value));
        },
        insertStaticContent: (html, parent, anchor) => {const wrapper = doc.createElement('div'); wrapper.innerHTML = html;
            const first = wrapper.firstChild!, last = wrapper.lastChild!; while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, anchor); return [first, last];},
    });
    props = reactive({modelValue: initiallyVisible, currentValue: value}); emitted = vi.fn();
    app = renderer.createApp({setup: () => () => h(component, {...props, onConfirm: (value: string) => emitted('confirm', value),
        onCancel: () => emitted('cancel'), 'onUpdate:modelValue': (value: boolean) => {props.modelValue = value; emitted('visible', value);}})});
    app.directive('ui-i18n', {}); app.mount(doc.querySelector('#mount')); await settle();
    const instance = (app as any)._instance.subTree.component;
    state = instance.setupState; root = doc.querySelector('.custom-hotkey-dialog')!;
    return state;
}
function key(value: string, flags: Partial<KeyboardEvent> = {}) {return {key: value, ctrlKey: false, altKey: false, shiftKey: false,
    metaKey: false, code: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...flags} as unknown as KeyboardEvent;}
function click(selector: string) {const target = doc.querySelector(selector)!; handlers.get(target)!.onClick({target, stopPropagation: vi.fn()});}
async function record(value = 'q') {click('.hotkey-input-field'); await settle(); const input = doc.querySelector('.hotkey-input-field')!;
    handlers.get(input)!.onKeydown(key(value, {altKey: true})); handlers.get(input)!.onKeyup(key(value, {altKey: true}));}
beforeEach(() => {vi.useFakeTimers(); expect((component as any).render).toBeTypeOf('function');});
afterEach(async () => {app?.unmount(); await settle(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('真实快捷键录制组件生命周期', () => {
    it('重复释放只保留一个待完成计时器，卸载同步取消它', async () => {
        await mount(); await record();
        for (let i = 0; i < 100; i++) state.handleKeyUp(key('q'));
        expect(vi.getTimerCount()).toBe(1); app.unmount(); expect(vi.getTimerCount()).toBe(0);
    });
    it('取消后重开录制不被上一轮的迟到释放提前结束', async () => {
        await mount(); await record(); vi.advanceTimersByTime(50); click('.secondary-button'); await settle();
        props.modelValue = true; await settle(); await record('d'); vi.advanceTimersByTime(50);
        expect(state.isRecording).toBe(true); vi.advanceTimersByTime(50); await settle();
        expect(state.currentHotkey).toBe('Alt+D'); expect(state.isRecording).toBe(false);
    });
    it('更换当前配置值立即结束旧录制并清理等待', async () => {
        await mount(); await record(); props.currentValue = 'F10'; await settle();
        expect(vi.getTimerCount()).toBe(0); expect(state.isRecording).toBe(false); expect(state.currentHotkey).toBe('F10');
    });
    it('保持挂载但关闭弹窗也取消录制等待', async () => {
        await mount(); await record(); props.modelValue = false; await settle();
        expect(vi.getTimerCount()).toBe(0); expect(state.isRecording).toBe(false);
    });
    it('确认前重新校验刚发生的方案冲突，并显示错误而不发出确认', async () => {
        await mount('F10'); let conflict = ''; props.validate = () => conflict; await settle();
        conflict = 'shortcut already occupied'; click('.primary-button'); await settle();
        expect(emitted).not.toHaveBeenCalledWith('confirm', 'F10');
        expect(doc.querySelector('[role="alert"]')?.textContent).toContain(conflict);
    });
    it('清除录制立即校验业务默认键的占用，拒绝确认并显示原因，冲突解除后允许清除', async () => {
        await mount('F10');let conflict = 'default key already occupied';
        props.validate = value => value === 'none' ? conflict : '';await settle();click('.clear-button');await settle();
        expect(state.canConfirm).toBe(false);expect(doc.querySelector('[role="alert"]')?.textContent).toContain(conflict);
        state.handleConfirm();expect(emitted).not.toHaveBeenCalledWith('confirm', 'none');
        conflict = '';state.handleConfirm();expect(emitted).toHaveBeenCalledWith('confirm', 'none');
    });
    it('清除后的冲突迟到变化也在确认前重新校验，不能沿用之前的有效状态', async () => {
        await mount('F10');let conflict = '';props.validate = value => value === 'none' ? conflict : '';await settle();
        click('.clear-button');await settle();expect(state.canConfirm).toBe(true);conflict = 'new default conflict';
        click('.primary-button');await settle();expect(emitted).not.toHaveBeenCalledWith('confirm', 'none');
        expect(doc.querySelector('[role="alert"]')?.textContent).toContain(conflict);
    });
    it.each(['F10', 'none'])('编辑已有 %s 时，录制完成前不能确认旧值；完成后提交新组合', async saved => {
        await mount(saved);await record('q');expect(vi.getTimerCount()).toBe(1);
        expect(state.canConfirm).toBe(false);state.handleConfirm();expect(emitted).not.toHaveBeenCalledWith('confirm', saved);
        vi.advanceTimersByTime(100);await settle();expect(state.canConfirm).toBe(true);click('.primary-button');
        expect(emitted).toHaveBeenCalledWith('confirm', 'Alt+Q');expect(vi.getTimerCount()).toBe(0);
    });
    it('关闭后的延迟焦点恢复不能抢走另一个已聚焦控件', async () => {
        await mount('F10'); expect(active).toBe(root);
        props.modelValue = false;
        await nextTick(); const replacement = doc.createElement('button'); doc.body.append(replacement); replacement.focus();
        await settle(); expect(active).toBe(replacement);
    });
});

it('实际模板预设、确认、清除和取消按当前有效值工作', async () => {
    await mount(); click('[aria-label="F9"]'); await settle(); expect(state.currentHotkey).toBe('F9');
    click('.primary-button'); expect(emitted).toHaveBeenCalledWith('confirm', 'F9');
    click('.clear-button'); await settle(); expect(state.currentHotkey).toBe('none'); expect(state.displayHotkey).toBe('已禁用');
    click('.primary-button'); expect(emitted).toHaveBeenCalledWith('confirm', 'none');
    click('.secondary-button'); await settle(); expect(props.modelValue).toBe(false); expect(emitted).toHaveBeenCalledWith('cancel');
});
it('普通、修饰组合、Meta 禁用和不支持的键都通过真实按键处理与验证', async () => {
    await mount(); state.handleKeyDown(key('q')); expect(state.pressedKeys.size).toBe(0); state.handleKeyUp(key('q')); expect(vi.getTimerCount()).toBe(0);
    await state.startRecording(); state.handleKeyDown(key('Control', {ctrlKey: true}));
    state.handleKeyDown(key('Shift', {ctrlKey: true, shiftKey: true})); state.handleKeyDown(key('k', {ctrlKey: true, shiftKey: true}));
    state.handleKeyUp(key('k')); vi.advanceTimersByTime(100); await settle(); expect(state.currentHotkey).toBe('Ctrl+Shift+K');
    await state.startRecording(); state.handleKeyDown(key('k', {metaKey: true})); state.handleKeyUp(key('k')); vi.advanceTimersByTime(100); await settle();
    expect(state.errorMessage).toContain('CMD 键已被禁用'); expect(state.canConfirm).toBe(false); state.handleConfirm();
    await state.startRecording(); state.handleKeyDown(key('Unidentified')); state.handleKeyUp(key('Unidentified')); vi.advanceTimersByTime(100); expect(state.isRecording).toBe(true);
    state.handleKeyDown(key('Escape')); await settle(); expect(props.modelValue).toBe(false); expect(state.pressedKeys.size).toBe(0);
    state.handleKeyDown(key('k')); state.handleKeyUp(key('k')); state.handleConfirm(); expect(vi.getTimerCount()).toBe(0);
});
it('普通焦点返回、Tab 边界与无可聚焦控件时的键盘语义保持', async () => {
    await mount('F10'); const buttons = [...root.querySelectorAll<HTMLElement>('button')];
    const first = buttons[0]!, last = buttons.at(-1)!;
    active = root; let event = key('Tab'); state.trapFocus(event); expect(active).toBe(first); expect(event.preventDefault).toHaveBeenCalledOnce();
    active = first; event = key('Tab', {shiftKey: true}); state.trapFocus(event); expect(active).toBe(last);
    active = last; event = key('Tab'); state.trapFocus(event); expect(active).toBe(first);
    active = buttons[1]!; event = key('Tab'); state.trapFocus(event); expect(event.preventDefault).not.toHaveBeenCalled();
    for (const button of buttons) button.remove(); active = doc.body;
    event = key('Tab'); state.trapFocus(event); expect(event.preventDefault).not.toHaveBeenCalled();
    props.modelValue = false; await settle(); expect(active?.id).toBe('prior');
});
it('关闭和卸载阻止尚未完成的录制聚焦；旧焦点节点被移除时不恢复', async () => {
    await mount('F10'); const prior = doc.querySelector('#prior')!; prior.remove();
    const recording = state.startRecording(); state.handleCancel(); await recording; await settle();
    expect(state.isRecording).toBe(false); expect(active?.id).not.toBe('prior');
    await state.startRecording(); state.handleKeyDown(key('q')); state.handleKeyUp(key('q')); state.handleConfirm();
    app.unmount(); await state.startRecording(); state.handleKeyDown(key('q')); state.handleKeyUp(key('q')); state.handleConfirm();
    expect(vi.getTimerCount()).toBe(0);
});
it('预置非法组合显示验证错误，重复开始录制保持一次会话，隐藏初始挂载不抢焦点', async () => {
    await mount('invalid hotkey'); expect(state.errorMessage).not.toBe(''); expect(state.canConfirm).toBe(false);
    await state.startRecording(); const generationKeys = state.pressedKeys; await state.startRecording(); expect(state.pressedKeys).toBe(generationKeys);
    state.selectPreset('Ctrl+W'); await settle(); expect(state.conflictWarning).not.toBe(''); expect(state.isValidHotkey).toBe(false);
    state.clearHotkey(); await settle(); expect(state.canConfirm).toBe(true); expect(state.errorMessage).toBe(''); expect(state.conflictWarning).toBe('');
});

it('无初始焦点及隐藏挂载可安全打开，Shift+Tab 和隐藏控件遵守可见焦点范围', async () => {
    await mount('F10', false, false); expect(active).toBeNull(); state.trapFocus(key('Tab')); await state.startRecording();
    props.modelValue = true; await settle(); root = doc.querySelector('.custom-hotkey-dialog')!;
    const buttons = [...root.querySelectorAll<HTMLElement>('button')];
    Object.defineProperty(buttons[0], 'getClientRects', {value: () => []});
    active = null; state.trapFocus(key('Tab', {shiftKey: true})); expect(active).toBe(buttons.at(-1));
    props.currentValue = ''; await settle(); expect(state.currentHotkey).toBe(''); expect(state.parsedHotkey).toBeNull();
    props.modelValue = false; await settle(); expect(doc.querySelector('.custom-hotkey-dialog')).toBeNull();
});
it('解析与冲突策略返回缺省说明时仍展示可理解的错误和警告', async () => {
    await mount('F10'); const invalid = hotkeyModule.parseHotkey('invalid');
    vi.spyOn(hotkeyModule, 'parseHotkey').mockReturnValueOnce({...invalid, errorMessage: undefined});
    state.validateCurrentHotkey('invalid'); expect(state.errorMessage).toBe('无效的快捷键');
    vi.spyOn(hotkeyModule, 'validateHotkeyConflicts').mockReturnValueOnce({hasConflict: true});
    state.validateCurrentHotkey('F10'); expect(state.conflictWarning).toBe('可能存在冲突');
});


describe('仅修饰键不是一次完成的快捷键录制', () => {
    it.each([
        ['Control', {ctrlKey: true}],
        ['Alt', {altKey: true}],
        ['Shift', {shiftKey: true}],
        ['Meta', {metaKey: true}],
    ] as const)('仅按下并释放 %s 时继续录制，不确认旧值或遗留修饰键', async (modifier, flags) => {
        await mount('F10'); click('.hotkey-input-field'); await settle();
        const input = doc.querySelector('.hotkey-input-field')!;
        const down = key(modifier, flags), up = key(modifier);
        handlers.get(input)!.onKeydown(down); handlers.get(input)!.onKeyup(up);
        expect(down.preventDefault).toHaveBeenCalledOnce(); expect(up.preventDefault).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(100); await settle();
        expect(state.isRecording).toBe(true); expect(state.currentHotkey).toBe('F10');
        expect(state.pressedKeys.size).toBe(0); expect(state.canConfirm).toBe(false); expect(vi.getTimerCount()).toBe(0);
        expect(doc.querySelector('.recording-text')).not.toBeNull(); expect(doc.querySelector('.hotkey-display')).toBeNull();
        expect(doc.querySelector('.hotkey-status')).toBeNull(); expect(doc.querySelector('.primary-button')!.hasAttribute('disabled')).toBe(true);
        state.handleConfirm(); expect(emitted).not.toHaveBeenCalled();

        // 随后的裸功能键通过同一真实模板事件入口录入，不继承已释放的 Ctrl/Alt/Shift/Meta。
        handlers.get(input)!.onKeydown(key('F9')); handlers.get(input)!.onKeyup(key('F9'));
        vi.advanceTimersByTime(100); await settle();
        expect(state.isRecording).toBe(false); expect(state.currentHotkey).toBe('F9'); expect(state.canConfirm).toBe(true);
        expect(doc.querySelector('.hotkey-display')?.textContent).toBe('F9'); expect(vi.getTimerCount()).toBe(0);
        click('.primary-button'); expect(emitted).toHaveBeenCalledOnce(); expect(emitted).toHaveBeenCalledWith('confirm', 'F9');
    });
    it.each(['', 'none'])('旧草稿为 %s 时，修饰键释放不自动清除、确认或结束录制', async saved => {
        await mount(saved); click('.hotkey-input-field'); await settle();
        const input = doc.querySelector('.hotkey-input-field')!;
        handlers.get(input)!.onKeydown(key('Control', {ctrlKey: true})); handlers.get(input)!.onKeyup(key('Control'));
        vi.advanceTimersByTime(100); await settle();
        expect(state.isRecording).toBe(true); expect(state.currentHotkey).toBe(saved); expect(state.canConfirm).toBe(false);
        expect(doc.querySelector('.primary-button')!.hasAttribute('disabled')).toBe(true); state.handleConfirm();
        expect(emitted).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
        click('.secondary-button'); await settle();
        expect(props.modelValue).toBe(false); expect(props.currentValue).toBe(saved); expect(state.currentHotkey).toBe(saved);
        expect(emitted).toHaveBeenCalledWith('cancel'); expect(emitted).toHaveBeenCalledWith('visible', false);
        expect(emitted.mock.calls.some(([kind]) => kind === 'confirm')).toBe(false);
    });
    it('仅修饰键尚未完成时，显式预设和清除仍结束录制并取消旧计时器', async () => {
        await mount('F10'); click('.hotkey-input-field'); await settle();
        let input = doc.querySelector('.hotkey-input-field')!;
        handlers.get(input)!.onKeydown(key('Control', {ctrlKey: true})); handlers.get(input)!.onKeyup(key('Control'));
        vi.advanceTimersByTime(100); await settle(); expect(state.isRecording).toBe(true);
        click('[aria-label="F9"]'); await settle();
        expect(state.currentHotkey).toBe('F9'); expect(state.isRecording).toBe(false); expect(state.canConfirm).toBe(true);
        expect(emitted).not.toHaveBeenCalled();
        click('.hotkey-input-field'); await settle(); input = doc.querySelector('.hotkey-input-field')!;
        handlers.get(input)!.onKeydown(key('Shift', {shiftKey: true})); handlers.get(input)!.onKeyup(key('Shift'));
        expect(vi.getTimerCount()).toBe(1); click('.clear-button'); await settle();
        expect(state.currentHotkey).toBe('none'); expect(state.isRecording).toBe(false); expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(100); await settle(); expect(state.currentHotkey).toBe('none');
        click('.primary-button'); expect(emitted).toHaveBeenCalledOnce(); expect(emitted).toHaveBeenCalledWith('confirm', 'none');
    });
});


describe('修饰键释放后的计时窗口与组合释放顺序', () => {
    it('松开 Ctrl 后 100ms 内按裸 F9，不继承已释放的 Ctrl 或确认旧 F10', async () => {
        await mount('F10'); click('.hotkey-input-field'); await settle();
        const input = doc.querySelector('.hotkey-input-field')!;
        handlers.get(input)!.onKeydown(key('Control', {ctrlKey: true})); handlers.get(input)!.onKeyup(key('Control'));
        expect(state.pressedKeys.size).toBe(0); expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(50); await settle();
        expect(state.currentHotkey).toBe('F10'); expect(state.isRecording).toBe(true); expect(state.canConfirm).toBe(false);
        expect(doc.querySelector('.hotkey-status')).toBeNull(); expect(doc.querySelector('.primary-button')!.hasAttribute('disabled')).toBe(true);
        state.handleConfirm(); expect(emitted).not.toHaveBeenCalled();
        handlers.get(input)!.onKeydown(key('F9')); handlers.get(input)!.onKeyup(key('F9'));
        expect([...state.pressedKeys]).toEqual(['f9']); expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(100); await settle();
        expect(state.currentHotkey).toBe('F9'); expect(state.isRecording).toBe(false); expect(state.canConfirm).toBe(true);
        expect(doc.querySelector('.hotkey-display')?.textContent).toBe('F9'); expect(vi.getTimerCount()).toBe(0);
        click('.primary-button'); expect(emitted).toHaveBeenCalledOnce(); expect(emitted).toHaveBeenCalledWith('confirm', 'F9');
    });
    it.each(['modifier-first', 'regular-first'] as const)('已有普通键时 %s 释放，完整保留真实录下的 Ctrl+F9', async order => {
        await mount('F10'); click('.hotkey-input-field'); await settle();
        const input = doc.querySelector('.hotkey-input-field')!;
        handlers.get(input)!.onKeydown(key('Control', {ctrlKey: true})); handlers.get(input)!.onKeydown(key('F9', {ctrlKey: true}));
        const first = order === 'modifier-first' ? key('Control') : key('F9', {ctrlKey: true});
        const last = order === 'modifier-first' ? key('F9') : key('Control');
        handlers.get(input)!.onKeyup(first);
        expect([...state.pressedKeys]).toEqual(['ctrl', 'f9']); expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(50); await settle();
        expect(state.isRecording).toBe(true); expect(state.canConfirm).toBe(false); expect(state.currentHotkey).toBe('F10');
        handlers.get(input)!.onKeyup(last); expect([...state.pressedKeys]).toEqual(['ctrl', 'f9']); expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(100); await settle();
        expect(state.currentHotkey).toBe('Ctrl+F9'); expect(state.isRecording).toBe(false); expect(state.canConfirm).toBe(true);
        expect(doc.querySelector('.hotkey-display')?.textContent).toBe(state.displayHotkey); expect(vi.getTimerCount()).toBe(0);
        click('.primary-button'); expect(emitted).toHaveBeenCalledOnce(); expect(emitted).toHaveBeenCalledWith('confirm', 'Ctrl+F9');
    });
    it('旧释放计时器遇到新按住的修饰键仍继续录制，后续普通键使用实时修饰键状态', async () => {
        await mount('F10'); click('.hotkey-input-field'); await settle();
        const input = doc.querySelector('.hotkey-input-field')!;
        handlers.get(input)!.onKeydown(key('Control', {ctrlKey: true})); handlers.get(input)!.onKeyup(key('Control'));
        vi.advanceTimersByTime(50); handlers.get(input)!.onKeydown(key('Alt', {altKey: true}));
        expect([...state.pressedKeys]).toEqual(['alt']); vi.advanceTimersByTime(50); await settle();
        expect(state.isRecording).toBe(true); expect(state.currentHotkey).toBe('F10'); expect(state.canConfirm).toBe(false);
        expect(state.pressedKeys.size).toBe(0); expect(vi.getTimerCount()).toBe(0); expect(emitted).not.toHaveBeenCalled();
        handlers.get(input)!.onKeydown(key('F9', {altKey: true})); handlers.get(input)!.onKeyup(key('F9', {altKey: true}));
        vi.advanceTimersByTime(100); await settle();
        expect(state.currentHotkey).toBe('Alt+F9'); expect(state.isRecording).toBe(false); expect(state.canConfirm).toBe(true);
        expect(vi.getTimerCount()).toBe(0); click('.primary-button');
        expect(emitted).toHaveBeenCalledOnce(); expect(emitted).toHaveBeenCalledWith('confirm', 'Alt+F9');
    });
});

it('业务冲突配置变化时即时更新确认按钮，不要求用户重录相同快捷键', async () => {
    await mount('F10');
    const validation = reactive({conflict: 'This shortcut is now occupied'});
    props.validate = () => validation.conflict;
    await settle();
    expect(doc.querySelector('.primary-button')!.hasAttribute('disabled')).toBe(true);
    expect(doc.querySelector('[role="alert"]')?.textContent).toBe(validation.conflict);
    validation.conflict = '';await settle();
    expect(doc.querySelector('.primary-button')!.hasAttribute('disabled')).toBe(false);
    expect(doc.querySelector('[role="alert"]')).toBeNull();
    click('.primary-button');expect(emitted).toHaveBeenCalledWith('confirm', 'F10');
    props.validate = () => 'Replacement validation';await settle();
    expect(doc.querySelector('.primary-button')!.hasAttribute('disabled')).toBe(true);
});

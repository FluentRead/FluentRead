import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window} = parseHTML('<html><body></body></html>');
    for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
});
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}));

import {createApp, defineComponent, h, KeepAlive, nextTick, reactive, ref, type App} from 'vue';
import PopupSiteRule from '@/src/app/popup/PopupSiteRule.vue';

let app: App | undefined;
let host: HTMLDivElement;
const always = vi.fn(), disabled = vi.fn();
const Empty = defineComponent({render: () => null});
const defaults = () => ({active: true, context: {}, domain: 'example.com', supported: true,
    alwaysTranslated: false, alwaysPaused: false, extensionDisabled: false, autoTranslate: false,
    translating: false, saving: false, switchLabel: '始终翻译 example.com', extensionSwitchLabel: '禁用 example.com'});
type Props = ReturnType<typeof defaults>;

async function mount(overrides: Partial<Props> = {}, keepAlive = false) {
    const props = reactive({...defaults(), ...overrides});
    const shown = ref(true);
    const component = () => h(PopupSiteRule, {...props,
        'onSet-always-translated': always, 'onSet-extension-disabled': disabled});
    app = createApp({render: () => keepAlive
        ? h(KeepAlive, null, {default: () => shown.value ? component() : h(Empty)}) : component()});
    app.mount(host);
    await nextTick();
    return {props, shown};
}
function button(kind: 'always' | 'disabled'): HTMLButtonElement {
    return host.querySelector(`[data-setting="${kind === 'always' ? 'always-translate-site' : 'disable-extension-site'}"]`)!;
}
function click(kind: 'always' | 'disabled') {button(kind).dispatchEvent(new Event('click', {bubbles: true}));}
function captured(kind: 'always' | 'disabled'): () => void {
    // 保留真实模板注册的动作，模拟第三方控件在页面状态变化后交付旧事件。
    const invokers = Object.getOwnPropertySymbols(button(kind)).map(key => (button(kind) as any)[key]);
    const actions = invokers.find(value => value?.onClick)?.onClick?.value;
    expect(actions).toBeTypeOf('function');
    return actions;
}
beforeEach(() => {vi.clearAllMocks();host = document.createElement('div');document.body.append(host);});
afterEach(() => {app?.unmount();app = undefined;host.remove();});

describe('PopupSiteRule 真实组件的网站规则与事件归属', () => {
    it('网站区只显示两个网站开关', async () => {
        await mount();
        expect([...host.querySelectorAll('button')]).toEqual([button('always'), button('disabled')]);
    });

    it('显示域名、作用域与可访问状态，发送开启和关闭意图', async () => {
        const {props} = await mount();
        expect(button('always').getAttribute('aria-checked')).toBe('false');
        expect(button('always').getAttribute('data-site-domain')).toBe('example.com');
        expect(button('always').getAttribute('aria-description')).toContain('及其子域名');
        expect(button('disabled').getAttribute('title')).toContain('禁用优先于自动翻译');
        expect(button('always').textContent).toContain('始终翻译此网站');
        click('always');click('disabled');
        expect(always).toHaveBeenLastCalledWith(true);expect(disabled).toHaveBeenLastCalledWith(true);
        props.alwaysTranslated = true;props.extensionDisabled = true;await nextTick();
        expect(button('always').textContent).toContain('始终翻译已开启');
        expect(button('disabled').textContent).toContain('已禁用扩展');
        expect(button('disabled').getAttribute('aria-checked')).toBe('true');
        click('disabled');expect(disabled).toHaveBeenLastCalledWith(false);
        props.extensionDisabled = false;await nextTick();click('always');
        expect(always).toHaveBeenLastCalledWith(false);
    });

    it.each([
        {label: '不支持的页面', state: {supported: false}, allowDisable: false},
        {label: '正在保存', state: {saving: true}, allowDisable: false},
        {label: '正在翻译', state: {translating: true}, allowDisable: true},
        {label: '全局自动翻译', state: {autoTranslate: true}, allowDisable: true},
        {label: '网站已禁用', state: {extensionDisabled: true}, allowDisable: true},
        {label: '面板不活跃', state: {active: false}, allowDisable: false},
    ])('$label 时按功能边界限制动作', async ({state, allowDisable}) => {
        await mount(state);
        click('always');click('disabled');
        expect(always).not.toHaveBeenCalled();
        expect(disabled).toHaveBeenCalledTimes(allowDisable ? 1 : 0);
        if ('saving' in state) {
            expect(button('always').getAttribute('aria-busy')).toBe('true');
            expect(host.querySelectorAll('.site-rule-saving')).toHaveLength(2);
        }
        if ('supported' in state) expect(host.firstElementChild?.getAttribute('title')).toBe('popup.unsupportedPage');
        if ('autoTranslate' in state) expect(button('always').textContent).toContain('全局自动翻译');
    });

    it('暂停提示优先于全局与单站开启提示，站点禁用仍可中断在途翻译', async () => {
        await mount({alwaysPaused: true, autoTranslate: true, alwaysTranslated: true, translating: true});
        expect(button('always').textContent).toContain('自动翻译已暂停');
        click('disabled');expect(disabled).toHaveBeenCalledWith(true);
    });

    it.each(['domain', 'context', 'active', 'supported', 'alwaysTranslated', 'alwaysPaused', 'extensionDisabled', 'autoTranslate', 'translating', 'saving'] as const)(
        '%s 变化会废弃先前捕获的两个动作', async key => {
            const {props} = await mount();const oldAlways = captured('always'), oldDisabled = captured('disabled');
            Object.assign(props, {[key]: key === 'domain' ? 'other.example' : key === 'context' ? {} : !props[key]});
            await nextTick();oldAlways();oldDisabled();
            expect(always).not.toHaveBeenCalled();expect(disabled).not.toHaveBeenCalled();
        },
    );

    it('KeepAlive 停用与重新激活不复活旧动作，新动作仍正常工作', async () => {
        const {shown} = await mount({}, true);const oldAlways = captured('always'), oldDisabled = captured('disabled');
        shown.value = false;await nextTick();oldAlways();oldDisabled();
        shown.value = true;await nextTick();oldAlways();oldDisabled();
        expect(always).not.toHaveBeenCalled();expect(disabled).not.toHaveBeenCalled();
        click('always');click('disabled');expect(always).toHaveBeenCalledWith(true);expect(disabled).toHaveBeenCalledWith(true);
    });

    it('卸载后旧事件不发送任何网站规则变更', async () => {
        await mount();const oldAlways = captured('always'), oldDisabled = captured('disabled');
        app!.unmount();app = undefined;oldAlways();oldDisabled();
        expect(always).not.toHaveBeenCalled();expect(disabled).not.toHaveBeenCalled();
    });
});

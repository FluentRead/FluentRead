import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window} = parseHTML('<html><body></body></html>');
    for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Node', 'Event']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
});
const calls = vi.hoisted(() => ({list: vi.fn()}));
vi.mock('@/src/features/settings/model/sitePreferences', async original => {
    const actual = await original<typeof import('@/src/features/settings/model/sitePreferences')>();
    calls.list.mockImplementation(actual.listSitePreferences);
    return {...actual, listSitePreferences: calls.list};
});
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('element-plus', async () => {
    const {defineComponent, h} = await import('vue');
    return {ClickOutside: {}, ElSelect: defineComponent({props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
        setup: (props, {attrs, emit, slots, expose}) => {
            expose({blur() {}});
            return () => h('div', attrs, [h('input', {'data-select-port': '', value: props.modelValue, disabled: props.disabled,
                onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)}), slots.default?.()]);
        }}),
    };
});

import {createApp, defineComponent, h, nextTick, reactive, type App} from 'vue';
import SitePreferencesSettings from '@/src/features/settings/ui/SitePreferencesSettings.vue';
import SiteRulePreview from '@/src/features/settings/ui/SiteRulePreview.vue';
import type {SiteAdaptationSettings} from '@/src/core/site-adaptation/types';
import type {SitePreferences, SitePreferenceLists} from '@/src/features/settings/model/sitePreferences';

type Patch = Partial<SitePreferenceLists> & {autoTranslate?: boolean};
let app: App | undefined, host: HTMLDivElement;
const defaults = (): SitePreferences => ({on: true, autoTranslate: false, disableFloatingBall: false,
    alwaysTranslateDomains: [], disabledExtensionDomains: [], floatingBallDisabledDomains: []});
const settle = async () => {for (let tick = 0; tick < 5; tick += 1) await nextTick();};
async function mount(settings: Partial<SitePreferences> = {}, save?: (patch: Patch) => Promise<void>) {
    const props = reactive({settings: {...defaults(), ...settings}, savePreferences: vi.fn(async (patch: Patch) => {
        await save?.(patch);
        Object.assign(props.settings, patch);
    })});
    app = createApp({render: () => h(SitePreferencesSettings, props)});
    app.component('ElOption', defineComponent({props: ['value', 'label'], setup: p => () => h('span', {'data-option': p.value}, p.label)}));
    app.component('ElSwitch', defineComponent({props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
        setup: (p, {attrs, emit}) => () => h('input', {...attrs, type: 'checkbox', checked: p.modelValue, disabled: p.disabled,
            onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).checked)})}));
    app.mount(host);await settle();return props;
}
function get<T extends Element = HTMLElement>(selector: string): T {const node = host.querySelector<T>(selector);expect(node, selector).not.toBeNull();return node!;}
function fire(node: Element, type: string) {node.dispatchEvent(new Event(type, {bubbles: true, cancelable: true}));}
async function input(selector: string, value: string, type = 'input') {const node = get<HTMLInputElement>(selector);node.value = value;fire(node, type);await settle();}
async function submit(value: string) {await input('input[inputmode="url"]', value);fire(get('form'), 'submit');await settle();}
async function click(selector: string) {fire(get(selector), 'click');await settle();}
beforeEach(() => {vi.clearAllMocks();host = document.createElement('div');document.body.append(host);});
afterEach(() => {app?.unmount();app = undefined;host.remove();});

describe('网站偏好真实 SFC 编辑与保存', () => {
    it('真实预览表单解释站点显示优先级、过期输入和非法网址，并允许检查命中的正文规则', async () => {
        const inspect = vi.fn();
        const adaptation: SiteAdaptationSettings = {enabled: true, disabledRuleIds: [], custom: {version: 1, rules: [
            {id: 'fixture-display', name: 'Fixture display scope', match: {hosts: ['example.com']}, mode: 'focus', content: [{css: ['article']}], allScopes: true},
        ]}};
        const props = reactive({settings: {...defaults(), display: 1, translationOnlyDomains: ['example.com']}, adaptation, scope: 'content' as 'content' | 'all', onInspectRule: inspect});
        app = createApp({render: () => h(SiteRulePreview, props)}); app.mount(host); await settle();
        expect(host.querySelector('.preview-states')).toBeNull();
        await input('input[inputmode="url"]', 'https://example.com/article'); fire(get('form'), 'submit'); await settle();
        expect(get('.preview-states').textContent).toContain('仅显示译文'); expect(host.textContent).toContain('限定范围：只翻译指定的正文区域');
        await click('[data-preview-rule="fixture-display"] button'); expect(inspect).toHaveBeenCalledWith('fixture-display');
        props.settings.translationOnlyDomains = []; await settle(); expect(get('.preview-states').textContent).toContain('双语对照');
        props.settings.display = 0; await settle(); expect(get('.preview-states').textContent).toContain('仅显示译文');
        props.settings.disabledExtensionDomains = ['example.com']; await settle(); expect(host.textContent).toContain('扩展功能未运行');
        props.scope = 'all'; await settle(); expect(host.textContent).toContain('仅显式声明 allScopes');
        await input('input[inputmode="url"]', 'https://another.test/'); expect(host.textContent).toContain('网址已修改，请重新检查');
        await input('input[inputmode="url"]', 'not a URL'); fire(get('form'), 'submit'); await settle(); expect(get('[role="alert"]').textContent).toContain('请输入以 http:// 或 https://');
    });
    it('只归一化一次网站集合，搜索复用已排序行并响应外部名单变化', async () => {
        const props = await mount({alwaysTranslateDomains: ['docs.example.com', 'second.net'], disabledExtensionDomains: ['example.com']});
        expect(host.querySelectorAll('[data-site-preference]')).toHaveLength(2);
        expect(calls.list).toHaveBeenCalledOnce();
        await input('input[type="search"]', ' EXAMPLE ');
        expect(host.querySelectorAll('[data-site-preference]')).toHaveLength(1);
        expect(get('[data-site-preference]').getAttribute('data-site-preference')).toBe('example.com');
        expect(calls.list).toHaveBeenCalledOnce();
        props.settings.alwaysTranslateDomains.push('third.org');await settle();
        expect(calls.list).toHaveBeenCalledTimes(2);
        await input('input[type="search"]', 'missing');expect(host.textContent).toContain('没有匹配的网站');
        await input('input[type="search"]', '');expect(host.querySelectorAll('[data-site-preference]')).toHaveLength(3);
    });

    it.each(['always', 'disabled', 'hidden', 'single'])('添加 %s 偏好只提交对应名单并规范网站作用域', async preference => {
        const props = await mount();
        expect(host.textContent).toContain('尚未添加网站偏好');
        await input('[data-select-port]', preference, 'change');
        await submit('https://docs.example.com/article?a=1');
        const field = preference === 'always' ? 'alwaysTranslateDomains' : preference === 'disabled' ? 'disabledExtensionDomains' : preference === 'single' ? 'translationOnlyDomains' : 'floatingBallDisabledDomains';
        expect(props.savePreferences).toHaveBeenCalledOnce();
        expect(props.settings[field]).toEqual(['example.com']);
        expect(props.savePreferences.mock.calls[0][0]).not.toHaveProperty('on');
        expect(get<HTMLInputElement>('input[inputmode="url"]').value).toBe('');
        expect(host.textContent).toContain('网站偏好已保存');
    });

    it('仅译文保存失败保留行，重试与删除撤销保留其他页面新增的同站偏好', async () => {
        const save = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);
        const props = await mount({translationOnlyDomains: ['example.com']}, save);
        const box = get<HTMLInputElement>('input[aria-label="仅显示译文 example.com"]');
        box.checked = false; fire(box, 'change'); await settle();
        expect(props.settings.translationOnlyDomains).toEqual(['example.com']); expect(host.textContent).toContain('保存失败');
        box.checked = false; fire(box, 'change'); await settle();
        expect(props.settings.translationOnlyDomains).toEqual([]);
        await input('[data-select-port]', 'single', 'change'); await submit('example.com');
        await submit('example.com'); expect(host.textContent).toContain('该网站已有此偏好');
        await click('[data-site-preference="example.com"] button');
        props.settings.translationOnlyDomains = ['example.com']; props.settings.alwaysTranslateDomains = ['example.com']; await settle();
        await click('.rule-actions button');
        expect(props.settings.translationOnlyDomains).toEqual(['example.com']); expect(props.settings.alwaysTranslateDomains).toEqual(['example.com']);
    });

    it('拒绝无效网站与重复偏好，同时允许为已有网站补充另一偏好', async () => {
        const props = await mount({alwaysTranslateDomains: ['example.com']});
        await submit('not a domain');expect(host.textContent).toContain('请输入有效');expect(props.savePreferences).not.toHaveBeenCalled();
        await submit('example.com');expect(host.textContent).toContain('该网站已有此偏好');expect(get<HTMLInputElement>('input[type="search"]').value).toBe('example.com');
        await input('[data-select-port]', 'hidden', 'change');await submit('example.com');
        expect(props.settings.alwaysTranslateDomains).toEqual(['example.com']);
        expect(props.settings.floatingBallDisabledDomains).toEqual(['example.com']);
    });

    it('保存失败保留输入与原名单，重试成功后才显示完成状态', async () => {
        const save = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue(undefined);
        const props = await mount({}, save);
        await submit('example.com');expect(host.textContent).toContain('保存失败');
        expect(props.settings.alwaysTranslateDomains).toEqual([]);expect(get<HTMLInputElement>('input[inputmode="url"]').value).toBe('example.com');
        fire(get('form'), 'submit');await settle();expect(props.settings.alwaysTranslateDomains).toEqual(['example.com']);
        expect(host.textContent).toContain('网站偏好已保存');
    });

    it('保存期间禁用控件并合并重复提交，等待后台确认后再解锁', async () => {
        let finish!: () => void;
        const pending = new Promise<void>(resolve => {finish = resolve;});
        const props = await mount({}, () => pending);
        await submit('example.com');fire(get('form'), 'submit');await settle();
        expect(props.savePreferences).toHaveBeenCalledOnce();expect(get<HTMLInputElement>('input[inputmode="url"]').disabled).toBe(true);
        expect(host.textContent).toContain('正在保存');expect(props.settings.alwaysTranslateDomains).toEqual([]);
        finish();await settle();expect(props.settings.alwaysTranslateDomains).toEqual(['example.com']);expect(get<HTMLInputElement>('input[inputmode="url"]').disabled).toBe(false);
    });

    it('删除后撤销合并后来新增的同站偏好，不覆盖其他网站', async () => {
        const props = await mount({alwaysTranslateDomains: ['example.com', 'second.net']});
        await click('[data-site-preference="example.com"] button');
        expect(props.settings.alwaysTranslateDomains).toEqual(['second.net']);
        props.settings.floatingBallDisabledDomains = ['example.com'];await settle();
        await click('.rule-actions button');
        expect(props.settings.alwaysTranslateDomains).toEqual(['second.net', 'example.com']);
        expect(props.settings.floatingBallDisabledDomains).toEqual(['example.com']);
        expect(host.querySelector('.rule-actions')).toBeNull();
    });

    it('删除失败保留行，撤销失败保留恢复入口，重试合并其他页面刚保存的偏好', async () => {
        const save = vi.fn().mockRejectedValueOnce(new Error('remove failed')).mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('undo failed')).mockResolvedValue(undefined);
        const props = await mount({floatingBallDisabledDomains: ['example.com']}, save);
        await click('[data-site-preference="example.com"] button');
        expect(host.querySelector('[data-site-preference="example.com"]')).not.toBeNull();
        expect(host.querySelector('.rule-actions')).toBeNull();
        await click('[data-site-preference="example.com"] button');
        props.settings.alwaysTranslateDomains = ['example.com'];await settle();
        const undo = get('.rule-actions button');
        fire(undo, 'click');await settle();
        expect(host.textContent).toContain('保存失败');
        expect(host.querySelector('.rule-actions button')).toBe(undo);
        expect(props.settings.floatingBallDisabledDomains).toEqual([]);
        fire(undo, 'click');await settle();
        expect(props.settings.alwaysTranslateDomains).toEqual(['example.com']);
        expect(props.settings.floatingBallDisabledDomains).toEqual(['example.com']);
        expect(host.querySelector('.rule-actions')).toBeNull();
        fire(undo, 'click');await settle();
        expect(props.savePreferences).toHaveBeenCalledTimes(4);
    });

    it('更改单站三项偏好和全局自动翻译，并解释禁用、暂停及继承状态', async () => {
        const props = await mount({alwaysTranslateDomains: ['example.com', 'visible.org'], floatingBallDisabledDomains: ['hidden.net', 'example.com'],
            autoTranslate: true, disableFloatingBall: true});
        expect(host.textContent).toContain('自动翻译 · 全局开启');expect(host.textContent).toContain('已隐藏 · 全局设置');
        for (let index = 0; index < 3; index += 1) {
            const checkbox = host.querySelectorAll<HTMLInputElement>('[data-site-preference="example.com"] input')[index];
            checkbox.checked = [false, true, false][index];fire(checkbox, 'change');await settle();
            if (index === 1) expect(host.textContent).toContain('已禁用扩展，其他偏好暂不生效');
        }
        expect(props.settings.alwaysTranslateDomains).toEqual(['visible.org']);expect(props.settings.disabledExtensionDomains).toEqual(['example.com']);
        expect(props.settings.floatingBallDisabledDomains).toEqual(['hidden.net']);
        const global = get<HTMLInputElement>('.rule-toggle-row input');global.checked = false;fire(global, 'change');await settle();expect(props.settings.autoTranslate).toBe(false);
        props.settings.on = false;await settle();expect(host.textContent).toContain('插件已关闭');
    });
});

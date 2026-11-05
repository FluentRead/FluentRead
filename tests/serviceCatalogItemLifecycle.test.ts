/**
 * @file tests/serviceCatalogItemLifecycle.test.ts
 * 文件职责：执行真实服务目录行与性质徽章的客户端模板，验证选择事件和名称旁标签随公开输入更新。
 * 主要内容：覆盖完整名称与提示、标签同行结构、默认/已保存/常用优先级、紧凑状态、服务替换、性质条件和七种界面语言。
 * 模块边界：保留实际 Vue 模板、性质判断与语言字典；只替换图标展示和语言上下文端口，不读取组件私有状态、不模拟布局测量或配置写入。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {dirname, resolve} from 'node:path';
import {compileVueInlineFixture} from './helpers/compiledVueFixture';

const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
    return {document: document as unknown as Document, Event: window.Event};
});

import * as Vue from 'vue';
import * as compositeTranslation from '@/src/core/config/compositeTranslation';
import {translate, translateLegacyText, type TranslationParams, type UiLanguage} from '@/src/core/i18n';
import type {ServiceOption} from '@/src/ui/view-model/serviceCatalog';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

registerAllUiLanguageBundles();
const locale = Vue.ref<UiLanguage>('zh-CN');
const i18nPort = {useUiI18n: () => ({
    t: (key: string, params?: TranslationParams) => translate(key, locale.value, params),
    translateLegacy: (value: string) => translateLegacyText(value, locale.value),
})};
const ServiceIcon = Vue.defineComponent({props: ['service', 'label', 'size'],
    setup: () => () => Vue.h('span', {'data-service-icon-port': '', 'aria-hidden': 'true'})});

function loadClient(relative: string, components = new Map<string, Vue.Component>()): Vue.Component {
    if (components.has(relative)) return components.get(relative)!;
    const filename = resolve(process.cwd(), relative);
    const compiled = compileVueInlineFixture(filename, {id: relative});
    const dependencies: Record<string, unknown> = {
        vue: Vue,
        '@/src/ui/i18n': i18nPort,
        '@/src/core/config/compositeTranslation': compositeTranslation,
        '@/src/ui/components/ServiceIcon.vue': {default: ServiceIcon},
        './service-badges.css': {},
    };
    const module = {exports: {} as {default: Vue.Component}};
    new Function('require', 'exports', 'module', compiled.code)((id: string) => {
        if (id in dependencies) return dependencies[id];
        if (id.endsWith('.vue')) {
            const path = id.startsWith('@/') ? id.slice(2) : resolve(dirname(filename), id);
            return {default: loadClient(path, components)};
        }
        throw new Error(`Unexpected service badge dependency: ${id}`);
    }, module.exports, module);
    components.set(relative, module.exports.default);
    return module.exports.default;
}

type ItemProps = {
    item: ServiceOption; selected: boolean; isDefault: boolean; isConfigured: boolean;
    isFavorite: boolean; compact: boolean; status: string; availabilityEnabled?: boolean; availabilityToggleDisabled?: boolean;
};
let app: Vue.App | undefined, root: HTMLElement;
async function settle(): Promise<void> {await Vue.nextTick(); await Vue.nextTick();}
async function mount(component: Vue.Component, props: Record<string, unknown>, onSelect?: (value: string) => void,
    onToggleAvailability?: (service: string, enabled: boolean) => void): Promise<void> {
    root = dom.document.createElement('div'); dom.document.body.append(root);
    app = Vue.createApp({setup: () => () => Vue.h(component, {...props, ...(onSelect ? {onSelect} : {}), ...(onToggleAvailability ? {onToggleAvailability} : {})})});
    app.component('el-tooltip', Vue.defineComponent({setup: (_props, {slots}) => () => Vue.h('span', {'data-tooltip-stub': ''}, slots.default?.())}));
    app.component('el-switch', Vue.defineComponent({
        inheritAttrs: false,
        props: {modelValue: {type: Boolean, default: false}, disabled: {type: Boolean, default: false}},
        emits: ['update:modelValue'],
        setup: (switchProps, {attrs, emit}) => () => Vue.h('button', {
            ...attrs, type: 'button', role: 'switch', 'aria-checked': String(switchProps.modelValue),
            disabled: switchProps.disabled,
            onClick: () => {if (!switchProps.disabled) emit('update:modelValue', !switchProps.modelValue)},
        }),
    }));
    app.mount(root); await settle();
}
async function mountItem(overrides: Partial<ItemProps> = {}) {
    const props = Vue.reactive<ItemProps>({item: {value: 'deeplx', label: 'DeepLX'}, selected: false,
        isDefault: false, isConfigured: false, isFavorite: false, compact: true, status: '', availabilityEnabled: true, availabilityToggleDisabled: false, ...overrides});
    const onSelect = vi.fn<(value: string) => void>();
    const onToggleAvailability = vi.fn<(service: string, enabled: boolean) => void>();
    const component = loadClient('src/features/settings/ui/services/ServiceCatalogItem.vue');
    await mount(component, props, onSelect, onToggleAvailability);
    return {props, onSelect, onToggleAvailability};
}
function control<T extends Element = HTMLElement>(selector: string): T {
    const element = root.querySelector<T>(selector);
    expect(element, `Rendered service control ${selector}`).not.toBeNull();
    return element!;
}
async function clickSelect(): Promise<void> {
    const event = new dom.Event('click', {bubbles: true});
    Object.assign(event, {_vts: Date.now() + 1});
    control('button.library-select').dispatchEvent(event); await settle();
}
function expectBadge(selector: string, label: string, branded = false): HTMLElement {
    const badge = control<HTMLElement>(selector);
    expect(badge.textContent).toBe(label);
    expect(badge.title).toBe(label);
    expect(badge.classList.contains('service-badge')).toBe(true);
    expect(badge.classList.contains('service-badge--default')).toBe(branded);
    return badge;
}

beforeEach(() => {locale.value = 'zh-CN'; dom.document.body.replaceChildren();});
afterEach(() => {app?.unmount(); app = undefined; dom.document.body.replaceChildren();});

describe('服务目录行实际客户端模板', () => {
    it('渲染可访问的启用开关并发出带服务身份的新状态', async () => {
        const {props, onToggleAvailability} = await mountItem({availabilityEnabled: false});
        const toggle = control<HTMLButtonElement>('[data-service-availability="deeplx"]');
        expect(toggle.getAttribute('role')).toBe('switch');
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        expect(toggle.getAttribute('aria-label')).toBe('启用 DeepLX');
        toggle.dispatchEvent(new dom.Event('click', {bubbles: true})); await settle();
        expect(onToggleAvailability).toHaveBeenCalledOnce();
        expect(onToggleAvailability).toHaveBeenCalledWith('deeplx', true);
        props.availabilityToggleDisabled = true; await settle();
        expect(toggle.disabled).toBe(true);
    });

    it('完整名称、性质和默认标签共用名称行，点击只发出当前服务选择并保留输入', async () => {
        const label = '自定义的完整 DeepLX 服务名称 / Very long provider name';
        const {props, onSelect} = await mountItem({item: {value: 'deeplx', label},
            selected: true, isDefault: true, isConfigured: true, isFavorite: true});
        const before = JSON.stringify(props);
        const name = control('.library-name');
        expect(name.querySelector('strong')!.textContent).toBe(label);
        expect(control<HTMLButtonElement>('button').title).toBe(label);
        expect(control('button').getAttribute('aria-pressed')).toBe('true');
        expect(control('.library-item').classList.contains('active')).toBe(true);
        const metadata = control('.library-metadata');
        expect(metadata.parentElement).toBe(name);
        expect(expectBadge('[data-service-nature-badge="deeplx"]', '免费 · 非官方').parentElement).toBe(metadata);
        expect(expectBadge('.library-default', '默认', true).parentElement).toBe(metadata);
        expect(root.querySelectorAll('.service-badge')).toHaveLength(2);
        expect(root.querySelector('.library-configured, .library-common')).toBeNull();
        await clickSelect();
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('deeplx');
        expect(JSON.stringify(props)).toBe(before);
    });

    it('公开 props 更新按默认、已保存、常用逐级切换，同时更新选中状态与紧凑说明', async () => {
        const {props} = await mountItem({isDefault: true, isConfigured: true, isFavorite: true, status: '可用服务'});
        expectBadge('.library-default', '默认', true);
        expect(control('button').getAttribute('aria-pressed')).toBe('false');
        expect(root.querySelector('small')).toBeNull();
        props.isDefault = false; props.selected = true; props.compact = false; await settle();
        expectBadge('.library-configured', '已保存');
        expect(root.querySelector('.library-default, .library-common')).toBeNull();
        expect(control('button').getAttribute('aria-pressed')).toBe('true');
        expect(control('.library-item').classList.contains('active')).toBe(true);
        expect(control('.library-item').classList.contains('compact')).toBe(false);
        expect(control('small').textContent).toBe('可用服务');
        props.isConfigured = false; await settle();
        expectBadge('.library-common', '常用');
        expect(root.querySelector('.library-configured')).toBeNull();
        props.isFavorite = false; props.selected = false; props.status = ''; await settle();
        expect(root.querySelector('.library-default, .library-configured, .library-common, small')).toBeNull();
        expectBadge('[data-service-nature-badge="deeplx"]', '免费 · 非官方');
        expect(control('button').getAttribute('aria-pressed')).toBe('false');
        expect(control('.library-item').classList.contains('active')).toBe(false);
    });

    it('替换目录项后名称、完整提示、性质和点击值都切换到新服务', async () => {
        const {props, onSelect} = await mountItem({isConfigured: true});
        await clickSelect();
        const item = {value: 'custom-openai:long-name', label: '完整自定义名称 '.repeat(12)};
        props.item = item; await settle();
        expect(control('strong').textContent).toBe(item.label);
        expect(control<HTMLButtonElement>('button').title).toBe(item.label);
        expect(control('button').getAttribute('data-service-value')).toBe(item.value);
        expect(root.querySelector('[data-service-nature-badge]')).toBeNull();
        expectBadge('.library-configured', '已保存');
        await clickSelect();
        expect(onSelect.mock.calls).toEqual([['deeplx'], [item.value]]);
        expect(props.item).toEqual(item);
    });

    it('切换七种语言即时更新性质与状态的可见短文案及完整提示，不改变服务输入', async () => {
        const {props, onSelect} = await mountItem({isConfigured: true});
        const before = JSON.stringify(props);
        const savedLabels: Array<[UiLanguage, string]> = [
            ['en-US', 'Saved'], ['ja-JP', '保存済み'], ['ko-KR', '저장됨'], ['fr-FR', 'Enregistré'],
            ['ru-RU', 'Сохранено'], ['es-ES', 'Guardado'], ['zh-CN', '已保存'],
        ];
        const button = control('button');
        for (const [language, saved] of savedLabels) {
            locale.value = language; await settle();
            expect(control('button')).toBe(button);
            expectBadge('.library-configured', saved);
            expectBadge('[data-service-nature-badge="deeplx"]', translate('settings.services.library.freeUnofficial', language));
            expect(JSON.stringify(props)).toBe(before);
        }
        expect(onSelect).not.toHaveBeenCalled();
    });
});

describe('服务性质徽章实际客户端模板', () => {
    it('同一实例随服务输入切换 DeepLX、两个免费入口、合法组合与无徽章服务', async () => {
        const props = Vue.reactive({service: 'deeplx'});
        const component = loadClient('src/features/settings/ui/services/ServiceNatureBadge.vue');
        await mount(component, props);
        const scenarios: Array<[string, string | null]> = [
            ['deeplx', '免费 · 非官方'], ['bilibili', '免费'], ['bilibiliFree', '免费'],
            ['composite:my-services_1', translate('settings.services.composite.badge', 'zh-CN')],
            ['microsoft', null], ['composite:', null], ['composite:invalid/name', null],
        ];
        for (const [service, label] of scenarios) {
            props.service = service; await settle();
            if (label === null) expect(root.querySelector('.service-badge')).toBeNull();
            else {
                expectBadge(`[data-service-nature-badge="${service}"]`, label);
                expect(root.querySelectorAll('.service-badge')).toHaveLength(1);
            }
        }
    });

    it('免费入口与组合性质响应语言切换，统一中性标签不携带默认强调', async () => {
        const props = Vue.reactive({service: 'bilibiliFree'});
        const component = loadClient('src/features/settings/ui/services/ServiceNatureBadge.vue');
        await mount(component, props);
        for (const language of ['en-US', 'ru-RU', 'zh-CN'] as const) {
            locale.value = language; await settle();
            expectBadge('[data-service-nature-badge]', translateLegacyText('免费', language));
        }
        props.service = 'composite:personal'; locale.value = 'en-US'; await settle();
        expectBadge('[data-service-nature-badge="composite:personal"]', translate('settings.services.composite.badge', 'en-US'));
        locale.value = 'fr-FR'; await settle();
        expectBadge('[data-service-nature-badge="composite:personal"]', translate('settings.services.composite.badge', 'fr-FR'));
    });
});

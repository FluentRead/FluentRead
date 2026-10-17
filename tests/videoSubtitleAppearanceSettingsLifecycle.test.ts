/**
 * @file tests/videoSubtitleAppearanceSettingsLifecycle.test.ts
 * 文件职责：执行字幕外观设置的真实客户端 SFC、共享布局与控件事件，验证设置草稿和实时预览的一致性。
 * 主要内容：覆盖移动端/X 自动贴底、手动偏移、位置显隐、七语可见标签与 ARIA、字号归一化、皮肤/重置、显示模式和父级草稿替换。
 * 模块边界：保留 Vue 模板、设置子组件、配置归一化及翻译字典；仅以 DOM 与 Element Plus UI ports 和受控语言上下文替代浏览器环境，不读取组件私有状态或复制产品事件。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {dirname, resolve} from 'node:path';
import {compileVueInlineFixture} from './helpers/compiledVueFixture';

const dom = await vi.hoisted(async () => {
    const {parseHTML} = await import('linkedom');
    const {window, document} = parseHTML('<html><body></body></html>');
    Object.defineProperty(window.Node.prototype, Symbol.toStringTag, {configurable: true, get() {return this.constructor.name;}});
    const selectValues = new WeakMap<object, string>();
    Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {configurable: true,
        get() {return selectValues.get(this) ?? '';}, set(value: string) {selectValues.set(this, String(value));}});
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'ShadowRoot', 'Event']) {
        Object.defineProperty(globalThis, key, {configurable: true, writable: true, value: (window as any)[key]});
    }
    Object.defineProperty(window, 'getSelection', {configurable: true, value: () => ({toString: () => ''})});
    return {document: document as unknown as Document, Event: window.Event};
});

import * as Vue from 'vue';
import {Config, normalizeConfig} from '@/src/core/config/model';
import * as appearanceModule from '@/src/core/config/videoSubtitleAppearance';
import * as shadowSelectModule from '@/src/ui/shadowSelectOutside';
import {translate, translateLegacyText, type UiLanguage} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from '@/src/core/i18n/bundles';

registerAllUiLanguageBundles();
const locale = Vue.ref<UiLanguage>('zh-CN');
const i18nPort = {useUiI18n: () => ({
    t: (key: string) => translate(key, locale.value),
    translateLegacy: (value: string) => translateLegacyText(value, locale.value),
})};
// Vendor ports expose the same public model events through native DOM controls.
// The target SFC and FluentRead's UiSelect/SegmentedControl still own all config writes.
const ElSelect = Vue.defineComponent({inheritAttrs: false, props: ['modelValue', 'disabled'], emits: ['update:modelValue', 'change'],
    setup: (props, {attrs, slots, emit, expose}) => {
        expose({focus: () => {}, blur: () => {}});
        return () => Vue.h('select', {...attrs, value: props.modelValue, disabled: props.disabled,
            onChange: (event: Event) => {const value = (event.target as HTMLSelectElement).value; emit('update:modelValue', value); emit('change', value);}}, slots.default?.());
    }});
const ElOption = Vue.defineComponent({props: ['value', 'label'], setup: props => () => Vue.h('option', {value: props.value}, props.label)});
const ElSwitch = Vue.defineComponent({inheritAttrs: false, props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
    setup: (props, {attrs, emit}) => () => Vue.h('input', {...attrs, class: 'el-switch', type: 'checkbox', role: 'switch',
        checked: props.modelValue, disabled: props.disabled,
        onChange: (event: Event) => {if (!props.disabled) emit('update:modelValue', (event.target as HTMLInputElement).checked);}})});
const ElColorPicker = Vue.defineComponent({inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'],
    setup: (props, {attrs, emit}) => () => Vue.h('input', {...attrs, type: 'color', value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)})});
const ElTooltip = Vue.defineComponent({setup: (_, {slots}) => () => Vue.h('div', slots.default?.())});

function loadClient(relative: string, components = new Map<string, Vue.Component>()): Vue.Component {
    if (components.has(relative)) return components.get(relative)!;
    const filename = resolve(process.cwd(), relative);
    const compiled = compileVueInlineFixture(filename, {id: relative});
    const dependencies: Record<string, unknown> = {
        vue: Vue,
        'element-plus': {ElSelect, ElOption, ElColorPicker, ElTooltip, ClickOutside: {}},
        '@/src/core/config/videoSubtitleAppearance': appearanceModule,
        '@/src/ui/shadowSelectOutside': shadowSelectModule,
        '@/src/ui/i18n': i18nPort,
        'element-plus/es/components/select/style/css': {},
        'element-plus/es/components/color-picker/style/css': {},
        './settings-card-heading.css': {},
    };
    const module = {exports: {} as {default: Vue.Component}};
    new Function('require', 'exports', 'module', compiled.code)((id: string) => {
        if (id.endsWith('.vue')) {
            const path = id.startsWith('@/') ? id.slice(2) : resolve(dirname(filename), id);
            return {default: loadClient(path, components)};
        }
        if (!(id in dependencies)) throw new Error(`Unexpected subtitle settings dependency: ${id}`);
        return dependencies[id];
    }, module.exports, module);
    components.set(relative, module.exports.default);
    return module.exports.default;
}

let app: Vue.App | undefined, root: HTMLElement, props: {config: Config};
async function settle(): Promise<void> {await Vue.nextTick(); await Vue.nextTick();}
async function mount(config = new Config()): Promise<void> {
    root = dom.document.createElement('div'); dom.document.body.append(root);
    props = Vue.reactive({config});
    const component = loadClient('src/features/settings/ui/VideoSubtitleAppearanceSettings.vue');
    app = Vue.createApp({setup: () => () => Vue.h(component, props)});
    app.component('el-switch', ElSwitch);
    app.mount(root); await settle();
}
function control<T extends Element = HTMLInputElement>(selector: string): T {
    const element = root.querySelector<T>(selector);
    expect(element, `Rendered control ${selector}`).not.toBeNull();
    return element!;
}
function event(element: Element, type: string): void {
    const event = new dom.Event(type, {bubbles: true});
    Object.assign(event, {_vts: Date.now() + 1}); element.dispatchEvent(event);
}
async function change(selector: string, value: string, type = 'change'): Promise<void> {
    const input = control<HTMLInputElement | HTMLSelectElement>(selector);
    input.value = value; event(input, type); await settle();
}
async function check(selector: string, checked: boolean): Promise<void> {
    const input = control<HTMLInputElement>(selector);
    input.checked = checked; event(input, 'change'); await settle();
}
async function click(selector: string): Promise<void> {event(control(selector), 'click'); await settle();}
const autoSelector = '.subtitle-appearance-controls input[type="checkbox"]';
const offsetSelector = 'input[aria-label="字幕底部偏移"]';
const previewSelector = '[data-video-subtitle-preview]';
const sceneSelector = '[data-video-subtitle-preview-scene]';
const offsetText = () => control(offsetSelector).closest('label')!.querySelector('b')!.textContent;

beforeEach(() => {locale.value = 'zh-CN'; dom.document.body.replaceChildren();});
afterEach(() => {app?.unmount(); app = undefined; dom.document.body.replaceChildren();});

describe('视频字幕外观设置实际客户端模板', () => {
    it('自动贴底开关写入当前草稿并即时切换预览和偏移说明，手动值始终保留', async () => {
        await mount();
        expect(control<HTMLInputElement>(autoSelector).checked).toBe(true);
        expect(offsetText()).toBe('自动');
        expect(control<HTMLElement>(sceneSelector).dataset.autoBottom).toBe('true');
        await check(autoSelector, false);
        expect(props.config.videoSubtitleAppearance.autoBottom).toBe(false);
        expect(props.config.videoSubtitleAppearance.bottomOffset).toBe(10);
        expect(offsetText()).toBe('10%');
        expect(control<HTMLElement>(sceneSelector).dataset.autoBottom).toBe('false');
        await check(autoSelector, true);
        expect(props.config.videoSubtitleAppearance.autoBottom).toBe(true);
        expect(offsetText()).toBe('自动');
        expect(control<HTMLElement>(sceneSelector).dataset.autoBottom).toBe('true');
    });

    it('拖动底部偏移关闭自动贴底并更新真实预览，重新开启自动后保留最近手动值', async () => {
        await mount();
        await change(offsetSelector, '17', 'input');
        expect(props.config.videoSubtitleAppearance).toMatchObject({bottomOffset: 17, autoBottom: false});
        expect(control<HTMLInputElement>(autoSelector).checked).toBe(false);
        expect(offsetText()).toBe('17%');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-bottom-offset')).toBe('17%');
        expect(control<HTMLElement>(sceneSelector).dataset.autoBottom).toBe('false');
        await check(autoSelector, true);
        expect(offsetText()).toBe('自动');
        await check(autoSelector, false);
        expect(offsetText()).toBe('17%');
        expect(control<HTMLInputElement>(offsetSelector).value).toBe('17');
    });

    it('通过实际位置控件切换顶部和中部时隐藏自动贴底，回到底部恢复保存状态', async () => {
        await mount();
        for (const position of ['top', 'center']) {
            await change('select[aria-label="字幕位置"]', position);
            expect(props.config.videoSubtitleAppearance.position).toBe(position);
            expect(control<HTMLElement>(sceneSelector).dataset.position).toBe(position);
            expect(root.querySelector(autoSelector)).toBeNull();
            expect(offsetText()).toBe('10%');
            expect(props.config.videoSubtitleAppearance.autoBottom).toBe(true);
        }
        await change('select[aria-label="字幕位置"]', 'bottom');
        expect(control<HTMLInputElement>(autoSelector).checked).toBe(true);
        expect(offsetText()).toBe('自动');
    });

    it('同一开关随七种界面语言同步更新可见标签和 ARIA，语言切换不改外观草稿', async () => {
        await mount();
        const checkbox = control<HTMLInputElement>(autoSelector);
        const saved = JSON.stringify(props.config.videoSubtitleAppearance);
        const labels: Array<[UiLanguage, string]> = [
            ['en-US', 'Auto bottom placement on mobile / X'],
            ['ja-JP', 'モバイル / X で自動下寄せ'],
            ['ko-KR', '모바일 / X 자동 하단 배치'],
            ['fr-FR', 'Placement auto en bas sur mobile / X'],
            ['ru-RU', 'Авторазмещение внизу на мобильных / X'],
            ['es-ES', 'Ajuste inferior automático en móvil / X'],
            ['zh-CN', '移动端 / X 自动贴底'],
        ];
        for (const [language, label] of labels) {
            locale.value = language; await settle();
            expect(control(autoSelector)).toBe(checkbox);
            expect(checkbox.getAttribute('aria-label')).toBe(label);
            expect(checkbox.closest('label')!.querySelector('span')!.textContent).toBe(label);
            expect(JSON.stringify(props.config.videoSubtitleAppearance)).toBe(saved);
        }
    });

    it('自定义字号提交归一化范围和整数，字号滑块也通过实际事件更新输入框与预览', async () => {
        await mount();
        for (const [input, expected] of [['900', 500], ['39', 80], ['153.6', 154], ['', 100]] as const) {
            await change('input[type="number"][aria-label="字幕字号"]', input);
            expect(props.config.videoSubtitleAppearance.fontScale).toBe(expected);
            expect(control<HTMLInputElement>('input[type="number"]').value).toBe(String(expected));
            expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-font-scale')).toBe(`${expected}%`);
        }
        await change('input[type="range"][aria-label="字幕字号"]', '230', 'input');
        expect(props.config.videoSubtitleAppearance.fontScale).toBe(230);
        expect(control<HTMLInputElement>('input[type="number"]').value).toBe('230');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-font-scale')).toBe('230%');
    });

    it('选择皮肤只改配色，恢复默认一次重置全部外观并保留显示及翻译偏好', async () => {
        const config = normalizeConfig({videoTranslationEnabled: true, videoSubtitleDisplayMode: 'original-only',
            videoSubtitleAppearance: {fontScale: 230, bottomOffset: 18, autoBottom: false, karaoke: true}});
        await mount(config);
        await click('button[data-skin="clean"]');
        expect(props.config.videoSubtitleAppearance).toMatchObject({skin: 'clean', textColor: '#1f2937', translationColor: '#0f766e',
            backgroundOpacity: 88, fontScale: 230, bottomOffset: 18, autoBottom: false, karaoke: true});
        expect(control('button[data-skin="clean"]').getAttribute('aria-checked')).toBe('true');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-text-color')).toBe('#1f2937');
        await click('.appearance-reset-button');
        expect(props.config.videoSubtitleAppearance).toEqual(appearanceModule.DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
        expect(props.config.videoTranslationEnabled).toBe(true);
        expect(props.config.videoSubtitleVisible).toBe(true);
        expect(props.config.videoSubtitleDisplayMode).toBe('original-only');
        expect(control('button[data-skin="classic"]').getAttribute('aria-checked')).toBe('true');
        expect(control<HTMLInputElement>(autoSelector).checked).toBe(true);
        expect(control<HTMLElement>(previewSelector).querySelector('b')).toBeNull();
    });

    it('显示模式、逐字高亮及显隐开关通过实际模板更新预览并遵守禁用状态', async () => {
        await mount(normalizeConfig({videoTranslationEnabled: true}));
        await click('[aria-label="视频字幕显示模式"] [data-option-index="1"]');
        expect(props.config.videoSubtitleDisplayMode).toBe('translation-only');
        expect(control(previewSelector).querySelector('span')).toBeNull();
        expect(control(previewSelector).querySelector('b')?.textContent).toBe('视频字幕预览');
        await check('[data-video-subtitle-karaoke]', true);
        expect(props.config.videoSubtitleAppearance.karaoke).toBe(true);
        expect(control(previewSelector).querySelector('b')?.classList.contains('subtitle-preview-karaoke')).toBe(true);
        await check('[role="switch"][aria-label="显示 流畅阅读 视频字幕"]', false);
        expect(props.config.videoSubtitleVisible).toBe(false);
        expect(root.querySelector(previewSelector)).toBeNull();
        expect(control('.subtitle-preview-hidden').textContent).toBe('字幕已隐藏');
        expect(control<HTMLInputElement>('[data-video-subtitle-karaoke]').disabled).toBe(true);
        expect([...root.querySelectorAll<HTMLButtonElement>('[aria-label="视频字幕显示模式"] button')].every(button => button.disabled)).toBe(true);
        await check('[role="switch"][aria-label="显示 流畅阅读 视频字幕"]', true);
        expect(control(previewSelector).querySelector('b')?.classList.contains('subtitle-preview-karaoke')).toBe(true);
    });

    it('父级替换草稿后展示和事件都归属新配置，旧草稿保留原来的自动贴底和字号', async () => {
        await mount();
        const previous = props.config;
        props.config = normalizeConfig({videoSubtitleAppearance: {autoBottom: false, bottomOffset: 22, fontScale: 250}});
        await settle();
        expect(control<HTMLInputElement>(autoSelector).checked).toBe(false);
        expect(offsetText()).toBe('22%');
        expect(control<HTMLInputElement>('input[type="number"]').value).toBe('250');
        await check(autoSelector, true);
        await change('input[type="number"]', '320');
        expect(props.config.videoSubtitleAppearance).toMatchObject({autoBottom: true, bottomOffset: 22, fontScale: 320});
        expect(previous.videoSubtitleAppearance).toEqual(appearanceModule.DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-font-scale')).toBe('320%');
    });
});

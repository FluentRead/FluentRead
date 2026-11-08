import './helpers/vueDomFixture';
/**
 * @file tests/videoSubtitleAppearanceSettingsLifecycle.test.ts
 * 文件职责：执行字幕外观设置的真实客户端 SFC、共享布局与控件事件，验证设置草稿和实时预览的一致性。
 * 主要内容：覆盖双语上下顺序、移动端/X 自动贴底、手动偏移、位置显隐、七语可见标签与 ARIA、字号归一化、轮廓样式/颜色/粗细、背景显隐、皮肤/重置、显示模式、读音示例显隐、单语顺序禁用、显式恢复双语和父级草稿替换；读音示例使用固定演示数据，不加载转写引擎。
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
    // linkedom 缺少 input.checked 的原生属性；补齐浏览器端口后由真实 Vue prop 更新维护状态。
    const checkedValues = new WeakMap<object, boolean>();
    Object.defineProperty(window.HTMLInputElement.prototype, 'checked', {configurable: true,
        get() {return checkedValues.get(this) ?? this.hasAttribute('checked');}, set(value: boolean) {checkedValues.set(this, !!value);}});
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
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';

registerAllUiLanguageBundles();
const locale = Vue.ref<UiLanguage>('zh-CN');
const capabilities = {extensionDom: true};
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
        '@/src/platform/browser/capabilities': {browserCapabilities: capabilities},
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
            return {__esModule: true, default: loadClient(path, components)};
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
const autoSelector = '.subtitle-auto-bottom-toggle input[type="checkbox"]';
const offsetSelector = 'input[aria-label="字幕底部偏移"]';
const previewSelector = '[data-video-subtitle-preview]';
const readingSelector = '[data-video-subtitle-reading-annotation]';
const readingPreviewSelector = '[data-video-subtitle-reading-preview]';
const sceneSelector = '[data-video-subtitle-preview-scene]';
const offsetText = () => control(offsetSelector).closest('label')!.querySelector('b')!.textContent;

beforeEach(() => {locale.value = 'zh-CN'; capabilities.extensionDom = true; dom.document.body.replaceChildren();});
afterEach(() => {app?.unmount(); app = undefined; dom.document.body.replaceChildren();});

describe('视频字幕外观设置实际客户端模板', () => {
    it('双语顺序通过实际分段按钮更新草稿和预览，读音与单语显示保持原语义', async () => {
        await mount(normalizeConfig({videoTranslationEnabled: true, videoSubtitleAppearance: {readingAnnotation: true}}));
        const order = '[data-video-subtitle-order]';
        const originalFirst = `${order} [data-option-index="0"]`;
        const translationFirst = `${order} [data-option-index="1"]`;
        expect(control(originalFirst).getAttribute('aria-checked')).toBe('true');
        expect([...control(previewSelector).children].map(line => line.tagName)).toEqual(['SPAN', 'SMALL', 'B']);
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-translation-order')).toBe('3');
        const reading = control(readingPreviewSelector);
        await click(translationFirst);
        expect(props.config.videoSubtitleAppearance.bilingualOrder).toBe('translation-first');
        expect(control(translationFirst).getAttribute('aria-checked')).toBe('true');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-translation-order')).toBe('0');
        expect(control(readingPreviewSelector)).toBe(reading);
        expect([...control(previewSelector).children].map(line => line.tagName)).toEqual(['B', 'SPAN', 'SMALL']);
        expect(control(previewSelector).querySelector('span')?.textContent).toBe('今日はいい天気ですね。');
        await click('[aria-label="视频字幕显示模式"] [data-option-index="1"]');
        expect(control(previewSelector).querySelector('span')).toBeNull();
        expect(root.querySelector(readingPreviewSelector)).toBeNull();
        expect(control(previewSelector).querySelector('b')).not.toBeNull();
        expect(props.config.videoSubtitleAppearance.bilingualOrder).toBe('translation-first');
        expect(control(order).getAttribute('aria-disabled')).toBe('true');
        expect([...control(order).querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
        expect(control('.subtitle-order-item').textContent).toContain(translate('video.bilingualOrderHint', 'zh-CN'));
        await click('[aria-label="视频字幕显示模式"] [data-option-index="2"]');
        expect(control(previewSelector).querySelector('b')).toBeNull();
        expect(control(readingPreviewSelector).textContent).toBe('kyō wa ii tenki desu ne.');
        expect(control(order).getAttribute('aria-disabled')).toBe('true');
        await click('[aria-label="视频字幕显示模式"] [data-option-index="0"]');
        expect(control(order).getAttribute('aria-disabled')).toBe('false');
        await click(originalFirst);
        expect(props.config.videoSubtitleAppearance.bilingualOrder).toBe('original-first');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-translation-order')).toBe('3');
        await check('[role="switch"][aria-label="显示 流畅阅读 视频字幕"]', false);
        expect([...control(order).querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
    });

    it('双语顺序七语标签与可访问名称同步更新，替换草稿后选择只写入新草稿', async () => {
        await mount(normalizeConfig({videoTranslationEnabled: true}));
        const group = control('[data-video-subtitle-order]');
        const expected: Array<[UiLanguage, string, string, string]> = [
            ['zh-CN', '双语顺序', '原文在上', '译文在上'],
            ['en-US', 'Bilingual order', 'Original above', 'Translation above'],
            ['ja-JP', '二言語の表示順', '原文を上に', '訳文を上に'],
            ['ko-KR', '이중 언어 순서', '원문 위에', '번역문 위에'],
            ['fr-FR', 'Ordre bilingue', 'Original en haut', 'Traduction en haut'],
            ['ru-RU', 'Порядок языков', 'Оригинал сверху', 'Перевод сверху'],
            ['es-ES', 'Orden bilingüe', 'Original arriba', 'Traducción arriba'],
        ];
        for (const [language, label, first, second] of expected) {
            locale.value = language; await settle();
            expect(control('[data-video-subtitle-order]')).toBe(group);
            expect(group.getAttribute('aria-label')).toBe(label);
            expect([...group.querySelectorAll('button')].map(button => button.textContent)).toEqual([first, second]);
            expect(props.config.videoSubtitleAppearance.bilingualOrder).toBe('original-first');
        }
        const previous = props.config;
        props.config = normalizeConfig({videoTranslationEnabled: true, videoSubtitleAppearance: {bilingualOrder: 'translation-first'}});
        await settle();
        expect(control('[data-video-subtitle-order] [data-option-index="1"]').getAttribute('aria-checked')).toBe('true');
        await click('[data-video-subtitle-order] [data-option-index="0"]');
        expect(props.config.videoSubtitleAppearance.bilingualOrder).toBe('original-first');
        expect(previous.videoSubtitleAppearance.bilingualOrder).toBe('original-first');
        await click('[data-video-subtitle-order] [data-option-index="1"]');
        expect(previous.videoSubtitleAppearance.bilingualOrder).toBe('original-first');
        expect(props.config.videoSubtitleAppearance.bilingualOrder).toBe('translation-first');
        await click('.appearance-reset-button');
        expect(props.config.videoSubtitleAppearance.bilingualOrder).toBe('original-first');
    });

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

    it('自定义轮廓样式、颜色和粗细同步更新预览，关闭背景时保留透明度设置', async () => {
        await mount(normalizeConfig({videoSubtitleAppearance: {backgroundOpacity: 72}}));
        const outlineStyle = 'select[aria-label="轮廓样式"]';
        const outlineColor = 'input[type="color"][aria-label="轮廓颜色"]';
        const outlineWidth = 'input[type="range"][aria-label="轮廓粗细"]';
        const background = 'input[type="checkbox"][aria-label="显示字幕背景"]';
        await change(outlineStyle, 'stroke');
        await change(outlineColor, '#ff1020', 'input');
        await change(outlineWidth, '2.3', 'input');
        expect(props.config.videoSubtitleAppearance).toMatchObject({outlineStyle: 'stroke', outlineColor: '#ff1020', outlineWidth: 2.3});
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-text-stroke')).toBe('2.3px #ff1020');
        await change(outlineStyle, 'shadow');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-text-stroke')).toBe('0');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-text-shadow')).toContain('2.3px 0px 0 #ff1020');
        await change(outlineStyle, 'none');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-text-shadow')).toBe('none');
        expect(control<HTMLInputElement>(outlineColor).disabled).toBe(true);
        await check(background, false);
        expect(props.config.videoSubtitleAppearance).toMatchObject({backgroundVisible: false, backgroundOpacity: 72});
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-background')).toBe('transparent');
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-border')).toBe('transparent');
        expect(control<HTMLInputElement>('input[aria-label="字幕背景透明度"]').disabled).toBe(true);
        await check(background, true);
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-background')).toBe('rgba(12, 15, 22, 0.72)');
    });

    it('轮廓和背景控件使用七种界面语言的标签', async () => {
        await mount();
        const cases: Array<[UiLanguage, string, string, string, string, string, string]> = [
            ['zh-CN', '轮廓样式', '跟随皮肤', '描边', '多向阴影', '无', '显示字幕背景'],
            ['en-US', 'Text outline', 'Match skin', 'Stroke', 'Multi-direction shadow', 'None', 'Show subtitle background'],
            ['ja-JP', '文字の輪郭', 'スキンに合わせる', '縁取り', '多方向シャドウ', 'なし', '字幕の背景を表示'],
            ['ko-KR', '글자 윤곽', '스킨 설정 따름', '외곽선', '다방향 그림자', '없음', '자막 배경 표시'],
            ['fr-FR', 'Contour du texte', 'Suivre le style', 'Contour', 'Ombre multidirectionnelle', 'Aucun', 'Afficher le fond des sous-titres'],
            ['ru-RU', 'Обводка текста', 'Как в теме', 'Обводка', 'Многонаправленная тень', 'Нет', 'Показывать фон субтитров'],
            ['es-ES', 'Contorno del texto', 'Según el tema', 'Contorno', 'Sombra multidireccional', 'Ninguno', 'Mostrar fondo de subtítulos'],
        ];
        for (const [language, styleLabel, skin, stroke, shadow, none, backgroundLabel] of cases) {
            locale.value = language; await settle();
            const style = control<HTMLSelectElement>(`select[aria-label="${styleLabel}"]`);
            expect([...style.querySelectorAll('option')].map(option => option.textContent)).toEqual([skin, stroke, shadow, none]);
            expect(control<HTMLInputElement>(`input[type="checkbox"][aria-label="${backgroundLabel}"]`)).not.toBeNull();
        }
    });

    it('读音开关显示明确的演示数据，仅译文与隐藏字幕时收起读音且保留偏好', async () => {
        await mount(normalizeConfig({videoTranslationEnabled: true}));
        expect(control<HTMLInputElement>(readingSelector).checked).toBe(false);
        expect(control('.subtitle-reading-item').textContent).toContain(translate('video.readingAnnotation.explanation', 'zh-CN'));
        expect(root.querySelector(readingPreviewSelector)).toBeNull();
        expect(root.querySelector('[data-video-subtitle-reading-sample]')).toBeNull();
        await check(readingSelector, true);
        expect(props.config.videoSubtitleAppearance.readingAnnotation).toBe(true);
        expect(control(readingPreviewSelector).textContent).toBe('kyō wa ii tenki desu ne.');
        expect(control(readingPreviewSelector).getAttribute('lang')).toBe('ja-Latn');
        expect(control('[data-video-subtitle-reading-sample]').textContent).toContain('演示数据');
        expect(control(previewSelector).querySelector('span')?.textContent).toBe('今日はいい天気ですね。');
        expect(control(previewSelector).querySelector('b')?.textContent).toBe('今天天气真好。');
        await click('[aria-label="视频字幕显示模式"] [data-option-index="1"]');
        expect(root.querySelector(readingPreviewSelector)).toBeNull();
        expect(props.config.videoSubtitleAppearance.readingAnnotation).toBe(true);
        expect(control<HTMLInputElement>(readingSelector).checked).toBe(true);
        expect(control('.subtitle-reading-item').textContent).toContain('仅原文或双语时显示，当前偏好会保留');
        await click('[aria-label="视频字幕显示模式"] [data-option-index="2"]');
        expect(control(readingPreviewSelector).textContent).toBe('kyō wa ii tenki desu ne.');
        expect(control(previewSelector).querySelector('b')).toBeNull();
        await check('[role="switch"][aria-label="显示 流畅阅读 视频字幕"]', false);
        expect(root.querySelector(readingPreviewSelector)).toBeNull();
        expect(control<HTMLInputElement>(readingSelector).disabled).toBe(true);
        await check(readingSelector, false);
        expect(props.config.videoSubtitleAppearance.readingAnnotation).toBe(true);
        await check('[role="switch"][aria-label="显示 流畅阅读 视频字幕"]', true);
        expect(control(readingPreviewSelector).textContent).toBe('kyō wa ii tenki desu ne.');
        props.config.videoTranslationEnabled = false; await settle();
        expect(control<HTMLInputElement>(readingSelector).disabled).toBe(true);
        await check(readingSelector, false);
        expect(props.config.videoSubtitleAppearance.readingAnnotation).toBe(true);
    });

    it('读音开关的七语标签、模式提示和演示说明随界面语言更新且不改配置', async () => {
        await mount(normalizeConfig({videoTranslationEnabled: true, videoSubtitleDisplayMode: 'translation-only',
            videoSubtitleAppearance: {readingAnnotation: true}}));
        const checkbox = control<HTMLInputElement>(readingSelector);
        const saved = JSON.stringify(props.config.videoSubtitleAppearance);
        const labels: Array<[UiLanguage, string]> = [
            ['en-US', 'Reading annotations'], ['ja-JP', '読み方の表記'], ['ko-KR', '읽기 표기'],
            ['fr-FR', 'Aides à la lecture'], ['ru-RU', 'Подсказки чтения'],
            ['es-ES', 'Guías de lectura'], ['zh-CN', '读音标注'],
        ];
        for (const [language, label] of labels) {
            locale.value = language; await settle();
            expect(control(readingSelector)).toBe(checkbox);
            expect(checkbox.getAttribute('aria-label')).toBe(label);
            expect(control('.subtitle-reading-item .settings-item-label').textContent).toContain(label);
            expect(control('.subtitle-reading-item').textContent).toContain(translate('video.readingAnnotation.originalRequired', language));
            props.config.videoSubtitleDisplayMode = 'bilingual'; await settle();
            expect(control('.subtitle-reading-item').textContent).toContain(translate('video.readingAnnotation.explanation', language));
            props.config.videoSubtitleDisplayMode = 'translation-only'; await settle();
            expect(control('[data-video-subtitle-reading-sample]').textContent).toBe(translate('video.readingAnnotation.previewSample', language));
            expect(root.querySelector(readingPreviewSelector)).toBeNull();
            expect(JSON.stringify(props.config.videoSubtitleAppearance)).toBe(saved);
        }
    });

    it('仅译文开启读音时保留模式，显式恢复双语后显示读音并保留上下顺序', async () => {
        await mount(normalizeConfig({videoTranslationEnabled: true, videoSubtitleDisplayMode: 'translation-only',
            videoSubtitleAppearance: {bilingualOrder: 'translation-first'}}));
        const showOriginal = '[data-video-subtitle-reading-show-original]';
        expect(root.querySelector(showOriginal)).toBeNull();
        await check(readingSelector, true);
        expect(props.config.videoSubtitleDisplayMode).toBe('translation-only');
        expect(root.querySelector(readingPreviewSelector)).toBeNull();
        expect(control(showOriginal).textContent).toBe(translate('settings.translationStyle.switchToBilingual', 'zh-CN'));
        await click(showOriginal);
        expect(props.config.videoSubtitleDisplayMode).toBe('bilingual');
        expect(props.config.videoSubtitleAppearance).toMatchObject({readingAnnotation: true, bilingualOrder: 'translation-first'});
        expect([...control(previewSelector).children].map(line => line.tagName)).toEqual(['B', 'SPAN', 'SMALL']);
        expect(root.querySelector(showOriginal)).toBeNull();
        await click('[aria-label="视频字幕显示模式"] [data-option-index="1"]');
        await check('[role="switch"][aria-label="显示 流畅阅读 视频字幕"]', false);
        expect(control<HTMLButtonElement>(showOriginal).disabled).toBe(true);
        await click(showOriginal);
        expect(props.config.videoSubtitleDisplayMode).toBe('translation-only');
        await check('[role="switch"][aria-label="显示 流畅阅读 视频字幕"]', true);
        await check(readingSelector, false);
        expect(root.querySelector(showOriginal)).toBeNull();
    });

    it('无扩展 DOM 能力时解释读音不可用，开关禁用且不写入假偏好', async () => {
        capabilities.extensionDom = false;
        await mount(normalizeConfig({videoTranslationEnabled: true}));
        expect(control<HTMLInputElement>(readingSelector).disabled).toBe(true);
        expect(control('.subtitle-reading-item').textContent).toContain('读音标注目前需要浏览器扩展版');
        await check(readingSelector, true);
        expect(props.config.videoSubtitleAppearance.readingAnnotation).toBe(false);
        expect(root.querySelector(readingPreviewSelector)).toBeNull();
    });

    it('选择皮肤只改配色，恢复默认一次重置全部外观并保留显示及翻译偏好', async () => {
        const config = normalizeConfig({videoTranslationEnabled: true, videoSubtitleDisplayMode: 'original-only',
            videoSubtitleAppearance: {fontScale: 230, bottomOffset: 18, autoBottom: false, karaoke: true, readingAnnotation: true}});
        await mount(config);
        await click('button[data-skin="clean"]');
        expect(props.config.videoSubtitleAppearance).toMatchObject({skin: 'clean', textColor: '#1f2937', translationColor: '#0f766e',
            backgroundOpacity: 88, fontScale: 230, bottomOffset: 18, autoBottom: false, karaoke: true, readingAnnotation: true});
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
        expect(control<HTMLInputElement>(readingSelector).checked).toBe(false);
        expect(root.querySelector(readingPreviewSelector)).toBeNull();
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
        props.config = normalizeConfig({videoSubtitleAppearance: {autoBottom: false, bottomOffset: 22, fontScale: 250, readingAnnotation: true}});
        await settle();
        expect(control<HTMLInputElement>(autoSelector).checked).toBe(false);
        expect(offsetText()).toBe('22%');
        expect(control<HTMLInputElement>('input[type="number"]').value).toBe('250');
        expect(control<HTMLInputElement>(readingSelector).checked).toBe(true);
        expect(control(readingPreviewSelector).textContent).toBe('kyō wa ii tenki desu ne.');
        await check(autoSelector, true);
        await check(readingSelector, false);
        await change('input[type="number"]', '320');
        expect(props.config.videoSubtitleAppearance).toMatchObject({autoBottom: true, bottomOffset: 22, fontScale: 320, readingAnnotation: false});
        expect(previous.videoSubtitleAppearance).toEqual(appearanceModule.DEFAULT_VIDEO_SUBTITLE_APPEARANCE);
        expect(control<HTMLElement>(previewSelector).style.getPropertyValue('--fluent-read-video-subtitle-font-scale')).toBe('320%');
    });
});

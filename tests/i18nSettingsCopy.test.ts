/**
 * @file tests/i18nSettingsCopy.test.ts
 * 文件职责：验证通用偏好、悬浮球、AI 多段与免费翻译帮助的七语资源，以及真实悬浮球设置客户端模板。
 * 主要内容：不安装旧文案扫描器，切换七种语言并验证选项、标签、说明与可访问名称立即同步；扩展和脚本分别展示真实入口；执行显隐、归一化和禁用状态事件。
 * 模块边界：被测 SFC、Vue 响应式与配置归一化保持真实；子控件是可操作端口，不启动浏览器或请求翻译服务。
 */
import {readFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
import * as Vue from 'vue';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as configModel from '@/src/core/config/model';
import {translate, translateLegacyText, type UiLanguage} from '@/src/core/i18n';
import {registerAllUiLanguageBundles} from './helpers/uiLanguageBundles';
import {compileVueInlineFixture} from './helpers/compiledVueFixture';

registerAllUiLanguageBundles();
const languages: UiLanguage[] = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'];
const catalog = (language: UiLanguage) => JSON.parse(readFileSync(`src/core/i18n/messages/settings-copy/${language}.json`, 'utf8')) as {messages: Record<string, string>; legacy: Record<string, string>};
const changedKeys = Object.keys(catalog('en-US').messages).filter(key => key.startsWith('settings.floatingBall.')
  || key.startsWith('settings.personalCorrections.') || key.startsWith('settings.fullPage.multiSegment') || [
    'options.panel.floatingBall', 'settings.general.assistance', 'settings.general.aiContextHelp', 'settings.general.floatingBall',
    'settings.general.floatingBallDescription', 'settings.general.progressPanel', 'settings.general.progressPanelDescription',
    'settings.general.preferences', 'settings.general.themeDescription', 'settings.services.freeWeights.timeoutHelp',
    'settings.fullPage.multiSegmentDescription', 'settings.fullPage.multiSegmentHelp',
  ].includes(key));
let app: Vue.App | undefined;
afterEach(() => {app?.unmount();app = undefined;vi.unstubAllGlobals();});

async function mountFloatingSettings(userscript = false) {
  const language = Vue.ref<UiLanguage>('zh-CN');
  const t = (key: string) => translate(key, language.value);
  const config = Vue.reactive(new configModel.Config());
  const parsed = parseHTML('<html><body><main></main></body></html>');
  const document = parsed.document;
  const display = Vue.defineComponent({props: ['title', 'label', 'description', 'help'], setup: (props, {slots}) => () => Vue.h('section', [
    Vue.h('strong', props.title || props.label), props.description && Vue.h('p', props.description), props.help && Vue.h('aside', props.help), slots.default?.(),
  ])});
  const segmented = Vue.defineComponent({props: ['modelValue', 'options', 'label', 'disabled'], emits: ['update:modelValue'], setup: (props, {emit}) => () => Vue.h('div', {'role': 'radiogroup', 'aria-label': props.label},
    props.options.map((option: {value: string; label: string}) => Vue.h('button', {type: 'button', 'data-value': option.value, disabled: props.disabled,
      onClick: () => emit('update:modelValue', option.value)}, option.label)))});
  const number = Vue.defineComponent({inheritAttrs: false, setup: (_, {attrs}) => () => Vue.h('input', {...attrs, onChange: (event: Event) =>
    (attrs.onChange as (value: number | undefined) => void)((event.target as HTMLInputElement).value === '' ? undefined : Number((event.target as HTMLInputElement).value))})});
  const fixture = compileVueInlineFixture('src/features/settings/ui/FloatingBallSettings.vue', {id: 'floating-settings-i18n',
    scriptReplacements: [["import.meta.env.BROWSER === 'userscript'", String(userscript)]]});
  expect(fixture.parseErrors).toEqual([]);
  const exports: Record<string, any> = {};
  const dependencies: Record<string, any> = {
    vue: Vue, '@/src/core/config/model': configModel,
    '@/src/ui/i18n': {useUiI18n: () => ({t, translateLegacy: () => {throw new Error('Legacy scanner must not localize this component');}})},
    './components/SettingsGroup.vue': {default: display}, './components/SettingsItem.vue': {default: display},
    './components/SegmentedControl.vue': {default: segmented}, './components/SettingsNumberInput.vue': {default: number},
    './AlwaysTranslateSites.vue': {default: Vue.defineComponent({setup: () => () => null})},
  };
  new Function('require', 'exports', fixture.code)((name: string) => {
    if (!dependencies[name]) throw new Error('Unexpected fixture dependency: ' + name);
    return {__esModule: true, ...dependencies[name]};
  }, exports);
  const renderer = Vue.createRenderer<any, any>({
    createElement: tag => document.createElement(tag), createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
    setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
    insert: (node, owner, anchor = null) => owner.insertBefore(node, anchor), remove: node => node.parentNode?.removeChild(node),
    parentNode: node => node.parentNode, nextSibling: node => node.nextSibling,
    patchProp: (element, key, previous, value) => {
      if (/^on[A-Z]/u.test(key)) {
        const event = key.slice(2).toLowerCase();if (previous) element.removeEventListener(event, previous);if (value) element.addEventListener(event, value);return;
      }
      if (key === 'value') element.value = value ?? '';
      if (value === false || value === null || value === undefined) element.removeAttribute(key);else element.setAttribute(key, String(value));
    },
  });
  app = renderer.createApp({setup: () => () => Vue.h(exports.default, {config})});
  app.component('el-switch', {inheritAttrs: false, props: ['modelValue', 'disabled'], emits: ['update:modelValue'], setup: (props: any, {attrs, emit}: any) => () =>
    Vue.h('button', {...attrs, 'role': 'switch', disabled: props.disabled, 'aria-checked': props.modelValue, onClick: () => emit('update:modelValue', !props.modelValue)}, '○')});
  app.mount(document.querySelector('main')!);
  await Vue.nextTick();
  const click = async (selector: string) => {document.querySelector(selector)!.dispatchEvent(new parsed.window.Event('click'));await Vue.nextTick();};
  return {language, config, document, t, click, window: parsed.window};
}

describe('设置文案七语一致性', () => {
  it('保持稳定key显式翻译、占位参数和实际资源注册一致', () => {
    expect(changedKeys.length).toBeGreaterThan(35);
    const source = catalog('zh-CN').messages;
    for (const language of languages) {
      const target = catalog(language).messages;
      for (const key of changedKeys) {
        expect(target[key]?.trim(), `${language}: ${key}`).toBeTruthy();
        expect(translate(key, language), `${language}: ${key}`).toBe(target[key]);
        expect([...target[key].matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()).toEqual([...source[key].matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort());
      }
      const help = translate('settings.services.freeWeights.timeoutHelp', language);
      expect(help).toContain('20');
      expect(help).not.toMatch(/\{\w+\}/u);
    }
  });

  it('旧免费服务恢复说明的有无句号版本都保留完整建议', () => {
    const source = '网络问题通常几分钟后重试；限流按服务提示恢复；拦截可能需要几小时；日额度通常隔天恢复';
    for (const language of languages.filter(value => value !== 'zh-CN')) {
      const expected = catalog(language).legacy[source];
      expect(expected.length).toBeGreaterThan(55);
      expect(translateLegacyText(source, language)).toBe(expected);
      expect(translateLegacyText(source + '。', language)).toBe(expected);
    }
  });

  it.each([false, true])('真实悬浮球模板随七语切换完整更新，userscript=%s', async userscript => {
    const ui = await mountFloatingSettings(userscript);
    for (const language of languages) {
      ui.language.value = language;await Vue.nextTick();
      const text = ui.document.querySelector('main')!.textContent!;
      for (const key of ['settings.floatingBall.title', 'settings.floatingBall.toolsDisplayDescription', 'settings.floatingBall.hoverDelayHelp', 'settings.floatingBall.tools.hover', 'settings.floatingBall.tools.hidden',
        'settings.floatingBall.defaultMargin', 'settings.floatingBall.defaultMarginDescription', 'settings.floatingBall.popoutMargin', 'settings.floatingBall.popoutMarginDescription',
        userscript ? 'settings.floatingBall.click.settings' : 'settings.floatingBall.click.quickPanel',
        userscript ? 'settings.floatingBall.clickDescriptionUserscript' : 'settings.floatingBall.clickDescription']) expect(text).toContain(ui.t(key));
      expect(ui.document.querySelector('input')!.getAttribute('aria-label')).toBe(ui.t('settings.floatingBall.hoverDelayAria'));
      expect(text).not.toMatch(/settings\.floatingBall\./u);
      if (language !== 'zh-CN' && language !== 'ja-JP') expect(text).not.toMatch(/[\u3400-\u9fff]/u);
    }
  });

  it('真实按钮和数值事件保留归一化、显隐以及关闭状态', async () => {
    const ui = await mountFloatingSettings();
    const delay = ui.document.querySelector('input')! as unknown as HTMLInputElement;
    delay.value = '999999';delay.dispatchEvent(new ui.window.Event('change'));await Vue.nextTick();
    expect(ui.config.floatingBallHoverDelay).toBe(configModel.normalizeFloatingBallHoverDelay(999999));
    const number = (key:string,value:string) => {
      const input = ui.document.querySelector(`[aria-label="${ui.t(key)}"]`) as unknown as HTMLInputElement;
      input.value = value;input.dispatchEvent(new ui.window.Event('change'));
    };
    number('settings.floatingBall.defaultMarginAria','-999');number('settings.floatingBall.popoutMarginAria','999');await Vue.nextTick();
    expect(ui.config).toMatchObject({floatingBallDefaultMargin:-200,floatingBallPopoutMargin:200});
    number('settings.floatingBall.popoutMarginAria','invalid');await Vue.nextTick();
    expect(ui.config.floatingBallPopoutMargin).toBe(200);
    await ui.click('[data-value="settings"]');expect(ui.config.floatingBallClickAction).toBe('settings');
    await ui.click('[data-value="hidden"]');expect(ui.config.floatingBallToolsDisplay).toBe('hidden');
    expect(ui.document.querySelector('input')!.getAttribute('aria-label')).toBe(ui.t('settings.floatingBall.collapsedOpacityAria'));
    expect(ui.document.querySelector(`[aria-label="${ui.t('settings.floatingBall.settingsEntry')}"]`)!.hasAttribute('disabled')).toBe(true);
    await ui.click('[data-value="always"]');expect(ui.document.querySelectorAll('input').length).toBe(1);
    expect(ui.config.floatingBallPopoutMargin).toBe(200);
    ui.config.disableFloatingBall = true;await Vue.nextTick();
    expect(ui.document.querySelector('main')!.textContent).toContain(ui.t('settings.floatingBall.disabledNote'));
    for (const control of ui.document.querySelectorAll('button')) expect(control.hasAttribute('disabled')).toBe(true);
    for (const control of ui.document.querySelectorAll('input')) expect(control.hasAttribute('disabled')).toBe(true);
  });
});

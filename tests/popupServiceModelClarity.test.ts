import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type ViteDevServer} from 'vite';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc';
import {parseHTML} from 'linkedom';
import ts from 'typescript';
import {Config} from '@/src/core/config/model';
import {customModelString} from '@/src/core/config/catalog';
import {registerAllUiLanguageBundles, UI_LANGUAGE_BUNDLES} from './helpers/uiLanguageBundles';
import {zhCNMessages} from '@/src/core/i18n/messages/zh-CN';
import {translate} from '@/src/core/i18n';

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
let server: ViteDevServer;
let app: import('vue').App;
let component: any;
const serviceOptions = [{value: 'openai', label: 'OpenAI'}, {value: 'deepseek', label: 'DeepSeek'},
  {value: 'microsoft', label: 'Microsoft'}, {value: 'custom:private', label: 'Private endpoint'}];

beforeAll(async () => {
  server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', root: process.cwd(),
    resolve: {alias: {'@': resolve(process.cwd(), '.')}}, server: {hmr: false, middlewareMode: true},
    plugins: [{name: 'service-picker-test-language', enforce: 'pre', resolveId(id) {
      return /\/src\/ui\/i18n(?:\.ts)?$/u.test(id) ? '\0service-picker-test-language' : null;
    }, load(id) {return id === '\0service-picker-test-language'
      ? `import {translate} from '@/src/core/i18n'; export const useUiI18n = () => ({t: (key, params) => translate(key, 'zh-CN', params), translateLegacy: text => text});` : null;}}, vue()],
  });
  const filename = resolve('src/app/popup/PopupServices.vue');
  const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
  const bindings = compileScript(descriptor, {id: 'service-model-clarity'}).bindings;
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'service-model-clarity',
    compilerOptions: {mode: 'function', bindingMetadata: bindings, expressionPlugins: ['typescript']}});
  expect(template.errors).toEqual([]);
  component = (await server.ssrLoadModule('/src/app/popup/PopupServices.vue')).default;
  component.render = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(runtime);
});
afterEach(() => {app?.unmount(); vi.unstubAllGlobals();});
afterAll(async () => server?.close());

function mount(savedConfig?: Config) {
  const {document, window} = parseHTML('<html><body><div id="root"></div></body></html>');
  const root = document.getElementById('root')!;
  let focused: HTMLElement | null = document.body;
  vi.stubGlobal('document', document);
  Object.defineProperty(document, 'activeElement', {get: () => focused});
  const renderer = runtime.createRenderer<any, any>({
    patchProp(node, key, previous, value) {
      if (/^on[A-Z]/u.test(key)) {
        const event = key.slice(2).toLowerCase();
        if (previous) node.removeEventListener(event, previous);
        if (value) node.addEventListener(event, value);
      } else if (key === 'value') node.value = value;
      else if (value == null || value === false) node.removeAttribute(key);
      else node.setAttribute(key, String(value));
    },
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
    // LinkeDOM has no browser focus manager; record the real component's focus requests.
    createElement: tag => {
      const node = document.createElement(tag);
      node.focus = () => {focused = node;};
      // Native DOM elements are not Vue-reactive; keep LinkeDOM nodes equally opaque.
      return runtime.markRaw(node);
    }, createText: text => document.createTextNode(text),
    createComment: text => document.createComment(text), setText: (node, text) => {node.nodeValue = text;},
    setElementText: (node, text) => {node.textContent = text;}, parentNode: node => node.parentNode,
    nextSibling: node => node.nextSibling, setScopeId: (node, id) => node.setAttribute(id, ''),
    insertStaticContent: (content, parent, anchor) => {
      const template = document.createElement('template'); template.innerHTML = content;
      const first = template.content.firstChild, last = template.content.lastChild;
      parent.insertBefore(template.content, anchor || null); return [first, last];
    },
  });
  const config = runtime.reactive(savedConfig || new Config());
  if (!savedConfig) {
    config.service = 'openai';
    config.model.openai = 'saved-openai-model';
    config.model.deepseek = 'saved-deepseek-model';
    config.token.openai = 'test-only-key'; config.token.deepseek = 'test-only-key';
    config.customModels.deepseek = ['search-only-model'];
  }
  const options = runtime.reactive(serviceOptions.map(option => ({...option})));
  const close = {count: 0};
  app = renderer.createApp(component, {config, serviceOptions: options, onClose: () => {close.count++;}});
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  app.mount(root);
  const find = (selector: string) => {const element = root.querySelector(selector); expect(element, selector).not.toBeNull(); return element!;};
  const click = async (selector: string) => {find(selector).dispatchEvent(new window.Event('click')); await runtime.nextTick();};
  const search = async (query: string) => {const input = find('input[type="search"]') as HTMLInputElement; input.value = query; input.dispatchEvent(new window.Event('input')); await runtime.nextTick();};
  const key = async (selector: string, key: string) => {
    const event = Object.assign(new window.Event('keydown', {bubbles: true, cancelable: true}), {key});
    find(selector).dispatchEvent(event);
    await runtime.nextTick();
    return event;
  };
  return {root, config, options, find, click, search, key, close, focused: () => focused};
}

describe('Popup configured model overview', () => {
  it('shows the configured model for the default, inherited and explicitly assigned feature', async () => {
    const {config, root, find} = mount();
    expect(find('[data-feature-service="default"] small').textContent).toBe('配置模型：saved-openai-model');
    // 继承行的模型与默认服务相同，不重复显示模型行，只保留在无障碍名称里。
    expect(root.querySelector('[data-feature-service="hover"] small')).toBeNull();
    expect(find('[data-feature-service="hover"] .assignment-follow').textContent).toBe('跟随默认');
    expect(find('[data-feature-service="hover"] .assignment-service').textContent).toBe('OpenAI');
    expect(find('[data-feature-service="hover"]').getAttribute('aria-label')).toBe('鼠标悬浮 · 跟随默认 · OpenAI · 配置模型：saved-openai-model');
    config.inputBoxTranslationService = 'deepseek'; config.inputBoxTranslationModel = 'input-override';
    config.documentService = 'deepseek'; config.documentModel.deepseek = 'document-override';
    await runtime.nextTick();
    expect(find('[data-feature-service="input"] small').textContent).toContain('input-override');
    expect(find('[data-feature-service="document"] small').textContent).toContain('document-override');
    config.model.openai = customModelString; config.customModel.openai = 'custom/active';
    await runtime.nextTick();
    expect(find('[data-feature-service="default"] small').textContent).toContain('custom/active');
    expect(root.querySelector('[data-feature-service="hover"] small')).toBeNull();
    expect(find('[data-feature-service="hover"]').getAttribute('aria-label')).toContain('custom/active');
    config.documentModel.deepseek = customModelString;
    config.documentCustomModel.deepseek = 'document/custom';
    await runtime.nextTick();
    expect(find('[data-feature-service="document"] small').textContent).toBe('配置模型：document/custom');
    expect(find('[data-feature-service="document"]').getAttribute('aria-label')).toContain('配置模型：document/custom');
    config.documentService = '';
    await runtime.nextTick();
    expect(root.querySelector('[data-feature-service="document"] small')).toBeNull();
    expect(find('[data-feature-service="document"]').getAttribute('aria-label')).toContain('配置模型：custom/active');
  });

  it('labels configuration rather than claiming the final request model when custom bodies override it', async () => {
    const {config, find} = mount();
    config.customBody.openai = '{"model":"request-body-model"}';
    config.inputBoxTranslationModel = 'configured-input-model';
    config.documentService = 'deepseek';
    config.documentModel.deepseek = 'configured-document-model';
    config.customBody.deepseek = '{"model":"request-document-model"}';
    const before = JSON.stringify({model: config.model, customBody: config.customBody,
      inputModel: config.inputBoxTranslationModel, documentModel: config.documentModel});
    await runtime.nextTick();
    for (const [feature, model] of [['default', 'saved-openai-model'], ['hover', 'saved-openai-model'],
      ['input', 'configured-input-model'], ['document', 'configured-document-model']]) {
      const row = find(`[data-feature-service="${feature}"]`);
      if (feature === 'hover') expect(row.querySelector('small')).toBeNull();
      else {
        expect(find(`[data-feature-service="${feature}"] small`).textContent).toBe(`配置模型：${model}`);
        expect(find(`[data-feature-service="${feature}"] small`).getAttribute('title')).toBe(model);
      }
      expect(row.getAttribute('aria-label')).toContain(`配置模型：${model}`);
      expect(row.getAttribute('aria-label')).not.toContain('当前模型');
    }
    expect(JSON.stringify({model: config.model, customBody: config.customBody,
      inputModel: config.inputBoxTranslationModel, documentModel: config.documentModel})).toBe(before);
  });

  it('keeps reading, writing and input model overrides when their provider follows the default', async () => {
    const {config, find} = mount();
    config.harness.service = ''; config.harness.model = 'inherited-reading-override';
    config.writing.service = ''; config.writing.model = 'inherited-writing-override';
    config.inputBoxTranslationService = ''; config.inputBoxTranslationModel = 'inherited-input-override';
    for (const service of ['openai', 'deepseek']) {
      config.service = service;
      await runtime.nextTick();
      for (const [feature, model] of [['reading', 'inherited-reading-override'], ['writing', 'inherited-writing-override'], ['input', 'inherited-input-override']]) {
        expect(find(`[data-feature-service="${feature}"] .assignment-follow`).textContent).toBe('跟随默认');
        expect(find(`[data-feature-service="${feature}"] .assignment-service`).textContent).toBe(service === 'openai' ? 'OpenAI' : 'DeepSeek');
        expect(find(`[data-feature-service="${feature}"] small`).textContent).toBe(`配置模型：${model}`);
        expect(find(`[data-feature-service="${feature}"]`).getAttribute('aria-label')).toContain(`跟随默认 · ${service === 'openai' ? 'OpenAI' : 'DeepSeek'} · 配置模型：${model}`);
      }
    }
  });

  it('shows the configured model after switching services without changing model maps', async () => {
    const {config, root, find, click, search} = mount();
    const before = JSON.stringify({model: config.model, customModel: config.customModel, customModels: config.customModels,
      documentModel: config.documentModel, documentCustomModel: config.documentCustomModel});
    await click('[data-feature-service="default"]');
    await search('search-only-model');
    expect(find('[data-service-choice="deepseek"] small').textContent).toBe('search-only-model');
    await click('[data-service-choice="deepseek"]');
    expect(config.service).toBe('deepseek');
    expect(config.model.deepseek).toBe('saved-deepseek-model');
    expect(find('[data-feature-service="default"] small').textContent).toBe('配置模型：saved-deepseek-model');
    expect(root.querySelector('.popup-service-picker')).toBeNull();
    expect(JSON.stringify({model: config.model, customModel: config.customModel, customModels: config.customModels,
      documentModel: config.documentModel, documentCustomModel: config.documentCustomModel})).toBe(before);
  });

  it('preserves existing service search and clear behavior', async () => {
    const {config, root, find, click, search, focused} = mount();
    await click('[data-feature-service="default"]');
    await search('Microsoft');
    expect(root.querySelectorAll('[data-service-choice]')).toHaveLength(1);
    expect(find('[data-service-choice="microsoft"] strong').textContent).toBe('Microsoft');
    await search('search-only-model');
    expect(root.querySelectorAll('[data-service-choice]')).toHaveLength(1);
    await click('.service-picker-search button');
    expect((find('input[type="search"]') as HTMLInputElement).value).toBe('');
    expect(focused()).toBe(find('input[type="search"]'));
    expect(config.service).toBe('openai');
    expect(config.model.deepseek).toBe('saved-deepseek-model');
  });

  it('uses custom OpenAI provider models for search while preserving its configured model', async () => {
    const {config, find, click, search} = mount();
    config.customOpenAIProviders = [{id: 'custom:private', name: 'Private endpoint',
      endpoint: 'https://example.test/v1', models: ['private-active', 'private-search-only']}];
    config.model['custom:private'] = 'private-active';
    config.token['custom:private'] = 'test-only-key';
    const modelsBefore = {...config.model};
    const customModelsBefore = {...config.customModel};
    await click('[data-feature-service="default"]');
    await search('private-search-only');
    expect(find('[data-service-choice="custom:private"] small').textContent).toBe('private-search-only');
    await click('[data-service-choice="custom:private"]');
    expect(config.service).toBe('custom:private');
    expect(find('[data-feature-service="default"] small').textContent).toBe('配置模型：private-active');
    expect(find('[data-feature-service="hover"]').getAttribute('aria-label')).toContain('跟随默认 · Private endpoint');
    expect(find('[data-feature-service="hover"]').getAttribute('aria-label')).toContain('配置模型：private-active');
    expect(config.model).toEqual(modelsBefore);
    expect(config.customModel).toEqual(customModelsBefore);
  });

  it('shows reading and writing overrides and retains the existing reset and AI-only rules', async () => {
    const {config, root, find, click, search} = mount();
    config.harness.service = 'deepseek'; config.harness.model = 'reading-override';
    config.writing.service = 'openai'; config.writing.model = 'writing-override';
    await runtime.nextTick();
    expect(find('[data-feature-service="reading"] small').textContent).toBe('配置模型：reading-override');
    expect(find('[data-feature-service="writing"] small').textContent).toBe('配置模型：writing-override');
    const modelsBefore = {...config.model};
    await click('[data-feature-service="reading"]');
    expect(root.querySelector('[data-service-choice="microsoft"]')).toBeNull();
    await search('saved-openai-model');
    await click('[data-service-choice="openai"]');
    expect(config.harness.service).toBe('openai');
    expect(config.harness.model).toBe('');
    expect(find('[data-feature-service="reading"] small').textContent).toBe('配置模型：saved-openai-model');
    await click('[data-feature-service="writing"]');
    await search('search-only-model');
    await click('[data-service-choice="deepseek"]');
    expect(config.writing.service).toBe('deepseek');
    expect(config.writing.model).toBe('');
    expect(find('[data-feature-service="writing"] small').textContent).toBe('配置模型：saved-deepseek-model');
    await click('[data-feature-service="writing"]');
    await click('[data-service-choice=""]');
    expect(config.writing.service).toBe('');
    expect(root.querySelector('[data-feature-service="writing"] small')).toBeNull();
    expect(config.model).toEqual(modelsBefore);
  });

  it('retains a removed provider as a disabled old choice without making its model selectable', async () => {
    const {config, options, root, find, click, search} = mount();
    config.customOpenAIProviders = [{id: 'custom:private', name: 'Private endpoint',
      endpoint: 'https://example.test/v1', models: ['removed-provider-model']}];
    config.service = 'custom:private';
    config.model['custom:private'] = 'removed-provider-model';
    config.token['custom:private'] = 'test-only-key';
    await runtime.nextTick();
    await click('[data-feature-service="default"]');
    expect(find('[data-service-choice="custom:private"]').hasAttribute('disabled')).toBe(false);
    config.customOpenAIProviders = [];
    options.splice(options.findIndex(option => option.value === 'custom:private'), 1);
    await runtime.nextTick();
    const removed = find('[data-service-choice="custom:private"]');
    expect(removed.hasAttribute('disabled')).toBe(true);
    expect(removed.getAttribute('aria-selected')).toBe('true');
    await search('removed-provider-model');
    expect(root.querySelector('[data-service-choice="custom:private"]')).toBeNull();
    expect(find('.service-picker-empty').textContent).toBe('没有匹配的翻译服务');
    expect(config.service).toBe('custom:private');
    expect(config.model['custom:private']).toBe('removed-provider-model');
    await search('DeepSeek');
    await click('[data-service-choice="deepseek"]');
    expect(config.service).toBe('deepseek');
    expect(config.model['custom:private']).toBe('removed-provider-model');
  });

  it('requests keyboard focus through model results and restores it when returning to the overview', async () => {
    const {config, find, click, search, key, focused} = mount();
    await click('[data-feature-service="hover"]');
    expect(focused()).toBe(find('input[type="search"]'));
    await key('input[type="search"]', 'ArrowDown');
    expect(focused()).toBe(find('[data-service-choice=""]'));
    await key('[data-service-choice=""]', 'End');
    expect(focused()).toBe(find('[data-service-choice="microsoft"]'));
    await key('[data-service-choice="microsoft"]', 'ArrowDown');
    expect(focused()).toBe(find('[data-service-choice=""]'));
    await key('[data-service-choice=""]', 'ArrowUp');
    expect(focused()).toBe(find('[data-service-choice="microsoft"]'));
    await key('[data-service-choice="microsoft"]', 'Home');
    expect(focused()).toBe(find('[data-service-choice=""]'));
    await search('search-only-model');
    await key('input[type="search"]', 'ArrowDown');
    expect(focused()).toBe(find('[data-service-choice="deepseek"]'));
    await click('.service-picker-back');
    expect(focused()).toBe(find('[data-feature-service="hover"]'));
    expect(config.hoverTranslationService).toBe('');
    expect(config.model.deepseek).toBe('saved-deepseek-model');
  });

  it('reopens with saved service assignments and models but without a stale search', async () => {
    const first = mount();
    await first.click('[data-feature-service="default"]');
    await first.search('search-only-model');
    await first.click('[data-service-choice="deepseek"]');
    await first.click('[data-feature-service="hover"]');
    await first.search('saved-openai-model');
    await first.click('.service-panel-close');
    expect(first.close.count).toBe(1);
    app.unmount();
    const reopened = mount(first.config);
    expect(reopened.find('[data-feature-service="default"] small').textContent).toBe('配置模型：saved-deepseek-model');
    expect(reopened.root.querySelector('[data-feature-service="hover"] small')).toBeNull();
    expect(reopened.find('[data-feature-service="hover"]').getAttribute('aria-label')).toContain('配置模型：saved-deepseek-model');
    await reopened.click('[data-feature-service="hover"]');
    expect((reopened.find('input[type="search"]') as HTMLInputElement).value).toBe('');
    expect(reopened.config.model.openai).toBe('saved-openai-model');
    expect(reopened.config.model.deepseek).toBe('saved-deepseek-model');
  });

  it('preserves existing per-feature model reset rules when choosing another service', async () => {
    const {config, find, click, search} = mount();
    config.inputBoxTranslationService = 'openai'; config.inputBoxTranslationModel = 'old-feature-model';
    await runtime.nextTick();
    await click('[data-feature-service="input"]');
    await search('search-only-model');
    await click('[data-service-choice="deepseek"]');
    expect(config.service).toBe('openai');
    expect(config.inputBoxTranslationService).toBe('deepseek');
    expect(config.inputBoxTranslationModel).toBe('');
    expect(config.model.deepseek).toBe('saved-deepseek-model');
    expect(find('[data-feature-service="input"] small').textContent).toBe('配置模型：saved-deepseek-model');
    await click('[data-feature-service="input"]');
    await click('[data-service-choice=""]');
    expect(config.inputBoxTranslationService).toBe('');
    expect(find('[data-feature-service="input"]').getAttribute('aria-label')).toContain('配置模型：saved-openai-model');
  });

  it('preserves assignments when returning from the picker and reopening it', async () => {
    const {config, find, click, search, close} = mount();
    await click('[data-feature-service="hover"]');
    await search('search-only-model');
    await search('no-such-service');
    expect(find('.service-picker-empty')).toBeTruthy();
    await click('.service-picker-back');
    expect(config.hoverTranslationService).toBe('');
    await click('[data-feature-service="hover"]');
    expect((find('input[type="search"]') as HTMLInputElement).value).toBe('');
    await click('.service-panel-close');
    expect(close.count).toBe(1);
  });

  it('ranks free translation, configured services and keyless services first and keeps the selection visible', async () => {
    const {config, options, root, find, click} = mount();
    options.splice(0, options.length, ...['bilibili', 'microsoft', 'google', 'deepL', 'youdao', 'tencent', 'freeTranslation', 'deepseek', 'tongyi', 'openai', 'gemini', 'claude']
      .map(value => ({value, label: value})));
    config.service = 'youdao'; config.token.claude = 'test-only-key';
    await runtime.nextTick();
    expect(root.querySelector('[data-feature-service="hover"] .assignment-follow')!.textContent).toBe('跟随默认');
    expect(find('[data-feature-service="hover"] .assignment-service').textContent).toBe('youdao');
    expect(root.querySelector('[data-feature-service="default"] .assignment-follow')).toBeNull();
    await click('[data-feature-service="default"]');
    const choices = () => [...root.querySelectorAll('[data-service-choice]')].map(node => node.getAttribute('data-service-choice'));
    // 当前选择即使缺少配置也留在常用区；其余待配置服务初始收起，搜索仍能直接找到。
    expect(choices()).toEqual(['freeTranslation', 'youdao', 'deepseek', 'openai', 'claude', 'microsoft', 'google', 'bilibili']);
    expect(find('.service-picker-more').getAttribute('aria-expanded')).not.toBe('true');
    expect(find('.service-picker-more small').textContent).toBe('4');
    expect(find('[data-service-choice="youdao"]').getAttribute('aria-selected')).toBe('true');
    expect(find('[data-service-choice="youdao"] small').textContent).toBe('待配置');
    expect(find('[data-service-choice="deepseek"] small').textContent).toBe('saved-deepseek-model');
    expect(root.querySelector('[data-service-choice="microsoft"] small')).toBeNull();
    await click('.service-picker-more');
    expect(find('.service-picker-more').getAttribute('aria-expanded')).toBe('true');
    expect(choices().slice(8)).toEqual(['deepL', 'tencent', 'tongyi', 'gemini']);
    expect([...root.querySelectorAll('.service-choice-group-label')].map(node => node.textContent)).toEqual(['常用服务', '机器翻译', '云服务厂商', 'AI 翻译']);
    expect(find('[data-service-choice="tongyi"] small').textContent).toBe('待配置');
    await click('[data-service-choice="tongyi"]');
    expect(config.service).toBe('tongyi');
    await click('[data-feature-service="hover"]');
    // 默认服务 tongyi 尚缺密钥：它不进入其他功能的常用区，由“跟随默认”一项代表。
    expect(choices().slice(0, 4)).toEqual(['', 'freeTranslation', 'deepseek', 'openai']);
    expect(find('[data-service-choice=""] small').textContent).toBe('tongyi');
  });

  it('does not display a model for machine translation and preserves setup warnings', async () => {
    const {config, root, find} = mount();
    config.service = 'microsoft'; await runtime.nextTick();
    expect(root.querySelector('[data-feature-service="default"] small')).toBeNull();
    expect(find('[data-feature-service="default"]').getAttribute('aria-label')).not.toContain('配置模型');
    config.service = 'openai'; config.token.openai = ''; await runtime.nextTick();
    expect(find('[data-feature-service="default"] .assignment-warning').getAttribute('aria-label')).toContain('API Key');
    expect(root.querySelector('[data-feature-service="default"] small')).toBeNull();
  });

  it('labels configured models in all seven interface languages without changing the shared current-model label', () => {
    registerAllUiLanguageBundles();
    expect(translate('settings.organization.modelScope', 'zh-CN', {model: 'unique-model'})).toBe('当前模型：unique-model');
    expect(translate('settings.organization.modelScope', 'en-US', {model: 'unique-model'})).toBe('Current model: unique-model');
    const expected = {
      'zh-CN': '配置模型：unique-model',
      'en-US': 'Configured model: unique-model',
      'es-ES': 'Modelo configurado: unique-model',
      'fr-FR': 'Modèle configuré : unique-model',
      'ja-JP': '設定モデル：unique-model',
      'ko-KR': '설정된 모델: unique-model',
      'ru-RU': 'Настроенная модель: unique-model',
    };
    for (const language of Object.keys(expected) as (keyof typeof expected)[]) {
      const messages = language === 'zh-CN' ? zhCNMessages : UI_LANGUAGE_BUNDLES[language].messages;
      expect(Object.hasOwn(messages, 'featureServices.configuredModel')).toBe(true);
      expect(messages['featureServices.configuredModel']).toContain('{model}');
      expect(translate('featureServices.configuredModel', language, {model: 'unique-model'})).toBe(expected[language]);
    }
  });
});

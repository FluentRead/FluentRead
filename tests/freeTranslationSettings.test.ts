import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type ViteDevServer} from 'vite';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import {Config} from '@/src/core/config/model';
import {DEFAULT_FREE_TRANSLATION_ORDER, FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation';
import {translateLegacyText} from '@/src/core/i18n';

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
const componentPath = 'src/features/settings/ui/services/FreeTranslationSettings.vue';
type Node = {tag: string; props: Record<string, any>; text?: string};
let server: ViteDevServer;
let app: import('vue').App;
let config: Config;
let elements: Node[];
let state: Record<string, any>;

beforeAll(async () => {
  server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', root: process.cwd(),
    resolve: {alias: {'@': resolve(process.cwd(), '.')}}, server: {hmr: false, middlewareMode: true},
    plugins: [{name: 'fallback-ui-i18n', enforce: 'pre', resolveId(id) {
      return /\/src\/ui\/i18n(?:\.ts)?$/u.test(id) ? '\0fallback-i18n' : null;
    }, load(id) {return id === '\0fallback-i18n' ? 'export const useUiI18n = () => ({translateLegacy: text => text});' : null;}}, vue()],
  });
});

beforeEach(async () => {
  config = runtime.reactive(new Config());
  const filename = resolve(process.cwd(), componentPath);
  const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
  const bindings = compileScript(descriptor, {id: 'fallback-ui-test'}).bindings;
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'fallback-ui-test',
    compilerOptions: {mode: 'function', bindingMetadata: bindings, expressionPlugins: ['typescript']}});
  expect(template.errors).toEqual([]);
  const component = (await server.ssrLoadModule(`/${componentPath}`)).default;
  component.render = new Function('Vue', ts.transpileModule(template.code, {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText)(runtime);
  elements = [];
  const renderer = runtime.createRenderer<Node, Node>({
    patchProp: (node, key, _previous, value) => {node.props[key] = value;},
    insert: () => undefined, remove: () => undefined,
    createElement: tag => {const node = {tag, props: {}}; elements.push(node); return node;},
    createText: () => ({tag: '#text', props: {}}), createComment: () => ({tag: '#comment', props: {}}),
    setText: () => undefined, setElementText: (node, value) => {node.text = value;}, parentNode: () => null, nextSibling: () => null,
    querySelector: () => null, setScopeId: () => undefined, cloneNode: node => ({...node}),
    insertStaticContent: () => [{tag: '#static', props: {}}, {tag: '#static', props: {}}],
  });
  app = renderer.createApp(component, {config});
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  const vm = app.mount({tag: '#root', props: {}});
  state = (vm.$ as unknown as {setupState: Record<string, any>}).setupState;
  await runtime.nextTick();
});

afterEach(() => app?.unmount());
afterAll(async () => server?.close());

function control(ariaLabel: string): Node {
  const element = [...elements].reverse().find(node => node.props['aria-label'] === ariaLabel);
  expect(element, ariaLabel).toBeDefined();
  return element!;
}

describe('free translation settings compiled component', () => {
  it('renders the configured order and reorders without changing the default service', async () => {
    config.service = 'google';
    const selectedService = config.service;
    expect(state.order).toEqual([...DEFAULT_FREE_TRANSLATION_ORDER]);
    control('下移 微软翻译').props.onClick();
    await runtime.nextTick();
    expect(config.freeTranslationOrder).toEqual(['deeplx', 'microsoft', 'google', 'myMemory']);
    control('上移 微软翻译').props.onClick();
    await runtime.nextTick();
    expect(config.freeTranslationOrder).toEqual([...DEFAULT_FREE_TRANSLATION_ORDER]);
    expect(config.service).toBe(selectedService);
    expect(control('上移 微软翻译').props.disabled).toBe(true);
    expect(control('下移 MyMemory').props.disabled).toBe(true);
  });

  it('keeps a user-disabled service off and prevents removing the final service', async () => {
    control('启用 MyMemory').props['onUpdate:modelValue'](false);
    await runtime.nextTick();
    expect(config.freeTranslationOrder).toEqual(['microsoft', 'deeplx', 'google']);
    state.move('myMemory', -1);
    expect(config.freeTranslationOrder).not.toContain('myMemory');
    state.toggle('google', false); state.toggle('deeplx', false);
    await runtime.nextTick();
    expect(control('启用 微软翻译').props.disabled).toBe(true);
    state.toggle('microsoft', false);
    expect(config.freeTranslationOrder).toEqual(['microsoft']);
    state.toggle('myMemory', true);
    expect(config.freeTranslationOrder).toEqual(['microsoft', 'myMemory']);
  });

  it('shows five keyless services and cannot add a credential-based service', () => {
    expect(state.providers.map((provider: {id: string}) => provider.id)).toEqual(['microsoft', 'deeplx', 'google', 'myMemory', 'apertium']);
    expect(elements.filter(element => element.props.type === 'password')).toEqual([]);
    const originalTokens = {...config.token};
    config.token.deepL = 'existing-account-key:fx';
    state.toggle('azureTranslator', true); state.toggle('deepL', true);
    expect(config.freeTranslationOrder).toEqual([...DEFAULT_FREE_TRANSLATION_ORDER]);
    state.toggle('google', false); state.toggle('google', true);
    expect(config.token).toEqual({...originalTokens, deepL: 'existing-account-key:fx'});
    const source = readFileSync(resolve(process.cwd(), componentPath), 'utf8');
    expect(source).not.toMatch(/config\.token|config\.proxy|type="password"/u);
    const userscript = readFileSync(resolve(process.cwd(), 'userscript/SettingsPanel.vue'), 'utf8');
    const fallbackSection = userscript.match(/<details v-if="draft.service === services.freeTranslation">[\s\S]*?<\/details>/u)?.[0];
    expect(fallbackSection).toBeTruthy();
    expect(fallbackSection).not.toMatch(/draft\.token|type="password"|Azure|DeepL API Free/u);
  });

  it('stores bounded durations from the advanced controls and ignores blank inputs', () => {
    const timeout = control('每个服务最多等待（秒）');
    const cooldown = control('失败后暂停使用（秒）');
    timeout.props['onUpdate:modelValue'](8); cooldown.props['onUpdate:modelValue'](120);
    expect(config.freeTranslationTimeoutMs).toBe(8000);
    expect(config.freeTranslationCooldownMs).toBe(120000);
    timeout.props['onUpdate:modelValue'](undefined); cooldown.props['onUpdate:modelValue'](NaN);
    expect(config.freeTranslationTimeoutMs).toBe(8000);
    expect(config.freeTranslationCooldownMs).toBe(120000);
    state.setDuration('freeTranslationTimeoutMs', 200); state.setDuration('freeTranslationCooldownMs', -1);
    expect(config.freeTranslationTimeoutMs).toBe(15000);
    expect(config.freeTranslationCooldownMs).toBe(1000);
  });

  it('keeps partial email typing local until a valid address is committed', async () => {
    const email = control('MyMemory 联系邮箱');
    for (const value of ['c', 'contact', 'contact@', 'contact@example.test']) {
      email.props['onUpdate:modelValue'](value);
      await runtime.nextTick();
      expect(state.myMemoryEmailDraft).toBe(value);
      expect(config.myMemoryEmail).toBe('');
    }
    email.props.onChange();
    expect(config.myMemoryEmail).toBe('contact@example.test');
    email.props['onUpdate:modelValue']('invalid@');
    email.props.onChange();
    expect(config.myMemoryEmail).toBe('contact@example.test');
    expect(state.myMemoryEmailInvalid).toBe(true);
    email.props['onUpdate:modelValue'](''); email.props.onChange();
    expect(config.myMemoryEmail).toBe('');
  });

  it('exposes official quota guidance, honest web endpoint labels, and English fallback descriptions', () => {
    const source = readFileSync(resolve(process.cwd(), componentPath), 'utf8');
    expect(source).toContain('https://mymemory.translated.net/doc/usagelimits.php');
    expect(source).toContain('不填写也可以使用');
    expect(source).toContain('不是官方公开翻译 API');
    expect(source).toContain('邮箱会随请求发送给 MyMemory');
    expect(source).toContain('手动选择来源语言');
    for (const provider of FREE_TRANSLATION_PROVIDERS) {
      expect(translateLegacyText(provider.description, 'en-US')).not.toBe(provider.description);
    }
    const connection = readFileSync(resolve(process.cwd(), 'src/features/settings/ui/services/ServiceConfiguration.vue'), 'utf8');
    expect(connection).toContain('v-if="service === services.freeTranslation"');
    expect(connection).toContain('v-if="service === services.myMemory"');
    expect(connection).not.toContain('services.azureTranslator');
  });
});

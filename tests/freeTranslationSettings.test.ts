import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type ViteDevServer} from 'vite';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import {Config} from '@/src/core/config/model';
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation';
import {checkAllFreeTranslationProviders, type FreeTranslationChecks} from '@/src/features/settings/ui/services/freeTranslationChecks';

const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
const componentPath = 'src/features/settings/ui/services/FreeTranslationSettings.vue';
type Node = {tag: string; props: Record<string, any>; text?: string};
let server: ViteDevServer;
let app: import('vue').App;
let config: Config;
let elements: Node[];
let state: Record<string, any>;
let renderer: import('vue').Renderer<Node>;
let component: any;
let checks: FreeTranslationChecks;

beforeAll(async () => {
  server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', root: process.cwd(),
    resolve: {alias: {'@': resolve(process.cwd(), '.')}}, server: {hmr: false, middlewareMode: true},
    ssr: {noExternal: ['webextension-polyfill']},
    plugins: [{name: 'fallback-ui-runtime', enforce: 'pre', resolveId(id) {
      if (id === 'webextension-polyfill') return '\0fallback-webextension-polyfill';
      return /\/src\/ui\/i18n(?:\.ts)?$/u.test(id) ? '\0fallback-i18n' : null;
    }, load(id) {
      if (id === '\0fallback-webextension-polyfill') return 'export default {runtime: {sendMessage: async () => ({success: false})}};';
      return id === '\0fallback-i18n' ? 'export const useUiI18n = () => ({t: key => key, translateLegacy: text => text});' : null;
    }}, vue()],
  });
});

async function mountComponent(advanced: boolean): Promise<void> {
  const filename = resolve(process.cwd(), componentPath);
  const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
  const bindings = compileScript(descriptor, {id: 'free-settings-test'}).bindings;
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'free-settings-test', compilerOptions: {mode: 'function', bindingMetadata: bindings, expressionPlugins: ['typescript']}});
  expect(template.errors).toEqual([]);
  component = (await server.ssrLoadModule(`/${componentPath}?advanced=${advanced}`)).default;
  component.render = new Function('Vue', ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText)(runtime);
  elements = [];
  renderer = runtime.createRenderer<Node, Node>({patchProp: (node, key, _previous, value) => {node.props[key] = value;}, insert: () => undefined, remove: () => undefined, createElement: tag => {const node = {tag, props: {}}; elements.push(node); return node;}, createText: () => ({tag: '#text', props: {}}), createComment: () => ({tag: '#comment', props: {}}), setText: () => undefined, setElementText: (node, value) => {node.text = value;}, parentNode: () => null, nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined, cloneNode: node => ({...node}), insertStaticContent: () => [{tag: '#static', props: {}}, {tag: '#static', props: {}}]});
  app = renderer.createApp(component, {config, advanced, checks});
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  const vm = app.mount({tag: '#root', props: {}});
  state = (vm.$ as unknown as {setupState: Record<string, any>}).setupState;
  await runtime.nextTick();
}

beforeEach(async () => {
  // The external browser constructor is present in production; complete the renderer port.
  vi.stubGlobal('ShadowRoot', parseHTML('<html><body></body></html>').window.ShadowRoot);
  config = runtime.reactive(new Config());
  checks = runtime.reactive({});
  await mountComponent(false);
});
afterEach(() => {app?.unmount(); vi.unstubAllGlobals();});
afterAll(async () => server?.close());
function control(ariaLabel: string): Node { const element = [...elements].reverse().find(node => node.props['aria-label'] === ariaLabel); expect(element, ariaLabel).toBeDefined(); return element!; }

describe('free translation settings compiled component', () => {
  it('微软第一、B站第二展示推荐标记，手动顺序仍可调整', async () => {
    expect(state.providers.slice(0, 2).map((provider: {id: string}) => provider.id)).toEqual(['microsoft', 'bilibiliFree']);
    expect(elements.filter(node => node.props['data-provider-recommended']).map(node => node.text)).toEqual(['推荐']);
    state.setMode('sequential');
    config.freeTranslationOrder = ['google', 'bilibiliFree'];
    await runtime.nextTick();
    expect(state.providers.map((provider: {id: string}) => provider.id).slice(0, 2)).toEqual(['google', 'bilibiliFree']);
  });
  it('已失效的检查不发布排队状态或发起请求', async () => {
    let updates = 0, requests = 0;
    await checkAllFreeTranslationProviders({isCurrent: () => false, failureMessage: 'failed',
      update: () => {updates++;}, check: async () => {requests++;return {success: true};}});
    expect(updates).toBe(0);expect(requests).toBe(0);
  });
  it('排队回调取消后停止后续状态发布，不启动任何服务', async () => {
    let current = true, requests = 0;const updates: string[] = [];
    await checkAllFreeTranslationProviders({isCurrent: () => current, failureMessage: 'failed',
      update: id => {updates.push(id);current = false;}, check: async () => {requests++;return {success: true};}});
    expect(updates).toEqual([FREE_TRANSLATION_PROVIDERS[0].id]);expect(requests).toBe(0);
  });
  it('checking状态回调取消后不发起对应HTTP消息', async () => {
    let current = true, requests = 0;
    await checkAllFreeTranslationProviders({isCurrent: () => current, failureMessage: 'failed',
      update: (_id, value) => {if (value.status === 'checking') current = false;}, check: async () => {requests++;return {success: true};}});
    expect(requests).toBe(0);
  });
  it('所有服务直接展示逐项结果与测试耗时，停用服务也保留本轮检查', async () => {
    const badges = elements.filter(element => element.props['data-provider-state']);
    expect(badges.map(node => node.props['data-provider-state'])).toEqual(FREE_TRANSLATION_PROVIDERS.map(provider => provider.id));
    expect(badges.every(node => node.text === 'settings.services.keys.unchecked')).toBe(true);
    checks.microsoft = {status: 'success', durationMs: 35};
    checks.transmart = {status: 'error', error: '服务限流', durationMs: 1200};
    checks.google = {status: 'checking'};
    await runtime.nextTick();
    expect(state.providerStateLabel('microsoft')).toBe('连接正常');
    expect(elements.find(element => element.props['data-provider-duration'] === 'microsoft')?.text).toBe('35 ms');
    expect(elements.find(element => element.props['data-provider-duration'] === 'transmart')?.text).toBe('1200 ms');
    expect(state.providerStateTitle('microsoft')).toBe('连接正常 · en → zh-Hans · 35 ms');
    expect(state.providerStateLabel('transmart')).toBe('连接失败');
    expect(state.failedProviders.map((provider: {id: string}) => provider.id)).toEqual(['transmart']);
    expect(state.providerStateTitle('transmart')).toBe('服务限流 · en → zh-Hans · 1200 ms');
    expect(state.providerStateLabel('google')).toBe('settings.services.keys.checking');
    state.setMode('sequential');
    await runtime.nextTick();
    expect(state.providerState('microsoft')).toBe('success');
    checks.apertiumFree = {status: 'success', durationMs: 40};
    state.toggle('apertiumFree', true);
    await runtime.nextTick();
    expect(state.providerStateTitle('apertiumFree')).toBe('连接正常 · en → es · 40 ms');
  });

  it('完整目录检查包含停用服务，独立失败仍继续检查其余服务', async () => {
    state.toggle('apertiumFree', false);
    const called: string[] = [];
    let active = 0, peak = 0;
    await checkAllFreeTranslationProviders({
      check: async id => {
        called.push(id); active += 1; peak = Math.max(peak, active);
        await Promise.resolve(); active -= 1;
        if (id === 'microsoft') throw new Error('网络不可用');
        if (id === 'transmart') return {success: false, error: '服务限流'};
        if (id === 'google') return undefined;
        if (id === 'youdaoFree') throw '连接中断';
        return {success: true, durationMs: 10};
      },
      update: (id, state) => { checks[id] = state; }, isCurrent: () => true, failureMessage: '检查失败', now: () => 0,
    });
    expect(called).toEqual(FREE_TRANSLATION_PROVIDERS.map(provider => provider.id));
    expect(peak).toBe(3);
    expect(checks.microsoft).toEqual({status: 'error', error: '网络不可用', durationMs: 0});
    expect(checks.transmart).toEqual({status: 'error', error: '服务限流', durationMs: 0});
    expect(checks.google).toEqual({status: 'error', error: '检查失败', durationMs: 0});
    expect(checks.youdaoFree).toEqual({status: 'error', error: '连接中断', durationMs: 0});
    expect(checks.apertiumFree).toEqual({status: 'success', durationMs: 10});
    expect(config.freeTranslationOrder).not.toContain('apertiumFree');
  });

  it('measures each dispatched test without including queue time and clears timing while retesting', async () => {
    let clock = 100;
    const pending: Array<{resolve: (value: {success: boolean; durationMs?: number; error?: string}) => void; reject: (error: Error) => void}> = [];
    const run = checkAllFreeTranslationProviders({
      check: id => ['bilibiliFree', 'microsoft', 'transmart'].includes(id)
        ? new Promise((resolve, reject) => pending.push({resolve, reject}))
        : Promise.resolve({success: true, durationMs: Number.NaN}),
      update: (id, value) => {checks[id] = value;},
      isCurrent: () => true, failureMessage: '检查失败', now: () => clock,
    });
    clock = 125;
    pending[0].resolve({success: true, durationMs: 7.4});
    pending[1].resolve({success: false, error: '超时'});
    pending[2].reject(new Error('断开'));
    await run;
    expect(checks.microsoft?.durationMs).toBe(7);
    expect(checks.bilibiliFree?.durationMs).toBe(25);
    expect(checks.transmart?.durationMs).toBe(25);
    expect(checks.apertiumFree?.durationMs).toBe(0);
    checks.microsoft = {status: 'checking', durationMs: 7};
    await runtime.nextTick();
    expect(state.providerDuration('microsoft')).toBeUndefined();
    checks.microsoft = {status: 'success', durationMs: -1};
    expect(state.providerDuration('microsoft')).toBeUndefined();
    checks.microsoft = {status: 'success'};
    expect(state.providerDuration('microsoft')).toBeUndefined();
  });

  it('切换服务后不发起后续检查，迟到响应不能覆盖新状态', async () => {
    let current = true;
    const pending: Array<{resolve: (value: {success: boolean}) => void; reject: (error: Error) => void}> = [];
    const run = checkAllFreeTranslationProviders({
      check: () => new Promise((resolve, reject) => { pending.push({resolve, reject}); }),
      update: (id, state) => { checks[id] = state; }, isCurrent: () => current, failureMessage: '检查失败',
    });
    expect(pending).toHaveLength(3);
    current = false;
    checks.microsoft = {status: 'idle'};
    pending[0].reject(new Error('迟到的网络错误'));
    pending.slice(1).forEach(({resolve}) => resolve({success: true}));
    await run;
    expect(pending).toHaveLength(3);
    expect(checks.microsoft).toEqual({status: 'idle'});
    expect(checks.google).toEqual({status: 'queued'});
  });
  async function mountAdvanced(): Promise<void> {
    app.unmount();
    await mountComponent(true);
  }

  it('shows free service controls immediately while leaving timeout in advanced mode', () => {
    expect(elements.some(element => element.props['aria-label'] === 'settings.services.freeWeights.mode')).toBe(true);
    expect(elements.filter(element => element.props['data-fallback-provider'])).toHaveLength(FREE_TRANSLATION_PROVIDERS.length);
    expect(elements.some(element => element.props['aria-label'] === '每个服务最多等待（秒）')).toBe(false);
    expect(control('settings.services.library.memoryEmail')).toBeDefined();
    expect(elements.some(element => element.tag === 'section' && element.props.class === 'provider-settings')).toBe(true);
    expect(readFileSync(resolve(process.cwd(), componentPath), 'utf8')).not.toContain('my-memory-advanced');
  });

  it('renders every provider and mode control in basic mode', async () => {
    expect(state.mode).toBe('balanced');
    expect(state.providers.map((provider: {id: string}) => provider.id)).toEqual(FREE_TRANSLATION_PROVIDERS.map(provider => provider.id));
    expect(control('启用 微软翻译')).toBeDefined();
    expect(elements.some(element => element.props['aria-label'] === '启用 微软翻译')).toBe(true);
    expect(elements.some(element => element.props['data-testid'] === 'free-translation-weight-summary')).toBe(true);
    expect(elements.filter(element => element.props['data-provider-weight'])).toHaveLength(config.freeTranslationOrder.length);
    const details = elements.find(element => element.props['data-testid'] === 'free-routing-details');
    expect(details).toBeUndefined();
    expect(elements.some(element => element.tag === 'details')).toBe(false);
    expect(elements.find(element => element.props['data-provider-weight'] === 'microsoft')?.text).toBe('13.1%');
    expect(control('启用 阿里翻译').props['model-value']).toBe(true);
    state.toggle('alibabaFree', false);
    await runtime.nextTick();
    expect(control('启用 阿里翻译').props['model-value']).toBe(false);
    state.toggle('alibabaFree', true);
    await runtime.nextTick();
    expect(control('启用 阿里翻译').props['model-value']).toBe(true);
    expect(config.freeTranslationOrder).toContain('alibabaFree');
    expect(readFileSync(resolve(process.cwd(), componentPath), 'utf8')).not.toContain('setWeight');
  });

  it('switches mode and exposes order controls in priority mode', async () => {
    control('优先顺序').props.onChange();
    await runtime.nextTick();
    expect(config.freeTranslationMode).toBe('sequential');
    expect(control('下移 微软翻译').props.disabled).toBe(false);
    control('settings.services.freeWeights.mode').props.onChange();
    await runtime.nextTick();
    expect(config.freeTranslationMode).toBe('balanced');
  });

  it('shows cooling only for an enabled service and exposes allocation beside services', async () => {
    state.weightSnapshot = {total: 100, observedAt: Date.now(), entries: [{providerId: 'microsoft', weight: 0, status: 'cooling'}]};
    await runtime.nextTick();
    expect(state.weightStatus('microsoft')).toBe('cooling');
    state.toggle('microsoft', false);
    await runtime.nextTick();
    expect(state.weightStatus('microsoft')).toBe('disabled');
    state.weightSnapshot = {total: 100, observedAt: Date.now(), entries: [{providerId: 'microsoft', weight: 0, status: 'disabled'}]};
    state.toggle('microsoft', true);
    await runtime.nextTick();
    expect(state.weightStatus('microsoft')).toBe('ready');
  });

  it('keeps at least one service enabled', async () => {
    for (const provider of FREE_TRANSLATION_PROVIDERS.slice(1)) state.toggle(provider.id, false);
    await runtime.nextTick();
    expect(config.freeTranslationOrder).toHaveLength(1);
    const only = config.freeTranslationOrder[0];
    state.toggle(only, false);
    expect(config.freeTranslationOrder).toEqual([only]);
  });

  it('keeps partial email local and commits only valid email', async () => {
    const email = control('settings.services.library.memoryEmail');
    email.props['onUpdate:modelValue']('contact@'); email.props.onChange();
    expect(config.myMemoryEmail).toBe('');
    email.props['onUpdate:modelValue']('contact@example.test'); email.props.onChange();
    expect(config.myMemoryEmail).toBe('contact@example.test');
  });

  it('updates the timeout through the advanced control', async () => {
    await mountAdvanced();
    expect(elements.some(element => element.props['data-fallback-provider'])).toBe(false);
    const timeout = control('每个服务最多等待（秒）');
    timeout.props['onUpdate:modelValue'](9);
    expect(config.freeTranslationTimeoutMs).toBe(9000);
  });
});

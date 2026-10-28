import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(),
  createShadowRootUi: vi.fn(),
  browser: {runtime: {sendMessage: vi.fn()}},
}));

vi.mock('vue', () => ({createApp: mocks.createApp}));
vi.mock('wxt/utils/content-script-ui/shadow-root', () => ({
  createShadowRootUi: mocks.createShadowRootUi,
}));
vi.mock('webextension-polyfill', () => ({default: mocks.browser}));
vi.mock('wxt/browser', () => ({browser: mocks.browser}));
vi.mock('@/src/ui/i18n', () => ({createUiI18nPlugin: vi.fn(() => ({}))}));

import {createVueShadowUi} from '@/src/platform/shadow-ui';

function shadowUi() {
  const attributes = new Map<string, string>();
  const host = {
    id: '',
    setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
  };
  return {
    attributes,
    host,
    ui: {
      shadowHost: host,
      mount: vi.fn(),
      remove: vi.fn(),
    },
  };
}

beforeEach(() => {
  mocks.createApp.mockReset();
  mocks.createShadowRootUi.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Vue Shadow UI 平台适配器', () => {
  it('releases an app when the content context invalidates synchronously during its mount', async () => {
    const {window, document} = parseHTML('<html><head></head><body></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    const actual = await vi.importActual<typeof import('wxt/utils/content-script-ui/shadow-root')>('wxt/utils/content-script-ui/shadow-root');
    mocks.createShadowRootUi.mockImplementation(actual.createShadowRootUi);
    let invalidate!: () => void;
    const ctx = {isInvalid: false, onInvalidated: (callback: () => void) => { invalidate = callback; }};
    const app = {use: vi.fn(), mount: vi.fn(() => {ctx.isInvalid = true; invalidate(); return {}; }), unmount: vi.fn()};
    mocks.createApp.mockReturnValue(app);
    await expect(createVueShadowUi(ctx as never, {name: 'invalidated-during-mount', hostId: 'invalidated-during-mount', component: {}}))
      .rejects.toMatchObject({name: 'AbortError'});
    expect(app.unmount).toHaveBeenCalledOnce();
    expect(document.getElementById('invalidated-during-mount')).toBeNull();
  });

  it('does not mount when the context invalidates during app configuration', async () => {
    const {window, document} = parseHTML('<html><head></head><body></body></html>');
    vi.stubGlobal('window', window); vi.stubGlobal('document', document);
    const actual = await vi.importActual<typeof import('wxt/utils/content-script-ui/shadow-root')>('wxt/utils/content-script-ui/shadow-root');
    mocks.createShadowRootUi.mockImplementation(actual.createShadowRootUi);
    let invalidate!: () => void;
    const ctx = {isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}};
    const app = {use: vi.fn(), mount: vi.fn(), unmount: vi.fn()};
    mocks.createApp.mockReturnValue(app);
    await expect(createVueShadowUi(ctx as never, {
      name: 'invalidated-during-config', hostId: 'invalidated-during-config', component: {},
      configureApp: () => {ctx.isInvalid = true; invalidate();},
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(app.mount).not.toHaveBeenCalled();
    expect(app.unmount).toHaveBeenCalledOnce();
    expect(document.getElementById('invalidated-during-config')).toBeNull();
  });

  it('unmounts a real Vue component invalidated in its mounted hook', async () => {
    const {window, document} = parseHTML('<html><head></head><body></body></html>');
    vi.stubGlobal('window', window); vi.stubGlobal('document', document);
    vi.stubGlobal('Element', window.Element); vi.stubGlobal('SVGElement', window.SVGElement);
    const actualWxt = await vi.importActual<typeof import('wxt/utils/content-script-ui/shadow-root')>('wxt/utils/content-script-ui/shadow-root');
    mocks.createShadowRootUi.mockImplementation(actualWxt.createShadowRootUi);
    const vue = await vi.importActual<typeof import('vue')>('vue');
    mocks.createApp.mockImplementation(vue.createApp);
    let invalidate!: () => void;
    const ctx = {isInvalid: false, onInvalidated: (callback: () => void) => {invalidate = callback;}};
    const mounted = vi.fn(), unmounted = vi.fn();
    const component = vue.defineComponent({setup() {
      vue.onMounted(() => {mounted(); ctx.isInvalid = true; invalidate();});
      vue.onUnmounted(unmounted);
      return () => vue.h('button', 'test');
    }});
    await expect(createVueShadowUi(ctx as never, {name: 'invalidated-real-vue', hostId: 'invalidated-real-vue', component, configureApp: () => {}}))
      .rejects.toMatchObject({name: 'AbortError'});
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).toHaveBeenCalledOnce();
    expect(document.getElementById('invalidated-real-vue')).toBeNull();
  });
  it.each([false, true])('实际 WXT 宿主跨延迟 body 替换保留同一组件，失效时正常卸载（viewport=%s）', async viewport => {
    const {window, document} = parseHTML('<html><head></head><body><main>First page</main></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    const actual = await vi.importActual<typeof import('wxt/utils/content-script-ui/shadow-root')>('wxt/utils/content-script-ui/shadow-root');
    mocks.createShadowRootUi.mockImplementation(actual.createShadowRootUi);
    const instance = {state: 'retained'};
    const app = {use: vi.fn(), mount: vi.fn(() => instance), unmount: vi.fn()};
    mocks.createApp.mockReturnValue(app);
    const invalidated = vi.fn();
    const ui = await createVueShadowUi({isInvalid: false, onInvalidated: invalidated} as never, {
      name: 'navigation-ui', hostId: 'navigation-host', component: {}, viewport,
    });
    const host = ui.shadowHost;
    const container = ui.uiContainer;
    const routeChecks: boolean[] = [];
    document.addEventListener('fluentread-route-change', () => routeChecks.push(Boolean(document.getElementById('navigation-host'))));
    vi.useFakeTimers();
    for (const delay of [0, 34, 572, 1000]) {
      document.dispatchEvent(new window.Event('fluentread-route-change'));
      const oldBody = document.body;
      setTimeout(() => {
        const body = document.createElement('body');
        body.innerHTML = `<main>Next page after ${delay}ms</main>`;
        oldBody.replaceWith(body);
      }, delay);
      await vi.advanceTimersByTimeAsync(delay);
      expect(oldBody.isConnected).toBe(false);
      expect(document.getElementById('navigation-host')).toBe(host);
      expect(host.parentElement).toBe(document.documentElement);
      expect(ui.uiContainer).toBe(container);
      expect(ui.mounted?.instance).toBe(instance);
    }
    expect(routeChecks).toEqual([true, true, true, true]);
    expect(app.mount).toHaveBeenCalledOnce();
    expect(app.unmount).not.toHaveBeenCalled();
    invalidated.mock.calls[0][0]();
    expect(app.unmount).toHaveBeenCalledOnce();
    expect(host.isConnected).toBe(false);
  });

  it('上下文在异步创建期间失效时释放 Shadow UI，不挂载迟到的组件', async () => {
    const fixture = shadowUi();
    const context = {isInvalid: false};
    let finish!: (ui: unknown) => void;
    mocks.createShadowRootUi.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = createVueShadowUi(context as never, {
      name: 'expired-ui', hostId: 'expired-host', component: {name: 'Expired'},
    });
    context.isInvalid = true;
    finish(fixture.ui);

    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(fixture.ui.remove).toHaveBeenCalledOnce();
    expect(fixture.ui.mount).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  it('已失效的上下文不创建 Shadow UI', async () => {
    await expect(createVueShadowUi({isInvalid: true} as never, {
      name: 'expired-ui', hostId: 'expired-host', component: {},
    })).rejects.toMatchObject({name: 'AbortError'});
    expect(mocks.createShadowRootUi).not.toHaveBeenCalled();
  });

  it('使用安全默认值挂载，并在 WXT 移除时卸载 Vue', async () => {
    const fixture = shadowUi();
    const instance = {kind: 'component'};
    const app = {use: vi.fn(), mount: vi.fn(() => instance), unmount: vi.fn()};
    mocks.createApp.mockReturnValue(app);
    mocks.createShadowRootUi.mockResolvedValue(fixture.ui);
    const component = {name: 'Fixture'};

    const result = await createVueShadowUi({} as never, {
      name: 'fixture-ui',
      hostId: 'fixture-host',
      component,
    });

    const [, options] = mocks.createShadowRootUi.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({
      name: 'fixture-ui',
      position: 'overlay',
      alignment: 'top-left',
      zIndex: 2_147_483_647,
      mode: 'open',
      inheritStyles: false,
      isolateEvents: ['keydown', 'keyup', 'keypress'],
    }));
    expect(options.css).toContain(':host');

    const container = {nodeType: 1};
    const mounted = options.onMount(container);
    expect(mocks.createApp).toHaveBeenCalledWith(component, {});
    expect(app.mount).toHaveBeenCalledWith(container);
    expect(mounted).toEqual({app, instance});
    options.onRemove(mounted);
    options.onRemove(undefined);
    expect(app.unmount).toHaveBeenCalledOnce();

    expect(result).toBe(fixture.ui);
    expect(fixture.host.id).toBe('fixture-host');
    expect(fixture.attributes.get('data-fluent-read-ui')).toBe('fixture-ui');
    expect(fixture.ui.mount).toHaveBeenCalledOnce();
  });

  it('透传 props、层级和关闭模式', async () => {
    const fixture = shadowUi();
    const app = {use: vi.fn(), mount: vi.fn(() => null), unmount: vi.fn()};
    mocks.createApp.mockReturnValue(app);
    mocks.createShadowRootUi.mockResolvedValue(fixture.ui);
    const props = {label: '测试'};

    await createVueShadowUi({} as never, {
      name: 'closed-ui',
      hostId: 'closed-host',
      component: {name: 'ClosedFixture'},
      props,
      zIndex: 99,
      mode: 'closed',
    });

    const [, options] = mocks.createShadowRootUi.mock.calls[0];
    options.onMount({});
    expect(options).toEqual(expect.objectContaining({zIndex: 99, mode: 'closed'}));
    expect(mocks.createApp).toHaveBeenCalledWith({name: 'ClosedFixture'}, props);
  });

  it('保留 WXT 创建失败，让 feature 运行时决定如何降级', async () => {
    mocks.createShadowRootUi.mockRejectedValue(new Error('shadow unavailable'));

    await expect(createVueShadowUi({} as never, {
      name: 'failed-ui',
      hostId: 'failed-host',
      component: {name: 'FailedFixture'},
    })).rejects.toThrow('shadow unavailable');
  });

  it('把本次自有挂载容器交给 configureApp，并在配置完成后挂载同一 Vue app', async () => {
    const fixture = shadowUi();
    const instance = {kind: 'owned-component'};
    const app = {use: vi.fn(), mount: vi.fn(() => instance), unmount: vi.fn()};
    const configureApp = vi.fn();
    mocks.createApp.mockReturnValue(app);
    mocks.createShadowRootUi.mockResolvedValue(fixture.ui);

    await createVueShadowUi({} as never, {
      name: 'owned-configured-ui', hostId: 'owned-configured-host', component: {name: 'OwnedFixture'},
      configureApp,
    });

    const [, options] = mocks.createShadowRootUi.mock.calls[0];
    const {document} = parseHTML('<div id="owned-ui-container"></div>');
    const exactContainer = document.querySelector<HTMLElement>('#owned-ui-container')!;
    const mounted = options.onMount(exactContainer);
    expect(configureApp).toHaveBeenCalledOnce();
    expect(configureApp).toHaveBeenCalledWith(app, exactContainer);
    expect(configureApp.mock.calls[0][1]).toBe(exactContainer);
    expect(configureApp.mock.invocationCallOrder[0]).toBeLessThan(app.mount.mock.invocationCallOrder[0]);
    expect(app.mount).toHaveBeenCalledWith(exactContainer);
    expect(app.use).not.toHaveBeenCalled();
    expect(mounted).toEqual({app, instance});
    options.onRemove(mounted);
    expect(app.unmount).toHaveBeenCalledOnce();
  });
});

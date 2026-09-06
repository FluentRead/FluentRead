import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { parseHTML } from 'linkedom';
import { createServer, type Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface ComponentTestState {
  browser: {
    runtime: {
      sendMessage: () => Promise<unknown>;
      onMessage: {
        addListener: () => void;
        removeListener: () => void;
      };
    };
  };
  config: Record<string, unknown>;
  configReady: Promise<void>;
  requestConfigPatch: () => Promise<void>;
  subscribeConfig: () => () => void;
}

const TEST_STATE_KEY = '__fluentReadVocabularyLifecycleTest';

function setComponentTestState(state: ComponentTestState | undefined): void {
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  if (state) target[TEST_STATE_KEY] = state;
  else delete target[TEST_STATE_KEY];
}

function componentMocks(): Plugin {
  return {
    name: 'vocabulary-lifecycle-test-mocks',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'element-plus') return '\0vocabulary-element-mock';
      if (id.includes('element-plus/') && id.includes('/style')) return '\0vocabulary-style-mock';
      if (id.endsWith('/UiSelect.vue')) return '\0vocabulary-select-mock';
      if (id === 'webextension-polyfill') return '\0vocabulary-browser-mock';
      if (
        id === '@/src/services/config/store'
        || id.endsWith('/src/services/config/store')
        || id.endsWith('/src/services/config/store.ts')
      ) {
        return '\0vocabulary-config-mock';
      }
      return null;
    },
    load(id) {
      if (id === '\0vocabulary-element-mock') return 'export const ElMessageBox = {confirm:async()=>{}}; export const ElOption = {render(){return null}};';
      if (id === '\0vocabulary-style-mock') return 'export {};';
      if (id === '\0vocabulary-select-mock') return 'export default {render() {return null}};';
      if (id === '\0vocabulary-browser-mock') {
        return `export default globalThis.${TEST_STATE_KEY}.browser;`;
      }
      if (id === '\0vocabulary-config-mock') {
        return [
          `const state = globalThis.${TEST_STATE_KEY};`,
          'export const config = state.config;',
          'export const configReady = state.configReady;',
          'export const requestConfigPatch = state.requestConfigPatch;',
          'export const subscribeConfig = state.subscribeConfig;',
        ].join('\n');
      }
      return null;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setComponentTestState(undefined);
});

describe('VocabularyBook mounted lifecycle', () => {
  it('refreshes failed optimistic updates from authoritative config without rewriting it', () => {
    const component = readFileSync(resolve(
      process.cwd(),
      'src/features/vocabulary/ui/VocabularyBook.vue',
    ), 'utf8');

    expect(component).toContain('betaEnabled.value = runtimeConfig.vocabularyBookEnabled === true;');
    expect(component).not.toContain('runtimeConfig.vocabularyBookEnabled = previous;');
  });

  it('does not subscribe, register listeners, or list after unmounting before configReady', async () => {
    const calls = {
      runtimeAdd: 0,
      runtimeSend: 0,
      subscribe: 0,
    };
    let resolveConfigReady!: () => void;
    const configReady = new Promise<void>((resolveReady) => { resolveConfigReady = resolveReady; });
    setComponentTestState({
      browser: {
        runtime: {
          sendMessage: async () => {
            calls.runtimeSend += 1;
            return { success: true, data: [] };
          },
          onMessage: {
            addListener: () => { calls.runtimeAdd += 1; },
            removeListener: () => undefined,
          },
        },
      },
      config: {
        theme: 'auto',
        vocabularyBookEnabled: false,
        selectionTranslatorMode: 'disabled',
        to: 'zh-CN',
      },
      configReady,
      requestConfigPatch: async () => undefined,
      subscribeConfig: () => {
        calls.subscribe += 1;
        return () => undefined;
      },
    });

    const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
    const { document } = window;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const windowAdd = vi.fn();
    const windowRemove = vi.fn();
    Object.defineProperties(window, {
      addEventListener: { configurable: true, value: windowAdd },
      removeEventListener: { configurable: true, value: windowRemove },
    });
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const mediaAdd = vi.fn();
    const mediaRemove = vi.fn();
    const matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: mediaAdd,
      removeEventListener: mediaRemove,
    }));
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia;

    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('SVGElement', window.SVGElement);
    vi.stubGlobal('Event', window.Event);
    vi.stubGlobal('navigator', window.navigator);

    const require = createRequire(import.meta.url);
    const vueRuntime = require('vue') as typeof import('vue');
    const server = await createServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      plugins: [componentMocks(), vue()],
      resolve: { alias: { '@': resolve(process.cwd(), '.') } },
      root: process.cwd(),
      server: { hmr: false, middlewareMode: true },
      ssr: { noExternal: ['webextension-polyfill', 'element-plus'] },
    });

    try {
      const loaded = await server.ssrLoadModule('/src/features/vocabulary/ui/VocabularyBook.vue');
      const component = loaded.default as { render?: () => null; ssrRender?: unknown };
      component.ssrRender = undefined;
      component.render = () => null;
      const renderer = vueRuntime.createRenderer<Record<string, never>, Record<string, unknown>>({
        patchProp: () => undefined,
        insert: () => undefined,
        remove: () => undefined,
        createElement: () => ({}),
        createText: () => ({}),
        createComment: () => ({}),
        setText: () => undefined,
        setElementText: () => undefined,
        parentNode: () => null,
        nextSibling: () => null,
        querySelector: () => null,
        setScopeId: () => undefined,
        cloneNode: () => ({}),
        insertStaticContent: () => [{}, {}],
      });
      const app = renderer.createApp(component as import('vue').Component);
      app.provide(vueRuntime.ssrContextKey, { modules: new Set<string>() });
      app.config.warnHandler = () => undefined;
      app.mount({});
      await vueRuntime.nextTick();
      expect(matchMedia).toHaveBeenCalledTimes(1);

      app.unmount();
      resolveConfigReady();
      await configReady;
      await Promise.resolve();
      await Promise.resolve();

      expect(calls).toEqual({ runtimeAdd: 0, runtimeSend: 0, subscribe: 0 });
      expect(windowAdd.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
      expect(documentAdd.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(0);
      expect(mediaAdd).toHaveBeenCalledTimes(1);
      expect(mediaRemove).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

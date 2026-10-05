import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, describe, expect, it, vi} from 'vitest';

const TEST_KEY = '__frOptionsNavigationLifecycle';
const runtime = createRequire(import.meta.url)('vue') as typeof import('vue');
let server: ViteDevServer | undefined;
let unmount: (() => void) | undefined;

afterEach(async () => {
  unmount?.();
  unmount = undefined;
  await server?.close();
  server = undefined;
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>)[TEST_KEY];
});

async function mountOptions(hash = '#settings-selection') {
  const location = {hash};
  const windowEvents = new EventTarget();
  const mediaAdd = vi.fn();
  const mediaRemove = vi.fn();
  const scrollTo = vi.fn();
  const windowScrollTo = vi.fn();
  const unsubscribeConfig = vi.fn();
  const replaceState = vi.fn((_state: unknown, _unused: string, nextHash: string) => {
    location.hash = nextHash;
  });
  const addEventListener = vi.spyOn(windowEvents, 'addEventListener');
  const removeEventListener = vi.spyOn(windowEvents, 'removeEventListener');
  vi.stubGlobal('window', Object.assign(windowEvents, {
    location,
    scrollTo: windowScrollTo,
    matchMedia: () => ({matches: false, addEventListener: mediaAdd, removeEventListener: mediaRemove}),
  }));
  vi.stubGlobal('history', {replaceState});
  (globalThis as Record<string, unknown>)[TEST_KEY] = {
    config: {interfaceSkin: 'default'},
    configReady: Promise.resolve(),
    subscribeConfig: () => unsubscribeConfig,
  };
  const mocks: Plugin = {
    name: 'options-navigation-lifecycle-mocks',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('.vue') && !id.endsWith('/OptionsApp.vue')) return '\0options-child-component';
      if (id.endsWith('/src/ui/i18n')) return '\0options-i18n';
      if (id.endsWith('/src/services/config/store')) return '\0options-config';
      if (id.endsWith('/src/ui/interfaceAppearance')) return '\0options-appearance';
      return null;
    },
    load(id) {
      if (id === '\0options-child-component') return 'export default {render: () => null};';
      if (id === '\0options-i18n') return 'export const useUiI18n = () => ({t: key => key, translateLegacy: text => text});';
      if (id === '\0options-config') return `export const {config, configReady, subscribeConfig} = globalThis.${TEST_KEY};`;
      if (id === '\0options-appearance') return 'export const applyInterfaceSkin = () => {}; export const applyInterfaceFont = () => {}; export const applyInterfaceTheme = () => {}; export const setInterfaceAppearanceRoot = () => {};';
      return null;
    },
  };
  server = await createServer({
    configFile: false, appType: 'custom', logLevel: 'silent', root: process.cwd(),
    plugins: [mocks, vue()], resolve: {alias: {'@': resolve(process.cwd())}},
    server: {hmr: false, middlewareMode: true},
  });
  const {default: component} = await server.ssrLoadModule('/src/app/options/OptionsApp.vue');
  component.ssrRender = undefined;
  component.render = () => null;
  const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
    patchProp: () => undefined, insert: () => undefined, remove: () => undefined,
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText: () => undefined, setElementText: () => undefined, parentNode: () => null,
    nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
    cloneNode: () => ({}), insertStaticContent: () => [{}, {}],
  });
  let state!: {activeSection: string; query: string; activeItem: {id: string}; selectSection: (id: string, target?: string) => void; activePanel: string; activePanels: {id: string}[]; contentComponentProps: {activePanel?: string}; selectPanel: (id: string) => void; isGroupOpen: (index: number) => boolean; toggleGroup: (index: number) => void; settingsContentElement: {scrollTo: typeof scrollTo} | null};
  const app = renderer.createApp({
    setup: () => () => runtime.h(component, {
      ref: (instance: any) => { if (instance) state = instance.$.setupState; },
    }),
  });
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  app.mount({});
  state.settingsContentElement = {scrollTo};
  unmount = () => app.unmount();
  await runtime.nextTick();
  const navigateHash = async (nextHash: string) => {
    location.hash = nextHash;
    windowEvents.dispatchEvent(new Event('hashchange'));
    await runtime.nextTick();
  };
  return {state, location, navigateHash, replaceState, scrollTo, windowScrollTo, addEventListener, removeEventListener, mediaAdd, mediaRemove, unsubscribeConfig};
}

describe('OptionsApp mounted hash navigation', () => {
  it('isolates website tasks while preserving the continuous layout of ordinary settings', async () => {
    const {state} = await mountOptions('#settings-sites');
    expect(state.activePanels.map(panel => panel.id)).toEqual(['rules', 'adaptation', 'preview']);
    expect(state.contentComponentProps.activePanel).toBe('rules');
    state.selectPanel('preview');
    expect(state.activePanel).toBe('preview');
    expect(state.contentComponentProps.activePanel).toBe('preview');
    state.selectSection('settings-sites', 'adaptation');
    expect(state.contentComponentProps.activePanel).toBe('adaptation');
    state.selectSection('settings-image-translation');
    expect(state.activePanels).toEqual([]);
    expect(state.contentComponentProps.activePanel).toBeUndefined();
  });

  it('follows same-document deep links and history hash changes after the initial mount', async () => {
    const {state, navigateHash, replaceState, scrollTo, windowScrollTo} = await mountOptions();
    expect(state.activeSection).toBe('settings-selection');
    state.query = 'pending search';
    await navigateHash('#settings-vocabulary');
    expect(state.activeSection).toBe('settings-vocabulary');
    expect(state.activeItem.id).toBe('settings-vocabulary');
    expect(state.query).toBe('');
    await navigateHash('#settings-selection');
    expect(state.activeSection).toBe('settings-selection');
    await navigateHash('#settings-vocabulary');
    expect(state.activeSection).toBe('settings-vocabulary');
    expect(replaceState).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenLastCalledWith({top: 0, left: 0, behavior: 'instant'});
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it('canonicalizes aliases and unknown fragments through the shared navigation resolver', async () => {
    const {state, location, navigateHash, replaceState} = await mountOptions('#settings-learning-center');
    expect(state.activeSection).toBe('settings-vocabulary');
    expect(location.hash).toBe('#settings-vocabulary');
    await navigateHash('#missing-section');
    expect(state.activeSection).toBe('settings-general');
    expect(location.hash).toBe('#settings-general');
    await navigateHash('#settings-learning-center');
    expect(state.activeSection).toBe('settings-vocabulary');
    expect(location.hash).toBe('#settings-vocabulary');
    expect(replaceState).toHaveBeenCalledTimes(3);
    state.selectSection('settings-selection');
    expect(location.hash).toBe('#settings-selection');
    expect(state.activeSection).toBe('settings-selection');
    state.selectSection('settings-selection');
    expect(replaceState).toHaveBeenCalledTimes(4);
  });

  it('removes the hash listener on unmount and no longer changes the former page state', async () => {
    const {state, navigateHash, addEventListener, removeEventListener, mediaAdd, mediaRemove, unsubscribeConfig} = await mountOptions();
    const hashListener = addEventListener.mock.calls.find(([event]) => event === 'hashchange')?.[1];
    expect(hashListener).toBeTypeOf('function');
    unmount?.();
    unmount = undefined;
    expect(removeEventListener).toHaveBeenCalledWith('hashchange', hashListener);
    expect(mediaAdd).toHaveBeenCalledTimes(2);
    expect(mediaRemove).toHaveBeenCalledTimes(2);
    expect(unsubscribeConfig).toHaveBeenCalledOnce();
    await navigateHash('#settings-vocabulary');
    expect(state.activeSection).toBe('settings-selection');
  });
});


it('reveals collapsed groups and the correct page category for a cross-page control', async () => {
  const {state, location} = await mountOptions('#settings-general');
  expect(state.isGroupOpen(0)).toBe(true);
  expect(state.isGroupOpen(3)).toBe(true);
  state.toggleGroup(3);
  expect(state.isGroupOpen(3)).toBe(false);
  state.selectSection('settings-advanced', 'cache');
  expect(state.activePanel).toBe('cache');
  expect(state.isGroupOpen(3)).toBe(true);
  expect(location.hash).toBe('#settings-advanced');
  state.selectPanel('requests');
  expect(state.activePanel).toBe('requests');
  state.selectSection('settings-translation', 'floating-ball-settings');
  expect(state.activePanel).toBe('tools');
  state.selectSection('settings-translation');
  expect(state.activePanel).toBe('reading');
  state.toggleGroup(3);
  expect(state.isGroupOpen(3)).toBe(false);
  state.toggleGroup(3);
  expect(state.isGroupOpen(3)).toBe(true);
});

it('keeps model-usage deep links inside the statistics page and preserves the tab on reload', async () => {
  const {state, location, navigateHash} = await mountOptions('#settings-model-usage');
  expect(state.activeSection).toBe('settings-translation-stats');
  expect(state.activePanel).toBe('usage');
  expect(location.hash).toBe('#settings-model-usage');
  state.selectPanel('overview');
  expect(location.hash).toBe('#settings-translation-stats');
  state.selectPanel('usage');
  expect(location.hash).toBe('#settings-model-usage');
  await navigateHash('#settings-general');
  await navigateHash('#settings-model-usage');
  expect(state.activePanel).toBe('usage');
});

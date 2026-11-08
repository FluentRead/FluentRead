import './helpers/vueDomFixture';
import * as runtime from 'vue';
import {parseHTML} from 'linkedom';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {TranslationParams, UiLanguage} from '../src/core/i18n';

const TEST_KEY = '__frOptionsNavigationLifecycle';
type ActualUiI18n = {language: import('vue').Ref<UiLanguage>; t: (key: string, params?: TranslationParams) => string; translateLegacy: (text: string) => string};
type FixtureScope = {active: boolean; unmount?: () => void};
type LearningVisibilityProps = {isVisible?: () => boolean};
let current: FixtureScope | undefined;
let unmount: (() => void) | undefined;
const owns = (scope: FixtureScope) => scope.active && current === scope;
const inactive = () => new Error('Options fixture scope is closed');
async function closeFixture(scope: FixtureScope) {
  scope.active = false;
  try {
    scope.unmount?.();
  } finally {
    if (current === scope) {
      current = undefined;
      unmount = undefined;
      vi.unstubAllGlobals();
      delete (globalThis as Record<string, unknown>)[TEST_KEY];
    }

  }
}
beforeEach(() => {current = {active: true};vi.resetModules();vi.stubEnv('BROWSER', 'chrome');});
afterEach(async () => {
  const scope = current;
  if (scope) await closeFixture(scope);vi.unstubAllEnvs();
}, 5000);

/** Direct module imports preserve source maps; only external UI/storage ports are replaced. */
function configureOptionsPorts(data: Record<string, any>) {
  const display = {render: () => null};
  vi.doMock('@/src/ui/i18n', () => ({useUiI18n: () => data.i18n ??
    ({t: (key: string) => key === 'informationHighlight.title' ? 'Smart Highlighting' : key, translateLegacy: (text: string) => text})}));
  vi.doMock('@/src/services/config/store', () => data);
  vi.doMock('@/src/ui/interfaceAppearance', () => ({applyInterfaceTheme: data.theme, applyInterfaceSkin: data.skin,
    applyInterfaceFont: data.font, registerInterfaceAppearanceRoot: data.registerAppearance}));
  vi.doMock('@/src/platform/browser/capabilities', () => ({browserCapabilities: data.browserCapabilities}));
  vi.doMock('@/src/app/options/assets/wechat-contact.jpg', () => ({default: 'synthetic-contact-image'}));
  vi.doUnmock('@/src/app/options/aboutImages');
  for (const path of ['@/src/ui/components/UiIcon.vue', '@/src/features/settings/ui/SettingsNavigationIcon.vue',
    '@/src/features/settings/ui/components/SettingsSectionNavigation.vue', '@/src/features/settings/ui/SettingsSections.vue',
    '@/src/features/settings/ui/LearningCenter.vue']) vi.doMock(path, () => ({__esModule: true, default: display}));
}

type RecoveryFixture = {href: string; historyState: unknown; props?: {locationRouting?: 'internal'; initialSection?: string}};
async function mountOptions(hash = '#settings-selection', ready = Promise.resolve(), appearanceRoot?: HTMLElement, load?: () => Promise<Record<string, any>>, browser = 'chrome', uiLanguage?: UiLanguage, recovery?: RecoveryFixture) {
  const scope = current;
  if (!scope || !owns(scope)) throw inactive();
  const initialUrl = recovery ? new URL(recovery.href) : undefined;
  const location = {hash: initialUrl?.hash ?? hash, search: initialUrl?.search ?? '', href: initialUrl?.href ?? `chrome-extension://fixture/options.html${hash}`, reload: vi.fn()};
  const windowEvents = new EventTarget();
  const mediaAdd = vi.fn();
  const mediaRemove = vi.fn();
  const scrollTo = vi.fn();
  const windowScrollTo = vi.fn();
  const unsubscribeConfig = vi.fn();
  const theme = vi.fn(), skin = vi.fn(), font = vi.fn();
  const releaseAppearance = vi.fn(), registerAppearance = vi.fn(() => releaseAppearance);
  const navigationState: {value: unknown} = {value: recovery?.historyState ?? null};
  const replaceState = vi.fn((nextState: unknown, _unused: string, target: string | URL) => {
    navigationState.value = nextState;
    if (!recovery) location.hash = String(target);
    else {
      const next = new URL(String(target), location.href);
      Object.assign(location, {hash: next.hash, search: next.search, href: next.href});
    }
  });
  const historyPort = {get state() {return navigationState.value;}, replaceState};
  const addEventListener = vi.spyOn(windowEvents, 'addEventListener');
  const removeEventListener = vi.spyOn(windowEvents, 'removeEventListener');
  vi.stubGlobal('window', Object.assign(windowEvents, {
    location,
    history: historyPort,
    scrollTo: windowScrollTo,
    matchMedia: () => ({matches: false, addEventListener: mediaAdd, removeEventListener: mediaRemove}),
  }));
  vi.stubGlobal('history', historyPort);
  (globalThis as Record<string, unknown>)[TEST_KEY] = {
    config: {interfaceSkin: 'default'},
    configReady: ready,
    subscribeConfig: () => unsubscribeConfig,
    theme, skin, font, registerAppearance,
    browserCapabilities: {browser},
  };
  configureOptionsPorts((globalThis as any)[TEST_KEY]);
  let i18n: ActualUiI18n | undefined;
  let loaded: Record<string, any>;
  try {
    if (uiLanguage) {
      const [core, english, patterns] = await Promise.all([
        import('@/src/core/i18n'),
        import('@/src/core/i18n/messages/en-US'),
        import('@/src/core/i18n/messages/legacy-patterns'),
      ]);
      if (!owns(scope)) throw inactive();
      core.registerUiLanguageBundle('en-US', {messages: english.enUSMessages, legacyText: english.enUSLegacyText, legacyPatterns: patterns.createLegacyPatternSet('en-US')});
      const language = runtime.ref<UiLanguage>(uiLanguage);
      i18n = {language, t: (key, params) => core.translate(key, language.value, params), translateLegacy: text => core.translateLegacyText(text, language.value)};
      ((globalThis as Record<string, unknown>)[TEST_KEY] as {i18n?: ActualUiI18n}).i18n = i18n;
    }
    loaded = await (load ? load() : import('@/src/app/options/OptionsApp.vue'));
    if (!owns(scope)) throw inactive();
  } catch (error) {
    throw error;
  }
  const component = {...loaded.default, render: () => null};
  const renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
    patchProp: () => undefined, insert: () => undefined, remove: () => undefined,
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText: () => undefined, setElementText: () => undefined, parentNode: () => null,
    nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
    cloneNode: () => ({}), insertStaticContent: () => [{}, {}],
  });
  type SearchResult = {id: string; sectionId: string; targetId?: string; panelId?: string; label: string; searchDescription: string};
  let state!: {activeSection: string; query: string; activeItem: {id: string}; selectSection: (id: string, target?: string) => void; activePanel: string; activePanels: {id: string}[]; sectionPanels: {id: string}[]; contentComponentProps: LearningVisibilityProps & {activePanel?: string; initialTab?: string; onReload?: (tab: string) => void}; selectPanel: (id: string) => void; isGroupOpen: (index: number) => boolean; toggleGroup: (index: number) => void; settingsContentElement: {scrollTo: typeof scrollTo} | null; filteredResults: SearchResult[]; selectResult: (result: SearchResult) => Promise<void>};
  const app = renderer.createApp({
    setup: () => () => runtime.h(component, {
      ...recovery?.props,
      appearanceRoot,
      ref: (instance: any) => { if (instance) state = instance.$.setupState; },
    }),
  });
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  app.mount({});
  state.settingsContentElement = {scrollTo};
  let mounted = true;
  scope.unmount = () => { if (mounted) { mounted = false; app.unmount(); } };
  unmount = scope.unmount;
  await runtime.nextTick();
  if (!owns(scope)) throw inactive();
  const navigateHash = async (nextHash: string) => {
    location.hash = nextHash;
    windowEvents.dispatchEvent(new Event('hashchange'));
    await runtime.nextTick();
  };
  return {state, location, navigateHash, replaceState, historyPort, scrollTo, windowScrollTo, addEventListener, removeEventListener, mediaAdd, mediaRemove, unsubscribeConfig, theme, skin, font, registerAppearance, releaseAppearance, i18n};
}

describe('OptionsApp language recovery search with actual UI messages', () => {
  const englishLanguageSuffix = ['settings-translation/excluded-languages', 'settings-translation', 'settings-image-translation', 'settings-writing', 'settings-glossary'];

  it.each(['chrome', 'userscript'])('shares query work within each actual search evaluation in %s', async browser => {
    const {state} = await mountOptions('#settings-selection', Promise.resolve(), undefined, undefined, browser, 'en-US');
    // Initialize the page's existing localized computed values before counting query work.
    expect(state.filteredResults).toEqual([]);
    const readSearch = (query: string) => {
      state.query = query;
      const queryForms = new Set([query, query.trim(), query.trim().normalize('NFKC')]);
      let lowercaseCalls = 0, normalizationCalls = 0;
      const lowercase = String.prototype.toLocaleLowerCase;
      const normalize = String.prototype.normalize;
      const lowercaseSpy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function(this: string, ...args) {
        if (queryForms.has(String(this))) lowercaseCalls += 1;
        return lowercase.apply(this, args);
      });
      const normalizeSpy = vi.spyOn(String.prototype, 'normalize').mockImplementation(function(this: string, ...args) {
        if (queryForms.has(String(this))) normalizationCalls += 1;
        return normalize.apply(this, args);
      });
      try {
        const results = state.filteredResults;
        const repeatedResults = state.filteredResults;
        return {results, repeatedResults, lowercaseCalls, normalizationCalls};
      } finally {
        lowercaseSpy.mockRestore();
        normalizeSpy.mockRestore();
      }
    };
    for (const [query, expectedIds] of [
      ['Language', ['settings-general', ...englishLanguageSuffix]],
      ['OpenAI', ['settings-services', 'settings-translation-stats']],
      ['Ｌａｎｇｕａｇｅ', ['settings-general']],
      [' language ', ['settings-general', 'settings-translation', 'settings-image-translation', 'settings-writing', 'settings-glossary']],
      ['UnmatchedAbC'.repeat(10_000), []],
      ['Language', ['settings-general', ...englishLanguageSuffix]],
    ] as const) {
      const {results, repeatedResults, lowercaseCalls, normalizationCalls} = readSearch(query);
      expect(results.map(result => result.id)).toEqual(expectedIds);
      expect(repeatedResults).toBe(results);
      expect(lowercaseCalls).toBe(5);
      expect(normalizationCalls).toBe(2);
    }
    const empty = readSearch('');
    expect(empty.results).toEqual([]);
    expect(empty.lowercaseCalls).toBe(3);
    expect(empty.normalizationCalls).toBe(1);
    // Panels deliberately match the raw query, unlike trimmed navigation/control helpers.
    const space = readSearch(' ');
    expect(space.results[0].id).toBe('settings-translation-stats/overview');
    expect(space.results.at(-1)?.id).toBe('settings-data/history');
    expect(space.results.every(result => result.panelId)).toBe(true);
    expect(space.results.some(result => result.panelId === 'information-highlight')).toBe(browser === 'chrome');
    expect(space.lowercaseCalls).toBe(4);
    expect(space.normalizationCalls).toBe(1);
  });

  it('refreshes the same query when its actual language bundle arrives and reads the latest query on click', async () => {
    const scope = current!;
    const language = runtime.ref<UiLanguage>('en-US');
    const bundleRevision = runtime.ref(0);
    let core!: typeof import('../src/core/i18n');
    const {state} = await mountOptions('#settings-selection', Promise.resolve(), undefined, async () => {
      core = await import('@/src/core/i18n') as typeof import('../src/core/i18n');
      if (!owns(scope)) throw inactive();
      ((globalThis as Record<string, unknown>)[TEST_KEY] as {i18n: ActualUiI18n}).i18n = {
        language,
        // Match the production i18n context's reactive resource-arrival dependency.
        t: (key, params) => {void bundleRevision.value; return core.translate(key, language.value, params);},
        translateLegacy: text => {void bundleRevision.value; return core.translateLegacyText(text, language.value);},
      };
      return import('@/src/app/options/OptionsApp.vue');
    });
    state.query = 'Language';
    const fallback = state.filteredResults;
    expect(fallback.map(result => result.id)).toEqual(['settings-general']);
    expect(fallback[0].label).toBe('软件语言 / Language');
    const [english, patterns] = await Promise.all([
      import('@/src/core/i18n/messages/en-US'),
      import('@/src/core/i18n/messages/legacy-patterns'),
    ]);
    if (!owns(scope)) throw inactive();
    core.registerUiLanguageBundle('en-US', {messages: english.enUSMessages, legacyText: english.enUSLegacyText, legacyPatterns: patterns.createLegacyPatternSet('en-US')});
    bundleRevision.value += 1;
    expect(state.query).toBe('Language');
    expect(state.filteredResults.map(result => result.id)).toEqual(['settings-general', ...englishLanguageSuffix]);
    expect(state.filteredResults[0]).toEqual({id: 'settings-general', sectionId: 'settings-general', label: 'App language / Language', searchDescription: 'Choose the language used across FluentRead.'});
    language.value = 'zh-CN';
    expect(state.filteredResults).toEqual(fallback);
    language.value = 'en-US';
    const oldLanguageResult = state.filteredResults[0];
    state.query = 'OpenAI';
    expect(state.filteredResults.map(result => result.id)).toEqual(['settings-services', 'settings-translation-stats']);
    const querySelector = vi.fn();
    vi.stubGlobal('document', {querySelector});
    await state.selectResult(oldLanguageResult);
    expect(state.activeSection).toBe('settings-general');
    expect(state.query).toBe('');
    expect(querySelector).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'en-US'] as const)('prioritizes language aliases and focuses the existing selector in %s', async language => {
    const {state, location} = await mountOptions('#settings-selection', Promise.resolve(), undefined, undefined, 'chrome', language);
    const control = {scrollIntoView: vi.fn(), focus: vi.fn()};
    const querySelector = vi.fn(() => control);
    vi.stubGlobal('document', {querySelector});
    for (const query of ['language', 'Language', 'lang']) {
      state.query = query;
      expect(state.filteredResults.map(result => result.id)).toEqual(['settings-general', ...(language === 'en-US' ? englishLanguageSuffix : [])]);
      expect(state.filteredResults[0]).toEqual({
        id: 'settings-general', sectionId: 'settings-general',
        label: language === 'en-US' ? 'App language / Language' : '软件语言 / Language',
        searchDescription: language === 'en-US' ? 'Choose the language used across FluentRead.' : '选择流畅阅读所有界面使用的语言',
      });
      await state.selectResult(state.filteredResults[0]);
      expect(state.activeSection).toBe('settings-general');
      expect(state.query).toBe('');
      expect(location.hash).toBe('#settings-general');
      expect(querySelector).toHaveBeenLastCalledWith('[data-testid="ui-language-select"] input');
      expect(control.scrollIntoView).toHaveBeenLastCalledWith({block: 'center'});
    }
    expect(control.focus).toHaveBeenCalledTimes(3);
  });

  it('preserves non-language result content and panel/target/section ordering', async () => {
    const {state, i18n} = await mountOptions('#settings-selection', Promise.resolve(), undefined, undefined, 'chrome', 'zh-CN');
    state.query = '翻译';
    expect(state.filteredResults.map(result => result.id)).toEqual([
      'settings-translation-stats/overview', 'settings-translation/page', 'settings-translation/section-translation',
      'settings-translation/excluded-languages', 'settings-sites/rules', 'settings-video/general', 'settings-advanced/cache',
      'feature-services', 'floating-ball-toggle', 'floating-ball-settings', 'translation-sentence-highlight',
      'settings-general', 'settings-services', 'settings-translation', 'settings-interface', 'settings-selection',
      'settings-image-translation', 'settings-video', 'settings-translation-center', 'settings-sites', 'settings-translation-stats',
    ]);
    state.query = 'OpenAI';
    expect(state.filteredResults).toMatchInlineSnapshot(`
      [
        {
          "id": "settings-services",
          "label": "翻译服务",
          "searchDescription": "服务与模型",
          "sectionId": "settings-services",
        },
        {
          "id": "settings-translation-stats",
          "label": "翻译统计",
          "searchDescription": "请求规模、耗时与服务表现",
          "sectionId": "settings-translation-stats",
        },
      ]
    `);
    i18n!.language.value = 'en-US';
    expect(state.filteredResults.map(result => result.id)).toEqual(['settings-services', 'settings-translation-stats']);
    state.query = '';
    expect(state.filteredResults).toEqual([]);
  });

  it('recomputes language recovery and localized results when the UI language changes', async () => {
    const {state, i18n} = await mountOptions('#settings-selection', Promise.resolve(), undefined, undefined, 'chrome', 'zh-CN');
    state.query = 'language';
    expect(state.filteredResults.map(result => result.id)).toEqual(['settings-general']);
    expect(state.filteredResults[0].label).toBe('软件语言 / Language');
    i18n!.language.value = 'en-US';
    expect(state.filteredResults.map(result => result.id)).toEqual(['settings-general', ...englishLanguageSuffix]);
    expect(state.filteredResults[0].label).toBe('App language / Language');
    i18n!.language.value = 'zh-CN';
    expect(state.filteredResults.map(result => result.id)).toEqual(['settings-general']);
    expect(state.filteredResults[0].label).toBe('软件语言 / Language');
  });

  it('keeps language recovery available while filtering unsupported userscript controls', async () => {
    const {state, i18n} = await mountOptions('#settings-selection', Promise.resolve(), undefined, undefined, 'userscript', 'en-US');
    state.query = 'lang';
    expect(state.filteredResults.map(result => result.id)).toEqual(['settings-general', ...englishLanguageSuffix]);
    for (const language of ['en-US', 'zh-CN'] as const) {
      i18n!.language.value = language;
      for (const query of ['智能高亮', 'Smart Highlighting', '意外度', 'surprisal', '关键词']) {
        state.query = query;
        expect(state.filteredResults).toEqual([]);
      }
      expect(state.sectionPanels.map(panel => panel.id)).not.toContain('information-highlight');
    }
  });
});

describe('OptionsApp mounted hash navigation', () => {
  it('registers the explicit appearance root and releases only its returned handle once', async () => {
    const root = {} as HTMLElement;
    const {registerAppearance, releaseAppearance} = await mountOptions('#settings-interface', Promise.resolve(), root);
    expect(registerAppearance).toHaveBeenCalledWith(root);expect(releaseAppearance).not.toHaveBeenCalled();
    unmount?.();unmount = undefined;expect(releaseAppearance).toHaveBeenCalledTimes(1);
  });
  it.each(['resolve', 'reject'] as const)('ignores configReady %s after unmount instead of changing a subsequent appearance owner', async outcome => {
    let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {resolveReady = resolve;rejectReady = reject;});
    const {theme, skin, font} = await mountOptions('#settings-selection', ready);
    unmount?.();unmount = undefined;
    if (outcome === 'resolve') resolveReady();else rejectReady(new Error('closed config'));
    await runtime.nextTick();await runtime.nextTick();
    expect(theme).not.toHaveBeenCalled();expect(skin).not.toHaveBeenCalled();expect(font).not.toHaveBeenCalled();
  });
  it('cancels deferred scrolling and rejects stale navigation after unmount', async () => {
    const {state, scrollTo, location} = await mountOptions();scrollTo.mockClear();
    state.selectSection('settings-general');unmount?.();unmount = undefined;
    await runtime.nextTick();expect(scrollTo).not.toHaveBeenCalled();
    state.selectSection('settings-about');expect(location.hash).toBe('#settings-general');
  });
  it('keeps website rules continuous and uses panel metadata only to locate destinations', async () => {
    const {state} = await mountOptions('#settings-sites');
    expect(state.activePanels).toEqual([]);
    expect(state.contentComponentProps.activePanel).toBeUndefined();
    state.selectSection('settings-image-translation');
    expect(state.activePanels).toEqual([]);
    expect(state.contentComponentProps.activePanel).toBeUndefined();
  });

  it('scrolls smart-highlighting searches within the continuous form without hiding any translation groups', async () => {
    const {state} = await mountOptions('#settings-translation');
    expect(state.activePanel).toBe('reading');
    expect(state.contentComponentProps.activePanel).toBeUndefined();
    expect(state.activePanels).toEqual([]);
    expect(state.sectionPanels.map(panel => panel.id)).toEqual(expect.arrayContaining(['reading', 'information-highlight', 'hover', 'input']));
    vi.stubGlobal('MutationObserver', class {observe() {} disconnect() {}});
    vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
    Object.assign(window, {setTimeout: vi.fn(() => 1), clearTimeout: vi.fn()});
    const groups = ['reading', 'information-highlight', 'hover', 'input'].map(name => ({
      name, style: {display: ''}, getClientRects() {return this.style.display === 'none' ? [] : [{}];},
    }));
    const container = Object.assign(new EventTarget(), {
      scrollTop: 0, clientHeight: 600, firstElementChild: {},
      scrollTo: vi.fn(({top}: {top: number}) => {container.scrollTop = top;}),
      getBoundingClientRect: () => ({top: 30}),
      querySelectorAll: vi.fn((selector: string) => [{
        getClientRects: () => [{}], getBoundingClientRect: () => ({top: 530 - container.scrollTop, height: 240}),
        matches: () => selector.startsWith('[data-settings-panel'), querySelector: () => null,
      }]),
    });
    state.settingsContentElement = container;
    for (const keyword of ['智能高亮', 'Smart Highlighting', '意外度', 'surprisal', '关键词']) {
      state.query = keyword;
      expect(state.filteredResults.length).toBeGreaterThan(0);
      expect(state.filteredResults.every(result => result.panelId === 'information-highlight' || result.targetId === 'information-highlight-settings')).toBe(true);
      await state.selectResult(state.filteredResults[0]);
      expect(state.activePanel).toBe('information-highlight');
      expect(state.contentComponentProps.activePanel).toBeUndefined();
      expect(container.querySelectorAll).toHaveBeenLastCalledWith('[data-settings-panel="information-highlight"]');
      expect(container.scrollTo).toHaveBeenLastCalledWith({top: 500, behavior: 'instant'});
      expect(groups.every(group => group.getClientRects().length === 1)).toBe(true);
    }
    state.query = 'Smart Highlighting';
    await state.selectResult(state.filteredResults.find(result => result.targetId === 'information-highlight-settings')!);
    expect(container.querySelectorAll).toHaveBeenLastCalledWith('#information-highlight-settings');
    expect(container.scrollTo).toHaveBeenLastCalledWith({top: 320, behavior: 'instant'});
    state.selectSection('settings-translation', 'translation-sentence-highlight');
    expect(state.activePanel).toBe('reading');
    state.selectSection('settings-translation', 'information-highlight-settings');
    expect(state.activePanel).toBe('information-highlight');
    state.selectSection('settings-translation', 'floating-ball-settings');
    expect(state.activePanel).toBe('floating-ball');
    expect(state.contentComponentProps.activePanel).toBeUndefined();
  });

  it('excludes unsupported smart-highlighting anchors and all their search results in userscript', async () => {
    const {state} = await mountOptions('#settings-translation', Promise.resolve(), undefined, undefined, 'userscript');
    expect(state.activePanels).toEqual([]);
    expect(state.sectionPanels.map(panel => panel.id)).toContain('reading');
    expect(state.sectionPanels.map(panel => panel.id)).not.toContain('information-highlight');
    for (const keyword of ['智能高亮', 'Smart Highlighting', '意外度', 'surprisal', '关键词']) {
      state.query = keyword;
      expect(state.filteredResults).toEqual([]);
    }
    state.settingsContentElement = null;
    state.selectSection('settings-translation', 'information-highlight-settings');
    expect(state.contentComponentProps.activePanel).toBeUndefined();
    state.query = '双语逐句高亮';
    expect(state.filteredResults.some(result => result.targetId === 'translation-sentence-highlight')).toBe(true);
  });

  it('keeps userscript builds excluded even when the runtime capability port reports chrome', async () => {
    await closeFixture(current!);
    const scope: FixtureScope = {active: true};current = scope;
    vi.stubEnv('BROWSER', 'userscript');
    const {state} = await mountOptions('#settings-translation');
    expect(state.sectionPanels.map(panel => panel.id)).not.toContain('information-highlight');
    state.query = 'Smart Highlighting';expect(state.filteredResults).toEqual([]);
    state.settingsContentElement = null;
    state.selectSection('settings-translation', 'information-highlight');
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

  it('keeps a captured learning props getter current after hash navigation and return', async () => {
    const {state, navigateHash} = await mountOptions('#settings-vocabulary');
    const capturedProps = state.contentComponentProps;
    const visible = capturedProps.isVisible;
    expect(visible).toBeTypeOf('function');expect(visible!()).toBe(true);
    await navigateHash('#settings-general');
    expect(state.activeSection).toBe('settings-general');expect(visible!()).toBe(false);
    await navigateHash('#settings-vocabulary');
    expect(state.contentComponentProps).not.toBe(capturedProps);
    expect(state.contentComponentProps.isVisible).toBe(visible);expect(visible!()).toBe(true);
  });

  it('opens the general page when an initial fragment names an Object prototype member', async () => {
    const {state, location} = await mountOptions('#constructor');
    expect(state.activeSection).toBe('settings-general');
    expect(location.hash).toBe('#settings-general');
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
  expect(state.activePanel).toBe('floating-ball');
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

describe('OptionsApp actual learning-panel reload callback', () => {
  it('reloads the requested panel with the current URL and history state preserved', async () => {
    const historyState = {navigation: {owner: 'host'}, position: 4};
    const href = 'chrome-extension://fixture/embedded/options.html?existing=a%2Fb&learningTab=history&keep=two#settings-vocabulary';
    const {state, location, replaceState, historyPort} = await mountOptions('#settings-vocabulary', Promise.resolve(), undefined, undefined, 'chrome', undefined, {href, historyState});
    expect(state.activeSection).toBe('settings-vocabulary');
    expect(state.contentComponentProps.initialTab).toBe('history');
    expect(state.contentComponentProps.onReload).toBeTypeOf('function');
    expect(replaceState).not.toHaveBeenCalled();
    state.contentComponentProps.onReload!('memory');
    expect(replaceState).toHaveBeenCalledOnce();
    const [savedState, title, destination] = replaceState.mock.calls[0];
    expect(savedState).toBe(historyState);
    expect(title).toBe('');
    const next = new URL(String(destination));
    expect(next.protocol).toBe('chrome-extension:');
    expect(next.host).toBe('fixture');
    expect(next.pathname).toBe('/embedded/options.html');
    expect(next.hash).toBe('#settings-vocabulary');
    expect(next.searchParams.get('existing')).toBe('a/b');
    expect(next.searchParams.get('keep')).toBe('two');
    expect(next.searchParams.getAll('learningTab')).toEqual(['memory']);
    expect(historyPort.state).toBe(historyState);
    expect(location.href).toBe(next.href);
    expect(location.reload).toHaveBeenCalledOnce();
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(location.reload.mock.invocationCallOrder[0]);
  });

  it('reloads an internal settings mount without rewriting its host URL or history', async () => {
    const historyState = {hostRoute: 'article', position: 8};
    const href = 'https://example.test/article?siteFilter=recent&learningTab=history#host-anchor';
    const {state, location, replaceState, historyPort} = await mountOptions('#host-anchor', Promise.resolve(), undefined, undefined, 'userscript', undefined, {
      href, historyState, props: {locationRouting: 'internal', initialSection: 'settings-vocabulary'},
    });
    expect(state.activeSection).toBe('settings-vocabulary');
    expect(state.contentComponentProps.initialTab).toBe('history');
    expect(state.contentComponentProps.onReload).toBeTypeOf('function');
    state.contentComponentProps.onReload!('memory');
    expect(location.reload).toHaveBeenCalledOnce();
    expect(replaceState).not.toHaveBeenCalled();
    expect(location.href).toBe(href);
    expect(location.search).toBe('?siteFilter=recent&learningTab=history');
    expect(location.hash).toBe('#host-anchor');
    expect(historyPort.state).toBe(historyState);
  });
});

// Optional real-client parent mode: navigation, search, hash resolution and capability gates
// remain the actual Options template/setup; async feature modules are counted display ports.
type AboutClientFixture = {supportGlobal?: string};
type ClientRouteFixture = {target: string; internal?: boolean; initialSection?: string};
async function mountClientOptions(requestedSection: string, browser: 'userscript' | 'chrome' | 'firefox', about?: AboutClientFixture, route?: ClientRouteFixture, client?: {onClose: () => void}) {
  const scope = current!;
  if (!owns(scope)) throw inactive();
  vi.stubEnv('BROWSER', browser);
  vi.doMock('@/src/app/options/assets/wechat-contact.jpg', () => ({default: 'synthetic-contact-image'}));
  const [navigation, capabilities, core, english, patterns, ordinaryImages] = await Promise.all([
    import('@/src/features/settings/model/navigation'),
    vi.importActual<typeof import('@/src/platform/browser/capabilities')>('@/src/platform/browser/capabilities'),
    import('@/src/core/i18n'), import('@/src/core/i18n/messages/en-US'), import('@/src/core/i18n/messages/legacy-patterns'),
    vi.importActual<typeof import('@/src/app/options/aboutImages')>('@/src/app/options/aboutImages'),
  ]);
  if (!owns(scope)) throw inactive();
  core.registerUiLanguageBundle('en-US', {messages: english.enUSMessages, legacyText: english.enUSLegacyText, legacyPatterns: patterns.createLegacyPatternSet('en-US')});
  const {window, document} = parseHTML(about
    ? '<html lang="fr" class="host-class" style="--host-sentinel: 7" data-theme="host-theme" data-interface-skin="host-skin" data-interface-font="host-font"><head><title>Host title sentinel</title></head><body></body></html>'
    : '<html><body></body></html>');
  const hostDocumentState = () => ({title: document.title, lang: document.documentElement.getAttribute('lang'),
    attributes: Object.fromEntries(['class', 'style', 'data-theme', 'data-interface-skin', 'data-interface-font']
      .map(name => [name, document.documentElement.getAttribute(name)]))});
  const initialHostDocumentState = hostDocumentState();
  if (about) vi.stubGlobal('__FLUENTREAD_APPROVE_DATA__', about.supportGlobal);
  const images = {support: vi.fn((normalUrl: string) => ordinaryImages.getSupportImageUrl(normalUrl) as string),
    contact: vi.fn(() => ordinaryImages.getContactImageUrl() as string)};
  let dialogSlotRuns = 0;
  const dialogNotifications: {closed?: () => void} = {};
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event'])
    vi.stubGlobal(key, key === 'window' ? window : window[key as keyof typeof window]);
  const prefix = '#fluentread-userscript-settings';
  const routeSearch=route ? '?target='+encodeURIComponent(route.target) : '';
  const location = {hash: `${prefix}/${requestedSection}`, search: routeSearch, href: `https://fixture.test/article${routeSearch}${prefix}/${requestedSection}`};
  const targetQueries: string[] = [], highlightedPanels: string[] = [];
  const historyPort = {replaceState: vi.fn((_state: unknown, _title: string, target: string | URL) => {location.hash = String(target);location.href = `https://fixture.test/article${location.hash}`;})};
  const media = new Map<string, {matches: boolean; listeners: Set<() => void>; addEventListener: (_type: string, listener: () => void) => void; removeEventListener: (_type: string, listener: () => void) => void}>();
  const matchMedia = (query: string) => {
    let port = media.get(query);
    if (!port) {
      const listeners = new Set<() => void>();
      port = {matches: false, listeners, addEventListener: (_type, listener) => {listeners.add(listener);}, removeEventListener: (_type, listener) => {listeners.delete(listener);}};
      media.set(query, port);
    }
    return port;
  };
  const emitMedia = (query: string, matches: boolean) => {const port = matchMedia(query);port.matches = matches;for (const listener of [...port.listeners]) listener();};
  Object.assign(window, {location, history: historyPort, matchMedia,
    setTimeout, clearTimeout, scrollTo: vi.fn()});
  vi.stubGlobal('history', historyPort);
  window.HTMLElement.prototype.scrollTo = vi.fn();window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frames.set(++sequence, callback);return sequence;});
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const mutationCallbacks=new Set<()=>void>();
  vi.stubGlobal('MutationObserver', class {callback:()=>void;constructor(callback:()=>void){this.callback=callback;mutationCallbacks.add(callback);}observe() {} disconnect() {mutationCallbacks.delete(this.callback);}});
  vi.stubGlobal('ResizeObserver', class {observe() {} disconnect() {}});
  const language = runtime.ref<UiLanguage>('zh-CN');
  const i18n = {language, t: (key: string, params?: TranslationParams) => core.translate(key, language.value, params), translateLegacy: (text: string) => core.translateLegacyText(text, language.value)};
  const config = {interfaceSkin: 'default', theme: 'auto'}, unsubscribe = vi.fn(), loads = {settings: vi.fn(), learning: vi.fn()};
  const theme = vi.fn();
  const errors: unknown[] = [];
  const display = runtime.defineComponent({setup: () => () => runtime.h('span')});
  const anchorPort = runtime.defineComponent({emits: ['availability-change', 'navigate'], setup(_props, {expose, emit}) {
    expose({cancelPendingAnchor() {}, highlightAnchor(panel: string) {highlightedPanels.push(panel);}});
    return () => runtime.h('span', [runtime.h('button', {'data-anchor-availability': '', onClick: () => emit('availability-change', true)}, 'Show anchors'),
      runtime.h('button', {'data-anchor-navigate': '', onClick: () => emit('navigate')}, 'Navigate anchor')]);
  }});
  const settingsPort = runtime.defineComponent({name: 'SettingsDisplayPort', props: ['activeSection'], setup: props => () => runtime.h('section', {'data-settings-child': 'settings', 'data-active-section': props.activeSection}, route ? (navigation.settingsPagePanels[props.activeSection] || []).map((panel: {id: string; targetIds: readonly string[]}) => runtime.h('div', {class:'settings-page-panel', 'data-settings-panel':panel.id}, panel.targetIds.map(id=>runtime.h('div',{id},id)))) : props.activeSection)});
  const learningProps: LearningVisibilityProps[] = [];
  const learningPort = runtime.defineComponent({name: 'LearningDisplayPort', props: {isVisible: Function as runtime.PropType<() => boolean>}, setup: props => {
    // Keep the mount-time value rather than a reactive props proxy, as a pending async VNode would.
    learningProps.push({isVisible: props.isVisible});
    return () => runtime.h('section', {'data-settings-child': 'learning'}, 'Saved display port');
  }});
  configureOptionsPorts({i18n, config, configReady: Promise.resolve(), subscribeConfig: () => unsubscribe,
    browserCapabilities: capabilities.resolveBrowserCapabilities({browser, manifestVersion: browser === 'chrome' ? 3 : 2}),
    theme, skin() {}, font() {}, registerAppearance: () => () => undefined});
  vi.doMock('@/src/app/options/aboutImages', () => ({getSupportImageUrl: images.support, getContactImageUrl: images.contact}));
  vi.doMock('@/src/features/settings/ui/SettingsSections.vue', () => {loads.settings();return {__esModule: true, default: settingsPort};});
  vi.doMock('@/src/features/settings/ui/LearningCenter.vue', () => {loads.learning();return {__esModule: true, default: learningPort};});
  vi.doMock('@/src/features/settings/ui/components/SettingsSectionNavigation.vue', () => ({default: anchorPort}));
  vi.doMock('@/src/features/settings/ui/SettingsNavigationIcon.vue', () => ({default: display}));
  vi.doMock('@/src/ui/components/UiIcon.vue', () => ({default: display}));
  const {default: component} = await import('@/src/app/options/OptionsApp.vue');
  const renderer = runtime.createRenderer<Node, Element>({
    // Native DOM nodes are non-reactive; preserve that identity for LinkeDOM refs too.
    createElement: tag => {const element=runtime.markRaw(document.createElement(tag));if(route){element.getClientRects=()=>[{}] as unknown as DOMRectList;element.getBoundingClientRect=()=>({top:element.classList.contains('settings-card')?30:530-(element.closest('.settings-card')?.scrollTop||0),height:240} as DOMRect);Object.defineProperty(element,'clientHeight',{configurable:true,value:600});element.scrollTop=0;element.scrollTo=vi.fn((options?: ScrollToOptions | number)=>{element.scrollTop=typeof options==='number'?options:options?.top||0;});const queryAll=element.querySelectorAll.bind(element);element.querySelectorAll=((selector:string)=>{if(element.classList.contains('settings-card'))targetQueries.push(selector);return queryAll(selector);}) as typeof element.querySelectorAll;}return element;}, createText: text => runtime.markRaw(document.createTextNode(text)), createComment: text => runtime.markRaw(document.createComment(text)),
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor ?? null), remove: node => node.parentNode?.removeChild(node),
    setText: (node, value) => {node.nodeValue = value;}, setElementText: (element, value) => {element.textContent = value;},
    parentNode: node => node.parentNode as Element | null, nextSibling: node => node.nextSibling,
    patchProp: (element, key, _before, value) => {
      if (key.startsWith('onUpdate:')) return;
      if (/^on[A-Z]/u.test(key)) {
        const events = element as Element & {__optionsEvents?: Map<string, EventListener>};
        const name = key.slice(2).toLowerCase();events.__optionsEvents ??= new Map();
        const prior = events.__optionsEvents.get(name);if (prior) element.removeEventListener(name, prior);
        if (value) {const handler: EventListener = event => {for (const fn of Array.isArray(value) ? value : [value]) {
          if (!about) fn(event);
          else {try {fn(event);} catch (error) {errors.push(error);}}
        }};events.__optionsEvents.set(name, handler);element.addEventListener(name, handler);}
      } else if (key === 'value' && ['INPUT', 'TEXTAREA'].includes(element.tagName)) (element as HTMLInputElement).value = value ?? '';
      else if (key.startsWith('aria-') && value != null) element.setAttribute(key, String(value));
      else if (value == null || value === false) element.removeAttribute(key);
      else element.setAttribute(key, value === true ? '' : String(value));
    }, setScopeId: (element, id) => element.setAttribute(id, ''), insertStaticContent: (content, parent, anchor) => {
      const container = document.createElement('div');container.innerHTML = content;const first = container.firstChild!, last = container.lastChild!;
      for (const node of [...container.childNodes]) parent.insertBefore(node, anchor);return [first, last];
    },
  });
  const host = document.createElement('div');document.body.appendChild(host);
  const app = renderer.createApp(component, {settingsHashPrefix: browser === 'userscript' ? prefix : undefined, ...client,...(route?.internal?{locationRouting:'internal',initialSection:route.initialSection}: {})});
  if (browser !== 'userscript') location.hash = `#${requestedSection}`;
  app.component('ElDialog', about ? runtime.defineComponent({
    props: {modelValue: Boolean}, emits: ['update:modelValue', 'closed'],
    setup(props, {slots, emit}) {
      dialogNotifications.closed = () => emit('closed');
      return () => {
        // Deliberately evaluate the slot while false: hidden must not cause eager acquisition.
        dialogSlotRuns++;
        return runtime.h('section', {'data-about-dialog-port': '', 'data-model-visible': String(props.modelValue),
          'aria-hidden': String(!props.modelValue)}, [
          ...(slots.default?.() ?? []),
          runtime.h('button', {type: 'button', 'data-about-dialog-close': '',
            onClick: () => emit('update:modelValue', false)}, 'Controlled dialog close'),
        ]);
      };
    },
  }) : runtime.defineComponent({render: () => null}));
  app.config.warnHandler = () => undefined;app.config.errorHandler = error => errors.push(error);
  let mounted = false;
  scope.unmount = () => {if (mounted) {mounted = false;app.unmount();}frames.clear();host.remove();};unmount = scope.unmount;
  app.mount(host);mounted = true;
  const settle = async () => {for (let i = 0; i < 10; i++) {await Promise.resolve();await runtime.nextTick();}};
  await settle();
  if(route){for(const callback of [...mutationCallbacks])callback();await settle();}
  const rail = (section: string) => host.querySelector<HTMLButtonElement>(`button[data-section="${section}"]`)!;
  const choose = async (section: string) => {rail(section).click();await settle();};
  const navigateHash = async (section: string) => {location.hash = browser === 'userscript' ? `${prefix}/${section}` : `#${section}`;window.dispatchEvent(new window.Event('hashchange'));await settle();};
  const previewState = () => {
    const dialog = host.querySelector<HTMLElement>('[data-about-dialog-port]')!;
    const image = dialog.querySelector<HTMLImageElement>('.about-approve-preview')!;
    return {visible: dialog.getAttribute('data-model-visible'),
      kind: dialog.classList.contains('about-wechat-contact-dialog') ? 'contact' : 'support',
      title: dialog.getAttribute('title'), src: image.getAttribute('src'), alt: image.getAttribute('alt'),
      width: image.getAttribute('width'), height: image.getAttribute('height')};
  };
  const notifyDialogClosed = () => {if (!dialogNotifications.closed) throw new Error('Dialog display port is not mounted');dialogNotifications.closed();};
  return {host, loads, learningProps, errors, language, t: i18n.t, location, prefix, unsubscribe, settle, rail, choose, navigateHash, targetQueries, highlightedPanels, media, emitMedia, theme, config,
    images, previewState, notifyDialogClosed, dialogSlotEvaluations: () => dialogSlotRuns,
    hostDocumentState, initialHostDocumentState, dispose: () => scope.unmount?.(),
    search: host.querySelector<HTMLInputElement>('input[type="search"]')!};
}

describe('OptionsApp actual client navigation controls and system events', () => {
  it('passes a live visibility getter through the actual learning VNode and retains it while cached', async () => {
    const h = await mountClientOptions('settings-vocabulary', 'chrome');
    expect(h.learningProps).toHaveLength(1);
    const capturedProps = h.learningProps[0], visible = capturedProps.isVisible;
    expect(visible).toBeTypeOf('function');expect(visible!()).toBe(true);
    await h.choose('settings-general');
    expect(h.host.querySelector('[data-settings-child="learning"]')).toBeNull();expect(visible!()).toBe(false);
    await h.choose('settings-vocabulary');
    expect(h.host.querySelector('[data-settings-child="learning"]')).not.toBeNull();expect(visible!()).toBe(true);
    expect(h.learningProps).toEqual([capturedProps]);expect(h.loads.learning).toHaveBeenCalledOnce();expect(h.errors).toEqual([]);
  });

  it('collapses a navigation group, selects a mobile destination and switches its registered tab', async () => {
    const h = await mountClientOptions('settings-general', 'chrome');
    const toggle = h.host.querySelector<HTMLButtonElement>('.nav-group-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();await h.settle();expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();await h.settle();expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const mobile = h.host.querySelector<HTMLSelectElement>('.mobile-settings-navigation')!;
    Object.defineProperty(mobile, 'value', {configurable: true, value: 'settings-sites'});
    mobile.dispatchEvent(new Event('change'));await h.settle();
    expect(h.rail('settings-sites').getAttribute('aria-current')).toBe('page');
    await h.choose('settings-translation-stats');
    const usage = h.host.querySelector<HTMLButtonElement>('[data-settings-category="usage"]')!;
    usage.click();await h.settle();expect(usage.getAttribute('aria-current')).toBe('true');
    expect(h.errors).toEqual([]);
  });

  it('updates auto theme and mobile navigation through registered media listeners, then releases both', async () => {
    const h = await mountClientOptions('settings-general', 'chrome');
    const scroll = vi.spyOn(h.rail('settings-general'), 'scrollIntoView');
    h.theme.mockClear();h.emitMedia('(prefers-color-scheme: dark)', true);
    expect(h.theme).toHaveBeenLastCalledWith(true, undefined);
    h.config.theme = 'light';h.emitMedia('(prefers-color-scheme: dark)', false);
    expect(h.theme).toHaveBeenLastCalledWith(false, undefined);
    h.emitMedia('(max-width: 700px)', true);await h.settle();
    expect(scroll).toHaveBeenLastCalledWith({block: 'nearest', inline: 'center'});
    expect([...h.media.values()].map(port => port.listeners.size)).toEqual([1, 1]);
    h.dispose();h.theme.mockClear();scroll.mockClear();
    expect([...h.media.values()].map(port => port.listeners.size)).toEqual([0, 0]);
    h.emitMedia('(prefers-color-scheme: dark)', true);h.emitMedia('(max-width: 700px)', false);await h.settle();
    expect(h.theme).not.toHaveBeenCalled();expect(scroll).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
  });

  it('handles anchor availability/navigation events and the overlay close control through the template', async () => {
    const close = vi.fn();
    const h = await mountClientOptions('settings-general', 'userscript', undefined, undefined, {onClose: close});
    h.host.querySelector<HTMLButtonElement>('[data-anchor-availability]')!.click();
    await h.settle();h.host.querySelector<HTMLButtonElement>('[data-anchor-navigate]')!.click();await h.settle();
    h.host.querySelector<HTMLButtonElement>('.userscript-settings-close')!.click();
    expect(close).toHaveBeenCalledOnce();expect(h.rail('settings-general').getAttribute('aria-current')).toBe('page');expect(h.errors).toEqual([]);
  });
});

describe('OptionsApp actual client URL targets', () => {
  it.each([['settings-sites','adaptation'],['settings-sites','preview'],['settings-interface','font']])('accepts only a registered panel in current section %s/%s',async(section,panel)=>{
    const mounted=await mountClientOptions(section,'chrome',undefined,{target:panel});
    expect(mounted.host.querySelector('[data-settings-child]')?.getAttribute('data-active-section')).toBe(section);
    expect(mounted.targetQueries).toContain(`[data-settings-panel="${panel}"]`);
    expect(mounted.highlightedPanels).toContain(panel);expect(mounted.errors).toEqual([]);
    const content=mounted.host.querySelector<HTMLElement>('.settings-card')!;
    expect(content.scrollTop).toBeGreaterThan(0);expect(mounted.location.search).toBe('?target='+encodeURIComponent(panel));
  });
  it('keeps a concrete registered search destination ahead of the panel fallback',async()=>{
    const mounted=await mountClientOptions('settings-translation','chrome',undefined,{target:'floating-ball-settings'});
    expect(mounted.targetQueries).toContain('#floating-ball-settings');
    expect(mounted.targetQueries).not.toContain('[data-settings-panel="floating-ball-settings"]');
    expect(mounted.highlightedPanels).toContain('floating-ball');expect(mounted.errors).toEqual([]);
  });
  it.each(['font','floating-ball-settings','body','adaptation"] [data-private="x','__proto__'])('rejects cross-section or unregistered target %s without submitting it as CSS',async target=>{
    const mounted=await mountClientOptions('settings-sites','chrome',undefined,{target});
    expect(mounted.host.querySelector('[data-settings-child]')?.getAttribute('data-active-section')).toBe('settings-sites');
    expect(mounted.targetQueries).toEqual([]);expect(mounted.highlightedPanels).toEqual([]);
    expect(mounted.host.querySelector<HTMLElement>('.settings-card')!.scrollTop).toBe(0);expect(mounted.errors).toEqual([]);
  });
  it('keeps a capability-hidden panel unavailable to a userscript URL target',async()=>{
    const mounted=await mountClientOptions('settings-translation','userscript',undefined,{target:'information-highlight'});
    expect(mounted.targetQueries).toEqual([]);expect(mounted.highlightedPanels).toEqual([]);expect(mounted.errors).toEqual([]);
  });
  it('leaves an internal mount on its own initial section regardless of host URL section/target',async()=>{
    const mounted=await mountClientOptions('settings-sites','chrome',undefined,{target:'adaptation',internal:true,initialSection:'settings-general'});
    expect(mounted.host.querySelector('[data-settings-child]')?.getAttribute('data-active-section')).toBe('settings-general');
    expect(mounted.targetQueries).toEqual([]);expect(mounted.highlightedPanels).toEqual([]);
    expect(mounted.location.hash).toBe('#settings-sites');expect(mounted.location.search).toBe('?target=adaptation');expect(mounted.errors).toEqual([]);
  });
});

describe('OptionsApp actual client standalone capability navigation', () => {
  it.each([
    ['settings-image-translation', 'settings-image-translation'],
    ['settings-area-translation', 'settings-image-translation'],
    ['settings-video', 'settings-video'],
    ['settings-writing', 'settings-writing'],
    ['settings-translation-stats', 'settings-translation-stats'],
    ['settings-model-usage', 'settings-translation-stats'],
  ])('keeps unavailable %s public links without loading extension forms', async (requested, canonical) => {
    const h = await mountClientOptions(requested, 'userscript');
    for (const language of ['zh-CN', 'en-US'] as const) {
      h.language.value = language;await h.settle();
      const notice = h.host.querySelector('.userscript-unavailable[role="status"]')!;
      expect(notice).not.toBeNull();expect(notice.id).toBe(canonical);
      expect(notice.querySelector('h2')!.textContent).toBe(h.t('options.userscriptUnavailableTitle'));
      expect(notice.querySelector('p')!.textContent).toBe(h.t('options.userscriptUnavailableDescription'));
      expect(h.rail(canonical).getAttribute('aria-current')).toBe('page');
      expect(h.loads.settings).not.toHaveBeenCalled();expect(h.loads.learning).not.toHaveBeenCalled();
    }
    expect(h.location.hash).toBe(`${h.prefix}/${requested === 'settings-area-translation' ? canonical : requested}`);
    const label = h.rail(canonical).querySelector('strong')!.textContent!;
    h.search.value = label;h.search.dispatchEvent(new Event('input', {bubbles: true}));await h.settle();
    const result = [...h.host.querySelectorAll<HTMLButtonElement>('.search-results button')].find(button => button.querySelector('strong')?.textContent === label)!;
    expect(result).toBeDefined();result.click();await h.settle();
    expect(h.search.value).toBe('');expect(h.host.querySelector('.userscript-unavailable')).not.toBeNull();
    expect(h.loads.settings).not.toHaveBeenCalled();expect(h.loads.learning).not.toHaveBeenCalled();
    await h.choose('settings-general');
    expect(h.host.querySelector('[data-settings-child="settings"]')?.getAttribute('data-active-section')).toBe('settings-general');
    expect(h.host.querySelector('.userscript-unavailable')).toBeNull();
    for (const section of ['settings-services', 'settings-selection']) {
      await h.choose(section);expect(h.host.querySelector('[data-settings-child="settings"]')?.getAttribute('data-active-section')).toBe(section);
    }
    await h.choose('settings-vocabulary');expect(h.host.querySelector('[data-settings-child="learning"]')).not.toBeNull();
    expect(h.loads.settings).toHaveBeenCalledOnce();expect(h.loads.learning).toHaveBeenCalledOnce();
    await h.navigateHash(requested);expect(h.host.querySelector('.userscript-unavailable[role="status"]')?.id).toBe(canonical);
    expect(h.loads.settings).toHaveBeenCalledOnce();expect(h.loads.learning).toHaveBeenCalledOnce();expect(h.errors).toEqual([]);
  });

  it.each(['chrome', 'firefox'] as const)('keeps the existing extension child path callable in %s', async browser => {
    const h = await mountClientOptions('settings-image-translation', browser);
    expect(h.host.querySelector('.userscript-unavailable')).toBeNull();
    expect(h.host.querySelector('[data-settings-child="settings"]')?.getAttribute('data-active-section')).toBe('settings-image-translation');
    for (const section of ['settings-video', 'settings-writing', 'settings-translation-stats']) {
      await h.choose(section);expect(h.host.querySelector('.userscript-unavailable')).toBeNull();
      expect(h.host.querySelector('[data-settings-child="settings"]')?.getAttribute('data-active-section')).toBe(section);
    }
    expect(h.loads.settings).toHaveBeenCalledOnce();expect(h.loads.learning).not.toHaveBeenCalled();expect(h.errors).toEqual([]);
  });
});

describe('OptionsApp actual client localized sidebar brand', () => {
  // 每个平台执行真实 SFC 与六语资源，保留完整的响应式品牌恢复断言。
  // 这里只验证响应式品牌恢复，不约定 5 秒初始化性能；局部预算保留有界失败及全部语言断言。
  it.each(['userscript', 'chrome', 'firefox'] as const)('reactively restores the brand through all UI languages in %s without a legacy DOM scanner', async browser => {
    const h = await mountClientOptions('settings-general', browser);
    const bundles = await import('./helpers/uiLanguageBundles');
    bundles.registerAllUiLanguageBundles();
    const brand = () => h.host.querySelector<HTMLElement>('.brand-copy strong')!;
    expect(brand().textContent).toBe('流畅阅读');
    expect(brand().hasAttribute('data-i18n-ignore')).toBe(true);
    for (const language of ['en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      h.language.value = language;
      await h.settle();
      expect(brand().textContent).toBe('FluentRead');
      expect(brand().textContent).toBe(h.t('common.brand'));
    }
    h.language.value = 'zh-CN';
    await h.settle();
    expect(brand().textContent).toBe('流畅阅读');
    expect(h.errors).toEqual([]);
  }, 10000);
});

// Linkedom/client display-port evidence only: this is not an Element Plus animation,
// browser image decode, native focus, or JPEG-cache performance test.
describe('OptionsApp actual client lazy About image ownership', () => {
  const supportSnapshot = 'data:image/jpeg;base64,c3ludGhldGljLXNldHVwLXN1cHBvcnQ=';
  const contactPort = 'synthetic-contact-image';
  const mountAbout = (section = 'settings-general', supportGlobal?: string) =>
    mountClientOptions(section, 'userscript', {supportGlobal});
  const assertSupportSnapshot = (h: Awaited<ReturnType<typeof mountAbout>>, expected: string) => {
    expect(h.images.support).toHaveBeenCalled();
    expect(h.images.support.mock.calls.every(([url]) => url === expected)).toBe(true);
  };

  it('does not acquire either image or assign a preview src in General even when the hidden dialog slot renders', async () => {
    const h = await mountAbout();
    expect(h.dialogSlotEvaluations()).toBeGreaterThan(0);
    expect(h.previewState()).toMatchObject({visible: 'false', src: null, kind: 'support'});
    expect(h.images.support).not.toHaveBeenCalled();
    expect(h.images.contact).not.toHaveBeenCalled();
    expect(h.host.querySelector('#settings-about')).toBeNull();
    await h.choose('settings-about');
    expect(h.host.querySelector('.about-support-qr')?.getAttribute('src')).toBe('/misc/approve.jpg');
    assertSupportSnapshot(h, '/misc/approve.jpg');
    expect(h.images.contact).not.toHaveBeenCalled();
    expect(h.previewState()).toMatchObject({visible: 'false', src: null});
    expect(h.hostDocumentState()).toEqual(h.initialHostDocumentState);
    expect(h.errors).toEqual([]);
  });

  it('acquires contact only through its public button and retains the setup support snapshot across host global changes', async () => {
    const h = await mountAbout('settings-general', supportSnapshot);
    vi.stubGlobal('__FLUENTREAD_APPROVE_DATA__', 'synthetic-later-host-support');
    await h.choose('settings-about');
    expect(h.host.querySelector('.about-support-qr')?.getAttribute('src')).toBe(supportSnapshot);
    expect(h.images.contact).not.toHaveBeenCalled();
    assertSupportSnapshot(h, supportSnapshot);
    await h.choose('settings-general');
    await h.choose('settings-about');
    expect(h.images.contact).not.toHaveBeenCalled();
    const contact = h.host.querySelector<HTMLButtonElement>('button.about-wechat-contact')!;
    expect(contact.getAttribute('type')).toBe('button');
    expect(contact.getAttribute('aria-haspopup')).toBe('dialog');
    contact.click();await h.settle();
    expect(h.images.contact).toHaveBeenCalledTimes(1);
    expect(h.previewState()).toMatchObject({visible: 'true', kind: 'contact', src: contactPort,
      alt: h.t('options.aboutWechatContactCodeAlt'), width: '888', height: '1131'});
    assertSupportSnapshot(h, supportSnapshot);
    const support = h.host.querySelector<HTMLButtonElement>('button.about-support-wechat')!;
    support.click();await h.settle();
    expect(h.images.contact).toHaveBeenCalledTimes(1);
    expect(h.previewState()).toMatchObject({visible: 'true', kind: 'support', src: supportSnapshot,
      alt: h.t('popup.donationCodeAlt'), width: '1152', height: '1152'});
    support.click();await h.settle();
    expect(h.images.contact).toHaveBeenCalledTimes(1);
    expect(h.previewState().src).toBe(supportSnapshot);
    contact.click();await h.settle();
    expect(h.images.contact).toHaveBeenCalledTimes(2);
    expect(h.previewState().src).toBe(contactPort);
    assertSupportSnapshot(h, supportSnapshot);
    expect(h.hostDocumentState()).toEqual(h.initialHostDocumentState);
    expect(h.errors).toEqual([]);
  });

  it.each(['contact', 'support'] as const)('commits no preview state when the selected %s accessor throws', async selected => {
    const h = await mountAbout('settings-about', supportSnapshot);
    const previous = selected === 'contact' ? 'support' : 'contact';
    h.host.querySelector<HTMLButtonElement>(previous === 'contact' ? 'button.about-wechat-contact' : 'button.about-support-wechat')!.click();
    await h.settle();
    const before = h.previewState();
    expect(before.visible).toBe('true');expect(before.kind).toBe(previous);
    const failure = new Error(`synthetic ${selected} image restoration failed`);
    if (selected === 'contact') h.images.contact.mockImplementationOnce(() => {throw failure;});
    else h.images.support.mockImplementationOnce(() => {throw failure;});
    h.host.querySelector<HTMLButtonElement>(selected === 'contact' ? 'button.about-wechat-contact' : 'button.about-support-wechat')!.click();
    await h.settle();
    expect(h.errors).toEqual([failure]);
    expect(h.previewState()).toEqual(before);
    expect(h.hostDocumentState()).toEqual(h.initialHostDocumentState);
  });

  it.each(['contact', 'support'] as const)('retains %s preview src through close update and returns focus only at the closed notification', async selected => {
    const h = await mountAbout('settings-about', supportSnapshot);
    const trigger = h.host.querySelector<HTMLButtonElement>(selected === 'contact' ? 'button.about-wechat-contact' : 'button.about-support-wechat')!;
    const focus = vi.spyOn(trigger, 'focus').mockImplementation(() => undefined);
    trigger.click();await h.settle();
    const before = h.previewState();expect(before.visible).toBe('true');
    const contactCalls = h.images.contact.mock.calls.length;
    h.host.querySelector<HTMLButtonElement>('[data-about-dialog-close]')!.click();
    await h.settle();
    expect(h.previewState()).toEqual({...before, visible: 'false'});
    expect(focus).not.toHaveBeenCalled();
    expect(h.images.contact).toHaveBeenCalledTimes(contactCalls);
    h.notifyDialogClosed();await h.settle();
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({preventScroll: true});
    expect(h.images.contact).toHaveBeenCalledTimes(contactCalls);
    assertSupportSnapshot(h, supportSnapshot);
    expect(h.hostDocumentState()).toEqual(h.initialHostDocumentState);
    expect(h.errors).toEqual([]);
  });

  it.each(['leave-about', 'unmount'] as const)('does not restore the old trigger after %s before the delayed closed notification', async outcome => {
    const h = await mountAbout('settings-about', supportSnapshot);
    const trigger = h.host.querySelector<HTMLButtonElement>('button.about-wechat-contact')!;
    const focus = vi.spyOn(trigger, 'focus').mockImplementation(() => undefined);
    trigger.click();await h.settle();
    h.host.querySelector<HTMLButtonElement>('[data-about-dialog-close]')!.click();
    await h.settle();expect(focus).not.toHaveBeenCalled();
    if (outcome === 'leave-about') await h.choose('settings-general');
    else h.dispose();
    const supportCalls = h.images.support.mock.calls.length, contactCalls = h.images.contact.mock.calls.length;
    h.notifyDialogClosed();await h.settle();
    expect(focus).not.toHaveBeenCalled();
    expect(h.images.support).toHaveBeenCalledTimes(supportCalls);
    expect(h.images.contact).toHaveBeenCalledTimes(contactCalls);
    expect(h.hostDocumentState()).toEqual(h.initialHostDocumentState);
    expect(h.errors).toEqual([]);
  });
});

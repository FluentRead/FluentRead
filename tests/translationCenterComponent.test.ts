import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {compileStyle, parse} from 'vue/compiler-sfc';
import {parseHTML} from 'linkedom';
import * as vue from 'vue';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {translate} from '@/src/core/i18n';
import {TranslationRequestError, serializeTranslationError} from '@/src/services/translation/errors';

const filename = 'src/features/translation-center/ui/TranslationCenter.vue';
const source = readFileSync(filename, 'utf8');
const {descriptor} = parse(source, {filename});
import TranslationCenter from '@/src/features/translation-center/ui/TranslationCenter.vue';
let state: Record<string, any>, config: Config;
let requestPatch: ReturnType<typeof vi.fn>, translateText: ReturnType<typeof vi.fn>, copy: ReturnType<typeof vi.fn>;
let subscription: (next: Config) => void;
let emit: ReturnType<typeof vi.fn>, unmount: (() => void) | undefined, host: HTMLElement;
let configReady: Promise<void>;
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: vi.fn()}}}));
vi.mock('@/src/services/config/store', () => ({
  get config() {return config;}, get configReady() {return configReady;},
  subscribeConfig: (fn: typeof subscription) => {subscription = fn; return vi.fn();},
  requestConfigPatch: (...args: unknown[]) => requestPatch(...args),
}));
vi.mock('@/src/services/translation/client', () => ({translateText: (...args: unknown[]) => translateText(...args)}));
vi.mock('@/src/services/translation/capabilities', () => ({
  filterAvailableTranslationServices: (items: any[]) => items.filter(item => item.value !== 'chromeTranslator'),
  isTranslationServiceAvailable: (service: string) => service !== 'chromeTranslator',
}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({language: vue.ref('zh-CN'), translateLegacy: (value: string) => value, t: (key: string, params: any) => translate(key, 'zh-CN', params)})}));
vi.mock('element-plus', () => ({ElOption: {props: ['value', 'label'], setup: (props: any) => () => vue.h('option', {value: props.value}, props.label)}}));
vi.mock('@/src/ui/components/UiSelect.vue', () => ({default: {props: ['modelValue'], emits: ['update:modelValue', 'change', 'visible-change'], setup: (props: any, context: any) => () => vue.h('select', {
  value: props.modelValue, onFocus: () => context.emit('visible-change', true), onBlur: () => context.emit('visible-change', false),
  onChange: (event: Event) => {const value = (event.target as HTMLSelectElement).value; context.emit('update:modelValue', value); context.emit('change', value);},
}, context.slots.default?.())}}));
vi.mock('@/src/ui/components/UiIcon.vue', () => ({default: {render: () => null}}));
vi.mock('@/src/ui/components/ServiceIcon.vue', () => ({default: {render: () => null}}));
const deferred = () => {let resolve!: (text: string) => void; const promise = new Promise<string>(done => {resolve = done;}); return {promise, resolve};};
const close = () => {unmount?.(); unmount = undefined;};
beforeEach(async () => {
  config = new Config(); emit = vi.fn();
  requestPatch = vi.fn().mockResolvedValue(undefined); translateText = vi.fn().mockResolvedValue('translated'); copy = vi.fn().mockResolvedValue(undefined);
  const {document} = parseHTML('<html><body></body></html>'); document.body.style.userSelect = 'text';
  Object.assign(document, {elementFromPoint: vi.fn()});
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', {platform: 'MacIntel', clipboard: {writeText: copy}});
  vi.stubGlobal('document', document);
  configReady = Promise.resolve();
  await mountCenter();
});
async function mountCenter(surface: 'settings' | 'sidebar' = 'settings'): Promise<void> {
  const document = globalThis.document;
  const renderer = vue.createRenderer<any, any>({
    createElement: (tag, namespace) => vue.markRaw(namespace === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)),
    createText: value => document.createTextNode(value), createComment: value => document.createComment(value),
    setText: (node, value) => {node.nodeValue = value;}, setElementText: (node, value) => {node.textContent = value;},
    parentNode: node => node.parentNode, nextSibling: node => node.nextSibling,
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
    patchProp: (node, key, previous, value) => {
      if (key.startsWith('on')) {if (key.includes(':')) return; const event = key.slice(2).replace(/(?:Once|Passive|Capture)+$/, '').toLowerCase(); if (previous) node.removeEventListener(event, previous); if (value) node.addEventListener(event, value);}
      else if (key === 'style') Object.assign(node.style, value || {});
      else if (key === 'value') {if (node.tagName === 'SELECT') for (const option of node.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value); else node.value = value;}
      else if (value == null || (value === false && !key.startsWith('aria-'))) node.removeAttribute(key);
      else node.setAttribute(key, String(value));
    },
  });
  host = document.createElement('div'); document.body.appendChild(host);
  const app = renderer.createApp(TranslationCenter, {surface, 'onConfigure-service': (service: string) => emit('configure-service', service), 'onConfigure-general': () => emit('configure-general')});
  app.mount(host); state = (app as any)._instance.setupState;
  unmount = () => {app.unmount(); host.remove();};
  for (let i = 0; i < 4; i++) {await Promise.resolve(); await vue.nextTick();}
}
afterEach(() => {close(); vi.unstubAllGlobals(); vi.useRealTimers();});

describe('translation center product workflow', () => {
  it('uses a compact single column in the sidebar without changing saved comparison layout', async () => {
    close();config.translationCenterLayout = 'grid';config.translationCenterServices = ['google'];await mountCenter('sidebar');
    expect(host.querySelector('.is-sidebar')).not.toBeNull();expect(host.querySelector('.results-layout-control')).toBeNull();
    expect(host.querySelector('.translation-result-list.is-grid')).toBeNull();expect(state.resultLayout).toBe('grid');
    expect(requestPatch).not.toHaveBeenCalled();
    expect(state.cards).toHaveLength(1);expect(host.querySelector('.translation-input-meta')).toBeNull();expect(host.querySelector('#translation-input-help')).toBeNull();
    expect(host.querySelector('.translation-result-card')).toBeNull();
    state.sourceText = 'A copied paragraph';state.runTranslation();await vi.waitFor(() => expect(state.successfulCards).toHaveLength(1));
    expect(translateText.mock.calls[0][0]).toBe('A copied paragraph');
    await vue.nextTick();host.querySelector<HTMLButtonElement>('.sidebar-copy-button')!.click();await vue.nextTick();expect(copy).toHaveBeenCalledWith('translated');
    copy.mockRejectedValueOnce(new Error('clipboard unavailable'));await state.copyText('translated', state.cards[0].service);await vue.nextTick();
    expect(host.querySelector('.translation-center-feedback')?.textContent).toBe(state.ct('copyError'));
    config.on = false;subscription(config);await vue.nextTick();
    host.querySelector<HTMLButtonElement>('.translation-paused button')!.click();expect(emit).toHaveBeenCalledWith('configure-general');
    expect(host.querySelector('.translation-paused a')).toBeNull();
    expect(state.sourceText).toBe('A copied paragraph');
    state.sourceLanguage = 'fr';state.persistTranslationCenterConfig('source');
    await vi.waitFor(() => expect(state.saveState).toBe('saved'));await vue.nextTick();expect(host.querySelector('.save-status')).toBeNull();
  });
  it('shares first-use comparison defaults between the settings page and sidebar', async () => {
    const defaults = state.cards.map((card: any) => card.service);
    close();await mountCenter('sidebar');
    expect(state.cards.map((card: any) => card.service)).toEqual(defaults);
    expect(defaults).toEqual(['freeTranslation', 'google']);expect(requestPatch).not.toHaveBeenCalled();
  });
  it('translates on sidebar Enter while preserving multiline input and IME composition', async () => {
    close();config.translationCenterServices = ['google'];await mountCenter('sidebar');
    const editor = host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(editor.getAttribute('aria-describedby')).toBe('sidebar-input-help');
    expect(editor.getAttribute('title')).toContain('Shift + Enter');
    expect(host.querySelector('#sidebar-input-help')?.textContent).toContain('Shift + Enter');
    const keydown = (options: Record<string, unknown>) => {
      const event = Object.assign(new document.defaultView!.Event('keydown', {bubbles: true, cancelable: true}), {key: 'Enter'}, options);
      editor.dispatchEvent(event);return event;
    };
    state.sourceText = 'Copied text';await vue.nextTick();
    for (const options of [{shiftKey: true}, {altKey: true}, {isComposing: true}, {keyCode: 229}]) {
      expect(keydown(options).defaultPrevented).toBe(false);
    }
    expect(translateText).not.toHaveBeenCalled();
    expect(keydown({}).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(state.successfulCards).toHaveLength(1));
    expect(translateText).toHaveBeenCalledOnce();expect(translateText.mock.calls[0][0]).toBe('Copied text');
    expect(keydown({repeat: true}).defaultPrevented).toBe(true);expect(translateText).toHaveBeenCalledOnce();
    expect(keydown({ctrlKey: true}).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(translateText).toHaveBeenCalledTimes(2));
  });
  it('keeps plain Enter as a newline in settings and blocks sidebar shortcuts when unavailable or running', async () => {
    state.sourceText = 'Text';await vue.nextTick();
    const settingsEnter = Object.assign(new document.defaultView!.Event('keydown', {bubbles: true, cancelable: true}), {key: 'Enter'});
    host.querySelector('textarea')!.dispatchEvent(settingsEnter);
    expect(settingsEnter.defaultPrevented).toBe(false);expect(translateText).not.toHaveBeenCalled();
    close();config.translationCenterServices = ['openai'];await mountCenter('sidebar');state.sourceText = 'Text';
    const press = () => host.querySelector('textarea')!.dispatchEvent(Object.assign(new document.defaultView!.Event('keydown', {bubbles: true, cancelable: true}), {key: 'Enter'}));
    press();expect(translateText).not.toHaveBeenCalled();expect(state.state.run).toBe(0);
    config.translationCenterServices = ['google'];subscription(config);config.on = false;subscription(config);
    press();expect(translateText).not.toHaveBeenCalled();
    config.on = true;subscription(config);const pending = deferred();translateText.mockReturnValueOnce(pending.promise);
    press();press();expect(translateText).toHaveBeenCalledOnce();pending.resolve('translated');
    await vi.waitFor(() => expect(state.successfulCards).toHaveLength(1));
  });
  it('retains a long saved comparison list and searches, toggles and copies each provider with its model identity', async () => {
    close();
    const providers = Array.from({length: 16}, (_, index) => ({id: `custom:team-${index + 1}`, name: `Team service ${index + 1}`,
      endpoint: 'https://fixture.invalid/v1', models: [`unique-team-model-${index + 1}`]}));
    config.customOpenAIProviders = providers;config.translationCenterServices = providers.map(provider => provider.id);
    for (const provider of providers) {config.token[provider.id] = 'synthetic-fixture';config.model[provider.id] = provider.models[0];}
    await mountCenter('sidebar');
    expect(state.cards.map((card: any) => card.service)).toEqual(config.translationCenterServices);
    expect(host.querySelector('.service-picker-count')?.textContent).toBe('16');expect(host.querySelector('.translation-result-card')).toBeNull();
    expect(requestPatch).not.toHaveBeenCalled();requestPatch.mockImplementation(async patch => {Object.assign(config, patch);});await state.toggleServicePicker();
    state.serviceSearchQuery = 'unique-team-model-16';await vue.nextTick();
    const option = host.querySelector<HTMLButtonElement>('.service-picker-option')!;
    expect(host.querySelectorAll('.service-picker-option')).toHaveLength(1);expect(option.getAttribute('aria-pressed')).toBe('true');
    option.click();await vue.nextTick();expect(host.querySelector('.service-picker-count')?.textContent).toBe('15');
    expect(requestPatch.mock.calls.at(-1)![0].translationCenterServices).not.toContain('custom:team-16');
    option.click();await vue.nextTick();expect(host.querySelector('.service-picker-count')?.textContent).toBe('16');
    await vi.waitFor(() => expect(requestPatch.mock.calls.at(-1)![0].translationCenterServices).toEqual(providers.map(provider => provider.id)));
    state.closePicker(false);translateText.mockImplementation((_text: string, _title: string, options: any) => Promise.resolve(`Result from ${options.serviceOverride}`));
    state.sourceText = 'One paragraph for all selected providers';state.runTranslation();
    await vi.waitFor(() => expect(state.successfulCards).toHaveLength(16));await vue.nextTick();
    expect(host.querySelectorAll('.translation-result-card-header')).toHaveLength(16);
    expect(host.querySelector('[data-service="custom:team-16"] .translation-result-service-name small')?.textContent).toBe('unique-team-model-16');
    host.querySelector<HTMLButtonElement>('[data-service="custom:team-16"] .translation-result-content footer button')!.click();
    await vue.nextTick();expect(copy).toHaveBeenCalledWith('Result from custom:team-16');
    config.model['custom:team-16'] = 'next-model';subscription(config);await vue.nextTick();
    expect(state.staleCount).toBe(1);
    expect(host.querySelector('[data-service="custom:team-16"] .translation-result-service-name small')?.textContent).toBe('unique-team-model-16');
  });
  it('keeps compact sidebar errors and optional comparisons actionable without restoring secondary metadata', async () => {
    close();await mountCenter('sidebar');state.addService('openai');await vue.nextTick();
    expect(host.querySelector('.needs-configuration')).not.toBeNull();expect(host.querySelector('.drag-handle')).toBeNull();
    state.addService('google');state.sourceText = 'Original';state.runTranslation();
    await vi.waitFor(() => expect(state.successfulCards).toHaveLength(2));await vue.nextTick();
    expect(host.querySelectorAll('.translation-result-card-header')).toHaveLength(3);
    expect(host.querySelectorAll('.translation-result-content footer > span')).toHaveLength(0);
    expect(host.querySelectorAll('.card-connection-footer')).toHaveLength(0);
    await state.toggleServicePicker();await vue.nextTick();expect(host.querySelector('.service-picker-footer')).toBeNull();
    expect(host.querySelector('.service-picker-header p')).toBeNull();state.closePicker(false);
    requestPatch.mockRejectedValueOnce(new Error('save unavailable'));state.sourceLanguage = 'fr';state.persistTranslationCenterConfig('source');
    await vi.waitFor(() => expect(state.saveState).toBe('error'));await vue.nextTick();
    host.querySelector<HTMLButtonElement>('.translation-center-intro button')!.click();await vi.waitFor(() => expect(state.saveState).toBe('saved'));
    await vue.nextTick();host.querySelector<HTMLButtonElement>('.sidebar-clear-button')!.click();await vue.nextTick();expect(state.sourceText).toBe('');
  });
  it('stops a hidden native sidebar before Chromium can freeze it, keeping the pasted input for a retry', async () => {
    close();await mountCenter('sidebar');const pending = deferred();translateText.mockReturnValueOnce(pending.promise);
    state.sourceText = 'Copied text';state.runTranslation();await vue.nextTick();
    const signal = translateText.mock.calls[0][2].signal as AbortSignal;expect(signal.aborted).toBe(false);
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});document.dispatchEvent(new document.defaultView!.Event('visibilitychange'));expect(signal.aborted).toBe(false);
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});document.dispatchEvent(new document.defaultView!.Event('visibilitychange'));expect(signal.aborted).toBe(true);
    expect(state.sourceText).toBe('Copied text');pending.resolve('late');await vue.nextTick();expect(state.cards[0].status).toBe('cancelled');
  });

  it.each(['empty result', 'empty error'])('renders a useful error and retry control for %s', async result => {
    if (result === 'empty result') translateText.mockResolvedValueOnce('   '); else translateText.mockRejectedValueOnce(new Error(''));
    state.sourceText = 'Original'; state.retryService('google'); await vi.waitFor(() => expect(state.cards[1].status).toBe('error')); await vue.nextTick();
    const error = host.querySelector('.translation-result-error')!;
    expect(error.querySelector('p')!.textContent?.trim()).toBeTruthy();
    expect(error.textContent).toContain(state.ct(result === 'empty result' ? 'emptyResult' : 'requestError'));
    error.querySelector('button')!.dispatchEvent(new document.defaultView!.Event('click')); await vi.waitFor(() => expect(state.cards[1].status).toBe('success'));
  });
  it('visible stop and retry controls isolate individual cards and expose configuration before launch', async () => {
    const click = async (selector: string) => {const button = host.querySelector(selector)!; expect(button).toBeTruthy(); button.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await vue.nextTick(); await Promise.resolve(); await vue.nextTick();};
    state.sourceText = 'Original'; await vue.nextTick();
    const one = deferred(), two = deferred(); translateText.mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
    await click('.translate-primary-button');
    await click('[data-service="freeTranslation"] .loading-placeholder button');
    expect(state.cards[0].status).toBe('cancelled'); expect(state.cards[1].status).toBe('loading');
    await click('.translate-stop-button'); expect(state.cards[1].status).toBe('cancelled');
    one.resolve('late one'); two.resolve('late two'); await vue.nextTick();
    translateText.mockRejectedValueOnce(new Error('service unavailable'));
    await click('[data-service="freeTranslation"] .translation-result-placeholder button');
    expect(host.querySelector('.translation-result-error')?.textContent).toContain('service unavailable');
    await click('.translation-result-error button'); expect(state.cards[0].result).toBe('translated');
    state.addService('openai'); await vue.nextTick(); await click('[data-service="openai"] .needs-configuration button');
    expect(emit).toHaveBeenCalledWith('configure-service', 'openai');
  });

  it('normalizes invalid persisted languages, searches custom models and renders model identity on completed cards', async () => {
    config.translationCenterSourceLanguage = 'bad-language'; config.translationCenterTargetLanguage = 'bad-language'; subscription(config);
    expect(state.sourceLanguage).toBe('auto'); expect(state.targetLanguage).toBe('zh-Hans');
    config.translationCenterSourceLanguage = ''; config.translationCenterTargetLanguage = ''; config.from = ''; config.to = ''; subscription(config);
    expect(state.sourceLanguage).toBe('auto'); expect(state.targetLanguage).toBe('zh-Hans');
    config.customOpenAIProviders = [{id: 'custom:search', name: 'Private model service', endpoint: 'https://model.invalid/v1', models: ['unique-search-model']}];
    config.model['custom:search'] = 'unique-search-model'; config.token['custom:search'] = 'fixture-only'; config.translationCenterServices = ['custom:search']; subscription(config);
    state.serviceSearchQuery = 'unique-search-model'; expect(state.filteredServiceGroups[0].items.map((item: any) => item.value)).toContain('custom:search');
    expect(state.serviceLabel('gone-service')).toBe('gone-service'); expect(state.languageLabel('gone-language')).toContain('gone-language');
    state.sourceText = 'Original'; state.runTranslation(); await vi.waitFor(() => expect(state.cards[0].status).toBe('success')); await vue.nextTick();
    expect(host.querySelector('.translation-result-content footer')?.textContent).toContain('unique-search-model');
    state.sourceLanguage = state.targetLanguage; await vue.nextTick();
    expect(host.querySelector('.translate-primary-button')?.hasAttribute('disabled')).toBe(true);
    expect(host.querySelectorAll('.input-notice').length).toBeGreaterThan(0);
  });

  it('removes omitted stored services on save and ignores invalid drag targets and secondary pointers', async () => {
    config.translationCenterServices = ['google', 'freeTranslation', 'microsoft']; subscription(config);
    state.removeService('microsoft'); expect(requestPatch.mock.calls.at(-1)![0].translationCenterServices).toEqual(['google', 'freeTranslation']);
    const before = state.cards.map((card: any) => card.service); state.reorderCards('gone', 'google'); state.reorderCards('google', 'gone'); state.reorderCards('google', 'google');
    state.startPointerDrag('google', {button: 2, pointerId: 1}); expect(state.draggingService).toBe('');
    state.handlePointerMove({pointerId: 1, clientX: 0, clientY: 0}); state.finishPointerDrag({pointerId: 1});
    state.startPointerDrag('google', {button: 0, pointerId: 1});
    state.finishPointerDrag({pointerId: 2}); expect(state.draggingService).toBe('google');
    vi.mocked(document.elementFromPoint).mockReturnValue(host.querySelector('[data-service="google"]'));
    state.handlePointerMove({pointerId: 1, clientX: 0, clientY: 0}); expect(state.dragOverService).toBe('');
    vi.mocked(document.elementFromPoint).mockReturnValue(null); state.handlePointerMove({pointerId: 1, clientX: 0, clientY: 0});
    state.finishPointerDrag({pointerId: 1, type: 'pointerup'}); expect(state.cards.map((card: any) => card.service)).toEqual(before);
  });

  it('does not hydrate or save after closing before configuration is ready, and shows Windows shortcuts on reopen', async () => {
    close(); let ready!: () => void; configReady = new Promise<void>(resolve => {ready = resolve;});
    vi.stubGlobal('navigator', {platform: 'Win32', clipboard: {writeText: copy}}); await mountCenter();
    expect(state.shortcutLabel).toBe('Ctrl ↵'); expect(state.cards).toEqual([]);
    state.setLayout('grid'); expect(requestPatch).not.toHaveBeenCalled();
    close(); ready(); await vue.nextTick(); await vue.nextTick(); expect(state.configHydrated).toBe(false);
    state.setLayout('list'); expect(requestPatch).not.toHaveBeenCalled();
    await mountCenter(); state.sourceText = 'Original';
    state.handleEditorKeydown({key: 'Enter', metaKey: true, ctrlKey: false, isComposing: false, preventDefault: vi.fn()});
    await vi.waitFor(() => expect(state.successfulCards).toHaveLength(2));
  });

  it('ignores late clipboard and configuration settlements after unmount', async () => {
    const clipboard = deferred(), settings = deferred(); copy.mockReturnValueOnce(clipboard.promise); requestPatch.mockReturnValueOnce(settings.promise);
    const copying = state.copyText('Reviewed text', 'google'); state.setLayout('grid'); close();
    clipboard.resolve(''); settings.resolve(''); await copying; await vue.nextTick();
    expect(state.feedback).toBe(''); expect(state.saveState).toBe('idle');
  });

  it('runs the visible input, language, service-picker, card and copy controls through the actual template', async () => {
    const click = async (selector: string, parent: ParentNode = host) => {const button = parent.querySelector(selector) as HTMLButtonElement; expect(button).toBeTruthy(); expect(button.hasAttribute('disabled')).toBe(false); button.dispatchEvent(new document.defaultView!.Event('click', {bubbles: true})); await vue.nextTick(); await Promise.resolve(); await vue.nextTick();};
    const input = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {element.value = value; element.dispatchEvent(new document.defaultView!.Event('input', {bubbles: true})); await vue.nextTick();};
    await click('.example-button'); expect(state.sourceText).toContain('Good design');
    const editor = host.querySelector('textarea')!; await input(editor, 'A source to compare'); expect(state.sourceText).toBe('A source to compare');
    const select = async (id: string, value: string) => {const element = host.querySelector(id) as HTMLSelectElement;
      element.dispatchEvent(new document.defaultView!.Event('focus')); await vue.nextTick();
      for (const option of element.querySelectorAll('option')) option.toggleAttribute('selected', option.value === value);
      element.dispatchEvent(new document.defaultView!.Event('change')); await vue.nextTick();
      element.dispatchEvent(new document.defaultView!.Event('blur')); await vue.nextTick();};
    await select('#translation-center-source', 'en'); await select('#translation-center-target', 'ja');
    expect(state.sourceLanguage).toBe('en'); expect(state.targetLanguage).toBe('ja');
    await click('.language-swap-button'); expect(state.sourceLanguage).toBe('ja'); expect(state.targetLanguage).toBe('en');
    await click('.add-service-button'); expect(host.querySelector('[role="dialog"]')).toBeTruthy();
    await input(host.querySelector('.service-picker-search input')!, 'a service that cannot exist'); expect(host.querySelector('.picker-empty')).toBeTruthy();
    await input(host.querySelector('.service-picker-search input')!, '');
    const row = (service: string) => [...host.querySelectorAll('.service-picker-row')].find(node => node.querySelector('strong')?.textContent === state.serviceLabel(service))!;
    await click('.service-picker-option', row('google')); expect(state.cards.map((card: any) => card.service)).not.toContain('google');
    await click('.service-picker-option', row('google')); expect(state.cards.map((card: any) => card.service)).toContain('google');
    await click('.picker-configure', row('openai')); expect(emit).toHaveBeenCalledWith('configure-service', 'openai'); expect(host.querySelector('[role="dialog"]')).toBeNull();
    await click('.add-service-button'); await click('.service-picker-close'); expect(state.servicePickerOpen).toBe(false);
    await click('.results-layout-control button:last-child'); expect(host.querySelector('.translation-result-list')?.getAttribute('class')).toContain('is-grid');
    await click('.results-layout-control button:first-child'); expect(state.resultLayout).toBe('list');
    await click('.translate-primary-button'); await vi.waitFor(() => expect(state.successfulCards).toHaveLength(2)); await vue.nextTick();
    expect(host.querySelectorAll('.translation-result-content')).toHaveLength(2);
    await click('.translation-result-content footer button:last-child'); expect(copy).toHaveBeenLastCalledWith('translated');
    await click('.copy-all-button'); expect(copy.mock.lastCall?.[0]).toContain('translated');
    await input(editor, 'Edited source'); expect(host.querySelector('.results-stale-notice')).toBeTruthy();
    await click('.translation-result-content footer button:first-child'); await vi.waitFor(() => expect(state.successfulCards).toHaveLength(1));
    await click('.card-connection-footer button'); expect(emit).toHaveBeenCalled();
    await click('.remove-service-button'); expect(state.cards).toHaveLength(1);
    await click('.translation-input-panel .translation-panel-heading .text-button'); expect(state.sourceText).toBe('');
  });

  it('routes actual pointer and focus events to picker dismissal and card reordering, retaining the selected pointer owner', async () => {
    const dispatch = (target: EventTarget, type: string, fields: Record<string, unknown> = {}) => {const event = new document.defaultView!.Event(type, {bubbles: true, cancelable: true}); Object.assign(event, fields); target.dispatchEvent(event);};
    const open = async () => {dispatch(host.querySelector('.add-service-button')!, 'click'); await vue.nextTick();};
    await open(); dispatch(host.querySelector('.service-picker-search input')!, 'focusin'); expect(state.servicePickerOpen).toBe(true);
    dispatch(host.querySelector('textarea')!, 'focusin'); await vue.nextTick(); expect(state.servicePickerOpen).toBe(false);
    await open(); dispatch(host.querySelector('.service-picker-search input')!, 'pointerdown'); expect(state.servicePickerOpen).toBe(true);
    dispatch(document.body, 'pointerdown'); await vue.nextTick(); expect(state.servicePickerOpen).toBe(false);
    await open(); await open(); expect(state.servicePickerOpen).toBe(false);
    const cards = host.querySelectorAll('.translation-result-card');
    dispatch(cards[0].querySelector('.drag-handle')!, 'pointerdown', {button: 0, pointerId: 9});
    vi.mocked(document.elementFromPoint).mockReturnValue(cards[1]);
    dispatch(document, 'pointermove', {pointerId: 8, clientX: 10, clientY: 20}); expect(state.dragOverService).toBe('');
    dispatch(document, 'pointermove', {pointerId: 9, clientX: 10, clientY: 20}); expect(state.dragOverService).toBe('google');
    dispatch(document, 'pointerup', {pointerId: 9}); await vue.nextTick(); expect(state.cards[0].service).toBe('google'); expect(document.body.style.userSelect).toBe('text');
  });

  it('keeps a combination label and marks completed results stale after member configuration changes', async () => {
    const service = 'composite:center';
    config.compositeTranslationProviders = [{id: service, name: 'Everyday', strategy: 'sequential', services: ['google', 'microsoft'], timeoutMs: 12000}];
    config.translationCenterServices = [service]; subscription(config);
    expect(state.serviceCategory(service)).toBe('组合');
    expect(state.serviceLabel(service)).toBe('Everyday');
    state.sourceText = 'Original'; state.runTranslation(); await vue.nextTick();
    await vi.waitFor(() => expect(state.successfulCards).toHaveLength(1));
    expect(translateText.mock.calls[0][2].modelOverride).toBeUndefined();
    config.compositeTranslationProviders[0].strategy = 'smart'; subscription(config);
    expect(state.isStale(state.cards[0])).toBe(true);
    expect(state.successfulCards).toEqual([]);
    state.retryService(service); await vue.nextTick();
    await vi.waitFor(() => expect(state.successfulCards).toHaveLength(1));
    config.proxy.google = 'https://changed.example'; subscription(config);
    expect(state.isStale(state.cards[0])).toBe(true);
    state.copyAllResults(); expect(copy).not.toHaveBeenCalled();
  });
  it('starts with a small no-key selection and never changes the page default', () => {
    expect(state.cards.map((card: any) => card.service)).toEqual(['freeTranslation', 'google']);
    expect(requestPatch).not.toHaveBeenCalled(); expect(translateText).not.toHaveBeenCalled();
    expect(config.service).toBe('freeTranslation');
  });
  it('keeps stored service order and marks unconfigured items without running them', async () => {
    config.translationCenterServices = ['openai', 'google']; subscription(config);
    expect(state.cards.map((card: any) => card.service)).toEqual(['openai', 'google']);
    expect(state.cardStatus(state.cards[0])).toBe('needsConfig');
    state.sourceText = 'Original'; state.runTranslation(); await vue.nextTick();
    expect(translateText).toHaveBeenCalledOnce(); expect(translateText.mock.calls[0][2].serviceOverride).toBe('google');
  });
  it('lets AI comparison requests inherit the configured timeout and retain cancellation', async () => {
    config.translationCenterServices = ['ollama'];
    config.aiRequestTimeoutMs = 300_000;
    subscription(config);
    const pending = deferred(); translateText.mockReturnValueOnce(pending.promise);
    state.sourceText = 'A long source paragraph'; state.runTranslation(); await vue.nextTick();
    expect(translateText).toHaveBeenCalledOnce();
    const options = translateText.mock.calls[0][2];
    expect(options.serviceOverride).toBe('ollama');
    expect(options).not.toHaveProperty('timeout');
    state.session.stop();
    expect(options.signal.aborted).toBe(true);
    pending.resolve('late translation'); await vue.nextTick(); await vue.nextTick();
    expect(state.cards[0].status).toBe('cancelled');
    expect(state.cards[0].result).toBe('');
  });
  it('does not treat missing custom endpoints or models as ready even without an API key requirement', () => {
    const service = 'custom:incomplete';
    config.customOpenAIProviders = [{id: service, name: 'Incomplete', endpoint: '', models: []}];
    config.translationCenterServices = [service]; subscription(config);
    expect(state.credentialWarning(service)).toContain('接口地址');
    config.customOpenAIProviders[0].endpoint = 'http://127.0.0.1/v1'; subscription(config);
    expect(state.credentialWarning(service)).toContain('模型'); expect(state.readyCards).toEqual([]);
  });
  it('preserves results and input when cards reorder or unrelated configuration syncs', async () => {
    state.sourceText = 'Original'; state.runTranslation(); await vue.nextTick();
    await vi.waitFor(() => expect(state.cards[0].result).toBe('translated'));
    state.moveCard('freeTranslation', 1);
    await vi.waitFor(() => expect(state.cards[1].result).toBe('translated'));
    expect(requestPatch.mock.calls[0][0]).toEqual({translationCenterServices: ['google', 'freeTranslation']});
    Object.assign(config, requestPatch.mock.calls[0][0]); subscription(config);
    config.animations = false; subscription(config);
    expect(state.sourceText).toBe('Original'); await vi.waitFor(() => expect(state.successfulCards).toHaveLength(2));
  });
  it('excludes stale results from aggregate copy and snapshots language across edits', async () => {
    const pending = deferred(); translateText.mockReturnValueOnce(pending.promise);
    state.sourceText = 'Original'; state.runTranslation(); state.sourceText = 'Changed'; state.targetLanguage = 'ja';
    pending.resolve('old translation'); await vue.nextTick(); await vue.nextTick();
    expect(state.staleCount).toBe(2); expect(state.successfulCards).toEqual([]);
    state.copyAllResults(); expect(copy).not.toHaveBeenCalled();
    expect(translateText.mock.calls[0][2].targetLanguage).toBe('zh-Hans');
    expect(state.cardStatus(state.cards[0])).toBe('stale');
  });
  it('only retries unfinished items and leaves completed results intact', async () => {
    translateText.mockRejectedValueOnce(new Error('failure'));
    state.sourceText = 'Original'; state.runTranslation(); await vue.nextTick(); await vue.nextTick();
    expect(state.incompleteCards).toHaveLength(1); const kept = state.cards[1].result;
    state.retryIncomplete(); await vue.nextTick(); await vue.nextTick();
    expect(translateText).toHaveBeenCalledTimes(3); expect(state.cards[1].result).toBe(kept);
  });
  it('blocks every launch path while globally paused and resumes only on user action', async () => {
    state.sourceText = 'Original'; config.on = false; subscription(config);
    state.runTranslation(); state.retryService('google'); state.retryIncomplete();
    state.handleEditorKeydown({key: 'Enter', ctrlKey: true, isComposing: false, preventDefault: vi.fn()});
    expect(state.canTranslate).toBe(false); expect(translateText).not.toHaveBeenCalled();
    config.on = true; subscription(config);
    expect(state.canTranslate).toBe(true); expect(translateText).not.toHaveBeenCalled();
    state.runTranslation(); await vue.nextTick();
    await vi.waitFor(() => expect(state.successfulCards).toHaveLength(2));
  });
  it('global pause aborts pending cards while retaining source and completed results', async () => {
    const pending = deferred(); translateText.mockReturnValueOnce(pending.promise);
    state.sourceText = 'Original'; state.runTranslation(); await vue.nextTick();
    await vi.waitFor(() => expect(state.cards[1].result).toBe('translated'));
    config.on = false; subscription(config);
    expect(translateText.mock.calls[0][2].signal.aborted).toBe(true);
    expect(state.cards[0].status).toBe('cancelled'); expect(state.cards[1].status).toBe('success');
    pending.resolve('late'); await vue.nextTick(); await vue.nextTick();
    expect(state.cards[0].result).toBe(''); await vi.waitFor(() => expect(state.cards[1].result).toBe('translated'));
    expect(state.sourceText).toBe('Original');
    config.on = true; subscription(config); expect(translateText).toHaveBeenCalledTimes(2);
  });
  it('treats a backend pause arriving before storage sync as cancellation for all pending cards', async () => {
    const pending = deferred();
    translateText.mockRejectedValueOnce(new TranslationRequestError(serializeTranslationError({message: 'paused', code: 'TRANSLATION_DISABLED', retryable: false}))).mockReturnValueOnce(pending.promise);
    state.sourceText = 'Original'; state.runTranslation(); await vue.nextTick(); await vue.nextTick();
    expect(state.translationEnabled).toBe(false); expect(state.isRunning).toBe(false);
    expect(state.cards.every((card: any) => card.status === 'cancelled' && !card.error)).toBe(true);
    expect(translateText.mock.calls[1][2].signal.aborted).toBe(true);
    pending.resolve('late'); await vue.nextTick(); expect(state.cards[1].result).toBe('');
  });
  it('stops work on clear and never accepts a late completion', async () => {
    const pending = deferred(); translateText.mockReturnValueOnce(pending.promise);
    state.sourceText = 'Original'; state.runTranslation(); state.clearSource();
    pending.resolve('late'); await vue.nextTick();
    expect(state.sourceText).toBe(''); expect(state.cards[0].status).toBe('cancelled'); expect(state.cards[0].result).toBe('');
  });
  it('guards empty text, oversized text, identical languages and IME composition', () => {
    state.runTranslation(); state.sourceText = 'x'.repeat(5001); state.runTranslation();
    state.sourceText = 'Original'; state.sourceLanguage = 'en'; state.targetLanguage = 'en'; state.runTranslation();
    state.targetLanguage = 'ja'; const preventDefault = vi.fn();
    state.handleEditorKeydown({key: 'Enter', ctrlKey: true, metaKey: false, isComposing: true, preventDefault});
    expect(translateText).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
    state.handleEditorKeydown({key: 'Enter', ctrlKey: true, metaKey: false, isComposing: false, preventDefault});
    expect(translateText).toHaveBeenCalledTimes(2); expect(preventDefault).toHaveBeenCalledOnce();
  });
  it('saves layout independently, keeps unavailable providers and normalizes old configs', () => {
    config.translationCenterServices = ['chromeTranslator', 'google']; subscription(config);
    state.addService('freeTranslation');
    expect(requestPatch.mock.calls[0][0]).toEqual({translationCenterServices: ['chromeTranslator', 'google', 'freeTranslation']});
    state.setLayout('grid'); expect(requestPatch.mock.calls[1][0]).toEqual({translationCenterLayout: 'grid'});
    expect(normalizeConfig({translationCenterLayout: 'invalid'}).translationCenterLayout).toBe('list');
    expect(normalizeConfig({translationCenterLayout: 'grid'}).translationCenterLayout).toBe('grid');
    expect(new Config().translationCenterLayout).toBe('list');
  });
  it('does not translate on service selection, enforces a final service, and delegates configuration', () => {
    state.toggleService('openai'); expect(state.cards).toHaveLength(3); expect(translateText).not.toHaveBeenCalled();
    state.toggleService('openai'); state.removeService('google'); state.removeService('freeTranslation'); expect(state.cards).toHaveLength(1);
    state.configureService('openai'); expect(emit).toHaveBeenCalledWith('configure-service', 'openai');
    expect(requestPatch.mock.calls.every((call: any[]) => !Object.hasOwn(call[0], 'service'))).toBe(true);
  });
  it('retries failed saves with the latest field values and exposes clipboard failures', async () => {
    requestPatch.mockRejectedValueOnce(new Error('storage unavailable'));
    state.setLayout('grid'); await vue.nextTick(); await vue.nextTick(); expect(state.saveState).toBe('error');
    state.retrySave(); await vue.nextTick(); expect(requestPatch.mock.calls[1][0]).toEqual({translationCenterLayout: 'grid'}); expect(state.saveState).toBe('saved');
    copy.mockRejectedValueOnce(new Error('clipboard denied')); await state.copyText('text', 'a'); expect(state.feedback).toContain('复制失败');
  });
  it('restores preexisting text selection styles and treats pointer cancel as no reorder', () => {
    state.startPointerDrag('freeTranslation', {button: 0, pointerId: 2}); state.dragOverService = 'google';
    expect(document.body.style.userSelect).toBe('none'); state.finishPointerDrag({pointerId: 2, type: 'pointercancel'});
    expect(document.body.style.userSelect).toBe('text'); expect(state.cards[0].service).toBe('freeTranslation');
  });
  it('cancels dragging on window blur and removes the blur listener on disposal', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    state.startPointerDrag('freeTranslation', {button: 0, pointerId: 2}); state.dragOverService = 'google';
    window.dispatchEvent(new Event('blur'));
    expect(document.body.style.userSelect).toBe('text');
    expect(state.draggingService).toBe('');
    expect(state.cards[0].service).toBe('freeTranslation');
    expect(requestPatch).not.toHaveBeenCalled();
    state.startPointerDrag('google', {button: 0, pointerId: 3});
    close();
    expect(document.body.style.userSelect).toBe('text');
    expect(remove).toHaveBeenCalledWith('blur', state.endCardDrag);
  });
  it('receives model updates during dragging and reconciles deferred order after cancellation', () => {
    state.startPointerDrag('freeTranslation', {button: 0, pointerId: 2});
    config.translationCenterServices = ['google', 'openai']; config.model.openai = 'custom-model'; config.token.openai = 'fixture-only'; subscription(config);
    expect(state.cards[0].service).toBe('freeTranslation'); expect(state.serviceModel('openai')).toBe('custom-model');
    state.finishPointerDrag({pointerId: 2, type: 'pointercancel'});
    expect(state.cards.map((card: any) => card.service)).toEqual(['google', 'openai']);
  });
  it('preserves user intent across storage rollback and unrelated later save success', async () => {
    let rejectLayout!: (reason: Error) => void;
    requestPatch.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectLayout = reject;}));
    state.setLayout('grid');
    subscription(config); // 后台失败前回读旧快照，不得抹掉待保存的用户选择。
    expect(state.resultLayout).toBe('grid');
    state.targetLanguage = 'ja'; state.persistTranslationCenterConfig('target'); await vue.nextTick();
    rejectLayout(new Error('storage failed')); await vue.nextTick(); await vue.nextTick();
    expect(state.saveState).toBe('error'); expect(state.resultLayout).toBe('grid');
    state.retrySave(); await vue.nextTick();
    expect(requestPatch.mock.calls[2][0]).toEqual({translationCenterLayout: 'grid'});
  });
  it('a newer edit to the same field wins over a delayed failed save', async () => {
    let rejectOld!: (reason: Error) => void;
    requestPatch.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectOld = reject;}));
    state.targetLanguage = 'ja'; state.persistTranslationCenterConfig('target');
    state.targetLanguage = 'fr'; state.persistTranslationCenterConfig('target'); await vue.nextTick();
    rejectOld(new Error('old failed')); await vue.nextTick(); await vue.nextTick();
    expect(state.saveState).not.toBe('error'); expect(state.targetLanguage).toBe('fr');
  });
  it('protects user content from legacy localization and provides persistent layout controls', () => {
    expect(source).toContain('<p data-i18n-ignore>{{ card.result }}</p>');
    expect(source).toContain('v-model="sourceText" data-i18n-ignore');
    expect(source).toContain('event.isComposing'); expect(source).toContain('prefers-reduced-motion');
    expect(source).toContain('aria-pressed="resultLayout');
    const css = compileStyle({source: descriptor.styles[0].content, filename, id: 'data-v-center-test', scoped: true}).code;
    expect(css).toContain(':root.dark .translation-center .translate-primary-button');
    expect(css).not.toMatch(/:root\.dark\s*\{/);
  });

  it('保留与原文相同的服务结果，单项及全部复制均可用', async () => {
    state.sourceText = 'Original'; translateText.mockResolvedValue('  Original  ');
    state.runTranslation(); await vi.waitFor(() => expect(state.cards.every((card: any) => card.status === 'success')).toBe(true));
    expect(state.successfulCards).toHaveLength(state.cards.length);
    expect(state.cards.every((card: any) => card.result === 'Original')).toBe(true);
    state.copyResult(state.cards[0]); expect(copy).toHaveBeenLastCalledWith('Original');
    state.copyAllResults(); expect(copy.mock.lastCall?.[0].match(/Original/g)).toHaveLength(state.cards.length);
    state.sourceText = 'A newer source';
    expect(state.successfulCards).toEqual([]);
  });
});

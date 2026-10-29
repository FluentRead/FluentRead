import {materialPageFixture} from './helpers/materialPageFixture';
import * as runtime from 'vue';
import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import LearningCenter from '@/src/features/settings/ui/LearningCenter.vue';
import MaterialWorkspace from '@/src/features/vocabulary/ui/MaterialWorkspace.vue';
import type {MaterialRecord} from '@/src/features/vocabulary/materialProtocol';

// Render the actual parent and material pane. The outer KeepAlive has the same
// lifetime shape as OptionsApp; this is not a full OptionsApp or browser test.
const KEY = '__fluentreadMaterialKeepAliveTest';
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const stop of disposers.splice(0).reverse()) stop();
  delete (globalThis as any)[KEY];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
const record = (id = 'a'): MaterialRecord => ({
  id, identityKey: `article:https://example.test/${id}`, kind: 'article', title: `Article ${id}`,
  source: {kind: 'article', url: `https://example.test/${id}`},
  locator: {kind: 'text', quote: 'A retained source sentence.'}, topics: ['Design'],
  references: [{kind: 'note', id: 'note-1', note: 'A retained personal thought.'}],
  createdAt: 1, updatedAt: 2, lastReadAt: 2, archivedAt: null,
});
vi.mock('@/src/features/vocabulary/materialClient', () => Object.fromEntries([
  'materialList', 'materialCapture', 'materialUpdate', 'materialArchive', 'materialRestore',
  'materialRemoveReference', 'materialClear', 'materialExport', 'materialImport', 'materialGeneration',
  'workspaceMaterialCapture','workspaceMaterialUpdate','workspaceMaterialArchive','workspaceMaterialRestore','workspaceMaterialRemoveReference',
].map(name => [name, (...args: unknown[]) => (globalThis as any).__fluentreadMaterialKeepAliveTest.api[name.replace('workspaceMaterial','material')](...args)])));
vi.mock('@/src/features/vocabulary/materialPageClient', async () => ({
  MaterialPageClientError: (await import('./helpers/materialPageFixture')).FixturePageError,
  requestMaterialPage: (...args: any[]) => (globalThis as any).__fluentreadMaterialKeepAliveTest.pages.page(...args),
  requestMaterialDetail: (...args: any[]) => (globalThis as any).__fluentreadMaterialKeepAliveTest.pages.detail(...args),
  requestMaterialTopics: (...args: any[]) => (globalThis as any).__fluentreadMaterialKeepAliveTest.pages.topics(...args),
}));
vi.mock('webextension-polyfill', () => ({default: {get runtime() {return (globalThis as any).__fluentreadMaterialKeepAliveTest.browser.runtime;}}}));
vi.mock('@/src/features/reading-assistant/public', () => ({
  getHarnessSession: (...args: unknown[]) => (globalThis as any).__fluentreadMaterialKeepAliveTest.getSession(...args),
  listLearningMemories: (...args: unknown[]) => (globalThis as any).__fluentreadMaterialKeepAliveTest.memories(...args),
}));
vi.mock('@/src/features/reading-assistant/ui/answer/public', () => ({ReadingAnswer: {render: () => null}}));
vi.mock('@/src/ui/dateFormat', () => ({useRenderDateFormatter: () => () => '10/24'}));
vi.mock('@/src/services/config/store', () => ({
  config: {harness: {memoryEnabled: false}}, configReady: Promise.resolve(), subscribeConfig: () => () => {},
}));
vi.mock('@/src/platform/browser/capabilities', () => ({browserCapabilities: {browser: 'chrome'}}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({language: runtime.ref('zh-CN'), t: (key: string) => key})}));
vi.mock('@/src/features/vocabulary/ui/public', async () => {
  const component = (await import('@/src/features/vocabulary/ui/MaterialWorkspace.vue')).default;
  return {
    VocabularyBook: {render: () => runtime.h('section', {'data-saved-pane': ''}, 'Saved pane')},
    // LearningCenter's real import(...).then(module => module.MaterialWorkspace)
    // assimilates this optional promise. Only async-export delivery is gated;
    // the eventual pane and parent loader remain the production components.
    get MaterialWorkspace() {return (globalThis as any).__fluentreadMaterialKeepAliveTest?.materialModule || component;},
  };
});

async function mount(options: {
  useParentVisibility?: boolean;
  items?: MaterialRecord[];
  list?: (...args: any[]) => Promise<MaterialRecord[]>;
  session?: (...args: any[]) => Promise<unknown>;
  memories?: () => Promise<unknown[]>;
  materialGate?: ReturnType<typeof deferred<unknown>>;
  learningGate?: ReturnType<typeof deferred<unknown>>;
} = {}) {
  let items = options.items || [record(), record('b')];
  const listeners = new Set<(message: unknown) => unknown>();
  const api = {
    materialList: vi.fn(options.list || (async () => structuredClone(items))),
    materialUpdate: vi.fn(async (id: string, patch: any) => {
      const updated = {...items.find(item => item.id === id)!, ...patch};
      items = items.map(item => item.id === id ? updated : item);
      return structuredClone(updated);
    }),
    materialCapture: vi.fn(async () => structuredClone(items[0])),
    materialArchive: vi.fn(async () => record()), materialRestore: vi.fn(async () => record()),
    materialRemoveReference: vi.fn(async () => record()), materialClear: vi.fn(async () => true),
    materialExport: vi.fn(async () => ({format: 'fluentread-learning-materials', version: 1, materials: items})),
    materialImport: vi.fn(async () => ({inserted: 0, updated: 0, skipped: 0})),
    materialGeneration: vi.fn(async () => 0),
  };
  const getSession = vi.fn(options.session || (async () => null));
  const memories = vi.fn(options.memories || (async () => []));
  const addListener = vi.fn((listener: (message: unknown) => unknown) => listeners.add(listener));
  const removeListener = vi.fn((listener: (message: unknown) => unknown) => listeners.delete(listener));
  (globalThis as any)[KEY] = {api, pages:materialPageFixture(api), getSession, materialModule: options.materialGate?.promise, memories, browser: {runtime: {
    getURL: (path: string) => `chrome-extension://fixture/${path}`,
    sendMessage: async () => ({success: true, data: null}), onMessage: {addListener, removeListener},
  }}};
  const {window, document} = parseHTML('<html><body><main></main></body></html>');
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement'])
    vi.stubGlobal(key, key === 'window' ? window : key === 'document' ? document : (window as any)[key]);
  let focused: Element = document.body;
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused});
  const focus = vi.spyOn(window.HTMLElement.prototype, 'focus').mockImplementation(function(this: HTMLElement) {focused = this;});
  const renderer = runtime.createRenderer<any, any>({
    createElement: (tag, ns) => runtime.markRaw(ns === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag)),
    createText: text => document.createTextNode(text), createComment: text => document.createComment(text),
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor || null), remove: node => node.remove(),
    setText: (node, text) => {node.nodeValue = text;}, setElementText: (node, text) => {node.textContent = text;},
    parentNode: node => node.parentNode, nextSibling: node => node.nextSibling, setScopeId: (node, id) => node.setAttribute(id, ''),
    patchProp(node, key, old, value) {
      if (/^on[A-Z]/u.test(key)) {const event = key.slice(2).toLowerCase(); if (old) node.removeEventListener(event, old); if (value) node.addEventListener(event, value);}
      else if (key === 'value') {node._value = value; if (node.tagName !== 'SELECT') node.value = value ?? '';}
      else if (key === 'style') Object.assign(node.style, value || {});
      else if (value == null || key === 'disabled' && value === false) node.removeAttribute(key);
      else node.setAttribute(key, String(value));
    },
    insertStaticContent(html, parent, anchor) {const box = document.createElement('div'); box.innerHTML = html; const first = box.firstChild!, last = box.lastChild!; while (box.firstChild) parent.insertBefore(box.firstChild, anchor || null); return [first, last];},
  });
  const shown = runtime.ref(true), otherPage = {render: () => runtime.h('aside', {'data-other-options-page': ''}, 'Other options page')};
  const LearningEntry = runtime.defineAsyncComponent(() => options.learningGate ? options.learningGate.promise as Promise<any> : Promise.resolve(LearningCenter));
  const isVisible = () => shown.value;
  let panel: any;
  const app = renderer.createApp({render: () => runtime.h(runtime.KeepAlive, null, {default: () => shown.value
    ? runtime.h(LearningEntry, {initialTab: 'materials', key: 'learning', ...(options.useParentVisibility === false ? {} : {isVisible})}) : runtime.h(otherPage, {key: 'settings'})})});
  app.mixin({mounted() {const instance = this as any; if (instance.$options.__name?.startsWith('MaterialWorkspace')) panel = instance.$.setupState;}});
  const errors: unknown[] = [];
  app.config.errorHandler = error => errors.push(error);
  app.mount(document.querySelector('main')!);
  let alive = true;
  const unmount = () => {if (alive) {alive = false; app.unmount();}};
  disposers.push(unmount);
  const flush = async () => {for (let index = 0; index < 15; index++) {await Promise.resolve(); await runtime.nextTick();}};
  if (!options.materialGate && !options.learningGate) await vi.waitFor(() => expect(panel).toBeDefined());
  await flush();
  return {
    get panel() {return panel;}, api, getSession, memories, addListener, removeListener, listeners, focus, errors,
    document, window, shown, flush, unmount,
    hide: async () => {shown.value = false; await flush();},
    show: async () => {shown.value = true; await flush();},
    notify: (count = 1) => {for (let index = 0; index < count; index++) for (const listener of listeners) listener({type: 'fluentReadMaterialsChanged'});},
    setItems: (next: MaterialRecord[]) => {items = next;},
  };
}
type Harness = Awaited<ReturnType<typeof mount>>;
async function click(ui: Harness, target: Element | null) {
  expect(target).not.toBeNull();
  target!.dispatchEvent(new ui.window.Event('click', {bubbles: true}));
  await ui.flush();
}
function button(ui: Harness, text: string) {return [...ui.document.querySelectorAll('button')].find(item => item.textContent?.trim() === text) || null;}

describe('actual learning-center material pane under an outer KeepAlive', () => {
  it('uses the live parent visibility getter when LearningCenter itself arrives after navigation away', async () => {
    const gate = deferred<unknown>(), ui = await mount({learningGate: gate});
    expect(ui.panel).toBeUndefined(); expect(ui.api.materialList).not.toHaveBeenCalled();
    await ui.hide(); gate.resolve(LearningCenter);
    await vi.waitFor(() => expect(ui.panel).toBeDefined()); await ui.flush();
    expect(ui.document.querySelector('.fr-materials')).toBeNull();
    expect(ui.api.materialList).not.toHaveBeenCalled();
    await ui.show();
    expect(ui.document.querySelector('.fr-materials')).not.toBeNull();
    expect(ui.api.materialList).toHaveBeenCalledTimes(1);
    expect(ui.errors).toEqual([]);
  });

  it('starts no list IO when the async material export arrives after its real parent is hidden', async () => {
    const gate = deferred<unknown>(), ui = await mount({materialGate: gate});
    expect(ui.panel).toBeUndefined(); expect(ui.api.materialList).not.toHaveBeenCalled();
    await ui.hide();
    gate.resolve(MaterialWorkspace);
    await vi.waitFor(() => expect(ui.panel).toBeDefined()); await ui.flush();
    expect(ui.document.querySelector('.fr-materials')).toBeNull();
    expect(ui.api.materialList).not.toHaveBeenCalled();
    await ui.show();
    expect(ui.document.querySelector('.fr-materials')).not.toBeNull();
    expect(ui.api.materialList).toHaveBeenCalledTimes(1);
    expect(ui.addListener).toHaveBeenCalledTimes(1);
    expect(ui.errors).toEqual([]);
  });

  it('reopens the released session after a clean hidden round trip', async () => {
    const ui = await mount(), owner = ui.panel;
    expect(ui.api.materialList).toHaveBeenCalledTimes(1);
    await ui.hide();
    expect(ui.document.querySelector('.fr-materials')).toBeNull();
    expect(ui.document.querySelector('[data-other-options-page]')).not.toBeNull();
    expect(ui.removeListener).not.toHaveBeenCalled();
    await ui.show();
    expect(ui.panel).toBe(owner);
    expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    expect(ui.errors).toEqual([]);
  });

  it.each([true, false])('coalesces five hidden broadcasts into one current read on reactivation (parent visibility getter: %s)', async useParentVisibility => {
    const ui = await mount({useParentVisibility});
    await ui.hide();
    ui.setItems([{...record('b'), title: 'Changed while another settings page was open'}]);
    ui.notify(5); await ui.flush();
    expect(ui.api.materialList).toHaveBeenCalledTimes(1);
    expect(ui.panel.materials.map((item: MaterialRecord) => item.id)).toEqual(['a', 'b']);
    await ui.show();
    expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    expect(ui.panel.materials.map((item: MaterialRecord) => item.title)).toEqual(['Changed while another settings page was open']);
    await ui.hide(); await ui.show();
    expect(ui.api.materialList).toHaveBeenCalledTimes(3);
    expect(ui.addListener).toHaveBeenCalledTimes(1);
  });

  it('coalesces broadcasts received during an already running visible list read', async () => {
    const first = deferred<MaterialRecord[]>(); let reads = 0;
    const ui = await mount({list: () => ++reads === 1 ? first.promise : Promise.resolve([{...record('b'), title: 'Current after broadcasts'}])});
    ui.notify(5); await ui.flush();
    expect(ui.api.materialList).toHaveBeenCalledTimes(1);
    first.resolve([record('a')]); await ui.flush();
    expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    expect(ui.panel.materials.map((item: MaterialRecord) => item.title)).toEqual(['Current after broadcasts']);
    expect(ui.panel.loading).toBe(false);
  });

  it('uses actual inner-tab unmount to release the material subscription', async () => {
    const ui = await mount();
    await ui.hide(); ui.notify(3); await ui.show();
    expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    await click(ui, ui.document.querySelector('[data-option-index="0"]'));
    expect(ui.document.querySelector('.fr-materials')).toBeNull();
    expect(ui.document.querySelector('[data-saved-pane]')).not.toBeNull();
    expect(ui.removeListener).toHaveBeenCalledTimes(1);
    expect(ui.listeners.size).toBe(0);
    ui.notify(5); await ui.flush();
    expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    await click(ui, ui.document.querySelector('[data-option-index="1"]'));
    await vi.waitFor(() => expect(ui.api.materialList).toHaveBeenCalledTimes(3));
    expect(ui.addListener).toHaveBeenCalledTimes(2);
    expect(ui.listeners.size).toBe(1);
  });

  it('retains selection, filters, both page limits and independent cached drafts across hidden refresh', async () => {
    const items = Array.from({length: 35}, (_, index) => ({...record(String(index)), references: Array.from({length: 25}, (_, note) => ({kind: 'note' as const, id: `note-${note}`, note: `Thought ${note}`}))}));
    const ui = await mount({items});
    ui.panel.query = 'Article'; ui.panel.topic = 'Design'; await vi.waitFor(() => expect(ui.api.materialList).toHaveBeenCalledTimes(2)); await ui.flush();
    await click(ui, button(ui, '显示更多材料（30 / 35）'));
    await ui.panel.select('1'); ui.panel.note = 'Cached other note'; ui.panel.startEdit(); ui.panel.draft.title = 'Cached other title';
    await ui.panel.select('0'); ui.panel.editNote(items[0].references[0]); ui.panel.note = 'Active unfinished note'; ui.panel.startEdit(); ui.panel.draft.title = 'Active unfinished title';
    await ui.flush(); await click(ui, button(ui, '显示更多学习内容'));
    const before = {selectedId: ui.panel.selectedId, query: ui.panel.query, topic: ui.panel.topic, materials: ui.panel.materials.length, references: ui.panel.selected.references.length};
    await ui.hide(); ui.notify(5); await ui.show();
    await vi.waitFor(() => expect(ui.api.materialList).toHaveBeenCalledTimes(3)); await ui.flush();
    expect({selectedId: ui.panel.selectedId, query: ui.panel.query, topic: ui.panel.topic, materials: ui.panel.materials.length, references: ui.panel.selected.references.length}).toEqual(before);
    expect(before).toEqual({selectedId: '0', query: 'Article', topic: 'Design', materials: 35, references: 25});
    expect(ui.panel.note).toBe('Active unfinished note'); expect(ui.panel.editingNoteId).toBe('note-0');
    expect(ui.panel.editing).toBe(true); expect(ui.panel.draft.title).toBe('Active unfinished title');
    await ui.panel.select('1');
    expect(ui.panel.note).toBe('Cached other note'); expect(ui.panel.draft.title).toBe('Cached other title');
    expect(ui.api.materialList).toHaveBeenCalledTimes(3);
  });

  it.each(['resolve-hidden', 'resolve-after-resume'] as const)('isolates an obsolete pending list without a broadcast when it will %s', async when => {
    const old = deferred<MaterialRecord[]>(), fresh = deferred<MaterialRecord[]>();
    let reads = 0;
    const ui = await mount({list: () => ++reads === 1 ? old.promise : fresh.promise});
    expect(ui.panel.loading).toBe(true);
    await ui.hide();
    if (when === 'resolve-hidden') {old.resolve([{...record('a'), title: 'Obsolete hidden response'}]); await ui.flush(); expect(ui.panel.materials).toEqual([]);}
    await ui.show();
    expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    fresh.resolve([{...record('b'), title: 'Current response'}]); await ui.flush();
    if (when === 'resolve-after-resume') {old.resolve([{...record('a'), title: 'Obsolete hidden response'}]); await ui.flush();}
    expect(ui.panel.materials.map((item: MaterialRecord) => item.title)).toEqual(['Current response']);
    expect(ui.panel.loading).toBe(false); expect(ui.panel.error).toBe('');
  });

  it('does not publish a hidden stale read failure and retries the invalidated read on resume', async () => {
    const old = deferred<MaterialRecord[]>(); let reads = 0;
    const ui = await mount({list: () => ++reads === 1 ? old.promise : Promise.resolve([record('b')])});
    await ui.hide(); old.reject(new Error('An obsolete read failed')); await ui.flush();
    expect(ui.panel.error).toBe('');
    await ui.show();
    expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    expect(ui.panel.materials.map((item: MaterialRecord) => item.id)).toEqual(['b']);
    expect(ui.panel.loading).toBe(false);
  });

  it.each(['resolve-hidden', 'resolve-after-resume'] as const)('isolates obsolete reference results that %s and refreshes the same selected detail', async when => {
    const old = deferred<unknown>(), fresh = deferred<unknown>(); let reads = 0;
    const ui = await mount({items: [{...record(), references: [{kind: 'session', id: 's1'}]}], session: () => ++reads === 1 ? old.promise : fresh.promise});
    await ui.panel.select('a'); expect(ui.getSession).toHaveBeenCalledTimes(1);
    await ui.hide();
    if (when === 'resolve-hidden') {old.resolve({id: 's1', text: 'Obsolete answer', turns: []}); await ui.flush(); expect(ui.panel.resolved['session:s1']).toBeUndefined();}
    await ui.show();
    expect(ui.getSession).toHaveBeenCalledTimes(2);
    fresh.resolve({id: 's1', text: 'Current answer', turns: []}); await ui.flush();
    if (when === 'resolve-after-resume') {old.resolve({id: 's1', text: 'Obsolete answer', turns: []}); await ui.flush();}
    expect(ui.panel.selectedId).toBe('a');
    expect(ui.panel.resolved['session:s1'].session.text).toBe('Current answer');
    expect(ui.panel.detailLoading).toBe(false);
  });

  it('does not fan out new reference IO after an old memory-list wait finishes while hidden', async () => {
    const old = deferred<unknown[]>(); let reads = 0;
    const ui = await mount({
      items: [{...record(), references: [{kind: 'memory', id: 'm1'}, {kind: 'session', id: 's1'}]}],
      memories: () => ++reads === 1 ? old.promise : Promise.resolve([{id: 'm1', content: 'Current memory'}]),
      session: async () => ({id: 's1', text: 'Current session', turns: []}),
    });
    await ui.panel.select('a');
    expect(ui.memories).toHaveBeenCalledTimes(1); expect(ui.getSession).not.toHaveBeenCalled();
    await ui.hide(); old.resolve([{id: 'm1', content: 'Obsolete memory'}]); await ui.flush();
    expect(ui.getSession).not.toHaveBeenCalled(); expect(ui.panel.resolved).toEqual({});
    await ui.show();
    expect(ui.memories).toHaveBeenCalledTimes(2); expect(ui.getSession).toHaveBeenCalledTimes(1);
    expect(ui.panel.resolved['memory:m1'].memory).toBe('Current memory');
    expect(ui.panel.resolved['session:s1'].session.text).toBe('Current session');
  });

  it.each(['ack-hidden', 'ack-after-resume'] as const)('keeps an accepted material save and newer draft when %s', async when => {
    const ui = await mount(), write = deferred<MaterialRecord>();
    await ui.panel.select('a'); ui.panel.startEdit(); ui.panel.draft.title = 'Submitted title';
    ui.api.materialUpdate.mockReturnValueOnce(write.promise);
    const saving = ui.panel.saveEdit(); await ui.flush();
    expect(ui.panel.busy).toBe(true);
    ui.panel.draft.title = 'A newer draft';
    await ui.hide(); ui.notify(5);
    if (when === 'ack-after-resume') {await ui.show(); expect(ui.api.materialList).toHaveBeenCalledTimes(1); expect(ui.panel.busy).toBe(true);}
    const saved = {...record(), title: 'Submitted title'};
    ui.setItems([saved, record('b')]); write.resolve(saved); await saving; await ui.flush();
    expect(ui.panel.busy).toBe(false);
    expect(ui.panel.feedback).toBe('材料已整理。'); expect(ui.panel.editing).toBe(true); expect(ui.panel.draft.title).toBe('A newer draft');
    if (when === 'ack-hidden') {expect(ui.api.materialList).toHaveBeenCalledTimes(1); await ui.show();}
    expect(ui.api.materialList).toHaveBeenCalledTimes(2);
    expect(ui.panel.selected.title).toBe('Submitted title');
    expect(ui.panel.selectedId).toBe('a'); expect(ui.panel.draft.title).toBe('A newer draft');
    expect(ui.focus.mock.contexts.every(element => ui.document.body.contains(element as Node))).toBe(true);
  });

  it('does not focus a selected detail when the real parent hides before nextTick', async () => {
    const ui = await mount(); ui.focus.mockClear();
    const selecting = ui.panel.select('a'); ui.shown.value = false;
    await selecting; await ui.flush();
    expect(ui.document.querySelector('.fr-materials')).toBeNull();
    expect(ui.focus).not.toHaveBeenCalled();
    await ui.show();
    expect(ui.panel.selectedId).toBe('a'); expect(ui.focus).not.toHaveBeenCalled();
  });
});

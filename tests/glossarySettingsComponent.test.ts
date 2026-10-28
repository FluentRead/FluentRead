import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import * as runtime from 'vue';
import {parseHTML} from 'linkedom';
import GlossarySettings from '@/src/features/glossary/ui/GlossarySettings.vue';
import BuiltinGlossaries from '@/src/features/glossary/ui/BuiltinGlossaries.vue';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {translate} from '@/src/core/i18n';
import {GLOSSARY_LIMITS, createGlossaryLibrary, normalizeGlossaryLibraries, type GlossaryLibrary} from '@/src/core/glossary';
import {Config} from '@/src/core/config/model';
import {createQuickTranslationProfile} from '@/src/core/config/quickTranslation';

// 正常导入并渲染生产模板；只隔离配置、浏览器、原生对话框及第三方选择控件端口。
const stateKey = '__fluentReadGlossarySettingsTest';
let app: import('vue').App;
let renderer: import('vue').Renderer<any>;
let state: Record<string, any>;
let listeners: Set<(value: unknown) => void>;
let config: {glossaryEnabled: boolean; glossaryLibraries: GlossaryLibrary[]; to: string};
let requestConfigPatch: ReturnType<typeof vi.fn>;
let confirm: ReturnType<typeof vi.fn>;
let dom: ReturnType<typeof parseHTML>;
let elements: RenderElement[];
type RenderElement = Record<string, any> & {tag: string; props: Record<string, any>; value?: string};

const normalizationProbe = vi.hoisted(() => vi.fn());
vi.mock('@/src/core/glossary', async importOriginal => {
  const original = await importOriginal<typeof import('@/src/core/glossary')>();
  return {...original, normalizeGlossaryLibraries: (value: unknown) => {normalizationProbe(value);return original.normalizeGlossaryLibraries(value);}};
});
vi.mock('@/src/services/config/store', () => ({
  get config() {return (globalThis as any).__fluentReadGlossarySettingsTest.config;},
  get configReady() {return (globalThis as any).__fluentReadGlossarySettingsTest.configReady;},
  requestConfigPatch: (...args: unknown[]) => (globalThis as any).__fluentReadGlossarySettingsTest.requestConfigPatch(...args),
  subscribeConfig: (...args: unknown[]) => (globalThis as any).__fluentReadGlossarySettingsTest.subscribeConfig(...args),
}));
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({language: runtime.ref('zh-CN'), t: (key: string, params?: Record<string, string>) => translate(key, 'zh-CN', params), translateLegacy: (text: string) => text})}));
vi.mock('webextension-polyfill', () => ({default: {runtime: {sendMessage: async () => undefined}}}));
vi.mock('element-plus/es/components/select/style/css', () => ({}));
vi.mock('element-plus', () => ({
  ElOption: {props: ['value', 'label'], setup: (props: any) => () => runtime.h('option', {value: props.value}, props.label)},
  ElMessageBox: {confirm: (...args: unknown[]) => (globalThis as any).__fluentReadGlossarySettingsTest.confirm(...args)},
}));
vi.mock('@/src/ui/components/UiSelect.vue', () => ({default: {inheritAttrs: false, props: ['modelValue', 'disabled'], emits: ['update:modelValue', 'change'], setup(props: any, {attrs, slots, emit}: any) {
  return () => runtime.h('span', [runtime.h('input', {...attrs, value: props.modelValue, disabled: props.disabled, 'data-select-port': '', onInput: (event: any) => {emit('update:modelValue', event.target.value);emit('change', event.target.value);}}), runtime.h('span', {hidden: true}, slots.default?.())]);
}}}));
const dialogPort = {props: ['modelValue'], emits: ['update:modelValue'], setup: (props: any, {slots, emit}: any) => () => props.modelValue ? runtime.h('section', {role: 'dialog'}, [slots.default?.(), runtime.h('button', {'data-dialog-close': '', onClick: () => emit('update:modelValue', false)}, 'Close dialog')]) : null};
function mountComponent(component: import('vue').Component | undefined = undefined, props: Record<string, unknown> = {}, shown?: import('vue').Ref<boolean>): void {
  elements = [];
  renderer = runtime.createRenderer({
    patchProp(node: any, key, old: any, value: any) {
      node.props[key] = value;
      if (key === 'value') {node.value = value ?? '';return;}
      if (key === 'checked') {node.checked = !!value;return;}
      if (/^on[A-Z]/u.test(key)) {const event = key.slice(2).toLowerCase();if (old) node.removeEventListener(event, old);if (typeof value === 'function') node.addEventListener(event, value);}
      else if (value === undefined || value === null || value === false) node.removeAttribute(key);else node.setAttribute(key, String(value));
    },
    insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor), remove: (node: any) => node.parentNode?.removeChild(node),
    createElement: tag => {const node: any = dom.document.createElement(tag);node.tag = tag;node.props = {};elements.push(node);return node;},
    createText: text => dom.document.createTextNode(text), createComment: text => dom.document.createComment(text),
    setText: (node: any, text) => {node.nodeValue = text;}, setElementText: (node: any, text) => {node.textContent = text;node.text = text;},
    parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling,
    querySelector: value => dom.document.querySelector(value), setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
    insertStaticContent: (content, parent: any, anchor) => {const template = dom.document.createElement('template');template.innerHTML = content;const first = template.content.firstChild,last = template.content.lastChild;parent.insertBefore(template.content, anchor);return [first,last];},
  });
  const capture = (vm: any) => {if (vm) state = vm.$.setupState;};
  const otherPage = {render: () => null};
  const panel = () => runtime.h(component || GlossarySettings, {...props, ref: capture});
  app = renderer.createApp({setup: () => () => shown
    ? runtime.h(runtime.KeepAlive, null, {default: () => shown.value ? panel() : runtime.h(otherPage, {key: 'other-page'})})
    : panel()});
  app.component('ElDialog', dialogPort);app.config.warnHandler = () => undefined;
  app.mount(dom.document.querySelector('main')!);
}
async function mountMetadataRender(): Promise<RenderElement[]> {
  app.unmount();mountComponent();await settle();return elements;
}

function typeMetadataInput(input: RenderElement, value: string): void {
  input.value = value;
  input.props.onInput?.({target: input});
}
function metadataElement(elements: RenderElement[], field: 'name' | 'domains'): RenderElement {
  const input = [...elements].reverse().find(node => field === 'name'
    ? node.tag === 'input' && node.props.maxlength === GLOSSARY_LIMITS.nameLength
    : node.tag === 'textarea' && node.props['aria-label'] === translate('glossary.domains', 'zh-CN'));
  expect(input).toBeDefined();
  return input!;
}

function fixture(name = '技术'): GlossaryLibrary {
  return {id: name, name, enabled: true, sourceLanguage: '', targetLanguage: 'zh-hans', domains: [],
    entries: [{id: 'term-1', source: 'token', target: '词元', caseSensitive: false}]};
}
function event(value: string): Event {return {target: {value}} as unknown as Event;}
async function settle(): Promise<void> {for (let index = 0; index < 8; index++) {await Promise.resolve(); await runtime.nextTick();}}
beforeEach(async () => {
  dom = parseHTML('<html><body><main></main></body></html>');
  vi.stubGlobal('document', dom.document);vi.stubGlobal('window', dom.window);vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();dom.window.HTMLInputElement.prototype.select = vi.fn();
  config = {glossaryEnabled: false, glossaryLibraries: [], to: 'zh-Hans'};
  listeners = new Set();confirm = vi.fn().mockResolvedValue('confirm');
  requestConfigPatch = vi.fn(async patch => {Object.assign(config, patch);config.glossaryLibraries = normalizeGlossaryLibraries(config.glossaryLibraries);listeners.forEach(listener => listener(config));});
  Object.assign(globalThis, {[stateKey]: {config, confirm, configReady: Promise.resolve(), requestConfigPatch,
    subscribeConfig: (listener: (value: unknown) => void) => {listeners.add(listener);return () => listeners.delete(listener);}}});
  mountComponent();await settle();
});
afterEach(async () => {app?.unmount();delete (globalThis as any)[stateKey];vi.unstubAllGlobals();});

describe('GlossarySettings compiled component', () => {
  it.each([true,false])('skips unchanged glossary normalization for unrelated config notifications while active=%s', async active => {
    let sourceReads=0;
    config.glossaryLibraries = Array.from({length:10},(_,index)=>({...fixture(`library-${index}`),entries:Array.from({length:500},(_,term)=>({id:`term-${term}`,get source(){sourceReads++;return `source-${term}`;},target:`译文-${term}`,caseSensitive:false}))}));
    app.unmount();const props=runtime.reactive({active:true});mountComponent(GlossarySettings,props);await settle();
    expect(state.totalEntries).toBe(5000);const original=state.libraries;
    props.active=active;await settle();normalizationProbe.mockClear();sourceReads=0;
    for(let count=0;count<20;count++)listeners.forEach(listener=>listener({...config,count,glossaryLibraries:config.glossaryLibraries.map(library=>({...library,entries:[...library.entries]}))}));
    await settle();
    expect(normalizationProbe).not.toHaveBeenCalled();expect(state.libraries).toBe(original);
    // 可见页仍检查完整字段签名；隐藏通知只保留快照引用，连签名也不遍历。
    expect(sourceReads).toBe(active?100000:0);
    expect(state.totalEntries).toBe(5000);expect(requestConfigPatch).not.toHaveBeenCalled();
  });
  it('recognizes complete library metadata, entry identities and ordering while master matching is disabled',async()=>{
    config.glossaryLibraries=[fixture('first'),fixture('second')];app.unmount();mountComponent();await settle();
    const notify=async()=>{listeners.forEach(listener=>listener({...config}));await settle();};
    expect(state.enabled).toBe(false);
    config.glossaryLibraries[0].name='Renamed';config.glossaryLibraries[0].preset={id:'ai-en-zh-hans',version:2};await notify();
    expect(state.selected.name).toBe('Renamed');expect(state.selected.preset).toEqual({id:'ai-en-zh-hans',version:2});
    Object.assign(config.glossaryLibraries[0].entries[0],{id:'changed-id',source:'changed',target:'更新',caseSensitive:true});await notify();
    expect(state.selected.entries[0]).toEqual({id:'changed-id',source:'changed',target:'更新',caseSensitive:true});
    config.glossaryLibraries.reverse();await notify();expect(state.libraries.map((library:GlossaryLibrary)=>library.id)).toEqual(['second','first']);expect(state.selectedId).toBe('first');
    normalizationProbe.mockClear();config.glossaryEnabled=true;await notify();expect(state.enabled).toBe(true);expect(normalizationProbe).not.toHaveBeenCalled();
  });
  it('retains only glossary fields without reading or retaining unrelated snapshot data',async()=>{
    app.unmount();const props=runtime.reactive({active:false});mountComponent(GlossarySettings,props);await settle();let unrelatedReads=0;
    const next={glossaryEnabled:true,glossaryLibraries:[fixture('latest')],get unrelatedLargeField(){unrelatedReads++;return 'unrelated configuration';}};
    listeners.forEach(listener=>listener(next));
    // 先用原生身份比较生成布尔值，避免断言库为对象差异提示遍历 expected 的 getter。
    expect(Object.keys(state.latestConfig).sort()).toEqual(['glossaryEnabled','glossaryLibraries']);expect(Object.is(state.latestConfig,next)).toBe(false);expect(Object.is(state.latestConfig.glossaryLibraries,next.glossaryLibraries)).toBe(true);expect(unrelatedReads).toBe(0);
    props.active=true;await settle();expect(state.enabled).toBe(true);expect(state.selectedId).toBe('latest');expect(unrelatedReads).toBe(0);
    expect(Object.keys(state.latestConfig).sort()).toEqual(['glossaryEnabled','glossaryLibraries']);
  });
  it.each(['active-prop','keep-alive'])('reconciles only the latest hidden snapshot and preserves library and metadata drafts through %s',async mode=>{
    config.glossaryLibraries=[fixture('first'),fixture('second')];app.unmount();
    const props=runtime.reactive({active:true}),shown=runtime.ref(true);mountComponent(GlossarySettings,props,mode==='keep-alive'?shown:undefined);await settle();
    const setVisible=async(visible:boolean)=>{if(mode==='keep-alive')shown.value=visible;else props.active=visible;await settle();};
    await state.editEntry();state.entryDraft.source='first draft';const firstDraft=state.entryDraft;
    state.selectLibrary('second');await state.editEntry();state.entryDraft.source='second draft';const secondDraft=state.entryDraft;
    state.editMetadata('name',event('unsubmitted second name'));
    await setVisible(false);normalizationProbe.mockClear();
    config.glossaryLibraries[0].name='intermediate';listeners.forEach(listener=>listener({...config}));
    config.glossaryLibraries=[{...config.glossaryLibraries[0],name:'latest first'},{...config.glossaryLibraries[1],name:'latest second'}];listeners.forEach(listener=>listener({...config}));await settle();
    expect(normalizationProbe).not.toHaveBeenCalled();expect(state.selected.name).toBe('second');
    await setVisible(true);expect(normalizationProbe).toHaveBeenCalledOnce();expect(state.selectedId).toBe('second');expect(state.selected.name).toBe('latest second');
    expect(state.entryDraft).toBe(secondDraft);expect(state.metadataValue('name')).toBe('unsubmitted second name');
    state.selectLibrary('first');expect(state.entryDraft).toBe(firstDraft);expect(state.entryDraft.source).toBe('first draft');
    state.selectLibrary('second');expect(state.entryDraft).toBe(secondDraft);
    await setVisible(false);config.glossaryLibraries=[config.glossaryLibraries[0]];listeners.forEach(listener=>listener({...config}));await setVisible(true);
    expect(state.selectedId).toBe('first');expect(state.entryDraft).toBe(firstDraft);expect(state.entryDrafts.has('second')).toBe(false);expect(state.metadataValue('name')).toBe('latest first');
    expect(requestConfigPatch).not.toHaveBeenCalled();
  });
  it('keeps initial hydration paused while inactive and refreshes on activation after config becomes ready',async()=>{
    app.unmount();let release!:()=>void;(globalThis as any)[stateKey].configReady=new Promise<void>(resolve=>{release=resolve;});
    const props=runtime.reactive({active:false});mountComponent(GlossarySettings,props);normalizationProbe.mockClear();
    config.glossaryLibraries=[fixture('latest')];listeners.forEach(listener=>listener({...config}));release();await settle();
    expect(state.ready).toBe(true);expect(state.libraries).toEqual([]);expect(normalizationProbe).not.toHaveBeenCalled();
    props.active=true;await settle();expect(normalizationProbe).toHaveBeenCalledOnce();expect(state.selectedId).toBe('latest');
  });
  it('falls back to normalization if a field signature fails and resumes comparison on the next notification',async()=>{
    config.glossaryLibraries=[fixture('first')];app.unmount();mountComponent();await settle();normalizationProbe.mockClear();
    vi.spyOn(JSON,'stringify').mockImplementationOnce(()=>{throw new Error('signature unavailable');});
    config.glossaryLibraries[0].name='changed';listeners.forEach(listener=>listener(config));await settle();
    expect(state.selected.name).toBe('changed');expect(normalizationProbe).toHaveBeenCalledOnce();
    normalizationProbe.mockClear();listeners.forEach(listener=>listener(config));await settle();expect(normalizationProbe).toHaveBeenCalledOnce();
    normalizationProbe.mockClear();listeners.forEach(listener=>listener({...config,glossaryLibraries:[...config.glossaryLibraries]}));await settle();expect(normalizationProbe).not.toHaveBeenCalled();
  });
  it('finishes accepted serial saves while hidden and uses the first acknowledgement for the next queued patch',async()=>{
    config.glossaryLibraries=[fixture('first'),fixture('second')];app.unmount();const props=runtime.reactive({active:true});mountComponent(GlossarySettings,props);await settle();
    let release!:()=>void;
    requestConfigPatch.mockImplementationOnce(async patch=>{await new Promise<void>(resolve=>{release=resolve;});Object.assign(config,patch);listeners.forEach(listener=>listener({...config,glossaryLibraries:[...config.glossaryLibraries]}));});
    const rename=state.patchLibrary({name:'accepted name'});await settle();const language=state.patchLibrary({sourceLanguage:'en'});
    props.active=false;await settle();expect(state.busy).toBe(true);release();await Promise.all([rename,language]);
    expect(config.glossaryLibraries[0]).toMatchObject({name:'accepted name',sourceLanguage:'en'});expect(state.busy).toBe(false);expect(state.saved).toBe(true);
    props.active=true;await settle();expect(state.selected).toMatchObject({name:'accepted name',sourceLanguage:'en'});expect(requestConfigPatch).toHaveBeenCalledTimes(2);
  });
  it('rejects an accepted entry update deleted externally before its queue executes while hidden',async()=>{
    config.glossaryLibraries=[fixture('first')];app.unmount();const props=runtime.reactive({active:true});mountComponent(GlossarySettings,props);await settle();
    await state.editEntry(state.selected.entries[0]);state.entryDraft.target='retained draft';const draft=state.entryDraft;
    const saving=state.saveEntry();props.active=false;config.glossaryLibraries[0].entries=[];listeners.forEach(listener=>listener({...config,glossaryLibraries:[...config.glossaryLibraries]}));
    await saving;expect(config.glossaryLibraries[0].entries).toEqual([]);expect(requestConfigPatch).not.toHaveBeenCalled();expect(state.entryDraft).toBe(draft);expect(state.error).toContain('已在其他页面删除');
    props.active=true;await settle();expect(state.entryDraft.target).toBe('retained draft');expect(state.busy).toBe(false);
  });
  it('restores authoritative data after a hidden save failure without discarding a newer metadata draft',async()=>{
    config.glossaryLibraries=[fixture('first')];app.unmount();const props=runtime.reactive({active:true});mountComponent(GlossarySettings,props);await settle();
    let release!:()=>void;requestConfigPatch.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});throw new Error('storage unavailable');});
    state.editMetadata('name',event('submitted'));const saving=state.saveMetadata('name',{name:'submitted'});await settle();state.editMetadata('name',event('newer local draft'));
    props.active=false;config.glossaryLibraries=[{...fixture('first'),name:'authoritative external'}];listeners.forEach(listener=>listener({...config,glossaryLibraries:[...config.glossaryLibraries]}));release();await saving;
    props.active=true;await settle();expect(state.selected.name).toBe('authoritative external');expect(state.metadataValue('name')).toBe('newer local draft');expect(state.error).toContain('保存失败');expect(state.saved).toBe(false);expect(state.busy).toBe(false);
  });
  it.each(['import','builtin'])('builds a %s library list from the latest snapshot when an already open dialog confirms while hidden',async mode=>{
    config.glossaryLibraries=[fixture('deleted')];app.unmount();const props=runtime.reactive({active:true});mountComponent(GlossarySettings,props);await settle();
    if(mode==='import'){state.openImport();state.importText='source,target\nimported-term,导入';await settle();}
    else {
      const card=dom.document.querySelector('[data-testid="builtin-ai-en-zh-hans"]')!;
      [...card.querySelectorAll('button')].find(button=>button.textContent===translate('glossary.builtin.preview','zh-CN'))!.dispatchEvent(new dom.window.Event('click',{bubbles:true}));await settle();
    }
    props.active=false;config.glossaryLibraries=[fixture('remote')];listeners.forEach(listener=>listener({...config,glossaryLibraries:[...config.glossaryLibraries]}));await settle();
    const dialog=dom.document.querySelector('[role="dialog"]')!;expect(dialog).toBeTruthy();
    const label=translate(mode==='import'?'glossary.confirmImport':'glossary.builtin.add','zh-CN');
    [...dialog.querySelectorAll('button')].find(button=>button.textContent===label)!.dispatchEvent(new dom.window.Event('click',{bubbles:true}));await settle();
    expect(config.glossaryLibraries.some(library=>library.id==='deleted')).toBe(false);expect(config.glossaryLibraries.some(library=>library.id==='remote')).toBe(true);
    expect(config.glossaryLibraries).toHaveLength(2);expect(config.glossaryLibraries[1].entries.some(entry=>entry.source===(mode==='import'?'imported-term':'artificial intelligence'))).toBe(true);
  });
  it('renders separate script choices from the shared translation catalog and persists traditional scope', async () => {
    expect(state.languageOptions('zh-hant').filter((item: {value: string}) => item.value.startsWith('zh-'))).toEqual([
      {value: 'zh-hans', label: '简体中文 / Simplified Chinese'},
      {value: 'zh-hant', label: '繁體中文 / Traditional Chinese'},
    ]);
    await state.addLibrary();
    await state.patchLibrary({sourceLanguage: 'zh-hans', targetLanguage: 'zh-hant'});
    expect(config.glossaryLibraries[0]).toMatchObject({sourceLanguage: 'zh-hans', targetLanguage: 'zh-hant'});
    const elements = await mountMetadataRender();
    for (const [value, text] of [['zh-hans', '简体中文 / Simplified Chinese'], ['zh-hant', '繁體中文 / Traditional Chinese']]) {
      expect(elements.some(node => node.tag === 'option' && node.props.value === value && node.text === text)).toBe(true);
    }
  });

  it('starts empty and disabled without saving defaults, and explains service support and local preview', () => {
    expect(state.ready).toBe(true); expect(state.enabled).toBe(false); expect(state.libraries).toEqual([]);
    expect(state.selected).toBeUndefined(); expect(state.preview.terms).toEqual([]);
    expect(requestConfigPatch).not.toHaveBeenCalled();
    const component = readFileSync(resolve(process.cwd(), 'src/features/glossary/ui/GlossarySettings.vue'), 'utf8');
    for (const key of ['glossary.emptyTitle', 'glossary.startHelp']) {
      expect(component).toContain(`t('${key}')`);
      for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) expect(translate(key, language)).not.toBe(key);
    }
    expect(translate('glossary.services', 'zh-CN')).toContain('机器翻译和 AI 翻译');
    expect(translate('glossary.services', 'zh-CN')).toContain('填回指定译法');
  });

  it('creates libraries and preserves blank translations, case options, search, and order', async () => {
    await state.addLibrary();
    await state.patchLibrary({name: '产品名', targetLanguage: 'zh-hans'});
    state.editEntry(); Object.assign(state.entryDraft, {source: 'FluentRead', target: '', caseSensitive: true});
    await state.saveEntry();
    expect(config.glossaryLibraries[0]).toMatchObject({name: '产品名', entries: [{source: 'FluentRead', target: '', caseSensitive: true}]});
    state.previewText = 'FluentRead and fluentread';
    expect(state.preview.terms).toEqual([{source: 'FluentRead', target: 'FluentRead'}]);
    state.query = 'not-here'; expect(state.filteredEntries).toHaveLength(0);
    state.query = 'fluent'; expect(state.filteredEntries).toHaveLength(1);
    await state.addLibrary(); state.moveLibrary(config.glossaryLibraries[1].id, -1); await settle();
    expect(config.glossaryLibraries[1].name).toBe('产品名');
    expect(requestConfigPatch.mock.calls.every(([patch]) => Object.keys(patch).every(key => ['glossaryLibraries', 'glossaryEnabled'].includes(key)))).toBe(true);
  });

  it('adds a real bundled word list, persists it without enabling the master switch, and opens rather than overwrites an edited copy', async () => {
    await state.addBuiltin('ai-en-zh-hans');
    expect(config.glossaryEnabled).toBe(false);
    expect(config.glossaryLibraries).toHaveLength(1);
    expect(state.selected).toMatchObject({name: 'AI 与机器学习', preset: {id: 'ai-en-zh-hans', version: 2}});
    expect(state.selected.entries).toHaveLength(65);
    await state.patchLibrary({name: '我的 AI 译名', enabled: false});
    state.editEntry(state.selected.entries[0]); state.entryDraft.target = '我的译法'; await state.saveEntry();
    const editedId = state.selectedId;
    await state.addLibrary();
    const callCount = requestConfigPatch.mock.calls.length;
    await state.addBuiltin('ai-en-zh-hans');
    expect(requestConfigPatch).toHaveBeenCalledTimes(callCount);
    expect(state.selectedId).toBe(editedId);
    expect(state.selected).toMatchObject({name: '我的 AI 译名', enabled: false, entries: [{target: '我的译法'}, ...state.selected.entries.slice(1)]});
    state.hydrate();
    expect(state.selected.preset).toEqual({id: 'ai-en-zh-hans', version: 2});
    await state.deleteLibrary();
    await state.addBuiltin('ai-en-zh-hans');
    expect(state.selected.name).toBe('AI 与机器学习'); expect(state.selected.entries[0].target).toBe('人工智能');
  });

  it('does not add builtins before readiness or while saving, and reports capacity and storage failures without losing existing libraries', async () => {
    state.ready = false; await state.addBuiltin('ai-en-zh-hans'); state.ready = true;
    state.busy = true; await state.addBuiltin('ai-en-zh-hans'); state.busy = false;
    await state.addBuiltin('missing'); expect(requestConfigPatch).not.toHaveBeenCalled();
    requestConfigPatch.mockRejectedValueOnce(new Error('disk unavailable'));
    await state.addBuiltin('ai-en-zh-hans');
    expect(state.libraries).toEqual([]); expect(state.error).toContain('保存失败');
    const full = Array.from({length: 20}, (_, index) => fixture(`lib-${index}`));
    await state.persist({glossaryLibraries: full});
    await state.addBuiltin('ai-en-zh-hans');
    expect(state.error).toContain('超出容量'); expect(config.glossaryLibraries).toEqual(full);
  });

  it('retains saved state and displays failure instead of claiming a failed change was saved', async () => {
    await state.addLibrary(); const original = structuredClone(config.glossaryLibraries);
    requestConfigPatch.mockRejectedValueOnce(new Error('storage failure'));
    expect(await state.patchLibrary({name: '不会保存'})).toBe(false);
    expect(state.libraries).toEqual(original); expect(config.glossaryLibraries).toEqual(original);
    expect(state.error).toContain('保存失败'); expect(state.saved).toBe(false);
    await state.patchLibrary({name: '重试成功'});
    expect(config.glossaryLibraries[0].name).toBe('重试成功'); expect(state.error).toBe('');
  });

  it('clears an older success indicator when the later queued save fails', async () => {
    await state.addLibrary();
    let release!: () => void;
    requestConfigPatch.mockImplementationOnce(async patch => {await new Promise<void>(resolve => {release = resolve;}); Object.assign(config, patch); listeners.forEach(listener => listener(config));});
    requestConfigPatch.mockRejectedValueOnce(new Error('second save failed'));
    const first = state.patchLibrary({name: '第一次成功'}); await settle();
    const second = state.patchLibrary({name: '第二次失败'});
    release(); await Promise.all([first, second]);
    expect(config.glossaryLibraries[0].name).toBe('第一次成功');
    expect(state.saved).toBe(false); expect(state.busy).toBe(false);
    expect(state.error).toContain('保存失败');
  });

  it('persists master and library enablement and updates an entry without creating a duplicate', async () => {
    await state.persist({glossaryLibraries: [fixture()]});
    state.setEnabled(true); await settle();
    expect(config.glossaryEnabled).toBe(true); expect(state.enabled).toBe(true);
    state.previewText = 'token';
    await state.patchLibrary({enabled: false}); expect(state.preview.terms).toEqual([]);
    await state.patchLibrary({enabled: true}); expect(state.preview.terms).toEqual([{source: 'token', target: '词元'}]);
    state.editEntry(state.selected.entries[0]); state.entryDraft.target = '令牌'; await state.saveEntry();
    expect(config.glossaryLibraries[0].entries).toEqual([{id: 'term-1', source: 'token', target: '令牌', caseSensitive: false}]);
    state.hydrate(); expect(state.preview.terms).toEqual([{source: 'token', target: '令牌'}]);
    expect(state.entryDraft).toBeNull();
  });

  it('serializes nearby field edits and applies both patches to the original selected library', async () => {
    await state.addLibrary(); const first = state.selectedId; await state.addLibrary(); state.selectLibrary(first);
    let release!: () => void;
    requestConfigPatch.mockImplementationOnce(async patch => {await new Promise<void>(resolve => {release = resolve;}); Object.assign(config, patch); listeners.forEach(listener => listener(config));});
    const rename = state.patchLibrary({name: '连续编辑'}); await settle();
    const language = state.patchLibrary({sourceLanguage: 'en'}); state.selectLibrary(config.glossaryLibraries[1].id);
    release(); await Promise.all([rename, language]);
    expect(config.glossaryLibraries.find(item => item.id === first)).toMatchObject({name: '连续编辑', sourceLanguage: 'en'});
    expect(config.glossaryLibraries[1].sourceLanguage).toBe('');
  });

  it.each([
    ['name', '技术词库第一次', '技术词库最终'],
    ['domains', 'first.example', 'final.example'],
  ] as const)('keeps uncommitted %s input through an older receipt in the actual template', async (field, first, final) => {
    config.glossaryLibraries = [fixture()];
    const elements = await mountMetadataRender();
    const input = metadataElement(elements, field);
    let release!: () => void;
    requestConfigPatch.mockImplementationOnce(async patch => {await new Promise<void>(resolve => {release = resolve;}); Object.assign(config, patch); listeners.forEach(listener => listener(config));});
    typeMetadataInput(input, first); input.props.onChange({target: input}); await settle();
    typeMetadataInput(input, final); await settle();
    expect(requestConfigPatch).toHaveBeenCalledTimes(1);
    release(); await settle();
    expect(input.value).toBe(final);
    expect(elements.find(node => node.props.class === 'glossary-save-state')?.text).toBe('');
    input.props.onChange({target: input}); await settle();
    expect(config.glossaryLibraries[0][field]).toEqual(field === 'domains' ? [final] : final);
    expect(input.value).toBe(final);
    expect(elements.find(node => node.props.class === 'glossary-save-state')?.text).toBe(translate('glossary.saved', 'zh-CN'));
  });

  it.each(['name', 'domains'] as const)('syncs external metadata without overwriting an edited %s field', async field => {
    config.glossaryLibraries = [fixture()];
    const elements = await mountMetadataRender();
    const input = metadataElement(elements, field);
    const draft = field === 'name' ? '本地未提交' : 'local.example';
    typeMetadataInput(input, draft);
    Object.assign(config.glossaryLibraries[0], {name: '外部名称', domains: ['external.example'], sourceLanguage: 'en'});
    listeners.forEach(listener => listener(config)); await settle();
    expect(metadataElement(elements, field).value).toBe(draft);
    expect(metadataElement(elements, field === 'name' ? 'domains' : 'name').value).toBe(field === 'name' ? 'external.example' : '外部名称');
    expect(state.selected.sourceLanguage).toBe('en');
    expect(requestConfigPatch).not.toHaveBeenCalled();
    input.props.onChange({target: input}); await settle();
    Object.assign(config.glossaryLibraries[0], {name: '后续名称', domains: ['later.example']});
    listeners.forEach(listener => listener(config)); await settle();
    expect(metadataElement(elements, field).value).toBe(field === 'name' ? '后续名称' : 'later.example');
  });

  it.each([
    {field: 'name' as const, laterEdit: false}, {field: 'name' as const, laterEdit: true},
    {field: 'domains' as const, laterEdit: false}, {field: 'domains' as const, laterEdit: true},
  ])('reconciles failed $field saves without losing a later edit: $laterEdit', async ({field, laterEdit}) => {
    config.glossaryLibraries = [{...fixture(), domains: ['saved.example']}];
    const elements = await mountMetadataRender();
    const input = metadataElement(elements, field);
    const savedValue = input.value;
    let release!: () => void;
    requestConfigPatch.mockImplementationOnce(async () => {await new Promise<void>(resolve => {release = resolve;}); throw new Error('storage unavailable');});
    typeMetadataInput(input, field === 'name' ? '提交值' : 'submitted.example');
    input.props.onChange({target: input}); await settle();
    const laterValue = field === 'name' ? '之后继续输入' : 'later.example';
    if (laterEdit) typeMetadataInput(input, laterValue);
    release(); await settle();
    expect(metadataElement(elements, field).value).toBe(laterEdit ? laterValue : savedValue);
    expect(state.error).toContain('保存失败');
    expect(config.glossaryLibraries[0][field]).toEqual(field === 'name' ? savedValue : [savedValue]);
    expect(requestConfigPatch).toHaveBeenCalledTimes(1);
    if (laterEdit) {
      const preserved = metadataElement(elements, field);
      preserved.props.onChange({target: preserved}); await settle();
      expect(config.glossaryLibraries[0][field]).toEqual(field === 'name' ? laterValue : [laterValue]);
    }
  });

  it.each([
    {field: 'name' as const, deletion: false}, {field: 'name' as const, deletion: true},
    {field: 'domains' as const, deletion: false}, {field: 'domains' as const, deletion: true},
  ])('isolates $field drafts after switching or deleting the old library: $deletion', async ({field, deletion}) => {
    config.glossaryLibraries = [fixture('first'), fixture('second')];
    const elements = await mountMetadataRender();
    const input = metadataElement(elements, field);
    let release!: () => void;
    requestConfigPatch.mockImplementationOnce(async patch => {
      await new Promise<void>(resolve => {release = resolve;});
      if (deletion) throw new Error('library removed by another page');
      Object.assign(config, patch); listeners.forEach(listener => listener(config));
    });
    typeMetadataInput(input, field === 'name' ? 'first submitted' : 'first.example');
    input.props.onChange({target: input}); await settle();
    if (deletion) {
      config.glossaryLibraries = config.glossaryLibraries.filter(library => library.id !== 'first');
      listeners.forEach(listener => listener(config));
    } else state.selectLibrary('second');
    await settle();
    const second = metadataElement(elements, field);
    expect(second.value).toBe(field === 'name' ? 'second' : '');
    const secondDraft = field === 'name' ? 'second draft' : 'second.example';
    typeMetadataInput(second, secondDraft);
    release(); await settle();
    expect(state.selectedId).toBe('second');
    expect(metadataElement(elements, field).value).toBe(secondDraft);
    expect(config.glossaryLibraries.find(library => library.id === 'second')?.[field]).toEqual(field === 'name' ? 'second' : []);
    expect(requestConfigPatch).toHaveBeenCalledTimes(1);
  });

  it('keeps a new draft when an older entry save finishes after switching libraries', async () => {
    await state.addLibrary(); const firstId = state.selectedId; await state.addLibrary(); const secondId = state.selectedId;
    state.selectLibrary(firstId); state.editEntry(); state.entryDraft.source = 'first';
    let release!: () => void;
    requestConfigPatch.mockImplementationOnce(async patch => {await new Promise<void>(resolve => {release = resolve;}); Object.assign(config, patch); listeners.forEach(listener => listener(config));});
    const saving = state.saveEntry(); await settle();
    state.selectLibrary(secondId); state.editEntry(); state.entryDraft.source = 'second draft';
    release(); await saving;
    expect(config.glossaryLibraries.find(item => item.id === firstId)?.entries[0].source).toBe('first');
    expect(state.entryDraft.source).toBe('second draft'); expect(state.selectedId).toBe(secondId);
  });

  it.each([
    ['source', ' tokenized '],
    ['target', ' 令牌 '],
    ['caseSensitive', true],
  ] as const)('preserves same-draft %s edits during a save and updates the saved entry on retry', async (field, value) => {
    await state.addLibrary(); state.editEntry();
    Object.assign(state.entryDraft, {source: ' token ', target: ' 词元 ', caseSensitive: false});
    const draft = state.entryDraft;
    let release!: () => void;
    requestConfigPatch.mockImplementationOnce(async patch => {await new Promise<void>(resolve => {release = resolve;}); Object.assign(config, patch); listeners.forEach(listener => listener(config));});
    const saving = state.saveEntry(); await settle();
    expect(state.busy).toBe(true);
    draft[field] = value;
    release(); await saving;
    expect(state.entryDraft).toBe(draft);
    expect(state.entryDraft[field]).toBe(value);
    expect(config.glossaryLibraries[0].entries).toEqual([{id: draft.id, source: 'token', target: '词元', caseSensitive: false}]);
    await state.saveEntry();
    expect(config.glossaryLibraries[0].entries).toEqual([{...draft, source: draft.source.trim(), target: draft.target.trim()}]);
    expect(state.entryDraft).toBeNull();
  });

  it('deletes the originally selected entry when selection changes during confirmation', async () => {
    await state.persist({glossaryLibraries: [fixture('first'), fixture('second')]});
    let release!: () => void;
    confirm.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;}));
    const deleting = state.deleteEntry(state.selected.entries[0]); state.selectLibrary('second'); release(); await deleting;
    expect(config.glossaryLibraries[0].entries).toEqual([]); expect(config.glossaryLibraries[1].entries).toHaveLength(1);
  });

  it('rejects invalid domains and previews website filtering, conflicts, and a disabled master switch', async () => {
    await state.persist({glossaryLibraries: [fixture('first'), {...fixture('second'), entries: [{id: 'term-1', source: 'token', target: '代币', caseSensitive: false}]}]});
    state.updateDomains(event('https://example.com/path')); await settle();
    expect(state.error).toContain('网站范围无效'); expect(config.glossaryLibraries[0].domains).toEqual([]);
    await state.patchLibrary({domains: ['example.com']}); state.previewText = 'token'; state.previewUrl = 'https://example.com/news';
    expect(state.preview.terms).toEqual([{source: 'token', target: '词元'}]); expect(state.preview.conflicts).toHaveLength(1);
    state.previewUrl = 'https://other.example/'; expect(state.preview.terms[0].target).toBe('代币');
    expect(state.enabled).toBe(false); expect(state.preview.terms).toHaveLength(1);
    const values = state.languageOptions('zh-hans').map((item: {value: string}) => item.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('blocks malformed imports, requires warning review, and appends rather than replaces', async () => {
    await state.addLibrary(); const originalId = config.glossaryLibraries[0].id;
    state.openImport(); await settle(); state.importText = 'source,target\n"unclosed,坏'; await settle();
    expect(state.importErrors.length).toBeGreaterThan(0); expect(state.canImport).toBe(false);
    await state.confirmImport(); expect(config.glossaryLibraries).toHaveLength(1);
    state.importText = 'source,target,tgt_lng,note\ncomponent,组件,zh-CN,备注'; await settle();
    expect(state.importPreview.warnings.length).toBeGreaterThan(0); expect(state.canImport).toBe(false);
    state.acceptWarnings = true; expect(state.canImport).toBe(true);
    await state.confirmImport(); expect(config.glossaryLibraries).toHaveLength(2);
    expect(config.glossaryLibraries[0].id).toBe(originalId); expect(config.glossaryLibraries[1].entries[0].target).toBe('组件');
    expect(config.glossaryLibraries[1].targetLanguage).toBe('zh-hans');
    expect(state.previewTarget).toBe('zh-hans'); state.previewText = 'component';
    expect(state.preview.terms).toEqual([{source: 'component', target: '组件'}]);
    expect(state.languageOptions('zh-hans').filter((item: {value: string}) => item.value === 'zh-hans')).toHaveLength(1);
    expect(new Set(config.glossaryLibraries.map(item => item.id)).size).toBe(2); expect(state.importOpen).toBe(false);
  });

  it('ignores stale file completions after a newer file or a closed import dialog', async () => {
    state.openImport(); await settle();
    let oldResolve!: (text: string) => void;
    const old = state.readImportFile({target: {files: [{name: 'old.csv', size: 10, text: () => new Promise<string>(resolve => {oldResolve = resolve;})}]}});
    await state.readImportFile({target: {files: [{name: 'new.csv', size: 10, text: async () => 'source,target\nnew,新'}]}});
    oldResolve('source,target\nold,旧'); await old;
    expect(state.importText).toContain('new,新');
    const closing = state.readImportFile({target: {files: [{name: 'late.csv', size: 10, text: () => new Promise<string>(resolve => {oldResolve = resolve;})}]}});
    state.importOpen = false; await settle(); state.openImport(); await settle();
    oldResolve('source,target\nlate,迟到'); await closing; expect(state.importText).toBe('');
  });

  it('preserves pasted text during a pending file read and clears file errors for a paste retry', async () => {
    state.openImport(); await settle(); let release!: (value: string) => void;
    const reading = state.readImportFile({target: {files: [{name: 'pending.csv', size: 10, text: () => new Promise<string>(resolve => {release = resolve;})}]}});
    state.importText = 'source,target\npasted,粘贴'; state.invalidateFileRead();
    release('source,target\nstale,旧'); await reading; expect(state.importText).toContain('pasted');
    await state.readImportFile({target: {files: [{name: 'failed.csv', size: 10, text: async () => {throw new Error('unreadable');}}]}});
    expect(state.fileError).toContain('无法读取');
    state.importText = 'source,target\nretry,重试'; state.invalidateFileRead(); await settle();
    expect(state.fileError).toBe(''); expect(state.canImport).toBe(true);
  });

  it('starts new libraries in the current target language with unique names and guards library capacity', async () => {
    await state.addLibrary(); await state.addLibrary();
    expect(config.glossaryLibraries.map(item => item.name)).toEqual(['新术语库', '新术语库 2']);
    expect(config.glossaryLibraries.every(item => item.targetLanguage === 'zh-hans')).toBe(true);
    expect(state.settingsOpen).toBe(true); expect(state.selected).toBeTruthy();
    state.previewText = 'token'; state.previewTarget = 'ja';
    expect(state.previewLibraries.every((item: any) => item.reason === 'target')).toBe(true);
    await state.persist({glossaryLibraries: Array.from({length: 20}, (_, index) => fixture(`lib-${index}`))});
    const calls = requestConfigPatch.mock.calls.length;
    await state.addLibrary();
    expect(requestConfigPatch).toHaveBeenCalledTimes(calls); expect(state.error).toContain('超出容量');
  });

  it('preserves per-library entry drafts on navigation, including switching during a pending save', async () => {
    await state.persist({glossaryLibraries: [fixture('first'), fixture('second')]});
    state.editEntry(); state.entryDraft.source = 'unsaved'; state.entryDraft.target = '草稿';
    state.selectLibrary('second'); expect(state.entryDraft).toBeNull();
    state.editEntry(); state.entryDraft.source = 'another';
    state.selectLibrary('first'); expect(state.entryDraft.source).toBe('unsaved');
    let release!: () => void;
    requestConfigPatch.mockImplementationOnce(async patch => {await new Promise<void>(resolve => {release = resolve;}); Object.assign(config, patch); listeners.forEach(listener => listener(config));});
    const saving = state.saveEntry(); await settle(); state.selectLibrary('second');
    release(); await saving;
    expect(state.entryDraft.source).toBe('another');
    state.selectLibrary('first'); expect(state.entryDraft).toBeNull();
    expect(config.glossaryLibraries[0].entries.at(-1)?.target).toBe('草稿');
    state.selectLibrary('second'); state.cancelEntry(); state.selectLibrary('first'); state.selectLibrary('second');
    expect(state.entryDraft).toBeNull();
  });

  it('blocks shadowed duplicates with Unicode and case semantics but allows distinct case-sensitive spellings', async () => {
    await state.persist({glossaryLibraries: [fixture()]});
    state.editEntry(); Object.assign(state.entryDraft, {source: ' TOKEN ', target: '代币'});
    expect(state.duplicateEntry.source).toBe('token');
    await state.saveEntry(); expect(config.glossaryLibraries[0].entries).toHaveLength(1);
    expect(state.error).toContain('已有匹配');
    state.cancelEntry(); state.editEntry(state.selected.entries[0]); state.entryDraft.caseSensitive = true; await state.saveEntry();
    state.editEntry(); Object.assign(state.entryDraft, {source: 'TOKEN', target: '代币', caseSensitive: true});
    expect(state.duplicateEntry).toBeUndefined(); await state.saveEntry();
    expect(config.glossaryLibraries[0].entries).toHaveLength(2);
    state.editEntry(); Object.assign(state.entryDraft, {source: 'café', target: '咖啡'}); await state.saveEntry();
    state.editEntry(); Object.assign(state.entryDraft, {source: 'cafe\u0301', target: '咖啡馆'});
    expect(state.duplicateEntry.source).toBe('café');
  });

  it('confirms replacing unsaved entries and keeps the draft when cancelled', async () => {
    await state.persist({glossaryLibraries: [fixture()]});
    state.editEntry(); state.entryDraft.source = 'draft';
    confirm.mockRejectedValueOnce('cancel');
    await state.editEntry(state.selected.entries[0]); expect(state.entryDraft.source).toBe('draft');
    await state.editEntry(state.selected.entries[0]); expect(state.entryDraft.source).toBe('token');
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('merges entry changes with the latest list and never restores an externally deleted entry', async () => {
    await state.persist({glossaryLibraries: [fixture()]});
    state.editEntry(state.selected.entries[0]); state.entryDraft.target = '更新';
    const saving = state.saveEntry();
    config.glossaryLibraries[0].entries.push({id: 'external', source: 'external', target: '外部', caseSensitive: false});
    listeners.forEach(listener => listener(config));
    await saving; expect(config.glossaryLibraries[0].entries.map(item => item.target)).toEqual(['更新', '外部']);
    state.editEntry(state.selected.entries[0]); state.entryDraft.target = '不应恢复';
    const staleSave = state.saveEntry();
    config.glossaryLibraries[0].entries.shift(); listeners.forEach(listener => listener(config));
    await staleSave;
    expect(config.glossaryLibraries[0].entries).toHaveLength(1);
    expect(state.entryDraft.target).toBe('不应恢复'); expect(state.error).toContain('已在其他页面删除');
  });

  it('keeps a dirty draft when clicking its own edit action and rejects an entry deleted before Save', async () => {
    await state.persist({glossaryLibraries: [fixture()]});
    state.editEntry(state.selected.entries[0]); state.entryDraft.target = '未保存';
    await state.editEntry(state.selected.entries[0]); expect(state.entryDraft.target).toBe('未保存');
    config.glossaryLibraries[0].entries = []; listeners.forEach(listener => listener(config));
    await state.saveEntry();
    expect(config.glossaryLibraries[0].entries).toEqual([]);
    expect(state.entryDraft.target).toBe('未保存'); expect(state.error).toContain('已在其他页面删除');
  });

  it('starts the first entry directly, hides advanced controls and saves a matchable term', async () => {
    expect(state.previewOpen).toBe(false); expect(state.settingsOpen).toBe(false);
    await state.startEntry('large language model');
    expect(state.libraries).toHaveLength(1); expect(state.settingsOpen).toBe(false);
    expect(state.entryDraft.source).toBe('large language model');
    state.entryDraft.target = '大语言模型'; await state.saveEntry();
    expect(state.totalEntries).toBe(1);
    state.previewText = 'large language model';
    expect(state.preview.terms).toEqual([{source: 'large language model', target: '大语言模型'}]);
    expect(state.enabled).toBe(false);
  });

  it('requires confirmation before deletion and unsubscribes when unmounted', async () => {
    await state.addLibrary(); confirm.mockRejectedValueOnce('cancel'); await state.deleteLibrary();
    expect(config.glossaryLibraries).toHaveLength(1);
    await state.deleteLibrary(); expect(config.glossaryLibraries).toHaveLength(0);
    expect(confirm).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(1);
    app.unmount(); expect(listeners.size).toBe(0);
  });
});

describe('GlossarySettings search workload and reactive semantics', () => {
  type SearchOperations = {joinedLower: number; sourceLower: number; targetLower: number; queryLower: number; queryTrim: number};
  const emptyOperations = (): SearchOperations => ({joinedLower:0,sourceLower:0,targetLower:0,queryLower:0,queryTrim:0});
  const difference = (after:SearchOperations,before:SearchOperations):SearchOperations => Object.fromEntries(Object.keys(after).map(key=>[key,after[key as keyof SearchOperations]-before[key as keyof SearchOperations]])) as SearchOperations;
  function searchLibrary(id:string,count=500):GlossaryLibrary {
    return {...fixture(id),entries:Array.from({length:count},(_,index)=>({id:`term-${index}`,source:`GLS-SOURCE-${id}-${index}`,target:`GLS-TARGET-${id}-${index}`,caseSensitive:false}))};
  }
  async function mountSearch(libraries:GlossaryLibrary[]):Promise<void>{config.glossaryLibraries=libraries;app.unmount();mountComponent();await settle();}
  async function search(value:string):Promise<void>{
    const input=dom.document.querySelector<HTMLInputElement>('.glossary-search input')!;expect(input).toBeTruthy();
    input.value=value;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle();
  }
  function trackSearch(){
    const operations=emptyOperations(),localeArguments:unknown[][]=[];
    const originalLower=String.prototype.toLocaleLowerCase,originalTrim=String.prototype.trim;
    const lower=vi.spyOn(String.prototype,'toLocaleLowerCase').mockImplementation(function(this:string,...args:Parameters<typeof originalLower>){
      const value=String(this);let recorded=true;
      if(value.startsWith('GLS-SOURCE-')){if(value.includes('\n'))operations.joinedLower++;else operations.sourceLower++;}
      else if(value.startsWith('GLS-TARGET-'))operations.targetLower++;
      else if(value.startsWith('GLS-QUERY-'))operations.queryLower++;
      else recorded=false;
      if(recorded)localeArguments.push(args);
      return originalLower.apply(this,args);
    });
    const trim=vi.spyOn(String.prototype,'trim').mockImplementation(function(this:string){
      if(String(this).startsWith('  GLS-QUERY-'))operations.queryTrim++;
      return originalTrim.call(this);
    });
    return {operations,localeArguments,snapshot:()=>({...operations}),restore:()=>{lower.mockRestore();trim.mockRestore();}};
  }
  function reportOperations(scenario:string,data:unknown):void{
    // 显式证据运行才输出计数；普通消费者回归没有日志或文件副作用。
    if(process.env.FLUENTREAD_GLOSSARY_SEARCH_METRICS==='1')console.info(`GLOSSARY_SEARCH_OPERATIONS ${JSON.stringify({scenario,...data as object})}`);
  }
  const ids=():string[]=>(state.filteredEntries as GlossaryLibrary['entries']).map(entry=>entry.id);

  it('normalizes each immediate query once and reuses current-library text across twenty inputs',async()=>{
    const probe=trackSearch();
    try {
      await mountSearch(Array.from({length:10},(_,index)=>searchLibrary(`library-${index}`)));
      const mounted=probe.snapshot();expect(state.totalEntries).toBe(5000);expect(dom.document.querySelectorAll('.glossary-table tbody tr')).toHaveLength(30);
      await search('  GLS-QUERY-0  ');const first=difference(probe.snapshot(),mounted);
      const afterFirst=probe.snapshot();
      for(let index=1;index<20;index++)await search(`  GLS-QUERY-${index}  `);
      const following=difference(probe.snapshot(),afterFirst),total=difference(probe.snapshot(),mounted),beforeRepeat=probe.snapshot();
      await search('  GLS-QUERY-19  ');const repeated=difference(probe.snapshot(),beforeRepeat);
      const cached=state.searchTexts as string[]|undefined;
      reportOperations('fixed-library-500-entries-20-queries',{libraries:10,totalEntries:5000,selectedEntries:500,mounted,firstInput:first,following19Inputs:following,totalInputs:total,repeatedSameInput:repeated,cachedEntries:cached?.length??null,cachedCharacters:cached?.reduce((count,text)=>count+text.length,0)??null});
      expect(mounted.joinedLower).toBe(0);
      expect(first).toEqual({joinedLower:500,sourceLower:0,targetLower:0,queryLower:1,queryTrim:2});
      expect(following).toEqual({joinedLower:0,sourceLower:0,targetLower:0,queryLower:19,queryTrim:38});
      expect(total).toEqual({joinedLower:500,sourceLower:0,targetLower:0,queryLower:20,queryTrim:40});
      expect(repeated).toEqual(emptyOperations());expect(probe.localeArguments.every(args=>args.length===0)).toBe(true);
      expect(state.filteredEntries).toEqual([]);expect(requestConfigPatch).not.toHaveBeenCalled();
    }finally{probe.restore();}
  });

  it('bounds text indexing to the selected library while rotating ten legal libraries over twenty queries',async()=>{
    await mountSearch(Array.from({length:10},(_,index)=>searchLibrary(`library-${index}`)));
    const probe=trackSearch(),perLibrary:SearchOperations[]=[],selectionTransitions:SearchOperations[]=[],queryInputs:SearchOperations[]=[];
    try{
      for(let library=0;library<10;library++){
        const before=probe.snapshot();state.selectLibrary(`library-${library}`);await settle();
        const afterSelection=probe.snapshot();selectionTransitions.push(difference(afterSelection,before));
        await search(`  GLS-QUERY-${library}-first  `);await search(`  GLS-QUERY-${library}-second  `);
        perLibrary.push(difference(probe.snapshot(),before));queryInputs.push(difference(probe.snapshot(),afterSelection));
      }
      reportOperations('rotating-10-libraries-5000-entries-20-queries',{libraries:10,totalEntries:5000,queriesPerLibrary:2,perLibrary,selectionTransitions,queryInputs,total:probe.snapshot()});
      expect(perLibrary).toEqual(Array.from({length:10},()=>({joinedLower:500,sourceLower:0,targetLower:0,queryLower:2,queryTrim:4})));
      expect(probe.operations).toEqual({joinedLower:5000,sourceLower:0,targetLower:0,queryLower:20,queryTrim:40});
      expect(state.searchTexts).toHaveLength(500);expect(probe.localeArguments.every(args=>args.length===0)).toBe(true);
      expect(requestConfigPatch).not.toHaveBeenCalled();
    }finally{probe.restore();}
  });

  it('preserves default-locale casing, Unicode trim, literal newlines, cross-field matching and non-normalized queries',async()=>{
    await mountSearch([{...fixture('semantics'),entries:[
      {id:'boundary',source:'FieldEnd',target:'TargetStart',caseSensitive:true},
      {id:'lines',source:'Line\r\nKeep',target:'Second\nLine',caseSensitive:false},
      {id:'accent',source:'Café',target:'',caseSensitive:false},
      {id:'locale',source:'IİΣΟΣ',target:'LocaleTarget',caseSensitive:false},
    ]}]);
    const cases:[string,string[]][]=[['\u00a0\t FIELDEND \n',['boundary']],['targetstart',['boundary']],['dend\ntargets',['boundary']],
      ['line\r\nkeep',['lines']],['line\nkeep',[]],['second\nline',['lines']],['CAFÉ',['accent']],['CAFE\u0301',[]],['IİΣΟΣ',['locale']],['\t\u00a0\n', ['boundary','lines','accent','locale']]];
    for(const [query,expected] of cases){await search(query);expect(ids(),JSON.stringify(query)).toEqual(expected);}
    // locale 结果采用当前运行时默认值，调用不传语言，避免改变原有 locale 合同。
    await search('İ'.toLocaleLowerCase());expect(ids()).toEqual(['locale']);
  });

  it('refreshes source, target and array changes without replacing the selected entries array',async()=>{
    await mountSearch([{...fixture('mutable'),entries:[{id:'first',source:'first',target:'',caseSensitive:false},{id:'second',source:'second',target:'',caseSensitive:false}]}]);
    await search('needle');const entries=state.selected.entries as GlossaryLibrary['entries'];expect(ids()).toEqual([]);
    entries[0].source='needle source';await settle();expect(ids()).toEqual(['first']);
    entries[0].source='first';entries[1].target='needle target';await settle();expect(ids()).toEqual(['second']);
    entries.push({id:'third',source:'needle third',target:'',caseSensitive:false});await settle();expect(ids()).toEqual(['second','third']);
    entries.reverse();await settle();expect(ids()).toEqual(['third','second']);
    entries[1]={id:'replacement',source:'needle replacement',target:'',caseSensitive:false};await settle();expect(ids()).toEqual(['third','replacement']);
    entries.splice(0,1);await settle();expect(ids()).toEqual(['replacement']);
    entries[0].target='changed';entries[0].source='gone';await settle();expect(ids()).toEqual([]);
    expect(state.selected.entries).toBe(entries);expect(requestConfigPatch).not.toHaveBeenCalled();
  });

  it('clears search on library selection and refreshes same-array and replacement authoritative hydration',async()=>{
    await mountSearch([{...fixture('first'),entries:[{id:'first-term',source:'needle first',target:'',caseSensitive:false}]},{...fixture('second'),entries:[{id:'second-term',source:'needle second',target:'',caseSensitive:false}]}]);
    await search('needle');expect(ids()).toEqual(['first-term']);state.selectLibrary('second');await settle();
    expect(state.query).toBe('');expect(ids()).toEqual(['second-term']);
    await search('needle');expect(ids()).toEqual(['second-term']);
    const authoritative=config.glossaryLibraries,entries=authoritative[1].entries;
    entries[0].source='changed';listeners.forEach(listener=>listener(config));await settle();expect(ids()).toEqual([]);
    entries[0].target='needle external';listeners.forEach(listener=>listener(config));await settle();expect(ids()).toEqual(['second-term']);expect(config.glossaryLibraries).toBe(authoritative);expect(config.glossaryLibraries[1].entries).toBe(entries);
    config.glossaryLibraries=[{...fixture('second'),entries:[{id:'replacement',source:'needle replaced',target:'',caseSensitive:false}]}];listeners.forEach(listener=>listener(config));await settle();expect(ids()).toEqual(['replacement']);
    config.glossaryLibraries=[];listeners.forEach(listener=>listener(config));await settle();expect(ids()).toEqual([]);
  });

  it('keeps entry ordering and resets pagination for new queries even when the match count stays equal',async()=>{
    await mountSearch([{...fixture('pages'),entries:Array.from({length:35},(_,index)=>({id:`term-${index}`,source:`source-${index}`,target:'common',caseSensitive:false}))}]);
    const next=()=>dom.document.querySelector(`[aria-label="${translate('glossary.nextPage','zh-CN')}"]`)!;
    next().dispatchEvent(new dom.window.Event('click',{bubbles:true}));await settle();expect(state.entryPage).toBe(1);expect(state.visibleEntries[0].id).toBe('term-30');
    await search('common');expect(state.entryPage).toBe(0);expect(state.filteredEntries).toHaveLength(35);
    next().dispatchEvent(new dom.window.Event('click',{bubbles:true}));await settle();expect(state.entryPage).toBe(1);
    await search('COMMON');expect(state.entryPage).toBe(0);expect(ids()).toEqual(Array.from({length:35},(_,index)=>`term-${index}`));
    expect(dom.document.querySelectorAll('.glossary-table tbody tr')).toHaveLength(30);
    next().dispatchEvent(new dom.window.Event('click',{bubbles:true}));await settle();state.selected.entries.splice(20);await settle();expect(state.entryPage).toBe(0);expect(state.visibleEntries).toHaveLength(20);
  });

  it.each(['',' \t\n\u00a0 '])('releases cached text on empty search %j and follows later entry replacement',async empty=>{
    await mountSearch([searchLibrary('release',35)]);await search('GLS-SOURCE');expect(state.filteredEntries).toHaveLength(35);expect(state.searchTexts).toHaveLength(35);
    const entries=state.selected.entries;await search(empty);expect(state.searchTexts).toEqual([]);expect(state.filteredEntries).toBe(entries);
    config.glossaryLibraries=[searchLibrary('release',2)];listeners.forEach(listener=>listener(config));await settle();expect(state.filteredEntries).toHaveLength(2);expect(state.searchTexts).toEqual([]);
    config.glossaryLibraries=[];listeners.forEach(listener=>listener(config));await settle();expect(state.filteredEntries).toEqual([]);expect(state.searchTexts).toEqual([]);
  });

  it('does not build search text when no library exists',async()=>{
    const probe=trackSearch();try{state.query='  GLS-QUERY-no-library  ';await settle();expect(state.filteredEntries).toEqual([]);expect(state.visibleEntries).toEqual([]);expect(probe.operations.joinedLower).toBe(0);}finally{probe.restore();}
  });
});

describe('GlossarySettings queued library mutation intents', () => {
  async function mountLibraries(libraries: GlossaryLibrary[]): Promise<{active: boolean}> {
    config.glossaryLibraries=libraries;app.unmount();const props=runtime.reactive({active:true});mountComponent(GlossarySettings,props);await settle();return props;
  }
  function publishLibraries(libraries: GlossaryLibrary[]): void {
    config.glossaryLibraries=libraries;listeners.forEach(listener=>listener({...config,glossaryLibraries:[...libraries]}));
  }
  const libraryIds=()=>config.glossaryLibraries.map(library=>library.id);
  function capacityLibraries(kind:'libraries'|'entries'):GlossaryLibrary[] {
    return Array.from({length:kind==='libraries'?20:10},(_,index)=>({...fixture(`remote-${index}`),entries:kind==='libraries'?[]:Array.from({length:500},(_,term)=>({id:`term-${term}`,source:`remote-${term}`,target:'远端',caseSensitive:false}))}));
  }
  function moveByButton(id:string,direction:number):void {
    const library=(state.libraries as GlossaryLibrary[]).find(item=>item.id===id)!;
    const label=translate(direction<0?'glossary.moveUp':'glossary.moveDown','zh-CN',{name:library.name});
    const button=[...dom.document.querySelectorAll('button')].find(item=>item.getAttribute('aria-label')===label)!;
    expect(button).toBeTruthy();button.dispatchEvent(new dom.window.Event('click',{bubbles:true}));
  }
  async function prepareImport(text='source,target\nqueued-term,排队译法',warnings=false):Promise<void>{
    state.openImport();state.importText=text;await settle();
    if(warnings){expect(state.importPreview.warnings.length).toBeGreaterThan(0);state.acceptWarnings=true;}
    expect(state.canImport).toBe(true);
  }
  it('preserves an external deletion after accepting addLibrary but before its queued request is sent',async()=>{
    await mountLibraries([fixture('delete-me'),fixture('keep-me')]);
    const saving=state.addLibrary();expect(state.busy).toBe(true);expect(requestConfigPatch).not.toHaveBeenCalled();
    publishLibraries([config.glossaryLibraries[1]]);expect(state.libraries.map((library:GlossaryLibrary)=>library.id)).toEqual(['keep-me']);expect(requestConfigPatch).not.toHaveBeenCalled();
    await saving;expect(libraryIds()).not.toContain('delete-me');expect(libraryIds()).toContain('keep-me');expect(config.glossaryLibraries).toHaveLength(2);expect(state.busy).toBe(false);
  });
  it.each(['insert','id-collision'])('rebases an accepted new library on external %s while retaining its accepted target language',async mode=>{
    await mountLibraries([fixture('keep')]);const intendedId=createGlossaryLibrary(config.glossaryLibraries).id;
    const saving=state.addLibrary();expect(requestConfigPatch).not.toHaveBeenCalled();
    const remote={...fixture(mode==='id-collision'?intendedId:'remote'),name:'新术语库',targetLanguage:'de'};
    config.to='ja';publishLibraries([...config.glossaryLibraries,remote]);await saving;
    expect(config.glossaryLibraries.find(library=>library.id===remote.id)).toEqual(remote);expect(config.glossaryLibraries).toHaveLength(3);
    const added=config.glossaryLibraries.find(library=>library.id!=='keep'&&library.id!==remote.id)!;
    expect(added).toMatchObject({name:'新术语库 2',targetLanguage:'zh-hans',entries:[]});expect(new Set(libraryIds()).size).toBe(3);expect(state.selectedId).toBe(added.id);
  });
  it('rejects newly reached library capacity without truncation and permits a later add retry',async()=>{
    await mountLibraries([fixture('keep')]);const saving=state.addLibrary();const full=capacityLibraries('libraries');publishLibraries(full);await saving;
    expect(config.glossaryLibraries).toEqual(full);expect(requestConfigPatch).not.toHaveBeenCalled();expect(state.error).toContain('超出容量');expect(state.busy).toBe(false);expect(state.saved).toBe(false);
    publishLibraries(full.slice(0,19));await state.addLibrary();expect(config.glossaryLibraries).toHaveLength(20);expect(state.error).toBe('');expect(state.saved).toBe(true);
  });
  it('reuses an externally installed builtin at full capacity without replacing its customization',async()=>{
    await mountLibraries([fixture('keep')]);const saving=state.addBuiltin('ai-en-zh-hans');
    const full=capacityLibraries('libraries');full[7]={...full[7],name:'remote customized builtin',preset:{id:'ai-en-zh-hans',version:2},entries:[{id:'remote-term',source:'artificial intelligence',target:'外部定制',caseSensitive:true}]};
    publishLibraries(full);await saving;expect(config.glossaryLibraries).toEqual(full);expect(requestConfigPatch).not.toHaveBeenCalled();expect(state.selectedId).toBe(full[7].id);expect(state.error).toBe('');expect(state.busy).toBe(false);
  });
  it('adds a builtin to the latest list without restoring a library removed after acceptance',async()=>{
    await mountLibraries([fixture('deleted')]);const saving=state.addBuiltin('ai-en-zh-hans');publishLibraries([fixture('remote')]);await saving;
    expect(libraryIds()).toContain('remote');expect(libraryIds()).not.toContain('deleted');expect(config.glossaryLibraries).toHaveLength(2);expect(config.glossaryLibraries[1].preset?.id).toBe('ai-en-zh-hans');
  });
  it.each(['libraries','entries'] as const)('rechecks builtin %s capacity when its accepted queue task executes',async kind=>{
    await mountLibraries([]);const saving=state.addBuiltin('ai-en-zh-hans');const full=capacityLibraries(kind);publishLibraries(full);await saving;
    expect(config.glossaryLibraries).toEqual(full);expect(requestConfigPatch).not.toHaveBeenCalled();expect(state.error).toContain('超出容量');expect(state.busy).toBe(false);expect(state.saved).toBe(false);
  });
  it.each([
    {mode:'prepend',remote:['remote','a','b','c'],expected:['remote','b','a','c']},
    {mode:'delete-other',remote:['a','b'],expected:['b','a']},
    {mode:'new-neighbor',remote:['a','remote','b','c'],expected:['a','b','remote','c']},
  ])('moves the accepted library identity one current step after external $mode',async({remote,expected})=>{
    await mountLibraries([fixture('a'),fixture('b'),fixture('c')]);moveByButton('b',-1);expect(state.busy).toBe(true);expect(requestConfigPatch).not.toHaveBeenCalled();
    publishLibraries(remote.map(id=>fixture(id)));await settle();expect(libraryIds()).toEqual(expected);expect(state.busy).toBe(false);
  });
  it.each([
    {mode:'removed',remote:['a','c','remote']},
    {mode:'already at boundary',remote:['b','a','c','remote']},
  ])('treats an accepted move as a successful no-op when its library is $mode',async({remote})=>{
    await mountLibraries([fixture('a'),fixture('b'),fixture('c')]);moveByButton('b',-1);publishLibraries(remote.map(id=>fixture(id)));await settle();
    expect(libraryIds()).toEqual(remote);expect(requestConfigPatch).not.toHaveBeenCalled();expect(state.error).toBe('');expect(state.saved).toBe(false);expect(state.busy).toBe(false);
  });
  it.each(['delete','insert','id-collision'])('merges accepted import content with external %s and regenerates conflicting library identities',async mode=>{
    await mountLibraries([fixture('original')]);await prepareImport();const intendedId=createGlossaryLibrary(config.glossaryLibraries).id;
    const saving=state.confirmImport();expect(requestConfigPatch).not.toHaveBeenCalled();
    const remote=fixture(mode==='id-collision'?intendedId:'remote');publishLibraries(mode==='delete'?[remote]:[...config.glossaryLibraries,remote]);await saving;
    expect(config.glossaryLibraries.find(library=>library.id===remote.id)).toEqual(remote);if(mode==='delete')expect(libraryIds()).not.toContain('original');
    expect(config.glossaryLibraries.flatMap(library=>library.entries).filter(entry=>entry.source==='queued-term')).toHaveLength(1);expect(new Set(libraryIds()).size).toBe(config.glossaryLibraries.length);expect(state.importOpen).toBe(false);expect(state.busy).toBe(false);
  });
  it.each(['libraries','entries'] as const)('rejects accepted import when latest %s capacity is exhausted without truncating the remote list',async kind=>{
    await mountLibraries([]);await prepareImport();const saving=state.confirmImport();const full=capacityLibraries(kind);publishLibraries(full);await saving;
    expect(config.glossaryLibraries).toEqual(full);expect(requestConfigPatch).not.toHaveBeenCalled();expect(state.importOpen).toBe(true);expect(state.importText).toContain('queued-term');expect(state.error).toContain('超出容量');expect(state.busy).toBe(false);
  });
  it.each(['text','format','warning','reopened-dialog'])('keeps accepted import content and preserves newer %s intent after its acknowledgement',async mode=>{
    await mountLibraries([fixture('original')]);await state.editEntry();state.entryDraft.source='retained entry draft';const draft=state.entryDraft;
    await prepareImport(mode==='warning'?'source,target,note\nqueued-term,排队译法,extra':'source,target\nqueued-term,排队译法',mode==='warning');
    let release!:()=>void;requestConfigPatch.mockImplementationOnce(async patch=>{await new Promise<void>(resolve=>{release=resolve;});Object.assign(config,patch);listeners.forEach(listener=>listener(config));});
    const saving=state.confirmImport();await settle();expect(requestConfigPatch).toHaveBeenCalledOnce();
    if(mode==='text')state.importText='source,target\nnewer-term,新草稿';
    else if(mode==='format')state.importFormat='tsv';
    else if(mode==='warning')state.acceptWarnings=false;
    else {state.importOpen=false;await settle();state.openImport();state.importText='source,target\nnewer-term,新窗口草稿';}
    await settle();release();await saving;await settle();
    expect(config.glossaryLibraries.flatMap(library=>library.entries).filter(entry=>entry.source==='queued-term')).toHaveLength(1);expect(config.glossaryLibraries.flatMap(library=>library.entries).some(entry=>entry.source==='newer-term')).toBe(false);
    expect(state.importOpen).toBe(true);expect(state.selectedId).toBe('original');expect(state.entryDraft).toBe(draft);
    if(mode==='text'||mode==='reopened-dialog')expect(state.importText).toContain('newer-term');else if(mode==='format')expect(state.importFormat).toBe('tsv');else expect(state.acceptWarnings).toBe(false);
  });
  it.each(['add','builtin','import'].flatMap(operation=>['hidden','unmounted'].map(mode=>({operation,mode}))))('finishes an accepted $operation against live config while $mode without restoring deleted data',async({operation,mode})=>{
    const props=await mountLibraries([fixture('deleted')]);if(operation==='import')await prepareImport();const before=state.selectedId;
    const saving=operation==='add'?state.addLibrary():operation==='builtin'?state.addBuiltin('ai-en-zh-hans'):state.confirmImport();
    if(mode==='hidden')props.active=false;else app.unmount();
    publishLibraries([fixture('remote')]);await saving;
    expect(libraryIds()).toContain('remote');expect(libraryIds()).not.toContain('deleted');expect(config.glossaryLibraries).toHaveLength(2);
    const added=config.glossaryLibraries.find(library=>library.id!=='remote')!;
    if(operation==='builtin')expect(added.preset?.id).toBe('ai-en-zh-hans');else if(operation==='import')expect(added.entries[0].source).toBe('queued-term');else expect(added.entries).toEqual([]);
    if(mode==='unmounted')expect(state.selectedId).toBe(before);else {props.active=true;await settle();expect(state.selected).toBeTruthy();expect(state.busy).toBe(false);}
  });
  it.each(['add','builtin'])('preserves a newer library selection and its cached entry draft when an older %s acknowledgement returns',async mode=>{
    await mountLibraries([fixture('a'),fixture('b')]);state.selectLibrary('b');await state.editEntry();state.entryDraft.source='retained b draft';const draft=state.entryDraft;state.selectLibrary('a');
    let release!:()=>void;requestConfigPatch.mockImplementationOnce(async patch=>{await new Promise<void>(resolve=>{release=resolve;});Object.assign(config,patch);listeners.forEach(listener=>listener(config));});
    const saving=mode==='add'?state.addLibrary():state.addBuiltin('ai-en-zh-hans');await settle();state.selectLibrary('b');expect(state.entryDraft).toBe(draft);release();await saving;
    expect(state.selectedId).toBe('b');expect(state.entryDraft).toBe(draft);expect(state.entryDraft.source).toBe('retained b draft');expect(config.glossaryLibraries).toHaveLength(3);
  });
  it('serializes an accepted add and a captured library edit while hidden without retargeting the edit to the new selection',async()=>{
    const props=await mountLibraries([fixture('original')]);await state.editEntry();state.entryDraft.source='retained original draft';const draft=state.entryDraft;
    let release!:()=>void;requestConfigPatch.mockImplementationOnce(async patch=>{await new Promise<void>(resolve=>{release=resolve;});Object.assign(config,patch);listeners.forEach(listener=>listener(config));});
    const adding=state.addLibrary();await settle();const editing=state.patchLibrary({name:'original renamed'});props.active=false;release();await Promise.all([adding,editing]);
    expect(config.glossaryLibraries).toHaveLength(2);expect(config.glossaryLibraries.find(library=>library.id==='original')?.name).toBe('original renamed');expect(config.glossaryLibraries.find(library=>library.id!=='original')?.name).toBe('新术语库');
    props.active=true;await settle();state.selectLibrary('original');expect(state.entryDraft).toBe(draft);expect(state.busy).toBe(false);
  });
  it('keeps an existing entry draft after an add storage failure and safely retries the same user intent',async()=>{
    await mountLibraries([fixture('original')]);await state.editEntry();state.entryDraft.source='retained original draft';const draft=state.entryDraft;
    requestConfigPatch.mockRejectedValueOnce(new Error('storage unavailable'));await state.addLibrary();
    expect(libraryIds()).toEqual(['original']);expect(state.entryDraft).toBe(draft);expect(state.error).toContain('保存失败');expect(state.busy).toBe(false);expect(state.saved).toBe(false);
    await state.addLibrary();expect(config.glossaryLibraries).toHaveLength(2);expect(state.error).toBe('');expect(state.saved).toBe(true);state.selectLibrary('original');expect(state.entryDraft).toBe(draft);
  });
  it('does not continue an empty-library startEntry in another selected library after its older add acknowledgement',async()=>{
    await mountLibraries([]);let release!:()=>void;
    requestConfigPatch.mockImplementationOnce(async patch=>{
      await new Promise<void>(resolve=>{release=resolve;});
      // The acknowledged snapshot includes both the accepted creation and later external libraries.
      const created=patch.glossaryLibraries as GlossaryLibrary[];
      publishLibraries([...created,...config.glossaryLibraries.filter(library=>!created.some(item=>item.id===library.id))]);
    });
    const starting=state.startEntry('captured source');await settle();publishLibraries([fixture('remote-a'),fixture('remote-b')]);state.selectLibrary('remote-b');release();await starting;await settle();
    expect(state.selectedId).toBe('remote-b');expect(state.entryDraft).toBeNull();expect(dom.document.querySelector('input[required]')).toBeNull();expect(config.glossaryLibraries).toHaveLength(3);
  });
  it.each(['selection-aba','draft-replacement'])('rejects an older editEntry confirmation after %s without replacing or focusing the newer draft',async mode=>{
    await mountLibraries([fixture('a'),fixture('b')]);await state.editEntry();state.entryDraft.source='retained draft';
    let release!:()=>void;confirm.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    const input=dom.document.querySelector<HTMLInputElement>('input[required]')!;const focus=vi.spyOn(input,'focus').mockImplementation(()=>undefined);
    try {
      const editing=state.editEntry(state.selected.entries[0]);expect(confirm).toHaveBeenCalledOnce();
      if(mode==='selection-aba'){state.selectLibrary('b');state.selectLibrary('a');}else state.entryDraft={...state.entryDraft,id:'newer-draft',source:'newer draft'};
      const retained=state.entryDraft;release();await editing;await settle();expect(state.entryDraft).toBe(retained);expect(state.entryDraft.source).toBe(mode==='selection-aba'?'retained draft':'newer draft');expect(focus).not.toHaveBeenCalled();
    } finally {focus.mockRestore();}
  });
  it.each(['selection-aba','draft-replacement'])('does not focus or fill a newer draft after a startEntry nextTick %s',async mode=>{
    await mountLibraries([fixture('a'),fixture('b')]);
    const focus=vi.spyOn(dom.window.HTMLElement.prototype,'focus').mockImplementation(()=>undefined);
    try {
      const starting=state.startEntry('captured source');expect(state.entryDraft).toBeTruthy();
      if(mode==='selection-aba'){state.selectLibrary('b');state.selectLibrary('a');}else state.entryDraft={...state.entryDraft,id:'newer-draft',source:'newer draft'};
      const retained=state.entryDraft;const source=retained.source;await starting;await settle();expect(state.entryDraft).toBe(retained);expect(state.entryDraft.source).toBe(source);expect(focus).not.toHaveBeenCalled();
    } finally {focus.mockRestore();}
  });
});

describe('Glossary integration and user-content boundaries', () => {
  it('gives every branded select and pagination control an exact accessible name', () => {
    const component = readFileSync(resolve(process.cwd(), 'src/features/glossary/ui/GlossarySettings.vue'), 'utf8');
    const selects = component.match(/<ElSelect\b[^>]*>/gu) || [];
    expect(selects).toHaveLength(7);
    for (const select of selects) expect(select).toContain(':aria-label="t(\'glossary.');
    expect(selects.filter(select => select.includes("t('glossary.sourceLanguage')"))).toHaveLength(2);
    expect(selects.filter(select => select.includes("t('glossary.targetLanguage')"))).toHaveLength(2);
    expect(selects.find(select => select.includes('v-model="importFormat"'))).toContain(':aria-label="t(\'glossary.format\')"');
    expect(component.match(/<textarea\b[^>]*@change="updateDomains"[^>]*>/u)?.[0]).toContain(':aria-label="t(\'glossary.domains\')"');
    for (const key of ['glossary.previousPage', 'glossary.nextPage']) {
      expect(component).toContain(`:aria-label="t('${key}')"`);
      for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) expect(translate(key, language)).not.toBe(key);
    }
  });

  it('distinguishes glossary-only profile overrides in the real collapsed summary and keeps inheritance unchanged', async () => {
    const {default: component} = await import('@/src/features/settings/ui/QuickTranslationProfiles.vue');
    app.unmount();
    const profileConfig = runtime.reactive(Object.assign(new Config(), {glossaryLibraries: [fixture('技术'), fixture('产品')]}));
    const profile = {...createQuickTranslationProfile('hover'), enabled: true, hotkey: 'Control+1'};
    mountComponent(component, {config: profileConfig, action: 'hover', profiles: [profile]});
    const summary = state;
    for (const inherited of [profile, {...profile, glossaryIds: null}]) {
      expect(summary.hasProfileOverrides(inherited)).toBe(false);
      expect(summary.profileSummaryTitle(inherited)).toBe(translate('quickTranslation.useDefaults', 'zh-CN'));
      expect(summary.profileSummaryDetail(inherited)).not.toContain('术语库');
    }
    const disabled = {...profile, glossaryIds: []};
    expect(summary.hasProfileOverrides(disabled)).toBe(true);
    expect(summary.profileSummaryTitle(disabled)).not.toBe(translate('quickTranslation.useDefaults', 'zh-CN'));
    expect(summary.profileSummaryDetail(disabled)).toContain(translate('glossary.none', 'zh-CN'));
    expect(summary.profileSummaryDetail({...profile, glossaryIds: ['技术']})).toContain('术语库: 技术');
    expect(summary.profileSummaryDetail({...profile, glossaryIds: ['产品']})).toContain('术语库: 产品');
    profileConfig.glossaryLibraries[0].name = '技术新版';
    expect(summary.profileSummaryDetail({...profile, glossaryIds: ['技术', 'missing']})).toContain('术语库: 技术新版, missing');
  });

  it('reuses the branded three-state selector across profiles, documents, and subtitle settings', () => {
    const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
    for (const path of ['src/features/settings/ui/QuickTranslationProfiles.vue', 'src/app/document-translation/DocumentApp.vue', 'src/features/settings/ui/SettingsSections.vue']) {
      expect(source(path)).toContain('GlossaryLibrarySelect');
    }
    const selector = source('src/ui/components/GlossaryLibrarySelect.vue');
    expect(selector).toContain('<UiSelect'); expect(selector).toContain('type="checkbox"');
    for (const mode of ['inherit', 'none', 'selected']) expect(selector).toContain(`value="${mode}"`);
    expect(selector).not.toContain('<el-select');
    expect(source('src/features/glossary/ui/GlossarySettings.vue')).toContain('data-i18n-ignore');
    expect(source('src/features/glossary/ui/GlossarySettings.vue')).not.toContain('v-html');
  });
});

describe('Glossary real template workflows', () => {
  const tr = (key: string) => translate(key, 'zh-CN');
  async function click(node: Element | null): Promise<void> {expect(node).toBeTruthy();expect(node!.hasAttribute('disabled')).toBe(false);node!.dispatchEvent(new dom.window.Event('click', {bubbles: true}));await settle();}
  function button(key: string, root: ParentNode = document): Element | null {return [...root.querySelectorAll('button')].find(node => node.textContent?.trim() === tr(key)) || null;}
  async function input(node: Element | null, value: string, event = 'input'): Promise<void> {expect(node).toBeTruthy();(node as HTMLInputElement).value = value;node!.dispatchEvent(new dom.window.Event(event, {bubbles: true}));await settle();}

  it.each(['library', 'entry'] as const)('does not delete a %s after its pending confirmation outlives the component', async kind => {
    await state.persist({glossaryLibraries: [fixture()]});
    let release!: () => void;
    confirm.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;}));
    const deleting = kind === 'library' ? state.deleteLibrary() : state.deleteEntry(state.selected.entries[0]);
    const calls = requestConfigPatch.mock.calls.length;
    app.unmount();release();await deleting;
    expect(requestConfigPatch).toHaveBeenCalledTimes(calls);
    expect(config.glossaryLibraries).toHaveLength(1);expect(config.glossaryLibraries[0].entries).toEqual(fixture().entries);
  });

  it('previews bundled terms, filters locally, closes and adds an editable copy through its actual parent event', async () => {
    const card = document.querySelector('[data-testid="builtin-ai-en-zh-hans"]')!;
    await click(button('glossary.builtin.preview', card));
    const preview = () => document.querySelector('[data-testid="builtin-glossary-preview"]');
    expect(preview()!.textContent).toContain('artificial intelligence');
    await input(preview()!.querySelector('input'), 'zz-no-actual-term');
    expect(preview()!.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(preview()!.textContent).toContain(tr('glossary.noResults'));
    await input(preview()!.querySelector('input'), ' artificial intelligence ');
    expect(preview()!.querySelectorAll('tbody tr')).toHaveLength(1);
    await click(button('common.close', preview()!));expect(preview()).toBeNull();
    await click(button('glossary.builtin.preview', card));expect(preview()!.querySelectorAll('tbody tr')).toHaveLength(65);
    await click(button('glossary.builtin.add', preview()!));
    expect(preview()).toBeNull();expect(config.glossaryLibraries[0].preset?.id).toBe('ai-en-zh-hans');expect(config.glossaryEnabled).toBe(false);
    await click(button('glossary.builtin.preview', card));await click(document.querySelector('[data-dialog-close]'));expect(preview()).toBeNull();
    await click(button('glossary.builtin.manage', card));expect(config.glossaryLibraries).toHaveLength(1);
    await click(document.querySelector('[role="switch"]'));expect(config.glossaryEnabled).toBe(true);
  });

  it('edits a term and scope through inputs, keeps pagination and search consistent, and restores disabled libraries', async () => {
    const library = {...fixture(), entries: Array.from({length: 32}, (_, i) => ({id: `term-${i}`, source: `source-${i}`, target: `译法-${i}`, caseSensitive: false}))};
    await state.persist({glossaryLibraries: [library, fixture('second')]});
    const libraryId = config.glossaryLibraries[0].id;
    await click(document.querySelector(`[aria-label="${tr('glossary.nextPage')}"]`));expect(document.querySelector('.glossary-table tbody')!.textContent).toContain('source-31');
    await click(document.querySelector(`[aria-label="${tr('glossary.previousPage')}"]`));expect(document.querySelector('.glossary-pagination')!.textContent).toContain('1/2');
    await input(document.querySelector('.glossary-search input'), 'no-match');await click(button('glossary.clearSearch'));
    await click(button('glossary.addEntry'));
    await input(document.querySelector('.glossary-entry-form input[required]'), 'from-dom');
    await input(document.querySelector('.glossary-entry-form input[aria-label]'), '来自控件');
    const sensitive = document.querySelector('.glossary-entry-form input[type="checkbox"]') as HTMLInputElement;sensitive.checked = true;sensitive.dispatchEvent(new dom.window.Event('change', {bubbles: true}));
    document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true}));await settle();
    expect(config.glossaryLibraries[0].entries.at(-1)).toMatchObject({source: 'from-dom', target: '来自控件', caseSensitive: true});
    await click(document.querySelector('.glossary-settings-toggle'));
    await input(document.querySelector(`#glossary-library-settings [aria-label="${tr('glossary.sourceLanguage')}"]`), 'en');
    await input(document.querySelector(`#glossary-library-settings [aria-label="${tr('glossary.targetLanguage')}"]`), 'zh-hant');
    expect(config.glossaryLibraries[0]).toMatchObject({sourceLanguage: 'en', targetLanguage: 'zh-hant'});
    const enabled = document.querySelector('#glossary-library-settings input[type="checkbox"]') as HTMLInputElement;enabled.checked = false;enabled.dispatchEvent(new dom.window.Event('change', {bubbles: true}));await settle();
    await click(button('glossary.libraryEnabled'));expect(config.glossaryLibraries[0].enabled).toBe(true);
    await input(document.querySelector('.glossary-library-picker input'), 'second');expect(state.selectedId).toBe('second');
    await click(document.querySelector('.glossary-library-name'));expect(state.selectedId).toBe(libraryId);
    const order = document.querySelectorAll('.glossary-library-order button');await click(order[1]);expect(config.glossaryLibraries[1].id).toBe(libraryId);
    await click(document.querySelectorAll('.glossary-library-order button')[2]);expect(config.glossaryLibraries[0].id).toBe(libraryId);
  });

  it.each(['CSV','TSV','JSON'])('exports a real library as %s and always releases the object URL', async format => {
    await state.persist({glossaryLibraries: [fixture('a/b')]});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:glossary-export');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchorClick = vi.spyOn(dom.window.HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      expect(this.getAttribute('download')).toBe(`a_b.${format.toLowerCase()}`);
    });
    await input(document.querySelector(`[aria-label="${tr('glossary.exportFormat')}"]`), format);
    await click(button('glossary.export'));
    const blob = create.mock.calls[0][0] as Blob;expect(await blob.text()).toContain('token');
    expect(revoke).toHaveBeenCalledWith('blob:glossary-export');
    anchorClick.mockRestore();create.mockRestore();revoke.mockRestore();
  });

  it('releases the glossary download URL when the click fails', async () => {
    await state.persist({glossaryLibraries: [fixture('private')]});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:glossary-sensitive');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchor = vi.spyOn(dom.window.HTMLElement.prototype, 'click').mockImplementation(() => {throw new Error('download failed');});
    try {
      await click(button('glossary.export'));
      expect(create).toHaveBeenCalledOnce();expect(revoke).toHaveBeenCalledWith('blob:glossary-sensitive');
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(tr('glossary.exportFailed'));
      anchor.mockImplementation(() => {});await click(button('glossary.export'));
      expect(create).toHaveBeenCalledTimes(2);expect(revoke).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally {anchor.mockRestore();create.mockRestore();revoke.mockRestore();}
  });

  it('shows a recoverable fixed error when creating the glossary URL fails', async () => {
    await state.persist({glossaryLibraries: [fixture('private')]});
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {throw new Error('sensitive detail');});
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      await click(button('glossary.export'));
      expect(revoke).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(tr('glossary.exportFailed'));
      expect(document.body.textContent).not.toContain('sensitive detail');
    } finally {create.mockRestore();revoke.mockRestore();}
  });

  it('attempts cleanup after a synchronous unmount without publishing a stale export error', async () => {
    await state.persist({glossaryLibraries: [fixture('private')]});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:glossary-sensitive');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const anchor = vi.spyOn(dom.window.HTMLElement.prototype, 'click').mockImplementation(() => {app.unmount();throw new Error('late');});
    try {
      await click(button('glossary.export'));expect(revoke).toHaveBeenCalledWith('blob:glossary-sensitive');
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally {anchor.mockRestore();create.mockRestore();revoke.mockRestore();}
  });

  it('does not turn a successful glossary download into an error when cleanup throws', async () => {
    await state.persist({glossaryLibraries: [fixture('private')]});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:glossary-sensitive');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {throw new Error('cleanup');});
    const anchor = vi.spyOn(dom.window.HTMLElement.prototype, 'click').mockImplementation(() => {});
    try {
      await click(button('glossary.export'));expect(revoke).toHaveBeenCalledWith('blob:glossary-sensitive');
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally {anchor.mockRestore();create.mockRestore();revoke.mockRestore();}
  });

  it('keeps a newer synchronously reentered export success when the older click fails', async () => {
    await state.persist({glossaryLibraries: [fixture('private')]});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:old').mockReturnValueOnce('blob:new');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});let nested = false;
    const anchor = vi.spyOn(dom.window.HTMLElement.prototype, 'click').mockImplementation(() => {
      if (!nested) {nested = true;button('glossary.export')!.dispatchEvent(new dom.window.Event('click', {bubbles:true}));throw new Error('old failed');}
    });
    try {
      await click(button('glossary.export'));expect(create).toHaveBeenCalledTimes(2);
      expect(revoke).toHaveBeenCalledWith('blob:old');expect(revoke).toHaveBeenCalledWith('blob:new');
      expect(document.querySelector('[role="alert"]')).toBeNull();
    } finally {anchor.mockRestore();create.mockRestore();revoke.mockRestore();}
  });

  it('keeps a newer synchronously reentered export failure when the older click succeeds', async () => {
    await state.persist({glossaryLibraries: [fixture('private')]});
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:old').mockReturnValueOnce('blob:new');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});let nested = false;
    const anchor = vi.spyOn(dom.window.HTMLElement.prototype, 'click').mockImplementation(() => {
      if (nested) throw new Error('new failed');
      nested = true;button('glossary.export')!.dispatchEvent(new dom.window.Event('click', {bubbles:true}));
    });
    try {
      await click(button('glossary.export'));expect(create).toHaveBeenCalledTimes(2);
      expect(revoke).toHaveBeenCalledWith('blob:old');expect(revoke).toHaveBeenCalledWith('blob:new');
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(tr('glossary.exportFailed'));
    } finally {anchor.mockRestore();create.mockRestore();revoke.mockRestore();}
  });

  it('adds and edits entries from the empty state, exposes duplicate recovery and deletes via actual table actions', async () => {
    await click(button('glossary.addEntry'));expect(config.glossaryLibraries).toHaveLength(1);
    await input(document.querySelector('input[required]'), 'unique-token');
    document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true}));await settle();
    const edit = document.querySelector('.glossary-table button');await click(edit);
    await input(document.querySelector('input[required]'), 'unique-token');await click(button('common.cancel'));
    await click(button('glossary.addEntry'));await input(document.querySelector('input[required]'), 'unique-token');
    await click(button('glossary.editExisting'));expect(document.querySelector('input[required]')).toHaveProperty('value', 'unique-token');
    await click(button('common.cancel'));await click(document.querySelectorAll('.glossary-table button')[1]);
    expect(config.glossaryLibraries[0].entries).toEqual([]);
    await click(button('glossary.newLibrary'));expect(config.glossaryLibraries).toHaveLength(2);
  });

  it('opens preview from the toolbar, checks scope and creates an unmatched term without calling a provider', async () => {
    await state.persist({glossaryLibraries: [fixture('first'), {...fixture('second'), entries: [{id:'second-entry',source:'token',target:'另一译法',caseSensitive:false}]}]});
    await click(button('glossary.preview'));
    const panel = () => document.querySelector('[data-testid="glossary-preview"]')!;
    await input(panel().querySelector('textarea'), 'token');expect(panel().querySelectorAll('tbody tr')).toHaveLength(1);expect(panel().textContent).toContain(tr('glossary.conflicts'));
    await input(panel().querySelector(`[aria-label="${tr('glossary.sourceLanguage')}"]`), 'en');
    await input(panel().querySelector(`[aria-label="${tr('glossary.targetLanguage')}"]`), 'ja');
    await input(panel().querySelector('input[type="url"]'), 'https://example.com/article');
    expect(panel().querySelectorAll('tbody tr')).toHaveLength(0);
    await click(panel().querySelector('.glossary-diagnostics button'));expect(panel()).toBeNull();
    await click(button('glossary.preview'));await input(panel().querySelector('textarea'), 'new-example');await click(button('glossary.addFromPreview', panel()));
    expect(document.querySelector('input[required]')).toHaveProperty('value', 'new-example');await click(button('common.cancel'));
    await click(button('glossary.preview'));await click(document.querySelector('[data-dialog-close]'));expect(panel()).toBeNull();
    await click(button('glossary.preview'));
    config.glossaryLibraries = [];listeners.forEach(listener=>listener(config));await settle();
    await click(button('glossary.builtin.title', panel()));expect(dom.window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('imports through the actual text, format and warning controls, and closes both cancel routes', async () => {
    await click(button('glossary.import'));
    const panel = () => document.querySelector('.glossary-import-dialog')!;
    await input(panel().querySelector('textarea'), 'source,target,tgt_lng,note\nwidget,组件,zh-hans,extra');
    const warning = panel().querySelector('input[type="checkbox"]') as HTMLInputElement;expect(warning).toBeTruthy();warning.checked=true;warning.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();
    await click(button('glossary.confirmImport',panel()));expect(config.glossaryLibraries[0].entries[0].target).toBe('组件');expect(panel()).toBeNull();
    await click(button('glossary.import'));await input(panel().querySelector(`[aria-label="${tr('glossary.format')}"]`),'tsv');
    await input(panel().querySelector('textarea'),'source\ttarget\nsecond\t第二');expect(state.importFormat).toBe('tsv');
    await click(button('common.cancel',panel()));expect(panel()).toBeNull();
    await click(button('glossary.import'));await click(document.querySelector('[data-dialog-close]'));expect(panel()).toBeNull();
  });

  it('can start an entry if another page removes every library while preview is open', async () => {
    await state.persist({glossaryLibraries:[fixture('first')]});await click(button('glossary.preview'));
    config.glossaryLibraries=[];listeners.forEach(listener=>listener(config));await settle();
    const panel=document.querySelector('[data-testid="glossary-preview"]')!;
    await click(button('glossary.addEntry',panel));expect(document.querySelector('input[required]')).toBeTruthy();expect(config.glossaryLibraries).toHaveLength(1);
  });

  it.each(['duplicate','id-collision','library-capacity','total-capacity'])('merges an entry submission with external %s arriving before its queued write',async mode=>{
    await state.persist({glossaryLibraries:[{...fixture('editable'),entries:[]}]});
    await click(button('glossary.addEntry'));await input(document.querySelector('input[required]'),'new-local-term');
    const draftId=state.entryDraft.id;
    document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
    const remote=(id:string,source:string)=>({id,source,target:'远端',caseSensitive:false});
    if(mode==='duplicate') config.glossaryLibraries[0].entries=[remote('remote-id','new-local-term')];
    else if(mode==='id-collision') config.glossaryLibraries[0].entries=[remote(draftId,'remote-other-term')];
    else if(mode==='library-capacity') config.glossaryLibraries[0].entries=Array.from({length:500},(_,i)=>remote(`remote-${i}`,`remote-term-${i}`));
    else config.glossaryLibraries.push(...Array.from({length:10},(_,i)=>({...fixture(`remote-library-${i}`),entries:Array.from({length:500},(_,j)=>remote(`remote-${j}`,`remote-term-${j}`))})));
    listeners.forEach(listener=>listener(config));await settle();
    if(mode==='id-collision'){
      expect(config.glossaryLibraries[0].entries.map(e=>e.source)).toEqual(['remote-other-term','new-local-term']);
      expect(new Set(config.glossaryLibraries[0].entries.map(e=>e.id)).size).toBe(2);expect(document.querySelector('input[required]')).toBeNull();
    }else{
      expect(document.querySelector('input[required]')).toHaveProperty('value','new-local-term');
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(tr(mode==='duplicate'?'glossary.duplicateHelp':'glossary.capacity'));
    }
  });

  it.each(['libraries','entries'])('prevents adding a builtin at %s capacity while retaining preview and existing-library management',async mode=>{
    const list=Array.from({length:mode==='libraries'?20:10},(_,i)=>({...fixture(`capacity-${i}`),entries:mode==='libraries'?[]:Array.from({length:500},(_,j)=>({id:`term-${j}`,source:`term-${j}`,target:'译',caseSensitive:false}))}));
    list[0]={...list[0],preset:{id:'ai-en-zh-hans',version:2}} as typeof list[number];
    await state.persist({glossaryLibraries:list});
    const missing=document.querySelector('[data-testid="builtin-software-en-zh-hans"]')!;
    const add=button('glossary.builtin.add',missing)!;expect(add.hasAttribute('disabled')).toBe(true);
    const installed=document.querySelector('[data-testid="builtin-ai-en-zh-hans"]')!;
    await click(button('glossary.builtin.manage',installed));expect(config.glossaryLibraries).toHaveLength(list.length);
    await click(button('glossary.builtin.preview',missing));
    const preview=document.querySelector('[data-testid="builtin-glossary-preview"]')!;expect(button('glossary.builtin.add',preview)!.hasAttribute('disabled')).toBe(true);
  });


  it('keeps builtin preview available during save but emits an add only after the parent enables the action', async()=>{
    app.unmount();
    const props=runtime.reactive({libraries:[] as GlossaryLibrary[],enabled:false,disabled:true});const add=vi.fn();
    app=renderer.createApp({setup:()=>()=>runtime.h(BuiltinGlossaries,{...props,onAdd:add})});
    // ElDialog 默认在首次打开后保留已渲染的 slot；关闭时其子条件仍会更新。
    app.component('ElDialog',{props:['modelValue'],setup(dialogProps:any,{slots}:any){const opened=runtime.ref(false);runtime.watch(()=>dialogProps.modelValue,value=>{if(value)opened.value=true;},{immediate:true});return()=>opened.value?runtime.h('section',{role:dialogProps.modelValue?'dialog':undefined,hidden:!dialogProps.modelValue},slots.default?.()):null;}});
    app.mount(document.querySelector('main')!);await settle();
    const card=document.querySelector('[data-testid="builtin-ai-en-zh-hans"]')!;
    expect(button('glossary.builtin.add',card)!.hasAttribute('disabled')).toBe(true);
    await click(button('glossary.builtin.preview',card));
    const preview=document.querySelector('[data-testid="builtin-glossary-preview"]')!;expect(button('glossary.builtin.add',preview)!.hasAttribute('disabled')).toBe(true);expect(add).not.toHaveBeenCalled();
    props.disabled=false;await settle();await click(button('glossary.builtin.add',preview));expect(add).toHaveBeenCalledOnce();expect(add).toHaveBeenCalledWith('ai-en-zh-hans');
    props.enabled=true;props.libraries=[{...fixture('copy'),preset:{id:'ai-en-zh-hans',version:2}}];await settle();
    expect(document.querySelector('.builtin-disabled-note')).toBeNull();expect(button('glossary.builtin.manage',card)).toBeTruthy();
  });

});

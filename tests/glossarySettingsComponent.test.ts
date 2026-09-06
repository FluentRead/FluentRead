import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vue from '@vitejs/plugin-vue';
import {createServer, type Plugin, type ViteDevServer} from 'vite';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {translate} from '@/src/core/i18n';
import {GLOSSARY_LIMITS, normalizeGlossaryLibraries, type GlossaryLibrary} from '@/src/core/glossary';
import {Config} from '@/src/core/config/model';
import {createQuickTranslationProfile} from '@/src/core/config/quickTranslation';
import {compileScript, compileTemplate, parse} from 'vue/compiler-sfc';
import ts from 'typescript';

// 编译实际 SFC；文本字段回归同时执行模板绑定，原生焦点与 DOM 指令由隔离浏览器覆盖。
const stateKey = '__fluentReadGlossarySettingsTest';
const require = createRequire(import.meta.url);
const runtime = require('vue') as typeof import('vue');
let server: ViteDevServer;
let app: import('vue').App;
let renderer: import('vue').Renderer<Record<string, unknown>>;
let state: Record<string, any>;
let listeners: Set<(value: unknown) => void>;
let config: {glossaryEnabled: boolean; glossaryLibraries: GlossaryLibrary[]; to: string};
let requestConfigPatch: ReturnType<typeof vi.fn>;
let confirm: ReturnType<typeof vi.fn>;

type RenderElement = Record<string, any> & {tag: string; props: Record<string, any>; value?: string};
async function mountMetadataRender(): Promise<RenderElement[]> {
  const filename = resolve(process.cwd(), 'src/features/glossary/ui/GlossarySettings.vue');
  const {descriptor} = parse(readFileSync(filename, 'utf8'), {filename});
  const bindings = compileScript(descriptor, {id: 'glossary-render-test'}).bindings;
  const template = compileTemplate({source: descriptor.template!.content, filename, id: 'glossary-render-test',
    compilerOptions: {mode: 'function', bindingMetadata: bindings, expressionPlugins: ['typescript']}});
  expect(template.errors).toEqual([]);
  const renderCode = ts.transpileModule(template.code, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
  const loaded = await server.ssrLoadModule('/src/features/glossary/ui/GlossarySettings.vue');
  const component = loaded.default;
  // 保留真实模板的值绑定和事件；无关 v-model 的原生 DOM 指令交给浏览器回归。
  component.render = new Function('Vue', renderCode)({...runtime, vModelText: {}, vModelSelect: {}, vModelCheckbox: {}});
  app.unmount();
  const elements: RenderElement[] = [];
  const host = runtime.createRenderer<RenderElement, RenderElement>({
    patchProp: (node, key, _previous, value) => {node.props[key] = value; if (key === 'value') node.value = String(value ?? '');},
    insert: () => undefined, remove: () => undefined,
    createElement: tag => {const node = {tag, props: {}}; elements.push(node); return node;},
    createText: () => ({tag: '#text', props: {}}), createComment: () => ({tag: '#comment', props: {}}),
    setText: () => undefined, setElementText: (node, value) => {node.text = value;}, parentNode: () => null, nextSibling: () => null,
    querySelector: () => null, setScopeId: () => undefined, cloneNode: node => ({...node}),
    insertStaticContent: () => [{tag: '#static', props: {}}, {tag: '#static', props: {}}],
  });
  app = host.createApp(component); app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  const vm = app.mount({tag: '#root', props: {}});
  state = (vm.$ as unknown as {setupState: Record<string, any>}).setupState;
  await settle();
  return elements;
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
function mocks(): Plugin {
  return {name: 'glossary-settings-mocks', enforce: 'pre', resolveId(id) {
    if (id === 'webextension-polyfill') return '\0glossary-browser';
    if (id.endsWith('/UiSelect.vue')) return '\0glossary-select';
    if (id === 'element-plus') return '\0glossary-element';
    if (/\/src\/services\/config\/store(?:\.ts)?$/u.test(id)) return '\0glossary-config';
    if (/\/src\/ui\/i18n(?:\.ts)?$/u.test(id)) return '\0glossary-i18n';
    return null;
  }, load(id) {
    if (id === '\0glossary-select') return `import {h} from 'vue'; export default {setup: (_, {slots}) => () => h('select', {}, slots.default?.())};`;
    if (id === '\0glossary-browser') return 'export default {runtime: {sendMessage: async () => undefined}}';
    if (id === '\0glossary-element') return `import {h} from 'vue'; export const ElSelect = {setup: (_, {slots}) => () => h('select', {}, slots.default?.())}; export const ElOption = {props: ['value', 'label'], setup: props => () => h('option', {value: props.value}, props.label)}; export const ElMessageBox = {confirm: globalThis.${stateKey}.confirm};`;
    if (id === '\0glossary-config') return `const s = globalThis.${stateKey}; export const config = s.config; export const configReady = s.configReady; export const requestConfigPatch = s.requestConfigPatch; export const subscribeConfig = s.subscribeConfig;`;
    if (id === '\0glossary-i18n') return `import {ref} from 'vue'; export const useUiI18n = () => ({language: ref('zh-CN'), t: globalThis.${stateKey}.translate, translateLegacy: text => text});`;
    return null;
  }};
}

beforeEach(async () => {
  config = {glossaryEnabled: false, glossaryLibraries: [], to: 'zh-Hans'};
  listeners = new Set(); confirm = vi.fn().mockResolvedValue('confirm');
  requestConfigPatch = vi.fn(async (patch) => {
    Object.assign(config, patch);
    config.glossaryLibraries = normalizeGlossaryLibraries(config.glossaryLibraries);
    listeners.forEach(listener => listener(config));
  });
  Object.assign(globalThis, {[stateKey]: {config, confirm, configReady: Promise.resolve(), requestConfigPatch,
    subscribeConfig: (listener: (value: unknown) => void) => {listeners.add(listener); return () => listeners.delete(listener);},
    translate: (key: string, params?: Record<string, string>) => translate(key, 'zh-CN', params)}});
  server = await createServer({appType: 'custom', configFile: false, logLevel: 'silent', plugins: [mocks(), vue()],
    resolve: {alias: {'@': resolve(process.cwd(), '.')}}, root: process.cwd(), server: {hmr: false, middlewareMode: true}, ssr: {noExternal: ['webextension-polyfill', 'element-plus']}});
  const loaded = await server.ssrLoadModule('/src/features/glossary/ui/GlossarySettings.vue');
  const component = loaded.default;
  component.ssrRender = undefined; component.render = () => null;
  renderer = runtime.createRenderer<Record<string, never>, Record<string, unknown>>({
    patchProp: () => undefined, insert: () => undefined, remove: () => undefined, createElement: () => ({}),
    createText: () => ({}), createComment: () => ({}), setText: () => undefined, setElementText: () => undefined,
    parentNode: () => null, nextSibling: () => null, querySelector: () => null, setScopeId: () => undefined,
    cloneNode: () => ({}), insertStaticContent: () => [{}, {}],
  });
  app = renderer.createApp(component); app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
  app.config.warnHandler = () => undefined;
  const vm = app.mount({});
  // Vue 的公开内部实例类型不暴露 setupState；仅此编译组件夹具读取真实 setup 返回值。
  state = (vm.$ as unknown as {setupState: Record<string, any>}).setupState;
  await settle();
});
afterEach(async () => {app?.unmount(); await server?.close(); delete (globalThis as any)[stateKey]; vi.unstubAllGlobals();});

describe('GlossarySettings compiled component', () => {
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
    for (const key of ['glossary.emptyTitle', 'glossary.emptyHelp', 'glossary.services', 'glossary.previewDisabled']) {
      expect(component).toContain(`t('${key}')`);
      for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) expect(translate(key, language)).not.toBe(key);
    }
    expect(translate('glossary.services', 'zh-CN')).toContain('qwen-mt');
    expect(translate('glossary.services', 'zh-CN')).toContain('机器翻译暂不应用');
    expect(translate('glossary.previewDisabled', 'zh-CN')).toContain('实际翻译不会使用');
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
    await state.addLibrary(); state.moveLibrary(1, -1); await settle();
    expect(config.glossaryLibraries[1].name).toBe('产品名');
    expect(requestConfigPatch.mock.calls.every(([patch]) => Object.keys(patch).every(key => ['glossaryLibraries', 'glossaryEnabled'].includes(key)))).toBe(true);
  });

  it('adds a real bundled word list, persists it without enabling the master switch, and opens rather than overwrites an edited copy', async () => {
    await state.addBuiltin('ai-en-zh-hans');
    expect(config.glossaryEnabled).toBe(false);
    expect(config.glossaryLibraries).toHaveLength(1);
    expect(state.selected).toMatchObject({name: 'AI 与机器学习', preset: {id: 'ai-en-zh-hans', version: 1}});
    expect(state.selected.entries).toHaveLength(60);
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
    expect(state.selected.preset).toEqual({id: 'ai-en-zh-hans', version: 1});
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

  it('requires confirmation before deletion and unsubscribes when unmounted', async () => {
    await state.addLibrary(); confirm.mockRejectedValueOnce('cancel'); await state.deleteLibrary();
    expect(config.glossaryLibraries).toHaveLength(1);
    await state.deleteLibrary(); expect(config.glossaryLibraries).toHaveLength(0);
    expect(confirm).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(1);
    app.unmount(); expect(listeners.size).toBe(0);
  });
});

describe('Glossary integration and user-content boundaries', () => {
  it('gives every branded select and pagination control an exact accessible name', () => {
    const component = readFileSync(resolve(process.cwd(), 'src/features/glossary/ui/GlossarySettings.vue'), 'utf8');
    const selects = component.match(/<ElSelect\b[^>]*>/gu) || [];
    expect(selects).toHaveLength(6);
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
    const loaded = await server.ssrLoadModule('/src/features/settings/ui/QuickTranslationProfiles.vue');
    const component = loaded.default;
    component.ssrRender = undefined; component.render = () => null;
    app.unmount();
    const profileConfig = runtime.reactive(Object.assign(new Config(), {glossaryLibraries: [fixture('技术'), fixture('产品')]}));
    const profile = {...createQuickTranslationProfile('hover'), enabled: true, hotkey: 'Control+1'};
    app = renderer.createApp(component, {config: profileConfig, action: 'hover', profiles: [profile]});
    app.provide(runtime.ssrContextKey, {modules: new Set<string>()});
    app.config.warnHandler = () => undefined;
    const vm = app.mount({});
    const summary = (vm.$ as unknown as {setupState: Record<string, any>}).setupState;
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

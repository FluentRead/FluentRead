/**
 * @file tests/promptEditorLifecycle.test.ts
 * 文件职责：验证实际提示词与输入框配置组件的组合输入、变量插入、配置归属和焦点生命周期。
 * 主要内容：执行真实缓存客户端模板与 DOM 事件，覆盖旧回调、字符容量、连续插入、有效配置选择和凭据读取范围；验证B站固定模型、免密钥提示、基础动作预览与默认动作临时回退、禁用动作偏好保留和完整AI切回恢复。
 * 模块边界：Linkedom 保留实际节点树，展示控件与焦点为受控端口；不调用翻译或验证系统输入法。
 */
import {parseHTML} from 'linkedom'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {createApiKeyRequirementKey} from '@/src/core/config/validation'
import {BILIBILI_FREE_TRANSLATION_MODEL} from '@/src/core/config/freeTranslation'

import * as runtime from 'vue'
import PromptTemplateEditor from '@/src/features/settings/ui/services/PromptTemplateEditor.vue'
import InputTranslationSettings from '@/src/features/settings/ui/InputTranslationSettings.vue'
import HarnessSettings from '@/src/features/settings/ui/HarnessSettings.vue'
import WritingSettings from '@/src/features/settings/ui/WritingSettings.vue'
let app: import('vue').App, document: Document, win: any, focused: Element | null
let state: Record<string, any>, props: Record<string, any>, shown: import('vue').Ref<boolean>
let events: Map<Element, Record<string, any>>
const updates = vi.fn(), focus = vi.fn(), selectionRange = vi.fn()
const promptPath = 'src/features/settings/ui/services/PromptTemplateEditor.vue', inputPath = 'src/features/settings/ui/InputTranslationSettings.vue'
const harnessPath = 'src/features/settings/ui/HarnessSettings.vue'
const writingPath = 'src/features/settings/ui/WritingSettings.vue'
const message = vi.hoisted(() => Object.assign(vi.fn(), {warning: vi.fn()}))
vi.mock('@/src/ui/i18n', () => ({useUiI18n: () => ({language: runtime.ref('zh-CN'), t: (key: string) => key, translateLegacy: (text: string) => text})}))
vi.mock('@/src/features/reading-assistant/public', () => ({ReadingAnswer: {render: () => runtime.h('div')}}))
vi.mock('element-plus', () => ({
  ElMessage: message,
  ElPopover: {setup(_: unknown, {attrs, slots}: any) {const instance = runtime.getCurrentInstance()!;return () => runtime.h('div', {...attrs, 'data-timing-port-key': instance.vnode.key}, [slots.reference?.(), slots.default?.()])}},
}))
vi.mock('@element-plus/icons-vue', () => ({ArrowDown: {}, Edit: {}, WarningFilled: {}}))
vi.mock('@/src/ui/components/CustomHotkeyInput.vue', () => ({__esModule: true, default: {setup(_: unknown, {attrs}: any) {
  return () => runtime.h('div', {...attrs, 'data-testid': 'input-custom-hotkey-dialog'})
}}}))
vi.mock('@/src/features/settings/ui/components/SettingsGroup.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/components/SettingsItem.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.description?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/ui/components/ServiceIcon.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/ui/components/FeatureEnableCard.vue', () => ({default: {props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, {emit}: any) {
  return () => runtime.h('input', {type: 'checkbox', 'data-feature-toggle': '', checked: props.modelValue, onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).checked)})
}}}))
vi.mock('@/src/features/settings/ui/components/WritingStylePreview.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/HarnessPromptSettings.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.copy?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/components/SettingsPreviewLayout.vue', () => ({default: {setup(_: unknown, {slots}: any) {return () => runtime.h('div', null, [slots.preview?.(), slots.default?.()])}}}))
vi.mock('@/src/features/settings/ui/components/SettingsNumberInput.vue', () => ({default: {props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, {attrs, emit}: any) {
  return () => runtime.h('input', {...attrs, value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', Number((event.target as HTMLInputElement).value))})
}}}))
vi.mock('@/src/features/settings/ui/components/SegmentedControl.vue', () => ({default: {props: ['modelValue', 'options', 'label'], emits: ['update:modelValue'], setup(props: any, {emit}: any) {
  return () => runtime.h('div', {'data-segmented': props.label}, props.options.map((item: {value: string; label: string}) => runtime.h('button', {'data-value': item.value, 'aria-pressed': props.modelValue === item.value, onClick: () => emit('update:modelValue', item.value)}, item.label)))
}}}))
async function settle() {await runtime.nextTick();await Promise.resolve();await runtime.nextTick()}
beforeEach(async () => {
  vi.clearAllMocks();events = new Map();const parsed = parseHTML('<html><body><div id="app"></div></body></html>');win = parsed.window;document = win.document;focused = document.body
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused})
  for (const [key, value] of Object.entries({document, window: win, HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLElement: win.HTMLElement, Event: win.Event, Node: win.Node})) vi.stubGlobal(key, value)

})
afterEach(async () => {app?.unmount();await settle();vi.unstubAllGlobals()})
async function mount(path: typeof promptPath | typeof inputPath | typeof harnessPath | typeof writingPath, values: Record<string, unknown>, listeners: Record<string, unknown> = {}) {
  const component = path === promptPath ? PromptTemplateEditor : path === inputPath ? InputTranslationSettings : path === harnessPath ? HarnessSettings : WritingSettings, source = runtime.shallowReactive({active: true, context: {}, contextKey: 'service-a', ...values});shown = runtime.ref(true)
  const renderer = runtime.createRenderer({patchProp(el: any, key: string, previous: any, next: any) {
    const handlers = events.get(el) || {};events.set(el, handlers)
    if (/^on[A-Z]/u.test(key)) {handlers[key] = next;const event = key.slice(2).toLowerCase();if (previous) el.removeEventListener(event, previous);if (next) el.addEventListener(event, next);return}
    if (key === 'value' || key === 'modelValue' || key === 'model-value') {el.value = next ?? '';return}
    if (key === 'class') {el.className = next ?? '';return}
    if (next === false || next === undefined || next === null) el.removeAttribute(key);else el.setAttribute(key, String(next))
  }, insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor), remove: (child: any) => child.parentNode?.removeChild(child),
    createElement: tag => {const el = document.createElement(tag) as any;el.focus = (options: unknown) => {focus(options);focused = el}
      if (tag === 'textarea') {el.selectionStart = 0;el.selectionEnd = 0;el.setSelectionRange = (start: number, end: number) => {selectionRange(start, end);el.selectionStart = start;el.selectionEnd = end}}
      return el}, createText: text => document.createTextNode(text), createComment: text => document.createComment(text), setText: (n: any, text: string) => {n.nodeValue = text},
    setElementText: (el: any, text: string) => {el.textContent = text}, parentNode: (n: any) => n.parentNode, nextSibling: (n: any) => n.nextSibling,
    querySelector: selector => document.querySelector(selector), setScopeId: () => {}, cloneNode: (n: any) => n.cloneNode(true),
    insertStaticContent: (html: string, parent: any, anchor: any) => {const t = document.createElement('template');t.innerHTML = html;const first = t.content.firstChild!, last = t.content.lastChild!;parent.insertBefore(t.content, anchor);return [first, last]}})
  app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => shown.value
    ? runtime.h(component as runtime.Component, {...source, ...listeners, ref: (vm: any) => {if (vm) {state = vm.$.setupState;props = vm.$.props}}}) : runtime.h({render: () => null}, {key: 'other'})})})
  const control = {setup(_props: unknown, {attrs, slots}: any) {return () => runtime.h('div', null, [runtime.h('input', attrs), slots.default?.()])}}
  app.component('el-input-number', control);app.component('el-select', control);app.component('el-option', {render: () => null})
  app.component('el-input', control);app.component('el-switch', control)
  app.component('el-button', {setup(_props: unknown, {attrs, slots}: any) {return () => runtime.h('button', attrs, slots.default?.())}})
  app.component('el-icon', {render: () => null})
  app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {};app.mount(document.getElementById('app')!);await settle()
}
async function mountPrompt(values: Record<string, unknown> = {}, listeners: Record<string, unknown> = {'onUpdate:modelValue': updates}) {await mount(promptPath, {role: 'user', modelValue: '', ...values}, listeners)}
function textarea() {return document.querySelector('textarea') as HTMLTextAreaElement}
function eventOf(el: Element, name: string) {const callback = events.get(el)?.[name];expect(callback, name).toBeTypeOf('function');return callback}
function control(id: string) {const el = document.querySelector(`[data-testid="${id}"]`)!;expect(el).not.toBeNull();return el}
function token(value = '{{to}}') {return document.querySelector(`[data-prompt-token="${value}"]`)!}
function input(value: string, composing = false, el = textarea()) {el.value = value;const event = new win.Event('input', {bubbles: true});Object.defineProperty(event, 'isComposing', {value: composing});el.dispatchEvent(event)}
function startComposition() {textarea().dispatchEvent(new win.Event('compositionstart', {bubbles: true}))}
function invalidate(reason: string) {
  if (reason === 'hidden') props.active = false
  if (reason === 'cached') shown.value = false
  if (reason === 'unmount') app.unmount()
  if (reason === 'context') props.context = {}
  if (reason === 'role') props.role = 'system'
  if (reason === 'external') props.modelValue = 'external'
  if (reason === 'config') props.config = runtime.reactive(new Config())
}
function profile() {const config = runtime.reactive(new Config());config.service = 'openai';config.inputBoxTranslationService = 'openai';config.model.openai = 'model-a';config.customModels.openai = ['model-a', 'model-b'];config.inputBoxTranslationTrigger = 'triple_space';return config}
const services = [{value: 'openai', label: 'OpenAI'}, {value: 'microsoft', label: 'Microsoft'}, {value: 'custom:input', label: 'Custom'}, {value: 'blocked', label: 'Blocked', disabled: true}]
async function mountInput(config = profile(), values: Record<string, unknown> = {}) {await mount(inputPath, {config, serviceOptions: services, ...values}, {'onTrigger-change': updates})}

describe('写作和阅读偏好的真实模板工作流', () => {
  function chooseWriting(label: string, text: string) {
    const group = document.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
    const button = [...group.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
    expect(button).toBeTruthy();button.click();
  }

  it('恢复单个网站、切换独立服务和语言，并通过真实风格选项保存自定义偏好', async () => {
    const config = profile();config.writing.enabled = false;config.writing.disabledDomains = ['one.test', 'two.test'];
    config.customOpenAIProviders = [{id: 'custom:writing', name: 'Writing service', endpoint: 'http://localhost:11434/v1', models: ['writer-a', 'writer-b']}];
    const navigate = vi.fn();await mount(writingPath, {config}, {'onConfigure-service': navigate});
    const enable = document.querySelector<HTMLInputElement>('[data-feature-toggle]')!;
    enable.checked = true;enable.dispatchEvent(new win.Event('change'));await settle();expect(config.writing.enabled).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-writing-disabled-site="one.test"] button')!.click();await settle();
    expect(config.writing.disabledDomains).toEqual(['two.test']);
    config.writing.model = 'old-model';
    const service = document.querySelector('[aria-label="写作服务"]')!;
    eventOf(service, 'onUpdate:modelValue')('custom:writing');eventOf(service, 'onChange')();await settle();
    expect(config.writing.model).toBe('');expect(config.service).toBe('openai');
    eventOf(document.querySelector('[aria-label="写作模型"]')!, 'onUpdate:modelValue')('writer-b');
    eventOf(document.querySelector('[aria-label="输出语言"]')!, 'onUpdate:modelValue')('en');
    eventOf(document.querySelector('[aria-label="writing.referenceLanguage"]')!, 'onUpdate:modelValue')('ja');await settle();
    expect(config.writing).toMatchObject({service: 'custom:writing', model: 'writer-b', language: 'en', referenceLanguage: 'ja'});
    document.querySelector<HTMLButtonElement>('.writing-model-label button')!.click();expect(navigate).toHaveBeenCalledOnce();
    for (const label of ['长度', '风格']) {
      const group = document.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!;
      const next = [...group.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-checked') !== 'true')!;
      next.click();await settle();expect(next.getAttribute('aria-checked')).toBe('true');
    }
    const {WRITING_TONE_MAX_LENGTH, WRITING_ROLE_MAX_LENGTH} = await import('@/src/core/config/writing');
    for (const [label, field, inputLabel, limit, fallback] of [['语气', 'tone', '自定义语气', WRITING_TONE_MAX_LENGTH, 'natural'], ['您的角色', 'role', '自定义角色', WRITING_ROLE_MAX_LENGTH, 'auto']] as const) {
      chooseWriting(label, '自定义');await settle();
      const input = document.querySelector(`[aria-label="${inputLabel}"]`)!;
      const update = eventOf(input, 'onUpdate:modelValue');
      update('patient\n' + 'x'.repeat(limit));await settle();
      expect(config.writing[field]).toBe(('patient ' + 'x'.repeat(limit)).slice(0, limit));
      update('patient\n' + 'x'.repeat(limit));await settle();
      update(' \u0000 ');await settle();expect(config.writing[field]).toBe(fallback);
      const preset = [...document.querySelectorAll<HTMLButtonElement>(`[role="radiogroup"][aria-label="${label}"] button`)].find(button => button.textContent !== '自定义')!;
      preset.click();await settle();expect(preset.getAttribute('aria-checked')).toBe('true');
      config.writing[field] = `External ${field}`;await settle();
      expect(document.querySelector<HTMLInputElement>(`[aria-label="${inputLabel}"]`)!.value).toBe(`External ${field}`);
    }
  });

  it('阅读预览、默认偏好、上下文范围和学习中心入口通过实际控件更新', async () => {
    const config = profile();config.harness.enabled = false;const navigate = vi.fn();
    await mount(harnessPath, {config}, {onNavigate: navigate});
    const enable = document.querySelector<HTMLInputElement>('[data-feature-toggle]')!;
    enable.checked = true;enable.dispatchEvent(new win.Event('change'));expect(config.harness.enabled).toBe(true);
    const preview = [...document.querySelectorAll<HTMLButtonElement>('.harness-preview-tabs button')].find(button => button.getAttribute('aria-pressed') !== 'true')!;
    preview.click();await settle();expect(preview.getAttribute('aria-pressed')).toBe('true');
    for (const [label, value, field] of [['解释深度', 'detailed', 'explanationDepth'], ['学习程度', 'advanced', 'learningLevel'], ['上下文范围', 'selection', 'contextMode']] as const) {
      document.querySelector<HTMLButtonElement>(`[data-segmented="${label}"] [data-value="${value}"]`)!.click();await settle();
      expect(config.harness[field]).toBe(value);
    }
    expect(document.querySelector('[aria-label="上下文上限"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-segmented="上下文范围"] [data-value="paragraph"]')!.click();await settle();
    const maximum = document.querySelector<HTMLInputElement>('[aria-label="上下文上限"]')!;
    maximum.value = '1600';maximum.dispatchEvent(new win.Event('input'));expect(config.harness.maxContextChars).toBe(1600);
    eventOf(document.querySelector('[aria-label="settings.memoryEnabled"]')!, 'onUpdate:modelValue')(true);
    expect(config.harness.memoryEnabled).toBe(true);
    document.querySelector<HTMLButtonElement>('.harness-memory-footer button')!.click();expect(navigate).toHaveBeenCalledWith('settings-vocabulary');
  });
});

describe('学习讲解服务设置的实际组件切换', () => {
  it('ChatGPT空静态目录仍显示全局和讲解直存slug，选择与服务切回不写自定义哨兵', async () => {
    const config = runtime.reactive(new Config());config.service = 'chatgptPlan';config.model.chatgptPlan = 'account-default';config.harness.model = 'account-reading'
    await mount(harnessPath, {config});expect(state.modelOptions).toEqual(['account-default', 'account-reading'])
    eventOf(document.querySelector('[aria-label="学习讲解模型"]')!, 'onUpdate:modelValue')('account-default')
    expect(config.harness.model).toBe('account-default');expect(config.customModel.chatgptPlan).toBeUndefined()
    const service = document.querySelector('[aria-label="学习讲解服务"]')!
    eventOf(service, 'onUpdate:modelValue')('openai');eventOf(service, 'onChange')();await settle()
    eventOf(service, 'onUpdate:modelValue')('chatgptPlan');eventOf(service, 'onChange')();await settle()
    expect(state.modelOptions).toEqual(['account-default']);expect(state.effectiveModel.model).toBe('account-default');expect(config.model.chatgptPlan).toBe('account-default')
  })
  it('ChatGPT写作选择器保留已保存专项slug和全局slug，显式模型选择保持直接保存', async () => {
    const config = runtime.reactive(new Config());config.writing.service = 'chatgptPlan';config.writing.model = 'account-writing';config.model.chatgptPlan = 'account-default'
    await mount(writingPath, {config});expect(state.modelOptions).toEqual(['account-default', 'account-writing'])
    const selector = document.querySelector('[aria-label="写作模型"]')!
    eventOf(selector, 'onUpdate:modelValue')('account-default');await settle()
    expect(config.writing.model).toBe('account-default');expect(config.model.chatgptPlan).toBe('account-default');expect(config.customModel.chatgptPlan).toBeUndefined()
    config.writing.service = 'openai';await settle();config.writing.service = 'chatgptPlan';await settle()
    expect(state.modelOptions).toEqual(['account-default']);expect(config.writing.model).toBe('account-default')
  })
  it('选择免费B站后显示固定模型与免密钥说明，保留默认关闭并可切回普通模型编辑', async () => {
    const config = runtime.reactive(new Config()); config.service = 'openai'; config.model.openai = 'reader'
    await mount(harnessPath, {config})
    expect(document.querySelector('.harness-fixed-model')).toBeNull()
    const selector = document.querySelector('[aria-label="学习讲解服务"]')!
    eventOf(selector, 'onUpdate:modelValue')('bilibili'); eventOf(selector, 'onChange')(); await settle()
    expect(config.harness.enabled).toBe(false); expect(config.harness.service).toBe('bilibili')
    expect(document.querySelector('.harness-fixed-model')?.textContent).toBe(BILIBILI_FREE_TRANSLATION_MODEL)
    expect(document.querySelector('.harness-free-hint')?.textContent).toContain('无需 API Key')
    expect(document.querySelector('[aria-label="学习讲解模型"]')?.tagName).toBe('DIV')
    expect(state.serviceOptions.find((item: any) => item.value === 'bilibili').label).toContain('免费')
    eventOf(selector, 'onUpdate:modelValue')('openai'); eventOf(selector, 'onChange')(); await settle()
    expect(document.querySelector('.harness-fixed-model')).toBeNull(); expect(document.querySelector('.harness-free-hint')).toBeNull()
    eventOf(document.querySelector('[aria-label="学习讲解模型"]')!, 'onUpdate:modelValue')('custom-reader')
    expect(config.harness.model).toBe('custom-reader')
  })
  it('跟随默认B站时同样显示固定模型，切换为不支持的机器服务后提示配置', async () => {
    const config = runtime.reactive(new Config()); config.service = 'bilibili'; config.harness.model = 'unused'
    await mount(harnessPath, {config})
    expect(document.querySelector('.harness-fixed-model')?.textContent).toBe(BILIBILI_FREE_TRANSLATION_MODEL)
    expect(document.querySelector('#harness-service-hint')).toBeNull()
    config.service = 'microsoft'; await settle()
    expect(document.querySelector('.harness-fixed-model')).toBeNull()
    expect(document.querySelector('#harness-service-hint')?.textContent).toContain('不能回答学习问题')
  })
  it('B站只预览基础动作并临时显示默认回退，禁用动作保留偏好且切回AI恢复', async () => {
    const config = runtime.reactive(new Config()); config.service = 'openai'; config.harness.defaultAction = 'grammar'
    const storedActions = [...config.harness.actions]
    await mount(harnessPath, {config})
    expect(state.previewAction).toBe('grammar')
    const selector = document.querySelector('[aria-label="学习讲解服务"]')!
    eventOf(selector, 'onUpdate:modelValue')('bilibili'); eventOf(selector, 'onChange')(); await settle()
    expect(state.visibleActions.map((action: any) => action.id)).toEqual(['meaning', 'usage'])
    expect(state.previewAction).toBe('meaning')
    expect((document.querySelector('[aria-label="默认动作"]') as HTMLInputElement).value).toBe('meaning')
    expect(document.querySelector('.harness-default-hint')?.textContent).toContain('恢复原默认动作')
    const inputs = [...document.querySelectorAll('.harness-actions input')]
    expect(inputs[1].hasAttribute('disabled')).toBe(true); expect(inputs[3].hasAttribute('disabled')).toBe(true)
    eventOf(inputs[1], 'onChange')(); state.toggleAction('practice')
    eventOf(document.querySelector('[aria-label="默认动作"]')!, 'onUpdate:modelValue')('grammar')
    expect(config.harness.actions).toEqual(storedActions); expect(config.harness.defaultAction).toBe('grammar')
    expect(document.querySelector('.harness-free-hint')?.textContent).toContain('完整语法、练习和追问可切换 AI 服务')
    eventOf(selector, 'onUpdate:modelValue')('openai'); eventOf(selector, 'onChange')(); await settle()
    expect(state.visibleActions.map((action: any) => action.id)).toEqual(['meaning', 'grammar', 'usage', 'practice'])
    expect(state.previewAction).toBe('grammar')
    expect((document.querySelector('[aria-label="默认动作"]') as HTMLInputElement).value).toBe('grammar')
    expect(document.querySelector('.harness-default-hint')).toBeNull()
    expect(document.querySelectorAll('.harness-actions input')[1].hasAttribute('disabled')).toBe(false)
    expect(config.harness.actions).toEqual(storedActions); expect(config.harness.defaultAction).toBe('grammar')
  })
})

describe('提示词实际 DOM 的输入与焦点归属', () => {
  it.each(['hidden', 'cached', 'unmount', 'context', 'role'])('%s之后旧组合结束与 input 不再提交', async reason => {
    await mountPrompt();const old = textarea(), end = eventOf(old, 'onCompositionend'), change = eventOf(old, 'onInput');startComposition();input('ni', true)
    invalidate(reason);await settle();old.value = '迟到';end({currentTarget: old});change({currentTarget: old});expect(updates).not.toHaveBeenCalled()
  })
  it('外部值在组合期间变化时丢弃旧 IME 尾事件，正常新输入继续提交', async () => {
    await mountPrompt();const old = textarea(), end = eventOf(old, 'onCompositionend'), change = eventOf(old, 'onInput');startComposition();input('ni', true);props.modelValue = 'external';await settle()
    old.value = '迟到';end({currentTarget: old});change({currentTarget: old});expect(updates).not.toHaveBeenCalled();expect(textarea().value).toBe('external')
    input('new');expect(updates).toHaveBeenCalledWith('new')
  })
  it('容量不足、未知或已移除变量不写入，合法替换选区可以恰好达到上限', async () => {
    await mountPrompt({modelValue: 'abcd', maxLength: 6});eventOf(token(), 'onClick')();state.insertToken('unknown');expect(updates).not.toHaveBeenCalled()
    const old = eventOf(token('{{origin}}'), 'onClick');props.tokens = [{value: '{{to}}', label: 'Target'}];await settle();old();expect(updates).not.toHaveBeenCalled()
    textarea().selectionStart=0;textarea().selectionEnd=4;textarea().dispatchEvent(new win.Event('select'));eventOf(token(), 'onClick')();expect(updates).toHaveBeenCalledWith('{{to}}')
  })
  it('组合输入期间禁用变量并保留最终组合文本', async () => {
    await mountPrompt();startComposition();input('ni', true);await settle();expect(textarea().value).toBe('ni');expect(token().hasAttribute('disabled')).toBe(true);eventOf(token(), 'onClick')();expect(updates).not.toHaveBeenCalled()
    const el = textarea();el.value = '你';el.dispatchEvent(new win.Event('compositionend', {bubbles: true}));input('你');expect(updates).toHaveBeenCalledOnce();expect(updates).toHaveBeenCalledWith('你')
  })
  it('连续变量插入使用本地最新值和选区，父级尚未回传也不会丢失前一次', async () => {
    await mountPrompt({modelValue: 'P'});textarea().selectionStart=1;textarea().selectionEnd=1;textarea().dispatchEvent(new win.Event('select'));eventOf(token(), 'onClick')();eventOf(token('{{origin}}'), 'onClick')();await settle()
    expect(updates.mock.calls.map(x => x[0])).toEqual(['P{{to}}', 'P{{to}}{{origin}}']);expect(textarea().value).toBe('P{{to}}{{origin}}');expect(selectionRange).toHaveBeenLastCalledWith(17, 17);expect(focus).toHaveBeenCalledOnce()
  })
  it('父级回传前撤销到原值仍提交，不被旧 modelValue 去重吞掉', async () => {
    await mountPrompt();eventOf(token(), 'onClick')();input('');expect(updates.mock.calls.map(x => x[0])).toEqual(['{{to}}', '']);await settle();expect(focus).not.toHaveBeenCalled()
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'role', 'external'])('变量插入的 nextTick 焦点在%s后失效', async reason => {
    await mountPrompt();eventOf(token(), 'onClick')();invalidate(reason);await settle();expect(focus).not.toHaveBeenCalled();expect(selectionRange).not.toHaveBeenCalled()
  })
  it('用户已聚焦另一控件时不抢回焦点，正常变量仍可恢复一次选区', async () => {
    await mountPrompt();focused = textarea();eventOf(token(), 'onClick')();focused = document.createElement('input');await settle();expect(focus).not.toHaveBeenCalled()
    focused = textarea();eventOf(token(), 'onClick')();await settle();expect(focus).toHaveBeenCalledOnce();expect(selectionRange).toHaveBeenLastCalledWith(12, 12)
  })
  it('超长原生或程序输入保留先前文本，不截断也不提交非法值', async () => {
    await mountPrompt({modelValue: 'old', maxLength: 6});input('1234567');expect(updates).not.toHaveBeenCalled();expect(textarea().value).toBe('old')
    input('123456');expect(updates).toHaveBeenCalledWith('123456')
  })
  it('一百次同轮插入同步回传时保持全部文本，只执行最新一次焦点与光标更新', async () => {
    await mountPrompt({}, {'onUpdate:modelValue': (value: string) => {updates(value);props.modelValue = value}});const click = eventOf(token(), 'onClick')
    for (let index = 0; index < 100; index++) click();await settle();expect(textarea().value).toBe('{{to}}'.repeat(100));expect(updates).toHaveBeenCalledTimes(100);expect(focus).toHaveBeenCalledOnce();expect(selectionRange).toHaveBeenLastCalledWith(600, 600)
  })
  it('省略 active 保持正常编辑，外部非组合更新保留 textarea 与新值', async () => {
    await mountPrompt({active: undefined});const old = textarea();input('valid');expect(updates).toHaveBeenCalledWith('valid');props.modelValue = 'external';await settle();expect(textarea()).toBe(old);expect(textarea().value).toBe('external')
  })
})

describe('输入框设置实际组件与缓存事件归属', () => {
  it('through the current DOM edits both prompts, restores defaults, and resets the triple-key interval',async()=>{
    const config=profile();await mountInput(config);
    const popover=document.querySelector('[data-timing-port-key]')!;eventOf(popover,'onUpdate:visible')(true);await settle();expect(state.timingOpen).toBe(true);
    eventOf(control('input-translation-interval'),'onUpdate:modelValue')(700);await settle();expect(config.inputBoxTranslationInterval).toBe(700);
    control('input-translation-interval-reset').dispatchEvent(new win.Event('click'));await settle();expect(config.inputBoxTranslationInterval).toBe(1000);expect(control('input-translation-interval-reset').hasAttribute('disabled')).toBe(true);
    control('input-translation-prompt-toggle').dispatchEvent(new win.Event('click'));await settle();let fields=document.querySelectorAll('textarea');
    input('Use plain wording.',false,fields[0]);input('Translate {{origin}} into {{to}}.',false,fields[1]);await settle();expect(config.inputBoxTranslationSystemPrompt).toBe('Use plain wording.');expect(config.inputBoxTranslationPrompt).toBe('Translate {{origin}} into {{to}}.');
    const resetButtons=document.querySelectorAll('.input-translation-prompt-section > button');expect(resetButtons).toHaveLength(2);resetButtons.forEach(button=>button.dispatchEvent(new win.Event('click')));await settle();expect(config.inputBoxTranslationSystemPrompt).toBe('');expect(config.inputBoxTranslationPrompt).toBe('');
    control('input-translation-user-default').dispatchEvent(new win.Event('click'));await settle();expect(config.inputBoxTranslationPrompt).toBe(state.defaultUserPrompt);expect(config.inputBoxTranslationSystemPrompt).toBe('');
    control('input-translation-system-default').dispatchEvent(new win.Event('click'));await settle();expect(config.inputBoxTranslationSystemPrompt).toBe(state.defaultSystemPrompt);expect(config.model.openai).toBe('model-a');
  })
  it.each(['hidden', 'cached', 'unmount', 'config'])('%s之后旧目标、输出、服务与间隔事件不能修改配置', async reason => {
    await mountInput();const target = eventOf(control('input-translation-target'), 'onUpdate:modelValue'), output = eventOf(control('input-translation-output-mode'), 'onUpdate:modelValue')
    const service = eventOf(control('input-translation-service'), 'onUpdate:modelValue'), interval = eventOf(control('input-translation-interval'), 'onUpdate:modelValue');invalidate(reason);await settle();const before = JSON.stringify(props.config)
    target('en');output('append');service('microsoft');interval(500);expect(JSON.stringify(props.config)).toBe(before)
  })
  it('拒绝未知或停用服务、非法选项与缺失模型，正常选择只改独立配置', async () => {
    await mountInput();const config = props.config, original = JSON.stringify(config)
    eventOf(control('input-translation-target'), 'onUpdate:modelValue')('missing');eventOf(control('input-translation-output-mode'), 'onUpdate:modelValue')('unknown')
    const choose = eventOf(control('input-translation-service'), 'onUpdate:modelValue');choose('blocked');choose('missing');eventOf(control('input-translation-model'), 'onUpdate:modelValue')('not-listed');expect(JSON.stringify(config)).toBe(original)
    eventOf(control('input-translation-model'), 'onUpdate:modelValue')('model-b');expect(config.inputBoxTranslationModel).toBe('model-b');expect(config.model.openai).toBe('model-a')
  })
  it('服务切换清除独立模型并拒绝旧模型事件，保留独立提示词与原默认服务', async () => {
    const config = profile();config.inputBoxTranslationModel = 'model-b';config.inputBoxTranslationPrompt = 'saved {{origin}}';config.customOpenAIProviders = [{id: 'custom:input', name: 'Custom', endpoint: 'http://localhost:11434/v1', models: ['model-a', 'model-b']}]
    await mountInput(config);const old = eventOf(control('input-translation-model'), 'onUpdate:modelValue');eventOf(control('input-translation-service'), 'onUpdate:modelValue')('custom:input');await settle();old('model-b')
    expect(config.inputBoxTranslationModel).toBe('');expect(config.inputBoxTranslationService).toBe('custom:input');expect(config.inputBoxTranslationPrompt).toBe('saved {{origin}}');expect(config.service).toBe('openai')
    eventOf(control('input-translation-model'), 'onUpdate:modelValue')('model-b');expect(config.inputBoxTranslationModel).toBe('model-b')
  })
  it('当前模型变化或离开设置时清理面板，旧提示词 DOM 和恢复按钮不改当前配置', async () => {
    await mountInput();eventOf(control('input-translation-prompt-toggle'), 'onClick')();await settle();const old = textarea(), change = eventOf(old, 'onInput'), reset = eventOf(control('input-translation-system-default'), 'onClick')
    eventOf(control('input-translation-model'), 'onUpdate:modelValue')('model-b');await settle();const before = props.config.inputBoxTranslationSystemPrompt;old.value = 'late';change({currentTarget: old});reset();expect(props.config.inputBoxTranslationSystemPrompt).toBe(before)
    props.active = false;await settle();expect(state.promptsExpanded).toBe(false);state.resetSystemPrompt();state.resetUserPrompt();expect(props.config.inputBoxTranslationSystemPrompt).toBe(before)
  })
  it('收起并重新打开提示词面板后旧默认按钮不能借用新编辑会话', async () => {
    await mountInput();eventOf(control('input-translation-prompt-toggle'), 'onClick')();await settle()
    const old = eventOf(control('input-translation-system-default'), 'onClick')
    eventOf(control('input-translation-prompt-toggle'), 'onClick')();await settle()
    eventOf(control('input-translation-prompt-toggle'), 'onClick')();await settle();old();expect(props.config.inputBoxTranslationSystemPrompt).toBe('')
    eventOf(control('input-translation-system-default'), 'onClick')();expect(props.config.inputBoxTranslationSystemPrompt).toBe(state.defaultSystemPrompt)
  })
  it('配置替换发生在实际子编辑器组合期间，旧组合尾事件不写到新配置', async () => {
    await mountInput();eventOf(control('input-translation-prompt-toggle'), 'onClick')();await settle();const old = textarea(), end = eventOf(old, 'onCompositionend'), change = eventOf(old, 'onInput');startComposition();input('ni', true)
    props.config = profile();await settle();old.value = '迟到';end({currentTarget: old});change({currentTarget: old});expect(props.config.inputBoxTranslationSystemPrompt).toBe('')
  })
  it('提示词长度复验保留原文，默认值/重置/合法变量仍正常写入', async () => {
    await mountInput();state.systemPrompt = 'old';state.userPrompt = 'old';state.systemPrompt = 'x'.repeat(8193);state.userPrompt = 'x'.repeat(8193);expect(props.config.inputBoxTranslationSystemPrompt).toBe('old');expect(props.config.inputBoxTranslationPrompt).toBe('old')
    state.resetSystemPrompt();state.resetUserPrompt();expect(props.config.inputBoxTranslationPrompt).toBe('');eventOf(control('input-translation-prompt-toggle'), 'onClick')();await settle()
    eventOf(control('input-translation-system-default'), 'onClick')();expect(props.config.inputBoxTranslationSystemPrompt).toBe(state.defaultSystemPrompt)
  })
  it('凭据提示按独立模型解析免 Key 开关，不读取其他配置与模型的枚举字段', async () => {
    const config = profile();let unrelated = 0, models = 0
    for (let index = 0; index < 1000; index++) Object.defineProperty(config, `unrelated${index}`, {configurable: true, enumerable: true, get: () => {unrelated++;return ''}})
    for (let index = 0; index < 500; index++) Object.defineProperty(config.model, `unrelated${index}`, {configurable: true, enumerable: true, get: () => {models++;return 'fixture'}})
    config.requireApiKey[createApiKeyRequirementKey('openai', 'model-b')] = false;await mountInput(config);unrelated = 0;models = 0
    eventOf(control('input-translation-model'), 'onUpdate:modelValue')('model-b');await settle();expect(state.credentialWarning).toBe('');expect({unrelated, models}).toEqual({unrelated: 0, models: 0})
    config.requireApiKey[createApiKeyRequirementKey('openai', 'model-b')] = true;await settle();expect(state.credentialWarning).toContain('API Key');expect({unrelated, models}).toEqual({unrelated: 0, models: 0})
  })
  it('跟随默认服务变化后旧模型不写，旧 Ctrl+Enter 与间隔默认值兼容', async () => {
    const config = profile();config.inputBoxTranslationService = '';await mountInput(config);const old = eventOf(control('input-translation-model'), 'onUpdate:modelValue');config.service = 'microsoft';await settle();old('model-b');expect(config.inputBoxTranslationModel).toBe('');expect(state.showPrompt).toBe(false)
    config.inputBoxTranslationTrigger = 'ctrl_enter';await settle();expect(state.triggerOptions.some((item: {value: string}) => item.value === 'ctrl_enter')).toBe(true)
    eventOf(control('input-translation-trigger'), 'onChange')('ctrl_enter');expect(updates).toHaveBeenCalledWith('ctrl_enter');state.setIntervalValue(700);expect(config.inputBoxTranslationInterval).toBe(1000)
    config.inputBoxTranslationTrigger = 'triple_space';await settle();state.setIntervalValue(700);expect(config.inputBoxTranslationInterval).toBe(700);state.resetInterval();expect(config.inputBoxTranslationInterval).toBe(1000)
  })
  it('输入框自定义快捷键支持录制、冲突校验、编辑、清除与切回保护', async () => {
    const config = profile();config.floatingBallHotkey = 'Alt+T';config.selectionAreaEnabled = true;config.selectionAreaHotkey = 'Shift+Z'
    config.paragraphCopyEnabled = true;config.paragraphCopyHotkey = 'Alt+C';config.sectionTranslationHotkeyEnabled = true;config.sectionTranslationHotkey = 'Alt+R'
    config.informationHighlight.hotkeyEnabled = true;config.informationHighlight.hotkey = 'Alt+H'
    config.quickTranslationProfiles = [{id: 'q1', enabled: true, action: 'hover', hotkey: 'F8', service: '', model: '', targetLanguage: '', displayMode: 'inherit', fullPageMode: 'inherit'}]
    await mountInput(config)

    // 尚未保存自定义键时选择 custom 打开录制弹窗，不提前改写触发方式
    eventOf(control('input-translation-trigger'), 'onChange')('custom');await settle()
    expect(updates).not.toHaveBeenCalled();expect(config.inputBoxTranslationTrigger).toBe('triple_space')
    expect(state.showCustomHotkeyDialog).toBe(true)

    // 校验裸键和与其他功能的冲突
    expect(state.findHotkeyConflict('Space')).toBe('inputTranslation.hotkeyRequireModifier')
    expect(state.findHotkeyConflict('Alt+T')).toBe('inputTranslation.hotkeyConflict')
    expect(state.findHotkeyConflict('Shift+Z')).toBe('inputTranslation.hotkeyConflict')
    expect(state.findHotkeyConflict('Alt+C')).toBe('inputTranslation.hotkeyConflict')
    expect(state.findHotkeyConflict('Alt+R')).toBe('inputTranslation.hotkeyConflict')
    expect(state.findHotkeyConflict('Alt+H')).toBe('inputTranslation.hotkeyConflict')
    expect(state.findHotkeyConflict('F8')).toBe('quickTranslation.conflictProfile')
    expect(state.findHotkeyConflict('none')).toBe('')
    expect(state.findHotkeyConflict('Alt+Enter')).toBe('')

    // 冲突值不提交，合法值提交并展示自定义键编辑行
    state.handleCustomHotkeyConfirm('Alt+T');expect(config.customInputBoxTranslationHotkey).toBe('')
    state.handleCustomHotkeyConfirm('Alt+Enter');await settle()
    expect(config.inputBoxTranslationTrigger).toBe('custom');expect(config.customInputBoxTranslationHotkey).toBe('Alt+Enter')
    expect(state.showCustomHotkeyDialog).toBe(false)
    expect(control('input-translation-custom-hotkey').textContent).toMatch(/(Alt|Option)\+Enter/u)

    // 点击编辑按钮可重新录制、取消保留原值、清除会关闭输入框翻译
    control('input-translation-hotkey-edit').dispatchEvent(new win.Event('click'));await settle()
    expect(state.showCustomHotkeyDialog).toBe(true)
    state.handleCustomHotkeyCancel();await settle()
    expect(state.showCustomHotkeyDialog).toBe(false);expect(config.customInputBoxTranslationHotkey).toBe('Alt+Enter')

    control('input-translation-hotkey-edit').dispatchEvent(new win.Event('click'));await settle()
    state.handleCustomHotkeyConfirm('none');await settle()
    expect(config.inputBoxTranslationTrigger).toBe('disabled');expect(config.customInputBoxTranslationHotkey).toBe('')

    // 切回已有自定义键时若已被其他功能占用则拦截警告，不冲突时发出 trigger-change
    config.customInputBoxTranslationHotkey = 'Alt+T';await settle()
    eventOf(control('input-translation-trigger'), 'onChange')('custom')
    expect(updates).not.toHaveBeenCalled();expect(message.warning).toHaveBeenCalled()
    config.customInputBoxTranslationHotkey = 'F9';await settle()
    eventOf(control('input-translation-trigger'), 'onChange')('custom')
    expect(updates).toHaveBeenCalledWith('custom')
  })
})

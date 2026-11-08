import {getFixtureRootNode} from './helpers/vueDomFixture';
/**
 * @file tests/serviceEditorLifecycle.test.ts
 * 文件职责：验证实际设置子组件的写入边界与延迟焦点生命周期。
 * 主要内容：直接导入实际 SFC setup/watch，覆盖隐藏、缓存、卸载、配置切换、模型容量和对话框重入；使用真实事件目标与受控 RAF 验证窗口视口订阅的更新、释放和重开。
 * 模块边界：全部用例执行真实客户端模板；受控端口负责 Element Plus 展示与浏览器事件，生产浏览器另行验证。
 */
import * as runtime from 'vue'
import {parseHTML} from 'linkedom'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {CUSTOM_OPENAI_RESERVED_MODEL_ID} from '@/src/core/config/customOpenAI'

let app: import('vue').App
let state: Record<string, any>, props: Record<string, any>, visible: import('vue').Ref<boolean>
const emitted = vi.fn(), focus = vi.fn(), scroll = vi.fn()
async function settle() {await runtime.nextTick();await runtime.nextTick()}
beforeEach(async () => {
  vi.clearAllMocks()
  vi.stubGlobal('document', {activeElement: null})
  vi.doMock('webextension-polyfill', () => ({default: {declarativeNetRequest: {updateDynamicRules: () => {}}}}))
  vi.doMock('element-plus/es/components/checkbox/style/css', () => ({}))
  vi.doMock('element-plus', () => ({ElPopover: {setup(_: unknown, {slots}: any) {const instance = runtime.getCurrentInstance()!;return () => runtime.h('div', {'data-port-popover-key': instance.vnode.key}, [slots.reference?.(), slots.default?.()])}}, ElButton: {}, ElCheckbox: {}, ElInput: {}}))
  vi.doMock('@/src/features/settings/ui/components/FieldHelp.vue', () => ({default: {render: () => null}}))
  vi.doMock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text}), localizeServiceOptions: (options: unknown) => options}))
})
afterEach(async () => {app?.unmount();await settle();vi.unstubAllGlobals()})
async function mount(name: string, values: Record<string, unknown>, listeners: Record<string, unknown> = {}) {
  vi.resetModules()
  const loaders: Record<string, () => Promise<{default: runtime.Component}>> = {
    CustomOpenAIProviderDialog: () => import('@/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue'),
    CompositeTranslationFields: () => import('@/src/features/settings/ui/services/CompositeTranslationFields.vue'),
    CompositeTranslationSettings: () => import('@/src/features/settings/ui/services/CompositeTranslationSettings.vue'),
    ApiKeyList: () => import('@/src/features/settings/ui/services/ApiKeyList.vue'),
    ModelPicker: () => import('@/src/features/settings/ui/services/ModelPicker.vue'),
    RequestHeaderSettings: () => import('@/src/features/settings/ui/services/RequestHeaderSettings.vue'),
    RequestLimitSettings: () => import('@/src/features/settings/ui/services/RequestLimitSettings.vue'),
  }
  const component = (await loaders[name]()).default
  type Node = {tag?: string; props: Record<string, any>; focus?: () => void; parent?: Node; children?: Node[]}
  const nodes: Node[] = []
  function remove(node: Node) {const siblings = node.parent?.children;if (siblings) {const index = siblings.indexOf(node);if (index >= 0) siblings.splice(index, 1)}node.parent = undefined}
  function insert(node: Node, parent: Node, anchor?: Node | null) {remove(node);const siblings = parent.children ||= [];const at = anchor ? siblings.indexOf(anchor) : -1;siblings.splice(at < 0 ? siblings.length : at, 0, node);node.parent = parent}
  const renderer = runtime.createRenderer<Node, Node>({patchProp: (node, key, _previous, value) => {node.props[key] = value}, insert,
    remove, createElement: tag => {const node = {tag, tagName: tag.toUpperCase(), value: '', props: {}, focus, getRootNode: getFixtureRootNode<Node>, addEventListener: () => {}, removeEventListener: () => {}};nodes.push(node);return node}, createText: () => ({props: {}}), createComment: () => ({props: {}}), setText: () => {},
    setElementText: () => {}, parentNode: node => node.parent || null, nextSibling: node => {const siblings = node.parent?.children || [];return siblings[siblings.indexOf(node) + 1] || null}, querySelector: () => null,
    setScopeId: () => {}, cloneNode: () => ({props: {}}), insertStaticContent: (_html, parent, anchor) => {const first = {props: {}}, last = {props: {}};insert(first, parent, anchor);insert(last, parent, anchor);return [first, last]}})
  const source = runtime.shallowReactive({active: true, context: {}, contextKey: 'service-a', ...values})
  visible = runtime.ref(true)
  app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
    ? runtime.h(component as runtime.Component, {...source, ...listeners, ref: (vm: any) => {if (vm) {state = vm.$.setupState;props = vm.$.props}}})
    : runtime.h({render: () => null}, {key: 'other'})})})
  app.component('el-dialog', runtime.defineComponent({setup(_props, {slots}) {return () => runtime.h('div', null, slots.default?.())}}))
  app.component('el-input', runtime.defineComponent({setup(_props, {attrs}) {return () => runtime.h('input', attrs)}}))
  app.config.warnHandler = () => {};app.mount({props: {}});await settle()
  return nodes
}
function change(reason: string) {
  if (reason === 'hidden') props.active = false
  if (reason === 'context') props.context = {}
  if (reason === 'config') props.config = runtime.reactive(new Config())
  if (reason === 'service') props.contextKey = 'service-b'
  if (reason === 'unmount') app.unmount()
  if (reason === 'cached') visible.value = false
}
const picker = {options: [{value: 'fixed'}, {value: 'custom', removable: true}], selectedModel: 'fixed', maximumModels: 2, maximumModelLength: 12}
function fillProvider() {Object.assign(state.draft, {name: 'Local', endpoint: 'http://localhost:11434/v1', apiKey: 'synthetic', model: 'local-model'})}

describe('服务子编辑器的写入与焦点归属', () => {
  it('组合成员选择不能加入关闭服务，已有关闭成员仍保留在草稿中', async () => {
    const draft = runtime.reactive({name: 'Group', strategy: 'sequential', services: ['google', 'microsoft'], timeoutMs: 12000});
    await mount('CompositeTranslationFields', {draft, members: [{value: 'google', label: 'Google', disabled: true}, {value: 'microsoft', label: 'Microsoft'}, {value: 'closed', label: 'Closed', disabled: true}], errors: {}}, {onUpdate: emitted});
    expect(state.availableMembers).toEqual([]);
    state.actions.selectMember({currentTarget: {value: 'closed'}}); await settle();
    expect(emitted).not.toHaveBeenCalled(); expect(draft.services).toEqual(['google', 'microsoft']);
  })
  it('唯一创建窗口默认接口，组合校验至少两个成员且旧提交不跨重开', async () => {
    const interfaceSubmit = vi.fn()
    await mount('CustomOpenAIProviderDialog', {config: runtime.reactive(new Config()), modelValue: true}, {onSubmit: interfaceSubmit, 'onSubmit:composite': emitted})
    expect(state.serviceType).toBe('interface');state.actions.type('composite')
    state.actions.submit();expect(state.compositeErrors.name).toBe('settings.services.composite.nameRequired');expect(emitted).not.toHaveBeenCalled()
    state.draft.name = ' Daily ';Object.assign(state.compositeDraft, {strategy: 'smart', services: ['google'], timeoutMs: 5000})
    state.actions.submit();expect(state.compositeErrors.services).toBe('settings.services.composite.membersRequired')
    const old = state.actions;props.modelValue = false;props.modelValue = true
    expect(state.serviceType).toBe('interface');state.actions.type('composite')
    state.draft.name = ' Daily ';Object.assign(state.compositeDraft, {strategy: 'smart', services: ['google', 'microsoft'], timeoutMs: 5000})
    old.submit();expect(emitted).not.toHaveBeenCalled();state.actions.submit()
    expect(emitted).toHaveBeenCalledWith({name: 'Daily', strategy: 'smart', services: ['google', 'microsoft'], timeoutMs: 5000})
    expect(state.compositeDraft.services).toEqual([]);expect(state.draft.name).toBe('');expect(interfaceSubmit).not.toHaveBeenCalled()
  })
  it('切换类型保留唯一名称与各自草稿，旧接口事件不能提交或关闭当前组合', async () => {
    const interfaceSubmit = vi.fn()
    await mount('CustomOpenAIProviderDialog', {config: runtime.reactive(new Config()), modelValue: true}, {onSubmit: interfaceSubmit, 'onSubmit:composite': emitted})
    fillProvider();const oldInterface = state.actions
    state.actions.type('composite');state.actions.composite({services: ['google', 'microsoft'], strategy: 'random', timeoutMs: 3000})
    expect(state.draft.name).toBe('Local');const oldComposite = state.actions
    oldInterface.submit();oldInterface.close();oldInterface.draft('endpoint', {target: {value: 'https://late.example'}})
    expect(state.ownedOpen).toBe(true);expect(interfaceSubmit).not.toHaveBeenCalled();expect(emitted).not.toHaveBeenCalled()
    state.actions.type('interface');expect(state.draft).toEqual({name: 'Local', endpoint: 'http://localhost:11434/v1', apiKey: 'synthetic', model: 'local-model'})
    oldComposite.composite({services: []});oldComposite.submit();expect(state.compositeDraft.services).toEqual(['google', 'microsoft'])
    state.draft.name = 'Shared name';state.actions.type('composite');state.actions.submit()
    expect(emitted).toHaveBeenCalledWith({name: 'Shared name', services: ['google', 'microsoft'], strategy: 'random', timeoutMs: 3000})
    expect(Object.keys(emitted.mock.calls[0][0]).sort()).toEqual(['name', 'services', 'strategy', 'timeoutMs'])
    expect(interfaceSubmit).not.toHaveBeenCalled();expect(state.draft.apiKey).toBe('')
  })
  it('取消后重开回到接口类型，同时清空接口密钥及组合成员草稿', async () => {
    await mount('CustomOpenAIProviderDialog', {config: runtime.reactive(new Config()), modelValue: true}, {'onSubmit:composite': emitted})
    fillProvider();state.actions.type('composite');state.actions.composite({services: ['google', 'microsoft'], strategy: 'smart', timeoutMs: 5000})
    const old = state.actions;state.actions.close();props.modelValue = false;props.modelValue = true
    expect(state.serviceType).toBe('interface');expect(state.draft).toEqual({name: '', endpoint: '', apiKey: '', model: ''});expect(state.compositeDraft.services).toEqual([])
    fillProvider();old.submit();old.composite({services: ['google', 'microsoft']});expect(emitted).not.toHaveBeenCalled();expect(state.compositeDraft.services).toEqual([])
  })
  it.each(['hidden', 'context', 'config', 'cached', 'unmount'])('组合类型在%s后清空两类草稿且禁止迟到提交', async reason => {
    await mount('CustomOpenAIProviderDialog', {config: runtime.reactive(new Config()), modelValue: true}, {'onSubmit:composite': emitted})
    fillProvider();state.actions.type('composite');state.actions.composite({services: ['google', 'microsoft'], strategy: 'smart', timeoutMs: 5000})
    const old = state.actions;change(reason);await settle();old.submit();old.composite({services: ['google', 'microsoft']})
    expect(emitted).not.toHaveBeenCalled();expect(state.draft.apiKey).toBe('');expect(state.compositeDraft.services).toEqual([])
  })
  it('组合成员添加拒绝嵌套，重排与移除使用服务身份且旧事件不能跨列表改动', async () => {
    const draft = runtime.reactive({name: 'Daily', strategy: 'sequential', services: ['google', 'microsoft'], timeoutMs: 12000})
    await mount('CompositeTranslationFields', {draft, members: [{value: 'google', label: 'Google'}, {value: 'microsoft', label: 'Microsoft'}, {value: 'custom:work', label: 'Work'}]}, {onUpdate: emitted})
    state.actions.selectMember({currentTarget: {value: 'composite:nested'}});expect(emitted).not.toHaveBeenCalled()
    state.actions.selectMember({currentTarget: {value: 'custom:work'}});expect(emitted).toHaveBeenLastCalledWith({services: ['google', 'microsoft', 'custom:work']})
    state.actions.move('microsoft', -1);expect(emitted).toHaveBeenLastCalledWith({services: ['microsoft', 'google']})
    const old = state.actions;draft.services.reverse();old.remove('google');expect(emitted).toHaveBeenCalledTimes(2)
    state.actions.remove('google');expect(emitted).toHaveBeenLastCalledWith({services: ['microsoft']})
    props.active = false;state.actions.strategy('smart');expect(emitted).toHaveBeenCalledTimes(3)
  })
  it('组合编辑显式保存，删除确认不能跨服务或配置身份', async () => {
    const config = runtime.reactive(new Config())
    config.compositeTranslationProviders = [{id: 'composite:first', name: 'First', strategy: 'sequential', services: ['google', 'microsoft'], timeoutMs: 12000}, {id: 'composite:second', name: 'Second', strategy: 'smart', services: ['microsoft', 'google'], timeoutMs: 10000}]
    await mount('CompositeTranslationSettings', {config, service: 'composite:first'}, {onRemove: emitted})
    state.actions.update({name: 'Renamed', strategy: 'random', timeoutMs: 3000});expect(config.compositeTranslationProviders[0].name).toBe('First')
    state.actions.save();expect(config.compositeTranslationProviders[0]).toEqual({id: 'composite:first', name: 'Renamed', strategy: 'random', services: ['google', 'microsoft'], timeoutMs: 3000})
    state.actions.remove();const old = state.deleteActions;props.service = 'composite:second';old.confirm();expect(emitted).not.toHaveBeenCalled();expect(state.deleteOpen).toBe(false)
    state.actions.remove();state.deleteActions.confirm();expect(emitted).toHaveBeenCalledOnce()
    expect(config.compositeTranslationProviders).toHaveLength(2)
  })
  it('实际缓存模板的旧模型点击不得在服务切换后使用新的事件身份', async () => {
    const nodes = await mount('ModelPicker', picker, {onSelect: emitted})
    const old = nodes.find(node => node.props.class === 'model-picker-option')!.props.onClick
    const oldKey = nodes.find(node => node.props['data-port-popover-key'])!.props['data-port-popover-key']
    props.contextKey = 'service-b';await settle();old();expect(emitted).not.toHaveBeenCalled()
    expect(nodes.filter(node => node.props['data-port-popover-key']).at(-1)!.props['data-port-popover-key']).not.toBe(oldKey)
    nodes.filter(node => node.props.class === 'model-picker-option').at(-2)!.props.onClick();expect(emitted).toHaveBeenCalledWith('fixed')
  })
  it('实际缓存模板的旧提交事件不得提交重开的新服务草稿', async () => {
    const nodes = await mount('CustomOpenAIProviderDialog', {modelValue: true}, {onSubmit: emitted})
    const old = nodes.find(node => node.tag === 'form')!.props.onSubmit
    props.modelValue = false;await settle();props.modelValue = true;await settle();fillProvider()
    old({preventDefault: vi.fn()});expect(emitted).not.toHaveBeenCalled()
    nodes.find(node => node.tag === 'form')!.props.onSubmit({preventDefault: vi.fn()});expect(emitted).toHaveBeenCalledOnce()
  })
  it('实际密钥模板的旧行更新不得在服务切换后写入新的服务', async () => {
    const nodes = await mount('ApiKeyList', {keys: ['fixture'], states: {}, summary: null, busy: false}, {onUpdate: emitted})
    const old = nodes.find(node => node.tag === 'input')!.props['onUpdate:modelValue']
    props.contextKey = 'service-b';await settle();old('late');expect(emitted).not.toHaveBeenCalled()
    nodes.find(node => node.tag === 'input')!.props['onUpdate:modelValue']('new');expect(emitted).toHaveBeenCalledWith(0, 'new')
  })
  it.each(['hidden', 'context', 'service', 'unmount'])('添加模型的 nextTick 焦点在%s后失效', async reason => {
    await mount('ModelPicker', picker);state.pickerOpen = true;state.modelInput = {focus}
    const job = state.beginAddModel();change(reason);await job;expect(focus).not.toHaveBeenCalled()
  })
  it('取消添加后不再聚焦输入，正常添加可聚焦和提交一次', async () => {
    const nodes = await mount('ModelPicker', picker, {onAdd: emitted});state.actions.open(true)
    const begin = nodes.find(node => node.props['data-testid'] === 'add-custom-model')!.props.onClick
    begin();state.actions.cancel();await settle();expect(focus).not.toHaveBeenCalled()
    begin();await settle();expect(focus).toHaveBeenCalledOnce()
    const {window} = parseHTML('<html><body><input></body></html>')
    vi.stubGlobal('HTMLInputElement', window.HTMLInputElement)
    const input = window.document.querySelector('input')!;input.value = 'new-model'
    nodes.find(node => node.props['data-testid'] === 'custom-model-input')!.props.onInput({target: input})
    const submit = nodes.find(node => node.props['data-testid'] === 'custom-model-form')!.props.onSubmit
    submit({preventDefault: vi.fn()});submit({preventDefault: vi.fn()})
    expect(emitted).toHaveBeenCalledOnce();expect(emitted).toHaveBeenCalledWith('new-model')
    nodes.find(node => node.props['data-testid'] === 'model-picker')!.props.onKeydown({key: 'Escape', stopPropagation: vi.fn()})
    expect(state.pickerOpen).toBe(false)
  })
  it.each(['capacity', 'permission', 'length', 'empty', 'reserved', 'duplicate'])('模型提交重新验证%s而不依赖 HTML 属性', async reason => {
    await mount('ModelPicker', picker, {onAdd: emitted});state.pickerOpen = true;await state.beginAddModel();state.modelDraft = 'new-model'
    if (reason === 'capacity') props.customModelCount = 2
    if (reason === 'permission') props.allowCustomModels = false
    if (reason === 'length') state.modelDraft = 'a'.repeat(13)
    if (reason === 'empty') state.modelDraft = '  '
    if (reason === 'reserved') state.modelDraft = CUSTOM_OPENAI_RESERVED_MODEL_ID
    if (reason === 'duplicate') state.modelDraft = 'fixed'
    state.submitModel();expect(emitted).not.toHaveBeenCalled()
    if (!['capacity', 'permission'].includes(reason)) expect(state.modelError).not.toBe('')
  })
  it('真实搜索输入筛选模型，父级切换当前模型后清空旧查询', async () => {
    const nodes = await mount('ModelPicker', picker)
    nodes.find(node => node.props.type === 'search')!.props['onUpdate:modelValue']('custom')
    await settle();expect(state.filteredOptions.map((option: {value: string}) => option.value)).toEqual(['custom'])
    props.selectedModel = 'custom';await settle();expect(state.query).toBe('')
    expect(state.filteredOptions.map((option: {value: string}) => option.value)).toEqual(['fixed', 'custom'])
  })
  it('拒绝缺失模型与内置模型删除，隐藏和缓存时关闭草稿', async () => {
    await mount('ModelPicker', picker, {onSelect: emitted, onRemove: emitted});state.pickerOpen = true
    state.selectModel('missing');state.removeModel('fixed');expect(emitted).not.toHaveBeenCalled()
    await state.beginAddModel();state.modelDraft = 'keep?';props.active = false;await settle()
    expect(state.pickerOpen).toBe(false);expect(state.modelDraft).toBe('');state.selectModel('fixed');expect(emitted).not.toHaveBeenCalled()
    props.active = true;await settle();state.pickerOpen = true;await state.beginAddModel();visible.value = false;await settle()
    expect(state.pickerOpen).toBe(false);expect(state.modelDraft).toBe('')
  })
  it('先关闭模型编辑再通知，监听器重开时保留新草稿', async () => {
    await mount('ModelPicker', picker, {onAdd: () => {state.addingModel = true;state.modelDraft = 'next-draft';emitted()}})
    state.pickerOpen = true;await state.beginAddModel();state.modelDraft = 'new-model';state.submitModel()
    expect(emitted).toHaveBeenCalledOnce();expect(state.modelDraft).toBe('next-draft');expect(state.addingModel).toBe(true)
  })
  it.each(['hidden', 'context', 'service', 'unmount'])('添加密钥的延迟焦点在%s后不触及旧根', async reason => {
    await mount('ApiKeyList', {keys: [''], states: {}, summary: null, busy: false})
    state.root = {querySelectorAll: () => [{focus, scrollIntoView: scroll}]};const job = state.addKey();change(reason);await job
    expect(focus).not.toHaveBeenCalled();expect(scroll).not.toHaveBeenCalled()
  })
  it('密钥正常添加聚焦空行，隐藏时不添加或展开错误', async () => {
    await mount('ApiKeyList', {keys: ['fixture'], states: {}, summary: null, busy: false}, {onAdd: () => {props.keys = ['fixture', ''];emitted()}})
    state.root.querySelectorAll = () => [{focus, scrollIntoView: scroll}, {focus, scrollIntoView: scroll}]
    await state.addKey();expect(emitted).toHaveBeenCalledOnce();expect(focus).toHaveBeenCalledOnce();expect(scroll).toHaveBeenCalledOnce()
    state.actions.toggle(0);expect(state.expandedErrors.has(0)).toBe(true)
    state.actions.toggle(0);expect(state.expandedErrors.size).toBe(0)
    props.active = false;await state.addKey();state.toggleError(0);expect(emitted).toHaveBeenCalledOnce();expect(state.expandedErrors.size).toBe(0)
  })
  it('外部关闭新服务对话框立即清空合成密钥，迟到 opened 不聚焦', async () => {
    await mount('CustomOpenAIProviderDialog', {modelValue: true});fillProvider();state.nameInput = {focus}
    props.modelValue = false;await settle();state.focusFirstField();state.submitProvider()
    expect(state.draft.apiKey).toBe('');expect(focus).not.toHaveBeenCalled()
  })
  it.each(['close', 'hidden', 'cached', 'unmount'])('新服务窗口视口在%s后释放监听与排队帧，迟到事件不更新', async reason => {
    const viewport = Object.assign(new EventTarget(), {width: 390, height: 780, offsetLeft: 0, offsetTop: 0})
    const page = Object.assign(new EventTarget(), {visibilityState: 'visible'})
    const frames = new Map<number, FrameRequestCallback>();let nextFrame = 0
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {const id = ++nextFrame;frames.set(id, callback);return id})
    const cancelAnimationFrame = vi.fn((id: number) => {frames.delete(id)})
    const view = Object.assign(new EventTarget(), {document: page, visualViewport: viewport, innerWidth: 390, innerHeight: 844,
      requestAnimationFrame, cancelAnimationFrame})
    const targets = [view, viewport, page].map(target => ({target, add: vi.spyOn(target, 'addEventListener'), remove: vi.spyOn(target, 'removeEventListener')}))
    const flushFrame = () => {const queued = [...frames.values()];frames.clear();for (const callback of queued) callback(0)}
    vi.stubGlobal('window', view)
    await mount('CustomOpenAIProviderDialog', {modelValue: true})
    expect(state.dialogViewportStyle).toEqual({'--fluentread-custom-provider-viewport-left': '0px', '--fluentread-custom-provider-viewport-top': '0px',
      '--fluentread-custom-provider-viewport-width': '390px', '--fluentread-custom-provider-viewport-height': '780px'})
    Object.assign(viewport, {width: 760, height: 180, offsetLeft: 20, offsetTop: 44})
    viewport.dispatchEvent(new Event('resize'));viewport.dispatchEvent(new Event('scroll'))
    expect(frames.size).toBe(1);expect(requestAnimationFrame).toHaveBeenCalledOnce()
    expect(state.dialogViewportStyle['--fluentread-custom-provider-viewport-height']).toBe('780px')
    flushFrame()
    expect(state.dialogViewportStyle).toEqual({'--fluentread-custom-provider-viewport-left': '20px', '--fluentread-custom-provider-viewport-top': '44px',
      '--fluentread-custom-provider-viewport-width': '760px', '--fluentread-custom-provider-viewport-height': '180px'})
    viewport.height = 90;view.dispatchEvent(new Event('resize'))
    expect(frames.size).toBe(1)
    const [pendingId, lateFrame] = [...frames.entries()][0]!
    if (reason === 'close') props.modelValue = false
    else change(reason)
    await settle()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingId);expect(frames.size).toBe(0)
    for (const {add, remove} of targets) {
      expect(add.mock.calls.length).toBeGreaterThan(0)
      expect(remove.mock.calls.map(([type, listener]) => [type, listener])).toEqual(add.mock.calls.map(([type, listener]) => [type, listener]))
    }
    const stoppedStyle = state.dialogViewportStyle, scheduled = requestAnimationFrame.mock.calls.length
    Object.assign(viewport, {width: 390, height: 600, offsetLeft: 3, offsetTop: 5})
    lateFrame(1)
    for (const {target, add} of targets) for (const [type] of add.mock.calls) target.dispatchEvent(new Event(type))
    expect(frames.size).toBe(0);expect(requestAnimationFrame).toHaveBeenCalledTimes(scheduled)
    expect(state.dialogViewportStyle).toBe(stoppedStyle)
    if (reason === 'close') {
      props.modelValue = true;await settle()
      expect(state.dialogViewportStyle).toEqual({'--fluentread-custom-provider-viewport-left': '3px', '--fluentread-custom-provider-viewport-top': '5px',
        '--fluentread-custom-provider-viewport-width': '390px', '--fluentread-custom-provider-viewport-height': '600px'})
    }
  })
  it.each(['hidden', 'cached', 'unmount'])('新服务对话框在%s后不提交并清空草稿', async reason => {
    await mount('CustomOpenAIProviderDialog', {modelValue: true}, {onSubmit: emitted});fillProvider();change(reason);await settle();state.submitProvider()
    expect(emitted).not.toHaveBeenCalled();expect(state.draft.apiKey).toBe('')
  })
  it('服务提交只执行一次，先关闭再通知，监听器重开时不擦除新草稿', async () => {
    const order: string[] = []
    await mount('CustomOpenAIProviderDialog', {modelValue: true}, {'onUpdate:modelValue': (open: boolean) => {order.push('close');props.modelValue = open},
      onSubmit: (value: unknown) => {order.push('submit');emitted(value);props.modelValue = true;state.draft.name = 'Next';state.draft.apiKey = 'next-fixture'}})
    fillProvider();state.submitProvider();expect(order).toEqual(['close', 'submit']);expect(state.draft.name).toBe('Next');expect(state.draft.apiKey).toBe('next-fixture')
    props.modelValue = false;props.modelValue = true;fillProvider();state.submitProvider();state.submitProvider();expect(emitted).toHaveBeenCalledTimes(2)
  })
  it.each(['name', 'endpoint', 'model'])('新服务显式拒绝超长%s，不将规范化截断当作成功', async field => {
    await mount('CustomOpenAIProviderDialog', {modelValue: true, maximumNameLength: 5, maximumEndpointLength: 35, maximumModelLength: 12}, {onSubmit: emitted})
    fillProvider();state.draft[field] = field === 'endpoint' ? `https://${'a'.repeat(40)}.com/v1` : 'a'.repeat(13)
    state.submitProvider();expect(emitted).not.toHaveBeenCalled();expect(state.errors[field]).toBeTruthy()
  })
  it('继承限制拒绝迟到数字更新，隐藏时不创建服务限额', async () => {
    const config = runtime.reactive(new Config());await mount('RequestLimitSettings', {config, service: 'deepseek', model: 'model-a'})
    state.setLimits({maxConcurrentTranslations: 2, translationRequestsPerSecond: 1, translationRequestsPerMinute: 5})
    expect(config.modelRequestLimits).toEqual({});props.active = false;state.setFollowing(false);expect(config.modelRequestLimits).toEqual({})
  })
  it('模型切换立即重置作用域，配置替换同样恢复默认作用域', async () => {
    const config = runtime.reactive(new Config());await mount('RequestLimitSettings', {config, service: 'deepseek', model: 'model-a'})
    state.scope = 'service';props.model = 'model-b';expect(state.scope).toBe('model')
    state.scope = 'service';props.config = runtime.reactive(new Config());expect(state.scope).toBe('model')
  })
  it('隐藏的请求头编辑不写配置，重新显示后仍可正常增删', async () => {
    const config = runtime.reactive(new Config());await mount('RequestHeaderSettings', {config});state.domain = 'fixture.example';props.active = false;state.add()
    expect(config.requestHeaderRules).toEqual([]);props.active = true;state.domain = 'fixture.example';state.add();expect(config.requestHeaderRules).toHaveLength(1)
    props.active = false;state.remove('fixture.example');expect(config.requestHeaderRules).toHaveLength(1)
    props.active = true;state.remove('fixture.example');expect(config.requestHeaderRules).toEqual([])
  })
  it('旧模型事件不能跨上下文，新上下文仍可正常选择和删除', async () => {
    await mount('ModelPicker', picker, {onSelect: emitted, onRemove: emitted});const old = state.actions
    props.contextKey = 'service-b';old.select('fixed');old.remove('custom');expect(emitted).not.toHaveBeenCalled()
    state.actions.select('fixed');state.actions.remove('custom');expect(emitted.mock.calls).toEqual([['fixed'], ['custom']])
  })
  it('密钥旧事件被服务切换淘汰，新行支持更新、删除和检查，忙碌时不检查', async () => {
    await mount('ApiKeyList', {keys: ['fixture'], states: {}, summary: null, busy: false}, {onUpdate: emitted, onRemove: emitted, onTest: emitted})
    const old = state.actions;props.contextKey = 'service-b';old.update(0, 'late');old.remove(0);old.test(0);expect(emitted).not.toHaveBeenCalled()
    state.actions.update(0, 'new');state.actions.remove(0);state.actions.test(0);expect(emitted.mock.calls).toEqual([[0, 'new'], [0], [0]])
    props.busy = true;state.actions.test(0);expect(emitted).toHaveBeenCalledTimes(3)
  })
  it.each(['replace-list', 'shift-in-place', 'edit-in-place'])('密钥行%s之后旧索引事件不能写入、删除、检查或展开现在的另一行', async reason => {
    const nodes = await mount('ApiKeyList', {keys: runtime.reactive(['first', 'second']), states: {0: {status: 'error'}}, summary: null, busy: false, allowMultiple: true}, {onUpdate: emitted, onRemove: emitted, onTest: emitted})
    const old = {update: nodes.find(node => node.tag === 'input')!.props['onUpdate:modelValue'],
      remove: nodes.find(node => node.props.class?.includes('api-key-remove'))!.props.onClick,
      test: nodes.find(node => node.props.class?.includes('api-key-retest'))!.props.onClick,
      toggle: nodes.find(node => node.props.class?.includes('api-key-error-toggle'))!.props.onClick}
    if (reason === 'replace-list') props.keys = ['second']
    if (reason === 'shift-in-place') props.keys.splice(0, 1)
    if (reason === 'edit-in-place') props.keys[0] = 'new-first'
    await settle();old.update('late');old.remove();old.test();old.toggle();expect(emitted).not.toHaveBeenCalled();expect(state.expandedErrors.size).toBe(0)
    nodes.find(node => node.tag === 'input')!.props['onUpdate:modelValue']('current');expect(emitted).toHaveBeenCalledWith(0, 'current')
  })
  it('请求限额旧作用域事件不修改新模型，继承切换后旧数字回调不重新启用', async () => {
    const config = runtime.reactive(new Config());await mount('RequestLimitSettings', {config, service: 'deepseek', model: 'a'})
    state.setFollowing(false);const old = state.actions;props.model = 'b';old.mode('custom');old.limits({maxConcurrentTranslations: 2});expect(config.modelRequestLimits.deepseek.b).toBeUndefined()
    state.actions.mode('custom');const b = state.actions;state.setFollowing(true);b.limits({maxConcurrentTranslations: 2});expect(config.modelRequestLimits.deepseek.b.enabled).toBe(false)
    state.actions.mode('custom');state.actions.limits({maxConcurrentTranslations: 2, translationRequestsPerSecond: 1, translationRequestsPerMinute: 5})
    expect(config.modelRequestLimits.deepseek.b.limits.maxConcurrentTranslations).toBe(2)
  })
  it('请求头旧事件不写替换后的配置，新事件可修改开关并拒绝无效值', async () => {
    const config = runtime.reactive(new Config());await mount('RequestHeaderSettings', {config});state.domain = 'fixture.example';state.add()
    const old = state.actions;props.config = runtime.reactive(new Config());state.domain = 'new.example';old.add();old.remove('new.example');old.flag('new.example', 'removeOrigin', false)
    expect(props.config.requestHeaderRules).toEqual([]);state.actions.add();state.actions.flag('new.example', 'removeOrigin', false)
    expect(props.config.requestHeaderRules[0].removeOrigin).toBe(false);state.actions.flag('new.example', 'removeOrigin', 'false');state.actions.flag('missing.example', 'removeOrigin', true)
    expect(props.config.requestHeaderRules[0].removeOrigin).toBe(false)
  })
  it('旧对话框 opened、关闭和提交事件不能操作重开的新草稿', async () => {
    await mount('CustomOpenAIProviderDialog', {modelValue: true}, {onSubmit: emitted});const old = state.actions
    props.modelValue = false;props.modelValue = true;fillProvider();state.nameInput = {focus};old.focus();old.update(false);old.submit()
    expect(focus).not.toHaveBeenCalled();expect(emitted).not.toHaveBeenCalled();expect(state.draft.name).toBe('Local')
    state.actions.focus();expect(focus).toHaveBeenCalledOnce();state.actions.submit();expect(emitted).toHaveBeenCalledOnce()
  })
})

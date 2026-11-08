/**
 * @file tests/serviceDirectoryLifecycle.test.ts
 * 文件职责：验证服务目录和免费权重设置的实际组件生命周期、缓存模板及有界读取。
 * 主要内容：覆盖停用与切换、迟到后台快照、轮询合并、目录焦点、搜索计算、显式设置默认服务、公开版套餐旧配置展示及默认动作门控、开发版正常选择、分组导航、帧内布局合并、缓存位置与尺寸/字体观察的旧 DOM 事件。
 * 模块边界：直接导入并实际挂载生产客户端 SFC；浏览器消息、DOM 几何与观察器使用受控端口，不复制目录业务；真实 UI 另行验证。
 */
import * as runtime from 'vue'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Config} from '@/src/core/config/model'
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation'
import {calculateFreeTranslationWeightSnapshot, FREE_TRANSLATION_WEIGHT_REFRESH_INTERVAL_MS} from '@/src/services/translation/freeWeights'

let app: import('vue').App, state: Record<string, any>, props: Record<string, any>
let shown: import('vue').Ref<boolean>, nodes: Node[], source: Record<string, any>, hostRoot: Node
type Node = {tag: string; props: Record<string, any>; value?: string; focus?: () => void; closest?: (selector?: string) => unknown; parent?: Node; children?: Node[];
  style?: Record<string, string>; dataset?: Record<string, string>; scrollTop?: number; clientHeight?: number; scrollHeight?: number;
  getClientRects?: () => unknown[]; getBoundingClientRect?: () => {top: number}; querySelectorAll?: (selector: string) => Node[]}
const groupScroll = vi.fn(), readRects = vi.fn(), readBounds = vi.fn(), sectionQueries = vi.fn(), reducedMotion = vi.fn(() => false)
const animationFrames = new Map<number, FrameRequestCallback>(), fontListeners = new Set<() => void>()
let animationFrameId = 0, frameTime = 0, development = false
const requestFrame = vi.fn((callback: FrameRequestCallback) => {const id = ++animationFrameId;animationFrames.set(id, callback);return id})
const cancelFrame = vi.fn((id: number) => {animationFrames.delete(id)})
function flushFrames() {const batch = [...animationFrames.values()];animationFrames.clear();frameTime += 16;batch.forEach(callback => callback(frameTime))}
const geometry = {visible: true, tops: new Map<string, number>()}
const observers: {callback: () => void; observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>}[] = []
function descendants(n: Node): Node[] {return (n.children || []).flatMap(child => [child, ...descendants(child)])}
function publicNode(predicate: (n: Node) => boolean): Node {const n = descendants(hostRoot).find(predicate);expect(n).toBeDefined();return n!}
function groupHeader(id: string): Node {
  const section = publicNode(n => n.props['data-service-section'] === id)
  const header = descendants(section).find(n => n.props.class === 'directory-section-toggle');expect(header).toBeDefined();return header!
}
function navigation(id: string): Node {return publicNode(n => n.props['data-service-group-link'] === id)}
function queryInput(): Node {return publicNode(n => n.tag === 'input' && n.props.type === 'search')}
async function search(value: string) {queryInput().props.onInput({currentTarget: {value}});await settle()}
function observer() {const current = observers.at(-1);expect(current).toBeDefined();return current!}

const focus = vi.fn(), scroll = vi.fn(), workspaceScroll = vi.fn(), emitted = vi.fn(), defaultEmitted = vi.fn(), send = vi.fn()
const intervals = new Map<number, () => void>(), timeouts = new Map<number, () => void>()
let timerId = -1
const timerCount = () => intervals.size + timeouts.size
async function tickIntervals(count = 1) {for (let i = 0; i < count; i++) {for (const callback of [...intervals.values()]) callback();await settle()}}
const providerNames = ['microsoft', 'google']
const catalog = [{value: 'machine', label: 'Machine', disabled: true}, {value: 'microsoft', label: 'Microsoft'}, {value: 'google', label: 'Google'}]
async function settle(frames = true) {await runtime.nextTick();await Promise.resolve();if (frames) flushFrames();await runtime.nextTick();await Promise.resolve()}
function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no});return {promise, resolve, reject}}
function response(ids = props.config.freeTranslationOrder) {return {success: true, snapshot: calculateFreeTranslationWeightSnapshot(ids, [], 123)}}
function node(predicate: (n: Node) => boolean) {const found = [...nodes].reverse().find(predicate);expect(found).toBeDefined();return found!}
beforeEach(async () => {
  vi.clearAllMocks();intervals.clear();timeouts.clear();observers.length = 0;animationFrames.clear();fontListeners.clear();geometry.visible = true;geometry.tops.clear();reducedMotion.mockReturnValue(false);development = false
  vi.stubGlobal('requestAnimationFrame', requestFrame);vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  // 免费设置会注册/释放页面恢复事件；端口保留真实 EventTarget 语义，不用空函数掩盖监听生命周期。
  vi.stubGlobal('document', Object.assign(new EventTarget(), {visibilityState: 'visible', fonts: {addEventListener: (_type: string, callback: () => void) => fontListeners.add(callback), removeEventListener: (_type: string, callback: () => void) => fontListeners.delete(callback)}}))
  vi.stubGlobal('window', Object.assign(new EventTarget(), {matchMedia: () => ({matches: reducedMotion()})}))
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();unobserve = vi.fn();disconnect = vi.fn()
    constructor(callback: () => void) {observers.push({callback, observe: this.observe, unobserve: this.unobserve, disconnect: this.disconnect})}
  })
  send.mockReset();send.mockResolvedValue({success: false})
  vi.doMock('webextension-polyfill', () => ({default: {runtime: {sendMessage: send}}}))
  vi.doMock('@/src/ui/i18n', () => ({useUiI18n: () => ({t: (key: string) => key, translateLegacy: (text: string) => text})}))
  vi.doMock('@/src/platform/chatgpt-plan/buildMode', () => ({get chatGPTPlanDevelopmentEnabled() {return development}}))
  const display = () => ({default: {setup(_: unknown, {attrs, slots}: any) {return () => runtime.h('button', {...attrs, 'data-directory-port': attrs.item?.value}, slots.default?.())}}})
  vi.doMock('@/src/ui/components/ServiceIcon.vue', display)
  vi.doMock('@/src/features/settings/ui/services/ServiceNatureBadge.vue', display)
  vi.doMock('@/src/features/settings/ui/services/ModelPicker.vue', display)
  vi.doMock('@/src/features/settings/ui/services/ServiceCatalogItem.vue', display)
  vi.doMock('@/src/features/settings/ui/components/FieldHelp.vue', display)
})
afterEach(async () => {
  try {app?.unmount();await settle()}
  finally {vi.restoreAllMocks();vi.unstubAllGlobals()}
})
async function mount(name: string, values: Record<string, unknown>, listeners: Record<string, unknown> = {}) {
  vi.resetModules()
  const component = name === 'ServiceCatalog'
    ? (await import('@/src/features/settings/ui/services/ServiceCatalog.vue')).default
    : (await import('@/src/features/settings/ui/services/FreeTranslationSettings.vue')).default
  if (!vi.isMockFunction(globalThis.setInterval)) {
    const originalInterval = globalThis.setInterval, originalTimeout = globalThis.setTimeout, clearInterval = globalThis.clearInterval, clearTimeout = globalThis.clearTimeout
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number, ...args: any[]) => {
      if (ms !== FREE_TRANSLATION_WEIGHT_REFRESH_INTERVAL_MS) return originalInterval(callback, ms, ...args)
      const id = timerId--;intervals.set(id, callback);return id
    }) as typeof setInterval)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: any) => {if (!intervals.delete(id)) clearInterval(id)}) as typeof globalThis.clearInterval)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number, ...args: any[]) => {
      if (ms !== 10_000) return originalTimeout(callback, ms, ...args)
      const id = timerId--;timeouts.set(id, callback);return id
    }) as typeof setTimeout)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: any) => {if (!timeouts.delete(id)) clearTimeout(id)}) as typeof globalThis.clearTimeout)
  }
  nodes = [];shown = runtime.ref(true)
  function remove(n: Node) {if (n.parent?.children) {const list = n.parent.children, index = list.indexOf(n);if (index >= 0) list.splice(index, 1)}n.parent = undefined}
  function insert(n: Node, parent: Node, anchor?: Node | null) {remove(n);const list = parent.children ||= [];const index = anchor ? list.indexOf(anchor) : -1;list.splice(index < 0 ? list.length : index, 0, n);n.parent = parent}
  const renderer = runtime.createRenderer<Node, Node>({patchProp: (n, key, _before, value) => {n.props[key] = value;if (key === 'value') n.value = value}, insert, remove,
    createElement: tag => {
      const n: Node = {tag, value: '', props: {}, style: {}, focus, closest: selector => {
        let parent: Node | undefined = n
        while (parent && `.${parent.props.class}` !== selector) parent = parent.parent
        return parent
      },
        get dataset() {return {serviceSection: n.props['data-service-section']}},
        scrollTop: 0, clientHeight: 100, scrollHeight: 500,
        getClientRects: () => {readRects(n);return geometry.visible ? [{}] : []},
        getBoundingClientRect: () => {
          readBounds(n)
          let parent = n.parent
          while (parent && parent.props.class !== 'service-groups') parent = parent.parent
          return {top: (geometry.tops.get(n.props['data-service-section']) ?? 0) - (parent?.scrollTop || 0)}
        },
        querySelectorAll: selector => {sectionQueries(n);return descendants(n).filter(child => selector === '[data-service-section]' && child.props['data-service-section'])},
      }
      Object.assign(n, {tagName: tag.toUpperCase(), addEventListener: () => {}, removeEventListener: () => {},
        querySelector: (selector: string) => descendants(n).find(child => `.${child.props.class}` === selector),
        scrollTo: (options: ScrollToOptions) => {
          if (n.props.class === 'service-groups') {groupScroll(options);return}
          if (n.props.class === 'catalog-layout') workspaceScroll(options)
          else if (n.props.class === 'service-detail') scroll(options)
          n.scrollTop = options.top ?? n.scrollTop
        },
      })
      nodes.push(n);return n
    },
    createText: value => ({tag: '#text', props: {}, value}), createComment: () => ({tag: '#comment', props: {}}), setText: (n, value) => {n.value = value}, setElementText: (n, value) => {n.value = value},
    parentNode: n => n.parent || null, nextSibling: n => {const list = n.parent?.children || [];return list[list.indexOf(n) + 1] || null}, querySelector: () => null, setScopeId: () => {}, cloneNode: n => ({...n}),
    insertStaticContent: (_html, parent, anchor) => {const start = {tag: '#static-start', props: {}}, end = {tag: '#static-end', props: {}};insert(start, parent, anchor);insert(end, parent, anchor);return [start, end]}})
  source = runtime.shallowReactive({active: true, context: {}, ...values})
  app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => shown.value
    ? runtime.h(component as runtime.Component, {...source, ...listeners, ref: (vm: any) => {if (vm) {state = vm.$.setupState;props = vm.$.props}}})
    : runtime.h({render: () => null}, {key: 'other'})})})
  const display = {setup(_props: unknown, {attrs, slots}: any) {return () => runtime.h('input', attrs, slots.default?.())}}
  app.component('el-input', display);app.component('el-input-number', display);app.component('el-switch', display)
  app.component('el-tooltip', {setup(_props: unknown, {slots}: any) {return () => runtime.h('span', null, slots.default?.())}})
  app.config.warnHandler = () => {};hostRoot = {tag: '#root', props: {}};app.mount(hostRoot);await settle()
}
async function openProviders(open: boolean) {
  publicNode(n => n.props['data-free-provider-disclosure'] !== undefined).props.onToggle({currentTarget: {open}})
  await settle()
}
async function mountFree(values: Record<string, unknown> = {}) {
  await mount('FreeTranslationSettings', {config: runtime.reactive(new Config()), ...values})
}
async function mountCatalog(values: Record<string, unknown> = {}, listeners: Record<string, unknown> = {}) {await mount('ServiceCatalog', {service: 'microsoft', defaultService: 'microsoft', services: catalog,
  favoriteServices: [], configuredServices: [], modelOptions: [], showModel: false, maximumModels: 5, maximumModelLength: 50, customModelCount: 0, allowCustomModels: false, ...values}, {'onUpdate:service': emitted, 'onUpdate:default-service': defaultEmitted, 'onAdd:service': emitted, ...listeners})}
function invalidate(reason: string) {
  if (reason === 'hidden') props.active = false
  if (reason === 'cached') shown.value = false
  if (reason === 'unmount') app.unmount()
  if (reason === 'config') props.config = runtime.reactive(new Config())
  if (reason === 'context') props.context = {}
  if (reason === 'advanced') props.advanced = true
  if (reason === 'sequential') props.config.freeTranslationMode = 'sequential'
  if (reason === 'service') props.service = 'google'
}

describe('免费设置的轮询和模板事件归属', () => {
  it('默认展开即轮询，手动收起立即取消等待并拒绝迟到结果，再展开重新读取', async () => {
    const pending = deferred<unknown>();send.mockReturnValueOnce(pending.promise)
    await mountFree()
    expect(publicNode(n => n.props['data-free-provider-disclosure'] !== undefined).props.open).toBe(true)
    expect(send).toHaveBeenCalledOnce();expect(timerCount()).toBe(2)
    // 表单仍挂载，既有节点开关和邮箱草稿不因折叠丢失。
    expect(descendants(hostRoot).filter(n => n.props['data-fallback-provider'])).toHaveLength(FREE_TRANSLATION_PROVIDERS.length)
    state.myMemoryEmailDraft = 'unsaved@example.test'
    await openProviders(false);expect(timerCount()).toBe(0);expect(state.myMemoryEmailDraft).toBe('unsaved@example.test')
    pending.resolve(response());await settle();expect(state.weightSnapshot).toBeNull()
    await tickIntervals(2);expect(send).toHaveBeenCalledOnce()
    send.mockResolvedValueOnce(response());await openProviders(true)
    expect(send).toHaveBeenCalledTimes(2);expect(state.weightSnapshot.observedAt).toBe(123);expect(timerCount()).toBe(1)
    props.active = false;await settle();expect(timerCount()).toBe(0)
  })
  it.each(['hidden', 'cached', 'unmount', 'config', 'advanced', 'sequential'])('%s之后丢弃旧权重响应，停用时不再轮询', async reason => {
    const pending = deferred<unknown>();send.mockReturnValueOnce(pending.promise);await mountFree();const old = response();expect(send).toHaveBeenCalledOnce()
    invalidate(reason);await settle();pending.resolve(old);await settle();expect(state.weightSnapshot?.observedAt).not.toBe(123)
    if (reason !== 'config') {await tickIntervals(2);expect(send).toHaveBeenCalledOnce();expect(timerCount()).toBe(0)}
  })
  it('初始顺序策略与高级字段不创建权重计时器，回到分流模式创建一条轮询', async () => {
    const config = runtime.reactive(new Config());config.freeTranslationMode = 'sequential';await mountFree({config});expect(send).not.toHaveBeenCalled();expect(timerCount()).toBe(0)
    state.setMode('balanced');await settle();expect(send).toHaveBeenCalledOnce();expect(timerCount()).toBe(1)
    props.advanced = true;await settle();expect(timerCount()).toBe(0);props.advanced = false;await settle();expect(send).toHaveBeenCalledTimes(2);expect(timerCount()).toBe(1)
  })
  it('目录已移除的免费线路从界面隐藏，重排可见线路时保留它的原位置', async () => {
    const config = runtime.reactive(new Config())
    config.freeTranslationMode = 'sequential'
    config.freeTranslationOrder = ['microsoft', 'myMemory', 'google']
    config.disabledTranslationServices = ['myMemory']
    await mountFree({config})
    const visible = () => descendants(hostRoot).filter(n => n.props['data-fallback-provider']).map(n => n.props['data-fallback-provider'])
    expect(visible().slice(0, 2)).toEqual(['microsoft', 'google'])
    expect(visible()).not.toContain('myMemory')
    state.move('microsoft', 1);await settle()
    expect(config.freeTranslationOrder).toEqual(['google', 'myMemory', 'microsoft'])
    config.disabledTranslationServices = [];await settle()
    expect(visible().slice(0, 3)).toEqual(['google', 'myMemory', 'microsoft'])
  })
  it('同一轮读取合并并发调用，完成后允许下一轮', async () => {
    await mountFree();send.mockClear();const pending = deferred<unknown>();send.mockReturnValue(pending.promise)
    const first = state.refreshWeights(), second = state.refreshWeights();expect(send).toHaveBeenCalledOnce();pending.resolve(response());await Promise.all([first, second]);expect(state.weightSnapshot.observedAt).toBe(123)
    send.mockResolvedValue({success: false});await state.refreshWeights();expect(send).toHaveBeenCalledTimes(2);expect(state.weightSnapshot).toBeNull()
  })
  it('同一渲染批次中的顺序变更只读取最终一次，旧状态立即回退本地', async () => {
    await mountFree();state.weightSnapshot = response().snapshot;send.mockClear()
    props.config.freeTranslationOrder = ['microsoft'];props.config.freeTranslationOrder = [...providerNames];props.config.myMemoryEmail = 'fixture@example.test'
    expect(state.weightSnapshot).toBeNull();await settle();expect(send).toHaveBeenCalledOnce();expect(timerCount()).toBe(1)
  })
  it('悬挂读取十秒结束等待，迟到失败不污染下一轮且没有未处理拒绝', async () => {
    await mountFree();const pending = deferred<unknown>();send.mockReturnValueOnce(pending.promise);let ended = false
    void state.refreshWeights().then(() => {ended = true});for (const callback of [...timeouts.values()]) callback();await settle();expect(ended).toBe(true);expect(state.weightSnapshot).toBeNull()
    send.mockResolvedValue(response());await state.refreshWeights();expect(state.weightSnapshot.observedAt).toBe(123);pending.reject(new Error('late'));await settle();expect(state.weightSnapshot.observedAt).toBe(123);expect(timerCount()).toBe(1)
  })
  it('拒绝后台仍属于旧启停集合的快照，保留当前全目录和本地分配', async () => {
    await mountFree();send.mockResolvedValue(response(['google']));await state.refreshWeights();expect(state.weightSnapshot).toBeNull()
    const ids = FREE_TRANSLATION_PROVIDERS.map(provider => provider.id)
    expect(state.displayedWeightSnapshot.entries.map((entry: {providerId: string}) => entry.providerId)).toEqual(ids)
    expect(descendants(hostRoot).filter(n => n.props['data-fallback-provider']).map(n => n.props['data-fallback-provider'])).toEqual(ids)
    send.mockResolvedValue(response());await state.refreshWeights();expect(state.weightSnapshot.observedAt).toBe(123)
  })
  it.each(['entries', 'total', 'weight', 'provider', 'status'])('损坏的%s快照回退本地而不使模板崩溃', async reason => {
    await mountFree();const value = response() as any
    if (reason === 'entries') value.snapshot.entries = null
    if (reason === 'total') value.snapshot.total = Number.NaN
    if (reason === 'weight') value.snapshot.entries[0].weight = -1
    if (reason === 'provider') value.snapshot.entries[0].providerId = 'unknown'
    if (reason === 'status') value.snapshot.entries[0].status = 'unknown'
    send.mockResolvedValue(value);await state.refreshWeights();expect(state.weightSnapshot).toBeNull();await settle()
  })
  it('实际缓存模板的旧模式、开关和邮箱事件不得写入新配置', async () => {
    const config = runtime.reactive(new Config());config.freeTranslationOrder = [...providerNames];await mountFree({config})
    const mode = publicNode(n => n.tag === 'input' && n.props.value === 'sequential').props.onChange
    const providerToggle = () => {
      const row = publicNode(n => n.props['data-fallback-provider'] === 'alibabaFree')
      const toggle = descendants(row).find(n => typeof n.props['onUpdate:modelValue'] === 'function');expect(toggle).toBeDefined();return toggle!
    }
    const toggle = providerToggle().props['onUpdate:modelValue'];expect(providerToggle().props['model-value'] ?? providerToggle().props.modelValue).toBe(false)
    const email = publicNode(n => n.tag === 'input' && n.props.type === 'email');const update = email.props['onUpdate:modelValue'], commit = email.props.onChange
    const replacement = runtime.reactive(new Config());replacement.freeTranslationOrder = [...providerNames];source.config = replacement
    await settle();mode();toggle(true);update('late@example.test');commit()
    expect(replacement.freeTranslationMode).toBe('balanced');expect(replacement.freeTranslationOrder).toEqual(providerNames);expect(replacement.myMemoryEmail).toBe('');expect(state.myMemoryEmailDraft).toBe('')
    publicNode(n => n.tag === 'input' && n.props.value === 'sequential').props.onChange();expect(replacement.freeTranslationMode).toBe('sequential')
    providerToggle().props['onUpdate:modelValue'](true);expect(replacement.freeTranslationOrder).toEqual([...providerNames, 'alibabaFree'])
    const currentEmail = publicNode(n => n.tag === 'input' && n.props.type === 'email')
    currentEmail.props['onUpdate:modelValue']('current@example.test');currentEmail.props.onChange();expect(replacement.myMemoryEmail).toBe('current@example.test')
  })
  it('隐藏清空未提交邮箱并拒绝直接动作，重开不复活旧超时回调', async () => {
    await mountFree();state.myMemoryEmailDraft = 'draft@example.test';invalidate('hidden');await settle();expect(state.myMemoryEmailDraft).toBe('')
    state.setMode('sequential');state.toggle('deeplx', true);state.move('microsoft', 1);state.myMemoryEmailDraft = 'late@example.test';state.commitMyMemoryEmail();expect(props.config.myMemoryEmail).toBe('');expect(props.config.freeTranslationMode).toBe('balanced');expect(props.config.freeTranslationOrder).not.toContain('deeplx')
    app.unmount();await mountFree({advanced: true});const old = node(n => n.props['aria-label'] === 'settings.services.waitTimeout').props['onUpdate:modelValue'];const initial = props.config.freeTranslationTimeoutMs
    props.active = false;await settle();props.active = true;await settle();old(9);expect(props.config.freeTranslationTimeoutMs).toBe(initial)
    node(n => n.props['aria-label'] === 'settings.services.waitTimeout').props['onUpdate:modelValue'](9);expect(props.config.freeTranslationTimeoutMs).toBe(9000)
  })
  it('未知模式、非布尔开关与分流模式排序不写入配置', async () => {
    await mountFree();const original = props.config.freeTranslationOrder.slice();state.setMode('unknown');state.toggle('deeplx', 'yes');state.move('microsoft', 1)
    expect(props.config.freeTranslationMode).toBe('balanced');expect(props.config.freeTranslationOrder).toEqual(original)
    state.setMode('sequential');state.move('microsoft', 2);expect(props.config.freeTranslationOrder).toEqual(original);state.move('microsoft', 1);expect(props.config.freeTranslationOrder[1]).toBe('microsoft')
  })
  it('冷却总量为零的完整快照正常显示，读取失败回退且恢复支持新请求', async () => {
    await mountFree();const ids = props.config.freeTranslationOrder
    const snapshot = calculateFreeTranslationWeightSnapshot(ids, ids.map((providerId: string) => ({providerId, retryAt: 1000, failures: 1, category: 'network' as const})), 123)
    send.mockResolvedValueOnce({success: true, snapshot});await state.refreshWeights();expect(state.displayedWeightSnapshot.total).toBe(0);expect(state.weightStatus('microsoft')).toBe('cooling')
    send.mockRejectedValueOnce(new Error('offline'));await state.refreshWeights();expect(state.weightSnapshot).toBeNull()
    send.mockResolvedValueOnce(response());await state.refreshWeights();expect(state.weightStatus('microsoft')).toBe('ready')
  })
  it('省略可选 active 属性仍可正常读取与选择服务', async () => {
    await mountFree({active: undefined});expect(send).toHaveBeenCalledOnce();app.unmount();await mountCatalog({active: undefined});state.selectService('google');expect(emitted).toHaveBeenCalledWith('google')
  })
})

describe('服务目录的搜索和导航归属', () => {
  it('移除项只在独立加回列表可搜索，确认后的配置更新才使目录恢复该项', async () => {
    const change = vi.fn()
    await mountCatalog({disabledServices: []}, {onToggleAvailability: change})
    const google = () => descendants(hostRoot).find(n => n.props['data-directory-port'] === 'google')
    google()!.props.onRemove('google')
    expect(change).toHaveBeenLastCalledWith('google', false)
    expect(google()).toBeDefined()

    source.disabledServices = ['google'];await settle()
    expect(google()).toBeUndefined()
    state.serviceQuery = 'Google';await settle()
    expect(state.visibleDirectoryGroups).toHaveLength(0)
    publicNode(n => n.props['data-service-restore-menu'] !== undefined).props.onClick()
    state.serviceQuery = 'ＧＯＯＧＬＥ';await settle()
    publicNode(n => n.props['data-service-restore'] === 'google').props.onClick()
    expect(change).toHaveBeenLastCalledWith('google', true)
    expect(google()).toBeUndefined()

    source.disabledServices = [];await settle()
    expect(state.restoreOpen).toBe(false)
    expect(google()).toBeDefined()
  })
  it('组合归入自定义目录且目录仅保留一个添加服务入口，旧上下文事件失效', async () => {
    const added = vi.fn()
    await mountCatalog({services: [...catalog, {value: 'composite:daily', label: 'Daily'}]}, {'onAdd:service': added})
    expect(state.directoryGroups.find((group: any) => group.id === 'custom').items.map((item: any) => item.value)).toEqual(['composite:daily'])
    expect(descendants(hostRoot).filter(n => n.props['data-testid'] === 'custom-service-add')).toHaveLength(1)
    expect(descendants(hostRoot).some(n => n.props['data-testid'] === 'composite-service-add')).toBe(false)
    const old = publicNode(n => n.props['data-testid'] === 'custom-service-add').props.onClick
    props.context = {};old();expect(added).not.toHaveBeenCalled();await settle()
    publicNode(n => n.props['data-testid'] === 'custom-service-add').props.onClick();expect(added).toHaveBeenCalledOnce()
    props.active = false;publicNode(n => n.props['data-testid'] === 'custom-service-add').props.onClick();expect(added).toHaveBeenCalledOnce()
  })
  it('空搜索不读取逐项搜索字段，有关键词时缓存文本并在目录更新后失效', async () => {
    let reads = 0
    const item = runtime.reactive({value: 'custom:fixture', label: 'Fixture', get description() {reads++;return 'Ｆｕｌｌ Width'}, searchTerms: ['Alias']})
    await mountCatalog({services: [item]});reads = 0;state.serviceQuery = ' ';await settle();expect(reads).toBe(0)
    state.serviceQuery = 'full';await settle();expect(state.visibleDirectoryGroups[0].items[0].value).toBe('custom:fixture');const first = reads;expect(first).toBeGreaterThan(0)
    state.serviceQuery = 'ALIAS';await settle();expect(reads).toBe(first);state.serviceQuery = 'missing';await settle();expect(state.visibleDirectoryGroups).toEqual([]);expect(reads).toBe(first)
    item.label = 'Missing';await settle();expect(state.visibleDirectoryGroups[0].items[0].label).toBe('Missing');expect(reads).toBeGreaterThan(first)
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('实际缓存模板的旧目录选择在%s之后失效', async reason => {
    await mountCatalog();const old = node(n => n.props['data-directory-port'] === 'google').props.onSelect
    invalidate(reason);await settle();scroll.mockClear();workspaceScroll.mockClear();old('google');await settle();expect(emitted).not.toHaveBeenCalled()
    expect(scroll).not.toHaveBeenCalled();expect(workspaceScroll).not.toHaveBeenCalled()
    if (reason === 'service' || reason === 'context') {const target = reason === 'service' ? 'microsoft' : 'google';node(n => n.props['data-directory-port'] === target).props.onSelect(target);expect(emitted).toHaveBeenCalledWith(target)}
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('目录延迟焦点与滚动在%s之后失效', async reason => {
    await mountCatalog();state.directoryOpen = true;state.directoryToggle = {focus};state.addButton = {closest: () => ({scrollTo: workspaceScroll, querySelector: () => ({scrollTo: scroll})})}
    props.service = 'google';if (reason === 'service') props.service = 'microsoft';else invalidate(reason);await settle();expect(focus).not.toHaveBeenCalled()
    if (reason === 'service') {expect(scroll).toHaveBeenCalledOnce();expect(workspaceScroll).toHaveBeenCalledOnce()}
    else {expect(scroll).not.toHaveBeenCalled();expect(workspaceScroll).not.toHaveBeenCalled()}
  })
  it('当前服务标题始终支持程序聚焦且不加入普通Tab顺序', async () => {
    await mountCatalog();expect(publicNode(n => n.tag === 'h4' && n.parent?.props.class === 'detail-title-row').props.tabindex).toBe('-1')
    source.active = false;await settle();source.active = true;source.service = 'google';await settle()
    expect(publicNode(n => n.tag === 'h4' && n.parent?.props.class === 'detail-title-row').props.tabindex).toBe('-1')
  })
  it('正常切换或重复当前服务都关闭目录、恢复一次焦点并回到配置顶部', async () => {
    await mountCatalog();state.directoryOpen = true;props.service = 'google';await settle();expect(state.directoryOpen).toBe(false);expect(focus).toHaveBeenCalledOnce();expect(scroll).toHaveBeenCalledOnce()
    focus.mockClear();scroll.mockClear();workspaceScroll.mockClear();state.directoryOpen = true;await state.selectService('google');await settle()
    expect(focus).toHaveBeenCalledOnce();expect(scroll).toHaveBeenCalledOnce();expect(workspaceScroll).toHaveBeenCalledOnce();expect(emitted).not.toHaveBeenCalled()
  })
  it.each(['google', 'microsoft'])('实际目录选择%s关闭目录并立即重置工作区和详情滚动，默认服务仍独立', async service => {
    await mountCatalog({}, {'onUpdate:service': (value: string) => {emitted(value);source.service = value}})
    publicNode(n => n.props.class === 'mobile-directory-toggle').props.onClick();await settle()
    const workspace = publicNode(n => n.props.class === 'catalog-layout'), detail = publicNode(n => n.props.class === 'service-detail')
    workspace.scrollTop = 800;detail.scrollTop = 600;focus.mockClear();scroll.mockClear();workspaceScroll.mockClear()
    publicNode(n => n.props['data-directory-port'] === service).props.onSelect(service);await settle()
    expect(workspace.scrollTop).toBe(0);expect(detail.scrollTop).toBe(0)
    expect(workspaceScroll).toHaveBeenCalledOnce();expect(workspaceScroll).toHaveBeenCalledWith({top: 0, behavior: 'instant'})
    expect(scroll).toHaveBeenCalledOnce();expect(scroll).toHaveBeenCalledWith({top: 0, behavior: 'instant'})
    expect(focus).toHaveBeenCalledOnce();expect(state.directoryOpen).toBe(false)
    expect(publicNode(n => n.props.class === 'service-catalog').props['data-editing-service']).toBe(service)
    expect(source.defaultService).toBe('microsoft')
    if (service === 'microsoft') expect(emitted).not.toHaveBeenCalled()
    else expect(emitted).toHaveBeenCalledWith('google')
  })
  it.each(['hidden', 'cached'])('%s后重新进入同一服务配置，从实际工作区和详情顶部开始', async reason => {
    await mountCatalog();const workspace = publicNode(n => n.props.class === 'catalog-layout'), detail = publicNode(n => n.props.class === 'service-detail')
    workspace.scrollTop = 800;detail.scrollTop = 600
    invalidatePublic(reason);await settle()
    expect(scroll).not.toHaveBeenCalled();expect(workspaceScroll).not.toHaveBeenCalled();await reopenPublic(reason)
    expect(source.service).toBe('microsoft');expect(workspace.scrollTop).toBe(0);expect(detail.scrollTop).toBe(0)
    expect(workspaceScroll).toHaveBeenCalledOnce();expect(scroll).toHaveBeenCalledOnce()
    expect(workspaceScroll).toHaveBeenCalledWith({top: 0, behavior: 'instant'});expect(scroll).toHaveBeenCalledWith({top: 0, behavior: 'instant'})
    expect(focus).not.toHaveBeenCalled();expect(emitted).not.toHaveBeenCalled()
  })
  it('持续活跃时替换配置保留两区位置，之后重新进入当前配置才回到顶部', async () => {
    await mountCatalog();const workspace = publicNode(n => n.props.class === 'catalog-layout'), detail = publicNode(n => n.props.class === 'service-detail')
    workspace.scrollTop = 800;detail.scrollTop = 600
    source.context = {};await settle()
    expect(workspace.scrollTop).toBe(800);expect(detail.scrollTop).toBe(600)
    expect(workspaceScroll).not.toHaveBeenCalled();expect(scroll).not.toHaveBeenCalled()
    source.active = false;await settle();source.active = true;await settle()
    expect(workspace.scrollTop).toBe(0);expect(detail.scrollTop).toBe(0)
    expect(workspaceScroll).toHaveBeenCalledOnce();expect(scroll).toHaveBeenCalledOnce()
    expect(focus).not.toHaveBeenCalled();expect(emitted).not.toHaveBeenCalled()
  })
  it.each(['hidden', 'cached', 'unmount', 'context'])('同服务目录选择排队后%s，迟到回调不能重置两个滚动区', async reason => {
    await mountCatalog();const workspace = publicNode(n => n.props.class === 'catalog-layout'), detail = publicNode(n => n.props.class === 'service-detail')
    workspace.scrollTop = 800;detail.scrollTop = 600
    publicNode(n => n.props['data-directory-port'] === 'microsoft').props.onSelect('microsoft')
    invalidatePublic(reason);await settle()
    expect(workspace.scrollTop).toBe(800);expect(detail.scrollTop).toBe(600)
    expect(workspaceScroll).not.toHaveBeenCalled();expect(scroll).not.toHaveBeenCalled()
  })
  it('隐藏或替换上下文后旧搜索、创建和展开回调不能修改当前目录', async () => {
    await mountCatalog();const search = node(n => n.tag === 'input').props.onInput
    const add = node(n => n.props['data-testid'] === 'custom-service-add').props.onClick, open = node(n => n.props.class === 'mobile-directory-toggle').props.onClick
    state.serviceQuery = 'draft';state.directoryOpen = true;invalidate('hidden');await settle();expect(state.directoryOpen).toBe(false);expect(state.serviceQuery).toBe('')
    props.active = true;await settle();search({currentTarget: {value: 'late'}});add();open();expect(state.directoryOpen).toBe(false);expect(state.serviceQuery).toBe('');expect(emitted).not.toHaveBeenCalled()
    node(n => n.props['data-testid'] === 'custom-service-add').props.onClick();expect(emitted).toHaveBeenCalledOnce()
  })
  it('拒绝目录标题、未知服务和停用动作，配置选择与默认服务保持分离', async () => {
    await mountCatalog();state.selectService('machine');state.selectService('missing');expect(emitted).not.toHaveBeenCalled();state.selectService('google');expect(emitted).toHaveBeenCalledWith('google');expect(props.defaultService).toBe('microsoft')
    emitted.mockClear();props.active = false;await settle();state.selectService('google');expect(emitted).not.toHaveBeenCalled()
  })
})

describe('服务详情的显式默认服务动作', () => {
  it.each(['microsoft', 'chatgptPlan'])('公开版默认%s的旧套餐详情完全隐藏且保留模型，不执行默认动作', async defaultService => {
    const config = runtime.reactive(new Config());config.service = defaultService;config.model.chatgptPlan = 'saved-account-model'
    await mountCatalog({service: 'chatgptPlan', defaultService, context: config, services: catalog, modelOptions: ['saved-account-model']})
    expect(state.selectedService).toBeUndefined()
    expect(descendants(hostRoot).some(n => n.props.class === 'service-catalog' || n.props.class === 'service-detail')).toBe(false)
    expect(descendants(hostRoot).filter(n => n.props['data-set-default-service-button'] !== undefined)).toEqual([])
    const before = JSON.stringify(config)
    const saved = state.actions.setDefaultService
    saved();state.setDefaultService();await settle()
    expect(defaultEmitted).not.toHaveBeenCalled();expect(emitted).not.toHaveBeenCalled()
    expect(JSON.stringify(config)).toBe(before);expect(props.defaultService).toBe(defaultService)
    expect(config.model.chatgptPlan).toBe('saved-account-model');expect(send).not.toHaveBeenCalled()
  })
  it('公开版即使调用方带入可选套餐条目，旧按钮与直接默认动作也不能绕过门控', async () => {
    await mountCatalog({service: 'google', services: [...catalog, {value: 'chatgptPlan', label: 'ChatGPT 套餐'}]})
    expect(state.allServices.some((item: {value: string}) => item.value === 'chatgptPlan')).toBe(false)
    expect(descendants(hostRoot).some(n => n.props['data-directory-port'] === 'chatgptPlan')).toBe(false)
    const saved = publicNode(n => n.props['data-set-default-service-button'] !== undefined).props.onClick
    source.service = 'chatgptPlan';await settle()
    expect(descendants(hostRoot).filter(n => n.props['data-set-default-service-button'] !== undefined)).toEqual([])
    saved();state.actions.setDefaultService();state.setDefaultService()
    expect(defaultEmitted).not.toHaveBeenCalled();expect(emitted).not.toHaveBeenCalled();expect(props.defaultService).toBe('microsoft')
  })
  it('开发版显式套餐夹具仍允许通过实际详情按钮设为默认', async () => {
    development = true
    await mountCatalog({service: 'chatgptPlan', services: [...catalog, {value: 'chatgptPlan', label: 'ChatGPT 套餐'}]})
    const button = publicNode(n => n.props['data-set-default-service-button'] !== undefined)
    expect(button.props.disabled).toBeFalsy();button.props.onClick()
    expect(defaultEmitted).toHaveBeenCalledOnce();expect(defaultEmitted).toHaveBeenCalledWith('chatgptPlan')
    expect(emitted).not.toHaveBeenCalled();expect(props.defaultService).toBe('microsoft')
  })
  it.each(['google', 'freeTranslation', 'localTranslation', 'openai', 'custom:fixture'])('仅显式点击把正在配置的%s设为默认，不复用目录选择事件', async service => {
    await mountCatalog({service, services: [...catalog, {value: 'freeTranslation', label: 'Free'}, {value: 'localTranslation', label: 'Local'}, {value: 'openai', label: 'OpenAI'}, {value: 'custom:fixture', label: 'Fixture'}]})
    expect(defaultEmitted).not.toHaveBeenCalled()
    const button = publicNode(n => n.props['data-set-default-service-button'] !== undefined)
    expect(button.props.disabled).toBeFalsy()
    button.props.onClick()
    expect(defaultEmitted).toHaveBeenCalledOnce();expect(defaultEmitted).toHaveBeenCalledWith(service)
    expect(emitted).not.toHaveBeenCalled()
    expect(props.defaultService).toBe('microsoft')
    expect(send).not.toHaveBeenCalled()
    source.defaultService = service;await settle()
    expect(publicNode(n => n.props['data-set-default-service-button'] !== undefined).props.disabled).toBe(true)
    state.actions.setDefaultService();expect(defaultEmitted).toHaveBeenCalledOnce()
  })
  it.each(['microsoft', 'missing', 'machine'])('当前默认、未知或停用的%s不能触发设置默认服务', async service => {
    await mountCatalog({service})
    state.actions.setDefaultService()
    expect(defaultEmitted).not.toHaveBeenCalled()
    expect(emitted).not.toHaveBeenCalled()
  })
  it('停用的实际服务按钮不可用，直接调用也不设置默认', async () => {
    await mountCatalog({service: 'google', services: catalog.map(item => item.value === 'google' ? {...item, disabled: true} : item)})
    expect(publicNode(n => n.props['data-set-default-service-button'] !== undefined).props.disabled).toBe(true)
    state.actions.setDefaultService()
    expect(defaultEmitted).not.toHaveBeenCalled()
  })
  it('浏览目录仍仅切换配置服务，停用后直接调用默认动作也无效', async () => {
    await mountCatalog({service: 'google'})
    publicNode(n => n.props['data-directory-port'] === 'microsoft').props.onSelect('microsoft')
    expect(emitted).toHaveBeenCalledOnce();expect(emitted).toHaveBeenCalledWith('microsoft')
    expect(defaultEmitted).not.toHaveBeenCalled()
    source.active = false;await settle()
    state.actions.setDefaultService()
    expect(defaultEmitted).not.toHaveBeenCalled()
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('%s后旧默认按钮不能修改当前服务，重新激活的当前按钮可用', async reason => {
    await mountCatalog({defaultService: 'freeTranslation', services: [...catalog, {value: 'freeTranslation', label: 'Free'}]})
    const old = publicNode(n => n.props['data-set-default-service-button'] !== undefined).props.onClick
    invalidatePublic(reason);await settle();await reopenPublic(reason)
    old()
    expect(defaultEmitted).not.toHaveBeenCalled()
    if (reason !== 'unmount') {
      publicNode(n => n.props['data-set-default-service-button'] !== undefined).props.onClick()
      expect(defaultEmitted).toHaveBeenCalledOnce();expect(defaultEmitted).toHaveBeenCalledWith(source.service)
    }
  })
})


const groupedCatalog = [...catalog, {value: 'custom:fixture', label: 'Fixture custom'}]
function invalidatePublic(reason: string): void {
  if (reason === 'hidden') source.active = false
  else if (reason === 'cached') shown.value = false
  else if (reason === 'unmount') app.unmount()
  else if (reason === 'context') source.context = {}
  else if (reason === 'service') source.service = 'google'
}
async function reopenPublic(reason: string): Promise<void> {
  if (reason === 'hidden') source.active = true
  else if (reason === 'cached') shown.value = true
  await settle()
}
async function reopenPublicWithoutFrames(reason: string): Promise<void> {
  if (reason === 'hidden') source.active = true
  else if (reason === 'cached') shown.value = true
  await settle(false)
}
function scroller(): Node {return publicNode(n => n.props.class === 'service-groups')}
async function mountGroups(): Promise<void> {
  geometry.tops.set('machine-services', 0);geometry.tops.set('custom', 180)
  await mountCatalog({services: groupedCatalog})
}

describe('服务分组导航的公共客户端生命周期', () => {
  it('连续滚动每帧只排一次，使用缓存位置而不重新读取目录几何', async () => {
    await mountGroups();requestFrame.mockClear();sectionQueries.mockClear();readBounds.mockClear();readRects.mockClear()
    scroller().scrollTop = 190
    for (let i = 0; i < 40; i++) scroller().props.onScrollPassive()
    expect(requestFrame).toHaveBeenCalledOnce();expect(animationFrames.size).toBe(1)
    expect(navigation('machine-services').props['aria-current']).toBe('location')
    await settle();expect(navigation('custom').props['aria-current']).toBe('location')
    expect(sectionQueries).not.toHaveBeenCalled();expect(readBounds).not.toHaveBeenCalled();expect(readRects).not.toHaveBeenCalled()
    scroller().scrollTop = 0
    for (let i = 0; i < 20; i++) scroller().props.onScrollPassive()
    await settle();expect(requestFrame).toHaveBeenCalledTimes(2)
    expect(navigation('machine-services').props['aria-current']).toBe('location')
    expect(sectionQueries).not.toHaveBeenCalled();expect(readBounds).not.toHaveBeenCalled()
  })
  it('尺寸、字体、折叠和滚动同帧合并一次测量，分组尺寸也被观察', async () => {
    await mountGroups();expect(observer().observe).toHaveBeenCalledTimes(3)
    requestFrame.mockClear();sectionQueries.mockClear();readBounds.mockClear();readRects.mockClear()
    groupHeader('machine-services').props.onClick();geometry.tops.set('custom', 120)
    for (let i = 0; i < 20; i++) {observer().callback();scroller().props.onScrollPassive()}
    for (const callback of fontListeners) callback()
    await settle(false);expect(requestFrame).toHaveBeenCalledOnce();expect(sectionQueries).not.toHaveBeenCalled()
    await settle();expect(sectionQueries).toHaveBeenCalledOnce();expect(readRects).toHaveBeenCalledOnce();expect(readBounds).toHaveBeenCalledTimes(3)
    expect(groupHeader('machine-services').props['aria-expanded']).toBe(false)
    scroller().scrollTop = 120;scroller().props.onScrollPassive();await settle()
    expect(navigation('custom').props['aria-current']).toBe('location')
    expect(sectionQueries).toHaveBeenCalledOnce();expect(readBounds).toHaveBeenCalledTimes(3)
  })
  it('字体与分组尺寸变化刷新相对位置，容器尺寸变化刷新目录末尾判断', async () => {
    await mountGroups();scroller().scrollTop = 190;scroller().props.onScrollPassive();await settle()
    expect(navigation('custom').props['aria-current']).toBe('location')
    geometry.tops.set('custom', 260);for (const callback of fontListeners) callback();await settle()
    expect(navigation('machine-services').props['aria-current']).toBe('location')
    geometry.tops.set('custom', 140);observer().callback();await settle()
    expect(navigation('custom').props['aria-current']).toBe('location')
    geometry.tops.set('custom', 450);scroller().clientHeight = 320;observer().callback();await settle()
    expect(navigation('custom').props['aria-current']).toBe('location')
    scroller().clientHeight = 100;observer().callback();await settle()
    expect(navigation('machine-services').props['aria-current']).toBe('location')
  })
  it('隐藏目录也缓存不可见状态，隐藏期间滚动不测量，重现后刷新位置', async () => {
    await mountGroups();geometry.visible = false;observer().callback();await settle()
    sectionQueries.mockClear();readBounds.mockClear();readRects.mockClear()
    scroller().scrollTop = 190
    for (let i = 0; i < 20; i++) scroller().props.onScrollPassive()
    await settle();expect(navigation('machine-services').props['aria-current']).toBe('location')
    expect(sectionQueries).not.toHaveBeenCalled();expect(readBounds).not.toHaveBeenCalled();expect(readRects).not.toHaveBeenCalled()
    geometry.visible = true;observer().callback();await settle()
    expect(sectionQueries).toHaveBeenCalledOnce();expect(readBounds).toHaveBeenCalledTimes(3)
    expect(navigation('custom').props['aria-current']).toBe('location')
  })
  it('搜索更新缓存并停止观察已移除分组，导航恢复后的滚动复用新位置', async () => {
    await mountGroups();const oldCustom = publicNode(n => n.props['data-service-section'] === 'custom')
    await search('google')
    expect(observer().unobserve.mock.calls.some(([element]) => runtime.toRaw(element) === oldCustom)).toBe(true)
    expect(observer().observe).toHaveBeenCalledTimes(3)
    await navigation('custom').props.onClick();await settle()
    expect(groupScroll).toHaveBeenCalledWith({top: 180, behavior: 'smooth'})
    expect(observer().observe).toHaveBeenCalledTimes(4)
    scroller().props.onWheelPassive();scroller().scrollTop = 180;sectionQueries.mockClear();readBounds.mockClear()
    scroller().props.onScrollPassive();await settle()
    expect(navigation('custom').props['aria-current']).toBe('location')
    expect(sectionQueries).not.toHaveBeenCalled();expect(readBounds).not.toHaveBeenCalled()
  })
  it.each([false, true])('导航等待更新/帧期间用户接管目录，nextTick已完成=%s时取消待执行跳转', async tickCompleted => {
    await mountGroups();const pending = navigation('custom').props.onClick()
    if (tickCompleted) await pending
    scroller().props.onWheelPassive();await pending;await settle()
    expect(groupScroll).not.toHaveBeenCalled()
    expect(navigation('machine-services').props['aria-current']).toBe('location')
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('%s取消已排队帧，迟到旧帧不读取目录也不覆盖新帧', async reason => {
    await mountGroups();scroller().props.onScrollPassive();const oldFrame = [...animationFrames.values()][0]
    cancelFrame.mockClear();invalidatePublic(reason);await settle(false)
    expect(cancelFrame).toHaveBeenCalledOnce()
    if (reason !== 'unmount') await reopenPublicWithoutFrames(reason)
    const currentFrames = animationFrames.size
    sectionQueries.mockClear();readBounds.mockClear();readRects.mockClear();oldFrame(frameTime)
    expect(animationFrames.size).toBe(currentFrames)
    expect(sectionQueries).not.toHaveBeenCalled();expect(readBounds).not.toHaveBeenCalled();expect(readRects).not.toHaveBeenCalled()
    if (reason !== 'unmount') {
      requestFrame.mockClear();scroller().props.onScrollPassive();expect(requestFrame).not.toHaveBeenCalled()
      await settle();expect(readRects).toHaveBeenCalledOnce()
    }
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('%s之后迟到导航帧不能滚动，旧字体事件也不能排队', async reason => {
    await mountGroups();await navigation('custom').props.onClick()
    const oldFrame = [...animationFrames.values()][0], oldFont = [...fontListeners][0]
    invalidatePublic(reason);await settle(false);requestFrame.mockClear();readBounds.mockClear()
    oldFrame(frameTime);oldFont();await settle(false)
    expect(groupScroll).not.toHaveBeenCalled();expect(readBounds).not.toHaveBeenCalled();expect(requestFrame).not.toHaveBeenCalled()
    if (reason === 'unmount' || reason === 'hidden' || reason === 'cached') expect(fontListeners.size).toBe(0)
    else expect(fontListeners.size).toBe(1)
  })
  it.each([false, true])('导航清空搜索、展开目标，并遵循 reduced-motion=%s', async reduced => {
    await mountGroups();groupHeader('custom').props.onClick();await settle()
    expect(groupHeader('custom').props['aria-expanded']).toBe(false)
    await search('google');expect(descendants(hostRoot).filter(n => n.props['data-service-section'])).toHaveLength(1)
    reducedMotion.mockReturnValue(reduced)
    await navigation('custom').props.onClick();await settle()
    expect(queryInput().props.value).toBe('');expect(groupHeader('custom').props['aria-expanded']).toBe(true)
    expect(navigation('custom').props['aria-current']).toBe('location')
    expect(groupScroll).toHaveBeenCalledOnce();expect(groupScroll).toHaveBeenCalledWith({top: 180, behavior: reduced ? 'instant' : 'smooth'})
  })
  it.each(['onWheelPassive', 'onTouchstartPassive', 'onPointerdown', 'onKeydown', 'onFocusin'])('短末组导航固定高亮，%s用户操作后恢复按滚动位置定位', async event => {
    await mountGroups();await navigation('custom').props.onClick();await settle()
    scroller().props.onScrollPassive();await settle();expect(navigation('custom').props['aria-current']).toBe('location')
    scroller().props[event]();scroller().props.onScrollPassive();await settle()
    expect(navigation('machine-services').props['aria-current']).toBe('location')
    scroller().scrollTop = 400;scroller().props.onScrollPassive();await settle()
    expect(navigation('custom').props['aria-current']).toBe('location')
  })
  it('选中折叠组内的服务及外部选择都会展开对应组，回页也展开选中组', async () => {
    await mountGroups();groupHeader('machine-services').props.onClick();await settle()
    expect(groupHeader('machine-services').props['aria-expanded']).toBe(false)
    publicNode(n => n.props['data-directory-port'] === 'microsoft').props.onSelect('microsoft');await settle()
    expect(groupHeader('machine-services').props['aria-expanded']).toBe(true)
    groupHeader('custom').props.onClick();await settle();source.service = 'custom:fixture';await settle()
    expect(groupHeader('custom').props['aria-expanded']).toBe(true)
    groupHeader('custom').props.onClick();await settle();shown.value = false;await settle();shown.value = true;await settle()
    observer().callback();await settle();expect(groupHeader('custom').props['aria-expanded']).toBe(true)
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('导航提交后%s作废 nextTick 目录滚动', async reason => {
    await mountGroups();const reveal = navigation('custom').props.onClick
    const pending = reveal();invalidatePublic(reason);await settle();await pending
    expect(groupScroll).not.toHaveBeenCalled()
  })
  it.each(['hidden', 'cached', 'context', 'service'])('%s之后旧分组事件不得清空新搜索或展开旧目标；当前事件仍可使用', async reason => {
    await mountGroups();groupHeader('custom').props.onClick();await settle()
    const oldToggle = groupHeader('custom').props.onClick, oldReveal = navigation('custom').props.onClick
    invalidatePublic(reason);await settle();await reopenPublic(reason);await search('google')
    oldToggle();await oldReveal();await settle()
    expect(queryInput().props.value).toBe('google');expect(groupScroll).not.toHaveBeenCalled()
    await search('');expect(groupHeader('custom').props['aria-expanded']).toBe(false)
    groupHeader('custom').props.onClick();await settle();expect(groupHeader('custom').props['aria-expanded']).toBe(true)
    await navigation('custom').props.onClick();await settle();expect(groupScroll).toHaveBeenCalledOnce()
  })
  it('停用时禁用导航/折叠，保存的旧事件同样无效；搜索时不能通过旧折叠事件隐藏匹配项', async () => {
    await mountGroups();const oldToggle = groupHeader('custom').props.onClick
    await search('fixture');oldToggle();await settle();await search('')
    expect(groupHeader('custom').props['aria-expanded']).toBe(true)
    const reveal = navigation('custom').props.onClick, toggle = groupHeader('custom').props.onClick
    source.active = false;await settle()
    expect(navigation('custom').props.disabled).toBe(true);expect(groupHeader('custom').props.disabled).toBe(true)
    toggle();await reveal();await settle();expect(groupScroll).not.toHaveBeenCalled()
  })
  it.each(['hidden', 'cached', 'unmount', 'context', 'service'])('%s断开旧 ResizeObserver，已排队的旧 delivery 也不得读旧目录', async reason => {
    await mountGroups();const previous = observer()
    invalidatePublic(reason);await settle();expect(previous.disconnect).toHaveBeenCalledOnce()
    readRects.mockClear();previous.callback();await settle();expect(readRects).not.toHaveBeenCalled()
    if (reason === 'context' || reason === 'service') {
      expect(observer()).not.toBe(previous);expect(observer().observe).toHaveBeenCalledTimes(3)
    } else if (reason !== 'unmount') {
      await reopenPublic(reason);expect(observer()).not.toBe(previous);expect(observer().observe).toHaveBeenCalledTimes(3)
    }
  })
  it('ResizeObserver 排队的位置更新在上下文替换后失效，当前观察器仍可重定位', async () => {
    await mountGroups();const previous = observer()
    previous.callback();const oldFrame = [...animationFrames.values()][0]
    source.context = {};await settle(false);readRects.mockClear();oldFrame(frameTime)
    expect(readRects).not.toHaveBeenCalled()
    observer().callback();await settle();expect(readRects).toHaveBeenCalledOnce()
    expect(navigation('machine-services').props['aria-current']).toBe('location')
  })
  it.each(['hidden', 'cached', 'context', 'service'])('%s之后旧手势事件不得解除当前末组固定高亮', async reason => {
    await mountGroups();const oldGesture = scroller().props.onWheelPassive
    invalidatePublic(reason);await settle();await reopenPublic(reason)
    await navigation('custom').props.onClick();await settle()
    oldGesture();scroller().props.onScrollPassive();await settle()
    expect(navigation('custom').props['aria-current']).toBe('location')
    scroller().props.onWheelPassive();scroller().props.onScrollPassive();await settle()
    expect(navigation('machine-services').props['aria-current']).toBe('location')
  })
  it('初始停用不创建尺寸观察器，激活后再观察当前目录', async () => {
    await mountCatalog({services: groupedCatalog, active: false});expect(observers).toHaveLength(0)
    source.active = true;await settle();expect(observer().observe).toHaveBeenCalledTimes(3)
  })
  it('自定义分组已移除时，旧导航事件不得清空当前搜索', async () => {
    await mountGroups();const oldReveal = navigation('custom').props.onClick
    source.services = catalog;await settle();await search('google')
    await oldReveal();await settle();expect(queryInput().props.value).toBe('google');expect(groupScroll).not.toHaveBeenCalled()
  })
  it('尺寸由隐藏变为可见时展开当前组；持续可见的尺寸变化尊重用户折叠', async () => {
    await mountGroups();observer().callback();await settle()
    groupHeader('machine-services').props.onClick();await settle();observer().callback();await settle()
    expect(groupHeader('machine-services').props['aria-expanded']).toBe(false)
    geometry.visible = false;observer().callback();await settle()
    geometry.visible = true;observer().callback();await settle()
    expect(groupHeader('machine-services').props['aria-expanded']).toBe(true)
  })
})

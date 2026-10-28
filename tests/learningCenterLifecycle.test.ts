import {parseHTML} from 'linkedom'
import {afterEach, describe, expect, it, vi} from 'vitest'
import * as runtime from 'vue'
import type {Component, App} from 'vue'

type Tab = 'history' | 'memory'
type Namespace = {__esModule: true; default?: Component; HarnessReadingHistory?: Component}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no})
  return {promise, resolve, reject}
}
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const stop of disposers.splice(0).reverse()) await stop()
  vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers()
})

// 直接导入实际客户端 SFC，覆盖率归因到生产源码；只替换浏览器、配置、展示与异步模块边界。
async function mountLearning(initialTab?: string, options: {listGate?: Tab; browser?: string; parentGate?: Promise<void>; parentVisibility?: boolean} = {}) {
  const {window, document} = parseHTML('<html><body></body></html>')
  for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'Event'])
    vi.stubGlobal(key, key === 'window' ? window : window[key as keyof typeof window])
  let focused: Element = document.body
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused})
  window.HTMLElement.prototype.focus = function () {focused = this}
  window.HTMLElement.prototype.blur = function () {focused = document.body}
  const frames = new Map<number, FrameRequestCallback>();let frame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frames.set(++frame, callback);return frame})
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const language = runtime.ref('zh-CN'), shown = runtime.ref(true), paneVisible = runtime.ref(true), props = runtime.reactive({initialTab})
  const configListeners = new Set<(value: any) => void>(), clientErrors: unknown[] = [], navigations: string[] = [], reloads: string[] = []
  const listGate = deferred<Record<string, unknown>>(), writeGate = deferred<Record<string, unknown>>()
  let pendingWrite = false, stopped = false, heldList = options.listGate
  const memory = {id: '12345678-1234-4234-8234-123456789abc', kind: 'note', content: 'Synthetic retained note', createdAt: 1, updatedAt: 1}
  const session = {id: 'synthetic-session', text: 'Synthetic retained reading', intent: 'meaning', updatedAt: 1, turnCount: 1}
  const memories = [memory], sessions = [session]
  const send = vi.fn(async (message: Record<string, unknown>) => {
    if (message.action === 'memory-list') {
      if (heldList === 'memory') {heldList = undefined;return listGate.promise}
      return {success: true, memories: [...memories]}
    }
    if (message.action === 'sessions-list') {
      if (heldList === 'history') {heldList = undefined;return listGate.promise}
      return {success: true, sessions: [...sessions], hasMore: false}
    }
    if (message.action === 'memory-save') {
      const input = message.input as {content: string; kind: string}
      const saved = {...memory, ...input};memories.splice(0, memories.length, saved)
      return pendingWrite ? writeGate.promise : {success: true, memory: saved}
    }
    if (message.action === 'memory-delete') {memories.splice(0, memories.length, ...memories.filter(item => item.id !== message.id));return {success: true}}
    if (message.action === 'memory-clear') {memories.length = 0;return {success: true}}
    if (message.action === 'sessions-delete') {sessions.length = 0;return pendingWrite ? writeGate.promise : {success: true}}
    if (message.action === 'sessions-clear') {sessions.length = 0;return {success: true}}
    if (message.action === 'sessions-get') return {success: true, session: {...session, turns: [{id: 'turn', intent: 'meaning', question: '', answer: '', status: 'completed', createdAt: 1}]}}
    throw new Error(`Unexpected learning action ${String(message.action)}`)
  })
  vi.resetModules()
  vi.doUnmock('../src/features/settings/ui/LearningMemoryManager.vue')
  vi.doUnmock('../src/features/reading-assistant/ui/public')
  vi.doMock('webextension-polyfill', () => ({default: {runtime: {sendMessage: send}}}))
  const {normalizeConfig} = await import('../src/core/config/model')
  const config = normalizeConfig({harness: {memoryEnabled: true}})
  const store = {config, configReady: Promise.resolve(), subscribeConfig: (listener: (value: typeof config) => void) => {
    configListeners.add(listener);return () => configListeners.delete(listener)
  }}
  const client = await import('../src/features/reading-assistant/client')
  const i18n = {useUiI18n: () => ({language, t: (key: string) => `${language.value}:${key}`, translateLegacy: (text: string) => text})}
  const display = runtime.defineComponent({setup: (_, {slots}) => () => runtime.h('span', slots.default?.())})
  const savedVisibility:Array<(() => boolean) | undefined>=[]
  const saved = runtime.defineComponent({props:['isVisible'],setup: (props, {emit}) => {savedVisibility.push(props.isVisible);return () => runtime.h('section', {class: 'saved-display-port','data-visible':String(props.isVisible?.())},
    runtime.h('button', {onClick: () => emit('navigate', 'settings-data')}, 'Saved navigate'))}})
  const materialMount = vi.fn()
  const material = runtime.defineComponent({setup: (_, {emit}) => {materialMount();return () => runtime.h('section', {class: 'material-display-port'}, [
    runtime.h('button', {onClick: () => emit('navigate', 'settings-data')}, 'Material navigate'),
    runtime.h('button', {onClick: () => emit('open-tab', 'memory')}, 'Open notes'),
  ])}})
  const loads = {history: vi.fn(), memory: vi.fn()}
  const gates: Record<Tab, Array<ReturnType<typeof deferred<Namespace>>>> = {history: [], memory: []}
  const namespaces = {} as Record<Tab, Namespace>
  function load(tab: Tab): Promise<Namespace> {
    loads[tab]()
    const gate = deferred<Namespace>();gates[tab].push(gate);return gate.promise
  }
  vi.doMock('../src/ui/i18n', () => i18n)
  vi.doMock('../src/services/config/store', () => store)
  vi.doMock('../src/platform/browser/capabilities', () => ({browserCapabilities: {browser: options.browser ?? 'chrome'}}))
  vi.doMock('../src/features/vocabulary/ui/public', () => ({VocabularyBook: saved, MaterialWorkspace: material}))
  vi.doMock('../src/features/reading-assistant/public', () => client)
  vi.doMock('element-plus/es/components/message-box/style/css', () => ({}))
  const confirm = vi.fn(async (): Promise<void> => undefined)
  vi.doMock('element-plus', () => ({ElMessageBox: {confirm}, ElOption: display}))
  vi.doMock('../src/ui/components/UiIcon.vue', () => ({default: display}))
  vi.doMock('../src/ui/components/UiSelect.vue', () => ({default: runtime.defineComponent({props: ['modelValue'], emits: ['update:modelValue'],
    setup: (props, {emit, attrs, slots}) => () => runtime.h('span', [runtime.h('input', {...attrs, value: props.modelValue,
      onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)}), slots.default?.()])})}))
  vi.doMock('../src/features/reading-assistant/ui/ReadingAnswer.vue', () => ({default: display}))
  namespaces.memory = {__esModule: true, default: (await vi.importActual<typeof import('../src/features/settings/ui/LearningMemoryManager.vue')>('../src/features/settings/ui/LearningMemoryManager.vue')).default}
  namespaces.history = {__esModule: true, HarnessReadingHistory: (await import('../src/features/reading-assistant/ui/HarnessReadingHistory.vue')).default}
  vi.doMock('../src/features/reading-assistant/ui/public', () => load('history'))
  vi.doMock('../src/features/settings/ui/LearningMemoryManager.vue', () => load('memory'))
  const parent = (await import('../src/features/settings/ui/LearningCenter.vue')).default
  // 模块加载完成后只控制 Vue 的异步组件等待时间。
  vi.useFakeTimers()
  const renderer = runtime.createRenderer<Node, Element>({
    createElement: tag => document.createElement(tag), createText: text => document.createTextNode(text), createComment: text => document.createComment(text),
    insert: (node, parent, anchor) => parent.insertBefore(node, anchor ?? null), remove: node => node.parentNode?.removeChild(node),
    setText: (node, value) => {node.nodeValue = value}, setElementText: (element, value) => {element.textContent = value},
    parentNode: node => node.parentNode as Element | null, nextSibling: node => node.nextSibling,
    patchProp: (element, key, _before, value) => {
      if (key.startsWith('onUpdate:')) return
      if (/^on[A-Z]/u.test(key)) {
        const events = element as Element & {__learningEvents?: Map<string, EventListener>}
        const name = key.slice(2).toLowerCase();events.__learningEvents ??= new Map()
        const prior = events.__learningEvents.get(name);if (prior) element.removeEventListener(name, prior)
        if (value) {const handler: EventListener = event => {for (const fn of Array.isArray(value) ? value : [value]) fn(event)}
          events.__learningEvents.set(name, handler);element.addEventListener(name, handler)}
      } else if (key === 'value') (element as HTMLInputElement).value = value ?? ''
      else if (key.startsWith('aria-') && value != null) element.setAttribute(key, String(value))
      else if (value === null || value === undefined || value === false) element.removeAttribute(key)
      else element.setAttribute(key, value === true ? '' : String(value))
    }, setScopeId: (element, id) => element.setAttribute(id, ''), insertStaticContent: (content, parent, anchor) => {
      const container = document.createElement('div');container.innerHTML = content
      const first = container.firstChild!, last = container.lastChild!
      for (const child of [...container.childNodes]) parent.insertBefore(child, anchor)
      return [first, last]
    },
  })
  const mountedParent=options.parentGate?runtime.defineAsyncComponent(async()=>{await options.parentGate;return parent}):parent
  const isVisible=()=>shown.value && paneVisible.value
  const warnings:string[]=[]
  const otherPage = {render: () => null}, host = document.createElement('main');document.body.append(host)
  const app: App = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => shown.value
    ? runtime.h(mountedParent, {...props, ...(options.parentVisibility===false?{}:{isVisible}), onNavigate: (section: string) => navigations.push(section), onReload: (tab: string) => reloads.push(tab)}) : runtime.h(otherPage)})})
  app.component('el-dialog', runtime.defineComponent({props:['modelValue'],emits:['update:modelValue'],setup:(props,{slots})=>()=>props.modelValue ? runtime.h('div',{'data-confirm-dialog':''},[...slots.default?.() ?? [], ...slots.footer?.() ?? []]) : null}))
  app.component('el-button', runtime.defineComponent({setup:(_,{attrs,slots})=>()=>runtime.h('button',attrs,slots.default?.())}))
  app.config.errorHandler = error => clientErrors.push(error);app.config.warnHandler = message => warnings.push(message)
  const settle = async () => {for (let i = 0; i < 12; i++) {await Promise.resolve();await runtime.nextTick()}}
  function stop() {if (!stopped) {stopped = true;app.unmount()}}
  disposers.push(async () => {stop();for (const tab of ['history', 'memory'] as const) for (const gate of gates[tab]) gate.resolve(namespaces[tab])
    listGate.resolve({success: true, memories: [], sessions: [], hasMore: false});writeGate.resolve({success: true, memory})
    await settle();frames.clear();host.remove()})
  app.mount(host);await settle()
  const choose = async (tab: 'saved' | Tab) => {host.querySelector<HTMLButtonElement>(`[data-option-index="${(options.browser === 'userscript' ? ['saved', 'history', 'memory'] : ['saved', 'materials', 'history', 'memory']).indexOf(tab)}"]`)!.click();await settle()}
  const resolvePanel = async (tab: Tab) => {gates[tab].at(-1)?.resolve(namespaces[tab]);await settle()}
  const actions = (action: string) => send.mock.calls.filter(([message]) => message.action === action)
  return {host, props, shown, paneVisible, confirm, language, loads, gates, namespaces, clientErrors, navigations, reloads, send, configListeners, config, materialMount, savedVisibility, warnings,
    memories, sessions, memory, session, listGate, writeGate, settle, choose, resolvePanel, stop, actions,
    pendingWrite: () => {pendingWrite = true}, listReply: () => ({success: true, memories: [...memories], sessions: [...sessions], hasMore: false}),
    notifyMemory: (enabled: boolean) => {config.harness.memoryEnabled = enabled;for (const listener of configListeners) listener(normalizeConfig(config))},
    flushFrames: () => {for (const [id, callback] of [...frames]) {frames.delete(id);callback(0)}},
    key: (element: HTMLElement, key: string) => {element.focus();const event = new window.Event('keydown', {bubbles: true, cancelable: true});Object.assign(event, {key});element.dispatchEvent(event)},
  }
}

describe('LearningCenter actual client pane loading and lifetime', () => {
  it.each(['history','memory'] as const)('propagates live navigation ownership to %s clear confirmation', async tab => {
    const h=await mountLearning(tab);await h.resolvePanel(tab)
    const clear=tab==='history'?'.harness-history-toolbar .harness-text-button':'.fr-memory-bottom button'
    h.host.querySelector<HTMLButtonElement>(clear)!.click();await h.settle();
    const old=[...h.host.querySelectorAll<HTMLButtonElement>('[data-confirm-dialog] button')].find(button=>button.textContent?.includes('common.confirm'))!
    expect(old).toBeDefined();h.paneVisible.value=false;h.paneVisible.value=true;await h.settle()
    expect(h.host.querySelector('[data-confirm-dialog]')).toBeNull();old.click();await h.settle()
    expect(h.actions(tab==='history'?'sessions-clear':'memory-clear')).toHaveLength(0)
    expect(tab==='history'?h.sessions:h.memories).toHaveLength(1)
  })
  it.each([undefined, 'materials'])('keeps userscript saved reachable for initial %s and omits the unsupported materials control', async initial => {
    const h = await mountLearning(initial, {browser: 'userscript'})
    expect(h.host.querySelectorAll('[role="radio"]')).toHaveLength(3)
    expect(h.host.querySelector('.saved-display-port')).not.toBeNull()
    expect(h.host.querySelector('.material-display-port')).toBeNull()
    expect(h.materialMount).not.toHaveBeenCalled()
    expect(h.host.querySelector('.fr-learning-center-header')!.textContent).not.toContain('阅读材料')
    h.host.querySelector<HTMLButtonElement>('.saved-display-port button')!.click()
    expect(h.navigations).toEqual(['settings-data'])
  })
  it('skips materials with userscript keyboard navigation and falls back to saved on a later materials route', async () => {
    const h = await mountLearning(undefined, {browser: 'userscript'})
    h.key(h.host.querySelector<HTMLElement>('[data-option-index="0"]')!, 'ArrowRight')
    await h.settle();await h.resolvePanel('history');h.flushFrames()
    expect(h.host.querySelector('.harness-history')).not.toBeNull()
    expect(h.host.querySelector('[data-option-index="1"][aria-checked="true"]')).not.toBeNull()
    expect(h.host.querySelectorAll('[role="radio"][tabindex="0"]')).toHaveLength(1)
    h.props.initialTab = 'materials';await h.settle()
    expect(h.host.querySelector('.saved-display-port')).not.toBeNull()
    expect(h.host.querySelector('[data-option-index="0"][aria-checked="true"]')).not.toBeNull()
    await h.choose('memory');await h.resolvePanel('memory')
    expect(h.host.querySelector('.fr-learning-memory')).not.toBeNull()
    h.props.initialTab = 'saved';await h.settle()
    h.props.initialTab = 'materials';await h.settle()
    expect(h.host.querySelector('.saved-display-port')).not.toBeNull()
    expect(h.materialMount).not.toHaveBeenCalled()
    expect(h.clientErrors).toEqual([])
  })
  it.each(['chrome', 'firefox'])('retains the extension materials direct entry and later route on %s', async browser => {
    const h = await mountLearning('materials', {browser})
    expect(h.host.querySelectorAll('[role="radio"]')).toHaveLength(4)
    expect(h.host.querySelector('.material-display-port')).not.toBeNull()
    expect(h.materialMount).toHaveBeenCalledOnce()
    h.props.initialTab = 'saved';await h.settle()
    expect(h.host.querySelector('.saved-display-port')).not.toBeNull()
    h.props.initialTab = 'materials';await h.settle()
    expect(h.host.querySelector('.material-display-port')).not.toBeNull()
    expect(h.materialMount).toHaveBeenCalledTimes(2)
  })
  it.each([undefined, 'invalid', 'saved'])('shows default saved for initial %s without loading other panes', async initial => {
    const h = await mountLearning(initial)
    expect(h.host.querySelector('.saved-display-port')).not.toBeNull()
    expect({history: h.loads.history.mock.calls.length, memory: h.loads.memory.mock.calls.length}).toEqual({history: 0, memory: 0})
  })
  it.each(['history', 'memory'] as const)('honors initial %s and loads only that module', async tab => {
    const h = await mountLearning(tab);expect(h.loads[tab]).toHaveBeenCalledOnce()
    expect(h.loads[tab === 'history' ? 'memory' : 'history']).not.toHaveBeenCalled()
    await h.resolvePanel(tab);expect(h.host.querySelector(tab === 'history' ? '.harness-history' : '.fr-learning-memory')).not.toBeNull()
  })
  it('uses real segmented keys and valid latest initialTab, retaining one tab stop and resolved modules', async () => {
    const h = await mountLearning();const saved = h.host.querySelector<HTMLElement>('[data-option-index="0"]')!
    h.key(saved, 'ArrowRight');await h.settle();h.flushFrames()
    expect(h.host.querySelector('[data-option-index="1"][aria-checked="true"]')).not.toBeNull()
    h.key(h.host.querySelector<HTMLElement>('[data-option-index="1"]')!, 'ArrowRight');await h.settle();await h.resolvePanel('history');h.flushFrames()
    expect(h.host.querySelector('[data-option-index="2"][aria-checked="true"]')).not.toBeNull()
    expect(h.host.querySelectorAll('[role="radio"][tabindex="0"]')).toHaveLength(1)
    h.props.initialTab = 'memory';await h.settle();await h.resolvePanel('memory')
    h.props.initialTab = 'invalid';await h.settle();expect(h.host.querySelector('.fr-learning-memory')).not.toBeNull()
    await h.choose('saved');await h.choose('history');expect(h.loads.history).toHaveBeenCalledOnce()
    expect(h.host.querySelector('.harness-history')).not.toBeNull()
  })
  it.each([['history', 'tab'], ['memory', 'tab'], ['history', 'unmount'], ['memory', 'unmount']] as const)
  ('does not mount pending %s after %s departure, including same-job resolution', async (tab, departure) => {
    const h = await mountLearning();await h.choose(tab)
    expect(h.actions(tab === 'memory' ? 'memory-list' : 'sessions-list')).toHaveLength(0)
    // Real queued resolve and parent v-if update, not a copied loader lifecycle algorithm.
    h.gates[tab].at(-1)!.resolve(h.namespaces[tab])
    if (departure === 'unmount') h.stop();else h.props.initialTab = 'saved'
    await h.settle();expect(h.actions(tab === 'memory' ? 'memory-list' : 'sessions-list')).toHaveLength(0)
    expect(h.host.querySelector(tab === 'memory' ? '.fr-learning-memory' : '.harness-history')).toBeNull()
  })
  it('passes latest false memory reference preference while pending and preserves actual note CRUD', async () => {
    const h = await mountLearning();await h.choose('memory');h.notifyMemory(false);await h.settle();await h.resolvePanel('memory')
    expect(h.host.querySelector('.fr-memory-options')!.textContent).toContain('learning.memoryDisabled')
    h.host.querySelector<HTMLButtonElement>('.fr-memory-heading button')!.click();await h.settle()
    const textarea = h.host.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value = 'Explicit local note'
    textarea.dispatchEvent(new Event('input', {bubbles: true}));await h.settle()
    h.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));await h.settle()
    expect(h.actions('memory-save')).toHaveLength(1);expect(h.actions('memory-save')[0][0]).toEqual({type: 'fluentReadHarness', action: 'memory-save', input: {kind: 'note', content: 'Explicit local note'}})
    expect(h.host.querySelector('.fr-memory-list')!.textContent).toContain('Explicit local note')
  })
  it.each([
    {label: 'long', content: 'Long original note with a complete explanation. '.repeat(10) + 'End of saved note.'},
    {label: 'short four-line', content: 'First line.\nSecond line.\nThird line.\nEnd of saved note.'},
  ])('keeps $label notes readable after search, and preserves them when editing is canceled', async ({content}) => {
    const h = await mountLearning('memory')
    h.memories[0].content = content;await h.resolvePanel('memory')
    const search = h.host.querySelector<HTMLInputElement>('.fr-memory-toolbar input')!
    search.value = 'End of saved note';search.dispatchEvent(new Event('input', {bubbles: true}));await h.settle()
    const details = h.host.querySelector<HTMLDetailsElement>('.fr-memory-content')!
    expect(details).not.toBeNull();expect(details.hasAttribute('open')).toBe(false)
    expect(details.querySelector('p')!.textContent).toBe(content)
    details.querySelector<HTMLElement>('summary')!.click();await h.settle()
    expect(h.host.querySelector('textarea')).toBeNull();expect(h.actions('memory-save')).toHaveLength(0)
    // Linkedom does not implement native details disclosure; the browser owns open state.
    details.setAttribute('open', '');expect(details.querySelector('p')!.textContent).toBe(content)
    h.host.querySelector<HTMLButtonElement>('.fr-memory-item footer button')!.click();await h.settle()
    expect(h.host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(content)
    expect(h.actions('memory-save')).toHaveLength(0)
    h.host.querySelectorAll<HTMLButtonElement>('.fr-memory-editor-actions button')[1].click();await h.settle()
    expect(h.host.querySelector('textarea')).toBeNull()
    expect(h.host.querySelector<HTMLInputElement>('.fr-memory-toolbar input')!.value).toBe('End of saved note')
    expect(h.host.querySelector('.fr-memory-content p')!.textContent).toBe(content)
    expect(h.actions('memory-save')).toHaveLength(0)
  })
  it.each(['history', 'memory'] as const)('keeps late %s list and accepted writes with their real child owner', async tab => {
    const h = await mountLearning(tab, {listGate: tab});await h.resolvePanel(tab)
    expect(h.actions(tab === 'memory' ? 'memory-list' : 'sessions-list')).toHaveLength(1)
    await h.choose('saved');h.listGate.resolve(h.listReply());await h.settle()
    expect(h.host.querySelector('.saved-display-port')).not.toBeNull();expect(h.host.textContent).not.toContain('Synthetic retained')
    await h.choose(tab);await h.resolvePanel(tab);h.pendingWrite()
    if (tab === 'memory') {
      h.host.querySelector<HTMLButtonElement>('.fr-memory-heading button')!.click();await h.settle()
      const input = h.host.querySelector<HTMLTextAreaElement>('textarea')!;input.value = 'Accepted local note';input.dispatchEvent(new Event('input', {bubbles: true}));await h.settle()
      h.host.querySelector('form')!.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}))
    } else h.host.querySelector<HTMLButtonElement>('.harness-history-row [aria-label="删除这条阅读记录"]')!.click()
    await h.settle();expect(h.actions(tab === 'memory' ? 'memory-save' : 'sessions-delete')).toHaveLength(1)
    await h.choose('saved');h.writeGate.resolve({success: true, memory: h.memories[0]});await h.settle()
    expect(h.host.querySelector('.saved-display-port')).not.toBeNull();expect(h.host.querySelector('[role="alert"]')).toBeNull()
    await h.choose(tab);await h.resolvePanel(tab)
    if (tab === 'memory') expect(h.host.textContent).toContain('Accepted local note')
    else {expect(h.sessions).toEqual([]);expect(h.host.querySelector('.harness-history-row')).toBeNull()}
    expect(h.clientErrors).toEqual([])
  })
  it.each(['history', 'memory'] as const)('preserves Vue cached late %s mount and current props instead of inventing hidden zero IO', async tab => {
    const h = await mountLearning();await h.choose(tab);h.shown.value = false;h.notifyMemory(false);await h.settle()
    await h.resolvePanel(tab)
    expect(h.actions(tab === 'memory' ? 'memory-list' : 'sessions-list')).toHaveLength(1)
    expect(h.host.querySelector(tab === 'memory' ? '.fr-learning-memory' : '.harness-history')).toBeNull()
    h.shown.value = true;await h.settle()
    expect(h.host.querySelector(tab === 'memory' ? '.fr-learning-memory' : '.harness-history')).not.toBeNull()
    if (tab === 'memory') expect(h.host.querySelector('.fr-memory-options')!.textContent).toContain('learning.memoryDisabled')
    expect(h.clientErrors).toEqual([])
  })
  it.each(['history', 'memory'] as const)('shows %s delayed loading/error in current language and emits the current pane reload request', async tab => {
    const h = await mountLearning();await h.choose(tab)
    expect(h.host.querySelector('.fr-learning-load[role="status"]')).toBeNull()
    await vi.advanceTimersByTimeAsync(200);await h.settle()
    expect(h.host.querySelector('.fr-learning-load[role="status"]')!.textContent).toContain('zh-CN:common.loading')
    h.language.value = 'en';await h.settle();expect(h.host.querySelector('.fr-learning-load[role="status"]')!.textContent).toContain('en:common.loading')
    const failure = new Error('Owned synthetic module rejection');h.gates[tab].at(-1)!.reject(failure);await h.settle()
    expect(h.host.querySelector('.fr-learning-load[role="alert"]')!.textContent).toContain('en:learning.panelLoadError')
    expect(h.host.querySelector('.fr-learning-center-header')).not.toBeNull();expect(h.host.querySelector('.fr-learning-local')).not.toBeNull()
    h.host.querySelector<HTMLButtonElement>('.fr-learning-load[role="alert"] button')!.click()
    expect(h.reloads).toEqual([tab])
    // Document routing/reload and the browser's ESM failure cache are parent/native boundaries.
    expect(h.clientErrors).toHaveLength(1)
    // Vitest 的异步模块 mock 给原始加载失败加一层 cause，仍核对同一个失败对象。
    expect((h.clientErrors[0] as Error & {cause?: unknown}).cause).toBe(failure);await h.choose('saved');expect(h.host.querySelector('.fr-learning-load')).toBeNull()
  })
  it('keeps public header/footer navigation available and releases its config subscription on unmount', async () => {
    const h = await mountLearning();expect(h.configListeners.size).toBe(1)
    h.host.querySelector<HTMLButtonElement>('.fr-learning-local > button')!.click();expect(h.navigations).toEqual(['settings-data'])
    h.stop();expect(h.configListeners.size).toBe(0)
  })

  it('forwards material and note settings navigation and closes storage disclosure with Escape', async () => {
    const h = await mountLearning('materials')
    h.host.querySelector<HTMLButtonElement>('.material-display-port button')!.click()
    h.host.querySelector<HTMLButtonElement>('.material-display-port button:last-child')!.click();await h.settle();await h.resolvePanel('memory')
    h.host.querySelector<HTMLButtonElement>('.fr-memory-options button')!.click()
    expect(h.navigations).toEqual(['settings-data', 'settings-selection'])
    for (const selector of ['.fr-learning-storage', '.fr-memory-options']) {
      const details = h.host.querySelector<HTMLDetailsElement>(selector)!;details.open = true
      h.key(details, 'Escape');await h.settle();expect(details.open).toBe(false)
    }
  })

  it('filters, edits, cancels and deletes existing notes through their actual controls', async () => {
    const h = await mountLearning('memory');await h.resolvePanel('memory')
    const search = h.host.querySelector<HTMLInputElement>('input[type="search"]')!
    search.value = 'does not match';search.dispatchEvent(new Event('input'));await h.settle()
    expect(h.host.textContent).toContain('learning.memoryNoMatches');expect(h.host.querySelector('.fr-memory-item')).toBeNull()
    search.value = 'synthetic';search.dispatchEvent(new Event('input'));await h.settle()
    h.host.querySelector<HTMLButtonElement>('.fr-memory-item footer button')!.click();await h.settle()
    expect(h.host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Synthetic retained note')
    h.host.querySelector<HTMLButtonElement>('.fr-memory-editor-actions button:last-child')!.click();await h.settle()
    expect(h.actions('memory-save')).toHaveLength(0)
    h.host.querySelector<HTMLButtonElement>('.fr-memory-item footer button:last-child')!.click();await h.settle()
    expect(h.actions('memory-delete')).toHaveLength(1);expect(h.host.textContent).toContain('learning.memoryDeleted')
    expect(h.host.querySelector('.fr-memory-item')).toBeNull();expect(h.clientErrors).toEqual([])
  })

  it('sorts tied note timestamps by id, searches by kind, and saves the selected kind without losing the id', async () => {
    const h = await mountLearning('memory')
    h.memories.push({...h.memory, id: '00000000-1234-4234-8234-123456789abc', content: 'Earlier identifier'})
    await h.resolvePanel('memory')
    expect(h.host.querySelector('.fr-memory-item p')!.textContent).toBe('Earlier identifier')
    const search = h.host.querySelector<HTMLInputElement>('input[type="search"]')!;search.value = 'memoryNote'
    search.dispatchEvent(new Event('input'));await h.settle();expect(h.host.querySelectorAll('.fr-memory-item')).toHaveLength(2)
    h.host.querySelector<HTMLButtonElement>('.fr-memory-item footer button')!.click();await h.settle()
    const kind = h.host.querySelector<HTMLInputElement>('.fr-memory-editor input')!;kind.value = 'lesson';kind.dispatchEvent(new Event('input'));await h.settle()
    h.host.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}));await h.settle()
    expect(h.actions('memory-save').at(-1)![0].input).toEqual({id: '00000000-1234-4234-8234-123456789abc', kind: 'lesson', content: 'Earlier identifier'})
    expect(h.host.querySelector('.fr-memory-item header')!.textContent).toContain('learning.memoryLesson')
  })

  it('reports non-Error note failures with the translated fallback and disables adding at capacity', async () => {
    const h = await mountLearning('memory');h.send.mockRejectedValueOnce('offline');await h.resolvePanel('memory')
    expect(h.host.querySelector('[role="alert"]')!.textContent).toContain('learning.memoryError')
    h.memories.splice(0, 1, ...Array.from({length: 200}, (_, index) => ({...h.memory, id: `note-${index}`, updatedAt: index})))
    h.host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();await h.settle()
    expect(h.host.querySelectorAll('.fr-memory-item')).toHaveLength(200)
    expect(h.host.querySelector<HTMLButtonElement>('.fr-memory-heading button')!.hasAttribute('disabled')).toBe(true)
    expect(h.host.querySelector('.fr-memory-bottom')!.textContent).toContain('learning.memoryLimit')
  })

  it.each(['read', 'save', 'delete', 'clear'] as const)('shows note %s failure and permits a successful retry', async operation => {
    const h = await mountLearning('memory')
    if (operation === 'read') h.send.mockResolvedValueOnce({success: false, error: 'controlled read failure'})
    await h.resolvePanel('memory')
    const perform = async () => {
      if (operation === 'read') h.host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
      else if (operation === 'save') {
        if (!h.host.querySelector('textarea')) {h.host.querySelector<HTMLButtonElement>('.fr-memory-item footer button')!.click();await h.settle()}
        const textarea = h.host.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value = 'Edited note';textarea.dispatchEvent(new Event('input'));await h.settle()
        h.host.querySelector('form')!.dispatchEvent(new Event('submit', {cancelable: true}))
      } else h.host.querySelector<HTMLButtonElement>(operation === 'delete' ? '.fr-memory-item footer button:last-child' : '.fr-memory-bottom button')!.click()
      await h.settle()
      if (operation === 'clear') {h.host.querySelectorAll<HTMLButtonElement>('[data-confirm-dialog] button')[1]!.click();await h.settle()}
    }
    if (operation !== 'read') {h.send.mockResolvedValueOnce({success: false, error: `controlled ${operation} failure`});await perform()}
    expect(h.host.querySelector('[role="alert"]')!.textContent).toContain(`controlled ${operation} failure`)
    await perform();expect(h.host.querySelector('[role="alert"]')).toBeNull()
    if (operation === 'save') expect(h.host.textContent).toContain('Edited note')
    else if (operation !== 'read') expect(h.host.querySelector('.fr-memory-item')).toBeNull()
    expect(h.clientErrors).toEqual([])
  })

  it('opens history detail with all turn states, returns to the list and removes the selected record', async () => {
    const h = await mountLearning('history');await h.resolvePanel('history')
    h.send.mockResolvedValueOnce({success: true, session: {...h.session, turns: ['meaning', 'grammar', 'usage', 'practice', 'unknown'].map((intent, index) => ({
      id: `turn-${index}`, intent, question: index === 0 ? 'Explicit question' : '', answer: index === 0 ? 'Saved answer' : '',
      status: ['completed', 'streaming', 'stopped', 'error', 'unknown'][index], createdAt: index + 1,
    }))}})
    h.host.querySelector<HTMLButtonElement>('.harness-history-open')!.click();await h.settle()
    expect(h.host.querySelectorAll('.harness-history-turn')).toHaveLength(5)
    for (const text of ['Explicit question', '拆句', '用法', '练习', '学习', '生成中', '已停止', '未完成']) expect(h.host.textContent).toContain(text)
    h.host.querySelector<HTMLButtonElement>('.harness-history-toolbar button')!.click();await h.settle()
    expect(h.host.querySelector('.harness-history-list')).not.toBeNull()
    h.host.querySelector<HTMLButtonElement>('.harness-history-open')!.click();await h.settle()
    h.host.querySelector<HTMLButtonElement>('.harness-history-toolbar button:last-child')!.click();await h.settle()
    expect(h.actions('sessions-delete')).toHaveLength(1);expect(h.host.querySelector('.harness-history-detail')).toBeNull()
    expect(h.host.querySelector('.harness-history-empty')).not.toBeNull()
  })

  it.each(['list', 'detail', 'delete', 'clear'] as const)('shows history %s failure and recovers without losing retained records', async operation => {
    const h = await mountLearning('history')
    if (operation === 'list') h.send.mockRejectedValueOnce(new Error('controlled list failure'))
    await h.resolvePanel('history')
    const perform = async () => {
      const selector = operation === 'list' ? '.harness-history-heading button' : operation === 'detail' ? '.harness-history-open'
        : operation === 'delete' ? '.harness-history-row > button:last-child' : '.harness-history-toolbar button:last-child'
      h.host.querySelector<HTMLButtonElement>(selector)!.click();await h.settle()
      if (operation === 'clear') {h.host.querySelectorAll<HTMLButtonElement>('[data-confirm-dialog] button')[1]!.click();await h.settle()}
    }
    if (operation !== 'list') {h.send.mockRejectedValueOnce(new Error(`controlled ${operation} failure`));await perform()}
    expect(h.host.querySelector('[role="alert"]')).not.toBeNull()
    await perform();expect(h.host.querySelector('[role="alert"]')).toBeNull()
    if (operation === 'detail') expect(h.host.querySelector('.harness-history-detail')).not.toBeNull()
    if (operation === 'delete' || operation === 'clear') expect(h.host.querySelector('.harness-history-row')).toBeNull()
    expect(h.clientErrors).toEqual([])
  })

  it('removes an expired history detail and ignores an old detail response after returning to the list', async () => {
    const h = await mountLearning('history');await h.resolvePanel('history')
    h.send.mockResolvedValueOnce({success: true, session: null})
    h.host.querySelector<HTMLButtonElement>('.harness-history-open')!.click();await h.settle()
    expect(h.host.querySelector('[role="alert"]')!.textContent).toContain('已过期或已被删除')
    expect(h.host.querySelector('.harness-history-row')).toBeNull()
    h.host.querySelector<HTMLButtonElement>('.harness-history-heading button')!.click();await h.settle()
    const pending = deferred<any>();h.send.mockImplementationOnce(() => pending.promise)
    h.host.querySelector<HTMLButtonElement>('.harness-history-open')!.click();await h.settle()
    h.host.querySelector<HTMLButtonElement>('.harness-history-heading button')!.click();await h.settle()
    pending.resolve({success: true, session: {...h.session, turns: []}});await h.settle()
    expect(h.host.querySelector('.harness-history-detail')).toBeNull();expect(h.host.querySelector('.harness-history-row')).not.toBeNull()
  })
})


describe('LearningCenter saved visibility forwarding',()=>{
  it('passes one live getter to the saved child across outer KeepAlive hides without remounting it',async()=>{
    const h=await mountLearning();const getter=h.savedVisibility[0];expect(typeof getter).toBe('function');expect(getter?.()).toBe(true)
    h.shown.value=false;await h.settle();expect(getter?.()).toBe(false);expect(h.savedVisibility).toHaveLength(1)
    h.shown.value=true;await h.settle();expect(getter?.()).toBe(true);expect(h.savedVisibility).toEqual([getter])
    expect(h.warnings).toEqual([]);expect(h.clientErrors).toEqual([])
  })
  it('gives a late-mounted actual parent a live false saved getter until the outer page returns',async()=>{
    const gate=deferred<void>();const h=await mountLearning(undefined,{parentGate:gate.promise})
    expect(h.savedVisibility).toEqual([]);h.shown.value=false;await h.settle();gate.resolve();await h.settle()
    expect(h.savedVisibility).toHaveLength(1);const getter=h.savedVisibility[0];expect(getter?.()).toBe(false)
    h.shown.value=true;await h.settle();expect(getter?.()).toBe(true);expect(h.savedVisibility).toHaveLength(1)
    expect(h.warnings).toEqual([]);expect(h.clientErrors).toEqual([])
  })
})


describe('LearningCenter saved visibility forwarding without an outer getter',()=>{
  it('defaults to visible and still follows its own KeepAlive lifetime when the optional getter is absent',async()=>{
    const h=await mountLearning(undefined,{parentVisibility:false});const getter=h.savedVisibility[0]
    expect(typeof getter).toBe('function');expect(getter?.()).toBe(true)
    h.shown.value=false;await h.settle();expect(getter?.()).toBe(false)
    h.shown.value=true;await h.settle();expect(getter?.()).toBe(true);expect(h.savedVisibility).toHaveLength(1)
    expect(h.warnings).toEqual([]);expect(h.clientErrors).toEqual([])
  })
})

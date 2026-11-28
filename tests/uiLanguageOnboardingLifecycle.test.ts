/**
 * @file tests/uiLanguageOnboardingLifecycle.test.ts
 * 文件职责：执行实际语言组件的缓存客户端模板，验证存储等待、旧回调和 Vue 生命周期归属。
 * 主要内容：保留真实 Vue/KeepAlive、模板事件和语言规则，验证七语单一 Tab 入口、循环键盘预览及确认后保存；存储提交/回滚、焦点为可控端口，确认立即交接且不依赖成功动画计时器。
 * 模块边界：不调用浏览器或真实存储，不证明 CSS 动画、Element Plus Teleport 或操作系统焦点；每项清理计时器与组件。
 */
import {parseHTML} from 'linkedom'
import * as Vue from 'vue'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as languageRules from '@/src/core/i18n/language'

let app: Vue.App | undefined, document: Document, win: any, shown: Vue.Ref<boolean>, source: Record<string, any>, componentProps: Record<string, any>, state: Record<string, any>
let focused: Element | null, events: Map<Element, Record<string, any>>, port: Record<string, any>
const focus = vi.fn(), saved = vi.fn(), confirmed = vi.fn(), setLanguage = vi.fn()
let language: Vue.Ref<languageRules.UiLanguage>, stored: languageRules.UiLanguage, requests: Array<{value: languageRules.UiLanguage; gate: ReturnType<typeof deferred<void>>}>
function deferred<T>() {let resolve!: (value: T) => void, reject!: (error: unknown) => void;const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no});return {promise, resolve, reject}}
async function settle() {await Vue.nextTick();await Promise.resolve();await Vue.nextTick()}
function callback(element: Element, name = 'onClick') {const action = events.get(element)?.[name];expect(action, name).toBeTypeOf('function');return action}
function button(selector: string) {const element = document.querySelector(selector);expect(Boolean(element), selector).toBe(true);return element!}
function invalidate(reason: string) {if (reason === 'cached') shown.value = false;if (reason === 'pagehide') win.dispatchEvent(new win.Event('pagehide'));if (reason === 'unmount') {app?.unmount();app = undefined}}
vi.mock('vue', async importOriginal => {
  const actual = await importOriginal<typeof import('vue')>()
  return {...actual, Transition: actual.defineComponent({inheritAttrs:false,setup:(_:unknown,{attrs,slots}:any)=>()=>actual.h('div',{...attrs,'data-transition':'true'},slots.default?.())})}
})
beforeEach(() => {
  vi.resetModules();vi.doMock('@/src/core/i18n',()=>port.rules)
  vi.doMock('@/src/ui/i18n',()=>({useUiI18n:()=>({language,setLanguage,t:(key:string)=>key})}))
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});vi.clearAllMocks();app = undefined;events = new Map();requests = []
  const parsed = parseHTML('<html><body><div id="app"></div></body></html>');win = parsed.window;document = win.document;focused = document.body
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused})
  for (const [key, value] of Object.entries({document, window: win, HTMLElement: win.HTMLElement, Node: win.Node, Event: win.Event})) vi.stubGlobal(key, value)
  stored = 'zh-CN';language = Vue.ref(stored);port = {rules: {...languageRules, getUiLanguageDisplayLabel: vi.fn(languageRules.getUiLanguageDisplayLabel)},
    addListener: vi.fn(win.addEventListener.bind(win)), removeListener: vi.fn(win.removeEventListener.bind(win))}
  // 保留 linkedom 的事件派发，只用可观测端口记录监听器身份。
  vi.stubGlobal('window', {addEventListener: port.addListener, removeEventListener: port.removeListener})
  setLanguage.mockImplementation(async (value: languageRules.UiLanguage) => {
    const previous = language.value, gate = deferred<void>();requests.push({value, gate});language.value = value
    try {await gate.promise;stored = value} catch (error) {language.value = previous;throw error}
  })
})
afterEach(async () => {app?.unmount();await settle();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals()})
async function mount(values: Record<string, any> = {}) {
  const component = (await import('@/src/ui/components/UiLanguageOnboarding.vue')).default;source = Vue.shallowReactive(values);shown = Vue.ref(true)
  const renderer = Vue.createRenderer({patchProp(element: any, key: string, _previous: any, next: any) {
    if (/^on[A-Z]/u.test(key)) {const handlers = events.get(element) || {};handlers[key] = next;events.set(element, handlers);return}
    if (key === 'class') {element.className = next ?? '';return}
    if (next === undefined || next === null || (next === false && !/^(?:aria-|data-)/u.test(key))) element.removeAttribute(key);else element.setAttribute(key, String(next))
  }, insert: (child: any, parent: any, anchor: any = null) => parent.insertBefore(child, anchor), remove: (child: any) => {if (child === focused || child.contains?.(focused)) focused = document.body;child.parentNode?.removeChild(child)},
    createElement: tag => {const element = Vue.markRaw(document.createElement(tag)) as any;element.focus = (options: unknown) => {focused = element;focus(element, options)};return element},
    createText: value => document.createTextNode(value), createComment: value => document.createComment(value), setText: (node: any, value) => {node.nodeValue = value},
    setElementText: (element: any, value) => {element.textContent = value}, parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling,
    querySelector: value => document.querySelector(value), setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
    insertStaticContent: (html, parent: any, anchor: any) => {const template = document.createElement('template');template.innerHTML = html;const first = template.content.firstChild!, last = template.content.lastChild!;parent.insertBefore(template.content, anchor);return [first, last]}})
  app = renderer.createApp({setup: () => () => Vue.h(Vue.KeepAlive, null, {default: () => shown.value
    ? Vue.h(component as Vue.Component, {...source, onSaved: saved, onConfirmed: confirmed, ref: (vm: any) => {if (vm) {state = vm.$.setupState;componentProps = vm.$.props}}})
    : Vue.h({render: () => null}, {key: 'other'})})})
  app.config.warnHandler = () => {};app.mount(document.getElementById('app')!);await settle()
  // Vue 开发模式的应用计时器不属于保存流程；从挂载完成后统计新增和清理。
  port.backgroundTimers = vi.getTimerCount()
}

async function languageStep() {await settle()}
function choose(value: string) {return callback(button(`[data-language="${value}"]`))}
function keyboardAction(value: string) {return callback(button(`[data-language="${value}"]`), 'onKeydown')}
function press(action: (event: {key: string; preventDefault: () => void}) => void, key: string) {const event = {key, preventDefault: vi.fn()};action(event);return event}
function confirmAction() {return callback(button('.onboarding-form > .onboarding-confirm'))}
function componentTimers() {return vi.getTimerCount() - port.backgroundTimers}

describe('UiLanguageOnboarding 实际保存与生命周期', () => {
  it('首屏直接提供七语原生名称与品牌，切换只预览且不自动保存', async () => {
    await mount({initialLanguage: 'zh-CN'})
    expect(document.querySelector('[data-testid="onboarding-welcome"]')).toBeNull()
    const names = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Русский', 'Español']
    for (const [index, {value}] of languageRules.UI_LANGUAGE_OPTIONS.entries()) {
      expect(button(`[data-language="${value}"]`).textContent).toContain(names[index])
      expect(button(`[data-language="${value}"]`).getAttribute('lang')).toBe(value)
      choose(value)();await settle()
      expect(button('.onboarding-brand strong').textContent).toBe(value === 'zh-CN' ? '流畅阅读' : value === 'zh-TW' ? '流暢閱讀' : 'FluentRead')
      expect(state.selectedLanguage).toBe(value)
    }
    expect(setLanguage).not.toHaveBeenCalled();expect(saved).not.toHaveBeenCalled();expect(confirmed).not.toHaveBeenCalled()
  })
  it('八种语言任一被选中时，单选组均只保留该卡片一个 Tab 入口', async () => {
    await mount({initialLanguage: 'ja-JP'});await languageStep()
    for (const {value} of languageRules.UI_LANGUAGE_OPTIONS) {
      choose(value)();await settle()
      const radios = [...document.querySelectorAll('[role="radio"]')]
      expect(radios).toHaveLength(8)
      expect(radios.filter(element => element.getAttribute('tabindex') === '0')).toEqual([button(`[data-language="${value}"]`)])
      expect(radios.filter(element => element.getAttribute('tabindex') === '-1')).toHaveLength(7)
      expect(button(`[data-language="${value}"]`).getAttribute('aria-checked')).toBe('true')
    }
    expect(setLanguage).not.toHaveBeenCalled()
  })
  it('四方向键与 Home/End 循环切换预览及焦点，Tab/Enter/空格保留原生行为', async () => {
    await mount({initialLanguage: 'ja-JP'});await languageStep()
    const sequence = [['ArrowRight', 'ko-KR'], ['ArrowDown', 'fr-FR'], ['ArrowLeft', 'ko-KR'], ['ArrowUp', 'ja-JP'],
      ['Home', 'zh-CN'], ['ArrowLeft', 'es-ES'], ['ArrowRight', 'zh-CN'], ['End', 'es-ES'], ['ArrowDown', 'zh-CN'], ['ArrowUp', 'es-ES']] as const
    for (const [key, value] of sequence) {
      focus.mockClear();const event = press(keyboardAction(state.selectedLanguage), key);await settle()
      expect(event.preventDefault).toHaveBeenCalledOnce();expect(state.selectedLanguage).toBe(value)
      expect(document.documentElement.lang).toBe(value);expect(focused).toBe(button(`[data-language="${value}"]`))
      expect(focus).toHaveBeenCalledOnce();expect(focus.mock.calls[0][1]).toEqual({preventScroll: true})
      expect(document.querySelectorAll('[role="radio"][tabindex="0"]')).toHaveLength(1)
    }
    focus.mockClear()
    for (const key of ['Tab', 'Enter', ' ', 'Escape']) expect(press(keyboardAction('es-ES'), key).preventDefault).not.toHaveBeenCalled()
    await settle();expect(focus).not.toHaveBeenCalled();expect(setLanguage).not.toHaveBeenCalled();expect(state.selectedLanguage).toBe('es-ES')
  })
  it.each(['list', 'shell'] as const)('%s 受限滚动区内 End/Home 只滚动所属容器并保持焦点 preventScroll，不保存或滚动宿主', async mode => {
    await mount({initialLanguage: 'zh-CN'});await languageStep()
    const options = button('.onboarding-language-options') as HTMLElement
    const shell = button('#app') as HTMLElement;shell.classList.add('popup-shell')
    const first = button('[data-language="zh-CN"]'), last = button('[data-language="es-ES"]')
    const scrollIntoView = vi.fn(), writes: Record<'list' | 'shell', number[]> = {list: [], shell: []}
    const scrollTop = {list: 0, shell: 0}, otherMode = mode === 'list' ? 'shell' : 'list'
    const bounds = (top: number, height: number) => ({x: 0, y: top, top, bottom: top + height,
      left: 0, right: 320, width: 320, height, toJSON: () => ({})})
    for (const [kind, element] of [['list', options], ['shell', shell]] as const) Object.defineProperties(element, {
      clientHeight: {configurable: true, value: kind === 'list' && mode === 'shell' ? 336 : 96},
      scrollHeight: {configurable: true, value: 336}, clientTop: {configurable: true, value: 2},
      getBoundingClientRect: {configurable: true, value: () => bounds(100 - (kind === 'list' ? scrollTop.shell : 0), kind === 'list' && mode === 'shell' ? 340 : 100)},
      scrollTop: {configurable: true, get: () => scrollTop[kind], set: (value: number) => {scrollTop[kind] = value;writes[kind].push(value)}},
    })
    for (const [element, contentTop] of [[first, 0], [last, 288]] as const) Object.defineProperties(element, {
      getBoundingClientRect: {configurable: true, value: () => bounds(102 + contentTop - scrollTop.list - scrollTop.shell, 44)},
      scrollIntoView: {configurable: true, value: scrollIntoView},
    })
    Object.defineProperty(document.documentElement, 'scrollTop', {configurable: true, writable: true, value: 23})
    Object.defineProperty(document.body, 'scrollTop', {configurable: true, writable: true, value: 41})

    focus.mockClear();press(keyboardAction('zh-CN'), 'End');await settle()
    expect(scrollTop[mode]).toBeGreaterThan(0);expect(scrollTop[mode]).toBeLessThanOrEqual(240)
    expect(last.getBoundingClientRect().top).toBeGreaterThanOrEqual(102)
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(198)
    expect(focused).toBe(last);expect(focus).toHaveBeenCalledOnce();expect(focus).toHaveBeenCalledWith(last, {preventScroll: true})
    expect(scrollTop[otherMode]).toBe(0);expect(writes[otherMode]).toEqual([])
    expect(document.documentElement.scrollTop).toBe(23);expect(document.body.scrollTop).toBe(41)

    focus.mockClear();press(keyboardAction('es-ES'), 'Home');await settle()
    expect(scrollTop[mode]).toBe(0);expect(writes[mode]).toHaveLength(2)
    expect(first.getBoundingClientRect().top).toBeGreaterThanOrEqual(102)
    expect(first.getBoundingClientRect().bottom).toBeLessThanOrEqual(198)
    expect(focused).toBe(first);expect(focus).toHaveBeenCalledOnce();expect(focus).toHaveBeenCalledWith(first, {preventScroll: true})
    expect(scrollTop[otherMode]).toBe(0);expect(writes[otherMode]).toEqual([])
    expect(document.documentElement.scrollTop).toBe(23);expect(document.body.scrollTop).toBe(41)
    expect(scrollIntoView).not.toHaveBeenCalled();expect(setLanguage).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled();expect(confirmed).not.toHaveBeenCalled()
  })
  it('键盘仅预览，确认一次保存最后选择，等待及交接阶段旧键盘回调均不再操作', async () => {
    await mount({initialLanguage: 'en-US'});await languageStep()
    press(keyboardAction('en-US'), 'End');await settle();press(keyboardAction('es-ES'), 'ArrowLeft');await settle()
    expect(state.selectedLanguage).toBe('ru-RU');expect(setLanguage).not.toHaveBeenCalled()
    const oldKey = keyboardAction('ru-RU'), pending = confirmAction()();await settle();focus.mockClear()
    expect(press(oldKey, 'Home').preventDefault).not.toHaveBeenCalled()
    expect(press(keyboardAction('ru-RU'), 'ArrowRight').preventDefault).not.toHaveBeenCalled()
    expect(state.selectedLanguage).toBe('ru-RU');expect(setLanguage).toHaveBeenCalledOnce();expect(requests.map(request => request.value)).toEqual(['ru-RU'])
    requests[0].gate.resolve();await pending;await settle()
    expect(press(oldKey, 'End').preventDefault).not.toHaveBeenCalled();expect(focus).not.toHaveBeenCalled()
    expect(stored).toBe('ru-RU');expect(saved).toHaveBeenCalledOnce();expect(saved).toHaveBeenCalledWith('ru-RU')
    expect(confirmed).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledWith('ru-RU')
  })
  it('保存失败后新键盘回调恢复，选择清除错误并可确认最终语言一次', async () => {
    await mount({initialLanguage: 'en-US'});await languageStep();press(keyboardAction('en-US'), 'End');await settle()
    const oldKey = keyboardAction('es-ES'), pending = confirmAction()();requests[0].gate.reject(new Error('storage failed'));await pending;await settle()
    expect(state.errorMessage).not.toBe('');expect(press(oldKey, 'Home').preventDefault).not.toHaveBeenCalled()
    press(keyboardAction('es-ES'), 'Home');await settle();expect(state.selectedLanguage).toBe('zh-CN');expect(state.errorMessage).toBe('')
    const retry = confirmAction()();requests[1].gate.resolve();await retry;await settle()
    expect(requests.map(request => request.value)).toEqual(['es-ES', 'zh-CN']);expect(stored).toBe('zh-CN')
    expect(saved).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledWith('zh-CN')
  })
  it.each(['selection', 'props', 'cached', 'pagehide', 'unmount'])('%s 改变后旧键盘回调不复活、不改预览或抢焦点', async reason => {
    await mount({initialLanguage: 'ja-JP'});await languageStep();const oldKey = keyboardAction('ja-JP')
    if (reason === 'selection') choose('en-US')()
    else if (reason === 'props') source.initialLanguage = 'en-US'
    else invalidate(reason)
    await settle()
    if (reason === 'cached') {shown.value = true;await settle()}
    const selected = state.selectedLanguage, preview = document.documentElement.lang;focus.mockClear()
    expect(press(oldKey, 'End').preventDefault).not.toHaveBeenCalled();await settle()
    expect(state.selectedLanguage).toBe(selected);expect(document.documentElement.lang).toBe(preview);expect(focus).not.toHaveBeenCalled();expect(setLanguage).not.toHaveBeenCalled()
    if (reason === 'cached') {
      press(keyboardAction('ja-JP'), 'End');await settle();expect(state.selectedLanguage).toBe('es-ES');expect(focused).toBe(button('[data-language="es-ES"]'))
    }

  })
  it.each(['cached', 'pagehide', 'unmount', 'props', 'selection', 'outside', 'busy'])('键盘选择后渲染前 %s，取消排队的旧卡片焦点', async reason => {
    await mount({initialLanguage: 'ja-JP'});await languageStep();press(keyboardAction('ja-JP'), 'ArrowRight');focus.mockClear()
    let pending: Promise<void> | undefined
    if (reason === 'props') componentProps.initialLanguage = 'en-US'
    else if (reason === 'selection') state.selectedLanguage = 'fr-FR'
    else if (reason === 'outside') {const outside = document.createElement('button');document.body.append(outside);focused = outside}
    else if (reason === 'busy') pending = state.confirm()
    else invalidate(reason)
    await settle();expect(focus).not.toHaveBeenCalled()
    if (pending) {requests[0].gate.resolve();await pending;await settle();expect(focus).not.toHaveBeenCalled()}
  })
  it('缓存返回时外部控件已聚焦，不把焦点抢回语言列表',async()=>{
    await mount({initialLanguage:'ja-JP'});shown.value=false;await settle();const outside=document.createElement('button');document.body.append(outside);focused=outside;focus.mockClear()
    shown.value=true;await settle();expect(focused).toBe(outside);expect(focus).not.toHaveBeenCalled();expect(setLanguage).not.toHaveBeenCalled()
  })
  it('键盘选择后所属DOM已脱离，排队焦点不触碰分离按钮',async()=>{
    await mount({initialLanguage:'ja-JP'});press(keyboardAction('ja-JP'),'ArrowRight');focus.mockClear();document.getElementById('app')!.remove();await settle()
    expect(focus).not.toHaveBeenCalled();expect(setLanguage).not.toHaveBeenCalled();expect(state.selectedLanguage).toBe('ko-KR')
  })
  it('共享 i18n 返回已被取代时，不宣布保存或交接', async () => {
    await mount({initialLanguage:'en-US'});await languageStep();setLanguage.mockImplementationOnce(async()=>false);await confirmAction()();await settle()
    expect(saved).not.toHaveBeenCalled();expect(confirmed).not.toHaveBeenCalled();expect(componentTimers()).toBe(0);expect(button('.onboarding-form > .onboarding-confirm').hasAttribute('disabled')).toBe(false)
  })

  it('闲时 initialLanguage 同步后旧选项失效，当前选择与预览语言一致', async () => {
    await mount({initialLanguage: 'en-US'});await languageStep();const oldChoose = choose('fr-FR');source.initialLanguage = 'ja-JP';await settle();oldChoose();await settle()
    expect(button('[data-language="ja-JP"]').getAttribute('aria-checked')).toBe('true');expect(document.documentElement.lang).toBe('ja-JP');choose('ko-KR')();await settle();expect(document.documentElement.lang).toBe('ko-KR')
  })
  it('卸载清理同一个 pagehide 监听器', async () => {
    const add = port.addListener, remove = port.removeListener;await mount({initialLanguage: 'en-US'})
    const listener = add.mock.calls.find((call: unknown[]) => call[0] === 'pagehide')?.[1];expect(listener).toBeTypeOf('function');invalidate('unmount');expect(remove).toHaveBeenCalledWith('pagehide', listener)
  })

  it('首屏直接聚焦浏览器默认语言一次，无下一步或返回按钮', async () => {
    await mount({initialLanguage: 'ja-JP'});expect(focus).toHaveBeenCalledOnce()
    expect(focused).toBe(button('[data-language="ja-JP"]'));expect(focus.mock.calls[0][1]).toEqual({preventScroll: true})
    expect(document.querySelectorAll('[role="radio"]')).toHaveLength(8)
    expect(document.querySelector('.onboarding-back')).toBeNull()
  })
  it('保存期间冻结全部选择，提交值、存储及 saved/confirmed 一致且立即交接', async () => {
    await mount({initialLanguage: 'en-US'});const lateChoose = choose('ja-JP'), pending = confirmAction()();await settle()
    expect([...document.querySelectorAll('button')].every(element => element.hasAttribute('disabled'))).toBe(true)
    lateChoose();requests[0].gate.resolve();await pending;await settle()
    expect(requests.map(request => request.value)).toEqual(['en-US']);expect(stored).toBe('en-US')
    expect(saved).toHaveBeenCalledOnce();expect(saved).toHaveBeenCalledWith(stored);expect(confirmed).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledWith(stored)
    expect(saved.mock.invocationCallOrder[0]).toBeLessThan(confirmed.mock.invocationCallOrder[0]);expect(componentTimers()).toBe(0)
    expect(button('.onboarding-confirm').hasAttribute('disabled')).toBe(true)
    await confirmAction()();expect(setLanguage).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledOnce()
  })
  it('确认中与交接后重复触发均不重复保存或交接', async () => {
    await mount({initialLanguage: 'en-US'});await languageStep();const confirm = confirmAction(), pending = confirm();await confirm();requests[0].gate.resolve();await pending;await settle();const late = confirm();requests[1]?.gate.resolve();await late
    expect(setLanguage).toHaveBeenCalledOnce();expect(componentTimers()).toBe(0);expect(confirmed).toHaveBeenCalledOnce();expect(button('.onboarding-confirm').hasAttribute('disabled')).toBe(true)
  })
  it.each(['cached', 'pagehide', 'unmount'])('%s 后等待保存成功，不通知或抢焦点', async reason => {
    await mount({initialLanguage: 'en-US'});await languageStep();const pending = confirmAction()();invalidate(reason);await settle();focus.mockClear();requests[0].gate.resolve();await pending;await settle()
    expect(stored).toBe('en-US');expect(saved).not.toHaveBeenCalled();expect(confirmed).not.toHaveBeenCalled();expect(componentTimers()).toBe(0);expect(focus).not.toHaveBeenCalled()
  })
  it.each(['cached', 'pagehide', 'unmount'])('%s 后等待保存失败，不回写错误或 document.lang', async reason => {
    await mount({initialLanguage: 'en-US'});await languageStep();const pending = confirmAction()();invalidate(reason);await settle();document.documentElement.lang = 'fr-FR';requests[0].gate.reject(new Error('storage failed'));await pending;await settle()
    expect(state.errorMessage).toBe('');expect(document.documentElement.lang).toBe('fr-FR');expect(componentTimers()).toBe(0)
  })
  it.each(['cached', 'pagehide', 'unmount'])('%s 不重复已完成的交接，不残留定时器', async reason => {
    await mount({initialLanguage: 'en-US'});const pending = confirmAction()();requests[0].gate.resolve();await pending;await settle()
    expect(confirmed).toHaveBeenCalledOnce();invalidate(reason);await settle();await vi.advanceTimersByTimeAsync(5000)
    expect(confirmed).toHaveBeenCalledOnce();expect(componentTimers()).toBe(0)
  })
  it('saved 的父回调同步卸载后不再宣布 confirmed', async () => {
    await mount({initialLanguage: 'en-US'});await languageStep();saved.mockImplementationOnce(() => {app?.unmount();app = undefined});const pending = confirmAction()();requests[0].gate.resolve();await pending;await settle();expect(saved).toHaveBeenCalledOnce();expect(confirmed).not.toHaveBeenCalled();expect(componentTimers()).toBe(0)
  })
  it('保存失败回滚语言且保留选择，可重新提交并成功一次', async () => {
    await mount({initialLanguage: 'en-US'});await languageStep();const pending = confirmAction()();requests[0].gate.reject(new Error('storage failed'));await pending;await settle()
    expect(stored).toBe('zh-CN');expect(language.value).toBe('zh-CN');expect(document.documentElement.lang).toBe('zh-CN');expect(button('[role="alert"]').textContent).toContain('Could not confirm the language was saved')
    expect(button('[data-language="en-US"]').getAttribute('aria-checked')).toBe('true');expect(button('.onboarding-form > .onboarding-confirm').hasAttribute('disabled')).toBe(false)
    const retry = confirmAction()();requests[1].gate.resolve();await retry;await settle();expect(stored).toBe('en-US');expect(saved).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledOnce()
  })
  it('忙时的新 initialLanguage 生效且旧保存不宣布新 props 完成', async () => {
    await mount({initialLanguage: 'en-US'});await languageStep();const pending = confirmAction()();source.initialLanguage = 'ja-JP';await settle();requests[0].gate.resolve();await pending;await settle()
    expect(saved).not.toHaveBeenCalled();expect(confirmed).not.toHaveBeenCalled();expect(componentTimers()).toBe(0);expect(button('[data-language="ja-JP"]').getAttribute('aria-checked')).toBe('true')
    const current = confirmAction()();requests[1].gate.resolve();await current;await settle();expect(stored).toBe('ja-JP');expect(confirmed).toHaveBeenCalledWith('ja-JP')
  })
  it('失活后重开不复活旧按钮，未结束的保存仍锁定；完成后可重新确认', async () => {
    await mount({initialLanguage: 'en-US'});await languageStep();const oldChoose = choose('ja-JP'), oldConfirm = confirmAction(), pending = oldConfirm();shown.value = false;await settle();shown.value = true;await settle();oldChoose();await oldConfirm()
    expect(setLanguage).toHaveBeenCalledOnce();expect(button('.onboarding-form > .onboarding-confirm').hasAttribute('disabled')).toBe(true);requests[0].gate.resolve();await pending;await settle();expect(saved).not.toHaveBeenCalled()
    expect(button('.onboarding-form > .onboarding-confirm').hasAttribute('disabled')).toBe(false);const current = confirmAction()();requests[1].gate.resolve();await current;await settle();expect(saved).toHaveBeenCalledWith('en-US')
  })
  it.each(['cached', 'pagehide', 'unmount', 'props', 'outside'])('选择渲染前 %s，使排队焦点失效', async reason => {
    await mount({initialLanguage: 'en-US'});press(keyboardAction('en-US'), 'ArrowRight');focus.mockClear()
    if (reason === 'props') componentProps.initialLanguage = 'ja-JP';else if (reason === 'outside') {const outside = document.createElement('button');document.body.append(outside);focused = outside}else invalidate(reason)
    await settle();expect(focus).not.toHaveBeenCalled()
  })
  it.each(languageRules.UI_LANGUAGE_OPTIONS)('$value 保存失败只显示可就地重试的本地文案，不泄露异常或指向设置页', async ({value}) => {
    await mount({initialLanguage: value});const pending = confirmAction()();requests[0].gate.reject(new Error('private-token https://secret.invalid'));await pending;await settle()
    const error = button('[role="alert"]');expect(error.getAttribute('lang')).toBe(value)
    expect(error.textContent).not.toMatch(/private-token|secret.invalid|设置页|Reopen settings/u)
    expect(error.textContent!.length).toBeGreaterThan(10);expect(button('.onboarding-confirm').hasAttribute('disabled')).toBe(false)
  })
  it('启用场景步骤时：语言确认进入第二步，支持多选应用与跳过直接开始', async () => {
    const {Config} = await import('@/src/core/config/model')
    const currentConfig = new Config();currentConfig.display = 0;currentConfig.glossaryEnabled = false
    const applyScenarioPatch = vi.fn(async (patch: Record<string, unknown>) => {Object.assign(currentConfig, patch)})
    await mount({initialLanguage: 'zh-TW', enableScenarioStep: true, currentConfig, applyScenarioPatch})
    const pending = confirmAction()();requests[0].gate.resolve();await pending;await settle()
    expect(saved).toHaveBeenCalledWith('zh-TW');expect(confirmed).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="onboarding-scenario-step"]')).not.toBeNull()

    const academic = button('[data-scenario="academic"]'), developer = button('[data-scenario="developer"]')
    callback(academic)();callback(developer)();await settle()
    expect(academic.getAttribute('aria-pressed')).toBe('true');expect(developer.getAttribute('aria-pressed')).toBe('true')
    callback(developer)();await settle()
    expect(developer.getAttribute('aria-pressed')).toBe('false')

    await callback(button('[data-testid="onboarding-scenario-apply"]'))();await settle()
    expect(applyScenarioPatch).toHaveBeenCalledOnce()
    expect(currentConfig.display).toBe(1);expect(currentConfig.glossaryEnabled).toBe(true)
    expect(confirmed).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledWith('zh-TW')

    // 当所选场景配置已完全满足时，不重复调用 applyScenarioPatch 但仍正常完成交接
    app?.unmount();app = undefined;await settle();saved.mockClear();confirmed.mockClear();applyScenarioPatch.mockClear()
    await mount({initialLanguage: 'zh-TW', enableScenarioStep: true, currentConfig, applyScenarioPatch})
    const pending2 = confirmAction()();requests[1].gate.resolve();await pending2;await settle()
    callback(button('[data-scenario="academic"]'))();await settle()
    await callback(button('[data-testid="onboarding-scenario-apply"]'))();await settle()
    expect(applyScenarioPatch).not.toHaveBeenCalled()
    expect(confirmed).toHaveBeenCalledOnce()
  })
  it('启用场景步骤时可跳过不写入场景补丁，并保护非活跃或异步卸载边界', async () => {
    const {Config} = await import('@/src/core/config/model')
    const currentConfig = new Config()
    let releasePatch!: () => void
    const applyScenarioPatch = vi.fn(() => new Promise<void>(resolve => {releasePatch = resolve}))
    await mount({initialLanguage: 'en-US', enableScenarioStep: true, currentConfig, applyScenarioPatch})
    const pending = confirmAction()();requests[0].gate.resolve();await pending;await settle()
    await callback(button('[data-testid="onboarding-scenario-skip"]'))();await settle()
    expect(applyScenarioPatch).not.toHaveBeenCalled();expect(confirmed).toHaveBeenCalledOnce();expect(confirmed).toHaveBeenCalledWith('en-US')

    // 二次触发在 committed 后被忽略
    await state.finishScenario(true);state.toggleScenario('academic')
    expect(applyScenarioPatch).not.toHaveBeenCalled()

    // 异步应用补丁期间卸载，不触发 confirmed
    app?.unmount();app = undefined;await settle();saved.mockClear();confirmed.mockClear()
    const freshConfig = new Config();freshConfig.display = 0
    await mount({initialLanguage: 'en-US', enableScenarioStep: true, currentConfig: freshConfig, applyScenarioPatch})
    const langPending = confirmAction()();requests[1].gate.resolve();await langPending;await settle()
    callback(button('[data-scenario="academic"]'))();await settle()
    const applyPending = callback(button('[data-testid="onboarding-scenario-apply"]'))()
    invalidate('unmount');releasePatch();await applyPending;await settle()
    expect(confirmed).not.toHaveBeenCalled()
  })
  it('场景预设保存失败时展示可重试错误，并支持 initialStep=scenario 直接恢复第二步', async () => {
    const {Config} = await import('@/src/core/config/model')
    const currentConfig = new Config();currentConfig.display = 0
    const applyScenarioPatch = vi.fn(async () => {throw new Error('persist failed')})
    await mount({initialLanguage: 'zh-TW', initialStep: 'scenario', enableScenarioStep: true, currentConfig, applyScenarioPatch})
    expect(document.querySelector('[data-testid="onboarding-scenario-step"]')).not.toBeNull()
    callback(button('[data-scenario="academic"]'))();await settle()
    await callback(button('[data-testid="onboarding-scenario-apply"]'))();await settle()
    expect(applyScenarioPatch).toHaveBeenCalledOnce()
    expect(confirmed).not.toHaveBeenCalled()
    expect(button('[data-testid="onboarding-scenario-error"]').textContent).toBe('scenarioPresets.onboarding.saveFailed')

    // 异步失败期间卸载，不回写错误
    let rejectLate!: (error: Error) => void
    app?.unmount();app = undefined;await settle()
    await mount({
      initialLanguage: 'zh-TW',
      initialStep: 'scenario',
      enableScenarioStep: true,
      currentConfig,
      applyScenarioPatch: () => new Promise<void>((_resolve, reject) => {rejectLate = reject}),
    })
    callback(button('[data-scenario="academic"]'))();await settle()
    const pendingFail = callback(button('[data-testid="onboarding-scenario-apply"]'))()
    invalidate('unmount');rejectLate(new Error('late error'));await pendingFail;await settle()
    expect(state.errorMessage).toBe('')
  })
})

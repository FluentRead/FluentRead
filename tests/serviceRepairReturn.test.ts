/**
 * @file tests/serviceRepairReturn.test.ts
 * 文件职责：通过实际返回网页组件模板验证明确点击、来源校验与迟到结果的操作归属。
 * 主要内容：覆盖扩展 URL 参数边界、普通网页协议、来源关闭、手动重试、重复点击、服务切换、显式失活、真实页面隐藏、缓存停用和卸载。
 * 模块边界：只替换浏览器 tabs 端口与 i18n，不模拟组件实现、不访问真实用户标签页。
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as vue from 'vue'
import type {UiLanguage} from '@/src/core/i18n'
import {registerUiLanguageBundle} from '@/src/core/i18n'
import {registerAllUiLanguageBundles, UI_LANGUAGE_BUNDLES} from './helpers/uiLanguageBundles'
registerAllUiLanguageBundles()
import * as diagnostics from '@/src/services/diagnostics'
import * as actionContext from '@/src/features/settings/model/useSettingsActionContext'
import * as repairFocus from '@/src/features/settings/ui/services/serviceRepairFocus'
import {compileVueInlineFixture} from './helpers/compiledVueFixture'
const get = vi.fn(), update = vi.fn()
const PageEvent = Event, PageEventTarget = EventTarget
const disposals: (() => void)[] = []
type TestNode = {props: Record<string, any>; children: TestNode[]; parent?: TestNode; value?: string}
async function settle() {for (let i = 0; i < 8; i++) await Promise.resolve();await vue.nextTick()}
async function mount(href = 'chrome-extension://fixture/options.html?returnTabId=7', locale: UiLanguage = 'zh-CN', initial: {active?: boolean; contextKey?: string; showRepairHint?: boolean; initialVisibility?: 'visible' | 'hidden'} = {}) {
  const {initialVisibility = 'visible', ...componentProps} = initial
  let visibility = initialVisibility
  const documentEvents = new PageEventTarget(), windowEvents = new PageEventTarget()
  Object.defineProperty(documentEvents, 'visibilityState', {get: () => visibility})
  const documentAdd = vi.spyOn(documentEvents, 'addEventListener'), documentRemove = vi.spyOn(documentEvents, 'removeEventListener')
  const windowAdd = vi.spyOn(windowEvents, 'addEventListener'), windowRemove = vi.spyOn(windowEvents, 'removeEventListener')
  vi.stubGlobal('document', documentEvents);vi.stubGlobal('window', windowEvents)
  vi.stubGlobal('location', {href})
  const compiled = compileVueInlineFixture('src/features/settings/ui/services/ServiceRepairReturn.vue', {id: 'service-return'})
  const language = vue.ref<UiLanguage>(locale), bundleRevision = vue.ref(0)
  const dependencies: Record<string, unknown> = {'vue': vue, 'webextension-polyfill': {__esModule: true, default: {tabs: {get, update}}},
    '@/src/ui/i18n': {useUiI18n: () => ({language, bundleRevision})}, '@/src/services/diagnostics': diagnostics, '../../model/useSettingsActionContext': actionContext, './serviceRepairFocus': repairFocus}
  const module = {exports: {} as {default: vue.Component}}
  new Function('require', 'exports', 'module', compiled.code)((id: string) => {if (!(id in dependencies)) throw new Error(id);return dependencies[id]}, module.exports, module)
  const make = (): TestNode => ({props: {}, children: []})
  function remove(n: TestNode) {if (n.parent) {const index = n.parent.children.indexOf(n);if (index >= 0) n.parent.children.splice(index, 1)};n.parent = undefined}
  const renderer = vue.createRenderer<TestNode, TestNode>({patchProp: (n, key, _old, value) => {n.props[key] = value},
    insert(n, parent, anchor) {remove(n);const index = anchor ? parent.children.indexOf(anchor) : -1;parent.children.splice(index < 0 ? parent.children.length : index, 0, n);n.parent = parent},
    remove, createElement: make, createText: make, createComment: make, setText: (n, value) => {n.value = value}, setElementText: (n, value) => {n.value = value},
    parentNode: n => n.parent || null, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
    insertStaticContent: () => {throw new Error('Unexpected static content')}})
  const ready = vi.fn()
  const props = vue.reactive({active: true, context: {}, contextKey: 'deepseek', ...componentProps}), shown = vue.ref(true), host = make()
  const app = renderer.createApp({setup: () => () => vue.h(vue.KeepAlive, null, {default: () => shown.value ? vue.h(module.exports.default, {...props, onRepairReady: ready}) : vue.h({render: () => null}, {key: 'hidden'})})})
  app.config.warnHandler = () => {};app.mount(host)
  let stopped = false
  const stop = () => {if (!stopped) {stopped = true;app.unmount()}}
  disposals.push(stop);await settle()
  function nodes(n = host): TestNode[] {return [n, ...n.children.flatMap(child => nodes(child))]}
  const button = () => nodes().find(n => Object.hasOwn(n.props, 'data-return-source-tab'))
  const text = () => nodes().map(n => n.value || '').join(' ')
  const click = async () => {const element = button();if (element) await element.props.onClick();await settle()}
  const statusNode = () => nodes().find(n => n.props.role === 'status')
  const setVisibility = (value: 'visible' | 'hidden') => {visibility = value;documentEvents.dispatchEvent(new PageEvent('visibilitychange'))}
  const pageEvent = (type: 'pagehide' | 'pageshow') => windowEvents.dispatchEvent(new PageEvent(type))
  return {props, shown, stop, button, text, click, language, bundleRevision, ready, statusNode, setVisibility, pageEvent,
    documentEvents, windowEvents, documentAdd, documentRemove, windowAdd, windowRemove}
}
beforeEach(() => {vi.clearAllMocks();get.mockResolvedValue({id: 7, url: 'https://example.test/private?secret=fixture'});update.mockResolvedValue({id: 7})})
afterEach(() => {for (const stop of disposals.splice(0)) stop();vi.restoreAllMocks();vi.unstubAllGlobals()})
describe('服务修复后返回来源网页', () => {
  it('迟到语言资源更新已有失败提示与按钮，不重新激活网页或清除失败状态', async () => {
    registerUiLanguageBundle('fr-FR', {...UI_LANGUAGE_BUNDLES['fr-FR'], messages: {}})
    try {
      const h = await mount('chrome-extension://fixture/options.html?returnTabId=7', 'fr-FR')
      get.mockResolvedValueOnce({id: 7, url: 'chrome://settings'})
      await h.click();expect(h.text()).toContain('原网页已关闭或当前无法访问')
      registerUiLanguageBundle('fr-FR', UI_LANGUAGE_BUNDLES['fr-FR'])
      h.bundleRevision.value++;await settle()
      expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-unavailable', 'fr-FR'))
      expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-return', 'fr-FR'))
      expect(get).toHaveBeenCalledTimes(1);expect(update).not.toHaveBeenCalled()
    } finally {registerUiLanguageBundle('fr-FR', UI_LANGUAGE_BUNDLES['fr-FR'])}
  })
  it('有效明确修复链接只在首次活跃挂载通知一次，不随同步或重新激活抢焦点', async () => {
    const h = await mount('chrome-extension://fixture/options.html?returnTabId=7&service=deepseek')
    expect(h.ready).toHaveBeenCalledOnce();expect(h.ready).toHaveBeenCalledWith('deepseek');expect(get).not.toHaveBeenCalled()
    h.props.context = {};h.props.active = false;await settle();h.props.active = true;await settle()
    h.props.contextKey = 'google';await settle();h.props.contextKey = 'deepseek';h.shown.value = false;await settle();h.shown.value = true;await settle()
    expect(h.ready).toHaveBeenCalledOnce()
  })
  it.each([
    ['https://fixture/options.html?returnTabId=7&service=deepseek', {}],
    ['chrome-extension://fixture/options.html?service=deepseek', {}],
    ['chrome-extension://fixture/options.html?returnTabId=7', {}],
    ['chrome-extension://fixture/options.html?returnTabId=7&service=deepseek&service=deepseek', {}],
    ['chrome-extension://fixture/options.html?returnTabId=7&service=openai', {}],
    ['chrome-extension://fixture/options.html?returnTabId=7&service=deepseek', {active: false}],
  ] as const)('非有效初次修复场景不请求焦点：%s %j', async (href, initial) => {
    const h = await mount(href, 'zh-CN', initial);expect(h.ready).not.toHaveBeenCalled()
    h.props.active = true;h.props.contextKey = 'deepseek';await settle();expect(h.ready).not.toHaveBeenCalled()
  })
  it.each(['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const)('%s 实际模板的空闲、等待、失败和返回成功反馈使用同一语言词库', async locale => {
    const h = await mount('chrome-extension://fixture/options.html?returnTabId=7', locale)
    expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-return-hint', locale))
    expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-return', locale))
    let release!: (value: unknown) => void
    get.mockReturnValueOnce(new Promise(resolve => {release = resolve}))
    const job = h.click();await settle()
    expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-looking', locale))
    release({id: 7, url: 'chrome://settings'});await job
    expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-unavailable', locale))
    await h.click()
    expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-returned', locale))
    if (locale !== 'zh-CN' && locale !== 'ja-JP') expect(h.text()).not.toMatch(/[\u3400-\u9fff]/u)
    expect(get).toHaveBeenCalledTimes(2);expect(update).toHaveBeenCalledWith(7, {active: true})
    h.language.value = locale === 'zh-CN' ? 'en-US' : 'zh-CN';await settle()
    expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-returned', h.language.value))
    expect(get).toHaveBeenCalledTimes(2)
  })
  it.each([
    'https://example.test/options.html?returnTabId=7', 'file:///options.html?returnTabId=7',
    'chrome-extension://fixture/options.html', 'chrome-extension://fixture/options.html?returnTabId=-1',
    'chrome-extension://fixture/options.html?returnTabId=1.5', 'chrome-extension://fixture/options.html?returnTabId=Infinity',
    'chrome-extension://fixture/options.html?returnTabId=9007199254740992', 'chrome-extension://fixture/options.html?returnTabId=7&returnTabId=8',
  ])('非法来源参数或非扩展页面不展示动作：%s', async href => {
    const h = await mount(href);expect(h.button()).toBeUndefined();await h.click();expect(get).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled()
  })
  it.each(['chrome-extension:', 'moz-extension:', 'safari-web-extension:'])('只在明确点击 %s 页面后验证源 ID 并激活原标签页', async protocol => {
    const h = await mount(`${protocol}//fixture/options.html?returnTabId=7`)
    expect(get).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled()
    await h.click();expect(get).toHaveBeenCalledWith(7);expect(update).toHaveBeenCalledWith(7, {active: true})
    expect(h.text()).not.toContain('private');expect(h.text()).toContain('通过扩展重试翻译')
  })
  it.each(['http://example.test', 'https://example.test', 'file:///document.html'])('来源 %s 协议允许返回', async url => {
    get.mockResolvedValueOnce({id: 7, url});const h = await mount();await h.click();expect(update).toHaveBeenCalledOnce()
  })
  it.each(['chrome://settings', 'about:blank', 'moz-extension://other/page.html', 'data:text/html,private', 'javascript:alert(1)', '', undefined])('来源限制页 %s 不激活并给出本地解释', async url => {
    get.mockResolvedValueOnce({id: 7, url});const h = await mount();await h.click();expect(update).not.toHaveBeenCalled();expect(h.text()).toContain('原网页已关闭或当前无法访问')
  })
  it('接受安全整数 0，来源 ID 不匹配或组件失活时不激活标签页', async () => {
    get.mockResolvedValueOnce({id: 0, url: 'https://example.test'})
    const h = await mount('chrome-extension://fixture/options.html?returnTabId=0')
    h.props.active = false;await settle();await h.click();expect(get).not.toHaveBeenCalled()
    h.props.active = true;await settle();await h.click();expect(update).toHaveBeenCalledWith(0, {active: true})
    get.mockResolvedValueOnce({id: 99, url: 'https://example.test'});update.mockClear();await h.click();expect(update).not.toHaveBeenCalled()
    expect(h.text()).toContain('原网页已关闭或当前无法访问')
  })
  it('关闭的源网页与激活失败不泄露原始错误，并允许明确重试', async () => {
    const h = await mount();get.mockRejectedValueOnce(new Error('private-tab-url token=fixture'))
    await h.click();expect(update).not.toHaveBeenCalled();expect(h.text()).not.toContain('fixture');expect(h.button()?.props.disabled).toBe(false)
    update.mockRejectedValueOnce(new Error('private-update-error'));await h.click();expect(h.text()).toContain('原网页已关闭或当前无法访问')
    await h.click();expect(update).toHaveBeenCalledTimes(2)
  })
  it.each(['active', 'cached', 'service', 'context', 'unmount'])('%s 使迟到 tabs.get 失效，不能切换到原网页', async reason => {
    let release!: (value: unknown) => void
    get.mockReturnValueOnce(new Promise(resolve => {release = resolve}))
    const h = await mount(), job = h.click();await settle();expect(h.button()?.props.disabled).toBe(true)
    const duplicate = h.click();await duplicate;expect(get).toHaveBeenCalledOnce()
    if (reason === 'active') h.props.active = false
    if (reason === 'cached') h.shown.value = false
    if (reason === 'service') h.props.contextKey = 'google'
    if (reason === 'context') h.props.context = {}
    if (reason === 'unmount') h.stop()
    await settle();release({id: 7, url: 'https://example.test'});await job
    expect(update).not.toHaveBeenCalled()
    if (reason === 'service' || reason === 'context') {expect(h.button()?.props.disabled).toBe(false);await h.click();expect(update).toHaveBeenCalledOnce()}
  })

  it.each(['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const)('%s 普通来源返回不声称修复或重试，仍保留等待、不可用和明确重试', async locale => {
    const h = await mount('chrome-extension://fixture/options.html?returnTabId=7', locale, {contextKey: 'settings-selection', showRepairHint: false})
    expect(h.statusNode()).toBeUndefined();expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-return', locale))
    expect(get).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled();expect(h.ready).not.toHaveBeenCalled()
    let release!: (value: unknown) => void
    get.mockReturnValueOnce(new Promise(resolve => {release = resolve}))
    const job = h.click();await settle()
    expect(h.button()?.props.disabled).toBe(true);expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-looking', locale));expect(h.statusNode()).toBeUndefined()
    await h.click();expect(get).toHaveBeenCalledOnce()
    release({id: 7, url: 'chrome://settings'});await job
    expect(update).not.toHaveBeenCalled();expect(h.statusNode()).toBeDefined();expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-unavailable', locale))
    expect(h.button()?.props.disabled).toBe(false)
    await h.click();expect(get).toHaveBeenCalledTimes(2);expect(update).toHaveBeenCalledOnce();expect(update).toHaveBeenCalledWith(7, {active: true})
    expect(h.statusNode()).toBeUndefined();expect(h.text()).not.toContain(diagnostics.getDiagnosticUiText('source-return-hint', locale))
    expect(h.text()).not.toContain(diagnostics.getDiagnosticUiText('source-returned', locale))
    h.language.value = locale === 'zh-CN' ? 'en-US' : 'zh-CN';await settle()
    expect(h.statusNode()).toBeUndefined();expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-return', h.language.value));expect(get).toHaveBeenCalledTimes(2)
  })
  it.each(['https://fixture/options.html?returnTabId=7', 'chrome-extension://fixture/options.html?returnTabId=7&returnTabId=8'])('普通模式仍拒绝无效来源：%s', async href => {
    const h = await mount(href, 'zh-CN', {showRepairHint: false});expect(h.button()).toBeUndefined();await h.click()
    expect(get).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled()
  })
  it('初始 document 隐藏时不读取或返回来源，显示后仅新明确点击可用', async () => {
    const h = await mount('chrome-extension://fixture/options.html?returnTabId=7&service=deepseek', 'zh-CN', {initialVisibility: 'hidden'})
    expect(h.ready).not.toHaveBeenCalled();expect(h.button()?.props.disabled).toBe(true);await h.click();expect(get).not.toHaveBeenCalled()
    h.setVisibility('visible');await settle();expect(h.button()?.props.disabled).toBe(false);expect(get).not.toHaveBeenCalled();expect(h.ready).not.toHaveBeenCalled()
    await h.click();expect(update).toHaveBeenCalledOnce();expect(update).toHaveBeenCalledWith(7, {active: true})
  })
  it.each(['visibility', 'pagehide'] as const)('%s 隐藏后恢复不复活旧查询，旧 finally 也不释放新请求', async kind => {
    const h = await mount('chrome-extension://fixture/options.html?returnTabId=7', 'zh-CN', {contextKey: 'settings-selection', showRepairHint: false})
    let oldRelease!: (value: unknown) => void, newRelease!: (value: unknown) => void
    get.mockReturnValueOnce(new Promise(resolve => {oldRelease = resolve})).mockReturnValueOnce(new Promise(resolve => {newRelease = resolve}))
    const oldJob = h.click();await settle();expect(get).toHaveBeenCalledOnce()
    if (kind === 'visibility') h.setVisibility('hidden');else h.pageEvent('pagehide')
    // 同 tick 隐藏后恢复，revision 必须同步使旧 capture 失效。
    if (kind === 'visibility') h.setVisibility('visible');else h.pageEvent('pageshow')
    await settle();expect(get).toHaveBeenCalledOnce();expect(h.button()?.props.disabled).toBe(false)
    const newJob = h.click();await settle();expect(get).toHaveBeenCalledTimes(2)
    oldRelease({id: 7, url: 'https://example.test/old'});await oldJob
    expect(update).not.toHaveBeenCalled();expect(h.button()?.props.disabled).toBe(true);expect(h.text()).toContain(diagnostics.getDiagnosticUiText('source-looking', 'zh-CN'))
    newRelease({id: 7, url: 'https://example.test/current'});await newJob
    expect(update).toHaveBeenCalledOnce();expect(update).toHaveBeenCalledWith(7, {active: true});expect(h.button()?.props.disabled).toBe(false);expect(h.statusNode()).toBeUndefined()
  })
  it('pageshow 尊重 document 仍隐藏，不能盲目恢复返回动作', async () => {
    const h = await mount();h.setVisibility('hidden');h.pageEvent('pagehide');h.pageEvent('pageshow');await settle()
    expect(h.button()?.props.disabled).toBe(true);await h.click();expect(get).not.toHaveBeenCalled()
    h.setVisibility('visible');await settle();await h.click();expect(update).toHaveBeenCalledOnce();expect(update).toHaveBeenCalledWith(7, {active: true})
  })
  it('卸载从 setup 捕获的 document/window 配对移除监听，迟到 get 和旧页面事件均无效', async () => {
    const h = await mount()
    const documentListener = h.documentAdd.mock.calls.filter(([type]) => type === 'visibilitychange')
    const hideListener = h.windowAdd.mock.calls.filter(([type]) => type === 'pagehide')
    const showListener = h.windowAdd.mock.calls.filter(([type]) => type === 'pageshow')
    expect(documentListener).toHaveLength(1);expect(hideListener).toHaveLength(1);expect(showListener).toHaveLength(1)
    let release!: (value: unknown) => void
    get.mockReturnValueOnce(new Promise(resolve => {release = resolve}));const job = h.click();await settle()
    // 清理必须使用捕获的 owner；全局对象在卸载前已更换。
    vi.stubGlobal('document', new PageEventTarget());vi.stubGlobal('window', new PageEventTarget());h.stop()
    expect(h.documentRemove.mock.calls.filter(([type]) => type === 'visibilitychange')).toEqual(documentListener)
    expect(h.windowRemove.mock.calls.filter(([type]) => type === 'pagehide')).toEqual(hideListener)
    expect(h.windowRemove.mock.calls.filter(([type]) => type === 'pageshow')).toEqual(showListener)
    h.setVisibility('hidden');h.setVisibility('visible');h.pageEvent('pagehide');h.pageEvent('pageshow')
    release({id: 7, url: 'https://example.test/late'});await job
    expect(get).toHaveBeenCalledOnce();expect(update).not.toHaveBeenCalled()
  })
})

/**
 * @file tests/uiI18nAuditHarness.ts
 * 文件职责：为语言归属审计加载实际 i18n、Selector 和 SettingsSections 客户端模板。
 * 主要内容：使用真实 Vue/KeepAlive、共享 i18n 保存函数及父 props，配置端口保留同步乐观订阅、revision、字段比较和失败权威回读。
 * 模块边界：只替换存储传输、资源加载和无关设置组件；不启动浏览器或监听 TCP，不模拟操作系统焦点，每次显式清理 app/context 和模块端口。
 */
import * as runtime from 'vue'
import {parseHTML} from 'linkedom'
import {vi} from 'vitest'
import type {UiLanguage} from '@/src/core/i18n/language'
import type {UiI18nContext} from '@/src/ui/i18n'

// 可选诊断仅记录夹具的等待阶段，帮助定位全量运行中的超时，不改变 Promise 或计时门槛。
export const languageHarnessPhases: Array<{phase: string; at: number; value?: unknown}> = []
function recordPhase(phase: string, value?: unknown) {
  if (process.env.FLUENTREAD_UI_LANGUAGE_TEST_DIAGNOSTICS === '1') languageHarnessPhases.push({phase, at: performance.now(), value})
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no})
  return {promise, resolve, reject}
}
export async function settle() {await runtime.nextTick();for (let i = 0; i < 8; i++) await Promise.resolve();await runtime.nextTick()}

export async function createLanguageHarness({parent = false, mount = true, ready = Promise.resolve()} = {}) {
  languageHarnessPhases.length = 0; recordPhase('create-start')
  const dom = parseHTML('<html><body><div id="app"></div></body></html>'), document = dom.document
  const frames = new Map<number, FrameRequestCallback>();let frame = 0, revision = 0
  const listeners = new Set<(config: Record<string, unknown>) => void>(), controls: import('vue').ComponentInternalInstance[] = []
  const requests: Array<{value: UiLanguage; expected: unknown; gate: ReturnType<typeof deferred<void>>}> = []
  const bundles = new Map<UiLanguage, ReturnType<typeof deferred<boolean>>>()
  const config: Record<string, unknown> = {uiLanguage: 'zh-CN', uiLanguageSetupCompleted: false}
  let stored = {...config}, app: import('vue').App | undefined, focused: Element | null = document.body
  const window = {location: {hash: '', search: '', protocol: 'chrome-extension:'}, navigator: {userAgent: ''},
    matchMedia: () => ({matches: false, onchange: null}), requestAnimationFrame: (fn: FrameRequestCallback) => {frames.set(++frame, fn);return frame},
    cancelAnimationFrame: (id: number) => frames.delete(id), addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window), dispatchEvent: dom.window.dispatchEvent.bind(dom.window)}
  Object.defineProperty(document, 'activeElement', {configurable: true, get: () => focused})
  for (const [name, value] of Object.entries({window, document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Event: dom.window.Event})) vi.stubGlobal(name, value)
  const emit = (next: Record<string, unknown>) => {Object.assign(config, next);for (const listener of listeners) listener({...config})}
  const patch = vi.fn(async (value: Record<string, unknown>, _sender?: unknown) => {
    // 父组件退出交接的全配置不属于本夹具的语言请求；不为它创建等待门。
    if (Object.keys(value).some(name => name !== 'uiLanguage' && name !== 'uiLanguageSetupCompleted')) return
    recordPhase('patch-await-ready'); await ready; recordPhase('patch-ready');
    const expected = config.uiLanguage, gate = deferred<void>(), requested = value.uiLanguage as UiLanguage
    requests.push({value: requested, expected, gate});emit(value)
    try {
      recordPhase('patch-await-gate', requested); await gate.promise; recordPhase('patch-gate-done', requested)
      if (stored.uiLanguage !== expected && stored.uiLanguage !== requested) throw new Error('配置字段已由其他页面更新')
      stored = {...stored, ...value};revision += 1
      if (config.uiLanguage !== stored.uiLanguage || config.uiLanguageSetupCompleted !== stored.uiLanguageSetupCompleted) emit(stored)
    } catch (error) {emit(stored);throw error}
  })
  const data = {config, configReady: ready, requestConfigPatch: patch, getConfigRevision: () => revision,
    subscribeConfig: (listener: (value: Record<string, unknown>) => void) => {listeners.add(listener);listener({...config});return () => listeners.delete(listener)},
    handoffPendingConfigPatches: vi.fn(async () => undefined), applyInterfaceTheme: vi.fn(),
    ensure: vi.fn((value: UiLanguage) => bundles.get(value)?.promise ?? Promise.resolve(true)),
    captureControl: (instance: import('vue').ComponentInternalInstance) => controls.push(instance),
    browser: {runtime: {sendMessage: vi.fn()}, tabs: {query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined)}}}
  vi.resetModules()
  const child={inheritAttrs:false,setup:(_:unknown,{attrs,slots}:any)=>()=>runtime.h('div',attrs,slots.default?.())}
  vi.doMock('@/src/services/config/store',()=>data)
  vi.doMock('@/src/platform/i18n/uiLanguageBundles',()=>({ensureUiLanguageBundle:data.ensure}))
  vi.doMock('@/src/ui/interfaceAppearance',()=>({applyInterfaceTheme:data.applyInterfaceTheme}))
  vi.doMock('webextension-polyfill',()=>({default:data.browser}))
  vi.doMock('element-plus',()=>({ElMessage:Object.assign(()=>{},{warning:()=>{}}),ElOption:{props:['value','label'],setup:(p:any,{slots}:any)=>()=>runtime.h('div',{'data-option':p.value},slots.default?.())}}))
  vi.doMock('@element-plus/icons-vue',()=>({ArrowRight:{render:()=>null},InfoFilled:{render:()=>null},Edit:{render:()=>null}}))
  vi.doMock('@/src/platform/browser/capabilities',()=>({browserCapabilities:{browser:'chrome'}}))
  vi.doMock('@/src/ui/components/UiSelect.vue',()=>({__esModule:true,default:{inheritAttrs:false,setup:(_:unknown,{attrs,slots}:any)=>{data.captureControl(runtime.getCurrentInstance()!);return()=>runtime.h('div',{...attrs,'data-language-control':'true'},slots.default?.())}}}))
  for(const path of [
    '@/src/ui/components/FeatureEnableCard.vue',
    '@/src/ui/components/GlossaryLibrarySelect.vue',
    '@/src/ui/components/CustomHotkeyInput.vue',
    '@/src/ui/components/ServiceIcon.vue',
    '@/src/features/settings/ui/FeatureServiceSettings.vue',
    '@/src/features/settings/ui/services/ServiceConfiguration.vue',
    '@/src/features/settings/ui/WritingSettings.vue',
    '@/src/features/settings/ui/InformationHighlightSettings.vue',
    '@/src/features/settings/ui/SelectionSettings.vue',
    '@/src/features/settings/ui/FloatingBallSettings.vue',
    '@/src/features/settings/ui/SiteAdaptationSettings.vue',
    '@/src/features/settings/ui/SitePreferencesSettings.vue',
    '@/src/features/settings/ui/SiteRulePreview.vue',
    '@/src/features/settings/ui/VideoLocalModelSettings.vue',
    '@/src/features/settings/ui/LocalTtsSettings.vue',
    '@/src/features/settings/ui/VideoSubtitleAppearanceSettings.vue',
    '@/src/features/settings/ui/InterfaceSettings.vue',
    '@/src/features/settings/ui/AreaTranslationSettings.vue',
    '@/src/features/settings/ui/InputTranslationSettings.vue',
    '@/src/features/settings/ui/ParagraphCopySettings.vue',
    '@/src/features/settings/ui/SectionTranslationSettings.vue',
    '@/src/features/settings/ui/ParagraphHandlingSettings.vue',
    '@/src/features/settings/ui/TranslationCacheSettings.vue',
    '@/src/features/settings/ui/ExcludedLanguageSettings.vue',
    '@/src/features/settings/ui/ExcludedTagSettings.vue',
    '@/src/features/settings/ui/ReadingAssistanceSettings.vue',
    '@/src/features/settings/ui/ConfigManagement.vue',
    '@/src/features/settings/ui/QuickTranslationProfiles.vue',
    '@/src/features/settings/ui/ContextMenuSettings.vue',
    '@/src/features/settings/ui/components/FieldHelp.vue',
    '@/src/features/settings/ui/components/SettingsGroup.vue',
    '@/src/features/settings/ui/components/SettingsItem.vue',
    '@/src/features/settings/ui/components/SettingsPanel.vue',
    '@/src/features/settings/ui/services/ServiceRepairReturn.vue',
    '@/src/features/settings/ui/services/RequestLimitFields.vue',
    '@/src/features/settings/ui/components/SettingsNumberInput.vue',
    '@/src/features/settings/ui/services/CompositeTranslationFields.vue',
    '@/src/features/settings/ui/components/SegmentedControl.vue',
    '@/src/features/settings/ui/services/CustomOpenAIProviderDialog.vue',
    '@/src/features/settings/ui/services/ServiceCatalog.vue'
  ])vi.doMock(path,()=>({__esModule:true,default:child}))
  vi.doMock('@/src/features/translation-center/public',()=>({TranslationCenter:child}))
  vi.doMock('@/src/features/glossary/public',()=>({GlossarySettings:child}))
  vi.doMock('@/src/features/image-translation/ui/public',()=>({ImageOcrSettings:child,MangaSettings:child}))
  vi.doMock('@/src/features/model-usage/public',()=>({ModelUsageDashboard:child}))
  vi.doMock('@/src/features/translation-stats/public',()=>({TranslationStatsDashboard:child}))
  let context!: UiI18nContext
  try {
    recordPhase('module-load'); const module = await import('@/src/ui/i18n'); recordPhase('module-loaded')
    context = module.createUiI18nContext(); recordPhase('context-created')
    const selector = mount ? (await import('@/src/ui/components/UiLanguageSelector.vue')).default : undefined
    const component = mount ? (parent ? (await import('@/src/features/settings/ui/SettingsSections.vue')).default : selector) : undefined
    const visible = runtime.ref(true), props = runtime.reactive({activeSection: 'settings-general'}), parentState: Record<string, any> = {}
    if (component) {
      const renderer = runtime.createRenderer({patchProp(element: any, name: string, _before: unknown, next: unknown) {
        if (/^on[A-Z]/u.test(name)) return
        if (name === 'class') {element.className = String(next ?? '');return}
        if (name === 'style' && typeof next === 'object' && next) {Object.assign(element.style, next);return}
        if (next === undefined || next === null || (next === false && !/^(?:aria-|data-)/u.test(name))) element.removeAttribute(name)
        else element.setAttribute(name, String(next))
      }, insert: (child: any, owner: any, anchor: any = null) => owner.insertBefore(child, anchor), remove: (child: any) => child.parentNode?.removeChild(child),
        createElement: tag => {const element = runtime.markRaw(document.createElement(tag));element.focus = () => {focused = element};return element},
        createText: value => document.createTextNode(value), createComment: value => document.createComment(value), setText: (node: any, value) => {node.nodeValue = value},
        setElementText: (element: any, value) => {element.textContent = value}, parentNode: (node: any) => node.parentNode, nextSibling: (node: any) => node.nextSibling,
        querySelector: value => document.querySelector(value), setScopeId: () => {}, cloneNode: (node: any) => node.cloneNode(true),
        insertStaticContent: (html, owner: any, anchor: any) => {const template = document.createElement('template');template.innerHTML = html;const first = template.content.firstChild!, last = template.content.lastChild!;owner.insertBefore(template.content, anchor);return [first,last]}})
      app = renderer.createApp({setup: () => () => runtime.h(runtime.KeepAlive, null, {default: () => visible.value
        ? runtime.h(component as runtime.Component, {...(parent ? props : {}), ref: (vm: any) => {if (vm) parentState.value = vm.$.setupState}})
        : runtime.h({render: () => null}, {key: 'cached'})})})
      app.provide(module.UI_I18N_KEY, context);app.provide(runtime.ssrContextKey, {modules: new Set<string>()});app.config.warnHandler = () => {}
      app.mount(document.getElementById('app')!);await settle()
    } else await settle()
    recordPhase('create-done'); const control = () => controls.at(-1)!, handles = () => ({...control().vnode.props})
    return {context, uiModule: module, props, visible, parentState, document, controls, requests, bundles, data,
      stored: () => stored.uiLanguage, foreign: (value: UiLanguage) => {stored = {...stored, uiLanguage: value};revision += 1;emit(stored)},
      control, handles, selector: () => control().parent!, open: async () => {handles().onVisibleChange?.(true);await settle()},
      change: (value: UiLanguage) => handles().onChange(value), pagehide: () => window.dispatchEvent(new dom.window.Event('pagehide')),
      unmount: () => {app?.unmount();app = undefined}, close: async () => {recordPhase('close-start');app?.unmount();context.dispose();await settle();recordPhase('close-done');vi.unstubAllGlobals()}}
  } catch (error) {app?.unmount();context?.dispose();vi.unstubAllGlobals();throw error}
}

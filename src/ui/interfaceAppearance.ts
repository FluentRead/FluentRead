/**
 * @file src/ui/interfaceAppearance.ts
 * 文件职责：把已经归一化的界面皮肤和字体配置应用到扩展页面根节点，为 Popup 和 Options 共享同一套界面切换入口，并持久化仅供 Popup 首帧防闪烁使用的非敏感外观提示。
 * 主要内容：按页面注册与释放所属根节点，字体异步准备绑定原目标和当前请求；切换保留旧字体直到就绪，按文件持有并清除自己注册的 FontFace，保留共享字体，公开下载和缓存状态。
 * 模块边界：本文件只负责扩展自身页面的 DOM 属性，不读取或保存配置，不影响网页内容脚本和宿主页面样式。
 */

import {
  getInterfaceFontOption,
  getInterfaceSkinOption,
  interfaceFontOptions,
  type InterfaceFont,
  type InterfaceSkin,
} from '@/src/core/config/interfaceAppearance'
import {readonly, shallowRef} from 'vue'
import {createInterfaceFontLoader, getCachedInterfaceFonts, type InterfaceFontLoadState} from '@/src/services/interfaceFonts'
import {getClearableInterfaceFontAssets, getInterfaceFontAssets, type InterfaceFontSourceId} from '@/src/core/config/interfaceFontAssets'

const fontLoadState = shallowRef<InterfaceFontLoadState>({font: 'system', status: 'system', loaded: 0, total: 0, persistent: true})
export const interfaceFontLoadState = readonly(fontLoadState)
const availableFonts = shallowRef<InterfaceFont[]>(['system'])
export const availableInterfaceFonts = readonly(availableFonts)
const cachedFonts = shallowRef<InterfaceFont[]>(['system'])
export const cachedInterfaceFonts = readonly(cachedFonts)
const installedFiles = new Map<string, FontFace>()
interface AppearanceRootRegistration {root: HTMLElement; released: boolean}
interface FontRequest {font: InterfaceFont; owner: AppearanceRootRegistration | null}
const requestedFonts = new WeakMap<HTMLElement, FontRequest>()
const openFontCache = async () => caches.open('fluentread-interface-fonts-v1')
let availabilityVersion = 0
const registeredAppearanceRoots = new Set<AppearanceRootRegistration>()
let activeInterfaceAppearanceRoot: AppearanceRootRegistration | null = null

/**
 * Options 页面通常把皮肤写到 document.documentElement；userscript 的完整设置页
 * 运行在 closed ShadowRoot 时，需要把同一份变量写到该 ShadowRoot 的 host。
 * 返回只释放本次注册的句柄，旧页面退出不会清除后来的页面。
 */
export function registerInterfaceAppearanceRoot(root: HTMLElement): () => void {
  const registration = {root, released: false}
  registeredAppearanceRoots.add(registration)
  activeInterfaceAppearanceRoot = registration
  return () => {
    if (registration.released) return
    registration.released = true
    registeredAppearanceRoots.delete(registration)
    if (requestedFonts.get(root)?.owner === registration) requestedFonts.delete(root)
    if (activeInterfaceAppearanceRoot === registration) {
      activeInterfaceAppearanceRoot = null
      for (const remaining of registeredAppearanceRoots) activeInterfaceAppearanceRoot = remaining
    }
  }
}

function resolveInterfaceAppearanceRoot(): HTMLElement | null {
  return activeInterfaceAppearanceRoot?.root || (typeof document !== 'undefined' ? document.documentElement : null)
}

function requestFont(target: HTMLElement, font: InterfaceFont): FontRequest {
  let owner: AppearanceRootRegistration | null = null
  for (const registration of registeredAppearanceRoots) if (registration.root === target) owner = registration
  const request = {font, owner}
  requestedFonts.set(target, request)
  return request
}

function isCurrentFontRequest(target: HTMLElement, request: FontRequest): boolean {
  return requestedFonts.get(target) === request && !request.owner?.released
}

function applyReadyFont(target: HTMLElement, request: FontRequest): void {
  if (!isCurrentFontRequest(target, request) || !getInterfaceFontAssets(request.font).every(asset => installedFiles.has(asset.file))) return
  const font = getInterfaceFontOption(request.font)
  target.dataset.interfaceFont = font.value
  target.style.setProperty('--interface-font-family', font.fontFamily)
  target.style.setProperty('--el-font-family', font.fontFamily)
}

function loadRequestedFont(target: HTMLElement, request: FontRequest, source?: InterfaceFontSourceId, retry = false): void {
  applyReadyFont(target, request)
  void fontLoader.load(request.font, source, retry).then(() => applyReadyFont(target, request)).catch(() => {})
}

function removeInstalledFontFiles(font: InterfaceFont): void {
  const installed = interfaceFontOptions
    .filter(option => getInterfaceFontAssets(option.value).every(asset => installedFiles.has(asset.file)))
    .map(option => option.value)
  for (const asset of getClearableInterfaceFontAssets(font, installed)) {
    const face = installedFiles.get(asset.file)
    if (face) document.fonts.delete(face)
    installedFiles.delete(asset.file)
  }
}

export async function refreshInterfaceFontAvailability(): Promise<void> {
  const version = ++availabilityVersion
  const cached = await getCachedInterfaceFonts(openFontCache)
  if (version !== availabilityVersion) return
  cachedFonts.value = cached
  const installed = interfaceFontOptions.filter(font => getInterfaceFontAssets(font.value)
    .every(asset => installedFiles.has(asset.file))).map(font => font.value)
  availableFonts.value = [...new Set([...installed, ...cached])]
}

const fontLoader = createInterfaceFontLoader({
  fetch: (...args) => fetch(...args),
  openCache: openFontCache,
  digest: data => crypto.subtle.digest('SHA-256', data),
  install: async (asset, data) => {
    const face = new FontFace(asset.family, data, {weight: asset.weight, style: 'normal', display: 'swap'})
    await face.load()
    document.fonts.add(face)
    installedFiles.set(asset.file, face)
    availableFonts.value = [...new Set([...availableFonts.value, ...interfaceFontOptions
      .filter(font => getInterfaceFontAssets(font.value).every(item => installedFiles.has(item.file)))
      .map(font => font.value)])]
  },
  onState: state => {
    fontLoadState.value = state
    if (state.status !== 'loading') void refreshInterfaceFontAvailability()
  },
})

export async function clearInterfaceFont(font: InterfaceFont): Promise<void> {
  let cleared = false
  try {
    await fontLoader.clearFont(font)
    cleared = true
  } finally {
    if (cleared) removeInstalledFontFiles(font)
    await refreshInterfaceFontAvailability()
  }
}

export function retryInterfaceFont(source?: InterfaceFontSourceId): void {
  const target = resolveInterfaceAppearanceRoot()
  if (!target) return
  const font = requestedFonts.get(target)?.font || fontLoadState.value.font
  loadRequestedFont(target, requestFont(target, font), source, true)
}

export function applyInterfaceSkin(value: unknown, root?: HTMLElement | null): InterfaceSkin {
  const skin = getInterfaceSkinOption(value)
  const target = root || resolveInterfaceAppearanceRoot()
  if (target) {
    target.dataset.interfaceSkin = skin.value
    target.dataset.interfaceSkinKind = skin.kind
    target.style.setProperty('--interface-popup-width', `${skin.popupWidth}px`)
  }
  return skin.value
}

export function applyInterfaceFont(value: unknown, root?: HTMLElement | null): InterfaceFont {
  const font = getInterfaceFontOption(value)
  const target = root || resolveInterfaceAppearanceRoot()
  if (target) loadRequestedFont(target, requestFont(target, font.value))
  return font.value
}

/** 扩展专属页面在挂载前调用；只等待本地缓存，未下载字体仍在后台按需获取。 */
export async function prepareInterfaceFont(value: unknown, root?: HTMLElement | null): Promise<void> {
  const font = getInterfaceFontOption(value)
  const target = root || resolveInterfaceAppearanceRoot()
  if (!target) return
  const request = requestFont(target, font.value)
  await fontLoader.loadCached(font.value)
  if (isCurrentFontRequest(target, request)) loadRequestedFont(target, request)
}

export const POPUP_STARTUP_APPEARANCE_KEY = 'fluentread:popup-startup-appearance'

export function applyInterfaceTheme(dark: boolean, root?: HTMLElement | null): void {
  const target = root || resolveInterfaceAppearanceRoot()
  target?.classList.toggle('dark', dark)
}

/** 仅缓存 Popup 首帧外观提示（皮肤、宽度、明暗模式与画布色），不包含任何业务配置或敏感数据。 */
export function persistPopupStartupAppearance(skinValue: unknown, themeValue: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return
    const skin = getInterfaceSkinOption(skinValue)
    const theme = themeValue === 'dark' || themeValue === 'light' ? themeValue : 'auto'
    localStorage.setItem(POPUP_STARTUP_APPEARANCE_KEY, JSON.stringify({
      skin: skin.value,
      skinKind: skin.kind,
      width: skin.popupWidth,
      theme,
      bgLight: skin.preview.light.canvas,
      bgDark: skin.preview.dark.canvas,
      darkOnly: skin.toneMode === 'dark',
    }))
  } catch {
    // 本地存储受限时跳过启动外观提示，真实配置仍会在挂载前同步。
  }
}

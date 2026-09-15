/**
 * @file src/services/interfaceFonts.ts
 * 文件职责：在扩展自有页面按需下载、验证并缓存已选择的界面字体。
 * 主要内容：有界流式下载、固定 SHA-256 校验、备用源重试、离线缓存、按字体清理共享资源安全的缓存和切换取消。
 * 模块边界：不读取业务配置或凭据，不注入宿主网页；DOM 字体注册由调用方提供。
 */
import {interfaceFontOptions, type InterfaceFont} from '@/src/core/config/interfaceAppearance'
import {
  getInterfaceFontAssets, getInterfaceFontUrl, interfaceFontSources,
  type InterfaceFontAsset, type InterfaceFontSourceId,
} from '@/src/core/config/interfaceFontAssets'

export interface InterfaceFontLoadState {
  font: InterfaceFont
  status: 'system' | 'loading' | 'ready' | 'error'
  loaded: number
  total: number
  source?: InterfaceFontSourceId
  persistent: boolean
}
interface Dependencies {
  fetch: typeof fetch
  openCache: () => Promise<Cache>
  digest: (data: ArrayBuffer) => Promise<ArrayBuffer>
  install: (asset: InterfaceFontAsset, data: ArrayBuffer) => Promise<void>
  onState: (state: InterfaceFontLoadState) => void
  timeoutMs?: number
}
const cacheKey = (asset: InterfaceFontAsset) => `https://fluentread.app/__interface_fonts__/${asset.sha256}`
const aborted = () => new DOMException('Font selection changed', 'AbortError')

/** Only inspect cache keys; never download fonts to populate the picker. */
export async function getCachedInterfaceFonts(openCache: () => Promise<Cache>): Promise<InterfaceFont[]> {
  try {
    const keys = new Set((await (await openCache()).keys()).map(request => request.url))
    return interfaceFontOptions.filter(font => getInterfaceFontAssets(font.value)
      .every(asset => keys.has(cacheKey(asset)))).map(font => font.value)
  } catch {
    return ['system']
  }
}

export async function verifyInterfaceFont(asset: InterfaceFontAsset, data: ArrayBuffer, digest: Dependencies['digest']): Promise<void> {
  if (data.byteLength !== asset.bytes) throw new Error('Font size mismatch')
  const hash = Array.from(new Uint8Array(await digest(data)), byte => byte.toString(16).padStart(2, '0')).join('')
  if (hash !== asset.sha256) throw new Error('Font integrity mismatch')
}

export function createInterfaceFontLoader(deps: Dependencies) {
  let active: {font: InterfaceFont; controller: AbortController; promise: Promise<void>} | undefined
  const installed = new Map<string, boolean>()
  let clearing: Promise<void> | undefined
  let lastState: InterfaceFontLoadState | undefined

  async function download(asset: InterfaceFontAsset, signal: AbortSignal, preferred: InterfaceFontSourceId | undefined,
    progress: (loaded: number, source: InterfaceFontSourceId) => void): Promise<ArrayBuffer> {
    const sources = [...interfaceFontSources].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
    for (const source of sources) {
      if (signal.aborted) throw aborted()
      const controller = new AbortController()
      const cancel = () => controller.abort()
      signal.addEventListener('abort', cancel, {once: true})
      const timer = setTimeout(cancel, deps.timeoutMs ?? 25000)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        progress(0, source.id)
        const response = await deps.fetch(getInterfaceFontUrl(source.id, asset.file), {
          signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        })
        if (!response.ok || !response.body) throw new Error('Font source unavailable')
        const length = response.headers.get('content-length')
        if (length && Number(length) > asset.bytes) throw new Error('Font response too large')
        reader = response.body.getReader()
        const data = new Uint8Array(asset.bytes)
        let offset = 0
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (offset + chunk.value.byteLength > asset.bytes) throw new Error('Font response too large')
          data.set(chunk.value, offset)
          offset += chunk.value.byteLength
          progress(offset, source.id)
        }
        if (offset !== asset.bytes) throw new Error('Incomplete font response')
        await verifyInterfaceFont(asset, data.buffer, deps.digest)
        if (signal.aborted || controller.signal.aborted) throw aborted()
        return data.buffer
      } catch {
        if (signal.aborted) throw aborted()
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        await reader?.cancel().catch(() => {})
        controller.abort()
      }
    }
    throw new Error('All font sources unavailable')
  }

  async function run(font: InterfaceFont, signal: AbortSignal, preferred?: InterfaceFontSourceId) {
    const assets = getInterfaceFontAssets(font)
    const state: InterfaceFontLoadState = {
      font, status: assets.length ? 'loading' : 'system', loaded: 0,
      total: assets.reduce((sum, asset) => sum + asset.bytes, 0), persistent: true,
    }
    const publish = () => { if (!signal.aborted) { lastState = {...state}; deps.onState(lastState) } }
    publish()
    if (!assets.length) return
    try {
      const cache = await deps.openCache().catch(() => undefined)
      for (const asset of assets) {
        if (signal.aborted) throw aborted()
        if (installed.has(asset.file)) {
          state.persistent &&= installed.get(asset.file)!
          state.loaded += asset.bytes
          publish()
          continue
        }
        let data: ArrayBuffer | undefined
        let persisted = false
        try {
          const response = await cache?.match(cacheKey(asset))
          if (response) {
            data = await response.arrayBuffer()
            await verifyInterfaceFont(asset, data, deps.digest)
            persisted = true
          }
        } catch {
          data = undefined
          await cache?.delete(cacheKey(asset)).catch(() => {})
        }
        if (signal.aborted) throw aborted()
        const complete = state.loaded
        if (!data) {
          data = await download(asset, signal, preferred, (loaded, source) => {
            state.loaded = complete + loaded
            state.source = source
            publish()
          })
          if (signal.aborted) throw aborted()
          if (cache) {
            persisted = await cache.put(cacheKey(asset), new Response(data, {
              headers: {'Content-Type': 'font/woff2'},
            })).then(() => true, () => false)
          }
        }
        if (signal.aborted) throw aborted()
        await deps.install(asset, data)
        installed.set(asset.file, persisted)
        state.loaded = complete + asset.bytes
        state.persistent &&= persisted
        publish()
      }
      state.status = 'ready'
      publish()
    } catch {
      state.status = 'error'
      publish()
    }
  }

  return {
    load(font: InterfaceFont, preferred?: InterfaceFontSourceId, retry = false): Promise<void> {
      if (active?.font === font && !retry) return active.promise
      active?.controller.abort()
      const controller = new AbortController()
      const promise = Promise.resolve(clearing).catch(() => {}).then(() => run(font, controller.signal, preferred))
      active = {font, controller, promise}
      return promise
    },
    clearFont(font: InterfaceFont): Promise<void> {
      if (font === 'system') return Promise.resolve()
      if (clearing) return clearing
      // 先等待当前下载完成，避免清除后迟到的写入又把同一字体放回缓存。
      const pending = active?.promise
      clearing = (async () => {
        await pending
        const cache = await deps.openCache()
        const keys = new Set((await cache.keys()).map(request => request.url))
        const protectedFiles = new Set(
          interfaceFontOptions
            .filter(option => option.value !== 'system' && option.value !== font)
            .filter(option => getInterfaceFontAssets(option.value).every(asset => keys.has(cacheKey(asset))))
            .flatMap(option => getInterfaceFontAssets(option.value).map(asset => asset.file)),
        )
        for (const asset of getInterfaceFontAssets(font)) {
          if (protectedFiles.has(asset.file)) continue
          await cache.delete(cacheKey(asset))
          installed.delete(asset.file)
        }
        if (lastState?.font === font && lastState.status === 'ready') {
          lastState = {...lastState, persistent: false}
          deps.onState(lastState)
        }
      })().finally(() => { clearing = undefined })
      return clearing
    },
  }
}

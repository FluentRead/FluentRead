/**
 * @file src/services/interfaceFonts.ts
 * 文件职责：在扩展自有页面按需下载、验证并缓存已选择的界面字体。
 * 主要内容：有界流式下载与校验、备用源重试、去重首屏缓存和字体注册；按字体排队清除共享资源，等待此前仍在写入的任务，切换取消不阻塞于失效的网络或流清理，取消未读和迟到响应，正常 EOF 只释放读取锁。
 * 模块边界：不读取业务配置或凭据，不注入宿主网页；DOM 字体注册由调用方提供。
 */
import {cancelResponseReader, cancelUnreadResponseBody} from '@/src/platform/http/runtime'
import {interfaceFontOptions, type InterfaceFont} from '@/src/core/config/interfaceAppearance'
import {
  getClearableInterfaceFontAssets, getInterfaceFontAssets, getInterfaceFontUrl, interfaceFontSources,
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
  const installing = new Map<string, Promise<void>>()
  const cachedLoads = new Map<InterfaceFont, Promise<boolean>>()
  const pendingTasks = new Set<Promise<unknown>>()
  const pendingClears = new Map<InterfaceFont, Promise<void>>()
  let clearing: Promise<void> | undefined
  let lastState: InterfaceFontLoadState | undefined

  function track<T>(promise: Promise<T>): Promise<T> {
    pendingTasks.add(promise)
    void promise.then(() => pendingTasks.delete(promise), () => pendingTasks.delete(promise))
    return promise
  }

  function install(asset: InterfaceFontAsset, data: ArrayBuffer, persistent: boolean): Promise<void> {
    if (installed.has(asset.file)) return Promise.resolve()
    const existing = installing.get(asset.file)
    if (existing) return existing
    const promise = Promise.resolve().then(() => deps.install(asset, data))
      .then(() => {installed.set(asset.file, persistent)})
      .finally(() => {installing.delete(asset.file)})
    installing.set(asset.file, promise)
    return promise
  }

  async function download(asset: InterfaceFontAsset, signal: AbortSignal, preferred: InterfaceFontSourceId | undefined,
    progress: (loaded: number, source: InterfaceFontSourceId) => void): Promise<ArrayBuffer> {
    const sources = [...interfaceFontSources].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
    for (const source of sources) {
      if (signal.aborted) throw aborted()
      const controller = new AbortController()
      let rejectInterrupted!: (reason: DOMException) => void
      const interrupted = new Promise<never>((_resolve, reject) => {rejectInterrupted = reject})
      const cancel = () => {controller.abort();rejectInterrupted(aborted())}
      // fetch、流读取或摘要端口即使忽略取消，也不能让选择和备用源无限等待。
      const step = <T>(operation: () => Promise<T>): Promise<T> => Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw aborted()
        return operation()
      }), interrupted])
      signal.addEventListener('abort', cancel, {once: true})
      const timer = setTimeout(cancel, deps.timeoutMs ?? 25000)
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      let response: Response | undefined
      let finished = false
      try {
        progress(0, source.id)
        const downloaded = await step<Response>(() => deps.fetch(getInterfaceFontUrl(source.id, asset.file), {
          signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        }).then(value => {
          if (controller.signal.aborted) {cancelUnreadResponseBody(value); throw aborted()}
          return value
        }))
        response = downloaded
        if (!downloaded.ok || !downloaded.body) throw new Error('Font source unavailable')
        const length = downloaded.headers.get('content-length')
        if (length && Number(length) > asset.bytes) throw new Error('Font response too large')
        reader = downloaded.body.getReader()
        const data = new Uint8Array(asset.bytes)
        let offset = 0
        while (true) {
          const chunk = await step(() => reader!.read())
          if (chunk.done) {finished = true; break}
          if (offset + chunk.value.byteLength > asset.bytes) throw new Error('Font response too large')
          data.set(chunk.value, offset)
          offset += chunk.value.byteLength
          progress(offset, source.id)
        }
        if (offset !== asset.bytes) throw new Error('Incomplete font response')
        await step(() => verifyInterfaceFont(asset, data.buffer, deps.digest))
        return data.buffer
      } catch {
        if (signal.aborted) throw aborted()
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', cancel)
        if (reader) {
          if (finished) reader.releaseLock()
          else cancelResponseReader(reader)
        } else if (response) cancelUnreadResponseBody(response)
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
        await install(asset, data, persisted)
        state.loaded = complete + asset.bytes
        state.persistent &&= installed.get(asset.file)!
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
    /** 新页面首屏前注册已下载字体；缺失或损坏时立即返回，不等待网络下载。 */
    loadCached(font: InterfaceFont): Promise<boolean> {
      const existing = cachedLoads.get(font)
      if (existing) return existing
      const promise = Promise.resolve(clearing).catch(() => {}).then(async () => {
        const assets = getInterfaceFontAssets(font).filter(asset => !installed.has(asset.file))
        if (!assets.length) return true
        try {
          const cache = await deps.openCache()
          const verified = await Promise.all(assets.map(async asset => {
            const response = await cache.match(cacheKey(asset))
            if (!response) return null
            const data = await response.arrayBuffer()
            await verifyInterfaceFont(asset, data, deps.digest)
            return {asset, data}
          }))
          if (verified.some(item => item === null)) return false
          await Promise.all(verified.map(item => install(item!.asset, item!.data, true)))
          return true
        } catch {
          return false
        }
      }).finally(() => {if (cachedLoads.get(font) === promise) cachedLoads.delete(font)})
      cachedLoads.set(font, promise)
      return track(promise)
    },
    load(font: InterfaceFont, preferred?: InterfaceFontSourceId, retry = false): Promise<void> {
      if (active?.font === font && !retry) return active.promise
      active?.controller.abort()
      const controller = new AbortController()
      const promise = Promise.allSettled([clearing, ...cachedLoads.values()]).then(() => run(font, controller.signal, preferred))
      active = {font, controller, promise}
      return track(promise)
    },
    clearFont(font: InterfaceFont): Promise<void> {
      if (font === 'system') return Promise.resolve()
      const existing = pendingClears.get(font)
      if (existing) return existing
      // 捕获此前所有任务，包括已被新选择替换、但仍在写缓存的旧下载。
      const pending = [...pendingTasks, clearing]
      if (active?.font === font) active = undefined
      cachedLoads.delete(font)
      const promise = (async () => {
        await Promise.allSettled(pending)
        const cache = await deps.openCache()
        const keys = new Set((await cache.keys()).map(request => request.url))
        const cachedFonts = interfaceFontOptions
          .filter(option => getInterfaceFontAssets(option.value).every(asset => keys.has(cacheKey(asset))))
          .map(option => option.value)
        for (const asset of getClearableInterfaceFontAssets(font, cachedFonts)) {
          await cache.delete(cacheKey(asset))
          installed.delete(asset.file)
        }
        if (lastState?.font === font && lastState.status === 'ready') {
          lastState = {...lastState, persistent: false}
          deps.onState(lastState)
        }
      })().finally(() => {
        pendingClears.delete(font)
        if (clearing === promise) clearing = undefined
      })
      pendingClears.set(font, promise)
      clearing = promise
      return promise
    },
  }
}

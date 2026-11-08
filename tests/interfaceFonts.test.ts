import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash, webcrypto} from 'node:crypto'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {interfaceFontOptions} from '@/src/core/config/interfaceAppearance'
import {getClearableInterfaceFontAssets, getInterfaceFontAssets, getInterfaceFontUrl, interfaceFontSources, INTERFACE_FONT_REVISION, type InterfaceFontAsset} from '@/src/core/config/interfaceFontAssets'
import {createInterfaceFontLoader, getCachedInterfaceFonts, verifyInterfaceFont, type InterfaceFontLoadState} from '@/src/services/interfaceFonts'
import {UI_LANGUAGE_BUNDLES} from '@/src/core/i18n/bundles'
import {zhCNMessages} from '@/src/core/i18n/messages/zh-CN'
import previewManifest from '../assets/interface-font-previews/manifest.json'

const digest = (data: ArrayBuffer) => webcrypto.subtle.digest('SHA-256', data)
const bytes = (file: string) => Uint8Array.from(readFileSync(resolve(__dirname, '../assets/interface-fonts', file))).buffer
const previewCatalogs: Record<string, Readonly<Record<string, string>>> = {'zh-CN': zhCNMessages,
  ...Object.fromEntries(Object.entries(UI_LANGUAGE_BUNDLES).map(([language, bundle]) => [language, bundle.messages]))}
function harness() {
  const entries = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (key: string) => entries.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => { entries.set(key, response.clone()) }),
    delete: vi.fn(async (key: string | Request) => entries.delete(typeof key === 'string' ? key : key.url)),
    keys: vi.fn(async () => [...entries.keys()].map(key => new Request(key))),
  }
  const states: InterfaceFontLoadState[] = []
  const deps = {
    fetch: vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => new Response(bytes(String(url).split('/').at(-1)!))),
    openCache: vi.fn(async () => cache as unknown as Cache),
    digest,
    install: vi.fn(async (_asset: InterfaceFontAsset, _data: ArrayBuffer) => {}),
    onState: (state: InterfaceFontLoadState) => {states.push(state)},
    timeoutMs: 1000,
  }
  return {deps, cache, entries, states, loader: createInterfaceFontLoader(deps)}
}
afterEach(() => vi.useRealTimers())

describe('按需字体资源契约', () => {
  it('只读取缓存键展示下载状态；共享中文未齐全时不把英文字体标成已下载', async () => {
    const cache = {keys: vi.fn(async () => getInterfaceFontAssets('inter').map(asset => new Request(`https://fluentread.app/__interface_fonts__/${asset.sha256}`)))}
    const open = vi.fn(async () => cache as unknown as Cache)
    expect(await getCachedInterfaceFonts(open)).toEqual(['system', 'inter', 'noto-sans-sc'])
    cache.keys.mockResolvedValueOnce([new Request(`https://fluentread.app/__interface_fonts__/${getInterfaceFontAssets('inter')[0].sha256}`)])
    expect(await getCachedInterfaceFonts(open)).toEqual(['system'])
    expect(await getCachedInterfaceFonts(async () => { throw new Error('unavailable') })).toEqual(['system'])
  })

  it('十套方案只加载必需资源，四个入口固定到不可变提交且没有路径注入', async () => {
    expect(interfaceFontOptions).toHaveLength(10)
    expect(getInterfaceFontAssets('system')).toEqual([])
    expect(getInterfaceFontAssets('inter').map(asset => asset.file)).toEqual(['Inter.woff2', 'NotoSansSC.woff2'])
    expect(getInterfaceFontAssets('noto-serif-sc')).toHaveLength(1)
    expect(getInterfaceFontAssets('lxgw-wenkai')).toHaveLength(2)
    expect(interfaceFontSources.filter(source => source.region === 'china')).toHaveLength(2)
    expect(interfaceFontSources.filter(source => source.region === 'global')).toHaveLength(2)
    for (const source of interfaceFontSources) {
      expect(getInterfaceFontUrl(source.id, 'Inter.woff2')).toContain(INTERFACE_FONT_REVISION)
      expect(getInterfaceFontUrl(source.id, '../test?x')).toMatch(/\.\.\%2Ftest%3Fx$/)
    }
    const assets = new Map(interfaceFontOptions.flatMap(font => getInterfaceFontAssets(font.value)).map(asset => [asset.file, asset]))
    expect(assets.size).toBe(10)
    for (const asset of assets.values()) await verifyInterfaceFont(asset, bytes(asset.file), digest)
  })

  it('拒绝大小或摘要错误的数据，完整字体不随包附带或由预览提前请求', async () => {
    const asset = getInterfaceFontAssets('manrope')[0]
    await expect(verifyInterfaceFont(asset, new ArrayBuffer(1), digest)).rejects.toThrow('size')
    await expect(verifyInterfaceFont(asset, new ArrayBuffer(asset.bytes), digest)).rejects.toThrow('integrity')
    const css = readFileSync(resolve(__dirname, '../src/ui/styles/interface-font.css'), 'utf8')
    expect(css).not.toContain('@font-face')
    expect(css).not.toContain('url(')
    expect(css).toContain('system-ui')
  })

  it('内置预览覆盖所有语言的当前卡片文案，避免文案更新后静默缺字', () => {
    const keys = [...interfaceFontOptions.flatMap(font => [font.labelKey, font.descriptionKey]),
      'settings.interface.font.preview'].sort()
    const texts = Object.fromEntries(Object.entries(previewCatalogs).sort(([a], [b]) => a.localeCompare(b))
      .map(([language, catalog]) => [language, keys.map(key => catalog[key]).join('\n') + '\nAa Bb Cc · 0123456789']))
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
    expect(previewManifest.languages.toSorted()).toEqual(Object.keys(previewCatalogs).toSorted())
    expect(previewManifest.corpusSha256).toBe(sha256(JSON.stringify(texts)))
    for (const [language, text] of Object.entries(texts)) {
      expect(previewManifest.corpus[language as keyof typeof previewManifest.corpus].sha256).toBe(sha256(text))
    }
  })

  it('按卡片与字重精准保留字形，共享中文只补齐主字体缺字', () => {
    const codepoints = (text: string) => new Set([...text]
      .filter(character => character === ' ' || !/\s/u.test(character)).map(character => character.codePointAt(0)!))
    const labels = (points: Iterable<number>) => [...points].sort((a, b) => a - b)
      .map(point => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`)
    const decoded = (range: readonly string[]) => new Set(range.map(label => Number.parseInt(label.slice(2), 16)))
    const options = interfaceFontOptions.filter(option => option.value !== 'system')
    const faceFor = (option: string, weight: number) => previewManifest.fonts
      .find(face => face.option === option && face.weight === weight)!
    const rolePoints = (option: typeof options[number], catalog: Readonly<Record<string, string>>, weight: number) =>
      codepoints(weight === 700 ? catalog[option.labelKey]
        : `${catalog[option.descriptionKey]}\n${catalog['settings.interface.font.preview']}\nAa Bb Cc · 0123456789`)
    for (const face of previewManifest.fonts) {
      const option = options.find(option => option.value === face.option)!
      const sourcePoints = decoded(face.sourceCorpusUnicodeRange)
      const renderedPoints = decoded(face.unicodeRange)
      const requestedPoints = new Set<number>()
      for (const [language, catalog] of Object.entries(previewCatalogs)) {
        const points = rolePoints(option, catalog, face.weight)
        if (option.value === 'noto-sans-sc') {
          for (const other of options.filter(other => other.value !== option.value)) {
            const primarySourcePoints = decoded(faceFor(other.value, face.weight).sourceCorpusUnicodeRange)
            for (const point of rolePoints(other, catalog, face.weight)) {
              if (!primarySourcePoints.has(point)) points.add(point)
            }
          }
        }
        for (const point of points) requestedPoints.add(point)
        expect(face.missingByLanguage[language as keyof typeof face.missingByLanguage])
          .toEqual(labels([...points].filter(point => !renderedPoints.has(point))))
      }
      expect(face.requestedUnicodeRange).toEqual(labels(requestedPoints))
      expect(face.unicodeRange).toEqual(labels([...requestedPoints].filter(point => sourcePoints.has(point))))
    }
  })

  it('预览只分发独立命名的小型字库，400/700 文件与完整字体缓存分离', () => {
    const css = readFileSync(resolve(__dirname, '../src/features/settings/ui/interface-font-previews.css'), 'utf8')
    expect(previewManifest.fonts).toHaveLength((interfaceFontOptions.length - 1) * 2)
    expect(previewManifest.totalFontBytes).toBeLessThan(256 * 1024)
    expect(css).not.toMatch(/https?:/u)
    for (const font of previewManifest.fonts) {
      const data = readFileSync(resolve(__dirname, '../assets/interface-font-previews', font.asset))
      expect(data.subarray(0, 4).toString()).toBe('wOF2')
      expect(data.byteLength).toBe(font.bytes)
      expect(createHash('sha256').update(data).digest('hex')).toBe(font.sha256)
      expect(font.family).toMatch(/^FluentRead Preview /u)
      expect(css).toContain(font.asset)
      const fullAssets = getInterfaceFontAssets(font.option as typeof interfaceFontOptions[number]['value'])
      expect(fullAssets.every(asset => asset.sha256 !== font.sha256 && asset.family !== font.cssFamily)).toBe(true)
      expect(fullAssets.find(asset => asset.file === font.sourceAsset)?.sha256).toBe(font.sourceAssetSha256)
    }
  })
})

describe('字体下载、缓存和切换生命周期', () => {
  it('默认系统方案不打开缓存、不下载、不注册字体；重复配置不重复启动', async () => {
    const h = harness()
    const first = h.loader.load('system')
    expect(h.loader.load('system')).toBe(first)
    await first
    expect(h.states.at(-1)?.status).toBe('system')
    expect(h.deps.fetch).not.toHaveBeenCalled()
    expect(h.deps.openCache).not.toHaveBeenCalled()
    expect(h.deps.install).not.toHaveBeenCalled()
  })

  it('选择才下载，省略凭据；共享中文缓存、相同页面不重复注册、重开离线可用', async () => {
    const h = harness()
    await h.loader.load('manrope')
    expect(h.states.at(-1)).toMatchObject({font: 'manrope', status: 'ready', persistent: true})
    expect(h.deps.fetch).toHaveBeenCalledTimes(2)
    expect(h.deps.fetch.mock.calls[0][1]).toMatchObject({credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store'})
    expect(h.deps.install).toHaveBeenCalledTimes(2)
    await h.loader.load('system')
    await h.loader.load('manrope')
    expect(h.deps.fetch).toHaveBeenCalledTimes(2)
    expect(h.deps.install).toHaveBeenCalledTimes(2)
    await h.loader.load('inter')
    expect(h.deps.fetch).toHaveBeenCalledTimes(3)
    const reopened = createInterfaceFontLoader(h.deps)
    h.deps.fetch.mockRejectedValue(new Error('offline'))
    await reopened.load('inter')
    expect(h.states.at(-1)).toMatchObject({status: 'ready', persistent: true})
    expect(h.deps.fetch).toHaveBeenCalledTimes(3)
  })

  it.each(['http', 'empty', 'length', 'oversized', 'truncated', 'digest'] as const)('从 %s 错误自动切换备用源，不缓存错误数据', async failure => {
    const h = harness()
    const asset = getInterfaceFontAssets('noto-sans-sc')[0]
    const bad = failure === 'http' ? new Response('unavailable', {status: 503})
      : failure === 'empty' ? new Response(null)
        : failure === 'length' ? new Response('x', {headers: {'Content-Length': String(asset.bytes + 1)}})
          : failure === 'oversized' ? new Response(new Uint8Array(asset.bytes + 1))
            : failure === 'truncated' ? new Response('x')
              : new Response(new Uint8Array(asset.bytes))
    const cancel = bad.body ? vi.spyOn(bad.body, 'cancel') : undefined
    h.deps.fetch.mockResolvedValueOnce(bad)
    await h.loader.load('noto-sans-sc', 'github')
    expect(h.deps.fetch.mock.calls[0][0]).toContain('raw.githubusercontent.com')
    expect(h.deps.fetch.mock.calls[1][0]).toContain('cdn.jsdmirror.com')
    expect(bad.body?.locked ?? false).toBe(false)
    if (failure === 'http' || failure === 'length') expect(cancel).toHaveBeenCalledOnce()
    expect(h.deps.fetch).toHaveBeenCalledTimes(2)
    expect(h.cache.put).toHaveBeenCalledTimes(1)
    expect(h.states.at(-1)?.status).toBe('ready')
  })

  it('四源失败保留错误状态；显式重试可以恢复', async () => {
    const h = harness()
    h.deps.fetch.mockRejectedValue(new Error('unavailable'))
    await h.loader.load('noto-sans-sc')
    expect(h.deps.fetch).toHaveBeenCalledTimes(4)
    expect(h.states.at(-1)?.status).toBe('error')
    expect(h.deps.install).not.toHaveBeenCalled()
    h.deps.fetch.mockImplementation(async url => new Response(bytes(String(url).split('/').at(-1)!)))
    await h.loader.load('noto-sans-sc', 'jsdelivr', true)
    expect(h.deps.fetch.mock.calls.at(-1)?.[0]).toContain('cdn.jsdelivr.net')
    expect(h.states.at(-1)?.status).toBe('ready')
  })

  it('缓存损坏会删除并重新下载，而不是把坏数据传入字体解析器', async () => {
    const h = harness()
    h.cache.match.mockResolvedValueOnce(new Response('corrupt'))
    await h.loader.load('noto-sans-sc')
    expect(h.cache.delete).toHaveBeenCalledOnce()
    expect(h.deps.fetch).toHaveBeenCalledOnce()
    expect(h.states.at(-1)?.status).toBe('ready')
  })

  it.each(['open', 'put'])('缓存 %s 不可用时仍能启用，并明确标为仅本次页面可用', async failure => {
    const h = harness()
    if (failure === 'open') h.deps.openCache.mockRejectedValue(new Error('disabled'))
    else h.cache.put.mockRejectedValue(new Error('quota'))
    await h.loader.load('noto-sans-sc')
    expect(h.states.at(-1)).toMatchObject({status: 'ready', persistent: false})
    await h.loader.load('system')
    await h.loader.load('noto-sans-sc')
    expect(h.states.at(-1)).toMatchObject({status: 'ready', persistent: false})
  })

  it('切回系统字体取消旧请求，迟到的响应不注册字体、不覆盖当前状态', async () => {
    const h = harness()
    let release!: (response: Response) => void
    h.deps.fetch.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const previous = h.loader.load('noto-sans-sc')
    await vi.waitFor(() => expect(h.deps.fetch).toHaveBeenCalledOnce())
    const signal = h.deps.fetch.mock.calls[0][1]?.signal
    await h.loader.load('system')
    expect(signal?.aborted).toBe(true)
    const lateBody = new ReadableStream<Uint8Array>()
    const cancel = vi.spyOn(lateBody, 'cancel')
    release(new Response(lateBody))
    await previous
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(h.states.at(-1)?.status).toBe('system')
    expect(h.deps.install).not.toHaveBeenCalled()
    expect(h.cache.put).not.toHaveBeenCalled()
  })

  it('阻塞的下载超时后切换下一个源', async () => {
    const h = harness()
    h.deps.fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {once: true})
    }))
    await h.loader.load('noto-sans-sc')
    expect(h.deps.fetch).toHaveBeenCalledTimes(2)
    expect(h.states.at(-1)?.status).toBe('ready')
  })

  it('字体解析失败明确报告，不显示下载成功', async () => {
    const h = harness()
    h.deps.install.mockRejectedValue(new Error('decode'))
    await h.loader.load('noto-sans-sc')
    expect(h.states.at(-1)?.status).toBe('error')
  })

  it.each(['open', 'match', 'put'])('在缓存 %s 期间切换，不让旧字体继续注册或写回状态', async stage => {
    const h = harness()
    if (stage === 'open') h.deps.openCache.mockImplementationOnce(async () => {
      await h.loader.load('system')
      return h.cache as unknown as Cache
    })
    if (stage === 'match') h.cache.match.mockImplementationOnce(async () => {
      await h.loader.load('system')
      return undefined
    })
    if (stage === 'put') h.cache.put.mockImplementationOnce(async () => { await h.loader.load('system') })
    await h.loader.load('noto-sans-sc')
    expect(h.states.at(-1)?.status).toBe('system')
    expect(h.deps.install).not.toHaveBeenCalled()
  })

  it.each(['valid', 'oversized'])('在 %s 流清理期间切换，不继续缓存或重试旧选择', async kind => {
    const h = harness()
    const data = new Uint8Array(bytes('NotoSansSC.woff2'))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {controller.enqueue(kind === 'valid' ? data : new Uint8Array(data.length + 1)); controller.close()},
    })
    const response = new Response(body)
    const reader = body.getReader()
    const releaseLock = reader.releaseLock.bind(reader)
    vi.spyOn(reader, 'releaseLock').mockImplementation(() => {releaseLock(); void h.loader.load('system')})
    vi.spyOn(body, 'getReader').mockReturnValue(reader)
    h.deps.fetch.mockResolvedValueOnce(response)
    await h.loader.load('noto-sans-sc')
    expect(h.states.at(-1)?.status).toBe('system')
    expect(h.deps.fetch).toHaveBeenCalledOnce()
    expect(h.cache.put).not.toHaveBeenCalled()
    expect(h.deps.install).not.toHaveBeenCalled()
  })

  it('使用默认超时时间也能完成下载', async () => {
    const h = harness()
    await createInterfaceFontLoader({...h.deps, timeoutMs: undefined}).load('noto-sans-sc')
    expect(h.states.at(-1)?.status).toBe('ready')
  })
})


describe('字体缓存维护', () => {
  it('首屏前离线注册完整缓存，随后正常加载不再次下载或注册字体', async () => {
    const h = harness()
    await h.loader.load('inter')
    const reopened = createInterfaceFontLoader(h.deps)
    h.deps.fetch.mockClear()
    h.deps.install.mockClear()
    expect(await reopened.loadCached('inter')).toBe(true)
    expect(h.deps.install).toHaveBeenCalledTimes(2)
    await reopened.load('inter')
    expect(h.deps.fetch).not.toHaveBeenCalled()
    expect(h.deps.install).toHaveBeenCalledTimes(2)
  })

  it('缺失、损坏或不可访问的缓存不会阻塞首屏去等待网络或注册不完整方案', async () => {
    for (const failure of ['missing', 'corrupt', 'unavailable'] as const) {
      const h = harness()
      if (failure === 'corrupt') h.entries.set('https://fluentread.app/__interface_fonts__/' + getInterfaceFontAssets('inter')[0].sha256, new Response('corrupt'))
      if (failure === 'unavailable') h.deps.openCache.mockRejectedValue(new Error('disabled'))
      expect(await h.loader.loadCached('inter')).toBe(false)
      expect(h.deps.fetch).not.toHaveBeenCalled()
      expect(h.deps.install).not.toHaveBeenCalled()
    }
    const h = harness()
    expect(await h.loader.loadCached('system')).toBe(true)
    expect(h.deps.openCache).not.toHaveBeenCalled()
  })

  it('可释放容量与实际清除一致，排除其他方案仍使用的中文文件', async () => {
    const h = harness()
    await h.loader.load('inter')
    const cached = await getCachedInterfaceFonts(h.deps.openCache)
    const clearable = getClearableInterfaceFontAssets('inter', cached)
    expect(clearable.map(asset => asset.file)).toEqual(['Inter.woff2'])
    expect(getClearableInterfaceFontAssets('noto-sans-sc', cached)).toEqual([])
    expect(getClearableInterfaceFontAssets('system', cached)).toEqual([])
    await h.loader.clearFont('inter')
    expect(await getCachedInterfaceFonts(h.deps.openCache)).toEqual(['system', 'noto-sans-sc'])
    expect(clearable[0].bytes).toBe(bytes('Inter.woff2').byteLength)
  })

  it('等待正在写入的下载完成后再清除该字体，期间的新选择在清除后执行', async () => {
    const h = harness()
    let release!: () => void
    h.cache.put.mockImplementationOnce(async (key, response) => {
      await new Promise<void>(resolve => { release = resolve })
      h.entries.set(key, response.clone())
    })
    const download = h.loader.load('noto-sans-sc')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const clear = h.loader.clearFont('noto-sans-sc')
    expect(h.loader.clearFont('noto-sans-sc')).toBe(clear)
    const select = h.loader.load('system')
    release()
    await Promise.all([download, clear, select])
    // 迟到的下载写入不能在清除后把同一字体放回缓存。
    expect(h.entries.size).toBe(0)
    expect(h.states.at(-1)?.status).toBe('system')
  })

  it('清除失败释放清理锁，重试成功且不阻塞后续字体选择', async () => {
    const h = harness()
    await h.loader.load('inter')
    h.cache.delete.mockRejectedValueOnce(new Error('delete denied'))
    await expect(h.loader.clearFont('inter')).rejects.toThrow('delete denied')
    await h.loader.clearFont('inter')
    expect(h.entries.has('https://fluentread.app/__interface_fonts__/' + getInterfaceFontAssets('inter')[0].sha256)).toBe(false)
    expect(h.states.at(-1)).toMatchObject({font: 'inter', status: 'ready', persistent: false})
    h.deps.openCache.mockRejectedValueOnce(new Error('cache denied'))
    const clear = h.loader.clearFont('inter')
    const select = h.loader.load('roboto')
    await expect(clear).rejects.toThrow('cache denied')
    await select
    expect(h.states.at(-1)).toMatchObject({font: 'roboto', status: 'ready'})
  })

  it('可以只清除指定字体，并保留其他字体共享的中文资源', async () => {
    const h = harness()
    await h.loader.load('inter')
    await h.loader.clearFont('inter')
    expect(h.entries.has('https://fluentread.app/__interface_fonts__/' + getInterfaceFontAssets('inter')[0].sha256)).toBe(false)
    expect(h.entries.has('https://fluentread.app/__interface_fonts__/' + getInterfaceFontAssets('noto-sans-sc')[0].sha256)).toBe(true)

    await h.loader.load('system')
    await h.loader.load('inter')
    expect(h.deps.fetch).toHaveBeenCalledTimes(3)
    expect(h.states.at(-1)).toMatchObject({font: 'inter', status: 'ready', persistent: true})
  })

  it('清除系统字体不访问缓存，并发清除同一字体复用同一个清理任务', async () => {
    const h = harness()
    await h.loader.clearFont('system')
    expect(h.deps.openCache).not.toHaveBeenCalled()
    await h.loader.load('inter')
    const clear = h.loader.clearFont('inter')
    expect(h.loader.clearFont('inter')).toBe(clear)
    await clear
    expect(h.states.at(-1)).toMatchObject({font: 'inter', status: 'ready', persistent: false})
  })
})

describe('字体任务队列和不可协作端口', () => {
  it('不同字体的并发清除分别执行，共享资源在前一方案移除后才释放', async () => {
    const h = harness();await h.loader.load('inter')
    const latin = h.loader.clearFont('inter');const chinese = h.loader.clearFont('noto-sans-sc')
    expect(chinese).not.toBe(latin)
    await Promise.all([latin, chinese]);expect(h.entries.size).toBe(0)
    expect(h.cache.delete).toHaveBeenCalledTimes(2)
  })
  it('旧下载在不可取消的缓存写入中被替换，清除仍等待它，迟到写入不能复活缓存', async () => {
    const h = harness();let release!: () => void
    h.cache.put.mockImplementationOnce(async (key, response) => {
      await new Promise<void>(resolve => {release = resolve});h.entries.set(key, response.clone())
    })
    const old = h.loader.load('noto-sans-sc');await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await h.loader.load('system');let completed = false
    const clear = h.loader.clearFont('noto-sans-sc').then(() => {completed = true})
    await Promise.resolve();await Promise.resolve();expect(completed).toBe(false)
    release();await Promise.all([old, clear]);expect(h.entries.size).toBe(0)
  })
  it('首屏缓存注册和清除有顺序，清除后同一字体的重新选择可以重新下载', async () => {
    const h = harness();await h.loader.load('noto-sans-sc');const reopened = createInterfaceFontLoader(h.deps)
    let release!: () => void;h.deps.install.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve}))
    const warm = reopened.loadCached('noto-sans-sc');await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    let cleared = false;const clear = reopened.clearFont('noto-sans-sc').then(() => {cleared = true})
    await Promise.resolve();await Promise.resolve();expect(cleared).toBe(false)
    release();await Promise.all([warm, clear]);expect(h.entries.size).toBe(0)
    h.deps.fetch.mockClear();await reopened.load('noto-sans-sc');expect(h.deps.fetch).toHaveBeenCalledOnce()
  })
  it('100 次相同首屏准备只读取、校验与注册每个文件一次', async () => {
    const h = harness();await h.loader.load('inter');const reopened = createInterfaceFontLoader(h.deps)
    h.cache.match.mockClear();h.deps.install.mockClear()
    const jobs = Array.from({length: 100}, () => reopened.loadCached('inter'))
    expect(jobs.every(promise => promise === jobs[0])).toBe(true)
    expect((await Promise.all(jobs)).every(Boolean)).toBe(true)
    expect(h.cache.match).toHaveBeenCalledTimes(2);expect(h.deps.install).toHaveBeenCalledTimes(2)
  })
  it('缓存准备期间正常选择不重复注册，重叠方案共享一条字体注册任务', async () => {
    const h = harness();await h.loader.load('inter');const reopened = createInterfaceFontLoader(h.deps)
    h.deps.install.mockClear();let release!: () => void
    h.deps.install.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve}))
    const warm = reopened.loadCached('inter');await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const selected = reopened.load('inter');release();await Promise.all([warm, selected])
    expect(h.deps.install).toHaveBeenCalledTimes(2)
    h.deps.install.mockClear();await reopened.clearFont('inter')
    await reopened.load('inter');expect(h.states.at(-1)).toMatchObject({status: 'ready'})
    expect(h.deps.install).toHaveBeenCalledOnce()
  })
  it('清除当前方案后不复用已经完成但内容已删除的加载任务', async () => {
    const h = harness();const first = h.loader.load('noto-sans-sc');await first
    await h.loader.clearFont('noto-sans-sc');h.deps.fetch.mockClear()
    const next = h.loader.load('noto-sans-sc');expect(next).not.toBe(first);await next
    expect(h.deps.fetch).toHaveBeenCalledOnce();expect(h.states.at(-1)).toMatchObject({persistent: true})
  })
  it('首个清理失败不吞掉队尾请求，同字体锁与加载屏障均释放', async () => {
    const h = harness();await h.loader.load('inter');h.deps.openCache.mockRejectedValueOnce(new Error('blocked'))
    const failed = h.loader.clearFont('inter');const next = h.loader.clearFont('inter')
    expect(next).toBe(failed);const tail = h.loader.clearFont('noto-sans-sc')
    await expect(failed).rejects.toThrow('blocked');await tail
    await h.loader.clearFont('inter');await h.loader.clearFont('noto-sans-sc');expect(h.entries.size).toBe(0)
    await h.loader.load('system');expect(h.states.at(-1)?.status).toBe('system')
  })
  it.each(['fetch', 'read', 'digest'] as const)('%s 不响应 AbortSignal 也在有界超时内切换备用源', async stage => {
    vi.useFakeTimers();const h = harness();const asset = getInterfaceFontAssets('noto-sans-sc')[0]
    let release!: (value: any) => void
    const stalled = new Promise<any>(resolve => {release = resolve});let entered = false
    const block = () => {entered = true;return stalled}
    if (stage === 'fetch') h.deps.fetch.mockImplementationOnce(block)
    if (stage === 'read') {
      const response = new Response('placeholder')
      vi.spyOn(response, 'body', 'get').mockReturnValue({getReader: () => ({read: block,
        cancel: () => Promise.resolve()})} as unknown as NonNullable<Response['body']>)
      h.deps.fetch.mockResolvedValueOnce(response)
    }
    if (stage === 'digest') h.deps.digest = vi.fn().mockImplementationOnce(block).mockImplementation(digest)
    // digest 的 mock 在 loader 创建后设置时，需要用当前端口重新装配。
    const loader = createInterfaceFontLoader(h.deps)
    const job = loader.load('noto-sans-sc')
    await vi.waitFor(() => expect(entered).toBe(true))
    await vi.advanceTimersByTimeAsync(1050)
    try {expect(h.deps.fetch).toHaveBeenCalledTimes(2)
    } finally {
      release(stage === 'fetch' ? new Response(bytes(asset.file)) : stage === 'read' ? {done: true} : await digest(bytes(asset.file)))
      await job
    }
    expect(h.states.at(-1)?.status).toBe('ready');expect(vi.getTimerCount()).toBe(0)
  })
  it('超限流 cancel 不返回时也释放锁并完成备用源和下一次选择', async () => {
    const h = harness();const asset = getInterfaceFontAssets('noto-sans-sc')[0]
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(asset.bytes + 1))}, cancel})
    h.deps.fetch.mockResolvedValueOnce(new Response(body))
    await h.loader.load('noto-sans-sc')
    expect(cancel).toHaveBeenCalledOnce();expect(body.locked).toBe(false)
    expect(h.states.at(-1)?.status).toBe('ready');expect(h.deps.fetch).toHaveBeenCalledTimes(2)
    await h.loader.load('system');expect(h.states.at(-1)?.status).toBe('system')
  })
  it('同时准备共享中文的两套缓存只调用一次中文解析注册', async () => {
    const h = harness();await h.loader.load('inter');const reopened = createInterfaceFontLoader(h.deps)
    let release!: () => void;h.deps.install.mockClear();h.deps.install.mockImplementation(async asset => {
      if (asset.file === 'NotoSansSC.woff2') await new Promise<void>(resolve => {release = resolve})
    })
    const latin = reopened.loadCached('inter');const chinese = reopened.loadCached('noto-sans-sc')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await vi.waitFor(() => expect(h.deps.install).toHaveBeenCalledTimes(2))
    release();expect(await latin).toBe(true);expect(await chinese).toBe(true)
    expect(h.deps.install.mock.calls.filter(([asset]) => asset.file === 'NotoSansSC.woff2')).toHaveLength(1)
  })
  it('读取开始后共享字体先由另一方案注册，迟到的完整缓存准备不会再次注册', async () => {
    const h = harness();await h.loader.load('inter');const reopened = createInterfaceFontLoader(h.deps)
    const original = h.cache.match.getMockImplementation()!;let release!: () => void
    h.cache.match.mockImplementationOnce(async key => {await new Promise<void>(resolve => {release = resolve});return original(key)})
    h.deps.install.mockClear();const latin = reopened.loadCached('inter')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));expect(await reopened.loadCached('noto-sans-sc')).toBe(true)
    release();expect(await latin).toBe(true);expect(h.deps.install).toHaveBeenCalledTimes(2)
  })
  it('清除排队后新首屏准备等待删除，不复用之前正在注册的缓存任务', async () => {
    const h = harness();await h.loader.load('noto-sans-sc');const reopened = createInterfaceFontLoader(h.deps)
    let release!: () => void;h.deps.install.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve}))
    const old = reopened.loadCached('noto-sans-sc');await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const clear = reopened.clearFont('noto-sans-sc');const current = reopened.loadCached('noto-sans-sc')
    expect(current).not.toBe(old);release();await Promise.all([old, clear]);expect(await current).toBe(false)
    expect(h.entries.size).toBe(0)
  })
  it.each(['throw', 'reject'])('超限流清理 %s 不阻塞备用源或产生未处理拒绝', async kind => {
    const h = harness();const asset = getInterfaceFontAssets('noto-sans-sc')[0]
    const body = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(asset.bytes + 1))}})
    const response = new Response(body)
    const reader = body.getReader()
    vi.spyOn(reader, 'cancel').mockImplementation(() => {
      if (kind === 'throw') throw new Error('cancel failed')
      return Promise.reject(new Error('cancel denied'))
    })
    vi.spyOn(body, 'getReader').mockReturnValue(reader)
    h.deps.fetch.mockResolvedValueOnce(response);await h.loader.load('noto-sans-sc')
    expect(reader.cancel).toHaveBeenCalledOnce();expect(body.locked).toBe(false)
    expect(h.states.at(-1)?.status).toBe('ready');expect(h.deps.fetch).toHaveBeenCalledTimes(2)
  })
  it('状态端口拒绝导致的失败任务从队列释放，后续清除和首屏缓存准备仍可恢复', async () => {
    const h = harness();let rejectState = true
    h.deps.onState = () => {if (rejectState) throw new Error('view disposed')}
    const loader = createInterfaceFontLoader(h.deps);await expect(loader.load('system')).rejects.toThrow('view disposed')
    rejectState = false;await loader.clearFont('inter');expect(await loader.loadCached('system')).toBe(true)
    h.deps.openCache.mockRejectedValueOnce(new Error('clear denied'))
    const failed = loader.clearFont('inter');const cached = loader.loadCached('system')
    await expect(failed).rejects.toThrow('clear denied');expect(await cached).toBe(true)
  })
})

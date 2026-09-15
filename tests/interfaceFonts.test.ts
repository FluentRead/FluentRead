import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {webcrypto} from 'node:crypto'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {interfaceFontOptions} from '@/src/core/config/interfaceAppearance'
import {getInterfaceFontAssets, getInterfaceFontUrl, interfaceFontSources, INTERFACE_FONT_REVISION} from '@/src/core/config/interfaceFontAssets'
import {createInterfaceFontLoader, getCachedInterfaceFonts, verifyInterfaceFont, type InterfaceFontLoadState} from '@/src/services/interfaceFonts'

const digest = (data: ArrayBuffer) => webcrypto.subtle.digest('SHA-256', data)
const bytes = (file: string) => Uint8Array.from(readFileSync(resolve(__dirname, '../assets/interface-fonts', file))).buffer
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
    install: vi.fn(async () => {}),
    onState: (state: InterfaceFontLoadState) => states.push(state),
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

  it('拒绝大小或摘要错误的数据，字体不再随包附带或由预览提前请求', async () => {
    const asset = getInterfaceFontAssets('manrope')[0]
    await expect(verifyInterfaceFont(asset, new ArrayBuffer(1), digest)).rejects.toThrow('size')
    await expect(verifyInterfaceFont(asset, new ArrayBuffer(asset.bytes), digest)).rejects.toThrow('integrity')
    const css = readFileSync(resolve(__dirname, '../src/ui/styles/interface-font.css'), 'utf8')
    expect(css).not.toContain('@font-face')
    expect(css).not.toContain('url(')
    expect(css).toContain('system-ui')
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
    const bad = failure === 'http' ? new Response(null, {status: 503})
      : failure === 'empty' ? new Response(null)
        : failure === 'length' ? new Response('x', {headers: {'Content-Length': String(asset.bytes + 1)}})
          : failure === 'oversized' ? new Response(new Uint8Array(asset.bytes + 1))
            : failure === 'truncated' ? new Response('x')
              : new Response(new Uint8Array(asset.bytes))
    h.deps.fetch.mockResolvedValueOnce(bad)
    await h.loader.load('noto-sans-sc', 'github')
    expect(h.deps.fetch.mock.calls[0][0]).toContain('raw.githubusercontent.com')
    expect(h.deps.fetch.mock.calls[1][0]).toContain('cdn.jsdmirror.com')
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
    release(new Response(bytes('NotoSansSC.woff2')))
    await previous
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
    const response = new Response('placeholder')
    const reader = {
      read: vi.fn().mockResolvedValueOnce({done: false, value: kind === 'valid' ? data : new Uint8Array(data.length + 1)})
        .mockResolvedValue({done: true}),
      cancel: vi.fn(async () => { await h.loader.load('system') }),
    }
    vi.spyOn(response, 'body', 'get').mockReturnValue({getReader: () => reader} as unknown as ReadableStream<Uint8Array>)
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

  it('清除系统字体不访问缓存，并发清除复用同一个清理任务', async () => {
    const h = harness()
    await h.loader.clearFont('system')
    expect(h.deps.openCache).not.toHaveBeenCalled()
    await h.loader.load('inter')
    const clear = h.loader.clearFont('inter')
    expect(h.loader.clearFont('noto-sans-sc')).toBe(clear)
    await clear
    expect(h.states.at(-1)).toMatchObject({font: 'inter', status: 'ready', persistent: false})
  })
})

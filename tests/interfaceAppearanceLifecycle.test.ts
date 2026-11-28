import {parseHTML} from 'linkedom'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {getInterfaceFontAssets} from '@/src/core/config/interfaceFontAssets'
import type {InterfaceFontLoadState} from '@/src/services/interfaceFonts'

const ports = vi.hoisted(() => ({load: vi.fn(), loadCached: vi.fn(), clearFont: vi.fn(), getCached: vi.fn(), deps: undefined as any}))
vi.mock('@/src/services/interfaceFonts', () => ({
  createInterfaceFontLoader: (deps: unknown) => {ports.deps = deps;return ports},
  getCachedInterfaceFonts: (open: unknown) => ports.getCached(open),
}))
let appearance: typeof import('@/src/ui/interfaceAppearance')
let doc: Document
const releases: Array<() => void> = []
function root(): HTMLElement {return doc.createElement('main')}
function deferred<T>() {let resolve!: (value: T) => void;let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no});return {promise, resolve, reject}}
function register(target: HTMLElement): () => void {
  // 固定旧源码对照使用其实际 set/null 接口；不以新增 register API 缺失作为产品失败。
  const modern = Reflect.get(appearance, 'registerInterfaceAppearanceRoot') as ((root: HTMLElement) => () => void) | undefined
  const legacy = Reflect.get(appearance, 'setInterfaceAppearanceRoot') as (root: HTMLElement | null) => void
  const release = modern ? modern(target) : (legacy(target), () => legacy(null))
  releases.push(release);return release
}
async function settle() {for (let index = 0; index < 8; index++) await Promise.resolve()}
async function install(font: Parameters<typeof getInterfaceFontAssets>[0]) {
  for (const asset of getInterfaceFontAssets(font)) await ports.deps.install(asset, new ArrayBuffer(1))
}
function state(font: InterfaceFontLoadState['font'], status: InterfaceFontLoadState['status']) {
  ports.deps.onState({font, status, loaded: 1, total: 1, persistent: true})
}
beforeEach(async () => {
  vi.resetModules();vi.clearAllMocks();ports.load.mockResolvedValue(undefined);ports.loadCached.mockResolvedValue(true)
  ports.clearFont.mockResolvedValue(undefined);ports.getCached.mockResolvedValue(['system'])
  doc = parseHTML('<html><head></head><body></body></html>').document as unknown as Document
  const faces = new Set<FontFace>()
  Object.defineProperty(doc, 'fonts', {value: {add: vi.fn((face: FontFace) => faces.add(face)),
    delete: vi.fn((face: FontFace) => faces.delete(face)), has: (face: FontFace) => faces.has(face), get size() {return faces.size}}})
  vi.stubGlobal('document', doc);vi.stubGlobal('caches', {open: vi.fn(async () => ({}))})
  vi.stubGlobal('FontFace', class {constructor(..._args: unknown[]) {}async load() {return this}})
  appearance = await import('@/src/ui/interfaceAppearance')
})
afterEach(() => {for (const release of releases.splice(0)) release();vi.unstubAllGlobals()})

describe('界面根节点和字体异步归属', () => {
  it('明确设置一个根的字体时不把其他已注册根当成其所有者', async () => {
    const a=root(),b=root();register(a);register(b);
    appearance.applyInterfaceFont('system',a);await settle();
    expect(a.dataset.interfaceFont).toBe('system');expect(b.dataset.interfaceFont).toBeUndefined();
    appearance.applyInterfaceSkin('brutalist');expect(b.dataset.interfaceSkin).toBe('brutalist');
  })
  it('旧页面释放自己的注册，不能清除新页面根节点；重复释放幂等', () => {
    const a = root(), b = root();const old = register(a);register(b);old();old()
    appearance.applyInterfaceSkin('brutalist');appearance.applyInterfaceTheme(true)
    expect(b.dataset.interfaceSkin).toBe('brutalist');expect(b.classList.contains('dark')).toBe(true)
    expect(doc.documentElement.dataset.interfaceSkin).toBeUndefined()
  })
  it('最后页面释放后回到仍存在的上一页面，全部释放才使用文档根节点；旧皮肤回退默认', () => {
    const a = root(), b = root();const releaseA = register(a);const releaseB = register(b)
    releaseB();appearance.applyInterfaceSkin('cheese');expect(a.dataset.interfaceSkin).toBe('default')
    appearance.applyInterfaceSkin('shuimo');expect(a.dataset.interfaceSkin).toBe('default')
    appearance.applyInterfaceSkin('cyber');expect(a.dataset.interfaceSkin).toBe('cyber')
    releaseA();appearance.applyInterfaceSkin('unknown');expect(doc.documentElement.dataset.interfaceSkin).toBe('default')
  })
  it('同一 DOM 的新注册不被旧释放撤销，新的字体请求仍可以完成', async () => {
    const a = root();const old = register(a);register(a);appearance.applyInterfaceFont('inter');old()
    await install('inter');await settle();appearance.retryInterfaceFont();await settle()
    expect(a.dataset.interfaceFont).toBe('inter')
  })
  it('首屏等待缓存期间页面已更换，不能把旧配置写到新根或启动旧网络选择', async () => {
    const a = root(), b = root();const old = register(a);const cached = deferred<boolean>()
    ports.loadCached.mockReturnValueOnce(cached.promise);const pending = appearance.prepareInterfaceFont('inter')
    register(b);old();cached.resolve(true);await pending;await settle()
    expect(a.dataset.interfaceFont).toBeUndefined();expect(b.dataset.interfaceFont).toBeUndefined()
    expect(ports.load).not.toHaveBeenCalled()
  })
  it('首屏等待期间同页选择更新，旧准备不能覆盖后来选择的系统字体', async () => {
    const a = root();const cached = deferred<boolean>();ports.loadCached.mockReturnValueOnce(cached.promise)
    const pending = appearance.prepareInterfaceFont('inter', a);appearance.applyInterfaceFont('system', a)
    cached.resolve(true);await pending;expect(a.dataset.interfaceFont).toBe('system')
    expect(ports.load.mock.calls.map(([font]) => font)).toEqual(['system'])
  })
  it('明确传入的首屏目标在等待后保持原目标，不跟随后来注册的默认根', async () => {
    const a = root(), b = root();const pending = appearance.prepareInterfaceFont('system', a)
    register(b);await pending;await settle();expect(a.dataset.interfaceFont).toBe('system')
    expect(b.dataset.interfaceFont).toBeUndefined()
  })
  it('加载中保持旧字体，完整注册后才应用；旧请求完成不能覆盖新的选择', async () => {
    const a = root();appearance.applyInterfaceFont('system', a);const pending = deferred<void>()
    ports.load.mockReturnValueOnce(pending.promise);appearance.applyInterfaceFont('inter', a)
    expect(a.dataset.interfaceFont).toBe('system');await install('inter');state('inter', 'ready')
    pending.resolve();await settle();expect(a.dataset.interfaceFont).toBe('inter')
    const late = deferred<void>();ports.load.mockReturnValueOnce(late.promise);appearance.applyInterfaceFont('roboto', a)
    appearance.applyInterfaceFont('system', a);await install('roboto');state('roboto', 'ready');late.resolve();await settle()
    expect(a.dataset.interfaceFont).toBe('system')
  })
  it('页面释放后字体即使完成，也不能再设置已释放根节点', async () => {
    const a = root();const release = register(a);const pending = deferred<void>();ports.load.mockReturnValueOnce(pending.promise)
    appearance.applyInterfaceFont('inter');release();await install('inter');state('inter', 'ready');pending.resolve();await settle()
    expect(a.dataset.interfaceFont).toBeUndefined()
  })
  it('重试使用当前根请求的字体与来源，不重复调用加载，也不读取另一页面的全局字体', async () => {
    const a = root();register(a);appearance.applyInterfaceFont('inter');await settle();state('roboto', 'error')
    ports.load.mockClear();await install('inter');appearance.retryInterfaceFont('github');await settle()
    expect(ports.load).toHaveBeenCalledTimes(1);expect(ports.load).toHaveBeenCalledWith('inter', 'github', true)
    expect(a.dataset.interfaceFont).toBe('inter')
  })
  it('尚无字体请求时重试沿用下载状态，加载失败保持已有字体并处理 rejection', async () => {
    const a = root();register(a);state('inter', 'error')
    // 新加载接口的 rejection 保护单独验证；固定旧源码对照不伪造实际 loader 没有抛出的错误。
    if (Reflect.get(appearance, 'registerInterfaceAppearanceRoot')) ports.load.mockRejectedValueOnce(new Error('port failed'))
    appearance.retryInterfaceFont();await settle();expect(ports.load).toHaveBeenCalledWith('inter', undefined, true)
    expect(a.dataset.interfaceFont).toBeUndefined()
  })
  it('没有 DOM 时应用和准备不创建字体任务，纯归一化仍返回正确选项', async () => {
    vi.stubGlobal('document', undefined)
    expect(appearance.applyInterfaceFont(null)).toBe('system');expect(appearance.applyInterfaceSkin(null)).toBe('default')
    appearance.applyInterfaceTheme(false);await appearance.prepareInterfaceFont('inter');appearance.retryInterfaceFont()
    expect(ports.load).not.toHaveBeenCalled();expect(ports.loadCached).not.toHaveBeenCalled()
  })
  it('皮肤、主题、未知字体只作用于指定节点，默认字体立即可用', async () => {
    const a = root();appearance.applyInterfaceSkin('liquid-glass', a);appearance.applyInterfaceTheme(true, a)
    appearance.applyInterfaceTheme(false, a);appearance.applyInterfaceFont('invalid', a);await settle()
    expect(a.dataset.interfaceSkin).toBe('liquid-glass');expect(a.dataset.interfaceSkinKind).toBe('craft')
    expect(a.dataset.interfaceFont).toBe('system')
    expect(a.style.getPropertyValue('--interface-popup-width')).toBe('324px')
    expect(a.style.getPropertyValue('--interface-font-family')).toContain('system-ui');expect(a.classList.contains('dark')).toBe(false)
    expect(doc.documentElement.dataset.interfaceFont).toBeUndefined()
  })
})

describe('字体可用性和共享资源状态', () => {
  it('清除和再次注册不会积累旧 FontFace，只释放自己独占的字体并保留外部和共享字体', async () => {
    const foreign = {} as FontFace;doc.fonts.add(foreign);await install('inter');expect(doc.fonts.size).toBe(3)
    const latin = vi.mocked(doc.fonts.add).mock.calls[1][0];const chinese = vi.mocked(doc.fonts.add).mock.calls[2][0]
    await appearance.clearInterfaceFont('inter');expect(doc.fonts.size).toBe(2)
    expect(doc.fonts.has(foreign)).toBe(true);expect(doc.fonts.has(chinese)).toBe(true);expect(doc.fonts.has(latin)).toBe(false)
    await ports.deps.install(getInterfaceFontAssets('inter')[0], new ArrayBuffer(1));expect(doc.fonts.size).toBe(3)
    expect(doc.fonts.delete).toHaveBeenCalledTimes(1)
  })
  it('已缓存但本页面未注册的字体清除，不移除其他页面资源或外部字体', async () => {
    const foreign = {} as FontFace;doc.fonts.add(foreign);await install('inter')
    await appearance.clearInterfaceFont('roboto');expect(doc.fonts.size).toBe(3)
    expect(doc.fonts.delete).not.toHaveBeenCalled();expect(doc.fonts.has(foreign)).toBe(true)
  })
  it('迟到的缓存清单不会覆盖较新的可用列表，已注册字体也保留', async () => {
    const pending = deferred<string[]>();ports.getCached.mockReturnValueOnce(pending.promise)
    const old = appearance.refreshInterfaceFontAvailability();ports.getCached.mockResolvedValueOnce(['system', 'roboto', 'noto-sans-sc'])
    await appearance.refreshInterfaceFontAvailability();pending.resolve(['system', 'inter']);await old
    expect(appearance.cachedInterfaceFonts.value).toEqual(['system', 'roboto', 'noto-sans-sc'])
    await install('inter');expect(appearance.availableInterfaceFonts.value).toContain('inter')
    expect(doc.fonts.add).toHaveBeenCalledTimes(2)
    await ports.deps.openCache();expect(caches.open).toHaveBeenCalledWith('fluentread-interface-fonts-v1')
    const data = new ArrayBuffer(1);const spy = vi.spyOn(crypto.subtle, 'digest');await ports.deps.digest(data)
    expect(spy).toHaveBeenCalledWith('SHA-256', data);spy.mockRestore()
    const fetchPort = vi.fn(async () => new Response('ok'));vi.stubGlobal('fetch', fetchPort)
    await ports.deps.fetch('https://example.test/font');expect(fetchPort).toHaveBeenCalledOnce()
  })
  it('清除成功只撤销该方案独占的注册标记，共享中文与缓存状态保持一致', async () => {
    await install('inter');ports.getCached.mockResolvedValue(['system', 'noto-sans-sc'])
    await appearance.clearInterfaceFont('inter');expect(ports.clearFont).toHaveBeenCalledWith('inter')
    expect(appearance.availableInterfaceFonts.value).toEqual(['system', 'noto-sans-sc'])
    appearance.applyInterfaceFont('inter');await settle();expect(doc.documentElement.dataset.interfaceFont).toBeUndefined()
    await appearance.clearInterfaceFont('noto-sans-sc');expect(appearance.availableInterfaceFonts.value).not.toContain('inter')
  })
  it('清除失败仍刷新缓存展示，保留已注册字体而不是伪称删除成功', async () => {
    await install('inter');ports.clearFont.mockRejectedValueOnce(new Error('delete failed'))
    await expect(appearance.clearInterfaceFont('inter')).rejects.toThrow('delete failed')
    expect(appearance.availableInterfaceFonts.value).toContain('inter');expect(ports.getCached).toHaveBeenCalled()
  })
  it('下载状态变化被公开，loading 不额外扫描缓存，ready 与 error 刷新展示', async () => {
    state('inter', 'loading');expect(ports.getCached).not.toHaveBeenCalled()
    expect(appearance.interfaceFontLoadState.value.status).toBe('loading')
    state('inter', 'ready');state('inter', 'error');await settle();expect(ports.getCached).toHaveBeenCalledTimes(2)
    expect(appearance.interfaceFontLoadState.value.status).toBe('error')
  })
})

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
import {createReadingAppearanceActions, type ReadingAppearanceState} from '@/src/app/popup/readingAppearanceActions'

function setup(target = {tabId: 4 as number | null, url: 'https://example.com/article'}) {
  const state: ReadingAppearanceState = {font: 'original', remembered: false, busy: false, ready: false, error: ''}
  let active = true
  const getTab = vi.fn(async () => ({id: 4, url: 'https://example.com/article'}))
  const send = vi.fn(async (_id: number, message: {font?: string; remember?: boolean}) => ({
    status: 'success', font: message.font || 'original', remembered: message.remember === true, documentToken: 'document-1',
  }))
  const actions = createReadingAppearanceActions({state, active: () => active,
    target: () => target, getTab, send})
  return {state, getTab, send, actions, deactivate: () => {active = false}}
}
function deferred<T>() {let resolve!: (value: T) => void;const promise = new Promise<T>(r => {resolve = r});return {promise, resolve}}

describe('Popup 阅读外观页面归属与持久化意图', () => {
  it('先读取真值，预览只作用于页面；保存、清除必须显式携带 remember', async () => {
    const {actions, state, send} = setup()
    await actions.set('system')
    expect(send).not.toHaveBeenCalled()
    await actions.read()
    expect(state.ready).toBe(true)
    await actions.set('system')
    expect(send).toHaveBeenLastCalledWith(4, {type: 'setReadingAppearance', font: 'system', documentToken: 'document-1'})
    expect(state.font).toBe('system')
    await actions.set('system', true)
    expect(state.remembered).toBe(true)
    expect(send).toHaveBeenLastCalledWith(4, {type: 'setReadingAppearance', font: 'system', documentToken: 'document-1', remember: true})
    await actions.set('system', false)
    expect(state.remembered).toBe(false)
    expect(state.font).toBe('system')
    await actions.set('original')
    expect(state.font).toBe('original')
  })

  it('来源导航后禁止向新的网页写入，提供读取重试', async () => {
    const {actions, getTab, send, state} = setup()
    await actions.read()
    getTab.mockResolvedValue({id: 5, url: 'https://example.com/other'})
    await actions.set('system')
    expect(send).toHaveBeenCalledTimes(1)
    expect(state.ready).toBe(false)
    expect(state.error).not.toBe('')
    getTab.mockResolvedValue({id: 4, url: 'https://example.com/article'})
    await actions.read()
    expect(state.ready).toBe(true)
    expect(state.error).toBe('')
  })

  it('在途操作独占；关闭和重开后旧回复不覆盖新状态', async () => {
    const {actions, send, state} = setup()
    const pending = deferred<Awaited<ReturnType<typeof send>>>()
    send.mockReturnValueOnce(pending.promise)
    const reading = actions.read()
    await Promise.resolve()
    await actions.read()
    expect(send).toHaveBeenCalledTimes(1)
    actions.invalidate()
    await actions.read()
    pending.resolve({status: 'success', font: 'system', remembered: true, documentToken: 'stale'})
    await reading
    expect(state.font).toBe('original')
    expect(state.remembered).toBe(false)
    expect(state.busy).toBe(false)
  })

  it('等待标签页时失活，旧请求不再发送', async () => {
    const {actions, getTab, send, deactivate} = setup()
    const pending = deferred<Awaited<ReturnType<typeof getTab>>>()
    getTab.mockReturnValueOnce(pending.promise)
    const reading = actions.read()
    deactivate()
    pending.resolve({id: 4, url: 'https://example.com/article'})
    await reading
    await actions.read()
    expect(send).not.toHaveBeenCalled()
  })

  it('发送失败可重试，同 URL 新文档回包不能冒充原页面成功', async () => {
    const {actions, send, state} = setup()
    send.mockRejectedValueOnce(new Error('not connected'))
    await actions.read()
    expect(state.busy).toBe(false)
    expect(state.error).not.toBe('')
    await actions.read()
    send.mockResolvedValueOnce({status: 'success', font: 'system', remembered: false, documentToken: 'document-2'})
    await actions.set('system')
    expect(state.font).toBe('original')
    expect(state.error).not.toBe('')
    expect(state.ready).toBe(false)
    await actions.read()
    await actions.set('system')
    expect(state.font).toBe('system')
    expect(state.error).toBe('')
  })

  it('没有页面目标时拒绝读取', async () => {
    const {actions, send, state} = setup({tabId: null, url: ''})
    await actions.read()
    expect(send).not.toHaveBeenCalled()
    expect(state.error).not.toBe('')
  })

  it('同一标签的待导航地址也不能接收旧意图', async () => {
    const {actions, getTab, send, state} = setup()
    await actions.read()
    getTab.mockResolvedValue({id: 4, url: 'https://example.com/article', pendingUrl: 'https://example.com/new'} as Awaited<ReturnType<typeof getTab>>)
    await actions.set('system')
    expect(send).toHaveBeenCalledTimes(1)
    expect(state.ready).toBe(false)
  })

  it('没有可验证地址的标签页不发送页面消息', async () => {
    const {actions, getTab, send, state} = setup()
    getTab.mockResolvedValue({id: 4} as Awaited<ReturnType<typeof getTab>>)
    await actions.read()
    expect(send).not.toHaveBeenCalled()
    expect(state.error).not.toBe('')
  })

  it('过期请求失败不显示错误', async () => {
    const {actions, send, state} = setup()
    let reject!: (reason: unknown) => void
    send.mockReturnValueOnce(new Promise((_resolve, fail) => {reject = fail}))
    const reading = actions.read()
    await Promise.resolve()
    actions.invalidate()
    reject(new Error('old request'))
    await reading
    expect(state.error).toBe('')
  })

  it.each([undefined, {}, {status: 'success', font: 'invalid'}, {status: 'success', font: 'system', remembered: 'false'},
    {status: 'success', font: 'system', remembered: false}, {status: 'success', font: 'system', remembered: false, documentToken: ''}])('拒绝不完整状态 %j', async response => {
    const {actions, send, state} = setup()
    send.mockResolvedValueOnce(response as Awaited<ReturnType<typeof send>>)
    await actions.read()
    expect(state.ready).toBe(false)
    expect(state.error).not.toBe('')
  })
})


describe('Popup 阅读外观入口与操作文案', () => {
  it('独立阅读抽屉具有两个选择、明确保存和清除入口，不复用译文显示设置', () => {
    const source = readFileSync(resolve(__dirname, '../src/app/popup/PopupApp.vue'), 'utf8')
    expect(source).toContain('data-testid="reading-appearance-entry"')
    expect(source).toContain("activeDrawer === 'readingAppearance'")
    for (const key of ['original', 'system', 'save', 'forget', 'restore']) expect(source).toContain(`popup.readingAppearance.${key}`)
    expect(source).toContain('popup.readingAppearance.previewHint')
    expect(source).toContain("remember: bind(() => readingActions.set(readingAppearance.font, true))")
    expect(source).toContain("forget: bind(() => readingActions.set(readingAppearance.font, false))")
  })
})


describe('Reading appearance localized copy', () => {
  it('provides every rendered label and failure in all seven language catalogs', async () => {
    const {registerAllUiLanguageBundles} = await import('./helpers/uiLanguageBundles')
    const {translate} = await import('@/src/core/i18n')
    registerAllUiLanguageBundles()
    const source = readFileSync(resolve(__dirname, '../src/app/popup/PopupApp.vue'), 'utf8')
    const keys = new Set([...source.matchAll(/popup\.readingAppearance\.[a-zA-Z]+/g)].map(match => match[0]))
    keys.add('popup.readingAppearance.error')
    expect(keys.size).toBe(20)
    for (const language of ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'] as const) {
      const catalog = JSON.parse(readFileSync(resolve(__dirname, '../src/core/i18n/messages/settings-copy', `${language}.json`), 'utf8')).messages
      for (const key of keys) {
        expect(catalog[key]?.trim(), `${language}: ${key}`).toBeTruthy()
        expect(translate(key, language)).toBe(catalog[key])
        if (language !== 'zh-CN') expect(catalog[key]).not.toBe(translate(key, 'zh-CN'))
        if (language !== 'zh-CN' && language !== 'ja-JP') expect(catalog[key]).not.toMatch(/[\u3400-\u9fff]/u)
      }
    }
  })
})

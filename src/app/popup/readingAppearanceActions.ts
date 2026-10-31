/**
 * @file src/app/popup/readingAppearanceActions.ts
 * 文件职责：编排阅读外观抽屉的当前网页读取、即时预览与明确站点记忆操作。
 * 主要内容：复验固定来源标签页和文档令牌，串行处理操作；抽屉失活与导航立即撤销旧回复，错误返回稳定本地化键并可重试，默认消息不携带持久化意图。
 * 模块边界：仅经注入的 Popup 标签页与消息端口工作，不读写配置或存储，不修改网页 DOM。
 */
import type {PopupActiveTab} from './pageContracts'

export type ReadingFont = 'original' | 'system'
export interface ReadingAppearanceState {
  font: ReadingFont; remembered: boolean; busy: boolean; ready: boolean; error: string
}
interface ReadingAppearanceMessage {type: string; font?: ReadingFont; remember?: boolean; documentToken?: string}
interface Ports {
  state: ReadingAppearanceState
  active: () => boolean
  target: () => {tabId: number | null; url: string}
  getTab: () => Promise<PopupActiveTab | undefined>
  send: (id: number, message: ReadingAppearanceMessage) => Promise<unknown>
}
export function createReadingAppearanceActions(ports: Ports) {
  const state = ports.state
  let generation = 0, documentToken: string | undefined
  function invalidate() {generation += 1;state.busy = false;state.ready = false;state.error = '';documentToken = undefined}
  async function run(font?: ReadingFont, remember?: boolean) {
    if (!ports.active() || state.busy || (font !== undefined && !state.ready)) return
    const revision = generation, expected = ports.target()
    const owns = () => ports.active() && revision === generation
    state.busy = true;state.error = ''
    try {
      const tab = await ports.getTab()
      if (!owns()) return
      if (expected.tabId === null || tab?.id !== expected.tabId || (tab.pendingUrl || tab.url || '') !== expected.url) {
        state.ready = false
        throw new Error('source changed')
      }
      const message: ReadingAppearanceMessage = font === undefined ? {type: 'getReadingAppearanceState'}
        : {type: 'setReadingAppearance', font, documentToken, ...(remember === undefined ? {} : {remember})}
      const response = await ports.send(expected.tabId, message) as {
        status?: unknown; font?: unknown; remembered?: unknown; documentToken?: unknown
      } | undefined
      if (!owns()) return
      if (!response || response.status !== 'success' || (response.font !== 'original' && response.font !== 'system') || typeof response.remembered !== 'boolean'
        || typeof response.documentToken !== 'string' || !response.documentToken
        || (font !== undefined && response.documentToken !== documentToken)) {
        state.ready = false
        throw new Error('unavailable')
      }
      state.font = response.font;state.remembered = response.remembered;documentToken = response.documentToken;state.ready = true
    } catch {
      if (owns()) state.error = 'popup.readingAppearance.error'
    } finally {if (owns()) state.busy = false}
  }
  return {invalidate, read: () => run(), set: (font: ReadingFont, remember?: boolean) => run(font, remember)}
}

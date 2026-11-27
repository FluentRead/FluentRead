/**
 * @file tests/settingsUiLanguageOwnership.test.ts
 * 文件职责：执行真实 SettingsSections 模板向语言 Selector 传入的活跃 props。
 * 主要内容：覆盖 general 的 v-show 保留、父缓存停用/恢复、旧控件事件和共享 i18n 存储的迟到成功/失败。
 * 模块边界：仅验证父子归属接线，其他设置子组件与存储传输使用可控端口，不重复审计父表单其它业务。
 */
import {afterEach, describe, expect, it} from 'vitest'
import {createLanguageHarness, settle} from './uiI18nAuditHarness'
let harness: Awaited<ReturnType<typeof createLanguageHarness>> | undefined
async function create() {return harness = await createLanguageHarness({parent:true})}
afterEach(async () => {await harness?.close();harness = undefined})
async function hide(h: NonNullable<typeof harness>) {h.props.activeSection = 'settings-language-audit-hidden';await settle()}
async function reopen(h: NonNullable<typeof harness>) {h.props.activeSection = 'settings-general';h.visible.value = true;await settle()}
async function invalidate(h: NonNullable<typeof harness>, reason: string) {
  if(reason==='hidden')await hide(h);else if(reason==='cached'){h.visible.value=false;await settle()}else if(reason==='pagehide'){h.pagehide();await settle()}else{h.unmount();await settle()}
}

describe('实际 SettingsSections → UiLanguageSelector 活跃归属', () => {
  it('v-show 隐藏 general 保留同一 Selector 实例，但实际父 props.active=false 且控件禁用', async () => {
    const h = await create(), child = h.selector();expect(child.props.active).toBe(true);expect(child.props.compact).toBe(true);await h.open();const old = h.handles();await hide(h)
    expect(h.selector()).toBe(child);expect(h.selector().props.active).toBe(false);expect(h.document.querySelector('#settings-general')?.getAttribute('style')).toContain('display:none')
    expect(h.document.querySelector('[data-language-control]')?.hasAttribute('disabled')).toBe(true);old.onVisibleChange(true);await old.onChange('en-US');await settle();expect(h.requests).toHaveLength(0)
  })
  it('隐藏再重开不复活旧 change/关闭事件，新菜单的选择仍可保存', async () => {
    const h = await create();await h.open();const old = h.handles();await hide(h);await reopen(h);await h.open();old.onVisibleChange(false);await old.onChange('fr-FR');await settle();expect(h.requests).toHaveLength(0)
    const pending = h.change('en-US');await settle();expect(h.requests).toHaveLength(1);h.requests[0].gate.resolve();await pending;expect(h.stored()).toBe('en-US')
  })
  it('父 KeepAlive deactivation 使语言失活，activation 不恢复旧事件', async () => {
    const h = await create();await h.open();const old = h.handles();h.visible.value=false;await settle();expect(h.parentState.value.viewActive).toBe(false);expect(h.selector().props.active).toBe(false)
    await old.onChange('en-US');expect(h.requests).toHaveLength(0);h.visible.value=true;await settle();expect(h.selector().props.active).toBe(true);await h.open();await old.onChange('fr-FR');expect(h.requests).toHaveLength(0)
    const current = h.change('ja-JP');await settle();h.requests[0].gate.resolve();await current;expect(h.stored()).toBe('ja-JP')
  })
  it('general 隐藏后父缓存再返回仍隐藏，重新进入 general 才创建当前选择身份', async () => {
    const h = await create();await h.open();const old = h.handles();await hide(h);h.visible.value=false;await settle();h.visible.value=true;await settle();expect(h.selector().props.active).toBe(false)
    old.onVisibleChange(true);await old.onChange('en-US');expect(h.requests).toHaveLength(0);await reopen(h);await h.open();const pending=h.change('ja-JP');await settle();h.requests[0].gate.resolve();await pending;expect(h.stored()).toBe('ja-JP')
  })
  it.each(['hidden','cached','pagehide','unmount'])('%s 后已发的保存允许成功，但旧事件无权发起其它保存', async reason => {
    const h = await create();await h.open();const old = h.handles(), pending = h.change('en-US');await settle();await invalidate(h,reason)
    if(reason==='hidden'||reason==='cached'){await reopen(h);expect(h.document.querySelector('[data-language-control]')?.hasAttribute('disabled')).toBe(true)}
    old.onVisibleChange(true);await old.onChange('fr-FR');expect(h.requests).toHaveLength(1);h.requests[0].gate.resolve();await pending;await settle();expect(h.stored()).toBe('en-US');expect(h.document.querySelector('[role="status"]')).toBeNull()
  })
  it.each(['hidden','cached','pagehide','unmount'])('%s 后旧失败不影响新活跃状态或留下旧错误', async reason => {
    const h = await create();await h.open();const pending = h.change('en-US');await settle();await invalidate(h,reason);if(reason==='hidden'||reason==='cached')await reopen(h)
    h.requests[0].gate.reject(new Error('old failure'));await pending;await settle();expect(h.document.querySelector('[role="status"]')).toBeNull();expect(h.stored()).toBe('zh-CN')
    if(reason==='hidden'||reason==='cached'){await h.open();const retry = h.change('ja-JP');await settle();h.requests.at(-1)!.gate.resolve();await retry;expect(h.stored()).toBe('ja-JP')}
  })
  it('当前失败离开 general 即清除，重开后的新失败可正常反馈和重试', async () => {
    const h = await create();await h.open();const first=h.change('en-US');await settle();h.requests[0].gate.reject(new Error('current failure'));await first;await settle();expect(h.document.querySelector('[role="status"]')).not.toBeNull()
    await hide(h);await reopen(h);expect(h.document.querySelector('[role="status"]')).toBeNull();await h.open();const retry=h.change('ja-JP');await settle();h.requests[1].gate.resolve();await retry;await settle();expect(h.stored()).toBe('ja-JP')
  })
})

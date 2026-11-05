/**
 * @file tests/compositeServiceEditor.test.ts
 * 文件职责：验证组合创建与编辑共用的草稿契约和成员目录边界。
 * 主要内容：覆盖普通和自定义候选、组合排除、名称及成员校验、超时上下界、无效策略收敛与草稿不共享数组。
 * 模块边界：只测试纯视图模型；实际 Vue 编辑、保存和生命周期由 serviceEditorLifecycle 测试覆盖，后台调度另行验证。
 */
import {describe, expect, it} from 'vitest'
import {Config} from '@/src/core/config/model'
import {services} from '@/src/core/config/catalog'
import {createCompositeTranslationDraft, getCompositeMemberOptions, validateCompositeTranslationDraft, type CompositeTranslationDraft} from '@/src/ui/view-model/compositeServiceEditor'

const members = [{value: 'google', label: 'Google'}, {value: 'microsoft', label: 'Microsoft'}, {value: 'custom:work', label: 'Work'}]
const base = (): CompositeTranslationDraft => ({name: ' Everyday ', strategy: 'sequential', services: ['google', 'microsoft'], timeoutMs: 12000})

describe('组合翻译编辑草稿', () => {
  it('保留关闭成员的原选择与标签，改名保存不删除成员，重新启用后恢复候选', () => {
    const config = new Config(); config.disabledTranslationServices = ['google'];
    const before = JSON.stringify(config); const options = getCompositeMemberOptions(config);
    expect(options.find(item => item.value === 'google')).toMatchObject({disabled: true});
    expect(validateCompositeTranslationDraft(base(), options)).toMatchObject({valid: true, draft: {services: ['google', 'microsoft']}});
    expect(JSON.stringify(config)).toBe(before);
    config.disabledTranslationServices = [];
    expect(getCompositeMemberOptions(config).find(item => item.value === 'google')?.disabled).not.toBe(true);
  })
  it('公开成员目录不提供未开放的ChatGPT，不改写已保存组合或模型', () => {
    const config = new Config(); config.model[services.chatgptPlan] = 'saved-account-model';
    config.compositeTranslationProviders = [{id: 'composite:saved', name: 'Saved', strategy: 'sequential', services: [services.chatgptPlan, services.microsoft], timeoutMs: 12000}];
    const before = JSON.stringify(config);
    expect(getCompositeMemberOptions(config).some(member => member.value === services.chatgptPlan)).toBe(false);
    expect(JSON.stringify(config)).toBe(before);
    expect(createCompositeTranslationDraft(config.compositeTranslationProviders[0]).services).toEqual([services.chatgptPlan, services.microsoft]);
  })
  it('候选包含内置和已创建自定义服务，排除目录标题与任何组合', () => {
    const config = new Config()
    config.customOpenAIProviders = [{id: 'custom:work', name: 'Work', endpoint: 'https://example.test/v1', models: ['fixture']},
      {id: 'composite:nested', name: 'Invalid nested', endpoint: '', models: []}]
    const result = getCompositeMemberOptions(config)
    expect(result.map(member => member.value)).toEqual(expect.arrayContaining(['google', 'microsoft', 'custom:work']))
    expect(result.some(member => member.disabled || member.value.startsWith('composite:'))).toBe(false)
  })
  it('空配置和已有组合生成独立草稿，编辑成员不回写原配置', () => {
    expect(createCompositeTranslationDraft()).toEqual({name: '', strategy: 'sequential', services: [], timeoutMs: 12000})
    const provider = {id: 'composite:work', ...base()}
    const draft = createCompositeTranslationDraft(provider)
    draft.services.push('custom:work')
    expect(provider.services).toEqual(['google', 'microsoft'])
    expect(createCompositeTranslationDraft({...provider, name: '', timeoutMs: 1000})).toEqual({...base(), name: '', timeoutMs: 1000})
  })
  it('保存裁剪名称、剔除失效和嵌套成员、去重且保留顺序', () => {
    const result = validateCompositeTranslationDraft({...base(), services: ['custom:work', 'composite:nested', 'google', 'missing', 'google']}, members)
    expect(result).toEqual({draft: {name: 'Everyday', strategy: 'sequential', services: ['custom:work', 'google'], timeoutMs: 12000}, errors: {}, valid: true})
  })
  it('创建和编辑均需名称及至少两成员，保留草稿供修复', () => {
    const result = validateCompositeTranslationDraft({...base(), name: '   ', services: ['google']}, members)
    expect(result.errors).toEqual({name: 'settings.services.composite.nameRequired', services: 'settings.services.composite.membersRequired'})
    expect(result.valid).toBe(false)
    expect(validateCompositeTranslationDraft({...base(), name: 'a'.repeat(81)}, members).errors.name).toBe('settings.services.composite.nameTooLong')
    expect(validateCompositeTranslationDraft({...base(), name: 'a'.repeat(80)}, members).valid).toBe(true)
  })
  it('单成员超时为1至45秒内的整数毫秒，无效输入不能保存', () => {
    for (const timeoutMs of [1000, 12000, 45000]) expect(validateCompositeTranslationDraft({...base(), timeoutMs}, members).valid).toBe(true)
    for (const timeoutMs of [0, 999, 45001, -1, 12000.5, NaN, Infinity]) expect(validateCompositeTranslationDraft({...base(), timeoutMs}, members).errors.timeoutMs).toBe('settings.services.composite.timeoutInvalid')
  })
  it('三策略均可保存，未知策略恢复为顺序', () => {
    for (const strategy of ['random', 'sequential', 'smart'] as const) expect(validateCompositeTranslationDraft({...base(), strategy}, members).draft.strategy).toBe(strategy)
    expect(validateCompositeTranslationDraft({...base(), strategy: 'invalid' as never}, members).draft.strategy).toBe('sequential')
  })
})

import { describe, expect, it } from 'vitest'
import {
  buildServiceGroups,
  buildServiceSections,
  cleanServiceLabel,
  getServiceWebsite,
  searchServiceOptions,
  splitServiceChoices,
} from '@/src/ui/view-model/serviceCatalog'
import { customModelString, defaultModels, models, services, servicesType } from '@/src/core/config/catalog'
import { Config, normalizeConfig } from '@/src/core/config/model'
import {filterEnabledTranslationServices, isTranslationServiceDisabled, markDisabledTranslationServices, normalizeDisabledTranslationServices} from '@/src/core/config/serviceAvailability'

const options = [
  { value: 'machine', label: '机器翻译', disabled: true },
  { value: 'microsoft', label: '微软翻译' },
  { value: 'chromeTranslator', label: 'Chrome内置AI翻译⭐' },
  { value: 'ai', label: 'AI翻译', disabled: true },
  { value: 'deepseek', label: 'DeepSeek️', catalogKind: 'provider' },
  { value: 'openai', label: 'OpenAI', catalogKind: 'provider' },
  { value: 'newapi', label: 'New API', catalogKind: 'platform' },
]

describe('service catalog helpers', () => {
  it('points combinations to the guide without using any member endpoint', () => {
    expect(getServiceWebsite('composite:daily', {endpoint: 'https://user:secret@example.test/private?key=fixture'})).toEqual({url: 'https://fluent.thinkstu.com/config/translation-engines', kind: 'documentation'})
  })
  it('provides a public website or guide for every built-in service', () => {
    for (const service of Object.values(services)) {
      const website = getServiceWebsite(service)
      expect(website, service).toBeDefined()
      const url = new URL(website!.url)
      expect(url.protocol).toBe('https:')
      expect(`${url.username}${url.password}${url.search}${url.hash}`).toBe('')
    }
    expect(getServiceWebsite(services.huanYuanTranslation)).toEqual({
      url: 'https://console.cloud.tencent.com/hunyuan', kind: 'website',
    })
    expect(getServiceWebsite(services.chromeTranslator)?.kind).toBe('documentation')
    expect(getServiceWebsite(services.freeTranslation)?.kind).toBe('documentation')
    expect(getServiceWebsite(services.myMemory)).toEqual({url: 'https://mymemory.translated.net/doc/spec.php', kind: 'documentation'})
  })

  it('keeps MiniMax websites aligned with the selected account region', () => {
    expect(getServiceWebsite(services.minimax)?.url).toBe('https://platform.minimaxi.com/')
    expect(getServiceWebsite(services.minimax, {minimaxRegion: 'global'})?.url)
      .toBe('https://platform.minimax.io/login')
    expect(getServiceWebsite(services.minimax, {minimaxRegion: 'unknown'})?.url)
      .toBe('https://platform.minimaxi.com/')
  })

  it('opens configured service origins without leaking credentials or API parameters', () => {
    for (const service of ['custom:personal', services.custom, services.newapi]) {
      expect(getServiceWebsite(service, {endpoint: 'https://user:secret@example.com:8443/v1/private/chat?key=secret#token'}))
        .toEqual({url: 'https://example.com:8443/', kind: 'website'})
      expect(getServiceWebsite(service, {endpoint: ' http://localhost:11434/v1/chat/completions '}))
        .toEqual({url: 'http://localhost:11434/', kind: 'website'})
      expect(getServiceWebsite(service, {endpoint: 'http://[::1]:3000/v1'}))
        .toEqual({url: 'http://[::1]:3000/', kind: 'website'})
    }
    expect(getServiceWebsite(services.openai, {endpoint: 'https://proxy.example.com/v1'})?.url)
      .toBe('https://platform.openai.com/')
  })

  it('falls back to a setup guide for incomplete or non-web service addresses', () => {
    for (const endpoint of ['', 'not a url', '/relative', '//example.com', 'javascript:alert(1)',
      'data:text/html,hello', 'file:///tmp/config', 'ftp://example.com', 'blob:https://example.com/id']) {
      for (const service of ['custom:personal', services.custom, services.newapi]) {
        const link = getServiceWebsite(service, {endpoint})!
        expect(link.kind).toBe('documentation')
        expect(link.url).toBe(service === services.newapi
          ? 'https://docs.newapi.pro/'
          : 'https://fluent.thinkstu.com/config/translation-engines')
      }
    }
  })

  it('omits unknown services and group headings instead of manufacturing a destination', () => {
    for (const service of ['unknown', 'machine', 'ai', '__proto__', 'constructor', '']) {
      expect(getServiceWebsite(service)).toBeUndefined()
    }
  })

  it('preserves divider-based service grouping', () => {
    expect(buildServiceGroups(options)).toEqual([
      {
        id: 'machine',
        label: '机器翻译',
        items: [
          { value: 'microsoft', label: '微软翻译' },
          { value: 'chromeTranslator', label: 'Chrome内置AI翻译' },
        ],
      },
      {
        id: 'ai',
        label: 'AI翻译',
        items: [
          { value: 'deepseek', label: 'DeepSeek', catalogKind: 'provider' },
          { value: 'openai', label: 'OpenAI', catalogKind: 'provider' },
          { value: 'newapi', label: 'New API', catalogKind: 'platform' },
        ],
      },
    ])
  })

  it('nests AI services into ordered provider and platform groups', () => {
    expect(buildServiceSections(options)).toEqual([
      {
        id: 'machine',
        label: '机器翻译',
        collapsible: true,
        groups: [{
          id: 'machine-services',
          label: '',
          itemKind: '机器翻译',
          items: [
            { value: 'microsoft', label: '微软翻译' },
            { value: 'chromeTranslator', label: 'Chrome内置AI翻译' },
          ],
        }],
      },
      {
        id: 'ai',
        label: 'AI翻译',
        collapsible: false,
        groups: [
          {
            id: 'ai-providers',
            label: '模型服务商',
            itemKind: '模型服务商',
            items: [
              { value: 'deepseek', label: 'DeepSeek', catalogKind: 'provider' },
              { value: 'openai', label: 'OpenAI', catalogKind: 'provider' },
            ],
          },
          {
            id: 'ai-platforms',
            label: '聚合平台与接口',
            itemKind: '聚合平台',
            items: [{ value: 'newapi', label: 'New API', catalogKind: 'platform' }],
          },
        ],
      },
    ])
  })

  it('keeps unclassified AI services visible as model providers', () => {
    const sections = buildServiceSections([
      { value: 'ai', label: 'AI翻译', disabled: true },
      { value: 'future-provider', label: '未来模型' },
    ])

    expect(sections[0]?.groups[0]?.items.map((item) => item.value)).toEqual(['future-provider'])
  })

  it('keeps services before the first divider in a non-collapsible fallback section', () => {
    expect(buildServiceSections([{ value: 'standalone', label: '独立服务' }])).toEqual([
      {
        id: 'other',
        label: '其他服务',
        collapsible: false,
        groups: [{
          id: 'other-services',
          label: '',
          itemKind: '其他服务',
          items: [{ value: 'standalone', label: '独立服务' }],
        }],
      },
    ])
  })

  it('searches popup services by service name and model keyword', () => {
    const popupOptions = [
      { value: 'openai', label: 'OpenAI' },
      { value: 'tongyi', label: '千问/Qwen' },
      { value: 'microsoft', label: '微软翻译' },
    ]
    const popupModels = new Map([
      ['openai', ['gpt-5.6-luna', 'gpt-4.1-mini']],
      ['tongyi', ['qwen3.7-max', 'qwen-mt-flash']],
    ])

    expect(searchServiceOptions(popupOptions, ' open ', popupModels)).toEqual([
      { value: 'openai', label: 'OpenAI', matchingModels: [] },
    ])
    expect(searchServiceOptions(popupOptions, 'GPT 5.6', popupModels)).toEqual([
      { value: 'openai', label: 'OpenAI', matchingModels: ['gpt-5.6-luna'] },
    ])
    expect(searchServiceOptions(popupOptions, 'qwen-mt', popupModels)).toEqual([
      { value: 'tongyi', label: '千问/Qwen', matchingModels: ['qwen-mt-flash'] },
    ])
    expect(searchServiceOptions(popupOptions, '不存在', popupModels)).toEqual([])
  })

  it('searches the configured custom model and preserves the unfiltered order', () => {
    const popupOptions = [
      { value: 'custom', label: '自定义接口', description: 'OpenAI 兼容服务' },
      { value: 'microsoft', label: '微软翻译' },
    ]
    const popupModels = new Map([['custom', ['gpt-5-mini', customModelString]]])

    expect(searchServiceOptions(
      popupOptions,
      'local translation',
      popupModels,
      { custom: customModelString },
      { custom: 'local/translation-model' },
    )).toEqual([
      { value: 'custom', label: '自定义接口', description: 'OpenAI 兼容服务', matchingModels: ['local/translation-model'] },
    ])
    expect(searchServiceOptions(popupOptions, ' ( ) ', popupModels)).toEqual([])
    expect(searchServiceOptions(popupOptions, '  ', popupModels)).toEqual([
      { value: 'custom', label: '自定义接口', description: 'OpenAI 兼容服务', matchingModels: [] },
      { value: 'microsoft', label: '微软翻译', matchingModels: [] },
    ])
  })

  it('searches dynamic service metadata supplied by saved profiles', () => {
    const dynamicOptions = [{
      value: 'custom:1',
      label: '公司网关',
      description: 'https://gateway.example/v1/chat/completions',
      searchTerms: ['private-translation-model'],
    }]

    expect(searchServiceOptions(dynamicOptions, 'gateway.example', new Map())).toEqual([
      {...dynamicOptions[0], matchingModels: []},
    ])
    expect(searchServiceOptions(dynamicOptions, 'private-translation', new Map())).toEqual([
      {...dynamicOptions[0], matchingModels: []},
    ])
  })

  it('removes decorative recommendation stars from labels', () => {
    expect(cleanServiceLabel('硅基流动⭐️')).toBe('硅基流动')
  })

  it('为所有需要模型的 AI 服务提供自定义模型入口', () => {
    for (const service of servicesType.useModel) {
      expect(models.get(service), `${service} 缺少模型列表`).toBeDefined()
      if (service === services.chatgptPlan) {
        expect(models.get(service)).toEqual([])
        continue
      }
      expect(models.get(service), `${service} 缺少自定义模型`).toContain(customModelString)
    }
  })

  it('为每个需要模型的 AI 服务补齐并默认选中列表第一项', () => {
    const normalized = normalizeConfig({})

    for (const service of servicesType.useModel) {
      const defaultModel = defaultModels.get(service)
      if (service === services.chatgptPlan) {
        expect(defaultModel).toBeUndefined()
        expect(normalized.model[service] || '').toBe('')
        continue
      }
      expect(defaultModel, `${service} 缺少默认模型`).toBeTruthy()
      if (service === services.custom) {
        expect(normalized.model[service], '未创建 profile 时不应保留静态自定义服务模型').toBeUndefined()
        continue
      }
      expect(normalized.model[service], `${service} 未选中默认模型`).toBe(defaultModel)
      expect(new Config().model[service], `${service} 的初始配置未选中默认模型`).toBe(defaultModel)
    }
  })

  it('把免费翻译、已配置服务、微软与谷歌排在常用区前面，并用热门服务补位', () => {
    const catalog = ['freeTranslation', 'bilibili', 'myMemory', 'microsoft', 'google', 'deepL', 'youdao', 'deepseek', 'tongyi', 'zhipu', 'openai', 'gemini', 'claude']
      .map((value) => ({ value, label: value }))
    const ids = (items: { value: string }[]) => items.map((item) => item.value)

    const fresh = splitServiceChoices(catalog, { configured: new Set() })
    expect(ids(fresh.common)).toEqual(['freeTranslation', 'microsoft', 'google', 'bilibili', 'deepL', 'deepseek', 'tongyi', 'openai'])
    expect(ids(fresh.more)).toEqual(['myMemory', 'youdao', 'zhipu', 'gemini', 'claude'])

    const configured = splitServiceChoices(catalog, { configured: new Set(['claude', 'zhipu', 'removed']), selected: 'youdao' })
    expect(ids(configured.common)).toEqual(['freeTranslation', 'zhipu', 'claude', 'microsoft', 'google', 'youdao', 'bilibili', 'deepL'])
    expect(ids(configured.more)).toEqual(['myMemory', 'deepseek', 'tongyi', 'openai', 'gemini'])
  })

  it('常用区保留全部已配置服务与当前选中项，目录缺项时不补空位', () => {
    const catalog = ['deepseek', 'openai', 'claude', 'custom:1'].map((value) => ({ value, label: value }))
    const split = splitServiceChoices(catalog, { configured: new Set(['custom:1', 'claude', 'openai']), selected: 'gone', limit: 2 })

    expect(split.common.map((item) => item.value)).toEqual(['openai', 'claude', 'custom:1'])
    expect(split.more.map((item) => item.value)).toEqual(['deepseek'])
    expect(splitServiceChoices([], { configured: new Set() })).toEqual({ common: [], more: [] })

    // 待配置的服务不进常用区，即使它正在被别的功能使用或属于热门服务；当前选中项例外。
    const pending = splitServiceChoices(
      ['freeTranslation', 'microsoft', 'google', 'bilibili', 'deepL', 'deepseek', 'openai'].map((value) => ({ value, label: value })),
      { configured: new Set(['openai', 'deepseek']), needsSetup: new Set(['deepL', 'deepseek', 'openai']), selected: 'openai' },
    )
    expect(pending.common.map((item) => item.value)).toEqual(['freeTranslation', 'openai', 'microsoft', 'google', 'bilibili'])
    expect(pending.more.map((item) => item.value)).toEqual(['deepL', 'deepseek'])
  })
})

describe('service availability helpers', () => {
  it('normalizes closed IDs without duplicates, whitespace, invalid values, or unbounded entries', () => {
    expect(normalizeDisabledTranslationServices(['openai', ' openai ', 'deeplx', '', null, 12, 'x'.repeat(129)]))
      .toEqual(['openai', 'deeplx'])
    expect(normalizeDisabledTranslationServices(undefined)).toEqual([])
  })

  it('keeps closed choices visible but disabled, and filters disabled services from active lists', () => {
    const catalog = [{value: 'google', label: 'Google'}, {value: 'openai', label: 'OpenAI'}]
    const marked = markDisabledTranslationServices(catalog, ['openai'])
    expect(marked).toEqual([{value: 'google', label: 'Google'}, {value: 'openai', label: 'OpenAI', disabled: true}])
    expect(filterEnabledTranslationServices(marked, ['openai'])).toEqual([{value: 'google', label: 'Google'}])
    expect(isTranslationServiceDisabled(['openai'], 'openai')).toBe(true)
    expect(isTranslationServiceDisabled(undefined, 'openai')).toBe(false)
  })
})

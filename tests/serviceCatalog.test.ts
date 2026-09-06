import { describe, expect, it } from 'vitest'
import {
  buildServiceGroups,
  buildServiceSections,
  cleanServiceLabel,
  filterServiceSections,
  getSelectedModelLabel,
  getServiceWebsite,
  searchServiceOptions,
} from '@/src/ui/view-model/serviceCatalog'
import { customModelString, defaultModels, models, services, servicesType } from '@/src/core/config/catalog'
import { Config, normalizeConfig } from '@/src/core/config/model'

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

  it('filters nested service sections without losing their parent or subgroup', () => {
    const sections = buildServiceSections(options)
    expect(filterServiceSections(sections, '   ')).toBe(sections)
    expect(filterServiceSections(sections, 'new api')).toEqual([
      {
        id: 'ai',
        label: 'AI翻译',
        collapsible: false,
        groups: [{
          id: 'ai-platforms',
          label: '聚合平台与接口',
          itemKind: '聚合平台',
          items: [{ value: 'newapi', label: 'New API', catalogKind: 'platform' }],
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

  it('shows the effective model only for services that use model selection', () => {
    expect(getSelectedModelLabel('microsoft', { microsoft: 'ignored' }, {})).toBe('')
    expect(getSelectedModelLabel('openai', { openai: 'gpt-5-mini' }, {})).toBe('gpt-5-mini')
    expect(getSelectedModelLabel('openai', { openai: customModelString }, { openai: 'local-model' })).toBe('local-model')
    expect(getSelectedModelLabel('openai', { openai: customModelString }, {})).toBe(customModelString)
    expect(getSelectedModelLabel('openai', {}, {})).toBe('未选择模型')
  })

  it('为所有需要模型的 AI 服务提供自定义模型入口', () => {
    for (const service of servicesType.useModel) {
      expect(models.get(service), `${service} 缺少模型列表`).toBeDefined()
      expect(models.get(service), `${service} 缺少自定义模型`).toContain(customModelString)
    }
  })

  it('为每个需要模型的 AI 服务补齐并默认选中列表第一项', () => {
    const normalized = normalizeConfig({})

    for (const service of servicesType.useModel) {
      const defaultModel = defaultModels.get(service)
      expect(defaultModel, `${service} 缺少默认模型`).toBeTruthy()
      if (service === services.custom) {
        expect(normalized.model[service], '未创建 profile 时不应保留静态自定义服务模型').toBeUndefined()
        continue
      }
      expect(normalized.model[service], `${service} 未选中默认模型`).toBe(defaultModel)
      expect(new Config().model[service], `${service} 的初始配置未选中默认模型`).toBe(defaultModel)
    }
  })
})

/**
 * @file src/ui/view-model/serviceCatalog.ts
 * 文件职责：为服务与模型选择界面提供无框架的视图模型转换，把扁平配置选项整理成可搜索、可分层和可稳定展示的数据。
 * 主要内容：定义服务目录分组与官方网站入口，安全派生自定义服务站点，按服务与模型关键词搜索、筛选分层目录，并解析当前模型标签。
 * 模块边界：这些函数不读取 Vue 状态、不修改 Config，也不判断平台能力或发起连接测试；原始目录由 core/config 提供，Popup/Options 等调用方负责交互与渲染。
 */
import { customModelString, resolveConfiguredModel, services, servicesType } from '@/src/core/config/catalog'
import { isCustomOpenAIProviderId } from '@/src/core/config/customOpenAI'

export interface ServiceWebsite {
  url: string
  kind: 'website' | 'documentation'
}

const serviceGuide = 'https://fluent.thinkstu.com/config/translation-engines'

// 这里只保存供人操作的官网/控制台，不使用翻译 API endpoint 或推广链接。
const serviceWebsites = {
  microsoft: 'https://www.bing.com/translator',
  freeTranslation: serviceGuide,
  myMemory: 'https://mymemory.translated.net/doc/spec.php',
  deepL: 'https://www.deepl.com/en/products/api',
  deeplx: 'https://deeplx.owo.network/',
  google: 'https://translate.google.com/',
  xiaoniu: 'https://niutrans.com/',
  youdao: 'https://ai.youdao.com/',
  tencent: 'https://console.cloud.tencent.com/tmt',
  chromeTranslator: 'https://developer.chrome.com/docs/ai/translator-api',
  openai: 'https://platform.openai.com/',
  azureOpenai: 'https://ai.azure.com/',
  gemini: 'https://aistudio.google.com/',
  yiyan: 'https://console.bce.baidu.com/qianfan/',
  tongyi: 'https://bailian.console.aliyun.com/',
  zhipu: 'https://bigmodel.cn/',
  moonshot: 'https://platform.kimi.com/',
  claude: 'https://platform.claude.com/',
  custom: serviceGuide,
  infini: 'https://cloud.infini-ai.com/',
  baichuan: 'https://platform.baichuan-ai.com/',
  lingyi: 'https://platform.lingyiwanwu.com/',
  deepseek: 'https://platform.deepseek.com/',
  minimax: 'https://platform.minimaxi.com/',
  mimo: 'https://platform.xiaomimimo.com/',
  jieyue: 'https://platform.stepfun.com/',
  groq: 'https://console.groq.com/',
  huanYuan: 'https://console.cloud.tencent.com/hunyuan',
  huanYuanTranslation: 'https://console.cloud.tencent.com/hunyuan',
  doubao: 'https://console.volcengine.com/ark/',
  siliconCloud: 'https://cloud.siliconflow.cn/',
  openrouter: 'https://openrouter.ai/',
  grok: 'https://console.x.ai/',
  newapi: 'https://docs.newapi.pro/',
} satisfies Record<keyof typeof services, string>

/** 自建服务只打开 HTTP(S) origin，避免把 API 路径、账号、密钥或查询参数带入跳转。 */
export function getServiceWebsite(
  service: string,
  context: { endpoint?: string; minimaxRegion?: string } = {},
): ServiceWebsite | undefined {
  if (isCustomOpenAIProviderId(service) || service === services.custom || service === services.newapi) {
    try {
      const endpoint = new URL(context.endpoint || '')
      if (endpoint.protocol === 'https:' || endpoint.protocol === 'http:') {
        return { url: `${endpoint.origin}/`, kind: 'website' }
      }
    } catch {
      // 正在输入、尚未配置或无效地址仍提供配置说明入口。
    }
    return {
      url: service === services.newapi ? serviceWebsites.newapi : serviceGuide,
      kind: 'documentation',
    }
  }

  if (!Object.hasOwn(serviceWebsites, service)) return undefined
  return {
    url: service === services.minimax && context.minimaxRegion === 'global'
      ? 'https://platform.minimax.io/login'
      : serviceWebsites[service as keyof typeof serviceWebsites],
    kind: [services.freeTranslation, services.chromeTranslator, services.myMemory].includes(service)
      ? 'documentation'
      : 'website',
  }
}

export interface ServiceOption {
  value: string
  label: string
  description?: string
  searchTerms?: string[]
  disabled?: boolean
  catalogKind?: string
}

export interface ServiceGroup {
  id: string
  label: string
  items: ServiceOption[]
}

export interface ServiceSubgroup extends ServiceGroup {
  itemKind: string
}

export interface ServiceSection {
  id: string
  label: string
  collapsible: boolean
  groups: ServiceSubgroup[]
}

export interface ServiceSearchOption extends ServiceOption {
  matchingModels: string[]
}

export function cleanServiceLabel(label: string) {
  return label.replace(/[⭐️★]+/gu, '').trim()
}

export function buildServiceGroups(options: ServiceOption[]): ServiceGroup[] {
  const groups: ServiceGroup[] = []
  let current: ServiceGroup = { id: 'other', label: '其他服务', items: [] }

  for (const option of options) {
    if (option.disabled) {
      if (current.items.length) groups.push(current)
      current = {
        id: option.value,
        label: cleanServiceLabel(option.label),
        items: [],
      }
      continue
    }
    current.items.push({ ...option, label: cleanServiceLabel(option.label) })
  }

  if (current.items.length) groups.push(current)
  return groups
}

export function buildServiceSections(options: ServiceOption[]): ServiceSection[] {
  return buildServiceGroups(options).map((group) => {
    if (group.id === 'ai') {
      const providers = group.items.filter((item) => item.catalogKind !== 'platform')
      const platforms = group.items.filter((item) => item.catalogKind === 'platform')
      return {
        id: group.id,
        label: group.label,
        collapsible: false,
        groups: [
          { id: 'ai-providers', label: '模型服务商', itemKind: '模型服务商', items: providers },
          { id: 'ai-platforms', label: '聚合平台与接口', itemKind: '聚合平台', items: platforms },
        ].filter((subgroup) => subgroup.items.length > 0),
      }
    }

    return {
      id: group.id,
      label: group.label,
      collapsible: group.id === 'machine',
      groups: [{
        id: `${group.id}-services`,
        label: '',
        itemKind: group.id === 'machine' ? '机器翻译' : group.label,
        items: group.items,
      }],
    }
  })
}

export function filterServiceSections(sections: ServiceSection[], query: string) {
  const keyword = query.trim().toLocaleLowerCase()
  if (!keyword) return sections

  return sections
    .map((section) => ({
      ...section,
      groups: section.groups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            `${item.label}${item.value}${item.description || ''}`.toLocaleLowerCase().includes(keyword),
          ),
        }))
        .filter((group) => group.items.length > 0),
    }))
    .filter((section) => section.groups.length > 0)
}

function searchTextMatches(value: string, rawKeyword: string, compactKeyword: string) {
  const normalizedValue = value.normalize('NFKC').toLocaleLowerCase()
  if (normalizedValue.includes(rawKeyword)) return true
  if (!compactKeyword) return false
  return normalizedValue.replace(/[\s._/()-]+/gu, '').includes(compactKeyword)
}

export function searchServiceOptions(
  serviceOptions: ServiceOption[],
  query: string,
  modelOptions: ReadonlyMap<string, readonly string[]>,
  selectedModels: Record<string, string> = {},
  activeCustomModels: Record<string, string> = {},
): ServiceSearchOption[] {
  const rawKeyword = query.trim().normalize('NFKC').toLocaleLowerCase()
  if (!rawKeyword) return serviceOptions.map((item) => ({ ...item, matchingModels: [] }))

  const compactKeyword = rawKeyword.replace(/[\s._/()-]+/gu, '')
  return serviceOptions.flatMap((item) => {
    const selectedModel = selectedModels[item.value]
    const configuredModel = resolveConfiguredModel(selectedModel, activeCustomModels[item.value])
    const searchableModels = Array.from(new Set([
      ...(modelOptions.get(item.value) || []),
      selectedModel,
      configuredModel,
    ].filter((model): model is string => Boolean(model))))
    const matchingModels = searchableModels.filter((model) => searchTextMatches(model, rawKeyword, compactKeyword))
    const serviceMatches = searchTextMatches(
      `${item.label} ${item.value} ${item.description || ''} ${item.searchTerms?.join(' ') || ''}`,
      rawKeyword,
      compactKeyword,
    )

    return serviceMatches || matchingModels.length > 0
      ? [{ ...item, matchingModels }]
      : []
  })
}

export function getSelectedModelLabel(
  service: string,
  selectedModels: Record<string, string>,
  activeCustomModels: Record<string, string>,
) {
  if (!servicesType.isUseModel(service)) return ''

  const selectedModel = selectedModels[service]
  const configuredModel = resolveConfiguredModel(selectedModel, activeCustomModels[service])
  return configuredModel || (selectedModel === customModelString ? customModelString : '未选择模型')
}

/**
 * @file src/ui/view-model/serviceCatalog.ts
 * 文件职责：为服务与模型选择界面提供无框架的视图模型转换，把扁平配置选项整理成可搜索、可分层和可稳定展示的数据。
 * 主要内容：定义服务目录分组与官方网站入口，提供云服务厂商的免费额度与开通指引，安全派生自定义服务站点，按服务与模型关键词搜索。
 * 模块边界：这些函数不读取 Vue 状态、不修改 Config，也不判断平台能力或发起连接测试；原始目录由 core/config 提供，Popup/Options 等调用方负责交互与渲染。
 */
import { resolveConfiguredModel, services } from '@/src/core/config/catalog'
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
  bilibili: 'https://github.com/bilibili/Index-Translate',
  myMemory: 'https://mymemory.translated.net/doc/spec.php',
  deepL: 'https://www.deepl.com/en/products/api',
  deeplx: 'https://deeplx.owo.network/',
  google: 'https://translate.google.com/',
  xiaoniu: 'https://niutrans.com/',
  youdao: 'https://ai.youdao.com/',
  tencent: 'https://console.cloud.tencent.com/tmt',
  googleCloudTranslation: 'https://console.cloud.google.com/apis/library/translate.googleapis.com',
  azureTranslator: 'https://portal.azure.com/',
  aliyunTranslation: 'https://mt.console.aliyun.com/',
  baiduTranslation: 'https://fanyi-api.baidu.com/',
  volcTranslation: 'https://console.volcengine.com/translate',
  chromeTranslator: 'https://developer.chrome.com/docs/ai/translator-api',
  localTranslation: serviceGuide,
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
  ollama: 'https://ollama.com/',
  mistral: 'https://console.mistral.ai/',
  cohere: 'https://dashboard.cohere.com/',
  togetherai: 'https://api.together.ai/',
  fireworks: 'https://app.fireworks.ai/',
  cerebras: 'https://cloud.cerebras.ai/',
  deepinfra: 'https://deepinfra.com/dash',
  perplexity: 'https://www.perplexity.ai/account/api',
} satisfies Record<keyof typeof services, string>

/**
 * 云服务厂商的开通指引。这些服务都要先在控制台开通产品、再签发密钥，
 * 目录里只给一个官网链接不足以让人走完整个流程，所以把额度、步骤和
 * 控制台入口一起交给设置页展示。
 */
export interface ServiceCredentialGuide {
  /** 官方公布的免费额度，用于帮助用户判断是否够用。 */
  freeQuota: string
  /** 申请密钥的控制台地址。 */
  consoleUrl: string
  /** 控制台按钮文案。 */
  consoleLabel: string
  /** 官方文档或计费说明地址。 */
  docsUrl: string
  /** 文档按钮文案。 */
  docsLabel: string
  /** 从零到可用的最小步骤，按顺序展示。 */
  steps: readonly string[]
}

const serviceCredentialGuides: Record<string, ServiceCredentialGuide> = {
  [services.tencent]: {
    freeQuota: '每月 500 万字符免费额度',
    consoleUrl: 'https://console.cloud.tencent.com/tmt',
    consoleLabel: '前往腾讯云控制台',
    docsUrl: 'https://cloud.tencent.com/document/product/551/35017',
    docsLabel: '额度与计费',
    steps: [
      '在腾讯云控制台开通「机器翻译 TMT」',
      '在访问管理中新建 API 密钥，复制 SecretId 与 SecretKey',
      '把两段密钥填入下方，再点连接测试',
    ],
  },
  [services.googleCloudTranslation]: {
    freeQuota: '每月 50 万字符免费额度（结算账号内）',
    consoleUrl: 'https://console.cloud.google.com/apis/library/translate.googleapis.com',
    consoleLabel: '前往 Google Cloud 控制台',
    docsUrl: 'https://cloud.google.com/products/translate/pricing',
    docsLabel: '额度与计费',
    steps: [
      '在 Google Cloud 项目中启用 Cloud Translation API',
      '在「凭据」页创建 API 密钥，并限制为 Cloud Translation API',
      '把密钥填入下方 API Key，再点连接测试',
    ],
  },
  [services.azureTranslator]: {
    freeQuota: 'F0 免费层每月 200 万字符',
    consoleUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation',
    consoleLabel: '创建 Translator 资源',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate',
    docsLabel: '接口文档',
    steps: [
      '在 Azure 门户创建「Translator」资源并选择 Free F0 定价层',
      '在「密钥和终结点」页复制密钥与位置/区域',
      '把密钥填入下方并选择同一区域，再点连接测试',
    ],
  },
  [services.aliyunTranslation]: {
    freeQuota: '通用版每月 100 万字符免费额度',
    consoleUrl: 'https://mt.console.aliyun.com/',
    consoleLabel: '前往阿里云控制台',
    docsUrl: 'https://help.aliyun.com/zh/machine-translation/developer-reference/api-alimt-2018-10-12-translategeneral',
    docsLabel: '接口文档',
    steps: [
      '在阿里云控制台开通「机器翻译」并领取免费额度',
      '在 RAM 访问控制中创建 AccessKey',
      '把 AccessKey ID 与 Secret 填入下方，选择地域后点连接测试',
    ],
  },
  [services.baiduTranslation]: {
    freeQuota: '标准版每月 5 万字符免费额度',
    consoleUrl: 'https://fanyi-api.baidu.com/manage/developer',
    consoleLabel: '前往百度翻译开放平台',
    docsUrl: 'https://fanyi-api.baidu.com/doc/23',
    docsLabel: '接口文档',
    steps: [
      '在百度翻译开放平台注册开发者并开通「通用文本翻译」',
      '在开发者信息页复制 APP ID 与密钥',
      '把两项填入下方，再点连接测试',
    ],
  },
  [services.volcTranslation]: {
    freeQuota: '每月 200 万字符免费额度',
    consoleUrl: 'https://console.volcengine.com/translate',
    consoleLabel: '前往火山引擎控制台',
    docsUrl: 'https://docs.volcengine.com/docs/4640/65067?lang=zh',
    docsLabel: '接口文档',
    steps: [
      '在火山引擎控制台开通「机器翻译」',
      '在访问控制中创建 Access Key',
      '把 Access Key ID 与 Secret Access Key 填入下方，再点连接测试',
    ],
  },
}

/** 只有云服务厂商需要这段开通指引；其余服务返回 undefined，由调用方隐藏整块区域。 */
export function getServiceCredentialGuide(service: string): ServiceCredentialGuide | undefined {
  return Object.hasOwn(serviceCredentialGuides, service) ? serviceCredentialGuides[service] : undefined
}

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
    kind: [services.freeTranslation, services.bilibili, services.chromeTranslator, services.myMemory, services.localTranslation].includes(service)
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
      // 机器翻译与云服务厂商都是长列表，允许收起；AI 分组保持常驻展开。
      collapsible: group.id === 'machine' || group.id === 'cloud',
      groups: [{
        id: `${group.id}-services`,
        label: '',
        itemKind: group.id === 'machine' ? '机器翻译' : group.label,
        items: group.items,
      }],
    }
  })
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

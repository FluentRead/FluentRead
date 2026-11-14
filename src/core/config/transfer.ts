/**
 * @file src/core/config/transfer.ts
 *
 * 文件职责：负责配置导入与导出的纯数据转换，生成用户主动复制的完整可迁移配置，并兼容导入不含凭据的旧公开配置文件。
 * 主要内容：验证导入对象的自有基础字段，生成完整迁移配置，按目标地址分别解绑未显式导入的凭据，并以对象身份临时记录原始 JSON 的重绑项，供实际保存消费；意图不进入序列化数据。公开转换为 isConfigImportValid、prepareConfigForExport、prepareConfigForImport。
 * 模块边界：本文件属于 core 领域层，只定义规则、类型与纯转换；不直接读写浏览器存储、不发起网络请求、不挂载 Vue/WXT 入口，持久化、协议调用和界面编排分别由 services、providers 与 features 承担。
 */

import { isCustomBodyMapping } from './customBody'
import {
  extractConfigCredentials,
  hasCredentialFields,
  mergeConfigCredentials,
  sanitizeConfigCredentials,
  type ConfigCredentialField,
  type ConfigCredentials,
} from './credentials'
import { normalizeConfig, type Config } from './model'
import { servicesType } from './catalog'
import {
  isConfiguredCustomOpenAIProvider,
  isCustomOpenAIProviderId,
  LEGACY_CUSTOM_OPENAI_PROVIDER_ID,
  normalizeCustomOpenAIProviders,
} from './customOpenAI'
import {isCompositeTranslationProviderId, isConfiguredCompositeTranslationProvider, normalizeCompositeTranslationProviders} from './compositeTranslation'
import {dropCredentialsForChangedDestinations} from './credentialBinding'

type ConfigRecord = Record<string, any>
export type ConfigImportCredentialMode = 'merge' | 'merge-hydration-safe' | 'replace'

export interface ConfigImportOptions {
  credentialMode?: ConfigImportCredentialMode
}

/** 原始导入 JSON 的显式项，只伴随本次返回对象，不进入配置或存储协议。 */
export interface ConfigImportCredentialBindings {
  readonly tokenServices: readonly string[]
  readonly apiKeyServices: readonly string[]
  readonly secretServices: readonly string[]
  readonly fields: readonly ConfigCredentialField[]
}
const importedCredentialBindings = new WeakMap<object, ConfigImportCredentialBindings>()

export function getConfigImportCredentialBindings(value: unknown): ConfigImportCredentialBindings | undefined {
  return isRecord(value) ? importedCredentialBindings.get(value) : undefined
}

const requiredConfigFields = ['on', 'service', 'display', 'from', 'to'] as const

function isRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isConfigImportValid(value: unknown): value is ConfigRecord {
  if (!isRecord(value)) return false
  if (!requiredConfigFields.every((field) => Object.hasOwn(value, field))) return false
  if (typeof value.on !== 'boolean') return false
  if (value.display !== 0 && value.display !== 1) return false
  if (typeof value.from !== 'string' || !value.from.trim()) return false
  if (typeof value.to !== 'string' || !value.to.trim()) return false
  if (typeof value.service !== 'string') return false
  if (isCompositeTranslationProviderId(value.service)) {
    const rawProviders = Object.hasOwn(value, 'compositeTranslationProviders') ? value.compositeTranslationProviders : undefined
    const customProviders = normalizeCustomOpenAIProviders(Object.hasOwn(value, 'customOpenAIProviders') ? value.customOpenAIProviders : undefined)
    if (!isConfiguredCompositeTranslationProvider(normalizeCompositeTranslationProviders(rawProviders, customProviders), value.service)) return false
  } else if (isCustomOpenAIProviderId(value.service)) {
    const rawProviders = Object.hasOwn(value, 'customOpenAIProviders') ? value.customOpenAIProviders : undefined
    const providers = normalizeCustomOpenAIProviders(rawProviders)
    const isLegacyImport = value.service === LEGACY_CUSTOM_OPENAI_PROVIDER_ID
      && !Array.isArray(rawProviders)
    if (!isLegacyImport && !isConfiguredCustomOpenAIProvider(providers, value.service)) return false
  } else if (!servicesType.machine.has(value.service) && !servicesType.AI.has(value.service)) return false
  return (!Object.hasOwn(value, 'customBody') || isCustomBodyMapping(value.customBody))
    && (!Object.hasOwn(value, 'customHeaders') || isCustomBodyMapping(value.customHeaders))
}

const scalarCredentialFields = [
  'ak', 'sk', 'appid', 'key', 'youdaoAppKey', 'youdaoAppSecret',
  'tencentSecretId', 'tencentSecretKey',
] as const

function clearCredentialsForChangedDestinations(
  value: ConfigRecord,
  current: Config,
  imported: Config,
  credentials: ConfigCredentials,
  explicitlyBoundCredentialFields: ReadonlySet<ConfigCredentialField>,
): ConfigCredentials {
  const explicitTokens = (Object.hasOwn(value, 'token') && isRecord(value.token)) ? value.token : {}
  const explicitlyBoundTokens = new Set(Object.entries(explicitTokens)
    .filter(([, token]) => typeof token === 'string')
    .map(([service]) => service))
  const explicitlyBoundApiKeys = new Set(Object.entries((Object.hasOwn(value, 'apiKeys') && isRecord(value.apiKeys)) ? value.apiKeys : {})
    .filter(([, keys]) => Array.isArray(keys))
    .map(([service]) => service))
  let bound = dropCredentialsForChangedDestinations(
    credentials,
    current,
    imported,
    explicitlyBoundTokens,
    explicitlyBoundCredentialFields,
    new Set(Object.entries((Object.hasOwn(value, 'customHeaders') && isRecord(value.customHeaders)) ? value.customHeaders : {})
      .filter(([, headers]) => typeof headers === 'string').map(([service]) => service)),
    explicitlyBoundApiKeys,
  )
  // apiKeys 是实际有序密钥源，token 是其首项镜像。显式列表被保留时必须
  // 同步镜像，否则旧 token 被解绑后的空映射会在归一化时清空新列表。
  for (const service of explicitlyBoundApiKeys) {
    const first = bound.apiKeys[service]?.[0]
    if (first !== undefined) bound = {...bound, token: {...bound.token, [service]: first}}
  }
  // token 与 secret 各自只由导入文件的自有项表达重绑意图；显式 ID
  // 不能替未提供的旧 Secret 授权，显式 Secret 也不能被遗漏的 ID 连带丢弃。
  const explicitSecrets = Object.hasOwn(value, 'secret') && isRecord(value.secret) ? value.secret : {}
  const explicitlyBoundSecrets = new Set(Object.entries(explicitSecrets)
    .filter(([, secret]) => typeof secret === 'string').map(([service]) => service))
  if (Object.keys(credentials.secret).length === 0) return bound
  const secretBinding = dropCredentialsForChangedDestinations(
    {...extractConfigCredentials({}), secret: credentials.secret},
    current,
    imported,
    explicitlyBoundSecrets,
  )
  return {...bound, secret: secretBinding.secret}
}

/**
 * 旧版文件只更新它明确提供的凭据；未提供的服务凭据通常继续保留。
 * 唯一例外是服务的有效请求地址发生变化，此时旧 token 必须与旧地址解绑。
 * 版本化完整备份可显式选择 replace，精确替换整份凭据快照。
 */
function prepareImportedCredentials(
  value: ConfigRecord,
  current: Config,
  imported: Config,
  mode: ConfigImportCredentialMode,
): ConfigCredentials {
  if (mode === 'replace') return extractConfigCredentials(value)

  const currentCredentials = extractConfigCredentials(current)
  let merged = currentCredentials
  const explicitlyBoundCredentialFields = new Set<ConfigCredentialField>()
  if (hasCredentialFields(value)) {
    const importedCredentials = extractConfigCredentials(value)
    const importedApiKeys = (Object.hasOwn(value, 'apiKeys') && isRecord(value.apiKeys))
      ? {...currentCredentials.apiKeys, ...importedCredentials.apiKeys}
      : {...currentCredentials.apiKeys};
    if (Object.hasOwn(value, 'token') && isRecord(value.token)) {
      for (const [service, token] of Object.entries(importedCredentials.token)) {
        // 新列表只覆盖同一服务的旧字段；其他服务的 token（含显式清空）仍是导入意图。
        if (!Object.hasOwn(importedCredentials.apiKeys, service)) importedApiKeys[service] = token ? [token] : [];
      }
    }
    merged = {
      ...currentCredentials,
      customHeaders: (Object.hasOwn(value, 'customHeaders') && isRecord(value.customHeaders))
        ? {...currentCredentials.customHeaders, ...importedCredentials.customHeaders}
        : currentCredentials.customHeaders,
      token: (Object.hasOwn(value, 'token') && isRecord(value.token))
        ? {...currentCredentials.token, ...importedCredentials.token}
        : currentCredentials.token,
      apiKeys: importedApiKeys,
      secret: (Object.hasOwn(value, 'secret') && isRecord(value.secret))
        ? {...currentCredentials.secret, ...importedCredentials.secret}
        : currentCredentials.secret,
      extra: (Object.hasOwn(value, 'extra') && isRecord(value.extra))
        ? {...currentCredentials.extra, ...importedCredentials.extra}
        : currentCredentials.extra,
    }
    for (const field of scalarCredentialFields) {
      if (!Object.hasOwn(value, field) || typeof value[field] !== 'string') continue
      // v1 完整备份可能在设置页凭据尚未水合时，把 Config 默认的空标量
      // 当成真实快照导出。该格式无法区分“尚未读取”与“用户主动清空”，
      // 因此兼容恢复时只接受非空标量，避免覆盖目标端仍安全保存的密钥。
      if (mode === 'merge-hydration-safe' && !value[field].trim()) continue
      merged[field] = importedCredentials[field]
      explicitlyBoundCredentialFields.add(field)
    }
  }
  return clearCredentialsForChangedDestinations(
    value,
    current,
    imported,
    merged,
    explicitlyBoundCredentialFields,
  )
}

/**
 * 生成由用户在配置管理页主动复制的完整迁移配置。
 *
 * 与可分享的公开配置不同，这份 JSON 会保留所有当前设置、提示词、自定义请求参数
 * 以及专用 API 凭据。翻译次数属于使用统计，不进入迁移文件；存储 revision 与
 * 已废弃的凭据持久化策略字段会由 normalizeConfig 在边界处移除。
 */
export function prepareConfigForExport(value: unknown): ConfigRecord {
  if (!isRecord(value)) throw new Error('配置必须是 JSON 对象')

  const exported = normalizeConfig(value) as unknown as ConfigRecord
  delete exported.count
  delete exported.persistCredentials
  return exported
}

/**
 * 默认兼容公开配置和旧版文件：只更新 JSON 明确提供的凭据字段，未提供的凭据
 * 继续保留；若同 ID 服务换了 endpoint 或 proxy，则未随文件显式提供的旧 token
 * 会被清除，避免误发。版本化完整备份可显式选择 replace，精确恢复 token/extra
 * 映射和标量凭据快照。翻译统计、迁移标记始终保留当前值；旧 persistCredentials
 * 会被忽略。
 */
export function prepareConfigForImport(
  value: unknown,
  current: unknown,
  options: ConfigImportOptions = {},
): Config {
  if (!isConfigImportValid(value)) throw new TypeError('导入配置缺少有效的基础字段')
  const currentConfig = normalizeConfig(current)
  const importedConfig = normalizeConfig(value)
  const credentials = prepareImportedCredentials(
    value,
    currentConfig,
    importedConfig,
    options.credentialMode ?? 'merge',
  )

  const result = normalizeConfig(mergeConfigCredentials({
    ...sanitizeConfigCredentials(importedConfig),
    count: currentConfig.count,
    videoServiceDefaultMigrated: currentConfig.videoServiceDefaultMigrated,
    aiPlatformDefaultRemovalMigrated: currentConfig.aiPlatformDefaultRemovalMigrated,
  }, credentials))
  const ownServices = (field: 'token' | 'apiKeys' | 'secret') => {
    if (!Object.hasOwn(value, field) || !isRecord(value[field])) return []
    return Object.entries(value[field]).filter(([, item]) => field === 'apiKeys'
      ? Array.isArray(item) && item.every(key => typeof key === 'string')
      : typeof item === 'string').map(([service]) => service)
  }
  const tokenServices = ownServices('token')
  importedCredentialBindings.set(result, {
    tokenServices,
    apiKeyServices: [...new Set([...tokenServices, ...ownServices('apiKeys')])],
    secretServices: ownServices('secret'),
    fields: [
      ...scalarCredentialFields.filter(field => Object.hasOwn(value, field) && typeof value[field] === 'string'
        && (options.credentialMode !== 'merge-hydration-safe' || Boolean(value[field].trim()))),
      ...(['customHeaders', 'extra'] as const).filter(field => Object.hasOwn(value, field) && isRecord(value[field])),
    ],
  })
  return result
}

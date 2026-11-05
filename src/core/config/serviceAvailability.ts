/**
 * @file src/core/config/serviceAvailability.ts
 * 文件职责：规范化用户关闭的翻译服务，并把关闭状态投影到服务选择项。
 * 主要内容：去重、限制服务标识长度，保留内置、自定义与组合服务的统一开关状态；选择列表保留已关闭项并标为不可选，供调用方显示旧配置和恢复提示。
 * 模块边界：只处理配置值和选项，不读取存储、不修改配置、不判断浏览器能力或发起翻译。
 */

export interface TranslationServiceAvailabilityOption {
  value: string
  disabled?: boolean
}

/** 忽略非法值并按首次出现顺序去重，兼容导入的旧备份与自定义服务标识。 */
export function normalizeDisabledTranslationServices(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const service = item.trim()
    if (!service || service.length > 128 || seen.has(service)) continue
    seen.add(service)
    result.push(service)
  }
  return result
}

/** 运行时配置来自持久化快照，读取时仍容忍缺字段或旧版本对象。 */
export function isTranslationServiceDisabled(disabledServices: unknown, service: string): boolean {
  return Array.isArray(disabledServices) && disabledServices.some(item => item === service)
}

/** 保留已关闭项的标签与现有选择，只阻止再次选用；目录页可单独提供重新启用开关。 */
export function markDisabledTranslationServices<T extends TranslationServiceAvailabilityOption>(
  options: readonly T[],
  disabledServices: unknown,
): Array<T & TranslationServiceAvailabilityOption> {
  const disabled = new Set(normalizeDisabledTranslationServices(disabledServices))
  if (!disabled.size) return [...options] as Array<T & TranslationServiceAvailabilityOption>
  return options.map(option => disabled.has(option.value) && !option.disabled
    ? {...option, disabled: true}
    : option) as Array<T & TranslationServiceAvailabilityOption>
}

/** 供只展示可用项的页面使用；保留配置的调用方应改用 markDisabledTranslationServices。 */
export function filterEnabledTranslationServices<T extends TranslationServiceAvailabilityOption>(
  options: readonly T[],
  disabledServices: unknown,
): T[] {
  const disabled = new Set(normalizeDisabledTranslationServices(disabledServices))
  return options.filter(option => !option.disabled && !disabled.has(option.value))
}

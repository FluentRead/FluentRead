/**
 * @file src/ui/view-model/compositeServiceEditor.ts
 * 文件职责：为组合服务创建与编辑表单提供不含凭据的草稿转换和校验。
 * 主要内容：从平台可用的普通服务目录派生成员候选，校验名称、成员数量、策略与单路等待时限；新建和已有组合共用规则，显示候选不修改已保存成员。
 * 模块边界：不修改配置、不保存数据、不调用翻译；成员只引用现有服务 ID，不复制密钥、模型或接口配置。
 */
import { options } from '@/src/core/config/catalog'
import type { Config } from '@/src/core/config/model'
import { withCustomOpenAIServiceOptions } from '@/src/core/config/customOpenAI'
import {
  COMPOSITE_TRANSLATION_TIMEOUT_MIN,
  COMPOSITE_TRANSLATION_TIMEOUT_MAX,
  DEFAULT_COMPOSITE_TRANSLATION_TIMEOUT_MS,
  isCompositeTranslationProviderId,
  type CompositeTranslationProvider,
  type CompositeTranslationStrategy,
} from '@/src/core/config/compositeTranslation'
import type { ServiceOption } from './serviceCatalog'
import {filterAvailableTranslationServices} from '@/src/services/translation/capabilities'
import {filterEnabledTranslationServices} from '@/src/core/config/serviceAvailability'

export type CompositeTranslationDraft = Omit<CompositeTranslationProvider, 'id'>
export type CompositeTranslationDraftErrors = Partial<Record<'name' | 'services' | 'timeoutMs', string>>
export const MAX_COMPOSITE_SERVICE_NAME_LENGTH = 80

export function getCompositeMemberOptions(config: Config): ServiceOption[] {
  return filterEnabledTranslationServices(filterAvailableTranslationServices(withCustomOpenAIServiceOptions(options.services, config.customOpenAIProviders)
    .filter(option => !option.disabled && !isCompositeTranslationProviderId(option.value))), config.disabledTranslationServices)
}

export function createCompositeTranslationDraft(provider?: CompositeTranslationProvider): CompositeTranslationDraft {
  return {
    name: provider?.name || '',
    strategy: provider?.strategy || 'sequential',
    services: [...(provider?.services || [])],
    timeoutMs: provider?.timeoutMs ?? DEFAULT_COMPOSITE_TRANSLATION_TIMEOUT_MS,
  }
}

export function validateCompositeTranslationDraft(
  value: CompositeTranslationDraft,
  members: readonly ServiceOption[],
): { draft: CompositeTranslationDraft; errors: CompositeTranslationDraftErrors; valid: boolean } {
  const available = new Set(members.map(member => member.value))
  const services = [...new Set(value.services.filter(service => available.has(service)))]
  const strategy: CompositeTranslationStrategy = ['random', 'sequential', 'smart'].includes(value.strategy) ? value.strategy : 'sequential'
  const draft = {name: value.name.trim(), strategy, services, timeoutMs: value.timeoutMs}
  const errors: CompositeTranslationDraftErrors = {}
  if (!draft.name) errors.name = 'settings.services.composite.nameRequired'
  else if (draft.name.length > MAX_COMPOSITE_SERVICE_NAME_LENGTH) errors.name = 'settings.services.composite.nameTooLong'
  if (services.length < 2) errors.services = 'settings.services.composite.membersRequired'
  if (!Number.isInteger(draft.timeoutMs) || draft.timeoutMs < COMPOSITE_TRANSLATION_TIMEOUT_MIN || draft.timeoutMs > COMPOSITE_TRANSLATION_TIMEOUT_MAX) errors.timeoutMs = 'settings.services.composite.timeoutInvalid'
  return {draft, errors, valid: Object.keys(errors).length === 0}
}

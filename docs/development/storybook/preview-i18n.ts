/** Storybook-only language context: the production UI and its configuration store remain independent. */
import { readonly, ref } from 'vue'
import { registerUiLanguageBundle, translate, translateLegacyText, type TranslationParams, type UiLanguage } from '@/src/core/i18n'
import { enUSMessages, enUSLegacyText } from '@/src/core/i18n/messages/en-US'

registerUiLanguageBundle('en-US', { messages: enUSMessages, legacyText: enUSLegacyText, legacyPatterns: { early: [], late: [] } })
export const previewLanguage = ref<UiLanguage>('zh-CN')

export function useUiI18n() {
  return {
    language: readonly(previewLanguage),
    t: (key: string, params?: TranslationParams) => translate(key, previewLanguage.value, params),
    translateLegacy: (value: string) => translateLegacyText(value, previewLanguage.value),
  }
}

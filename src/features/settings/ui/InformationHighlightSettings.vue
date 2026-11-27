<!--
@file src/features/settings/ui/InformationHighlightSettings.vue
文件职责：以可按需展开的设置卡组织智能高亮的开关、阅读预览、持久偏好与本地模型管理。
主要内容：标题旁保留简洁的原理与论文说明气泡及开启状态摘要，未启用自动高亮与快捷键时默认折叠以保持页面简洁；展开后并排展示示意文本与阅读偏好，只有选择意外度模式才读取本地模型状态。
模块边界：组件不分析正文或自动下载；开关与偏好写入由共享控件处理，资源状态由独立模型卡读取。
-->
<template>
  <SettingsDisclosure
    id="information-highlight-settings"
    class="information-highlight-disclosure"
    :title="t('informationHighlight.title')"
    :description="t('informationHighlight.description')"
    :status="statusLabel"
    :default-open="initiallyActive"
  >
    <div class="information-highlight-header-bar">
      <FieldHelp :content="t('informationHighlight.principle.help')" :label="t('informationHighlight.principle')" data-information-highlight-principle>
        <template #content>{{ t('informationHighlight.principle.help') }} <a class="information-highlight-paper" :href="paperUrl" target="_blank" rel="noopener noreferrer">{{ t('informationHighlight.principle.paper') }}</a></template>
      </FieldHelp>
      <span class="information-highlight-principle-label">{{ t('informationHighlight.principle') }}</span>
    </div>
    <div class="information-highlight-workspace">
      <div class="information-highlight-example"><InformationHighlightPreview :preferences="config.informationHighlight" /></div>
      <InformationHighlightPreferences :config="config" :active="active">
        <template #after-mode>
          <div v-if="config.informationHighlight.mode === 'surprisal-local'" class="information-highlight-models" role="radiogroup" :aria-label="t('informationHighlight.model.select')" data-information-highlight-models>
            <span class="information-highlight-models-label">{{ t('informationHighlight.model.select') }}</span>
            <div class="information-highlight-model-grid"><InformationHighlightModelCard v-for="item in modelChoices" :key="item.model.id" :active="active" :model-id="item.model.id" :selected="config.informationHighlight.model === item.model.id" selectable :context-identity="context.revision.value" :onSelect="item.choose" /></div>
          </div>
        </template>
      </InformationHighlightPreferences>
    </div>
  </SettingsDisclosure>
</template>
<script setup lang="ts">
import {computed} from 'vue'
import type {Config} from '@/src/core/config/model'
import {INFORMATION_HIGHLIGHT_MODELS} from '@/src/core/config/informationHighlightModel'
import {useUiI18n} from '@/src/ui/i18n'
import SettingsDisclosure from './components/SettingsDisclosure.vue'
import FieldHelp from './components/FieldHelp.vue'
import InformationHighlightPreferences from './InformationHighlightPreferences.vue'
import InformationHighlightPreview from './InformationHighlightPreview.vue'
import InformationHighlightModelCard from './InformationHighlightModelCard.vue'
import {useSettingsActionContext} from '../model/useSettingsActionContext'
const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true})
const {t} = useUiI18n()
// Smith & Levy (2013), The effect of word predictability on reading time is logarithmic, Cognition 128(3).
const paperUrl = 'https://doi.org/10.1016/j.cognition.2013.02.013'
const context = useSettingsActionContext(() => props.active, () => [props.config, props.config.informationHighlight])
const initiallyActive = Boolean(props.config.informationHighlight.enabled || props.config.informationHighlight.hotkeyEnabled)
const statusLabel = computed(() => {
  if (props.config.informationHighlight.enabled) return t(`informationHighlight.mode.${props.config.informationHighlight.mode}`)
  if (props.config.informationHighlight.hotkeyEnabled && props.config.informationHighlight.hotkey) return props.config.informationHighlight.hotkey
  return t('common.none')
})
const modelChoices = computed(() => {
  const current = context.capture()
  return Object.values(INFORMATION_HIGHLIGHT_MODELS).map(model => ({model, choose: () => {
    if (current()) props.config.informationHighlight = {...props.config.informationHighlight, model: model.id}
  }}))
})
</script>
<style scoped>
.information-highlight-header-bar { display: flex; align-items: center; gap: 4px; padding: 12px 20px 0; color: var(--muted); font-size: 12px; }
.information-highlight-principle-label { color: var(--muted); font-size: 12px; }
:global(.information-highlight-paper) { color: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
.information-highlight-workspace { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; padding: 16px 20px 20px; align-items: start; }
.information-highlight-example { min-width: 0; }
.information-highlight-models { display: grid; gap: 12px; min-width: 0; }
.information-highlight-models-label { color: var(--ink); font-size: 12px; font-weight: 600; }
.information-highlight-model-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; min-width: 0; align-items: stretch; }
@media (max-width: 850px) { .information-highlight-workspace { grid-template-columns: minmax(0, 1fr); gap: 20px; padding: 14px 16px 16px; } .information-highlight-header-bar { padding: 10px 16px 0; } }
@media (max-width: 480px) { .information-highlight-workspace { padding: 12px; } .information-highlight-header-bar { padding: 10px 12px 0; } }
</style>

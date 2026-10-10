<!--
@file src/features/settings/ui/InformationHighlightPreferences.vue
文件职责：提供智能高亮的开关与阅读偏好控件，让用户直接比较密度、渐变配色和绘制效果。
主要内容：首行设置当前页面的开关快捷键，其下开关决定是否自动高亮；分析方式后提供两张模型资源卡的插槽，模型选择由父级处理；以密度、色阶卡、浓度和绘制方式控制外观，所有写入绑定活跃配置归属。
模块边界：只修改已有 Config.informationHighlight，不分析正文、不下载模型；设置持久化由父级现有配置服务负责。
-->
<template>
  <div class="information-highlight-preferences" :class="{'is-compact': compact}" data-testid="information-highlight-preferences">
    <div class="highlight-enable">
      <span class="highlight-enable-copy"><strong>{{ t('informationHighlight.hotkey') }}</strong><small>{{ t('informationHighlight.hotkey.description') }}</small></span>
      <span class="highlight-hotkey-controls"><button type="button" class="highlight-hotkey" :disabled="!context.active.value || !config.informationHighlight.hotkeyEnabled" :aria-label="t('informationHighlight.hotkey')" :onClick="actions.editHotkey" data-information-highlight-hotkey>{{ config.informationHighlight.hotkey || t('informationHighlight.hotkey.none') }}</button>
      <ElSwitch :model-value="config.informationHighlight.hotkeyEnabled" :disabled="!context.active.value" :aria-label="t('informationHighlight.hotkey.enabled')" :onUpdate:modelValue="actions.hotkeyEnabled" data-information-highlight-hotkey-enabled /></span>
    </div>
    <div class="highlight-enable">
      <span class="highlight-enable-copy"><strong>{{ t('informationHighlight.enabled') }}</strong><small>{{ t('informationHighlight.enabled.description') }}</small></span>
      <ElSwitch :model-value="config.informationHighlight.enabled" :disabled="!context.active.value" :aria-label="t('informationHighlight.enabled')" :onUpdate:modelValue="actions.enabled" data-information-highlight-enabled />
    </div>
    <label v-if="showMode" class="highlight-field">
      <span>{{ t('informationHighlight.mode') }}</span>
      <UiSelect :model-value="config.informationHighlight.mode" :disabled="!context.active.value" :aria-label="t('informationHighlight.mode')" :onUpdate:modelValue="actions.mode" data-information-highlight-mode-select>
        <ElOption v-for="mode in modes" :key="mode" :value="mode" :label="t(`informationHighlight.mode.${mode}`)" :data-information-highlight-mode="mode" />
      </UiSelect>
      <small v-if="config.informationHighlight.mode === 'keywords'">{{ t('informationHighlight.mode.keywords.description') }}</small>
    </label>
    <slot name="after-mode" />
    <div v-if="showDensity" class="highlight-field">
      <span id="information-highlight-density-label">{{ t('informationHighlight.density') }}</span>
      <div class="highlight-segments" role="group" :aria-label="t('informationHighlight.density')">
        <button v-for="item in densityChoices" :key="item.value" type="button" :disabled="!context.active.value" :aria-pressed="config.informationHighlight.density === item.value" :class="{selected: config.informationHighlight.density === item.value}" :onClick="item.choose" :data-information-highlight-density="item.value">{{ t(`informationHighlight.density.${item.value}`) }}</button>
      </div>
    </div>
    <div v-if="showAppearance" class="highlight-field">
      <span>{{ t('informationHighlight.color') }}</span>
      <div class="highlight-colors" role="group" :aria-label="t('informationHighlight.color')">
        <button v-for="item in colorChoices" :key="item.value" type="button" :disabled="!context.active.value" :aria-pressed="config.informationHighlight.color === item.value" :class="{selected: config.informationHighlight.color === item.value}" :onClick="item.choose" :data-information-highlight-color="item.value">
          <span class="highlight-color-ramp" aria-hidden="true"><i v-for="shade in item.shades" :key="shade" data-information-highlight-palette-sample :style="{backgroundColor: `rgb(${item.rgb} / ${shade})`}" /></span>
          <span class="highlight-color-name">{{ t(`informationHighlight.color.${item.value}`) }}<svg v-if="config.informationHighlight.color === item.value" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8 3 3 6-6" /></svg></span>
        </button>
      </div>
    </div>
    <div v-if="showAppearance" class="highlight-field">
      <span>{{ t('informationHighlight.intensity') }}</span>
      <div class="highlight-segments" role="group" :aria-label="t('informationHighlight.intensity')">
        <button v-for="item in intensityChoices" :key="item.value" type="button" :disabled="!context.active.value" :aria-pressed="config.informationHighlight.intensity === item.value" :class="{selected: config.informationHighlight.intensity === item.value}" :onClick="item.choose" :data-information-highlight-intensity="item.value">{{ t(`informationHighlight.intensity.${item.value}`) }}</button>
      </div>
    </div>
    <div v-if="showAppearance" class="highlight-field">
      <span>{{ t('informationHighlight.style') }}</span>
      <div class="highlight-styles" role="group" :aria-label="t('informationHighlight.style')" :style="{'--highlight-palette-rgb': INFORMATION_HIGHLIGHT_PALETTES[config.informationHighlight.color].rgb}">
        <button v-for="item in styleChoices" :key="item.value" type="button" :disabled="!context.active.value" :aria-pressed="config.informationHighlight.style === item.value" :class="{selected: config.informationHighlight.style === item.value}" :onClick="item.choose" :data-information-highlight-style="item.value">
          <span class="highlight-style-sample" :class="`sample-${item.value}`" aria-hidden="true"><i v-for="level in rampLevels" :key="level" :style="{'--highlight-sample-opacity': informationHighlightOpacity(item.value, level, config.informationHighlight.intensity)}" /></span>
          <span>{{ t(`informationHighlight.style.${item.value}`) }}</span>
        </button>
      </div>
    </div>
    <CustomHotkeyInput v-if="hotkeyDialog" :model-value="hotkeyDialog" :current-value="config.informationHighlight.hotkey" :validate="hotkeyConflict" :onUpdate:modelValue="closeHotkey" :onConfirm="actions.hotkey" :onCancel="closeHotkey" />
  </div>
</template>
<script setup lang="ts">
import {computed, defineAsyncComponent, ref, watch} from 'vue'
import {ElOption, ElSwitch} from 'element-plus'
import UiSelect from '@/src/ui/components/UiSelect.vue'
import type {Config} from '@/src/core/config/model'
import type {InformationHighlightMode, InformationHighlightDensity, InformationHighlightColor, InformationHighlightIntensity, InformationHighlightStyle} from '@/src/core/config/informationHighlight'
import {INFORMATION_HIGHLIGHT_COLORS, INFORMATION_HIGHLIGHT_PALETTES, informationHighlightOpacity} from '@/src/features/information-highlight/domain/public'
import {useSettingsActionContext} from '../model/useSettingsActionContext'
import {useUiI18n} from '@/src/ui/i18n'
import {canonicalizeHotkey, resolveConfiguredHotkey} from '@/src/core/hotkey'
import {resolveSectionTranslationHotkey} from '@/src/core/config/sectionTranslation'
import {resolveParagraphCopyHotkey} from '@/src/core/config/paragraphCopy'
import {resolveAreaTranslationHotkey} from '@/src/core/config/areaTranslation'
import {findEnabledQuickTranslationHotkeyConflict} from '@/src/core/config/quickTranslation'
const CustomHotkeyInput = defineAsyncComponent(() => import('@/src/ui/components/CustomHotkeyInput.vue'))
const props = withDefaults(defineProps<{config: Config; active?: boolean; compact?: boolean; showMode?: boolean; showDensity?: boolean; showAppearance?: boolean}>(), {active: true, compact: false, showMode: true, showDensity: true, showAppearance: true})
const {t} = useUiI18n()
const context = useSettingsActionContext(() => props.active, () => [props.config, props.config.informationHighlight])
const modes: InformationHighlightMode[] = ['keywords', 'surprisal-local']
const densities: InformationHighlightDensity[] = ['low', 'medium', 'high']
const colors: readonly InformationHighlightColor[] = INFORMATION_HIGHLIGHT_COLORS
const styles: InformationHighlightStyle[] = ['heatmap', 'background', 'underline']
const intensities: InformationHighlightIntensity[] = ['soft', 'standard', 'strong']
const rampLevels = [0, 2, 3, 5, 7]
const hotkeyDialog = ref(false)
const closeHotkey = () => {hotkeyDialog.value = false}
watch(context.revision, closeHotkey, {flush: 'sync'})
/** 与已启用功能共用同一组合键时两边都会响应，录制时直接拒绝。 */
function hotkeyConflict(hotkey: string): string {
  const identity = canonicalizeHotkey(hotkey).toLocaleLowerCase(), config = props.config
  if (!identity) return ''
  const taken = [resolveConfiguredHotkey(config.hotkey, config.customHotkey), resolveConfiguredHotkey(config.floatingBallHotkey, config.customFloatingBallHotkey),
    config.selectionTranslatorMode === 'disabled' ? '' : resolveConfiguredHotkey(config.selectionTranslatorTrigger, config.customSelectionTranslatorHotkey),
    config.sectionTranslationHotkeyEnabled ? resolveSectionTranslationHotkey(config.sectionTranslationHotkey, config.customSectionTranslationHotkey) : '',
    config.paragraphCopyEnabled ? resolveParagraphCopyHotkey(config.paragraphCopyHotkey, config.customParagraphCopyHotkey) : '',
    resolveAreaTranslationHotkey(config.selectionAreaHotkey, config.customSelectionAreaHotkey)]
  return taken.some(item => canonicalizeHotkey(item || '').toLocaleLowerCase() === identity) || findEnabledQuickTranslationHotkeyConflict(config.quickTranslationProfiles ?? [], hotkey)
    ? t('informationHighlight.hotkey.conflict') : ''
}
const actions = computed(() => {
  const current = context.capture()
  return {editHotkey: () => {if (current()) hotkeyDialog.value = true}, hotkey: (value: unknown) => {
    const hotkey = typeof value === 'string' ? canonicalizeHotkey(value) : ''
    if (!current() || hotkeyConflict(hotkey)) return
    props.config.informationHighlight = {...props.config.informationHighlight, hotkey}; closeHotkey()
  }, hotkeyEnabled: (value: unknown) => {
    if (!current()) return
    closeHotkey(); props.config.informationHighlight = {...props.config.informationHighlight, hotkeyEnabled: value === true}
  }, enabled: (value: unknown) => {
    if (current()) props.config.informationHighlight = {...props.config.informationHighlight, enabled: value === true}
  }, mode: (value: unknown) => {
    if (current() && modes.includes(value as InformationHighlightMode)) props.config.informationHighlight = {...props.config.informationHighlight, mode: value as InformationHighlightMode}
  }}
})
const densityChoices = computed(() => {const current = context.capture(); return densities.map(value => ({value, choose: () => {
  if (current()) props.config.informationHighlight = {...props.config.informationHighlight, density: value}
}}))})
const colorChoices = computed(() => {const current = context.capture(); return colors.map(value => ({value, rgb: INFORMATION_HIGHLIGHT_PALETTES[value].rgb, shades: rampLevels.map(level => informationHighlightOpacity('heatmap', level, props.config.informationHighlight.intensity)), choose: () => {
  if (current()) props.config.informationHighlight = {...props.config.informationHighlight, color: value}
}}))})
const intensityChoices = computed(() => {const current = context.capture(); return intensities.map(value => ({value, choose: () => {
  if (current()) props.config.informationHighlight = {...props.config.informationHighlight, intensity: value}
}}))})
const styleChoices = computed(() => {const current = context.capture(); return styles.map(value => ({value, choose: () => {
  if (current()) props.config.informationHighlight = {...props.config.informationHighlight, style: value}
}}))})
</script>
<style scoped>
.information-highlight-preferences { display: grid; gap: 22px; min-width: 0; }
.highlight-enable { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; padding-bottom: 18px; border-bottom: 1px solid var(--line, #dce3eb); color: var(--ink, #25354b); }
.highlight-hotkey-controls { display: inline-flex; flex: none; align-items: center; gap: 12px; }
.highlight-hotkey { flex: none; min-width: 84px; padding: 8px 14px; border: 1px solid var(--line, #dce3eb); border-radius: 8px; color: var(--ink, #25354b); background: var(--surface-soft, #f6f8fb); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.highlight-hotkey:hover { border-color: var(--brand, #3680dd); }
.highlight-hotkey:focus-visible { outline: 2px solid var(--brand, #3680dd); outline-offset: 2px; }
.highlight-hotkey:disabled { cursor: default; opacity: .55; }
.highlight-enable-copy { display: grid; gap: 4px; min-width: 0; }
.highlight-enable-copy strong { font-size: 14px; font-weight: 600; }
.highlight-enable-copy small { color: var(--muted, #637184); font-size: 12px; line-height: 1.6; }
.highlight-field { display: grid; gap: 9px; min-width: 0; color: var(--ink, #25354b); font-size: 12px; font-weight: 600; }
.highlight-field small { color: var(--muted, #637184); font-weight: 400; line-height: 1.6; }
.highlight-field :deep(.el-select) { width: 100%; }
.highlight-segments, .highlight-styles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; min-width: 0; }
.highlight-colors { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.highlight-segments button, .highlight-colors button, .highlight-styles button { min-width: 0; border: 1px solid var(--line, #dce3eb); border-radius: 10px; padding: 10px 8px; color: var(--muted, #637184); background: var(--surface, #fff); font: inherit; font-weight: 500; cursor: pointer; overflow-wrap: anywhere; transition: border-color .15s ease, background-color .15s ease; }
.highlight-segments button:hover, .highlight-colors button:hover, .highlight-styles button:hover { border-color: var(--brand, #3680dd); }
.highlight-segments button.selected, .highlight-colors button.selected, .highlight-styles button.selected { border-color: var(--brand, #3680dd); color: var(--brand-strong, #2464b8); background: var(--brand-soft, #edf5ff); }
.highlight-segments button:focus-visible, .highlight-colors button:focus-visible, .highlight-styles button:focus-visible { outline: 2px solid var(--brand, #3680dd); outline-offset: 2px; }
.highlight-segments button:disabled, .highlight-colors button:disabled, .highlight-styles button:disabled { cursor: default; opacity: .55; }
.highlight-colors button { display: grid; gap: 8px; padding: 10px; text-align: left; }
.highlight-color-ramp { display: flex; gap: 2px; overflow: hidden; height: 18px; border-radius: 5px; background: var(--surface, #fff); }
.highlight-color-ramp i { flex: 1; min-width: 0; }
.highlight-color-name { display: flex; align-items: center; justify-content: space-between; gap: 3px; }
.highlight-color-name svg { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.highlight-styles button { display: grid; justify-items: center; gap: 9px; }
.highlight-style-sample { display: flex; width: min(100%, 68px); height: 14px; gap: 3px; align-items: center; }
.highlight-style-sample i { flex: 1; height: 10px; min-width: 0; border-radius: 3px; background: rgb(var(--highlight-palette-rgb) / var(--highlight-sample-opacity)); }
.sample-underline i { height: 7px; border-radius: 0; border-bottom: 2px solid rgb(var(--highlight-palette-rgb) / var(--highlight-sample-opacity)); background: transparent; }
.is-compact { gap: 14px; }
@media (max-width: 370px) { .highlight-colors { grid-template-columns: repeat(2, minmax(0, 1fr)); } .highlight-styles { gap: 5px; } .highlight-styles button { padding: 9px 4px; } }
@media (prefers-reduced-motion: reduce) { .highlight-segments button, .highlight-colors button, .highlight-styles button { transition: none; } }
</style>

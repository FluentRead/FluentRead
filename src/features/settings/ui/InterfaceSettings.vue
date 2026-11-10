<!--
 * @file src/features/settings/ui/InterfaceSettings.vue
 * 文件职责：组织译文样式、界面风格、动画加载效果、菜单栏布局与界面字体及逐句高亮、完整句学习外观分组，其中网页译文样式排在第一位，完整句学习外观紧随菜单栏布局。
 * 主要内容：连续展示译文样式、与真实菜单栏同宽的皮肤预览、菜单栏布局、动画及紧凑字体卡片，风格选择以名称和配色缩略图组成可比较网格，仅单独展示当前选择的说明，其余说明保留在可访问名称与悬停提示中；单选组只保留选中项的 Tab 入口并支持方向键及首尾定位，窄屏优先展示选择网格再展示完整预览，通过预览和显隐列表编排区域与快捷入口；字体标题、描述和样例使用包内字形子集，未下载和离线时也可预览真实样式；字体下载、重试和逐项清除都在对应字体卡片内完成，清除按钮展示排除共享文件后的可释放容量；清除确认框绑定当前页面、配置及选中字体，隐藏、缓存停用或配置变更时关闭，迟到结果不写回新配置或显示旧反馈。
 * 侧边栏：在菜单栏布局中为支持原生侧边栏的 Chromium 宿主提供显示范围选择。
 * 模块边界：本组件只负责界面配置的展示与双向绑定，不直接读写浏览器存储、不负责主题模式，也不关闭翻译功能本身；界面皮肤由 Options composition root 统一应用，译文样式的细节由 TranslationStyleSettings 负责。
-->
<template>
  <SettingsPanel name="translation" :active="props.activePanel">
<TranslationStyleSettings :config="props.config" />
<SentenceHighlightStyleSettings :config="props.config" />
</SettingsPanel>

  <SettingsPanel name="skin" :active="props.activePanel">
<SettingsGroup :title="translateLegacy('界面与弹窗')">
    <SettingsItem
      class="interface-appearance-settings"
      :label="translateLegacy('弹窗风格')"
      :description="translateLegacy('风格只改变扩展界面的呈现，不影响网页翻译效果')"
    >
      <template #copy>
        <InterfaceSkinPreview
          :skin="selectedSkinOption"
          :preview-label="`${translateLegacy('弹窗风格')}: ${translateLegacy(selectedSkinOption.label)}`"
        />
      </template>
      <div class="interface-skin-picker" role="radiogroup" :aria-label="translateLegacy('弹窗风格')" @keydown="handleSkinKeydown">
        <div class="interface-skin-current">
          <strong>{{ translateLegacy(selectedSkinOption.label) }}</strong>
          <p>{{ translateLegacy(selectedSkinOption.description).replace('FluentRead', t('common.brand')) }}</p>
        </div>
        <div
          v-for="group in groupedSkinOptions"
          :key="group.value"
          class="interface-skin-group"
          role="group"
          :aria-labelledby="`interface-skin-group-${group.value}`"
        >
          <div class="interface-skin-group-heading">
            <strong :id="`interface-skin-group-${group.value}`">{{ translateLegacy(group.label) }}</strong>
          </div>
          <div class="interface-skin-grid">
            <button
              v-for="skin in group.options"
              :key="skin.value"
              class="interface-skin-option"
              :class="{ selected: props.config.interfaceSkin === skin.value }"
              type="button"
              role="radio"
              :aria-checked="props.config.interfaceSkin === skin.value"
              :tabindex="props.config.interfaceSkin === skin.value ? 0 : -1"
              :aria-label="`${translateLegacy(skin.label)}: ${translateLegacy(skin.description).replace('FluentRead', t('common.brand'))}`"
              :title="translateLegacy(skin.description).replace('FluentRead', t('common.brand'))"
              :data-skin="skin.value"
              @click="selectInterfaceSkin(skin.value)"
            >
              <span
                class="interface-skin-preview"
                :style="{
                  '--skin-preview-canvas': skin.preview.canvas,
                  '--skin-preview-surface': skin.preview.surface,
                  '--skin-preview-accent': skin.preview.accent,
                  '--skin-preview-ink': skin.preview.ink,
                  '--skin-preview-title': skin.preview.title,
                  '--skin-preview-action': skin.preview.action,
                  '--skin-preview-backdrop': skin.preview.backdrop,
                  '--skin-preview-border': skin.preview.border,
                  '--skin-preview-radius': `${skin.preview.radius}px`,
                }"
                aria-hidden="true"
              >
                <i class="interface-skin-preview-title" />
                <span class="interface-skin-preview-card"><i /><i /></span>
              </span>
              <span class="interface-skin-copy">
                <strong>{{ translateLegacy(skin.label) }}</strong>
              </span>
              <span class="interface-skin-radio" aria-hidden="true"><i /></span>
            </button>
          </div>
        </div>
      </div>
    </SettingsItem>

  </SettingsGroup>
</SettingsPanel>

  <SettingsPanel name="motion" :active="props.activePanel">
<TranslationLoadingStyleSettings :config="props.config" />
</SettingsPanel>

  <SettingsPanel name="layout" :active="props.activePanel">
<SettingsGroup
    v-if="browserCapabilities.browser !== 'userscript'"
    :title="t('settings.interface.popupLayout.label')"
    :description="t('settings.interface.popupLayout.description')"
  >
    <SidepanelScopeSetting v-if="SidepanelScopeSetting" :config="props.config" :active="layoutEditorActive" />
    <div class="interface-layout-settings">
      <div class="popup-layout-workbench" data-popup-layout-workbench>
        <div class="popup-layout-tabs" role="tablist" :aria-label="t('settings.interface.popupLayout.label')" @keydown="handleLayoutTabKeydown">
          <button
            id="popup-layout-modules-tab"
            type="button"
            role="tab"
            data-popup-layout-tab="popupModule"
            :aria-selected="activeLayoutPanel === 'popupModule'"
            :tabindex="activeLayoutPanel === 'popupModule' ? 0 : -1"
            aria-controls="popup-layout-modules-panel"
            @click="activeLayoutPanel = 'popupModule'"
          >
            {{ t('settings.interface.popupLayout.moduleTab') }}
          </button>
          <button
            id="popup-layout-features-tab"
            type="button"
            role="tab"
            data-popup-layout-tab="quickFeature"
            :aria-selected="activeLayoutPanel === 'quickFeature'"
            :tabindex="activeLayoutPanel === 'quickFeature' ? 0 : -1"
            aria-controls="popup-layout-features-panel"
            @click="activeLayoutPanel = 'quickFeature'"
          >
            {{ t('settings.interface.popupLayout.featureTab') }}
          </button>
        </div>
        <section class="popup-layout-preview-panel">
          <header class="popup-layout-panel-heading">
            <span>
              <strong>{{ t('settings.interface.popupLayout.previewTitle') }}</strong>
              <small>{{ t('settings.interface.popupLayout.previewDescription') }}</small>
            </span>
            <em>{{ translateLegacy(selectedSkinOption.label) }}</em>
          </header>
          <PopupLayoutPreview
            :skin="selectedSkinOption"
            :skin-label="translateLegacy(selectedSkinOption.label)"
            :module-items="popupModuleEditorItems"
            :module-order="props.config.popupModuleOrder"
            :quick-feature-items="popupQuickFeatureEditorItems"
            :quick-feature-order="props.config.popupQuickFeatureOrder"
            :edit-scope="activeLayoutPanel"
            @update:module-order="setPopupModuleOrder"
            @update:quick-feature-order="setPopupQuickFeatureOrder"
            @edit:scope="activeLayoutPanel = $event"
          />
        </section>

        <section class="popup-layout-control-panel">
          <div
            v-show="activeLayoutPanel === 'popupModule'"
            id="popup-layout-modules-panel"
            class="popup-layout-tab-panel"
            role="tabpanel"
            aria-labelledby="popup-layout-modules-tab"
          >
            <PopupLayoutEditor
              :items="popupModuleEditorItems"
              :order="props.config.popupModuleOrder"
              :default-order="DEFAULT_POPUP_MODULE_ORDER"
              scope="popupModule"
              copy-prefix="settings.interface.popupLayout"
              @update:order="setPopupModuleOrder"
              @update:visibility="setPopupModuleVisibility"
            />
          </div>

          <div
            v-show="activeLayoutPanel === 'quickFeature'"
            id="popup-layout-features-panel"
            class="popup-layout-tab-panel"
            role="tabpanel"
            aria-labelledby="popup-layout-features-tab"
          >
            <div v-if="!props.config.interfaceVisibility.popupQuickFeatures" class="popup-layout-section-hidden" role="status">
              <span>{{ t('settings.interface.popupLayout.featureSectionHidden') }}</span>
              <button type="button" @click="setPopupModuleVisibility('quickFeatures', true)">{{ t('settings.interface.popupLayout.addFeatureSection') }}</button>
            </div>
            <PopupLayoutEditor
              :items="popupQuickFeatureEditorItems"
              :order="props.config.popupQuickFeatureOrder"
              :default-order="DEFAULT_POPUP_QUICK_FEATURE_ORDER"
              scope="quickFeature"
              copy-prefix="settings.interface.popupLayout"
              @update:order="setPopupQuickFeatureOrder"
              @update:visibility="setPopupQuickFeatureVisibility"
            />
          </div>
        </section>
      </div>
    </div>
  </SettingsGroup>
  <SettingsGroup
    v-else
    data-userscript-unavailable="popup-layout"
    :title="t('settings.interface.popupLayout.label')"
    :description="t('options.userscriptUnavailableDescription')"
  />
</SettingsPanel>

  <SettingsPanel name="video-learning" :active="props.activePanel">
    <VideoSentenceLearningAppearanceSettings :config="props.config" data-settings-anchor="video-learning" />
  </SettingsPanel>

  <SettingsPanel name="font" :active="props.activePanel">
<SettingsGroup
    class="interface-font-group"
    :title="t('settings.interface.font.label')"
    :description="t('settings.interface.font.description')"
  >
    <div class="interface-font-settings">
      <div class="interface-font-picker" role="radiogroup" :aria-label="t('settings.interface.font.label')">
        <label
          v-for="font in interfaceFontOptions"
          :key="font.value"
          class="interface-font-option"
          :class="{ selected: props.config.interfaceFont === font.value }"
          :data-font="font.value"
        >
          <input
            :id="`interface-font-${font.value}`"
            :checked="props.config.interfaceFont === font.value"
            @change="selectInterfaceFont(font.value)"
            type="radio"
            name="interface-font"
            :value="font.value"
            :aria-label="t(font.labelKey)"
          />
          <span class="interface-font-copy" :style="{ fontFamily: font.fontFamily.replace(/FluentRead /g, 'FluentRead Preview ') }">
            <strong>{{ t(font.labelKey) }}</strong>
            <small>{{ t(font.descriptionKey) }}</small>
            <span class="interface-font-sample" aria-hidden="true">Aa Bb Cc · 0123456789</span>
          </span>
          <div class="interface-font-action-area">
            <div v-if="font.value === interfaceFontLoadState.font && interfaceFontLoadState.status === 'loading'" class="interface-font-card-status" role="status" aria-live="polite" :data-status="interfaceFontLoadState.status">
              <span>{{ fontStatusText }}</span>
              <progress :value="interfaceFontLoadState.loaded" :max="interfaceFontLoadState.total" :aria-label="t('settings.interface.font.downloading')" />
            </div>
            <div v-else-if="font.value === interfaceFontLoadState.font && interfaceFontLoadState.status === 'error'" class="interface-font-card-status is-error" role="status" aria-live="polite" :data-status="interfaceFontLoadState.status">
              <span>{{ fontStatusText }}</span>
              <button type="button" @click.stop.prevent="selectInterfaceFont(font.value)">{{ t('settings.interface.font.retry') }}</button>
            </div>
            <template v-else>
              <span v-if="font.value === props.config.interfaceFont" class="interface-font-action is-active">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
                {{ t('settings.interface.font.active') }}
              </span>
              <button v-else type="button" class="interface-font-action" :class="{'is-download': !availableInterfaceFonts.includes(font.value)}" @click.stop.prevent="selectInterfaceFont(font.value)">
                <svg v-if="!availableInterfaceFonts.includes(font.value)" class="interface-font-cloud" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 17H6a4 4 0 0 1-.6-7.95 6.5 6.5 0 0 1 12.5-1.9A5 5 0 0 1 19 17h-2M12 11v10m-3-3 3 3 3-3" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
                {{ t(availableInterfaceFonts.includes(font.value) ? 'settings.interface.font.useFont' : 'settings.interface.font.downloadAndUse') }}
              </button>
            </template>
            <button
              v-if="canClearFont(font.value)"
              type="button"
              class="interface-font-clear"
              :disabled="clearingFont !== null"
              :aria-label="`${t('settings.interface.font.clear', {size: clearFontSize(font.value)})} · ${t(font.labelKey)}`"
              :title="`${t('settings.interface.font.clear', {size: clearFontSize(font.value)})} · ${t(font.labelKey)}`"
              @click.stop.prevent="confirmClearFont(font.value)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5" /></svg>
              {{ clearingFont === font.value ? t('settings.interface.font.clearingCache') : clearFontSize(font.value) }}
            </button>
          </div>
        </label>
        <div class="interface-font-preview" :style="{ fontFamily: selectedFontOption.fontFamily.replace(/FluentRead /g, 'FluentRead Preview ') }">
          <span>{{ t('settings.interface.font.preview') }}</span>
          <small aria-hidden="true">Aa Bb Cc · 0123456789</small>
        </div>
        <p class="interface-font-note">{{ t('settings.interface.font.note') }}</p>
      </div>
    </div>
  </SettingsGroup>
</SettingsPanel>
  <el-dialog v-model="fontClearDialogOpen" :title="t('settings.interface.font.clearConfirmTitle')" width="min(460px, calc(100vw - 32px))" append-to-body destroy-on-close>
    <p>{{ t('settings.interface.font.clearConfirmMessage', {font: pendingFontLabel}) }}</p>
    <template #footer>
      <el-button @click="fontClearActions.cancel">{{ t('settings.interface.font.clearConfirmCancel') }}</el-button>
      <el-button type="primary" @click="fontClearActions.confirm">{{ t('settings.interface.font.clearConfirmButton') }}</el-button>
    </template>
  </el-dialog>
</template>

<script lang="ts" setup>
import './interface-font-previews.css'
import SettingsPanel from './components/SettingsPanel.vue'
import VideoSentenceLearningAppearanceSettings from './VideoSentenceLearningAppearanceSettings.vue'
import {computed, defineAsyncComponent, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue'
import {ElMessage} from 'element-plus'
import type {Config} from '@/src/core/config/model'
import {
  DEFAULT_POPUP_MODULE_ORDER,
  DEFAULT_POPUP_QUICK_FEATURE_ORDER,
  getInterfaceFontOption,
  getInterfaceSkinOption,
  interfaceFontOptions,
  interfaceSkinGroups,
  interfaceSkinOptions,
  normalizePopupModuleOrder,
  normalizePopupQuickFeatureOrder,
  popupModuleOptions,
  popupQuickFeatureOptions,
  withInterfaceVisibility,
  withPopupQuickFeatureVisibility,
  type InterfaceFont,
} from '@/src/core/config/interfaceAppearance'
import {useUiI18n} from '@/src/ui/i18n'
import {getClearableInterfaceFontAssets} from '@/src/core/config/interfaceFontAssets'
import {browserCapabilities} from '@/src/platform/browser/capabilities'
import {canOpenTranslationSidepanel} from '@/src/platform/browser/translationSidepanel'
import {availableInterfaceFonts, cachedInterfaceFonts, clearInterfaceFont, interfaceFontLoadState, refreshInterfaceFontAvailability, retryInterfaceFont} from '@/src/ui/interfaceAppearance'
import InterfaceSkinPreview from './components/InterfaceSkinPreview.vue'
import PopupLayoutPreview from './components/PopupLayoutPreview.vue'
import PopupLayoutEditor from './PopupLayoutEditor.vue'
import TranslationLoadingStyleSettings from './TranslationLoadingStyleSettings.vue'
import TranslationStyleSettings from './TranslationStyleSettings.vue'
import SentenceHighlightStyleSettings from './SentenceHighlightStyleSettings.vue'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'
const SidepanelScopeSetting = import.meta.env.BROWSER === 'userscript'
  || browserCapabilities.browser === 'firefox' || !canOpenTranslationSidepanel()
  ? null : defineAsyncComponent(() => import('./components/SidepanelScopeSetting.vue'))

const props = withDefaults(defineProps<{
  config: Config
  activePanel?: string
  active?: boolean
}>(), {active: true})
const {t, translateLegacy} = useUiI18n()
const viewActive = ref(true)
const settingsActive = computed(() => viewActive.value && props.active)
const fontEditorActive = computed(() => settingsActive.value && (!props.activePanel || props.activePanel === 'font'))
const layoutEditorActive = computed(() => settingsActive.value && (!props.activePanel || props.activePanel === 'layout'))
const skinEditorActive = computed(() => settingsActive.value && (!props.activePanel || props.activePanel === 'skin'))
function selectInterfaceSkin(skin: string): void {
  if (!skinEditorActive.value) return
  const option = interfaceSkinOptions.find(item => item.value === skin)
  if (option) props.config.interfaceSkin = option.value
}
function handleSkinKeydown(event: KeyboardEvent): void {
  if (!skinEditorActive.value || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const radios = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]'))
  if (!radios.length) return
  event.preventDefault()
  const focusedIndex = radios.indexOf(event.target as HTMLButtonElement)
  const selectedIndex = radios.findIndex(button => button.dataset.skin === props.config.interfaceSkin)
  const current = Math.max(0, focusedIndex >= 0 ? focusedIndex : selectedIndex)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1
    : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + radios.length) % radios.length
  selectInterfaceSkin(radios[next].dataset.skin || '')
  radios[next].focus()
}
const activeLayoutPanel = ref<'popupModule' | 'quickFeature'>('popupModule')
function handleLayoutTabKeydown(event: KeyboardEvent) {
  if (!layoutEditorActive.value) return
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  activeLayoutPanel.value = event.key === 'Home' ? 'popupModule'
    : event.key === 'End' ? 'quickFeature'
      : activeLayoutPanel.value === 'popupModule' ? 'quickFeature' : 'popupModule'
  const tabs = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')
  tabs[activeLayoutPanel.value === 'popupModule' ? 0 : 1]?.focus()
}
const selectedSkinOption = computed(() => getInterfaceSkinOption(props.config.interfaceSkin))
const selectedFontOption = computed(() => getInterfaceFontOption(props.config.interfaceFont))
function selectInterfaceFont(font: InterfaceFont) {
  if (!fontEditorActive.value) return
  if (font === props.config.interfaceFont) {
    if (interfaceFontLoadState.value.status === 'error') retryInterfaceFont()
    return
  }
  props.config.interfaceFont = font
}
const clearingFont = ref<InterfaceFont | null>(null)
const fontClearDialogOpen = ref(false)
let clearVersion = 0
type FontClearOperation = {font: InterfaceFont; config: Config; selectedFont: InterfaceFont; version: number; label: string}
const pendingClear = ref<FontClearOperation | null>(null)
const pendingFontLabel = computed(() => pendingClear.value?.label || '')
const fontClearActions = computed(() => {
  const operation = pendingClear.value
  return {confirm: () => performClearFont(operation), cancel: () => {
    if (pendingClear.value === operation) closeFontClearDialog()
  }}
})
function closeFontClearDialog(): void {pendingClear.value = null;fontClearDialogOpen.value = false}
function isCurrentClear(operation: FontClearOperation): boolean {
  return fontEditorActive.value && operation.version === clearVersion && operation.config === props.config
    && operation.selectedFont === props.config.interfaceFont
}
watch(() => [fontEditorActive.value, props.config, props.config.interfaceFont], () => {
  clearVersion++;closeFontClearDialog()
}, {flush: 'sync'})
watch(fontClearDialogOpen, open => {if (!open) pendingClear.value = null}, {flush: 'sync'})
watch(fontEditorActive, active => {if (active) void refreshInterfaceFontAvailability()}, {immediate: true})
onActivated(() => {viewActive.value = true})
onDeactivated(() => {viewActive.value = false})
onBeforeUnmount(() => {viewActive.value = false})
function clearFontSize(font: InterfaceFont): string {
  const bytes = getClearableInterfaceFontAssets(font, cachedInterfaceFonts.value).reduce((sum, asset) => sum + asset.bytes, 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function canClearFont(font: InterfaceFont): boolean {
  return font !== 'system'
    && cachedInterfaceFonts.value.includes(font)
    && getClearableInterfaceFontAssets(font, cachedInterfaceFonts.value).length > 0
    && !(interfaceFontLoadState.value.font === font && interfaceFontLoadState.value.status === 'loading')
}
function confirmClearFont(font: InterfaceFont): void {
  if (!fontEditorActive.value || !canClearFont(font) || clearingFont.value || fontClearDialogOpen.value) return
  const option = interfaceFontOptions.find(item => item.value === font)
  const label = option ? t(option.labelKey) : font
  pendingClear.value = {font, config: props.config, selectedFont: props.config.interfaceFont, version: ++clearVersion, label}
  fontClearDialogOpen.value = true
}
async function performClearFont(operation: FontClearOperation | null = pendingClear.value): Promise<void> {
  if (!operation || operation !== pendingClear.value || !fontClearDialogOpen.value || clearingFont.value || !isCurrentClear(operation) || !canClearFont(operation.font)) return
  clearingFont.value = operation.font
  closeFontClearDialog()
  try {
    await clearInterfaceFont(operation.font)
    if (!isCurrentClear(operation)) return
    if (props.config.interfaceFont === operation.font) props.config.interfaceFont = 'system'
    ElMessage({message: t('settings.interface.font.clearSuccess', {font: operation.label}), type: 'success', duration: 1800})
  } catch {
    if (isCurrentClear(operation)) ElMessage({message: t('settings.interface.font.clearFailed', {font: operation.label}), type: 'error', duration: 2200})
  } finally {
    clearingFont.value = null
  }
}
const fontStatusText = computed(() => {
  const state = interfaceFontLoadState.value
  if (state.status === 'system') return t('settings.interface.font.noDownload')
  if (state.status === 'error') return t('settings.interface.font.failed')
  if (state.status === 'ready') return t(state.persistent ? 'settings.interface.font.saved' : 'settings.interface.font.sessionOnly')
  return `${t('settings.interface.font.downloading')} ${Math.floor(state.loaded / Math.max(1, state.total) * 100)}%`
})

const groupedSkinOptions = interfaceSkinGroups.map((group) => ({
  ...group,
  options: interfaceSkinOptions.filter((skin) => skin.group === group.value),
}))

const popupModuleEditorItems = computed(() => popupModuleOptions.map((module) => ({
  id: module.id,
  label: t(module.labelKey),
  description: t(module.descriptionKey),
  visible: module.visibilityKey ? props.config.interfaceVisibility[module.visibilityKey] : true,
  required: module.required,
})))

const popupQuickFeatureEditorItems = computed(() => popupQuickFeatureOptions.map((feature) => ({
  id: feature.id,
  label: t(feature.labelKey),
  description: t(feature.descriptionKey),
  visible: props.config.popupQuickFeatureVisibility[feature.id],
})))

function setPopupModuleOrder(order: string[]) {
  if (!layoutEditorActive.value) return
  props.config.popupModuleOrder = normalizePopupModuleOrder(order)
}

function setPopupModuleVisibility(moduleId: string, visible: boolean) {
  if (!layoutEditorActive.value) return
  const module = popupModuleOptions.find((item) => item.id === moduleId)
  if (!module?.visibilityKey) return
  props.config.interfaceVisibility = withInterfaceVisibility(
    props.config.interfaceVisibility,
    module.visibilityKey,
    visible,
  )
}

function setPopupQuickFeatureOrder(order: string[]) {
  if (!layoutEditorActive.value) return
  props.config.popupQuickFeatureOrder = normalizePopupQuickFeatureOrder(order)
}

function setPopupQuickFeatureVisibility(featureId: string, visible: boolean) {
  if (!layoutEditorActive.value) return
  const feature = popupQuickFeatureOptions.find((item) => item.id === featureId)
  if (!feature) return
  props.config.popupQuickFeatureVisibility = withPopupQuickFeatureVisibility(
    props.config.popupQuickFeatureVisibility,
    feature.id,
    visible,
  )
}
</script>

<style scoped>
.interface-layout-settings {
  padding: 12px 16px;
}

/* 左列由预览自身的真实菜单栏宽度决定，右侧的风格列表占用其余空间。 */
.interface-appearance-settings {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 24px;
}

.interface-appearance-settings:hover { background: transparent; }
.interface-appearance-settings :deep(.settings-item-copy) { position: sticky; top: 0; }

.interface-font-settings { padding: 12px 16px; }

.interface-font-picker {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}

.interface-font-option {
  display: grid;
  min-width: 0;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: start;
  gap: 6px 8px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 12px;
  color: var(--ink);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease;
}

.interface-font-option:hover { border-color: var(--brand); }
.interface-font-option.selected { border-color: var(--brand); background: var(--brand-soft); }
.interface-font-option:has(input:focus-visible) { outline: 2px solid var(--brand); outline-offset: 2px; }
.interface-font-option input { width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--brand); cursor: pointer; }

.interface-font-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; cursor: pointer; }
.interface-font-action-area { grid-column: 2; display: flex; min-width: 0; align-items: center; align-self: end; flex-wrap: wrap; gap: 4px 8px; }
.interface-font-action { display: inline-flex; align-items: center; justify-content: center; gap: 4px; width: fit-content; max-width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; font-size: 10px; line-height: 1.4; background: var(--surface); color: var(--brand); cursor: pointer; }
.interface-font-action.is-download { background: var(--brand-soft); border-color: transparent; }
.interface-font-option:hover .interface-font-action:not(.is-active) { border-color: var(--brand); }
.interface-font-action.is-active { cursor: default; color: var(--muted); background: transparent; border-color: transparent; }
.interface-font-action svg { width: 14px; height: 14px; flex-shrink: 0; }
.interface-font-clear { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 0; border: 0; border-radius: 6px; padding: 3px 4px; color: var(--muted); background: transparent; cursor: pointer; font-size: 10px; line-height: 1.4; }
.interface-font-clear:hover:not(:disabled) { border-color: #e69bad; color: var(--brand-strong); background: var(--brand-soft); }
.interface-font-clear:disabled { opacity: .55; cursor: wait; }
.interface-font-clear svg { width: 15px; height: 15px; flex: 0 0 15px; }
.interface-font-card-status { display: grid; flex: 1 1 100%; min-width: 0; gap: 5px; color: var(--brand-strong); font-size: 10.5px; line-height: 1.45; }
.interface-font-card-status > span { overflow-wrap: anywhere; }
.interface-font-card-status progress { width: 100%; height: 5px; accent-color: var(--brand); }
.interface-font-card-status.is-error { color: var(--brand-strong); }
.interface-font-card-status button { width: fit-content; border: 1px solid var(--line); border-radius: 7px; padding: 4px 8px; color: var(--brand-strong); background: var(--surface); cursor: pointer; font-size: 10.5px; }
.interface-font-card-status button:hover { border-color: var(--brand); background: var(--brand-soft); }
.interface-font-copy strong { overflow-wrap: anywhere; font-size: 12px; font-weight: 700; line-height: 1.35; }
.interface-font-copy small { color: var(--muted); font-size: 10.5px; font-weight: 400; line-height: 1.4; }
.interface-font-sample { margin-top: 2px; color: var(--ink); font-size: 12px; font-weight: 400; line-height: 1.5; overflow-wrap: anywhere; }

.interface-font-preview {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px 20px;
  padding: 12px 14px;
  border-radius: 10px;
  color: var(--ink);
  background: var(--surface-soft);
  overflow-wrap: anywhere;
  font-size: 17px;
  font-weight: 400;
  line-height: 1.6;
}

.interface-font-preview small { color: var(--muted); font-size: 13px; }
.interface-font-note { grid-column: 1 / -1; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.6; }

.interface-skin-picker {
  display: grid;
  width: 100%;
  gap: 12px;
}

.interface-skin-current { display: grid; gap: 4px; padding: 0 2px 4px; }
.interface-skin-current strong { color: var(--ink); font-size: 13px; font-weight: 600; line-height: 1.45; }
.interface-skin-current p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }

.popup-layout-workbench {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(290px, 1fr);
  align-items: start;
  gap: 14px;
}

.popup-layout-preview-panel,
.popup-layout-control-panel {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-soft);
}

.popup-layout-preview-panel {
  display: grid;
  gap: 12px;
}

.popup-layout-panel-heading {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.popup-layout-panel-heading > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.popup-layout-panel-heading strong {
  color: var(--ink);
  font-size: 11.5px;
}

.popup-layout-panel-heading small {
  color: var(--muted);
  font-size: 8.5px;
  line-height: 1.4;
}

.popup-layout-panel-heading em {
  flex: none;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--brand-strong);
  background: var(--brand-soft);
  font-size: 8px;
  font-style: normal;
  font-weight: 750;
  white-space: nowrap;
}

.popup-layout-control-panel {
  background: var(--surface);
}

.popup-layout-tabs {
  grid-column: 1 / -1;
  width: min(100%, 420px);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  background: var(--surface-soft);
}

@media (max-width: 1050px) {
  .interface-font-picker { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 700px) {
  .interface-font-picker { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .interface-font-settings { padding: 12px; }
}

@media (max-width: 460px) {
  .interface-font-picker { grid-template-columns: minmax(0, 1fr); }
}

.popup-layout-tabs button {
  min-width: 0;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  color: var(--muted);
  background: transparent;
  font: inherit;
  font-size: 10px;
  font-weight: 750;
  cursor: pointer;
  transition: color 140ms ease, background 140ms ease, box-shadow 140ms ease;
}

.popup-layout-tabs button:hover {
  color: var(--ink);
}

.popup-layout-tabs button[aria-selected="true"] {
  color: var(--brand-strong);
  background: var(--surface);
  box-shadow: 0 3px 10px rgba(31, 40, 61, .07);
}

.popup-layout-tabs button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 40%, transparent);
  outline-offset: 1px;
}

.popup-layout-tab-panel {
  margin-top: 0;
}

.interface-skin-group {
  display: grid;
  gap: 7px;
}

.interface-skin-group-heading {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 0 2px;
}

.interface-skin-group-heading strong {
  flex: none;
  color: var(--ink);
  font-size: 12px;
}

.interface-skin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 152px), 1fr));
  gap: 7px;
}

.interface-skin-option {
  position: relative;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 64px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  text-align: start;
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}

.interface-skin-option:hover {
  border-color: var(--brand);
  background: var(--surface-soft);
}

.interface-skin-option:focus-visible { outline: 2px solid var(--brand-strong); outline-offset: 2px; }

.interface-skin-option.selected {
  border-color: var(--brand);
  background: var(--brand-soft);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 10%, transparent);
}

/* 缩略图是一个极简菜单栏：画布背景、品牌行、一张卡片和主按钮；卡片的描边与圆角体现各风格的造型，取值来自注册表而不是当前皮肤。 */
.interface-skin-preview {
  display: flex;
  width: 40px;
  height: 46px;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
  padding: 5px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--skin-preview-ink) 16%, transparent);
  border-radius: 6px;
  background: var(--skin-preview-backdrop);
}

.interface-skin-preview-title {
  display: block;
  width: 46%;
  height: 3px;
  border-radius: 2px;
  background: var(--skin-preview-title);
}

.interface-skin-preview-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 3px;
  border: 1px solid var(--skin-preview-border);
  border-radius: var(--skin-preview-radius);
  background: var(--skin-preview-surface);
}

.interface-skin-preview-card > i {
  display: block;
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--skin-preview-ink) 16%, var(--skin-preview-surface));
}

.interface-skin-preview-card > i:last-child {
  height: 8px;
  border-radius: min(3px, var(--skin-preview-radius));
  background: var(--skin-preview-action);
}

.interface-skin-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.interface-skin-copy strong {
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.interface-skin-radio {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: 1px solid #b9c0cd;
  border-radius: 999px;
  background: var(--surface);
}

.interface-skin-option.selected .interface-skin-radio {
  border-color: var(--brand);
  background: var(--brand);
}

.interface-skin-radio > i {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: #fff;
  opacity: 0;
}

.interface-skin-option.selected .interface-skin-radio > i {
  opacity: 1;
}

@media (max-width: 1100px) {
  .interface-appearance-settings { grid-template-columns: minmax(0, 1fr); }
  .interface-appearance-settings :deep(.settings-item-copy) { position: static; order: 2; }
  .interface-appearance-settings :deep(.settings-item-control) { justify-content: stretch; order: 1; }
}

@media (max-width: 520px) {
  .popup-layout-workbench {
    grid-template-columns: minmax(0, 1fr);
  }

  .interface-skin-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .interface-skin-option { gap: 6px; }
  .interface-skin-copy strong { font-size: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .interface-skin-option { transition: none; }
}

@media (min-width: 521px) and (max-width: 900px) {
  .popup-layout-workbench {
    grid-template-columns: minmax(0, 1fr);
  }

  .popup-layout-live-preview {
    max-width: 360px;
  }
}
.popup-layout-section-hidden { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; padding: 10px; border-radius: 10px; color: var(--muted); background: var(--surface-soft); font-size: 11px; line-height: 1.5; }
.popup-layout-section-hidden button { flex: none; border: 0; border-radius: 6px; padding: 4px 6px; color: var(--brand-strong); background: var(--brand-soft); font: inherit; cursor: pointer; }
@media (max-width: 520px) {
  .interface-layout-settings { padding: 10px; }
  .popup-layout-section-hidden { flex-direction: column; }
}
</style>

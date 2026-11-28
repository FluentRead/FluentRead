<!--
 * @file src/features/settings/ui/InterfaceSettings.vue
 * 文件职责：组织译文样式、Popup 专属皮肤展台、动画加载效果、菜单栏布局与界面字体及逐句高亮、完整句学习外观分组，其中网页译文样式排在第一位，完整句学习外观紧随菜单栏布局。
 * 主要内容：Popup 皮肤面板采用双栏 Studio 展台：左侧粘性 1:1 实时 Popup 舞台（支持浅/深/跟随预览切换与悬停即时预演且零配置污染），右侧提供系列筛选与纯 CSS 微缩弹窗卡片网格（支持鼠标悬停零闪烁预览、键盘二维方向导航与 Home/End、一键恢复默认），并确保皮肤仅作用于 Popup 与局部 `.popup-skin-scope` 预览容器而不影响设置页本体；菜单栏布局与字体下载、重试、确认清除均保留完整生命周期保护。
 * 侧边栏：在菜单栏布局中为支持原生侧边栏的 Chromium 宿主提供显示范围选择。
 * 模块边界：本组件只负责界面配置的展示与双向绑定，不直接读写浏览器存储、不负责全局主题切换，也不关闭翻译功能本身；译文样式细节由 TranslationStyleSettings 负责。
-->
<template>
  <SettingsPanel name="translation" :active="props.activePanel">
    <TranslationStyleSettings :config="props.config" />
  </SettingsPanel>

  <SettingsPanel name="skin" :active="props.activePanel">
    <SettingsGroup
      class="popup-skin-studio-group"
      :title="translateLegacy('界面与弹窗')"
      :description="t('settings.interface.skinStudio.description')"
    >
      <template v-if="props.config.interfaceSkin !== 'default'" #heading-extra>
        <button
          type="button"
          class="popup-skin-reset-btn"
          data-skin-reset
          @click="selectInterfaceSkin('default')"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3.2 6.2A5.2 5.2 0 1 1 4.2 11.4M3 3v3.5h3.5" />
          </svg>
          <span>{{ t('settings.interface.skinStudio.resetDefault') }}</span>
        </button>
      </template>

      <div class="popup-skin-studio">
        <InterfaceSkinPreview
          :skin="activePreviewSkin"
          :preview-label="`${translateLegacy('弹窗风格')}: ${translateLegacy(activePreviewSkin.label)}`"
          :theme-mode="previewThemeMode"
          :app-dark="appDark"
          :previewing="isHoverPreviewing"
          @update:theme-mode="previewThemeMode = $event"
        />

        <div class="skin-gallery" @pointerleave="clearGalleryHover">
          <div class="skin-filter-bar" role="group" :aria-label="translateLegacy('弹窗风格')">
            <button
              type="button"
              class="skin-filter-pill"
              data-skin-collection="all"
              :aria-pressed="activeCollection === 'all'"
              @click="activeCollection = 'all'"
            >
              {{ t('settings.interface.skinStudio.allCollections') }}
              <span>{{ interfaceSkinOptions.length }}</span>
            </button>
            <button
              v-for="group in groupedSkinOptions"
              :key="group.value"
              type="button"
              class="skin-filter-pill"
              :data-skin-collection="group.value"
              :aria-pressed="activeCollection === group.value"
              @click="activeCollection = group.value"
            >
              {{ translateLegacy(group.label) }}
              <span>{{ group.options.length }}</span>
            </button>
          </div>

          <div
            class="interface-skin-picker"
            role="radiogroup"
            :aria-label="translateLegacy('弹窗风格')"
            @keydown="handleSkinKeydown"
          >
            <div
              v-for="group in displayedSkinGroups"
              :key="group.value"
              class="interface-skin-group"
              role="group"
              :aria-labelledby="activeCollection === 'all' ? `interface-skin-group-${group.value}` : undefined"
            >
              <div v-if="activeCollection === 'all'" class="interface-skin-group-heading">
                <strong :id="`interface-skin-group-${group.value}`">{{ translateLegacy(group.label) }}</strong>
                <small>{{ translateLegacy(group.description) }}</small>
              </div>
              <div class="interface-skin-grid">
                <button
                  v-for="skin in group.options"
                  :key="skin.value"
                  class="interface-skin-option"
                  :class="{
                    selected: props.config.interfaceSkin === skin.value,
                    previewing: activePreviewSkin.value === skin.value && props.config.interfaceSkin !== skin.value,
                  }"
                  type="button"
                  role="radio"
                  :aria-checked="props.config.interfaceSkin === skin.value"
                  :tabindex="getSkinTabindex(skin.value)"
                  :aria-label="`${translateLegacy(skin.label)}: ${translateLegacy(skin.description).replace('FluentRead', t('common.brand'))}`"
                  :title="translateLegacy(skin.description).replace('FluentRead', t('common.brand'))"
                  :data-skin="skin.value"
                  @click="selectInterfaceSkin(skin.value)"
                  @pointerenter="handleSkinPointerEnter($event, skin.value)"
                  @pointerleave="handleSkinPointerLeave(skin.value)"
                  @focus="handleSkinFocus(skin.value)"
                  @blur="handleSkinBlur(skin.value)"
                >
                  <span
                    class="skin-card-stage"
                    :data-card-style="skin.preview.cardStyle"
                    :data-card-dark="skin.toneMode === 'dark' || effectiveStudioTheme === 'dark' ? 'true' : 'false'"
                    :style="getCardPreviewVars(skin)"
                    aria-hidden="true"
                  >
                    <span
                      class="skin-mini-popup"
                      :data-frameless="skin.preview.framelessHero ? 'true' : undefined"
                      :data-dense="skin.preview.dense ? 'true' : undefined"
                      :data-icon-shape="skin.preview.iconShape"
                    >
                      <span class="skin-mini-header">
                        <span class="skin-mini-brand"><i /><b /></span>
                        <span class="skin-mini-chip" />
                      </span>
                      <span class="skin-mini-hero">
                        <span class="skin-mini-langs"><i /><i /></span>
                        <span class="skin-mini-cta"><i /></span>
                      </span>
                      <span class="skin-mini-tiles">
                        <span><i /><b /></span>
                        <span><i /><b /></span>
                      </span>
                    </span>
                    <span v-if="skin.toneMode === 'dark'" class="skin-card-dark-badge">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M13 9.7A5.2 5.2 0 0 1 6.3 3a5.4 5.4 0 1 0 6.7 6.7Z" />
                      </svg>
                    </span>
                  </span>

                  <span class="skin-card-footer">
                    <span class="skin-card-title-row interface-skin-copy">
                      <strong>{{ translateLegacy(skin.label) }}</strong>
                      <span class="skin-card-check" aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                        </svg>
                      </span>
                    </span>
                    <span class="skin-card-meta-row">
                      <span class="skin-card-swatches" aria-hidden="true">
                        <i :style="{ background: getCardTone(skin).swatches[0] }" />
                        <i :style="{ background: getCardTone(skin).swatches[1] }" />
                        <i :style="{ background: getCardTone(skin).swatches[2] }" />
                      </span>
                      <span class="skin-card-tag">{{ translateLegacy(skin.badge) }}</span>
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </div>
          <span class="sr-only" aria-live="polite">{{ skinAnnouncement }}</span>
        </div>
      </div>
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
              :app-dark="appDark"
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
  type InterfaceSkin,
  type InterfaceSkinGroupId,
  type InterfaceSkinOption,
} from '@/src/core/config/interfaceAppearance'
import {useUiI18n} from '@/src/ui/i18n'
import {getClearableInterfaceFontAssets} from '@/src/core/config/interfaceFontAssets'
import {browserCapabilities} from '@/src/platform/browser/capabilities'
import {canOpenTranslationSidepanel} from '@/src/platform/browser/translationSidepanel'
import {availableInterfaceFonts, cachedInterfaceFonts, clearInterfaceFont, interfaceFontLoadState, refreshInterfaceFontAvailability, retryInterfaceFont} from '@/src/ui/interfaceAppearance'
import InterfaceSkinPreview, {type SkinPreviewThemeMode} from './components/InterfaceSkinPreview.vue'
import PopupLayoutPreview from './components/PopupLayoutPreview.vue'
import PopupLayoutEditor from './PopupLayoutEditor.vue'
import TranslationLoadingStyleSettings from './TranslationLoadingStyleSettings.vue'
import TranslationStyleSettings from './TranslationStyleSettings.vue'
import SettingsGroup from './components/SettingsGroup.vue'
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

const systemThemeMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null
const systemDark = ref(Boolean(systemThemeMedia?.matches))
function handleSystemThemeChange(event: MediaQueryListEvent): void {
  systemDark.value = event.matches
}
systemThemeMedia?.addEventListener('change', handleSystemThemeChange)

const appDark = computed(() => props.config.theme === 'dark' || ((!props.config.theme || props.config.theme === 'auto') && systemDark.value))
const previewThemeMode = ref<SkinPreviewThemeMode>('auto')
const effectiveStudioTheme = computed<'light' | 'dark'>(() => previewThemeMode.value === 'auto' ? (appDark.value ? 'dark' : 'light') : previewThemeMode.value)

const activeCollection = ref<'all' | InterfaceSkinGroupId>('all')
const hoveredSkinId = ref<InterfaceSkin | null>(null)
const focusedSkinId = ref<InterfaceSkin | null>(null)
const skinAnnouncement = ref('')
let hoverLeaveTimer: ReturnType<typeof setTimeout> | null = null

function cancelHoverLeave(): void {
  if (hoverLeaveTimer !== null) {
    clearTimeout(hoverLeaveTimer)
    hoverLeaveTimer = null
  }
}

function clearGalleryHover(): void {
  cancelHoverLeave()
  hoveredSkinId.value = null
}

function handleSkinPointerEnter(event: PointerEvent, skin: InterfaceSkin): void {
  if (event.pointerType !== 'mouse' || !skinEditorActive.value) return
  cancelHoverLeave()
  hoveredSkinId.value = skin
}

function handleSkinPointerLeave(skin: InterfaceSkin): void {
  if (hoveredSkinId.value !== skin) return
  cancelHoverLeave()
  hoverLeaveTimer = setTimeout(() => {
    hoverLeaveTimer = null
    if (hoveredSkinId.value === skin) hoveredSkinId.value = null
  }, 80)
}

function handleSkinFocus(skin: InterfaceSkin): void {
  if (!skinEditorActive.value) return
  focusedSkinId.value = skin
}

function handleSkinBlur(skin: InterfaceSkin): void {
  if (focusedSkinId.value === skin) focusedSkinId.value = null
}

const selectedSkinOption = computed(() => getInterfaceSkinOption(props.config.interfaceSkin))
const activePreviewSkin = computed(() => getInterfaceSkinOption(hoveredSkinId.value ?? focusedSkinId.value ?? props.config.interfaceSkin))
const isHoverPreviewing = computed(() => activePreviewSkin.value.value !== selectedSkinOption.value.value)

const groupedSkinOptions = interfaceSkinGroups.map((group) => ({
  ...group,
  options: interfaceSkinOptions.filter((skin) => skin.group === group.value),
}))

const displayedSkinGroups = computed(() => activeCollection.value === 'all'
  ? groupedSkinOptions
  : groupedSkinOptions.filter((group) => group.value === activeCollection.value))

const visibleSkinValues = computed(() => displayedSkinGroups.value.flatMap((group) => group.options.map((skin) => skin.value)))

function getSkinTabindex(skinValue: InterfaceSkin): number {
  if (visibleSkinValues.value.includes(props.config.interfaceSkin)) {
    return props.config.interfaceSkin === skinValue ? 0 : -1
  }
  return visibleSkinValues.value[0] === skinValue ? 0 : -1
}

function getCardTone(skin: InterfaceSkinOption) {
  return skin.toneMode === 'dark' || effectiveStudioTheme.value === 'dark' ? skin.preview.dark : skin.preview.light
}

function getCardPreviewVars(skin: InterfaceSkinOption): Record<string, string> {
  const tone = getCardTone(skin)
  return {
    '--mini-mat': tone.mat,
    '--mini-canvas': tone.canvas,
    '--mini-surface': tone.surface,
    '--mini-soft': tone.surfaceSoft,
    '--mini-border': tone.border,
    '--mini-ink': tone.ink,
    '--mini-accent': tone.accent,
    '--mini-action': tone.actionBg,
    '--mini-action-ink': tone.actionInk,
    '--mini-icon-fg': tone.iconFg,
    '--mini-panel-radius': `${skin.preview.panelRadius}px`,
    '--mini-control-radius': `${skin.preview.controlRadius}px`,
    '--mini-border-width': `${skin.preview.borderWidth}px`,
  }
}

function selectInterfaceSkin(skin: string): void {
  if (!skinEditorActive.value) return
  const option = interfaceSkinOptions.find(item => item.value === skin)
  if (!option) return
  props.config.interfaceSkin = option.value
  clearGalleryHover()
  skinAnnouncement.value = t('settings.interface.skinStudio.appliedAnnouncement', {name: translateLegacy(option.label)})
}

function findVerticalRadio(radios: HTMLButtonElement[], current: number, direction: -1 | 1): number {
  const hasLayout = typeof radios[current]?.getBoundingClientRect === 'function'
    && radios.some((el) => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
  if (!hasLayout) return (current + direction + radios.length) % radios.length
  const currentRect = radios[current].getBoundingClientRect()
  const centerX = currentRect.left + currentRect.width / 2
  const candidates = radios
    .map((el, index) => ({index, rect: el.getBoundingClientRect()}))
    .filter(({rect}) => direction > 0 ? rect.top >= currentRect.bottom - 4 : rect.bottom <= currentRect.top + 4)
  if (!candidates.length) return direction > 0 ? 0 : radios.length - 1
  const targetRowY = direction > 0
    ? Math.min(...candidates.map(c => c.rect.top))
    : Math.max(...candidates.map(c => c.rect.top))
  const row = candidates.filter(c => Math.abs(c.rect.top - targetRowY) < 16)
  row.sort((a, b) => Math.abs((a.rect.left + a.rect.width / 2) - centerX) - Math.abs((b.rect.left + b.rect.width / 2) - centerX))
  return row[0].index
}

function handleSkinKeydown(event: KeyboardEvent): void {
  if (!skinEditorActive.value || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const radios = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]'))
  if (!radios.length) return
  event.preventDefault()
  const focusedIndex = radios.indexOf(event.target as HTMLButtonElement)
  const selectedIndex = radios.findIndex(button => button.dataset.skin === props.config.interfaceSkin)
  const current = Math.max(0, focusedIndex >= 0 ? focusedIndex : selectedIndex)
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? radios.length - 1
      : event.key === 'ArrowUp' ? findVerticalRadio(radios, current, -1)
        : event.key === 'ArrowDown' ? findVerticalRadio(radios, current, 1)
          : (current + (event.key === 'ArrowLeft' ? -1 : 1) + radios.length) % radios.length
  selectInterfaceSkin(radios[next].dataset.skin || '')
  radios[next].focus()
}

watch(activeCollection, () => {
  clearGalleryHover()
  focusedSkinId.value = null
})

watch(skinEditorActive, (active) => {
  if (!active) {
    clearGalleryHover()
    focusedSkinId.value = null
  }
})

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
onDeactivated(() => {viewActive.value = false;clearGalleryHover();focusedSkinId.value = null})
onBeforeUnmount(() => {
  viewActive.value = false
  clearGalleryHover()
  focusedSkinId.value = null
  systemThemeMedia?.removeEventListener('change', handleSystemThemeChange)
})
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

<style scoped src="./interface-settings.css"></style>

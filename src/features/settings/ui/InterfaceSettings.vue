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

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.popup-skin-studio-group :deep(.settings-group-body) {
  overflow: clip;
}

.popup-skin-reset-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--fr-control-radius, 8px);
  color: var(--muted);
  background: var(--surface);
  font: inherit;
  font-size: var(--fr-text-sm, 12px);
  font-weight: 550;
  cursor: pointer;
  transition: border-color 120ms var(--fr-ease-out, ease), color 120ms var(--fr-ease-out, ease), background-color 120ms var(--fr-ease-out, ease);
}

.popup-skin-reset-btn svg {
  width: 14px;
  height: 14px;
  flex: none;
}

.popup-skin-reset-btn:hover {
  border-color: color-mix(in srgb, var(--brand) 42%, var(--line));
  color: var(--brand-strong);
  background: var(--brand-soft);
}

.popup-skin-reset-btn:focus-visible {
  outline: 2px solid var(--brand-strong);
  outline-offset: 2px;
}

/* === Popup Skin Studio 双栏展台 === */
.popup-skin-studio {
  --studio-stage-width: 372px;
  display: grid;
  grid-template-columns: var(--studio-stage-width) minmax(0, 1fr);
  align-items: start;
  gap: 24px;
  padding: 20px;
}

:root:is(:lang(en), :lang(fr), :lang(ru), :lang(es)) .popup-skin-studio {
  --studio-stage-width: 416px;
}

.skin-gallery {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 16px;
}

.skin-filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.skin-filter-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--fr-radius-full, 9999px);
  color: var(--muted);
  background: var(--surface);
  font: inherit;
  font-size: var(--fr-text-sm, 12px);
  font-weight: 550;
  cursor: pointer;
  transition: border-color 120ms var(--fr-ease-out, ease), color 120ms var(--fr-ease-out, ease), background-color 120ms var(--fr-ease-out, ease);
}

.skin-filter-pill > span {
  font-size: var(--fr-text-xs, 11px);
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}

.skin-filter-pill:hover {
  color: var(--ink);
  border-color: var(--fr-color-line-strong, var(--line));
}

.skin-filter-pill[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--brand) 36%, var(--line));
  color: var(--brand-strong);
  background: var(--brand-soft);
  font-weight: 600;
}

.skin-filter-pill:focus-visible {
  outline: 2px solid var(--brand-strong);
  outline-offset: 2px;
}

.interface-skin-picker {
  display: grid;
  width: 100%;
  gap: 12px;
}

.interface-skin-group {
  display: grid;
  gap: 6px;
}

.interface-skin-group-heading {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 10px;
  padding: 0 2px;
}

.interface-skin-group-heading strong {
  color: var(--ink);
  font-size: var(--fr-text-sm, 12px);
  font-weight: 650;
}

.interface-skin-group-heading small {
  color: var(--muted);
  font-size: var(--fr-text-xs, 11px);
}

.interface-skin-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

/* === 纯 CSS 微缩弹窗皮肤卡 === */
.interface-skin-option {
  position: relative;
  display: flex;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  align-items: stretch;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--fr-radius-lg, 12px);
  color: var(--ink);
  background: var(--surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
  contain: layout style paint;
  transition: transform 140ms var(--fr-ease-out, ease), border-color 140ms var(--fr-ease-out, ease), box-shadow 140ms var(--fr-ease-out, ease);
}

.interface-skin-option:hover,
.interface-skin-option.previewing {
  border-color: color-mix(in srgb, var(--brand) 50%, var(--line));
}

.interface-skin-option:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px -12px rgba(23, 32, 51, 0.28);
}

:root.dark .interface-skin-option:hover {
  box-shadow: 0 10px 24px -10px rgba(0, 0, 0, 0.65);
}

.interface-skin-option:active {
  transform: translateY(0) scale(0.985);
}

.interface-skin-option.selected {
  border-color: var(--brand);
  box-shadow: 0 0 0 1px var(--brand), 0 6px 18px -10px color-mix(in srgb, var(--brand) 34%, transparent);
}

.interface-skin-option:focus-visible {
  outline: var(--fr-focus-width, 2px) solid var(--fr-focus-color, var(--brand-strong));
  outline-offset: 2px;
}

.skin-card-stage {
  position: relative;
  display: grid;
  width: 100%;
  box-sizing: border-box;
  height: 76px;
  padding: 8px 8px 0;
  align-items: end;
  justify-items: center;
  overflow: hidden;
  border-bottom: 1px solid var(--line);
  background: var(--mini-mat, var(--surface-soft));
  contain: layout style paint;
}

.skin-mini-popup {
  display: flex;
  width: min(100%, 138px);
  box-sizing: border-box;
  height: 68px;
  flex-direction: column;
  gap: 3px;
  padding: 5px 5px 4px;
  border: max(1px, var(--mini-border-width, 1px)) solid var(--mini-border);
  border-bottom: 0;
  border-radius: var(--mini-panel-radius, 6px) var(--mini-panel-radius, 6px) 0 0;
  background: var(--mini-canvas);
  box-shadow: 0 4px 12px -3px rgba(0, 0, 0, 0.14);
  transition: transform 160ms var(--fr-ease-out, ease);
}

.interface-skin-option:hover .skin-mini-popup {
  transform: translateY(-2px);
}

.skin-mini-popup[data-frameless="true"] {
  border-color: color-mix(in srgb, var(--mini-ink) 12%, transparent);
}

.skin-mini-popup[data-dense="true"] {
  gap: 2px;
  padding: 4px;
}

.skin-mini-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.skin-mini-brand {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.skin-mini-brand > i {
  width: 7px;
  height: 7px;
  border-radius: 2.5px;
  background: #ef4776;
}

.skin-mini-brand > b {
  width: 22px;
  height: 3px;
  border-radius: 2px;
  background: var(--mini-ink);
  opacity: 0.85;
}

.skin-mini-chip {
  width: 14px;
  height: 5px;
  border: max(1px, var(--mini-border-width, 1px)) solid var(--mini-border);
  border-radius: var(--mini-control-radius, 3px);
  background: var(--mini-surface);
}

.skin-mini-popup[data-frameless="true"] .skin-mini-chip {
  border-color: transparent;
  background: var(--mini-soft);
}

.skin-mini-hero {
  display: flex;
  flex-direction: column;
  gap: 2.5px;
  padding: 3.5px;
  border: var(--mini-border-width, 1px) solid var(--mini-border);
  border-radius: var(--mini-panel-radius, 5px);
  background: var(--mini-surface);
}

.skin-mini-popup[data-frameless="true"] .skin-mini-hero {
  padding: 1px 0;
  border: 0;
  background: transparent;
}

.skin-mini-popup[data-dense="true"] .skin-mini-hero {
  gap: 2px;
  padding: 3px;
}

.skin-mini-langs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
}

.skin-mini-langs > i {
  display: block;
  height: 5px;
  border-radius: var(--mini-control-radius, 3px);
  background: var(--mini-soft);
}

.skin-mini-popup[data-dense="true"] .skin-mini-langs > i {
  height: 4px;
}

.skin-mini-cta {
  display: grid;
  height: 8px;
  place-items: center;
  border-radius: var(--mini-control-radius, 3px);
  background: var(--mini-action);
}

.skin-mini-popup[data-dense="true"] .skin-mini-cta {
  height: 7px;
}

.skin-mini-cta > i {
  width: 38%;
  height: 2px;
  border-radius: 2px;
  background: var(--mini-action-ink, #ffffff);
  opacity: 0.92;
}

.skin-mini-tiles {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
}

.skin-mini-tiles > span {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 11px;
  padding: 0 3px;
  border: var(--mini-border-width, 1px) solid var(--mini-border);
  border-radius: var(--mini-panel-radius, 4px);
  background: var(--mini-surface);
}

.skin-mini-popup[data-frameless="true"] .skin-mini-tiles > span {
  border-radius: var(--mini-control-radius, 6px);
  background: var(--mini-soft);
}

.skin-mini-popup[data-dense="true"] .skin-mini-tiles > span {
  height: 13px;
}

.skin-mini-tiles > span > i {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 2px;
  background: var(--mini-icon-fg, var(--mini-accent));
  opacity: 0.9;
}

.skin-mini-popup[data-icon-shape="circle"] .skin-mini-tiles > span > i {
  border-radius: 50%;
}

.skin-mini-popup[data-icon-shape="square"] .skin-mini-tiles > span > i {
  border-radius: 1px;
}

.skin-mini-tiles > span > b {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: var(--mini-ink);
  opacity: 0.34;
}

/* === 12 套皮肤专属展台微缩材质特征 === */
.skin-card-stage[data-card-style="default"] {
  background-color: #eef1f6;
  background-image: radial-gradient(circle, rgba(23, 32, 51, 0.13) 1px, transparent 1px);
  background-size: 10px 10px;
}
.skin-card-stage[data-card-style="default"][data-card-dark="true"] {
  background-color: #0e121a;
  background-image: radial-gradient(circle, rgba(255, 255, 255, 0.09) 1px, transparent 1px);
}
.skin-card-stage[data-card-style="default"] .skin-mini-cta {
  box-shadow: 0 3px 8px rgba(235, 58, 112, 0.34);
}

.skin-card-stage[data-card-style="liquid-glass"] {
  background:
    radial-gradient(circle at 16% 20%, rgba(56, 189, 248, 0.85), transparent 52%),
    radial-gradient(circle at 86% 24%, rgba(168, 85, 247, 0.78), transparent 54%),
    radial-gradient(circle at 52% 96%, rgba(14, 165, 233, 0.72), transparent 58%),
    #dbeafe;
}
.skin-card-stage[data-card-style="liquid-glass"][data-card-dark="true"] {
  background:
    radial-gradient(circle at 18% 20%, rgba(56, 189, 248, 0.52), transparent 52%),
    radial-gradient(circle at 84% 24%, rgba(129, 140, 248, 0.56), transparent 54%),
    radial-gradient(circle at 50% 96%, rgba(14, 165, 233, 0.44), transparent 58%),
    #0b1120;
}
.skin-card-stage[data-card-style="liquid-glass"] .skin-mini-popup {
  border: 1px solid rgba(255, 255, 255, 0.84);
  border-bottom: 0;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.74), rgba(255, 255, 255, 0.50));
  box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, 0.96), 0 8px 20px rgba(30, 58, 138, 0.22);
}
.skin-card-stage[data-card-style="liquid-glass"][data-card-dark="true"] .skin-mini-popup {
  border-color: rgba(255, 255, 255, 0.28);
  background: linear-gradient(180deg, rgba(30, 41, 59, 0.74), rgba(15, 23, 42, 0.56));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.36), 0 10px 24px rgba(0, 0, 0, 0.55);
}
.skin-card-stage[data-card-style="liquid-glass"] :is(.skin-mini-hero, .skin-mini-tiles > span) {
  border-color: rgba(255, 255, 255, 0.68);
  background: rgba(255, 255, 255, 0.54);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}
.skin-card-stage[data-card-style="liquid-glass"][data-card-dark="true"] :is(.skin-mini-hero, .skin-mini-tiles > span) {
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
}
.skin-card-stage[data-card-style="liquid-glass"] .skin-mini-cta {
  border-radius: 999px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55), 0 3px 10px rgba(14, 165, 233, 0.36);
}

.skin-card-stage[data-card-style="aurora"] {
  background: linear-gradient(135deg, #fecdd3 0%, #f3e8ff 50%, #c7d2fe 100%);
}
.skin-card-stage[data-card-style="aurora"][data-card-dark="true"] {
  background: linear-gradient(135deg, #0d2b2b 0%, #24103a 52%, #131c45 100%);
}
.skin-card-stage[data-card-style="aurora"] .skin-mini-popup {
  background:
    radial-gradient(circle at 0% 0%, rgba(251, 113, 133, 0.30), transparent 55%),
    radial-gradient(circle at 100% 25%, rgba(168, 85, 247, 0.26), transparent 52%),
    radial-gradient(circle at 50% 100%, rgba(251, 191, 36, 0.24), transparent 58%),
    var(--mini-canvas);
  box-shadow: 0 8px 22px -4px rgba(124, 58, 237, 0.28);
}
.skin-card-stage[data-card-style="aurora"][data-card-dark="true"] .skin-mini-popup {
  background:
    radial-gradient(circle at 0% 0%, rgba(20, 184, 166, 0.34), transparent 55%),
    radial-gradient(circle at 100% 25%, rgba(217, 70, 239, 0.30), transparent 52%),
    var(--mini-canvas);
}
.skin-card-stage[data-card-style="aurora"] .skin-mini-cta {
  box-shadow: 0 3px 10px rgba(168, 85, 247, 0.48);
}
.skin-card-stage[data-card-style="aurora"] .skin-mini-tiles > span:first-child > i { background: #06b6d4; }
.skin-card-stage[data-card-style="aurora"] .skin-mini-tiles > span:last-child > i { background: #ec4899; }

.skin-card-stage[data-card-style="tactile"] {
  background: linear-gradient(180deg, #dcd7ce 0%, #e7e3db 100%);
}
.skin-card-stage[data-card-style="tactile"][data-card-dark="true"] {
  background: linear-gradient(180deg, #141518 0%, #1e2026 100%);
}
.skin-card-stage[data-card-style="tactile"] .skin-mini-popup {
  box-shadow: inset 0 1.5px 0 rgba(255, 255, 255, 0.85), 0 8px 18px rgba(0, 0, 0, 0.16);
}
.skin-card-stage[data-card-style="tactile"][data-card-dark="true"] .skin-mini-popup {
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 10px 22px rgba(0, 0, 0, 0.6);
}
.skin-card-stage[data-card-style="tactile"] :is(.skin-mini-hero, .skin-mini-tiles > span) {
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.88);
}
.skin-card-stage[data-card-style="tactile"][data-card-dark="true"] :is(.skin-mini-hero, .skin-mini-tiles > span) {
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.10);
}
.skin-card-stage[data-card-style="tactile"] .skin-mini-cta {
  box-shadow: 0 3px 0 #822205, inset 0 1px 0 rgba(255, 255, 255, 0.36);
  margin-bottom: 2px;
}

.skin-card-stage[data-card-style="brutalist"] {
  padding-bottom: 5px;
  background-color: #ffef9a;
  background-image: radial-gradient(circle, rgba(17, 17, 17, 0.24) 1px, transparent 1px);
  background-size: 9px 9px;
}
.skin-card-stage[data-card-style="brutalist"][data-card-dark="true"] {
  background-color: #1f1d14;
  background-image: radial-gradient(circle, rgba(255, 222, 56, 0.24) 1px, transparent 1px);
}
.skin-card-stage[data-card-style="brutalist"] .skin-mini-popup {
  height: 62px;
  margin-right: 3px;
  border: 2px solid #111111;
  border-radius: 3px;
  box-shadow: 3px 3px 0 #111111;
}
.skin-card-stage[data-card-style="brutalist"][data-card-dark="true"] .skin-mini-popup {
  border-color: #ffde38;
  box-shadow: 4px 4px 0 #ffde38;
}
.skin-card-stage[data-card-style="brutalist"] :is(.skin-mini-hero, .skin-mini-cta) {
  border: 1.5px solid #111111;
  box-shadow: 2px 2px 0 #111111;
}
.skin-card-stage[data-card-style="brutalist"] .skin-mini-tiles > span:first-child {
  border: 1.5px solid #111111;
  background: #d3f9e2;
  box-shadow: 1.5px 1.5px 0 #111111;
}
.skin-card-stage[data-card-style="brutalist"] .skin-mini-tiles > span:last-child {
  border: 1.5px solid #111111;
  background: #d6f0ff;
  box-shadow: 1.5px 1.5px 0 #111111;
}
.skin-card-stage[data-card-style="brutalist"][data-card-dark="true"] :is(.skin-mini-hero, .skin-mini-cta, .skin-mini-tiles > span) {
  border-color: #ffde38;
  box-shadow: 2px 2px 0 #ffde38;
}
.skin-card-stage[data-card-style="brutalist"][data-card-dark="true"] .skin-mini-tiles > span:first-child { background: #133024; }
.skin-card-stage[data-card-style="brutalist"][data-card-dark="true"] .skin-mini-tiles > span:last-child { background: #132a3d; }

.skin-card-stage[data-card-style="cyber"] {
  background-color: #070812;
  background-image:
    linear-gradient(rgba(0, 229, 255, 0.12) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 229, 255, 0.12) 1px, transparent 1px),
    radial-gradient(circle at 50% 100%, rgba(255, 42, 133, 0.30), transparent 65%);
  background-size: 12px 12px, 12px 12px, 100% 100%;
}
.skin-card-stage[data-card-style="cyber"] .skin-mini-popup {
  border: 1px solid rgba(0, 229, 255, 0.72);
  border-bottom: 0;
  box-shadow: -4px 0 14px rgba(0, 229, 255, 0.28), 4px 0 14px rgba(255, 42, 133, 0.28);
}
.skin-card-stage[data-card-style="cyber"] .skin-mini-cta {
  box-shadow: 0 0 10px rgba(201, 20, 108, 0.62);
}
.skin-card-stage[data-card-style="cyber"] .skin-mini-tiles > span:first-child { border-color: rgba(0, 229, 255, 0.55); }
.skin-card-stage[data-card-style="cyber"] .skin-mini-tiles > span:first-child > i { background: #00e5ff; }
.skin-card-stage[data-card-style="cyber"] .skin-mini-tiles > span:last-child { border-color: rgba(255, 42, 133, 0.55); }
.skin-card-stage[data-card-style="cyber"] .skin-mini-tiles > span:last-child > i { background: #ff2a85; }

.skin-card-stage[data-card-style="retro-os"] {
  background: #008080;
}
.skin-card-stage[data-card-style="retro-os"][data-card-dark="true"] {
  background: #143638;
}
.skin-card-stage[data-card-style="retro-os"] .skin-mini-popup {
  border: 0;
  border-radius: 0;
  padding: 4px 6px 6px;
  box-shadow:
    inset 1.5px 1.5px 0 #ffffff,
    inset -1.5px -1.5px 0 #404040,
    inset 3px 3px 0 #dfdfdf,
    inset -3px -3px 0 #808080;
}
.skin-card-stage[data-card-style="retro-os"][data-card-dark="true"] .skin-mini-popup {
  box-shadow:
    inset 1.5px 1.5px 0 #62666e,
    inset -1.5px -1.5px 0 #0b0c0e,
    inset 3px 3px 0 #45484f,
    inset -3px -3px 0 #1b1d21;
}
.skin-card-stage[data-card-style="retro-os"] .skin-mini-header {
  margin: -1px -2px 1px;
  padding: 3px 5px;
  background: linear-gradient(90deg, #000080, #1084d0);
}
.skin-card-stage[data-card-style="retro-os"] .skin-mini-brand > b { background: #ffffff; opacity: 1; }
.skin-card-stage[data-card-style="retro-os"] .skin-mini-chip {
  border: 0;
  border-radius: 0;
  background: #c0c0c0;
  box-shadow: inset 1px 1px 0 #ffffff, inset -1px -1px 0 #404040;
}
.skin-card-stage[data-card-style="retro-os"] :is(.skin-mini-hero, .skin-mini-tiles > span, .skin-mini-cta, .skin-mini-langs > i) {
  border-radius: 0;
}
.skin-card-stage[data-card-style="retro-os"] .skin-mini-cta {
  box-shadow: inset 1px 1px 0 rgba(255, 255, 255, 0.72), inset -1px -1px 0 #000040;
}

.skin-card-stage[data-card-style="terminal"] {
  background:
    repeating-linear-gradient(0deg, rgba(34, 197, 94, 0.08) 0 1px, transparent 1px 3px),
    radial-gradient(circle at 50% 60%, rgba(34, 197, 94, 0.14), transparent 70%),
    #040a06;
}
.skin-card-stage[data-card-style="terminal"] .skin-mini-popup {
  border: 1px solid #22c55e;
  border-bottom: 0;
  border-radius: 0;
  box-shadow: 0 0 16px rgba(34, 197, 94, 0.28);
}
.skin-card-stage[data-card-style="terminal"] .skin-mini-brand > i {
  border-radius: 0;
  background: #22c55e;
  box-shadow: 0 0 6px #22c55e;
}
.skin-card-stage[data-card-style="terminal"] :is(.skin-mini-hero, .skin-mini-tiles > span, .skin-mini-cta, .skin-mini-langs > i) {
  border-radius: 0;
}
.skin-card-stage[data-card-style="terminal"] .skin-mini-tiles > span {
  border-style: dashed;
}
.skin-card-stage[data-card-style="terminal"] .skin-mini-cta {
  box-shadow: 0 0 10px rgba(34, 197, 94, 0.55);
}

.skin-card-stage[data-card-style="editorial"] {
  background: linear-gradient(180deg, #e7e0d2 0%, #eee8dc 100%);
}
.skin-card-stage[data-card-style="editorial"][data-card-dark="true"] {
  background: linear-gradient(180deg, #1b1814 0%, #231f1a 100%);
}
.skin-card-stage[data-card-style="editorial"] .skin-mini-popup {
  border-radius: 0;
  border-color: var(--mini-ink);
  box-shadow: 0 6px 14px -6px rgba(28, 25, 23, 0.24);
}
.skin-card-stage[data-card-style="editorial"] .skin-mini-header {
  padding-bottom: 4px;
  border-bottom: 3px double var(--mini-ink);
}
.skin-card-stage[data-card-style="editorial"] :is(.skin-mini-hero, .skin-mini-tiles > span, .skin-mini-cta, .skin-mini-langs > i, .skin-mini-chip) {
  border-radius: 0;
}
.skin-card-stage[data-card-style="editorial"] .skin-mini-hero {
  border-inline: 0;
  padding-inline: 2px;
}

.skin-card-stage[data-card-style="sakura"] {
  background: linear-gradient(135deg, #ffe1ec 0%, #fff0f6 55%, #ede9fe 100%);
}
.skin-card-stage[data-card-style="sakura"][data-card-dark="true"] {
  background: linear-gradient(135deg, #2a1522 0%, #201427 100%);
}
.skin-card-stage[data-card-style="sakura"] .skin-mini-popup {
  border-radius: 13px 13px 0 0;
  box-shadow: 0 8px 18px -4px rgba(244, 114, 182, 0.28);
}
.skin-card-stage[data-card-style="sakura"] .skin-mini-cta {
  border-radius: 999px;
  box-shadow: 0 3px 8px rgba(207, 46, 106, 0.34);
}
.skin-card-stage[data-card-style="sakura"] .skin-mini-tiles > span:first-child { background: #ffe8f1; border-color: #fbcfe8; }
.skin-card-stage[data-card-style="sakura"] .skin-mini-tiles > span:first-child > i { background: #d4356f; }
.skin-card-stage[data-card-style="sakura"] .skin-mini-tiles > span:last-child { background: #f1ebff; border-color: #ddd6fe; }
.skin-card-stage[data-card-style="sakura"] .skin-mini-tiles > span:last-child > i { background: #7c3aed; }
.skin-card-stage[data-card-style="sakura"][data-card-dark="true"] .skin-mini-tiles > span:first-child { background: #361d2c; border-color: #5b2d47; }
.skin-card-stage[data-card-style="sakura"][data-card-dark="true"] .skin-mini-tiles > span:last-child { background: #29203a; border-color: #463566; }

.skin-card-stage[data-card-style="matcha"] {
  background: linear-gradient(160deg, #d4e3d0 0%, #c1d5bc 100%);
}
.skin-card-stage[data-card-style="matcha"][data-card-dark="true"] {
  background: linear-gradient(160deg, #101b14 0%, #17281e 100%);
}
.skin-card-stage[data-card-style="matcha"] .skin-mini-tiles > span {
  box-shadow: inset 2.5px 0 0 var(--mini-accent);
}

.skin-card-stage[data-card-style="midnight-gold"] {
  background:
    radial-gradient(circle at 50% 0%, rgba(212, 175, 55, 0.28), transparent 68%),
    #0a0908;
}
.skin-card-stage[data-card-style="midnight-gold"] .skin-mini-popup {
  border: 1px solid rgba(212, 175, 55, 0.65);
  border-bottom: 0;
  box-shadow: inset 0 1px 0 rgba(245, 214, 123, 0.45), 0 8px 22px rgba(0, 0, 0, 0.7);
}
.skin-card-stage[data-card-style="midnight-gold"] :is(.skin-mini-hero, .skin-mini-tiles > span) {
  border-color: rgba(212, 175, 55, 0.34);
}
.skin-card-stage[data-card-style="midnight-gold"] .skin-mini-cta {
  box-shadow: 0 2px 10px rgba(212, 175, 55, 0.36);
}

/* 微缩卡左上角保留品牌玫红原色，仅叠加各皮肤专属外缘趣味细节 */
.skin-card-stage[data-card-style="liquid-glass"] .skin-mini-brand > i { box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.9); }
.skin-card-stage[data-card-style="aurora"] .skin-mini-brand > i { box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.75); }
.skin-card-stage[data-card-style="tactile"] .skin-mini-brand > i { box-shadow: 0 1px 0 #8a8376; }
.skin-card-stage[data-card-style="brutalist"] .skin-mini-brand > i { border: 1px solid #111; transform: rotate(-7deg); box-shadow: 1px 1px 0 #111; }
.skin-card-stage[data-card-style="cyber"] .skin-mini-brand > i { box-shadow: 0 0 0 1px #00e5ff, 0 0 4px rgba(0, 229, 255, 0.65); }
.skin-card-stage[data-card-style="retro-os"] .skin-mini-brand > i { border-radius: 1px; box-shadow: 0 0 0 1px #ffffff, 1px 1px 0 #5c5b55; }
.skin-card-stage[data-card-style="terminal"] .skin-mini-brand > i { box-shadow: 0 0 0 1px #4ade80; }
.skin-card-stage[data-card-style="editorial"] .skin-mini-brand > i { box-shadow: 0 0 0 1px rgba(127, 29, 40, 0.65); }
.skin-card-stage[data-card-style="sakura"] .skin-mini-brand > i { box-shadow: 0 0 0 1px #fda4af; }
.skin-card-stage[data-card-style="matcha"] .skin-mini-brand > i { box-shadow: 0 0 0 1px #4ade80; }
.skin-card-stage[data-card-style="midnight-gold"] .skin-mini-brand > i { box-shadow: 0 0 0 1px #e5c372; }

.skin-card-dark-badge {
  position: absolute;
  top: 5px;
  right: 5px;
  display: grid;
  width: 17px;
  height: 17px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  color: #e6eef2;
  background: rgba(15, 23, 42, 0.82);
}

.skin-card-dark-badge svg {
  width: 9.5px;
  height: 9.5px;
}

.skin-card-footer {
  display: grid;
  width: 100%;
  box-sizing: border-box;
  gap: 4px;
  padding: 6px 8px 7px;
}

.skin-card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.skin-card-title-row strong {
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.interface-skin-option.selected .skin-card-title-row strong {
  color: var(--brand-strong);
}

.skin-card-check {
  display: grid;
  flex: none;
  width: 14px;
  height: 14px;
  place-items: center;
  border: 1.5px solid var(--fr-color-line-strong, #cfd5e0);
  border-radius: 50%;
  color: #fff;
  background: transparent;
  transition: background-color 120ms var(--fr-ease-out, ease), border-color 120ms var(--fr-ease-out, ease);
}

.skin-card-check svg {
  width: 9px;
  height: 9px;
  opacity: 0;
  transform: scale(0.7);
  transition: opacity 120ms ease, transform 120ms ease;
}

.interface-skin-option.selected .skin-card-check {
  border-color: var(--brand);
  background: var(--brand);
}

.interface-skin-option.selected .skin-card-check svg {
  opacity: 1;
  transform: scale(1);
}

.skin-card-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.skin-card-swatches {
  display: inline-flex;
  align-items: center;
  gap: 2.5px;
}

.skin-card-swatches > i {
  width: 6.5px;
  height: 6.5px;
  border: 1px solid rgba(15, 23, 42, 0.16);
  border-radius: 50%;
}

:root.dark .skin-card-swatches > i {
  border-color: rgba(255, 255, 255, 0.18);
}

.skin-card-tag {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: var(--fr-radius-full, 9999px);
  color: var(--muted);
  background: var(--surface-soft);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
}

.interface-skin-option.selected .skin-card-tag {
  border-color: color-mix(in srgb, var(--brand) 32%, var(--line));
  color: var(--brand-strong);
  background: var(--brand-soft);
}

/* === 布局与字体面板样式 === */
.interface-layout-settings {
  padding: 12px 16px;
}

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

.popup-layout-tabs button:hover { color: var(--ink); }
.popup-layout-tabs button[aria-selected="true"] {
  color: var(--brand-strong);
  background: var(--surface);
  box-shadow: 0 3px 10px rgba(31, 40, 61, .07);
}
.popup-layout-tabs button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 40%, transparent);
  outline-offset: 1px;
}
.popup-layout-tab-panel { margin-top: 0; }
.popup-layout-section-hidden { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; padding: 10px; border-radius: 10px; color: var(--muted); background: var(--surface-soft); font-size: 11px; line-height: 1.5; }
.popup-layout-section-hidden button { flex: none; border: 0; border-radius: 6px; padding: 4px 6px; color: var(--brand-strong); background: var(--brand-soft); font: inherit; cursor: pointer; }

/* === 响应式断点 === */
@media (max-width: 1220px) {
  .popup-skin-studio {
    --studio-stage-width: 344px;
    gap: 18px;
    padding: 16px;
  }
  .interface-skin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
}

@media (max-width: 1050px) {
  .interface-font-picker { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 820px) {
  .popup-skin-studio {
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
    padding: 14px;
  }
  .interface-skin-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
}

@media (min-width: 521px) and (max-width: 900px) {
  .popup-layout-workbench { grid-template-columns: minmax(0, 1fr); }
  .popup-layout-live-preview { max-width: 360px; }
}

@media (max-width: 700px) {
  .interface-font-picker { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .interface-font-settings { padding: 12px; }
}

@media (max-width: 520px) {
  .popup-layout-workbench { grid-template-columns: minmax(0, 1fr); }
  .interface-layout-settings { padding: 10px; }
  .popup-layout-section-hidden { flex-direction: column; }
}

@media (max-width: 460px) {
  .interface-font-picker { grid-template-columns: minmax(0, 1fr); }
  .skin-card-stage { height: 70px; padding: 7px 7px 0; }
  .skin-mini-popup { height: 62px; padding: 4px 5px; }
  .skin-card-footer { padding: 6px 7px; }
}

@media (prefers-reduced-motion: reduce) {
  .interface-skin-option,
  .skin-mini-popup,
  .skin-card-check,
  .skin-card-check svg,
  .skin-filter-pill,
  .popup-skin-reset-btn {
    transition: none;
  }
  .interface-skin-option:hover,
  .interface-skin-option:hover .skin-mini-popup,
  .interface-skin-option:active {
    transform: none;
  }
}
</style>

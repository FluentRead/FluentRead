<!--
 * @file src/features/settings/ui/InterfaceSettings.vue
 * 文件职责：在独立的“界面风格”页面组织 FluentRead 的界面风格、动画加载效果和菜单栏布局三个偏好分组。
 * 主要内容：用真实 DOM 范例辅助选择注册皮肤，提供动画与加载效果预览，并通过预览直接拖动和显隐列表共同编排菜单栏区域与快捷入口，两个操作面共享持久化配置。
 * 模块边界：本组件只负责界面配置的展示与双向绑定，不直接读写浏览器存储、不负责主题模式，也不关闭翻译功能本身；界面皮肤由 Options composition root 统一应用。
-->
<template>
  <SettingsGroup
    :title="translateLegacy('界面与弹窗')"
    :description="translateLegacy('从效率布局、趣味配色到夜间和护眼方案，选择适合自己的界面；也可以只留下常用栏目。')"
  >
    <SettingsItem
      class="interface-appearance-settings"
      :label="translateLegacy('弹窗风格')"
      :description="translateLegacy('风格只改变扩展界面的呈现，不影响网页翻译效果。')"
    >
      <template #copy>
        <InterfaceSkinPreview
          :skin="selectedSkinOption"
          :skin-label="translateLegacy(selectedSkinOption.label)"
          :preview-label="`${translateLegacy('弹窗风格')}: ${translateLegacy(selectedSkinOption.label)}`"
        />
      </template>
      <div class="interface-skin-picker" role="radiogroup" :aria-label="translateLegacy('弹窗风格')">
        <div
          v-for="group in groupedSkinOptions"
          :key="group.value"
          class="interface-skin-group"
          role="group"
          :aria-labelledby="`interface-skin-group-${group.value}`"
        >
          <div class="interface-skin-group-heading">
            <strong :id="`interface-skin-group-${group.value}`">{{ translateLegacy(group.label) }}</strong>
            <small>{{ translateLegacy(group.description) }}</small>
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
              :aria-label="`${translateLegacy(skin.label)}: ${translateLegacy(skin.description)}`"
              :data-skin="skin.value"
              @click="props.config.interfaceSkin = skin.value"
            >
              <span
                class="interface-skin-preview"
                :style="{
                  '--skin-preview-canvas': skin.preview.canvas,
                  '--skin-preview-surface': skin.preview.surface,
                  '--skin-preview-accent': skin.preview.accent,
                  '--skin-preview-ink': skin.preview.ink,
                }"
                aria-hidden="true"
              >
                <InterfaceBackdrop :motif="skin.motif" />
                <i /><i /><i />
              </span>
              <span class="interface-skin-copy">
                <strong>{{ translateLegacy(skin.label) }}</strong>
                <small>{{ translateLegacy(skin.description) }}</small>
              </span>
              <span class="interface-skin-radio" aria-hidden="true"><i /></span>
            </button>
          </div>
        </div>
      </div>
    </SettingsItem>

  </SettingsGroup>

  <TranslationLoadingStyleSettings :config="props.config" />

  <SettingsGroup
    :title="t('settings.interface.popupLayout.label')"
    :description="t('settings.interface.popupLayout.description')"
  >
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
</template>

<script lang="ts" setup>
import InterfaceBackdrop from '@/src/ui/components/InterfaceBackdrop.vue'
import {computed, ref} from 'vue'
import type {Config} from '@/src/core/config/model'
import {
  DEFAULT_POPUP_MODULE_ORDER,
  DEFAULT_POPUP_QUICK_FEATURE_ORDER,
  getInterfaceSkinOption,
  interfaceSkinGroups,
  interfaceSkinOptions,
  normalizePopupModuleOrder,
  normalizePopupQuickFeatureOrder,
  popupModuleOptions,
  popupQuickFeatureOptions,
  withInterfaceVisibility,
  withPopupQuickFeatureVisibility,
} from '@/src/core/config/interfaceAppearance'
import {useUiI18n} from '@/src/ui/i18n'
import InterfaceSkinPreview from './components/InterfaceSkinPreview.vue'
import PopupLayoutPreview from './components/PopupLayoutPreview.vue'
import PopupLayoutEditor from './PopupLayoutEditor.vue'
import TranslationLoadingStyleSettings from './TranslationLoadingStyleSettings.vue'
import SettingsGroup from './components/SettingsGroup.vue'
import SettingsItem from './components/SettingsItem.vue'

const props = defineProps<{
  config: Config
}>()
const {t, translateLegacy} = useUiI18n()
const activeLayoutPanel = ref<'popupModule' | 'quickFeature'>('popupModule')
function handleLayoutTabKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  activeLayoutPanel.value = event.key === 'Home' ? 'popupModule'
    : event.key === 'End' ? 'quickFeature'
      : activeLayoutPanel.value === 'popupModule' ? 'quickFeature' : 'popupModule'
  const tabs = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]')
  tabs[activeLayoutPanel.value === 'popupModule' ? 0 : 1]?.focus()
}
const selectedSkinOption = computed(() => getInterfaceSkinOption(props.config.interfaceSkin))

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
  props.config.popupModuleOrder = normalizePopupModuleOrder(order)
}

function setPopupModuleVisibility(moduleId: string, visible: boolean) {
  const module = popupModuleOptions.find((item) => item.id === moduleId)
  if (!module?.visibilityKey) return
  props.config.interfaceVisibility = withInterfaceVisibility(
    props.config.interfaceVisibility,
    module.visibilityKey,
    visible,
  )
}

function setPopupQuickFeatureOrder(order: string[]) {
  props.config.popupQuickFeatureOrder = normalizePopupQuickFeatureOrder(order)
}

function setPopupQuickFeatureVisibility(featureId: string, visible: boolean) {
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

.interface-appearance-settings {
  grid-template-columns: minmax(190px, .65fr) minmax(0, 1.5fr);
  align-items: start;
  gap: 24px;
}

.interface-appearance-settings:hover { background: transparent; }
.interface-appearance-settings :deep(.settings-item-copy) { position: sticky; top: 0; }

.interface-skin-picker {
  display: grid;
  width: 100%;
  gap: 12px;
}

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

.interface-skin-group-heading small {
  min-width: 0;
  overflow: visible;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.5;
  white-space: normal;
}

.interface-skin-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.interface-skin-option {
  position: relative;
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 82px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 11px;
  color: var(--ink);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}

.interface-skin-option:hover {
  border-color: var(--brand);
  background: var(--surface-soft);
}

.interface-skin-option.selected {
  border-color: var(--brand);
  background: var(--brand-soft);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 10%, transparent);
}

.interface-skin-preview {
  position: relative;
  isolation: isolate;
  display: flex;
  width: 56px;
  height: 60px;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
  padding: 10px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--skin-preview-ink) 18%, transparent);
  border-radius: 9px;
  background: radial-gradient(ellipse at 100% 0, color-mix(in srgb, var(--skin-preview-accent) 20%, transparent), transparent 80%), var(--skin-preview-canvas);
}

.interface-skin-preview :deep(.interface-backdrop) {
  width: 100%;
  height: 42px;
  color: var(--skin-preview-accent);
  opacity: .8;
}
.interface-skin-preview :deep(.emoji-stickers) { width: 100%; height: 100%; }
.interface-skin-preview :deep(.emoji-stickers span:nth-child(1)) { top: 2px; right: 6px; font-size: 17px; }
.interface-skin-preview :deep(.emoji-stickers span:nth-child(2)) { top: 24px; right: 3px; font-size: 11px; }
.interface-skin-preview :deep(.emoji-stickers span:nth-child(3)) { top: 4px; right: 35px; font-size: 11px; }

.interface-skin-preview > i {
  display: block;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: var(--skin-preview-surface);
}

.interface-skin-preview > i:first-of-type {
  width: 48%;
  height: 3px;
  background: var(--skin-preview-ink);
}

.interface-skin-preview > i:last-child {
  width: 72%;
  height: 4px;
  align-self: flex-end;
  background: var(--skin-preview-accent);
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

.interface-skin-copy small {
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.5;
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
  .interface-appearance-settings :deep(.settings-item-copy) { position: static; }
  .interface-appearance-settings :deep(.settings-item-control) { justify-content: stretch; }
}

@media (max-width: 520px) {
  .popup-layout-workbench {
    grid-template-columns: minmax(0, 1fr);
  }

  .interface-skin-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .interface-skin-group-heading {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }

  .interface-skin-group-heading small {
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
  }
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

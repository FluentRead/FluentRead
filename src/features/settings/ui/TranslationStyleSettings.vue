<!--
@file src/features/settings/ui/TranslationStyleSettings.vue
文件职责：作为“界面风格”页的第一个分组，集中设置网页双语译文的样式预设、文字与独立背景色、精确字号等外观微调，并提供与网页一致的实时预览。
主要内容：左侧实时预览、右侧选择样式，窄屏下按相同顺序纵向排列；以紧凑可视卡片比较内置样式和已保存样式的独立外观快照，减少嵌套边框并突出当前选择；当前预览实时反映颜色、字体与安全的自定义 CSS 声明，并能保存、更新或删除多套样式。
模块边界：本组件只编辑父级传入的 Config 草稿（style、translationAppearance、translationStyleProfiles 等），不持久化配置、
不向网页注入样式；预设元数据和外观声明来自 core/config/translationAppearance，网页应用由 content 层负责。
-->
<template>
  <SettingsGroup
    class="translation-style-group"
    :title="t('settings.translationStyle.title')"
    :description="t('settings.translationStyle.description')"
  >
    <div id="translation-style-settings" class="translation-style-settings" data-testid="translation-style-settings">
      <div v-if="config.display !== 1" class="translation-style-mode-note" role="status">
        <span>{{ t('settings.translationStyle.bilingualOnly') }}</span>
        <button type="button" @click="config.display = 1">{{ t('settings.translationStyle.switchToBilingual') }}</button>
      </div>

      <div class="translation-style-workbench">
        <div class="translation-style-stage">
          <TranslationStylePreview
            :style-class="selectedPreset.className"
            :appearance-style="appearanceStyle"
            :highlight-enabled="config.bilingualSentenceHighlightEnabled"
            :highlight-style="config.bilingualSentenceHighlightStyle"
            :highlight-appearance="config.bilingualSentenceHighlightAppearance"
            :translation-before-original="config.translationBeforeOriginal"
            :page-theme="pageTheme"
            :caption="t('settings.translationStyle.currentPreset', { name: activeProfile?.name ?? translateLegacy(selectedPreset.label) })"
            :customized="customized"
            :hint="selectedPreset.className === 'fluent-display-blur-reveal' ? t('settings.translationStyle.blurRevealHint') : ''"
            @update:page-theme="pageTheme = $event"
          />
        </div>

        <section class="translation-style-gallery" aria-labelledby="translation-style-gallery-title">
          <div v-if="config.translationStyleProfiles.length" class="translation-style-saved">
            <strong id="translation-style-saved-title">{{ t('settings.translationStyle.savedTitle') }}</strong>
            <div class="translation-style-saved-list" role="radiogroup" aria-labelledby="translation-style-saved-title">
              <button
                v-for="profile in config.translationStyleProfiles"
                :key="profile.id"
                type="button"
                class="translation-style-saved-card"
                :class="{ selected: config.activeTranslationStyleProfileId === profile.id }"
                role="radio"
                :aria-checked="config.activeTranslationStyleProfileId === profile.id"
                :aria-label="profile.name"
                :title="profile.name"
                @click="selectProfile(profile)"
              >
                <span class="translation-style-card-sample" :data-page-theme="pageTheme" aria-hidden="true" data-i18n-ignore>
                  <span class="fluent-read-bilingual-content" :class="getTranslationStylePreset(profile.style)?.className" :style="getTranslationAppearanceStyle(profile.appearance)" lang="zh-CN"><span class="fluent-read-translation-text">阅读轻松自然</span></span>
                </span>
                <span class="translation-style-saved-card-copy">
                  <strong>{{ profile.name }}</strong>
                  <small>{{ t('settings.translationStyle.profileBase', { name: translateLegacy(getTranslationStylePreset(profile.style)?.label ?? '') }) }}</small>
                </span>
                <span class="translation-style-card-check" aria-hidden="true"><i /></span>
              </button>
            </div>
          </div>
          <header class="translation-style-gallery-heading">
            <strong id="translation-style-gallery-title">{{ t('settings.translationStyle.presetsTitle') }}</strong>
            <SegmentedControl
              class="translation-style-categories"
              :model-value="activeCategory"
              :options="categoryOptions"
              :label="t('settings.translationStyle.categoryLabel')"
              @update:model-value="selectCategory"
            />
          </header>
          <div class="translation-style-grid" role="radiogroup" aria-labelledby="translation-style-gallery-title">
            <button
              v-for="preset in visiblePresets"
              :key="preset.value"
              type="button"
              role="radio"
              class="translation-style-card"
              :class="{ selected: !config.activeTranslationStyleProfileId && config.style === preset.value }"
              :aria-checked="!config.activeTranslationStyleProfileId && config.style === preset.value"
              :aria-label="translateLegacy(preset.label)"
              :data-style-value="preset.value"
              @click="selectPreset(preset.value)"
            >
              <span class="translation-style-card-sample" :data-page-theme="pageTheme" aria-hidden="true" data-i18n-ignore>
                <span class="fluent-read-bilingual-content" :class="preset.className" :style="presetAppearanceStyle" lang="zh-CN"><span class="fluent-read-translation-text">阅读轻松自然</span></span>
              </span>
              <span class="translation-style-card-name">{{ translateLegacy(preset.label) }}</span>
              <span class="translation-style-card-check" aria-hidden="true"><i /></span>
            </button>
          </div>
          <p class="translation-style-apply-hint">{{ t('settings.translationStyle.applyHint') }}</p>
        </section>
      </div>

      <section id="translation-appearance-panel" class="translation-appearance-panel" aria-labelledby="translation-appearance-title" data-testid="translation-appearance-panel">
        <button
          type="button"
          class="translation-appearance-disclosure"
          :aria-expanded="customExpanded"
          aria-controls="translation-appearance-content"
          @click="customExpanded = !customExpanded"
        >
          <span class="translation-appearance-disclosure-copy">
            <strong id="translation-appearance-title">{{ t('settings.translationStyle.customizeTitle') }}</strong>
            <small>{{ t('settings.translationStyle.customizeCollapsedHint') }}</small>
          </span>
          <span v-if="profileDirty" class="translation-appearance-status">{{ t('settings.translationStyle.unsavedChanges') }}</span>
          <span v-else-if="customized" class="translation-appearance-status">{{ t('settings.translationStyle.customized') }}</span>
          <svg class="translation-appearance-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div v-if="customExpanded" id="translation-appearance-content" class="translation-appearance-content">
          <header class="translation-appearance-heading">
            <small>{{ t('settings.translationStyle.customizeDescription') }}</small>
            <button type="button" class="translation-appearance-reset" :disabled="!customized" @click="resetAppearance">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
              {{ t('settings.translationStyle.reset') }}
            </button>
          </header>
          <div class="translation-appearance-grid">
            <div class="translation-appearance-colors">
              <TranslationColorField
                v-model="appearance.textColor"
                field-id="translation-text-color"
                :label="t('settings.translationStyle.textColor')"
                :swatches="TRANSLATION_TEXT_COLOR_SWATCHES"
              />
              <TranslationColorField
                v-model="appearance.backgroundColor"
                field-id="translation-background-color"
                :label="t('settings.translationStyle.backgroundColor')"
                :swatches="TRANSLATION_BACKGROUND_COLOR_SWATCHES"
              />
              <TranslationColorField
                v-model="appearance.lineColor"
                field-id="translation-line-color"
                :label="t('settings.translationStyle.lineColor')"
                :swatches="TRANSLATION_LINE_COLOR_SWATCHES"
                :hint="selectedPreset.usesLine ? '' : t('settings.translationStyle.lineUnused')"
              />
              <TranslationColorField
                v-model="appearance.fillColor"
                field-id="translation-fill-color"
                :label="t('settings.translationStyle.fillColor')"
                :swatches="TRANSLATION_FILL_COLOR_SWATCHES"
                :hint="selectedPreset.usesFill ? '' : t('settings.translationStyle.fillUnused')"
              />
            </div>
            <div class="translation-appearance-typography">
              <div class="translation-appearance-range">
                <span>{{ t('settings.translationStyle.fontSize') }}<b>{{ appearance.fontScale }}%</b></span>
                <div class="translation-appearance-scale-controls">
                  <input
                    v-model.number="appearance.fontScale"
                    type="range"
                    :min="TRANSLATION_FONT_SCALE_RANGE.min"
                    :max="TRANSLATION_FONT_SCALE_RANGE.max"
                    :step="TRANSLATION_FONT_SCALE_RANGE.step"
                    :aria-label="t('settings.translationStyle.fontSize')"
                  >
                  <span class="translation-appearance-percent-input">
                    <input
                      type="number"
                      :value="appearance.fontScale"
                      :min="TRANSLATION_FONT_SCALE_RANGE.min"
                      :max="TRANSLATION_FONT_SCALE_RANGE.max"
                      step="1"
                      :aria-label="t('settings.translationStyle.fontSize')"
                      data-testid="translation-font-scale-value"
                      @change="commitFontScale"
                    >
                    <span aria-hidden="true">%</span>
                  </span>
                </div>
              </div>
              <label class="translation-appearance-range">
                <span>{{ t('settings.translationStyle.opacity') }}<b>{{ appearance.opacity }}%</b></span>
                <input
                  v-model.number="appearance.opacity"
                  type="range"
                  :min="TRANSLATION_OPACITY_RANGE.min"
                  :max="TRANSLATION_OPACITY_RANGE.max"
                  :step="TRANSLATION_OPACITY_RANGE.step"
                  :aria-label="t('settings.translationStyle.opacity')"
                >
              </label>
              <div class="translation-appearance-choice">
                <span>{{ t('settings.translationStyle.fontWeightLabel') }}</span>
                <SegmentedControl
                  :model-value="appearance.fontWeight"
                  :options="fontWeightOptions"
                  :label="t('settings.translationStyle.fontWeightLabel')"
                  @update:model-value="selectFontWeight"
                />
              </div>
              <div class="translation-appearance-choice">
                <span>{{ t('settings.translationStyle.fontFamilyLabel') }}</span>
                <SegmentedControl
                  :model-value="appearance.fontFamily"
                  :options="fontFamilyOptions"
                  :label="t('settings.translationStyle.fontFamilyLabel')"
                  @update:model-value="selectFontFamily"
                />
              </div>
            </div>
          </div>
          <div class="translation-custom-css">
            <label for="translation-custom-css">{{ t('settings.translationStyle.customCssTitle') }}</label>
            <small id="translation-custom-css-hint">{{ t('settings.translationStyle.customCssHint') }}</small>
            <textarea
              id="translation-custom-css"
              v-model="appearance.customCss"
              :maxlength="MAX_TRANSLATION_CUSTOM_CSS_LENGTH"
              :aria-invalid="cssValidation.invalidCount > 0"
              aria-describedby="translation-custom-css-hint"
              rows="4"
              spellcheck="false"
              placeholder="color: rebeccapurple;&#10;background: rgb(255, 248, 204);&#10;font-size: 117%;"
            />
            <small v-if="cssValidation.invalidCount" class="translation-custom-css-error" role="alert">{{ t('settings.translationStyle.customCssInvalid') }}</small>
          </div>
          <div class="translation-profile-editor">
            <label for="translation-profile-name">{{ t('settings.translationStyle.profileName') }}</label>
            <div class="translation-profile-editor-row">
              <input
                id="translation-profile-name"
                v-model="profileNameDraft"
                type="text"
                maxlength="30"
                :placeholder="t('settings.translationStyle.profileNamePlaceholder')"
              >
              <button type="button" class="translation-profile-save" :disabled="config.translationStyleProfiles.length >= MAX_TRANSLATION_STYLE_PROFILES || !profileNameDraft.trim()" @click="saveProfile">
                {{ t('settings.translationStyle.saveAsNew') }}
              </button>
            </div>
            <div v-if="activeProfile" class="translation-profile-actions">
              <button type="button" :disabled="!profileNameDraft.trim() || !profileDirty" @click="updateProfile">{{ t('settings.translationStyle.updateSaved') }}</button>
              <button type="button" class="translation-profile-delete" @click="deleteProfile">{{ t('settings.translationStyle.deleteSaved') }}</button>
            </div>
            <small v-if="config.translationStyleProfiles.length >= MAX_TRANSLATION_STYLE_PROFILES">{{ t('settings.translationStyle.profileLimit') }}</small>
          </div>
        </div>
      </section>
    </div>
  </SettingsGroup>
</template>

<script lang="ts" setup>
// 与内容脚本注入网页的是同一份样式表，预览与卡片缩略图因此与网页效果一致。
import '@/src/ui/styles/translation-display.css'
import {computed, ref, watch} from 'vue'
import type {Config} from '@/src/core/config/model'
import {
  DEFAULT_TRANSLATION_APPEARANCE,
  MAX_TRANSLATION_CUSTOM_CSS_LENGTH,
  TRANSLATION_BACKGROUND_COLOR_SWATCHES,
  TRANSLATION_FILL_COLOR_SWATCHES,
  TRANSLATION_FONT_FAMILY_OPTIONS,
  TRANSLATION_FONT_SCALE_RANGE,
  TRANSLATION_FONT_WEIGHT_OPTIONS,
  TRANSLATION_LINE_COLOR_SWATCHES,
  TRANSLATION_OPACITY_RANGE,
  TRANSLATION_STYLE_CATEGORIES,
  TRANSLATION_STYLE_PRESETS,
  TRANSLATION_TEXT_COLOR_SWATCHES,
  MAX_TRANSLATION_STYLE_PROFILES,
  getTranslationAppearanceStyle,
  getTranslationStylePreset,
  isDefaultTranslationAppearance,
  normalizeTranslationAppearance,
  parseTranslationCustomCss,
  type TranslationStyleCategory,
  type TranslationStyleProfile,
} from '@/src/core/config/translationAppearance'
import {useUiI18n} from '@/src/ui/i18n'
import SettingsGroup from './components/SettingsGroup.vue'
import SegmentedControl from './components/SegmentedControl.vue'
import TranslationColorField from './components/TranslationColorField.vue'
import TranslationStylePreview from './components/TranslationStylePreview.vue'

const props = defineProps<{
  config: Config
}>()
const {t, translateLegacy} = useUiI18n()
// 设置页会整体替换草稿；始终读取最新 prop，避免继续编辑旧配置对象。
const config = computed(() => props.config)
// 未知编号在网页上不加任何样式类，等同朴素模式；预览同样按朴素模式展示。
const selectedPreset = computed(() => getTranslationStylePreset(config.value.style) ?? TRANSLATION_STYLE_PRESETS[0])
const appearance = computed(() => config.value.translationAppearance)
const appearanceStyle = computed(() => getTranslationAppearanceStyle(appearance.value))
const cssValidation = computed(() => parseTranslationCustomCss(appearance.value.customCss))
const presetAppearanceStyle = computed(() => config.value.activeTranslationStyleProfileId ? {} : appearanceStyle.value)
const customized = computed(() => !isDefaultTranslationAppearance(appearance.value))
const activeProfile = computed(() => config.value.translationStyleProfiles.find((profile) => profile.id === config.value.activeTranslationStyleProfileId))
const customExpanded = ref(false)
const profileNameDraft = ref('')
const profileDirty = computed(() => activeProfile.value && (
  config.value.style !== activeProfile.value.style
  || profileNameDraft.value.trim() !== activeProfile.value.name
  || (Object.keys(DEFAULT_TRANSLATION_APPEARANCE) as Array<keyof typeof DEFAULT_TRANSLATION_APPEARANCE>)
    .some((key) => appearance.value[key] !== activeProfile.value?.appearance[key])
))
const pageTheme = ref<'light' | 'dark'>('light')
const activeCategory = ref<TranslationStyleCategory>(selectedPreset.value.category)
watch(() => selectedPreset.value.category, category => { activeCategory.value = category })
const visiblePresets = computed(() => TRANSLATION_STYLE_PRESETS.filter(preset => preset.category === activeCategory.value))
function selectCategory(value: string | number): void {
  activeCategory.value = TRANSLATION_STYLE_CATEGORIES.find(category => category.value === value)?.value ?? activeCategory.value
}
watch(() => [config.value.activeTranslationStyleProfileId, activeProfile.value?.name], () => {
  profileNameDraft.value = activeProfile.value?.name ?? ''
}, {immediate: true})
const categoryOptions = computed(() => TRANSLATION_STYLE_CATEGORIES.map((category) => ({value: category.value, label: t(category.labelKey)})))
const fontWeightOptions = computed(() => TRANSLATION_FONT_WEIGHT_OPTIONS.map((option) => ({value: option.value, label: t(option.labelKey)})))
const fontFamilyOptions = computed(() => TRANSLATION_FONT_FAMILY_OPTIONS.map((option) => ({value: option.value, label: t(option.labelKey)})))

function selectPreset(style: number): void {
  // 离开已保存的快照时恢复内置样式原貌；内置样式间切换仍沿用当前的全局外观微调。
  if (config.value.activeTranslationStyleProfileId) {
    config.value.translationAppearance = {...DEFAULT_TRANSLATION_APPEARANCE}
  }
  config.value.activeTranslationStyleProfileId = ''
  config.value.style = style
}

function selectProfile(profile: TranslationStyleProfile): void {
  config.value.style = profile.style
  config.value.translationAppearance = {...profile.appearance}
  config.value.activeTranslationStyleProfileId = profile.id
}

function profileName(): string {
  return profileNameDraft.value.trim().slice(0, 30)
}

function saveProfile(): void {
  if (config.value.translationStyleProfiles.length >= MAX_TRANSLATION_STYLE_PROFILES || !profileName()) return
  let id: string
  do {
    id = `style-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
  } while (config.value.translationStyleProfiles.some((profile) => profile.id === id))
  const profile: TranslationStyleProfile = {
    id,
    name: profileName(),
    style: config.value.style,
    appearance: normalizeTranslationAppearance(appearance.value),
  }
  config.value.translationStyleProfiles = [...config.value.translationStyleProfiles, profile]
  config.value.activeTranslationStyleProfileId = profile.id
}

function updateProfile(): void {
  if (!activeProfile.value || !profileName()) return
  const id = activeProfile.value.id
  config.value.translationStyleProfiles = config.value.translationStyleProfiles.map((profile) => profile.id === id
    ? {id, name: profileName(), style: config.value.style, appearance: normalizeTranslationAppearance(appearance.value)}
    : profile)
}

function deleteProfile(): void {
  if (!activeProfile.value) return
  const id = activeProfile.value.id
  config.value.translationStyleProfiles = config.value.translationStyleProfiles.filter((profile) => profile.id !== id)
  config.value.activeTranslationStyleProfileId = ''
}

function selectFontWeight(value: string | number): void {
  appearance.value.fontWeight = TRANSLATION_FONT_WEIGHT_OPTIONS.find((option) => option.value === value)?.value ?? 'default'
}

function selectFontFamily(value: string | number): void {
  appearance.value.fontFamily = TRANSLATION_FONT_FAMILY_OPTIONS.find((option) => option.value === value)?.value ?? 'default'
}

function commitFontScale(event: Event): void {
  const input = event.target as HTMLInputElement
  const value = input.value.trim()
  const normalized = value
    ? normalizeTranslationAppearance({fontScale: value}).fontScale
    : appearance.value.fontScale
  appearance.value.fontScale = normalized
  input.value = String(normalized)
}

function resetAppearance(): void {
  config.value.translationAppearance = {...DEFAULT_TRANSLATION_APPEARANCE}
}
</script>

<style scoped>
.translation-style-settings {
  display: grid;
  min-width: 0;
  gap: 14px;
  padding: 14px;
  /* 分组宽度随侧栏变化，布局按分组自身宽度切换，而不是按窗口宽度。 */
  container-type: inline-size;
}

.translation-style-mode-note {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--brand) 26%, var(--line));
  border-radius: 12px;
  color: var(--ink);
  background: color-mix(in srgb, var(--brand) 7%, var(--surface));
  font-size: 11.5px;
  line-height: 1.55;
}

.translation-style-mode-note button {
  flex: none;
  padding: 5px 11px;
  border: 0;
  border-radius: 8px;
  color: var(--brand-strong);
  background: var(--brand-soft);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}

.translation-style-workbench {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 14px;
}

.translation-style-stage {
  display: grid;
  min-width: 0;
  gap: 10px;
}

.translation-style-gallery {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 10px;
}

.translation-style-saved { display: grid; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.translation-style-saved > strong { color: var(--ink); font-size: 12.5px; }
.translation-style-saved-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); gap: 7px; }
.translation-style-saved-card {
  position: relative; display: grid; min-width: 0; gap: 7px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px;
  color: var(--ink); background: var(--surface); cursor: pointer; font: inherit; text-align: left;
}
.translation-style-saved-card-copy { display: grid; min-width: 0; gap: 3px; padding-right: 18px; }
.translation-style-saved-card strong { overflow: hidden; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.translation-style-saved-card small { color: var(--muted); font-size: 10px; }
.translation-style-saved-card.selected { border-color: var(--brand); background: var(--brand-soft); }
.translation-style-saved-card:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

.translation-style-gallery-heading {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}

.translation-style-gallery-heading strong {
  color: var(--ink);
  font-size: 12.5px;
}

.translation-style-categories.segmented-control {
  width: auto;
  min-width: min(100%, 260px);
  flex: 1 1 260px;
  max-width: 340px;
}

.translation-style-categories :deep(button) {
  min-height: 30px;
}

.translation-style-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(138px, 1fr));
  gap: 8px;
}

.translation-style-card {
  position: relative;
  display: grid;
  min-width: 0;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--ink);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
}

.translation-style-card:hover {
  border-color: color-mix(in srgb, var(--brand) 42%, var(--line));
  box-shadow: 0 8px 18px -14px rgba(15, 23, 42, .45);
}

.translation-style-card.selected {
  border-color: var(--brand);
  background: color-mix(in srgb, var(--brand) 5%, var(--surface));
  box-shadow: inset 0 0 0 1px var(--brand);
}

.translation-style-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 55%, transparent);
  outline-offset: 2px;
}

/* 缩略图模拟网页表面，不随扩展皮肤着色；网格布局让块级译文像网页中一样占满宽度。 */
.translation-style-card-sample {
  display: grid;
  min-width: 0;
  min-height: 42px;
  align-content: center;
  overflow: hidden;
  padding: 0 10px;
  border-radius: 8px;
  color: #1f2328;
  background: #fff;
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, .07);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 13px;
  line-height: 1.6;
  white-space: nowrap;
}

.translation-style-card-sample[data-page-theme="dark"] {
  color: #e6e8ec;
  background: #17191e;
  box-shadow: none;
}

.translation-style-card-name {
  min-width: 0;
  padding: 0 20px 0 4px;
  font-size: 11.5px;
  font-weight: 650;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.translation-style-card-check {
  position: absolute;
  right: 9px;
  bottom: 9px;
  display: grid;
  width: 13px;
  height: 13px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
}

.translation-style-card.selected .translation-style-card-check,
.translation-style-saved-card.selected .translation-style-card-check {
  border-color: var(--brand);
  background: var(--brand);
}

.translation-style-card-check > i {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: #fff;
  opacity: 0;
}

.translation-style-card.selected .translation-style-card-check > i,
.translation-style-saved-card.selected .translation-style-card-check > i { opacity: 1; }

.translation-style-apply-hint {
  margin: 0;
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.55;
}

.translation-appearance-panel {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-soft);
}

.translation-appearance-disclosure {
  display: flex; width: 100%; min-width: 0; align-items: center; gap: 12px; padding: 12px 16px;
  border: 0; color: var(--ink); background: transparent; cursor: pointer; font: inherit; text-align: left;
}
.translation-appearance-disclosure:hover { background: color-mix(in srgb, var(--brand) 4%, var(--surface-soft)); }
.translation-appearance-disclosure:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.translation-appearance-disclosure-copy { display: grid; flex: 1; min-width: 0; gap: 3px; }
.translation-appearance-disclosure-copy strong { font-size: 12.5px; }
.translation-appearance-disclosure-copy small { color: var(--muted); font-size: 10.5px; line-height: 1.45; }
.translation-appearance-status { flex: none; color: var(--brand-strong); font-size: 10.5px; font-weight: 700; }
.translation-appearance-chevron { width: 16px; height: 16px; flex: none; transition: transform 150ms ease; }
.translation-appearance-disclosure[aria-expanded="true"] .translation-appearance-chevron { transform: rotate(180deg); }
.translation-appearance-content { display: grid; gap: 16px; padding: 14px 16px 16px; border-top: 1px solid var(--line); }

.translation-profile-editor { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.translation-profile-editor > label { color: var(--ink); font-size: 11.5px; font-weight: 700; }
.translation-profile-editor-row { display: flex; flex-wrap: wrap; gap: 8px; }
.translation-profile-editor-row input { flex: 1 1 190px; min-width: 0; min-height: 34px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); }
.translation-profile-editor button { min-height: 32px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--brand-strong); background: var(--surface); cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; }
.translation-profile-editor button:hover:not(:disabled) { border-color: var(--brand); background: var(--brand-soft); }
.translation-profile-editor button:disabled { opacity: .5; cursor: default; }
.translation-profile-editor .translation-profile-save { border-color: var(--brand); color: #fff; background: var(--brand); }
.translation-profile-editor .translation-profile-save:hover:not(:disabled) { color: var(--brand-strong); }
.translation-profile-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.translation-profile-editor .translation-profile-delete { color: var(--muted); }
.translation-profile-editor > small { color: var(--muted); font-size: 10px; }

.translation-appearance-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.translation-appearance-heading small {
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.55;
}

.translation-appearance-reset {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--brand-strong);
  background: var(--surface);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  transition: border-color 140ms ease, background 140ms ease;
}

.translation-appearance-reset svg { width: 14px; height: 14px; }
.translation-appearance-reset:hover:not(:disabled) { border-color: var(--brand); background: var(--brand-soft); }
.translation-appearance-reset:disabled { color: var(--muted); cursor: default; opacity: .6; }

.translation-appearance-grid {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 18px 28px;
}

.translation-appearance-colors,
.translation-appearance-typography {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 14px;
}

.translation-appearance-range,
.translation-appearance-choice {
  display: grid;
  min-width: 0;
  gap: 7px;
}

.translation-appearance-range > span,
.translation-appearance-choice > span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--ink);
  font-size: 11.5px;
  font-weight: 700;
  line-height: 1.45;
}

.translation-appearance-range b {
  color: var(--brand-strong);
  font-variant-numeric: tabular-nums;
}

.translation-appearance-scale-controls {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.translation-appearance-range input[type="range"] {
  width: 100%;
  margin: 0;
  accent-color: var(--brand);
  cursor: pointer;
}

.translation-appearance-percent-input {
  display: inline-flex;
  width: 70px;
  flex: none;
  align-items: center;
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--ink);
  background: var(--surface);
  font-size: 11px;
}

.translation-appearance-percent-input input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.translation-appearance-percent-input:focus-within { outline: 2px solid var(--brand); outline-offset: 1px; }

.translation-custom-css { display: grid; min-width: 0; gap: 7px; }
.translation-custom-css label { color: var(--ink); font-size: 11.5px; font-weight: 700; }
.translation-custom-css small { color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.translation-custom-css textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 90px;
  resize: vertical;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  color: var(--ink);
  background: var(--surface);
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.translation-custom-css textarea:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.translation-custom-css textarea[aria-invalid="true"] { border-color: #dc2626; }
.translation-custom-css .translation-custom-css-error { color: #b91c1c; }

.translation-appearance-choice :deep(.segmented-control button) {
  min-height: 30px;
}

@container (min-width: 860px) {
  .translation-appearance-grid { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); }
}

@container (min-width: 700px) {
  .translation-style-workbench { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); }
}

@media (max-width: 520px) {
  .translation-style-settings { padding: 12px; }
  .translation-appearance-disclosure { padding: 12px; }
  .translation-appearance-content { padding: 12px; }
}
/* 样式本身就是信息：单层卡片保留真实缩略效果，不再叠放装饰性内框。 */
.translation-style-card-sample { border: 0; border-radius: 4px; padding: 8px 2px; box-shadow: none; }
.translation-style-card-name { padding-left: 0; font-size: 11px; font-weight: 500; color: var(--muted); }
.translation-style-card.selected .translation-style-card-name { color: var(--brand-strong); font-weight: 650; }
.translation-style-card-check { right: 9px; bottom: 9px; }
.translation-style-categories.segmented-control { min-width: 220px; max-width: 290px; }
@container (max-width: 480px) { .translation-style-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>

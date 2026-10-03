<!--
@file src/features/settings/ui/SentenceHighlightStyleSettings.vue
文件职责：在界面风格页独立选择双语逐句高亮外观，与译文整体样式分开设置。
主要内容：提供网页交互预览、八种预设、外观控件与 CSS 声明输入，支持命名快照的保存、切换、更新和删除；开关仍由阅读辅助管理。
模块边界：只编辑父级 Config 草稿；与网页共用命名和绘制声明，不请求翻译、不修改宿主 DOM。
-->
<template>
  <SettingsGroup id="translation-sentence-highlight-style" :title="t('sentenceHighlight.title')" :description="t('sentenceHighlight.description')">
    <div class="sentence-highlight-settings">
      <div class="sentence-highlight-workbench">
        <TranslationStylePreview
          style-class=""
          :appearance-style="{}"
          :highlight-enabled="true"
          :highlight-style="config.bilingualSentenceHighlightStyle"
          :highlight-appearance="config.bilingualSentenceHighlightAppearance"
          :initial-sentence="0"
          :translation-before-original="config.translationBeforeOriginal"
          :page-theme="pageTheme"
          :caption="t('sentenceHighlight.tryHint')"
          :customized="customized"
          @update:page-theme="pageTheme = $event"
        />
        <div class="sentence-highlight-options" role="radiogroup" :aria-label="t('sentenceHighlight.title')">
          <button v-for="style in SENTENCE_HIGHLIGHT_STYLES" :key="style.value" type="button" role="radio" class="sentence-highlight-option" :class="{selected: !config.activeSentenceHighlightProfileId && config.bilingualSentenceHighlightStyle === style.value}" :aria-label="t(style.labelKey)" :aria-checked="!config.activeSentenceHighlightProfileId && config.bilingualSentenceHighlightStyle === style.value" :data-highlight-style="style.value" @click="selectPreset(style.value)">
            <span class="bilingual-highlight-preview sentence-highlight-swatch" :data-fr-bilingual-sentence-highlight-style="style.value" :data-page-theme="pageTheme" aria-hidden="true"><span class="is-sentence-highlighted">{{ t('sentenceHighlight.sample') }}</span></span>
            <strong>{{ t(style.labelKey) }}</strong>
            <span class="sentence-highlight-check" aria-hidden="true">{{ !config.activeSentenceHighlightProfileId && config.bilingualSentenceHighlightStyle === style.value ? '●' : '○' }}</span>
          </button>
        </div>
      </div>
      <section v-if="config.bilingualSentenceHighlightProfiles.length" class="sentence-highlight-saved" aria-labelledby="sentence-highlight-saved-title">
        <strong id="sentence-highlight-saved-title">{{ t('sentenceHighlight.savedTitle') }}</strong>
        <div class="sentence-highlight-saved-list" role="radiogroup" :aria-label="t('sentenceHighlight.savedTitle')">
          <button v-for="profile in config.bilingualSentenceHighlightProfiles" :key="profile.id" type="button" role="radio" class="sentence-highlight-option sentence-highlight-saved-card" data-i18n-ignore :class="{selected: config.activeSentenceHighlightProfileId === profile.id}" :aria-checked="config.activeSentenceHighlightProfileId === profile.id" :aria-label="profile.name" :data-profile-id="profile.id" @click="selectProfile(profile)">
            <span class="bilingual-highlight-preview sentence-highlight-swatch" :data-fr-bilingual-sentence-highlight-style="profile.style" :data-page-theme="pageTheme" aria-hidden="true"><span class="is-sentence-highlighted" :style="getSentenceHighlightAppearanceStyle(profile.style, profile.appearance)">{{ t('sentenceHighlight.sample') }}</span></span>
            <strong :title="profile.name">{{ profile.name }}</strong>
            <small>{{ t('settings.translationStyle.profileBase', {name: t(SENTENCE_HIGHLIGHT_STYLES.find(style => style.value === profile.style)!.labelKey)}) }}</small>
          </button>
        </div>
      </section>
      <section class="sentence-highlight-custom" aria-labelledby="sentence-highlight-custom-title" data-testid="sentence-highlight-custom">
        <header class="sentence-highlight-custom-heading">
          <div><strong id="sentence-highlight-custom-title">{{ t('sentenceHighlight.customTitle') }}</strong><p>{{ t('sentenceHighlight.customHint') }}</p></div>
          <span v-if="profileDirty" class="sentence-highlight-dirty" role="status">{{ t('settings.translationStyle.unsavedChanges') }}</span>
          <button type="button" :disabled="!customized" @click="resetAppearance">{{ t('sentenceHighlight.reset') }}</button>
        </header>
        <div class="sentence-highlight-custom-grid">
          <div class="sentence-highlight-custom-column">
            <TranslationColorField v-model="appearance.backgroundColor" field-id="sentence-highlight-background" :label="t('sentenceHighlight.backgroundColor')" :swatches="TRANSLATION_FILL_COLOR_SWATCHES" />
            <label class="sentence-highlight-range">
              <span>{{ t('sentenceHighlight.backgroundOpacity') }}<b>{{ resolved.backgroundOpacity }}%</b></span>
              <input type="range" min="0" max="100" step="1" :value="resolved.backgroundOpacity" :aria-label="t('sentenceHighlight.backgroundOpacity')" @input="updateNumber('backgroundOpacity', $event)">
            </label>
          </div>
          <div class="sentence-highlight-custom-column">
            <TranslationColorField v-model="appearance.lineColor" field-id="sentence-highlight-line" :label="t('sentenceHighlight.lineColor')" :swatches="TRANSLATION_LINE_COLOR_SWATCHES" />
            <label class="sentence-highlight-range">
              <span>{{ t('sentenceHighlight.lineOpacity') }}<b>{{ resolved.lineOpacity }}%</b></span>
              <input type="range" min="0" max="100" step="1" :value="resolved.lineOpacity" :aria-label="t('sentenceHighlight.lineOpacity')" @input="updateNumber('lineOpacity', $event)">
            </label>
          </div>
          <label class="sentence-highlight-line-style">
            <span>{{ t('sentenceHighlight.lineStyle') }}</span>
            <select v-model="appearance.lineStyle" :aria-label="t('sentenceHighlight.lineStyle')">
              <option v-for="style in SENTENCE_HIGHLIGHT_LINE_STYLES" :key="style" :value="style">{{ t(`sentenceHighlight.line.${style}`) }}</option>
            </select>
          </label>
          <label class="sentence-highlight-range">
            <span>{{ t('sentenceHighlight.lineThickness') }}<b>{{ resolved.lineThickness }}px</b></span>
            <input type="range" min="1" max="4" step="1" :value="resolved.lineThickness" :aria-label="t('sentenceHighlight.lineThickness')" @input="updateNumber('lineThickness', $event)">
          </label>
        </div>
        <div class="sentence-highlight-css">
          <label for="sentence-highlight-custom-css">{{ t('settings.translationStyle.customCssTitle') }}</label>
          <small id="sentence-highlight-custom-css-hint">{{ t('sentenceHighlight.customCssHint') }}</small>
          <textarea id="sentence-highlight-custom-css" v-model="appearance.customCss" :maxlength="MAX_TRANSLATION_CUSTOM_CSS_LENGTH" :aria-invalid="cssValidation.invalidCount > 0" aria-describedby="sentence-highlight-custom-css-hint" rows="4" spellcheck="false" placeholder="background-color: rgba(255, 220, 100, 0.3);&#10;text-decoration: underline wavy #9d4edd;&#10;text-decoration-thickness: 2px;" />
          <small v-if="cssValidation.invalidCount" class="sentence-highlight-css-error" role="alert">{{ t('sentenceHighlight.customCssInvalid') }}</small>
        </div>
        <div class="sentence-highlight-profile-editor">
          <label for="sentence-highlight-profile-name">{{ t('settings.translationStyle.profileName') }}</label>
          <div class="sentence-highlight-profile-row">
            <input id="sentence-highlight-profile-name" v-model="profileNameDraft" type="text" maxlength="30" :placeholder="t('settings.translationStyle.profileNamePlaceholder')">
            <button type="button" :disabled="config.bilingualSentenceHighlightProfiles.length >= MAX_SENTENCE_HIGHLIGHT_PROFILES || !profileNameDraft.trim()" @click="saveProfile">{{ t('settings.translationStyle.saveAsNew') }}</button>
          </div>
          <div v-if="activeProfile" class="sentence-highlight-profile-actions">
            <button type="button" :disabled="!profileNameDraft.trim() || !profileDirty" @click="updateProfile">{{ t('settings.translationStyle.updateSaved') }}</button>
            <button type="button" class="sentence-highlight-profile-delete" @click="deleteProfile">{{ t('settings.translationStyle.deleteSaved') }}</button>
          </div>
          <small v-if="config.bilingualSentenceHighlightProfiles.length >= MAX_SENTENCE_HIGHLIGHT_PROFILES">{{ t('settings.translationStyle.profileLimit') }}</small>
        </div>
      </section>
      <p class="sentence-highlight-note">{{ t('sentenceHighlight.enableHint') }}</p>
    </div>
  </SettingsGroup>
</template>
<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import type {Config} from '@/src/core/config/model'
import {DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE, MAX_SENTENCE_HIGHLIGHT_PROFILES, SENTENCE_HIGHLIGHT_STYLES, SENTENCE_HIGHLIGHT_LINE_STYLES, getSentenceHighlightAppearanceStyle, isDefaultSentenceHighlightAppearance, normalizeSentenceHighlightAppearance, parseSentenceHighlightCustomCss, resolveSentenceHighlightAppearance, type SentenceHighlightStyle, type SentenceHighlightProfile} from '@/src/core/config/sentenceHighlight'
import {MAX_TRANSLATION_CUSTOM_CSS_LENGTH, TRANSLATION_FILL_COLOR_SWATCHES, TRANSLATION_LINE_COLOR_SWATCHES} from '@/src/core/config/translationAppearance'
import {useUiI18n} from '@/src/ui/i18n'
import SettingsGroup from './components/SettingsGroup.vue'
import TranslationStylePreview from './components/TranslationStylePreview.vue'
import TranslationColorField from './components/TranslationColorField.vue'
const props = defineProps<{config: Config}>()
const {t} = useUiI18n()
const pageTheme = ref<'light' | 'dark'>('light')
const appearance = computed(() => props.config.bilingualSentenceHighlightAppearance)
const resolved = computed(() => resolveSentenceHighlightAppearance(props.config.bilingualSentenceHighlightStyle, appearance.value))
const customized = computed(() => !isDefaultSentenceHighlightAppearance(appearance.value))
const cssValidation = computed(() => parseSentenceHighlightCustomCss(appearance.value.customCss))
const activeProfile = computed(() => props.config.bilingualSentenceHighlightProfiles.find(profile => profile.id === props.config.activeSentenceHighlightProfileId))
const profileNameDraft = ref('')
const profileDirty = computed(() => Boolean(activeProfile.value && (
  profileNameDraft.value.trim() !== activeProfile.value.name
  || props.config.bilingualSentenceHighlightStyle !== activeProfile.value.style
  || JSON.stringify(normalizeSentenceHighlightAppearance(appearance.value)) !== JSON.stringify(activeProfile.value.appearance)
)))
watch(() => [props.config.activeSentenceHighlightProfileId, activeProfile.value?.name], () => {
  profileNameDraft.value = activeProfile.value?.name ?? ''
}, {immediate: true})
function resetAppearance(): void {
  props.config.bilingualSentenceHighlightAppearance = {...DEFAULT_SENTENCE_HIGHLIGHT_APPEARANCE}
}
function selectPreset(style: SentenceHighlightStyle): void {
  props.config.activeSentenceHighlightProfileId = ''
  props.config.bilingualSentenceHighlightStyle = style
  resetAppearance()
}
function selectProfile(profile: SentenceHighlightProfile): void {
  props.config.bilingualSentenceHighlightStyle = profile.style
  props.config.bilingualSentenceHighlightAppearance = {...profile.appearance}
  props.config.activeSentenceHighlightProfileId = profile.id
  profileNameDraft.value = profile.name
}
function saveProfile(): void {
  const name = profileNameDraft.value.trim()
  if (!name || props.config.bilingualSentenceHighlightProfiles.length >= MAX_SENTENCE_HIGHLIGHT_PROFILES) return
  let id: string
  do {
    id = `sentence-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
  } while (props.config.bilingualSentenceHighlightProfiles.some(profile => profile.id === id))
  const profile: SentenceHighlightProfile = {
    id, name,
    style: props.config.bilingualSentenceHighlightStyle,
    appearance: normalizeSentenceHighlightAppearance(appearance.value),
  }
  props.config.bilingualSentenceHighlightProfiles = [...props.config.bilingualSentenceHighlightProfiles, profile]
  props.config.activeSentenceHighlightProfileId = profile.id
}
function updateProfile(): void {
  const profile = activeProfile.value
  const name = profileNameDraft.value.trim()
  if (!profile || !name) return
  props.config.bilingualSentenceHighlightProfiles = props.config.bilingualSentenceHighlightProfiles.map(item => item.id === profile.id
    ? {...profile, name, style: props.config.bilingualSentenceHighlightStyle, appearance: normalizeSentenceHighlightAppearance(appearance.value)} : item)
}
function deleteProfile(): void {
  props.config.bilingualSentenceHighlightProfiles = props.config.bilingualSentenceHighlightProfiles.filter(profile => profile.id !== props.config.activeSentenceHighlightProfileId)
  props.config.activeSentenceHighlightProfileId = ''
}
function updateNumber(field: 'backgroundOpacity' | 'lineOpacity' | 'lineThickness', event: Event): void {
  appearance.value[field] = Number((event.target as HTMLInputElement).value)
}
</script>
<style scoped>
.sentence-highlight-settings { container-type: inline-size; padding: 16px; }
.sentence-highlight-workbench { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
.sentence-highlight-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.sentence-highlight-option { position: relative; display: grid; gap: 7px; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--ink); background: var(--surface); cursor: pointer; text-align: start; font: inherit; }
.sentence-highlight-option:hover { border-color: var(--brand); }
.sentence-highlight-option.selected { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); background: var(--brand-soft); }
.sentence-highlight-option:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.sentence-highlight-option strong { padding-right: 16px; font-size: 12px; }
.sentence-highlight-swatch { display: block; border-radius: 6px; padding: 10px 8px; background: #fff; color: #1f2328; font-size: 13px; line-height: 1.8; }
.sentence-highlight-swatch[data-page-theme="dark"] { background: #17191e; color: #e6e8ec; }
.sentence-highlight-check { position: absolute; right: 12px; bottom: 12px; color: var(--brand-strong); }
.sentence-highlight-note { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.7; }
.sentence-highlight-custom { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.sentence-highlight-custom-heading { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.sentence-highlight-custom-heading strong { color: var(--ink); font-size: 13px; }
.sentence-highlight-custom-heading p { margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
.sentence-highlight-custom-heading button { flex: none; border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; color: var(--brand-strong); background: var(--surface); cursor: pointer; font: inherit; font-size: 11px; }
.sentence-highlight-custom-heading button:disabled { opacity: .5; cursor: default; }
.sentence-highlight-custom-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
.sentence-highlight-custom-column { display: grid; gap: 14px; min-width: 0; }
.sentence-highlight-range, .sentence-highlight-line-style { display: grid; min-width: 0; align-content: start; gap: 8px; color: var(--ink); font-size: 11.5px; }
.sentence-highlight-range > span { display: flex; justify-content: space-between; gap: 8px; }
.sentence-highlight-range b { color: var(--brand-strong); font-weight: 600; }
.sentence-highlight-range input { width: 100%; min-width: 0; margin: 0; accent-color: var(--brand); cursor: pointer; }
.sentence-highlight-line-style select { width: 100%; min-width: 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); font: inherit; }
.sentence-highlight-custom :is(button, input, select):focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.sentence-highlight-saved { display: grid; gap: 10px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.sentence-highlight-saved > strong { color: var(--ink); font-size: 13px; }
.sentence-highlight-saved-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 10px; }
.sentence-highlight-saved-card strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sentence-highlight-saved-card small { color: var(--muted); font-size: 11px; }
.sentence-highlight-dirty { color: var(--brand-strong); font-size: 11px; }
.sentence-highlight-css, .sentence-highlight-profile-editor { display: grid; min-width: 0; gap: 7px; margin-top: 18px; color: var(--ink); font-size: 11.5px; }
.sentence-highlight-css small, .sentence-highlight-profile-editor small { color: var(--muted); line-height: 1.6; }
.sentence-highlight-css textarea, .sentence-highlight-profile-row input { min-width: 0; width: 100%; box-sizing: border-box; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); font: inherit; }
.sentence-highlight-css textarea { resize: vertical; font-family: ui-monospace, monospace; line-height: 1.6; }
.sentence-highlight-css .sentence-highlight-css-error { color: var(--el-color-danger); }
.sentence-highlight-css textarea:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.sentence-highlight-profile-row, .sentence-highlight-profile-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.sentence-highlight-profile-row input { flex: 1 1 180px; }
.sentence-highlight-profile-row button, .sentence-highlight-profile-actions button { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; color: var(--brand-strong); background: var(--surface); font: inherit; cursor: pointer; }
.sentence-highlight-profile-row button:disabled, .sentence-highlight-profile-actions button:disabled { opacity: .5; cursor: default; }
.sentence-highlight-profile-actions .sentence-highlight-profile-delete { color: var(--el-color-danger); }
@container (min-width: 550px) { .sentence-highlight-custom-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 700px) { .sentence-highlight-workbench { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); } }
@container (min-width: 1000px) { .sentence-highlight-options { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (max-width: 340px) { .sentence-highlight-options { grid-template-columns: minmax(0, 1fr); } }
</style>

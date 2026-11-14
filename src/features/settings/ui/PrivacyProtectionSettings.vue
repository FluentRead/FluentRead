<!--
 * @file src/features/settings/ui/PrivacyProtectionSettings.vue
 * 文件职责：以现有设置行、分段控件与选项按钮呈现翻译隐私防护，不占用主页面展示调试表单。
 * 主要内容：标题行直接启停，集中编辑处理方式与保护类别；固定示例随规则变化，仅作效果预览；自定义词在紧凑弹窗中编辑，取消、离页和卸载清空草稿，旧回调不能修改新会话。
 * 模块边界：配置仍由父级编辑器统一保存；预览复用纯本地检测规则，不接受测试输入、不调用翻译服务，也不读写 storage。
 -->
<template>
  <SettingsGroup :title="t('privacy.title')" data-privacy-settings>
    <template #heading-extra>
      <div class="privacy-heading-actions">
        <FieldHelp :content="`${t('privacy.scope')} ${t('privacy.boundary')} ${t('privacy.localPolicy')}`" :label="t('privacy.scope')" />
        <el-switch :model-value="config.privacyProtection.enabled" :disabled="!context.active.value"
          :aria-label="t('privacy.enabled')" :onUpdate:modelValue="actions.enabled" />
      </div>
    </template>
    <template v-if="config.privacyProtection.enabled">
      <SettingsItem :label="t('privacy.mode')" :help="t('privacy.modeHelp')">
        <SegmentedControl class="privacy-mode" :model-value="config.privacyProtection.mode" :label="t('privacy.mode')" compact
          :options="[{value: 'mask', label: t('privacy.mask')}, {value: 'block', label: t('privacy.block')}]"
          :disabled="!context.active.value" :onUpdate:modelValue="actions.mode" />
      </SettingsItem>
      <SettingsItem :label="t('privacy.categories')" class="privacy-category-row">
        <div class="privacy-categories" role="group" :aria-label="t('privacy.categories')">
          <button v-for="category in PRIVACY_CATEGORIES" :key="category" type="button" class="privacy-category"
            :class="{'is-selected': config.privacyProtection.categories.includes(category)}"
            :aria-pressed="config.privacyProtection.categories.includes(category)" :data-privacy-category="category"
            :disabled="!context.active.value" :onClick="actions.category[category]">
            <span>{{ t(`privacy.category.${category}`) }}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>
          </button>
        </div>
      </SettingsItem>
      <SettingsItem :label="t('privacy.custom')" :description="t('privacy.customHelp')">
        <span v-if="config.privacyProtectionSecretTerms.length" class="privacy-term-count">{{ t('privacy.customCount', {count: config.privacyProtectionSecretTerms.length}) }}</span>
        <el-button size="small" :disabled="!context.active.value" :onClick="actions.manage">{{ t('privacy.manage') }}</el-button>
      </SettingsItem>
      <div class="privacy-preview" role="figure" :aria-label="t('privacy.preview')">
        <span class="privacy-preview-label">{{ t('privacy.preview') }}</span>
        <div class="privacy-preview-pair">
          <span class="privacy-preview-source">{{ sample }}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h12M9 3l5 5-5 5" /></svg>
          <span v-if="preview.blocked" class="privacy-preview-blocked" data-privacy-preview>{{ t('privacy.previewBlocked') }}</span>
          <span v-else class="privacy-preview-result" data-privacy-preview><span v-for="(part, index) in preview.parts" :key="index" :class="{'privacy-masked': part.hidden}">{{ part.text }}</span></span>
        </div>
      </div>
    </template>
    <el-dialog v-if="termsOpen" :model-value="true" :title="t('privacy.custom')" width="min(480px, calc(100vw - 32px))"
      align-center destroy-on-close :close-on-click-modal="false" :onUpdate:modelValue="actions.dialog" data-privacy-terms-dialog>
      <p class="privacy-editor-help">{{ t('privacy.customEditorHelp') }}</p>
      <el-input :model-value="termsDraft" type="textarea" :autosize="{minRows: 4, maxRows: 8}"
        :maxlength="MAX_PRIVACY_TERMS * (MAX_PRIVACY_TERM_LENGTH + 1)" :aria-label="t('privacy.custom')"
        autocomplete="off" spellcheck="false" :disabled="!context.active.value" :onUpdate:modelValue="actions.draft" />
      <p class="privacy-editor-limit" :class="{'is-invalid': !termsValid}" :role="!termsValid ? 'alert' : undefined">
        {{ t(termsValid ? 'privacy.customLimits' : 'privacy.invalidTerms', {count: MAX_PRIVACY_TERMS, length: MAX_PRIVACY_TERM_LENGTH}) }}
      </p>
      <template #footer>
        <el-button size="small" :onClick="actions.cancel">{{ t('common.cancel') }}</el-button>
        <el-button size="small" type="primary" :disabled="!context.active.value || !termsChanged || !termsValid" :onClick="actions.terms">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import type {Config} from '@/src/core/config/model';
import {createPrivacyDetector} from '@/src/core/privacy/detect';
import {MAX_PRIVACY_TERMS, MAX_PRIVACY_TERM_LENGTH, normalizePrivacyTerms, PRIVACY_CATEGORIES, type PrivacyCategory} from '@/src/core/privacy/policy';
import {useSettingsActionContext} from '../model/useSettingsActionContext';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';
import SettingsItem from './components/SettingsItem.vue';
import SegmentedControl from './components/SegmentedControl.vue';
import FieldHelp from './components/FieldHelp.vue';

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {t} = useUiI18n();
const context = useSettingsActionContext(() => props.active, () => [props.config, JSON.stringify(props.config.privacyProtection), props.config.privacyProtectionSecretTerms]);
const termsOpen = ref(false);
const termsDraft = ref('');
const terms = computed(() => termsDraft.value.split('\n').map(term => term.trim()).filter(Boolean));
const termsValid = computed(() => terms.value.length <= MAX_PRIVACY_TERMS && terms.value.every(term => term.length <= MAX_PRIVACY_TERM_LENGTH));
const termsChanged = computed(() => JSON.stringify(normalizePrivacyTerms(terms.value)) !== JSON.stringify(props.config.privacyProtectionSecretTerms));
const sample = computed(() => t('privacy.sampleText'));
const preview = computed(() => {
  const input = sample.value;
  const spans = createPrivacyDetector(props.config.privacyProtection, props.config.privacyProtectionSecretTerms)(input);
  const parts: Array<{text: string; hidden: boolean}> = [];
  let offset = 0;
  for (const span of spans) {
    parts.push({text: input.slice(offset, span.start), hidden: false}, {text: t(`privacy.category.${span.category}`), hidden: true});
    offset = span.end;
  }
  parts.push({text: input.slice(offset), hidden: false});
  return {parts, blocked: props.config.privacyProtection.mode === 'block' && spans.length > 0};
});
function closeTerms() {termsOpen.value = false; termsDraft.value = '';}
watch(() => props.config.privacyProtectionSecretTerms, value => {if (termsOpen.value) termsDraft.value = value.join('\n');});
watch(() => [context.active.value, props.config], closeTerms, {flush: 'sync'});
onBeforeUnmount(closeTerms);
const actions = computed(() => {
  const owns = context.capture();
  return {
    enabled(value: unknown) {if (owns() && typeof value === 'boolean') props.config.privacyProtection = {...props.config.privacyProtection, enabled: value};},
    mode(value: unknown) {if (owns() && (value === 'mask' || value === 'block')) props.config.privacyProtection = {...props.config.privacyProtection, mode: value};},
    category: Object.fromEntries(PRIVACY_CATEGORIES.map(category => [category, () => {
      if (!owns()) return;
      const selected = props.config.privacyProtection.categories.includes(category);
      props.config.privacyProtection = {...props.config.privacyProtection,
        categories: PRIVACY_CATEGORIES.filter(item => item === category ? !selected : props.config.privacyProtection.categories.includes(item))};
    }])) as Record<PrivacyCategory, () => void>,
    manage() {if (owns()) {termsDraft.value = props.config.privacyProtectionSecretTerms.join('\n'); termsOpen.value = true;}},
    draft(value: unknown) {if (owns() && termsOpen.value && typeof value === 'string') termsDraft.value = value;},
    dialog(value: unknown) {if (owns() && value === false) closeTerms();},
    cancel() {if (owns()) closeTerms();},
    terms() {
      if (!owns() || !termsOpen.value || !termsValid.value) return;
      props.config.privacyProtectionSecretTerms = normalizePrivacyTerms(terms.value);
      closeTerms();
    },
  };
});
</script>

<style scoped>
.privacy-heading-actions { display: inline-flex; align-items: center; flex: none; gap: 8px; }
.privacy-mode { max-width: 280px; }
.privacy-category-row { grid-template-columns: 150px minmax(0, 1fr); }
.privacy-categories { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.privacy-category { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface); font: inherit; font-size: 12px; cursor: pointer; }
.privacy-category svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; opacity: 0; }
.privacy-category.is-selected { border-color: color-mix(in srgb, var(--brand) 28%, var(--line)); color: var(--brand-strong); background: var(--brand-soft); }
.privacy-category.is-selected svg { opacity: 1; }
.privacy-category:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.privacy-category:disabled { opacity: .55; cursor: default; }
.privacy-term-count, .privacy-preview-label, .privacy-editor-limit { color: var(--muted); font-size: 12px; }
.privacy-preview { display: grid; gap: 9px; padding: 12px var(--fr-card-padding-inline, 20px) 14px; border-top: 1px solid var(--line); background: var(--surface-soft); }
.privacy-preview-pair { display: grid; grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr); align-items: center; gap: 12px; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.privacy-preview-source { color: var(--muted); }
.privacy-preview-pair > svg { width: 14px; height: 14px; fill: none; stroke: var(--muted); stroke-width: 1.4; }
.privacy-preview-result { color: var(--ink); }
.privacy-masked { padding: 1px 4px; border-radius: 4px; color: var(--brand-strong); background: var(--brand-soft); }
.privacy-preview-blocked { color: var(--brand-strong); }
.privacy-editor-help { margin: 0 0 12px; color: var(--muted); font-size: 12px; line-height: 1.7; }
.privacy-editor-limit { margin: 8px 0 0; line-height: 1.6; }
.privacy-editor-limit.is-invalid { color: var(--el-color-danger); }
@media (max-width: 700px) { .privacy-category-row { grid-template-columns: minmax(0, 1fr); gap: 10px; } .privacy-categories { justify-content: flex-start; } }
@media (max-width: 480px) { .privacy-mode { max-width: none; } .privacy-preview-pair { grid-template-columns: minmax(0, 1fr); gap: 5px; } .privacy-preview-pair > svg { display: none; } }
</style>

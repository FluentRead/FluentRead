<!--
 * @file src/features/settings/ui/ExcludedTagSettings.vue
 * 文件职责：提供网页翻译不翻译标签与 CSS 选择器的可视化设置，支持常见 HTML 标签一键多选与自定义选择器录入。
 * 主要内容：展示常见可排除 HTML 标签的快捷切换按钮，提供支持逗号、分号和换行分隔的自定义标签/选择器输入框，实时校验语法并拦截整页根选择器，展示已添加的自定义条目以便逐项移除或一键清空；所有标签字面值标记 data-i18n-ignore，界面文案全部走稳定 message key。
 * 模块边界：本组件只通过 v-model 编辑父级配置副本，保存、跨页同步与候选跳过均由现有配置服务和翻译候选核心负责。
 -->
<template>
  <SettingsGroup :title="t('settings.excludedTags.title')" :description="t('settings.excludedTags.description')" data-testid="excluded-tag-settings">
    <div class="excluded-tag-body">
      <div class="excluded-tag-options" role="group" :aria-label="t('settings.excludedTags.title')">
        <button
          v-for="tag in COMMON_EXCLUDED_TAG_OPTIONS"
          :key="tag"
          type="button"
          class="excluded-tag-option"
          :class="{'is-selected': selectedSet.has(tag)}"
          :data-tag="tag"
          :aria-pressed="selectedSet.has(tag)"
          @click="toggle(tag)"
        >
          <code data-i18n-ignore>{{ tag }}</code>
          <svg viewBox="0 0 16 16" aria-hidden="true" :class="{'is-visible': selectedSet.has(tag)}"><path d="m3 8 3 3 7-7" /></svg>
        </button>
      </div>
      <div class="excluded-tag-input-row">
        <input
          v-model="draft"
          type="text"
          class="excluded-tag-input"
          :aria-label="t('settings.excludedTags.inputLabel')"
          :placeholder="t('settings.excludedTags.placeholder')"
          @input="clearError"
          @keydown.enter.prevent="addDraft"
        >
        <button type="button" class="excluded-tag-add" :disabled="!draft.trim()" @click="addDraft">
          {{ t('settings.excludedTags.add') }}
        </button>
      </div>
      <p v-if="errorMessage" class="excluded-tag-error" role="alert">{{ errorMessage }}</p>
      <div v-if="customEntries.length" class="excluded-tag-custom-list" role="list">
        <button
          v-for="selector in customEntries"
          :key="selector"
          type="button"
          role="listitem"
          class="excluded-tag-chip"
          :data-custom-tag="selector"
          :aria-label="t('settings.excludedTags.remove', {tag: selector})"
          @click="remove(selector)"
        >
          <code data-i18n-ignore>{{ selector }}</code>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div v-if="modelValue.length" class="excluded-tag-actions">
        <button type="button" @click="clearAll">{{ t('settings.excludedTags.clear') }}</button>
      </div>
      <p class="excluded-tag-hint">{{ t('settings.excludedTags.hint') }}</p>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue';
import {
  COMMON_EXCLUDED_TAG_OPTIONS,
  normalizeExcludedTags,
  splitExcludedTagInput,
  validateExcludedTagSelector,
} from '@/src/core/config/pageTranslation';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';

const presetTags = new Set<string>(COMMON_EXCLUDED_TAG_OPTIONS);

const props = defineProps<{modelValue: string[]}>();
const emit = defineEmits<{'update:modelValue': [value: string[]]}>();
const {t} = useUiI18n();
const draft = ref('');
const errorState = ref<{kind: 'invalid' | 'disallowed'; tags: string[]} | null>(null);

const selectedSet = computed(() => new Set(props.modelValue));
const customEntries = computed(() => props.modelValue.filter(item => !presetTags.has(item)));
const errorMessage = computed(() => {
  if (!errorState.value) return '';
  return t(
    errorState.value.kind === 'disallowed' ? 'settings.excludedTags.disallowed' : 'settings.excludedTags.invalid',
    {tags: errorState.value.tags.join(', ')},
  );
});

function clearError(): void {
  errorState.value = null;
}

function toggle(tag: string): void {
  clearError();
  emit('update:modelValue', normalizeExcludedTags(
    selectedSet.value.has(tag)
      ? props.modelValue.filter(item => item !== tag)
      : [...props.modelValue, tag],
  ));
}

function remove(selector: string): void {
  clearError();
  emit('update:modelValue', normalizeExcludedTags(props.modelValue.filter(item => item !== selector)));
}

function clearAll(): void {
  clearError();
  emit('update:modelValue', []);
}

function addDraft(): void {
  const entries = splitExcludedTagInput(draft.value);
  if (entries.length === 0) return;
  const accepted: string[] = [];
  const disallowed: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const result = validateExcludedTagSelector(entry);
    if (result.ok) {
      accepted.push(result.selector);
    } else if (result.reason === 'disallowed') {
      disallowed.push(entry);
    } else {
      invalid.push(entry);
    }
  }
  if (accepted.length > 0) {
    emit('update:modelValue', normalizeExcludedTags([...props.modelValue, ...accepted]));
  }
  if (disallowed.length > 0) {
    errorState.value = {kind: 'disallowed', tags: disallowed};
    draft.value = [...disallowed, ...invalid].join(', ');
    return;
  }
  if (invalid.length > 0) {
    errorState.value = {kind: 'invalid', tags: invalid};
    draft.value = invalid.join(', ');
    return;
  }
  errorState.value = null;
  draft.value = '';
}
</script>

<style scoped>
.excluded-tag-body { padding: 16px 20px 18px; }
.excluded-tag-options { display: flex; flex-wrap: wrap; gap: 8px; }
.excluded-tag-option { display: inline-flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 38px; max-width: 100%; padding: 7px 13px; border: 1px solid var(--el-border-color-light); border-radius: 10px; background: var(--el-fill-color-light); color: var(--el-text-color-primary); font: inherit; font-weight: 500; text-align: start; cursor: pointer; }
.excluded-tag-option code, .excluded-tag-chip code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }
.excluded-tag-option.is-selected { border-color: var(--el-color-primary); color: var(--el-color-primary); background: color-mix(in srgb, var(--el-color-primary) 9%, var(--surface)); }
.excluded-tag-option:hover { border-color: var(--el-color-primary); }
.excluded-tag-option:focus-visible, .excluded-tag-add:focus-visible, .excluded-tag-chip:focus-visible, .excluded-tag-actions button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.excluded-tag-option svg { width: 15px; height: 15px; flex: 0 0 15px; visibility: hidden; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.excluded-tag-option svg.is-visible { visibility: visible; }
.excluded-tag-input-row { display: flex; gap: 10px; margin-top: 14px; }
.excluded-tag-input { flex: 1 1 auto; min-width: 0; min-height: 38px; padding: 8px 12px; border: 1px solid var(--el-border-color); border-radius: 10px; background: var(--surface, var(--el-bg-color)); color: var(--el-text-color-primary); font: inherit; font-size: 13px; }
.excluded-tag-input:focus { border-color: var(--el-color-primary); outline: none; }
.excluded-tag-add { flex: 0 0 auto; min-height: 38px; padding: 0 16px; border: 1px solid var(--el-color-primary); border-radius: 10px; background: var(--el-color-primary); color: #fff; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.excluded-tag-add:disabled { opacity: 0.5; cursor: not-allowed; }
.excluded-tag-error { margin: 8px 0 0; color: var(--el-color-danger); font-size: 12px; line-height: 1.5; }
.excluded-tag-custom-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.excluded-tag-chip { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; max-width: 100%; padding: 4px 11px; border: 1px solid var(--el-color-primary); border-radius: 999px; background: color-mix(in srgb, var(--el-color-primary) 9%, var(--surface)); color: var(--el-color-primary); font: inherit; cursor: pointer; }
.excluded-tag-chip span { font-size: 15px; line-height: 1; }
.excluded-tag-actions { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 12px; }
.excluded-tag-actions button { padding: 2px 0; border: 0; background: none; color: var(--el-color-primary); font: inherit; cursor: pointer; }
.excluded-tag-hint { margin: 12px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
@media (max-width: 480px) { .excluded-tag-options { gap: 6px; } .excluded-tag-option { gap: 8px; padding: 6px 10px; } .excluded-tag-input-row { flex-direction: column; } }
</style>

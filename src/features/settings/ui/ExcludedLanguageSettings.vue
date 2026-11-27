<!--
 * @file src/features/settings/ui/ExcludedLanguageSettings.vue
 * 文件职责：提供网页翻译排除语言的多选设置，使用可换行的选项按钮表达选中状态。
 * 主要内容：常用语言默认展开，更多语言可展开选择，收起时保留已选语言；支持键盘切换、清空和主题自适应。
 * 模块边界：只通过 v-model 编辑父级配置副本，保存、同步和翻译判断由现有配置服务及网页运行时负责。
 -->
<template>
  <SettingsGroup :title="t('settings.excludedLanguages.title')" :description="t('settings.excludedLanguages.description')" data-testid="excluded-language-settings">
    <div class="excluded-language-body">
      <div class="excluded-language-options" role="group" :aria-label="t('settings.excludedLanguages.title')">
        <button v-for="item in visibleOptions" :key="item.value" type="button"
          class="excluded-language-option" :class="{'is-selected': modelValue.includes(item.value)}"
          :data-language="item.value" :aria-pressed="modelValue.includes(item.value)"
          @click="toggle(item.value)">
          <span data-i18n-ignore>{{ label(item.value, item.label) }}</span>
          <svg viewBox="0 0 16 16" aria-hidden="true" :class="{'is-visible': modelValue.includes(item.value)}"><path d="m3 8 3 3 7-7" /></svg>
        </button>
      </div>
      <div class="excluded-language-actions">
        <button type="button" :aria-expanded="expanded" @click="expanded = !expanded">{{ t(expanded ? 'settings.excludedLanguages.less' : 'settings.excludedLanguages.more') }}</button>
        <button v-if="modelValue.length" type="button" @click="emit('update:modelValue', [])">{{ t('settings.excludedLanguages.clear') }}</button>
      </div>
    </div>
  </SettingsGroup>
</template>

<script setup lang="ts">
import {computed, ref} from 'vue';
import {options, getMultilingualTargetLanguageLabel} from '@/src/core/config/catalog';
import {normalizeExcludedLanguages} from '@/src/core/config/pageTranslation';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsGroup from './components/SettingsGroup.vue';

const props = defineProps<{modelValue: string[]}>();
const emit = defineEmits<{'update:modelValue': [value: string[]]}>();
const {t, language} = useUiI18n();
const expanded = ref(false);
const visibleOptions = computed(() => options.to.filter((item, index) => expanded.value || index < 8 || props.modelValue.includes(item.value)));
function label(value: string, fallback: string): string {
  const parts = getMultilingualTargetLanguageLabel(value, fallback, language.value).split(' / ');
  // 目录的中文条目以中文开头；其他条目为原生名 / 英文名 / 中文名。
  // 外语界面目录始终把当前界面语言放在第一项。
  return language.value === 'zh-CN' && !value.startsWith('zh-')
    ? parts[parts.length - 1]!
    : parts[0]!;
}
function toggle(value: string): void {
  emit('update:modelValue', normalizeExcludedLanguages(props.modelValue.includes(value)
    ? props.modelValue.filter(item => item !== value) : [...props.modelValue, value]));
}
</script>

<style scoped>
.excluded-language-body { padding: 16px 20px 18px; }
.excluded-language-options { display: flex; flex-wrap: wrap; gap: 10px; }
.excluded-language-option { display: inline-flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 44px; max-width: 100%; padding: 10px 16px; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-fill-color-light); color: var(--el-text-color-primary); font: inherit; font-weight: 500; text-align: start; cursor: pointer; }
.excluded-language-option.is-selected { border-color: var(--el-color-primary); color: var(--el-color-primary); background: color-mix(in srgb, var(--el-color-primary) 9%, var(--surface)); }
.excluded-language-option:hover { border-color: var(--el-color-primary); }
.excluded-language-option:focus-visible, .excluded-language-actions button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.excluded-language-option svg { width: 16px; height: 16px; flex: 0 0 16px; visibility: hidden; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.excluded-language-option svg.is-visible { visibility: visible; }
.excluded-language-actions { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 14px; }
.excluded-language-actions button { padding: 2px 0; border: 0; background: none; color: var(--el-color-primary); font: inherit; cursor: pointer; }
.excluded-language-hint { margin: 12px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
@media (max-width: 480px) { .excluded-language-options { gap: 8px; } .excluded-language-option { gap: 10px; padding: 9px 12px; } }
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElOption } from 'element-plus'
import UiSelect from '@/src/ui/components/UiSelect.vue'
import { useUiI18n } from '../preview-i18n'

const props = withDefaults(defineProps<{ filterable?: boolean; multiple?: boolean; disabled?: boolean; longLabels?: boolean }>(), { filterable: true })
const { language } = useUiI18n()
const value = ref<string | string[]>('zh-CN')
watch(() => props.multiple, (multiple) => { value.value = multiple ? ['zh-CN', 'en-US'] : 'zh-CN' }, { immediate: true })
const options = computed(() => language.value === 'en-US'
  ? [{ value: 'zh-CN', label: 'Simplified Chinese' }, { value: 'en-US', label: 'English' }, { value: 'ja-JP', label: 'Japanese' }]
  : [{ value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: '英语' }, { value: 'ja-JP', label: '日语' }])
</script>
<template>
  <div class="fr-story-stack" style="max-width: 420px">
    <label class="fr-story-field">
      <span>{{ language === 'en-US' ? 'Target language' : '目标语言' }}</span>
      <UiSelect v-model="value" :filterable="filterable" :multiple="multiple" :disabled="disabled" :aria-label="language === 'en-US' ? 'Target language' : '目标语言'" placeholder="选择语言">
        <ElOption v-for="option in options" :key="option.value" :value="option.value" :label="longLabels ? `${option.label} · ${language === 'en-US' ? 'A longer label that wraps on narrow screens' : '用于验证窄屏自然换行的较长选项名称'}` : option.label" />
      </UiSelect>
    </label>
    <small class="fr-story-value">{{ language === 'en-US' ? 'Selected' : '当前选择' }}：{{ value }}</small>
  </div>
</template>

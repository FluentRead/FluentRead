<!--
 * @file src/features/writing-assistant/ui/WritingLanguagePicker.vue
 * 文件职责：让写作语言默认跟随目标语言，同时允许本次回复选择另一种语言，不使用宿主系统的原生下拉菜单。
 * 主要内容：在固定卡片中展示当前选择、可检索的语言目录和跟随目标语言选项，点击后仅发出一次语言选择事件。
 * 模块边界：组件不保存配置、不调用翻译或写作服务，不改变网页滚动；语言解析及应用请求由父层负责。
 -->
<template>
  <div class="writing-language-picker">
    <div class="writing-subheading"><h3>输出语言</h3><button type="button" class="writing-text-button" @click="emit('cancel')">返回草稿</button></div>
    <input v-model="search" type="search" aria-label="搜索输出语言" placeholder="搜索语言" />
    <div class="writing-language-options" role="listbox" aria-label="输出语言">
      <button v-for="item in filtered" :key="item.value" type="button" :disabled="disabled" role="option" :aria-selected="modelValue === item.value" @click="emit('select', item.value)"><span>{{ item.label }}<small v-if="item.value === 'target'">{{ targetLabel }}</small></span><Check v-if="modelValue === item.value" /></button>
      <p v-if="!filtered.length">没有匹配的语言</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import {computed, ref} from 'vue';
import {Check} from '@element-plus/icons-vue';
import {WRITING_LANGUAGES} from '@/src/core/config/writing';
const props = defineProps<{modelValue: string; targetLabel: string; disabled?: boolean}>();
const emit = defineEmits<{select: [value: string]; cancel: []}>();
const search = ref('');
const filtered = computed(() => WRITING_LANGUAGES.filter(item => `${item.label} ${item.value} ${item.value === 'target' ? props.targetLabel : ''}`.toLowerCase().includes(search.value.trim().toLowerCase())));
</script>
<style scoped>
.writing-language-picker{display:flex;flex-direction:column;flex:1;min-height:0;padding:4px 20px 14px}.writing-subheading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}.writing-subheading h3{font-size:15px;font-weight:650;margin:0}.writing-language-picker input{font:inherit;font-size:13px;color:var(--w-ink);background:var(--w-soft);border:1px solid var(--w-line);border-radius:10px;padding:9px 12px;margin-bottom:10px;outline-offset:2px}.writing-language-options{min-height:0;overflow:auto;overscroll-behavior:contain;display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:2px}.writing-language-options button{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:9px 11px;text-align:left;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--w-ink);font:inherit;font-size:12px;cursor:pointer}.writing-language-options button:hover{background:var(--w-soft)}.writing-language-options button[aria-selected=true]{color:var(--w-brand);border-color:var(--w-brand);background:var(--w-brand-soft)}.writing-language-options button svg{width:15px;height:15px;flex-shrink:0}.writing-language-options small{display:block;font-size:10px;color:var(--w-muted);margin-top:3px}.writing-language-options p{color:var(--w-muted);font-size:12px}.writing-language-options button:focus-visible,.writing-language-picker input:focus-visible{outline:2px solid var(--w-brand)}@media(max-width:540px){.writing-language-picker{padding-inline:14px}.writing-language-options{grid-template-columns:1fr}}
</style>

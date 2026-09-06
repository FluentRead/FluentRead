<!--
 * @file src/features/writing-assistant/ui/WritingStyleEditor.vue
 * 文件职责：集中呈现回答风格，把长度、表达风格、语气和回复身份组织成一次可确认的调整。
 * 主要内容：编辑独立的临时偏好，提供预设及自定义语气和角色，只有确认后才交给父组件保存和改写；取消保持已有草稿。
 * 模块边界：不读取网页或配置仓库，不直接请求模型，不创建新的浮窗；在既有卡片内部保持稳定的滚动区域与底部操作。
 -->
<template>
  <div class="writing-style-editor">
    <div class="writing-subheading"><h3>回答风格</h3><button type="button" class="writing-text-button" :disabled="saving" @click="emit('cancel')">返回草稿</button></div>
    <div class="writing-style-fields">
      <section><h4>长度</h4><WritingChoices v-model="selection.length" :options="WRITING_LENGTHS" label="长度" :disabled="saving" /></section>
      <section><h4>风格</h4><WritingChoices v-model="selection.style" :options="WRITING_STYLES" label="风格" :disabled="saving" /></section>
      <section><h4>语气</h4><WritingChoices v-model="toneChoice" :options="toneOptions" label="语气" :disabled="saving" /><input v-if="toneChoice === 'custom'" v-model="customTone" :maxlength="WRITING_TONE_MAX_LENGTH" :disabled="saving" aria-label="自定义语气" placeholder="例如：耐心、鼓励，避免夸张" /></section>
      <section><h4>您的角色</h4><WritingChoices v-model="roleChoice" :options="roleOptions" label="您的角色" :disabled="saving" /><input v-if="roleChoice === 'custom'" v-model="customRole" :maxlength="WRITING_ROLE_MAX_LENGTH" :disabled="saving" aria-label="自定义角色" placeholder="例如：正在排查问题的项目维护者" /></section>
    </div>
    <footer><button type="button" class="writing-button" :disabled="saving" @click="emit('cancel')">取消</button><button type="button" class="writing-button primary" :disabled="saving || !valid" @click="confirm">{{ saving ? '正在保存…' : actionLabel }}</button></footer>
  </div>
</template>
<script setup lang="ts">
import {computed, reactive, ref} from 'vue';
import {WRITING_LENGTHS, WRITING_STYLES, WRITING_TONES, WRITING_ROLES, WRITING_TONE_MAX_LENGTH, WRITING_ROLE_MAX_LENGTH, type WritingPreferences} from '@/src/core/config/writing';
import WritingChoices from './WritingChoices.vue';
type StylePreferences = Pick<WritingPreferences, 'length' | 'style' | 'tone' | 'role'>;
const props = defineProps<{modelValue: StylePreferences; actionLabel: string; saving?: boolean}>();
const emit = defineEmits<{apply: [value: StylePreferences]; cancel: []}>();
const selection = reactive({...props.modelValue});
const toneOptions = [...WRITING_TONES, {value: 'custom', label: '自定义'}];
const roleOptions = [...WRITING_ROLES, {value: 'custom', label: '自定义'}];
const toneChoice = ref(WRITING_TONES.some(item => item.value === selection.tone) ? selection.tone : 'custom');
const roleChoice = ref(WRITING_ROLES.some(item => item.value === selection.role) ? selection.role : 'custom');
const customTone = ref(toneChoice.value === 'custom' ? selection.tone : '');
const customRole = ref(roleChoice.value === 'custom' ? selection.role : '');
const valid = computed(() => (toneChoice.value !== 'custom' || Boolean(customTone.value.trim())) && (roleChoice.value !== 'custom' || Boolean(customRole.value.trim())));
function confirm() { emit('apply', {...selection, tone: toneChoice.value === 'custom' ? customTone.value.trim() : toneChoice.value, role: roleChoice.value === 'custom' ? customRole.value.trim() : roleChoice.value}); }
</script>
<style scoped>
.writing-style-editor{display:flex;flex-direction:column;flex:1;min-height:0;padding:4px 20px 0}.writing-subheading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}.writing-subheading h3{font-size:15px;font-weight:650;margin:0}.writing-style-fields{min-height:0;overflow:auto;overscroll-behavior:contain;padding:1px 2px 4px}.writing-style-fields section+section{margin-top:9px}.writing-style-fields h4{font-size:12px;font-weight:500;color:var(--w-muted);margin:0 0 5px}.writing-style-fields input{display:block;width:100%;box-sizing:border-box;margin-top:8px;border:1px solid var(--w-line);background:var(--w-soft);color:var(--w-ink);border-radius:9px;padding:9px 11px;font:inherit;font-size:12px}.writing-style-fields input:focus-visible{outline:2px solid var(--w-brand);outline-offset:1px}.writing-style-fields p{color:var(--w-muted);font-size:11px;margin:7px 0 0}footer{display:flex;justify-content:flex-end;gap:9px;flex-shrink:0;border-top:1px solid var(--w-line);padding:10px 0;margin-top:9px}@media(max-width:540px){.writing-style-editor{padding-inline:14px}}
</style>

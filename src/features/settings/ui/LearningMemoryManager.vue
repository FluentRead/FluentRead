<!--
 * @file src/features/settings/ui/LearningMemoryManager.vue
 * 文件职责：让用户查看和维护主动保存的本机学习笔记，区分保存笔记与允许 AI 参考的开关。
 * 主要内容：提供本地搜索、类型选择、单条添加编辑、删除和清空；长笔记使用原生折叠容器原位阅读全文，阅读无需进入编辑；按 200 条与每条 2000 字限制提示容量，并隔离迟到读取；日期格式器在本组件每轮同步模板渲染内复用，下轮重新读取系统默认语言与时区。
 * 模块边界：只通过 reading-assistant 无 UI 的公共客户端管理记忆，不加载阅读卡、不检索模型、不直接访问数据库、不自动收集网页或学习信息。
 -->
<template>
  <section class="fr-learning-memory" :aria-label="t('learning.memory')">
    <header class="fr-memory-heading">
      <div><h2>{{ t('learning.memory') }}</h2><p>{{ t('learning.memoryDescription') }}</p></div>
      <button v-if="!editor" type="button" class="fr-memory-button fr-memory-primary" :disabled="loading || mutating || memories.length >= 200" @click="createMemory">{{ t('learning.memoryAdd') }}</button>
    </header>
    <details class="fr-memory-options" @keydown.esc.stop.prevent="($event.currentTarget as HTMLDetailsElement).open = false">
      <summary>{{ t('learning.memorySettings') }}</summary>
      <p>{{ enabled ? t('learning.memoryEnabled') : t('learning.memoryDisabled') }}</p>
      <p>{{ t('learning.memoryRetention') }}</p>
      <button type="button" class="fr-memory-link" @click="emit('navigate', 'settings-selection')">{{ t('learning.memorySettingsOpen') }}</button>
    </details>
    <p v-if="error" class="fr-memory-feedback is-error" role="alert">{{ error }} <button v-if="!mutating && !editor" type="button" class="fr-memory-link" @click="loadMemories">{{ translateLegacy('重试') }}</button></p>
    <p v-if="feedback" class="fr-memory-feedback" role="status">{{ feedback }}</p>

    <form v-if="editor" class="fr-memory-editor" @submit.prevent="saveMemory">
      <h3>{{ editor.id ? t('learning.memoryEdit') : t('learning.memoryAdd') }}</h3>
      <label class="fr-memory-field"><span>{{ t('learning.memoryKind') }}</span>
        <UiSelect v-model="editor.kind" :disabled="mutating" :aria-label="t('learning.memoryKind')"><ElOption v-for="kind in kinds" :key="kind.value" :value="kind.value" :label="translateControlLabel(kind.label)" /></UiSelect>
      </label>
      <label class="fr-memory-field"><span>{{ t('learning.memoryContent') }}</span>
        <textarea v-model="editor.content" rows="7" maxlength="2000" required :disabled="mutating" :aria-label="t('learning.memoryContent')" :placeholder="t('learning.memoryPlaceholder')" data-i18n-ignore />
      </label>
      <small class="fr-memory-counter">{{ t('learning.memoryCharacters', {count: editor.content.length}) }}</small>
      <div class="fr-memory-editor-actions"><button type="submit" class="fr-memory-button fr-memory-primary" :disabled="mutating || !editor.content.trim()">{{ translateLegacy(mutating ? '正在保存…' : '保存') }}</button><button type="button" class="fr-memory-button" :disabled="mutating" @click="editor = null">{{ translateLegacy('取消') }}</button></div>
    </form>
    <template v-else>
      <div v-if="memories.length" class="fr-memory-toolbar">
        <input v-model="query" type="search" :aria-label="t('learning.memorySearch')" :placeholder="t('learning.memorySearch')" />
        <span>{{ t('learning.memoryCount', {count: memories.length}) }}</span>
        <button type="button" class="fr-memory-link" :disabled="loading || mutating" @click="loadMemories">{{ translateLegacy('刷新') }}</button>
      </div>
      <p v-if="loading" class="fr-memory-feedback" role="status">{{ t('learning.memoryLoading') }}</p>
      <div v-else-if="!memories.length && !error" class="fr-memory-empty"><strong>{{ t('learning.memoryEmpty') }}</strong><p>{{ t('learning.memoryEmptyHint') }}</p></div>
      <p v-else-if="memories.length && !filteredMemories.length" class="fr-memory-feedback">{{ t('learning.memoryNoMatches') }}</p>
      <div class="fr-memory-list">
        <article v-for="memory in filteredMemories" :key="memory.id" class="fr-memory-item">
          <header><span>{{ kindLabel(memory.kind) }}</span><small>{{ formatDate(memory.updatedAt) }}</small></header>
          <details v-if="memory.content.length > 180 || memory.content.split('\n').length > 3" class="fr-memory-content" @keydown.esc.stop.prevent="($event.currentTarget as HTMLDetailsElement).open = false">
            <summary><span class="fr-memory-preview" data-i18n-ignore>{{ memory.content }}</span><span class="fr-memory-expand">{{ translateLegacy('展开') }}</span><span class="fr-memory-collapse">{{ translateLegacy('收起') }}</span></summary>
            <p data-i18n-ignore>{{ memory.content }}</p>
          </details>
          <p v-else data-i18n-ignore>{{ memory.content }}</p>
          <footer><button type="button" class="fr-memory-link" :disabled="mutating" @click="editMemory(memory)">{{ translateLegacy('编辑') }}</button><button type="button" class="fr-memory-link" :disabled="mutating" @click="removeMemory(memory.id)">{{ translateLegacy('删除') }}</button></footer>
        </article>
      </div>
      <div v-if="memories.length" class="fr-memory-bottom"><small v-if="memories.length >= 200">{{ t('learning.memoryLimit') }}</small><span v-else /><button type="button" class="fr-memory-link" :disabled="mutating || confirmingClear" @click="clearMemories">{{ t('learning.memoryClear') }}</button></div>
    </template>
    <el-dialog :key="clearRevision" :model-value="confirmingClear" :onUpdate:modelValue="clearActions.open" :title="t('common.confirm')" width="min(460px, calc(100vw - 32px))" destroy-on-close>
      <p>{{ t('learning.memoryClearConfirm') }}</p>
      <template #footer><el-button :onClick="clearActions.cancel">{{ t('common.cancel') }}</el-button><el-button type="danger" :onClick="clearActions.confirm">{{ t('common.confirm') }}</el-button></template>
    </el-dialog>
  </section>
</template>
<script setup lang="ts">
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {ElOption} from 'element-plus';
import {useUiI18n as useControlI18n} from '@/src/ui/i18n';
const {translateLegacy: translateControlLabel} = useControlI18n();

import {computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch} from 'vue'
import {clearLearningMemories, deleteLearningMemory, listLearningMemories, saveLearningMemory, type LearningMemory} from '@/src/features/reading-assistant/public'
import {useUiI18n} from '@/src/ui/i18n'
import {useRenderDateFormatter} from '@/src/ui/dateFormat'

const props = defineProps<{enabled: boolean; isVisible?: () => boolean}>()
const emit = defineEmits<{navigate: [section: string]}>()
const {t, translateLegacy} = useUiI18n()
const memories = ref<LearningMemory[]>([])
const query = ref('')
const loading = ref(false)
const mutating = ref(false)
const error = ref('')
const feedback = ref('')
const editor = ref<{id?: string; content: string; kind: LearningMemory['kind']} | null>(null)
const kinds = computed(() => [
  {value: 'preference', label: t('learning.memoryPreference')},
  {value: 'lesson', label: t('learning.memoryLesson')},
  {value: 'note', label: t('learning.memoryNote')},
])
const filteredMemories = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  return memories.value.filter(memory => !term || memory.content.toLocaleLowerCase().includes(term) || kindLabel(memory.kind).toLocaleLowerCase().includes(term))
})
const kindLabel = (kind: LearningMemory['kind']) => kinds.value.find(item => item.value === kind)?.label || t('learning.memoryNote')
const formatDate = useRenderDateFormatter({month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'})
let generation = 0
let active = true
const confirmingClear = ref(false)
const clearRevision = ref(0)
function invalidateClearConfirmation() { clearRevision.value += 1; confirmingClear.value = false }
watch(() => props.isVisible?.() ?? true, visible => {if (!visible) invalidateClearConfirmation()}, {flush: 'sync'})
onDeactivated(invalidateClearConfirmation)
const errorText = (failure: unknown) => failure instanceof Error ? failure.message : t('learning.memoryError')
function sortMemories(items: LearningMemory[]) { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)) }
async function loadMemories() {
  if (mutating.value) return
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const items = await listLearningMemories()
    if (active && request === generation) memories.value = sortMemories(items)
  } catch (failure) {
    if (active && request === generation) error.value = errorText(failure)
  } finally {
    if (active && request === generation) loading.value = false
  }
}
function createMemory() {
  editor.value = {content: '', kind: 'note'}
  error.value = ''
  feedback.value = ''
}
function editMemory(memory: LearningMemory) {
  editor.value = {id: memory.id, content: memory.content, kind: memory.kind}
  error.value = ''
  feedback.value = ''
}
async function saveMemory() {
  if (!editor.value || mutating.value || !editor.value.content.trim()) return
  const input = {...editor.value, content: editor.value.content.trim()}
  generation += 1
  loading.value = false
  mutating.value = true
  error.value = ''
  try {
    const saved = await saveLearningMemory(input)
    if (!active) return
    memories.value = sortMemories([...memories.value.filter(memory => memory.id !== saved.id), saved])
    editor.value = null
    query.value = ''
    feedback.value = t('learning.memorySaved')
  } catch (failure) {
    if (active) error.value = errorText(failure)
  } finally {
    if (active) mutating.value = false
  }
}
async function removeMemory(id: string) {
  if (mutating.value) return
  generation += 1
  loading.value = false
  mutating.value = true
  error.value = ''
  try {
    await deleteLearningMemory(id)
    if (!active) return
    memories.value = memories.value.filter(memory => memory.id !== id)
    feedback.value = t('learning.memoryDeleted')
  } catch (failure) {
    if (active) error.value = errorText(failure)
  } finally {
    if (active) mutating.value = false
  }
}
function clearMemories() {
  if (!active || mutating.value || confirmingClear.value || props.isVisible?.() === false) return
  clearRevision.value += 1
  confirmingClear.value = true
}
const clearActions = computed(() => {
  const revision = clearRevision.value
  const isCurrent = () => active && confirmingClear.value && revision === clearRevision.value && props.isVisible?.() !== false
  return {
    open: (value: boolean) => {if (!value && isCurrent()) invalidateClearConfirmation()},
    cancel: () => {if (isCurrent()) invalidateClearConfirmation()},
    confirm: () => {if (isCurrent()) void commitClear()},
  }
})
async function commitClear() {
  confirmingClear.value = false
  if (mutating.value) return
  generation += 1
  loading.value = false
  mutating.value = true
  error.value = ''
  try {
    await clearLearningMemories()
    if (!active) return
    memories.value = []
    feedback.value = t('learning.memoryCleared')
  } catch (failure) {
    if (active) error.value = errorText(failure)
  } finally {
    if (active) mutating.value = false
  }
}
onMounted(() => { void loadMemories() })
onBeforeUnmount(() => { active = false; invalidateClearConfirmation(); generation += 1 })
</script>
<style scoped>
.fr-learning-memory { color:var(--ink); }
.fr-memory-heading { display:flex; align-items:center; justify-content:space-between; gap:14px; }
.fr-memory-heading h2 { margin:0 0 6px; font-size:14px; line-height:1.5; }
.fr-memory-heading p, .fr-memory-retention { margin:0; color:var(--muted); font-size:11px; line-height:1.7; }
.fr-learning-memory button { font:inherit; font-size:12px; cursor:pointer; }
.fr-learning-memory button:disabled { opacity:.5; cursor:default; }
.fr-learning-memory button:focus-visible, .fr-learning-memory input:focus-visible, .fr-learning-memory select:focus-visible, .fr-learning-memory textarea:focus-visible { outline:2px solid var(--brand-strong); outline-offset:2px; }
.fr-memory-button { flex-shrink:0; border:1px solid var(--line); border-radius:8px; padding:8px 12px; color:var(--ink); background:var(--surface); }
.fr-memory-primary { color:var(--brand-strong); border-color:color-mix(in srgb,var(--brand-strong) 35%,var(--line)); background:color-mix(in srgb,var(--brand-strong) 7%,var(--surface)); }
.fr-memory-link { border:0; padding:3px 0; background:transparent; color:var(--muted); }
.fr-memory-link:hover { color:var(--brand-strong); }
.fr-memory-heading .fr-memory-link { margin-left:5px; color:var(--brand-strong); font-size:11px; }
.fr-memory-toolbar { display:flex; align-items:center; gap:12px; margin:16px 0 12px; }
.fr-memory-toolbar input { width:100%; min-width:0; flex:1; border:1px solid var(--line); border-radius:8px; padding:9px 11px; color:var(--ink); background:var(--surface); font:inherit; font-size:12px; }
.fr-memory-toolbar > span { flex-shrink:0; color:var(--muted); font-size:11px; }
.fr-memory-list { display:grid; gap:10px; }
.fr-memory-item { min-width:0; padding:14px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
.fr-memory-item header { display:flex; gap:12px; align-items:center; justify-content:space-between; color:var(--muted); font-size:11px; }
.fr-memory-item header small { flex-shrink:0; font-size:10px; }
.fr-memory-item > p,.fr-memory-content p,.fr-memory-preview { margin:10px 0; font-size:13px; line-height:1.75; white-space:pre-wrap; overflow-wrap:anywhere; }
.fr-memory-content > summary { display:block; margin:0; padding:0; border:0; border-radius:0; background:transparent; color:var(--ink); font:inherit; font-weight:400; list-style:none; cursor:pointer; }
.fr-memory-content > summary::-webkit-details-marker { display:none; }
.fr-memory-content > summary::after { display:none; content:none; }
.fr-memory-content > summary:focus-visible { outline:2px solid var(--brand); outline-offset:3px; }
.fr-memory-preview { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.fr-memory-expand,.fr-memory-collapse { color:var(--brand-strong); font-size:12px; line-height:1.8; }
.fr-memory-collapse,.fr-memory-content[open] .fr-memory-preview,.fr-memory-content[open] .fr-memory-expand { display:none; }
.fr-memory-content[open] .fr-memory-collapse { display:inline; }
.fr-memory-item footer { display:flex; justify-content:space-between; gap:12px; }
.fr-memory-editor { margin-top:16px; padding:18px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
.fr-memory-editor h3 { margin:0 0 16px; font-size:14px; }
.fr-memory-field { display:flex; flex-direction:column; gap:7px; margin-bottom:14px; }
.fr-memory-field > span { color:var(--muted); font-size:12px; }
.fr-memory-field select, .fr-memory-field textarea { width:100%; box-sizing:border-box; padding:10px; border:1px solid var(--line); border-radius:8px; color:var(--ink); background:var(--surface-soft); font:inherit; font-size:13px; line-height:1.7; }
.fr-memory-field select { max-width:260px; }
.fr-memory-field textarea { resize:vertical; min-height:140px; max-height:420px; }
.fr-memory-counter { display:block; margin-top:-6px; text-align:right; color:var(--muted); font-size:10px; }
.fr-memory-editor-actions { display:flex; align-items:center; gap:8px; margin-top:16px; }
.fr-memory-empty { padding:40px 14px; margin-top:16px; border:1px solid var(--line); border-radius:12px; text-align:center; background:var(--surface); }
.fr-memory-empty strong { font-size:13px; }
.fr-memory-empty p { margin:8px auto 0; max-width:420px; color:var(--muted); font-size:12px; line-height:1.7; }
.fr-memory-feedback { margin:14px 0; color:var(--muted); font-size:12px; line-height:1.6; }
.fr-memory-feedback.is-error { color:var(--fr-danger); }
.fr-memory-bottom { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:14px; }
.fr-memory-bottom small { color:var(--muted); font-size:11px; }
.fr-learning-memory > details.fr-memory-options[class] > summary { width:fit-content; min-height:0; margin:8px 0 0; padding:0; border:0; border-radius:0; color:var(--muted); background:transparent; font:inherit; font-size:11px; font-weight:400; cursor:pointer; }
.fr-learning-memory > details.fr-memory-options[class] > summary::after { display:none; content:none; }
.fr-memory-options p { margin:8px 0; color:var(--muted); font-size:11px; line-height:1.7; }
@media (max-width:480px) {
  .fr-memory-heading { align-items:flex-start; }
  .fr-memory-heading > div { min-width:0; }
  .fr-memory-heading .fr-memory-button { padding:7px 9px; }
  .fr-memory-toolbar { flex-wrap:wrap; }
  .fr-memory-toolbar input { flex-basis:100%; }
  .fr-memory-editor { padding:14px; }
}
</style>

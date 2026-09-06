<!--
 * @file src/features/settings/ui/LearningMemoryManager.vue
 * 文件职责：让用户查看和维护主动保存的本机学习记忆，明确其使用开关与长期保留边界。
 * 主要内容：提供本地搜索、类型选择、单条添加编辑、删除和清空；按 200 条与每条 2000 字限制提示容量，并隔离迟到读取。
 * 模块边界：只通过 reading-assistant 公共客户端管理记忆，不检索模型、不直接访问数据库、不自动收集网页或学习信息。
 -->
<template>
  <section class="fr-learning-memory" :aria-label="t('learning.memory')">
    <header class="fr-memory-heading">
      <div><h2>{{ t('learning.memory') }}</h2><p>{{ enabled ? t('learning.memoryEnabled') : t('learning.memoryDisabled') }} <button type="button" class="fr-memory-link" @click="emit('navigate', 'settings-harness')">{{ t('learning.memorySettings') }}</button></p></div>
      <button v-if="!editor" type="button" class="fr-memory-button fr-memory-primary" :disabled="loading || mutating || memories.length >= 200" @click="createMemory">{{ t('learning.memoryAdd') }}</button>
    </header>
    <p class="fr-memory-retention">{{ t('learning.memoryRetention') }}</p>
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
          <p data-i18n-ignore>{{ memory.content }}</p>
          <footer><button type="button" class="fr-memory-link" :disabled="mutating" @click="editMemory(memory)">{{ t('learning.memoryViewEdit') }}</button><button type="button" class="fr-memory-link" :disabled="mutating" @click="removeMemory(memory.id)">{{ translateLegacy('删除') }}</button></footer>
        </article>
      </div>
      <div v-if="memories.length" class="fr-memory-bottom"><small v-if="memories.length >= 200">{{ t('learning.memoryLimit') }}</small><span v-else /><button type="button" class="fr-memory-link" :disabled="mutating" @click="clearMemories">{{ t('learning.memoryClear') }}</button></div>
    </template>
  </section>
</template>
<script setup lang="ts">
import {ElMessageBox} from 'element-plus';
import 'element-plus/es/components/message-box/style/css';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {ElOption} from 'element-plus';
import {useUiI18n as useControlI18n} from '@/src/ui/i18n';
const {translateLegacy: translateControlLabel} = useControlI18n();

import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {clearLearningMemories, deleteLearningMemory, listLearningMemories, saveLearningMemory, type LearningMemory} from '@/src/features/reading-assistant/public'
import {useUiI18n} from '@/src/ui/i18n'

defineProps<{enabled: boolean}>()
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
const formatDate = (value: number) => new Intl.DateTimeFormat(undefined, {month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'}).format(value)
let generation = 0
let active = true
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
  editor.value = {content: '', kind: 'preference'}
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
async function clearMemories() {
  if (mutating.value) return
  try { await ElMessageBox.confirm(t('learning.memoryClearConfirm'), t('common.confirm'), {type: 'warning', confirmButtonText: t('common.confirm'), cancelButtonText: t('common.cancel')}) }
  catch { return }
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
onBeforeUnmount(() => { active = false; generation += 1 })
</script>
<style scoped>
.fr-learning-memory { color:var(--ink); }
.fr-memory-heading { display:flex; align-items:center; justify-content:space-between; gap:14px; }
.fr-memory-heading h2 { margin:0 0 6px; font-size:14px; line-height:1.5; }
.fr-memory-heading p, .fr-memory-retention { margin:0; color:var(--muted); font-size:11px; line-height:1.7; }
.fr-memory-retention { margin-top:8px; }
.fr-learning-memory button { font:inherit; font-size:12px; cursor:pointer; }
.fr-learning-memory button:disabled { opacity:.5; cursor:default; }
.fr-learning-memory button:focus-visible, .fr-learning-memory input:focus-visible, .fr-learning-memory select:focus-visible, .fr-learning-memory textarea:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.fr-memory-button { flex-shrink:0; border:1px solid var(--line); border-radius:8px; padding:8px 12px; color:var(--ink); background:var(--surface); }
.fr-memory-primary { color:var(--accent); border-color:color-mix(in srgb,var(--accent) 35%,var(--line)); background:color-mix(in srgb,var(--accent) 7%,var(--surface)); }
.fr-memory-link { border:0; padding:3px 0; background:transparent; color:var(--muted); }
.fr-memory-link:hover { color:var(--accent); }
.fr-memory-heading .fr-memory-link { margin-left:5px; color:var(--accent); font-size:11px; }
.fr-memory-toolbar { display:flex; align-items:center; gap:12px; margin:16px 0 12px; }
.fr-memory-toolbar input { width:100%; min-width:0; flex:1; border:1px solid var(--line); border-radius:8px; padding:9px 11px; color:var(--ink); background:var(--surface); font:inherit; font-size:12px; }
.fr-memory-toolbar > span { flex-shrink:0; color:var(--muted); font-size:11px; }
.fr-memory-list { display:grid; gap:10px; }
.fr-memory-item { min-width:0; padding:14px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
.fr-memory-item header { display:flex; gap:12px; align-items:center; justify-content:space-between; color:var(--muted); font-size:11px; }
.fr-memory-item header small { flex-shrink:0; font-size:10px; }
.fr-memory-item > p { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; margin:10px 0; font-size:13px; line-height:1.75; white-space:pre-wrap; overflow-wrap:anywhere; }
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
.fr-memory-feedback.is-error { color:var(--warning,#b26a00); }
.fr-memory-bottom { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:14px; }
.fr-memory-bottom small { color:var(--muted); font-size:11px; }
@media (max-width:480px) {
  .fr-memory-heading { align-items:flex-start; }
  .fr-memory-heading > div { min-width:0; }
  .fr-memory-heading .fr-memory-button { padding:7px 9px; }
  .fr-memory-toolbar { flex-wrap:wrap; }
  .fr-memory-toolbar input { flex-basis:100%; }
  .fr-memory-editor { padding:14px; }
}
</style>

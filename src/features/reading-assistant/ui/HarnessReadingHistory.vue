<!--
 * @file src/features/reading-assistant/ui/HarnessReadingHistory.vue
 * 文件职责：在学习中心集中展示本机保存的 30 天阅读记录，并按原文查看完整问答。
 * 主要内容：提供分页记录列表、独立 Markdown 详情、刷新、删除和清空操作，以异步代次避免迟到读取覆盖当前界面。
 * 模块边界：只调用 reading-assistant 的记录客户端，不发起模型请求、不访问数据库实现，也不拥有设置或收藏功能。
 -->
<template>
  <section class="harness-history" aria-label="阅读记录">
    <div class="harness-history-heading">
      <div><h2>阅读记录</h2><p>找回读过的句子和回答。本机保存 30 天，查看不调用模型。</p></div>
      <button type="button" class="harness-secondary-button" :disabled="historyLoading || historyMutating" @click="reloadHistory">
        刷新记录
      </button>
    </div>
    <div class="harness-history-body">
      <p v-if="historyError" class="harness-history-feedback" role="alert">{{ historyError }}<button v-if="!historyLoading && !selectedHistory" type="button" @click="reloadHistory">重试</button></p>
      <template v-if="selectedHistory">
        <div class="harness-history-toolbar">
          <button type="button" class="harness-secondary-button" @click="backToHistoryList">返回记录列表</button>
          <button type="button" class="harness-text-button" :disabled="historyMutating" @click="removeHistory(selectedHistory.id)">删除此条</button>
        </div>
        <article class="harness-history-detail">
          <header class="harness-history-source">
            <small>当时选中的原文</small>
            <blockquote data-i18n-ignore>{{ selectedHistory.text }}</blockquote>
            <p>{{ formatDate(selectedHistory.updatedAt) }} · {{ selectedHistory.turns.length }} 次问答</p>
          </header>
          <section v-for="(turn, index) in selectedHistory.turns" :key="turn.id" class="harness-history-turn">
            <header><h3 data-i18n-ignore>{{ turn.question || translateLegacy(actionLabelFor(turn.intent)) }}</h3><small>{{ actionLabelFor(turn.intent) }} · {{ formatDate(turn.createdAt) }}<template v-if="turn.status !== 'completed'"> · {{ statusLabel(turn.status) }}</template></small></header>
            <ReadingAnswer v-if="turn.answer" data-i18n-ignore :text="turn.answer" :compact="false" />
            <p v-else class="harness-history-empty-answer">{{ turn.status === 'streaming' ? '回答仍在生成中，稍后重新打开这条记录查看。' : '这次提问没有保存回答。' }}</p>
            <span class="harness-visually-hidden">{{ t("reading.turnEnd", {number: index + 1}) }}</span>
          </section>
        </article>
        <p class="harness-history-footnote">想继续提问？回到网页，在阅读卡的“阅读记录”中打开这条记录。</p>
      </template>
      <template v-else>
        <p v-if="historyLoading && !historySessions.length" class="harness-history-feedback" role="status">正在读取记录…</p>
        <div v-else-if="!historySessions.length && !historyError" class="harness-history-empty">
          <strong>还没有阅读记录</strong>
          <p>在网页选中一句话，点“读懂”或“拆句”。回答会自动保存在这里，方便以后回看。</p>
        </div>
        <div v-if="historySessions.length" class="harness-history-list" aria-label="阅读记录列表">
          <div v-for="item in historySessions" :key="item.id" class="harness-history-row">
            <button type="button" class="harness-history-open" :disabled="historyMutating" @click="openHistory(item.id)">
              <span data-i18n-ignore>{{ item.text }}</span><small>{{ actionLabelFor(item.intent) }} · {{ formatDate(item.updatedAt) }} · {{ item.turnCount }} 次问答</small>
            </button>
            <button type="button" class="harness-text-button" :disabled="historyMutating" aria-label="删除这条阅读记录" @click="removeHistory(item.id)">删除</button>
          </div>
        </div>
        <p v-if="historyDetailLoading" class="harness-history-feedback" role="status">正在打开记录…</p>
        <div v-if="historySessions.length" class="harness-history-toolbar">
          <button v-if="historyHasMore" type="button" class="harness-secondary-button" :disabled="historyLoading || historyMutating" @click="loadMoreHistory">{{ historyLoading ? '正在读取…' : '加载更多' }}</button>
          <span v-else class="harness-history-count">{{ historySessions.length }} 条记录</span>
          <button type="button" class="harness-text-button" :disabled="historyMutating" @click="clearHistory">清空记录</button>
        </div>
      </template>
    </div>
  </section>
</template>
<script setup lang="ts">
import {useUiI18n} from "@/src/ui/i18n"
const {t, translateLegacy} = useUiI18n()
import {onBeforeUnmount, onMounted, ref} from 'vue'
import ReadingAnswer from './ReadingAnswer.vue'
import {clearHarnessSessions, deleteHarnessSession, getHarnessSession, listHarnessSessions} from '../client'
import type {HarnessSession, HarnessSessionSummary} from '@/src/services/harness/sessionTypes'

const historySessions = ref<HarnessSessionSummary[]>([])
const historyOffset = ref(0)
const historyHasMore = ref(false)
const selectedHistory = ref<HarnessSession | null>(null)
const historyLoading = ref(false)
const historyDetailLoading = ref(false)
const historyMutating = ref(false)
const historyError = ref('')
let historyGeneration = 0
let detailGeneration = 0
const actionLabelFor = (value: string) => ({meaning: '读懂', grammar: '拆句', usage: '用法', practice: '练习'}[value] || '学习')
const statusLabel = (value: string) => ({streaming: '生成中', completed: '已完成', stopped: '已停止', error: '未完成'}[value] || '未完成')
const formatDate = (value: number) => new Intl.DateTimeFormat(undefined, {month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'}).format(value)

function backToHistoryList() {
  detailGeneration += 1
  selectedHistory.value = null
  historyDetailLoading.value = false
}
async function reloadHistory() {
  historyGeneration += 1
  historyLoading.value = false
  historySessions.value = []
  historyOffset.value = 0
  historyHasMore.value = false
  backToHistoryList()
  await loadMoreHistory()
}
async function loadMoreHistory() {
  if (historyLoading.value || historyMutating.value) return
  const generation = historyGeneration
  historyLoading.value = true
  historyError.value = ''
  try {
    const result = await listHarnessSessions(historyOffset.value)
    if (generation !== historyGeneration) return
    const existingIds = new Set(historySessions.value.map((item) => item.id))
    historySessions.value = [...historySessions.value, ...result.sessions.filter((item) => !existingIds.has(item.id))]
    historyOffset.value += result.sessions.length
    historyHasMore.value = result.hasMore
  } catch {
    if (generation === historyGeneration) historyError.value = '读取记录失败，请重试。'
  } finally {
    if (generation === historyGeneration) historyLoading.value = false
  }
}
async function openHistory(id: string) {
  const generation = ++detailGeneration
  historyDetailLoading.value = true
  historyError.value = ''
  try {
    const record = await getHarnessSession(id)
    if (generation !== detailGeneration) return
    if (record) selectedHistory.value = record
    else {
      historySessions.value = historySessions.value.filter((item) => item.id !== id)
      historyOffset.value = historySessions.value.length
      historyError.value = '这条记录已过期或已被删除。'
    }
  } catch {
    if (generation === detailGeneration) historyError.value = '读取记录详情失败，请重试。'
  } finally {
    if (generation === detailGeneration) historyDetailLoading.value = false
  }
}
async function removeHistory(id: string) {
  if (historyMutating.value) return
  historyMutating.value = true
  historyError.value = ''
  historyGeneration += 1
  historyLoading.value = false
  detailGeneration += 1
  historyDetailLoading.value = false
  try {
    await deleteHarnessSession(id)
    historySessions.value = historySessions.value.filter((item) => item.id !== id)
    historyOffset.value = historySessions.value.length
    if (selectedHistory.value?.id === id) backToHistoryList()
  } catch {
    historyError.value = '删除记录失败，请重试。'
  } finally {
    historyMutating.value = false
  }
}
async function clearHistory() {
  if (historyMutating.value || !window.confirm('清空本机全部阅读记录？删除后无法恢复。')) return
  historyMutating.value = true
  historyError.value = ''
  historyGeneration += 1
  historyLoading.value = false
  backToHistoryList()
  try {
    await clearHarnessSessions()
    historySessions.value = []
    historyOffset.value = 0
    historyHasMore.value = false
  } catch {
    historyError.value = '清空记录失败，请重试。'
  } finally {
    historyMutating.value = false
  }
}
onMounted(() => { void reloadHistory() })
onBeforeUnmount(() => {
  historyGeneration += 1
  detailGeneration += 1
})
</script>
<style scoped>
.harness-history { width:100%; }
.harness-history-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:2px 4px; }
.harness-history-heading h2 { margin:0 0 4px; font-size:13px; line-height:1.5; color:var(--ink); }
.harness-history-heading p { margin:0; font-size:10.5px; line-height:1.6; color:var(--muted); }
.harness-history button { font:inherit; font-size:11.5px; cursor:pointer; }
.harness-history button:disabled { cursor:wait; opacity:.6; }
.harness-history button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.harness-secondary-button { flex-shrink:0; border:1px solid var(--line); border-radius:8px; padding:7px 11px; background:var(--surface); color:var(--ink); }
.harness-secondary-button:hover, .harness-text-button:hover { color:var(--accent); }
.harness-text-button { border:0; border-radius:6px; padding:7px 8px; background:transparent; color:var(--muted); }
.harness-history-body { color:var(--ink); margin-top:12px; padding:14px 16px; border:1px solid var(--line); border-radius:14px; background:var(--surface); }
.harness-history-list { max-height:420px; overflow:auto; }
.harness-history-row { display:flex; align-items:center; gap:10px; border-bottom:1px solid var(--line); }
.harness-history-row:last-child { border-bottom:0; }
.harness-history-row > .harness-text-button { flex-shrink:0; }
.harness-history-open { display:flex; flex:1; min-width:0; flex-direction:column; gap:5px; padding:12px 4px; text-align:left; border:0; background:transparent; color:var(--ink); border-radius:6px; }
.harness-history-open:hover { color:var(--accent); }
.harness-history-open > span { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; line-height:1.6; overflow-wrap:anywhere; }
.harness-history-open > small { color:var(--muted); font-size:10px; line-height:1.5; }
.harness-history-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:12px; }
.harness-history-toolbar:first-child { margin:0 0 14px; }
.harness-history-count { color:var(--muted); font-size:10.5px; }
.harness-history-detail { max-width:740px; margin-inline:auto; overflow-wrap:anywhere; }
.harness-history-source { padding:13px 14px; border-radius:10px; background:var(--surface-soft); }
.harness-history-source > small { color:var(--muted); font-size:10.5px; }
.harness-history-source blockquote { margin:7px 0; color:var(--ink); font-size:13px; line-height:1.7; white-space:pre-wrap; }
.harness-history-source p { margin:6px 0 0; color:var(--muted); font-size:10px; }
.harness-history-turn { padding:20px 2px; border-bottom:1px solid var(--line); }
.harness-history-turn:last-child { border-bottom:0; padding-bottom:4px; }
.harness-history-turn > header { margin-bottom:13px; }
.harness-history-turn h3 { margin:0 0 5px; color:var(--ink); font-size:13px; line-height:1.6; white-space:pre-wrap; }
.harness-history-turn > header > small { color:var(--muted); font-size:10px; }
.harness-history-feedback, .harness-history-empty-answer, .harness-history-footnote { margin:10px 0; color:var(--muted); font-size:11px; line-height:1.65; }
.harness-history-feedback button { margin-left:7px; padding:3px 6px; border:0; border-radius:4px; background:var(--surface-soft); color:var(--accent); }
.harness-history-footnote { margin:18px 0 0; }
.harness-history-empty { padding:18px 6px; text-align:center; }
.harness-history-empty strong { color:var(--ink); font-size:12px; }
.harness-history-empty p { max-width:360px; margin:8px auto 0; color:var(--muted); font-size:11px; line-height:1.8; }
.harness-visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
@media (max-width:480px) {
  .harness-history-heading { align-items:flex-start; }
  .harness-history-body { padding:12px; }
  .harness-history-row { gap:4px; }
  .harness-history-source { padding:11px; }
}
</style>

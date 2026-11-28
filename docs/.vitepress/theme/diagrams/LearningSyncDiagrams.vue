<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  kind: 'learning-loop' | 'backup-sync-compare' | 'platform-matrix'
  en: boolean
}>()

const t = (zh: string, english: string) => (props.en ? english : zh)

const learningSteps = computed(() => [
  {
    num: '1',
    title: t('阅读遇见', 'Encounter'),
    desc: t('在网页、PDF 文档或视频字幕中划词查词、听读音，一键收藏词句。', 'Look up words, listen to TTS, and save expressions from webpages, PDFs, or videos.'),
  },
  {
    num: '2',
    title: t('理解与造句', 'Understand & Practice'),
    desc: t('结合原句按需调用 AI 讲解用法，并亲自造句获得自然度反馈。', 'Request on-demand AI explanations in context and practice writing your own sentence.'),
  },
  {
    num: '3',
    title: t('间隔回忆复习', 'Spaced Review'),
    desc: t('每轮最多 20 条，先忆后看答案，仅主动评分（记得/忘了）更新复习计划。', 'Up to 20 items per session; recall first, then grade Remembered / Forgot to schedule reviews.'),
  },
  {
    num: '4',
    title: t('新网页再次遇见', 'Re-encounter'),
    desc: t('开启后在新文章中用点状下划线标出已收藏表达，对照新旧语境加深记忆。', 'Highlights saved expressions with dotted underlines on new articles to compare contexts.'),
  },
])

const learningTabs = computed(() => [
  { name: t('单词与句子', 'Words & Sentences'), retention: t('永久保留', 'Until deleted'), tone: 'rose', desc: t('主动收藏的表达、译文、简短解释、上下文与复习计划；支持导出 Anki。', 'Saved terms, translations, notes, context & review schedule; Anki export ready.') },
  { name: t('阅读材料', 'Reading Materials'), retention: t('永久保留', 'Until cleared'), tone: 'blue', desc: t('按文章、文档与视频整理原句、笔记与阅读位置，支持独立备份与继续阅读。', 'Groups sentences, notes & reading positions by article, document, or video.') },
  { name: t('阅读记录', 'Reading History'), retention: t('保留 30 天', '30 days'), tone: 'amber', desc: t('读懂、句法、用法与练习的 AI 问答历史，可离线回看或继续追问。', 'AI Q&A threads from Explain, Structure, Usage, and Practice; view offline anytime.') },
  { name: t('学习笔记', 'Study Notes'), retention: t('永久保留', 'Until deleted'), tone: 'teal', desc: t('从回答保存的要点或手动记录的学习偏好；默认不自动发给 AI，可按需开启参考。', 'Key takeaways and study preferences; optional AI reference is off by default.') },
])

const backupRows = computed(() => [
  {
    method: t('本地完整备份 (JSON)', 'Local full backup (JSON)'),
    basic: true,
    keys: t('包含（未加密）', 'Included (unencrypted)'),
    vocab: t('包含（上下文可选）', 'Included (context opt-in)'),
    stats: true,
    note: t('换设备 / 卸载前首选，请勿公开分享', 'Best before switching browsers; keep private'),
  },
  {
    method: t('设置历史与自动快照', 'Settings history & snapshots'),
    basic: true,
    keys: t('不包含', 'Excluded'),
    vocab: t('不包含', 'Excluded'),
    stats: false,
    note: t('每 6 小时自动快照，各保留最近 10 份，用于撤回误改', 'Auto-snapshots every 6h (10 max) for quick undo'),
  },
  {
    method: t('云备份 · 基础配置 (v2)', 'Cloud backup · Basic (v2)'),
    basic: true,
    keys: t('不包含（默认安全）', 'Excluded (default)'),
    vocab: t('不包含', 'Excluded'),
    stats: false,
    note: t('Google Drive（桌面 Chrome）或 WebDAV 手动触发', 'Manual sync via Google Drive (Chrome) or WebDAV'),
  },
  {
    method: t('云备份 · 含敏感配置 (v1)', 'Cloud backup · Sensitive (v1)'),
    basic: true,
    keys: t('包含（固定应用口令）', 'Included (public app key)'),
    vocab: t('不包含', 'Excluded'),
    stats: false,
    note: t('需明确确认风险，仅在受保护账号与目录中启用', 'Requires explicit consent; protect cloud account'),
  },
])

const platformRows = computed(() => [
  { env: t('桌面扩展 (Chrome / Edge / Firefox)', 'Desktop Ext (Chrome / Edge / Firefox)'), web: '✓', selection: '✓', media: '✓', docs: '✓', local: '✓' },
  { env: t('移动扩展 (Android Edge / Firefox)', 'Mobile Ext (Android Edge / Firefox)'), web: '✓', selection: '✓', media: t('部分', 'Partial'), docs: '✓', local: t('部分', 'Partial') },
  { env: t('油猴脚本 (桌面 / Via / Safari)', 'Userscript (Desktop / Via / Safari)'), web: '✓', selection: '✓', media: '—', docs: '—', local: '—' },
  { env: t('Safari 原生扩展（开发预览）', 'Safari Native Extension (Preview)'), web: '✓', selection: '✓', media: t('预览', 'Preview'), docs: '✓', local: t('部分', 'Partial') },
  { env: t('Thunderbird 邮件插件', 'Thunderbird Add-on'), web: t('邮件正文', 'Email body'), selection: '—', media: '—', docs: '—', local: '—' },
  { env: t('Zotero 文献插件（实验性）', 'Zotero Add-on (Experimental)'), web: '—', selection: t('PDF 划词', 'PDF select'), media: '—', docs: t('文字层 PDF', 'Text PDF'), local: '—' },
])
</script>

<template>
  <!-- 1. 学习中心闭环与四栏目关系图 -->
  <div v-if="kind === 'learning-loop'" class="ll-wrap">
    <div class="fr-dg-flow ll-flow">
      <template v-for="(s, idx) in learningSteps" :key="s.num">
        <div class="fr-dg-step">
          <div class="fr-dg-card-title">
            <span class="fr-dg-step-num">{{ s.num }}</span>
            <span class="ll-step-title">{{ s.title }}</span>
          </div>
          <p class="fr-dg-card-desc">{{ s.desc }}</p>
        </div>
        <div v-if="idx < learningSteps.length - 1" class="fr-dg-arrow" aria-hidden="true">→</div>
      </template>
    </div>

    <div class="ll-divider">{{ t('学习中心四大栏目数据职责', 'Four Tabs in Learning Center') }}</div>
    <div class="fr-dg-grid-2">
      <div v-for="tab in learningTabs" :key="tab.name" class="fr-dg-card" :class="`fr-dg-card-${tab.tone}`">
        <div class="fr-dg-card-title">
          <span>{{ tab.name }}</span>
          <span class="fr-dg-chip" :class="`fr-dg-chip-${tab.tone}`">{{ tab.retention }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ tab.desc }}</p>
      </div>
    </div>
  </div>

  <!-- 2. 备份与同步方案边界对比图 -->
  <div v-else-if="kind === 'backup-sync-compare'" class="bs-wrap">
    <div class="fr-dg-matrix-wrap">
      <table class="fr-dg-matrix">
        <thead>
          <tr>
            <th>{{ t('方式', 'Method') }}</th>
            <th>{{ t('基础配置', 'Basic settings') }}</th>
            <th>{{ t('API 密钥与连接', 'Keys & connections') }}</th>
            <th>{{ t('词书与收藏', 'Vocabulary') }}</th>
            <th>{{ t('用量统计', 'Usage stats') }}</th>
            <th>{{ t('适用建议', 'When to use') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in backupRows" :key="row.method">
            <td><strong>{{ row.method }}</strong></td>
            <td class="fr-dg-status-yes">✓</td>
            <td :class="row.keys.includes('不') || row.keys.includes('Excluded') ? 'fr-dg-status-no' : 'fr-dg-status-part'">{{ row.keys }}</td>
            <td :class="row.vocab.includes('不') || row.vocab.includes('Excluded') ? 'fr-dg-status-no' : 'fr-dg-status-yes'">{{ row.vocab }}</td>
            <td :class="row.stats ? 'fr-dg-status-yes' : 'fr-dg-status-no'">{{ row.stats ? '✓' : '—' }}</td>
            <td>{{ row.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 3. 跨平台能力矩阵图 -->
  <div v-else class="pm-wrap">
    <div class="fr-dg-matrix-wrap">
      <table class="fr-dg-matrix">
        <thead>
          <tr>
            <th>{{ t('平台与版本', 'Platform / Edition') }}</th>
            <th>{{ t('网页双语', 'Webpage') }}</th>
            <th>{{ t('划词翻译', 'Selection') }}</th>
            <th>{{ t('图片 / 圈选 / 视频', 'Image / Area / Video') }}</th>
            <th>{{ t('文档翻译', 'Documents') }}</th>
            <th>{{ t('本地模型', 'Local AI') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in platformRows" :key="row.env">
            <td><strong>{{ row.env }}</strong></td>
            <td :class="row.web === '✓' ? 'fr-dg-status-yes' : row.web === '—' ? 'fr-dg-status-no' : 'fr-dg-status-part'">{{ row.web }}</td>
            <td :class="row.selection === '✓' ? 'fr-dg-status-yes' : row.selection === '—' ? 'fr-dg-status-no' : 'fr-dg-status-part'">{{ row.selection }}</td>
            <td :class="row.media === '✓' ? 'fr-dg-status-yes' : row.media === '—' ? 'fr-dg-status-no' : 'fr-dg-status-part'">{{ row.media }}</td>
            <td :class="row.docs === '✓' ? 'fr-dg-status-yes' : row.docs === '—' ? 'fr-dg-status-no' : 'fr-dg-status-part'">{{ row.docs }}</td>
            <td :class="row.local === '✓' ? 'fr-dg-status-yes' : row.local === '—' ? 'fr-dg-status-no' : 'fr-dg-status-part'">{{ row.local }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.ll-step-title {
  flex: 1;
}
.ll-divider {
  margin: 16px 0 10px;
  font-size: 12px;
  font-weight: 680;
  color: var(--fr-muted, #6b6872);
  letter-spacing: 0.02em;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  kind: 'image-pipeline' | 'document-workflow' | 'video-matrix'
  en: boolean
}>()

const t = (zh: string, english: string) => (props.en ? english : zh)

/* 文档阅读模式交互切换 */
const pdfView = ref<'original' | 'reflow'>('original')

const docFormats = computed(() => [
  {
    group: t('学术与电子书', 'Academic & eBooks'),
    tone: 'rose',
    formats: ['PDF (≤50 MB)', 'EPUB'],
    note: t('支持原版双语对照、重排阅读、目录同步与扫描页 OCR', 'Original layout & reflow reading, synced TOC, scanned-page OCR'),
  },
  {
    group: t('办公与网页文档', 'Office & Web Docs'),
    tone: 'blue',
    formats: ['DOCX', 'HTML', 'Markdown', 'TXT'],
    note: t('保留标题、链接、表格与代码结构，不改写代码块', 'Preserves headings, links, tables & code blocks'),
  },
  {
    group: t('结构化数据表', 'Structured Data'),
    tone: 'teal',
    formats: ['JSON', 'CSV', 'TSV'],
    note: t('CSV/TSV 可按列选择翻译；JSON 保留键名与非文本值', 'Column selection for CSV/TSV; preserves JSON keys & non-text values'),
  },
  {
    group: t('字幕文件', 'Subtitles'),
    tone: 'amber',
    formats: ['SRT', 'VTT', 'ASS', 'SSA', 'LRC'],
    note: t('保留序号与时间轴，AI 模式自动参考前后字幕语境', 'Keeps timestamps & styling tags; AI uses neighboring cues'),
  },
])

const imageSteps = computed(() => [
  {
    num: '1',
    title: t('本机文字识别', 'Local OCR'),
    zone: t('本机浏览器', 'On-device'),
    desc: t('默认 PaddleOCR（约 30 MB）；俄/韩/阿/希伯来语自动切换 Tesseract 语言包。', 'PaddleOCR (~30 MB) by default; auto-uses Tesseract packs for RU/KO/AR/HE.'),
  },
  {
    num: '2',
    title: t('仅发送文本翻译', 'Text-only Translation'),
    zone: t('所选服务', 'Provider'),
    desc: t('只把识别出的文字交给翻译服务，原图像素不随文本请求上传。', 'Only recognized text is sent to your provider; image pixels stay local.'),
  },
  {
    num: '3',
    title: t('本机背景修补', 'Local Inpainting'),
    zone: t('本机浏览器', 'On-device'),
    desc: t('纯色/渐变优先原色还原，漫画复杂底图使用 LaMa（约 197 MB）本地擦字。', 'Restores solid/gradient backgrounds cleanly; manga uses local LaMa (~197 MB).'),
  },
  {
    num: '4',
    title: t('译图与文字面板', 'Rendered + Text Panel'),
    zone: t('随时切换', 'Toggle anytime'),
    desc: t('支持一键切回原图、按住对照，复杂排版或保护原文同时提供文字面板复制。', 'Switch Original/Translated anytime; text panel shows full copyable text.'),
  },
])

const videoPlatforms = computed(() => [
  { name: 'YouTube', native: true, aiAsr: false, study: true, exportable: true },
  { name: t('哔哩哔哩 (普通/分P)', 'Bilibili (Standard/Multi-P)'), native: true, aiAsr: true, study: true, exportable: true },
  { name: 'X (Twitter)', native: true, aiAsr: true, study: true, exportable: true },
  { name: 'Udemy / edX / Coursera', native: true, aiAsr: false, study: true, exportable: true },
  { name: 'Google Meet / Teams / Zoom', native: true, aiAsr: false, study: false, exportable: false },
  { name: t('普通网页 HTML 音视频', 'Standard HTML audio/video'), native: true, aiAsr: true, study: true, exportable: true },
])
</script>

<template>
  <!-- 1. 图片与漫画本地识别管线图 -->
  <div v-if="kind === 'image-pipeline'" class="im-wrap">
    <div class="fr-dg-flow">
      <template v-for="(s, idx) in imageSteps" :key="s.num">
        <div class="fr-dg-step" :class="idx === 1 ? 'fr-dg-card-rose' : 'fr-dg-card-teal'">
          <div class="fr-dg-card-title">
            <span class="fr-dg-step-num">{{ s.num }}</span>
            <span class="im-step-title">{{ s.title }}</span>
            <span class="fr-dg-chip" :class="idx === 1 ? 'fr-dg-chip-rose' : 'fr-dg-chip-teal'">{{ s.zone }}</span>
          </div>
          <p class="fr-dg-card-desc">{{ s.desc }}</p>
        </div>
        <div v-if="idx < imageSteps.length - 1" class="fr-dg-arrow" aria-hidden="true">→</div>
      </template>
    </div>

    <div class="fr-dg-grid-3 im-modes">
      <div class="fr-dg-card fr-dg-card-soft">
        <div class="fr-dg-card-title">
          <span>{{ t('单张图片翻译', 'Single image') }}</span>
          <span class="fr-dg-chip fr-dg-chip-slate">{{ t('悬停 / 右键', 'Hover / Right-click') }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('适合海报、图表、文档配图。点击放大时直接复用译图，无需重译。', 'Great for posters, charts, and article images. Reuses translations when enlarged.') }}</p>
      </div>
      <div class="fr-dg-card fr-dg-card-soft">
        <div class="fr-dg-card-title">
          <span>{{ t('漫画连续翻译', 'Continuous manga') }}</span>
          <span class="fr-dg-chip fr-dg-chip-rose">{{ t('滚动预译 0–5 页', 'Prefetch 0–5 pages') }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('适配 MANGA Plus、Pixiv 及自建阅读器。支持按住对照原图与实时进度。', 'Works on MANGA Plus, Pixiv & self-hosted readers with hold-to-compare and live progress.') }}</p>
      </div>
      <div class="fr-dg-card fr-dg-card-soft">
        <div class="fr-dg-card-title">
          <span>{{ t('圈选截图翻译', 'Area selection') }}</span>
          <span class="fr-dg-chip fr-dg-chip-blue">Shift+Z</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('适合无法读取的跨域图、暂停视频画面或局部图表，可选模型识图或本地 OCR。', 'Ideal for restricted images, paused video frames, or cropped charts via Vision AI or local OCR.') }}</p>
      </div>
    </div>
  </div>

  <!-- 2. 文档格式与 PDF 双模式图解 -->
  <div v-else-if="kind === 'document-workflow'" class="dw-wrap">
    <div class="fr-dg-grid-4 dw-formats">
      <div v-for="item in docFormats" :key="item.group" class="fr-dg-card fr-dg-card-soft">
        <div class="fr-dg-card-title">
          <span>{{ item.group }}</span>
        </div>
        <div class="dw-pills">
          <span v-for="f in item.formats" :key="f" class="fr-dg-chip" :class="`fr-dg-chip-${item.tone}`">{{ f }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ item.note }}</p>
      </div>
    </div>

    <div class="dw-pdf-box">
      <div class="dw-pdf-top">
        <strong>{{ t('PDF 双阅读模式对比', 'PDF Dual Reading Modes') }}</strong>
        <div class="fr-dg-tabs dw-tabs" role="group" :aria-label="t('切换 PDF 阅读模式', 'Switch PDF reading mode')">
          <button type="button" class="fr-dg-tab" :aria-pressed="pdfView === 'original'" @click="pdfView = 'original'">
            {{ t('原版排版（左右对照）', 'Original layout (Side by side)') }}
          </button>
          <button type="button" class="fr-dg-tab" :aria-pressed="pdfView === 'reflow'" @click="pdfView = 'reflow'">
            {{ t('重排阅读（流式单栏）', 'Reflow reading (Single column)') }}
          </button>
        </div>
      </div>

      <div v-if="pdfView === 'original'" class="fr-dg-grid-2 dw-preview">
        <div class="dw-sheet">
          <span class="fr-dg-chip fr-dg-chip-slate">{{ t('原页版式', 'Original page') }}</span>
          <div class="dw-cols">
            <div>
              <b>2.1 Architecture</b>
              <p>Formula: E = mc²</p>
              <div class="dw-fig">{{ t('原图 / 图表保留', 'Figures preserved') }}</div>
            </div>
            <div>
              <b>2.2 Results</b>
              <p>Table 1 stays intact.</p>
            </div>
          </div>
        </div>
        <div class="dw-sheet dw-sheet-tr">
          <span class="fr-dg-chip fr-dg-chip-rose">{{ t('同步译文页', 'Translated mirror') }}</span>
          <div class="dw-cols">
            <div>
              <b>2.1 架构设计</b>
              <p>公式：E = mc²</p>
              <div class="dw-fig">{{ t('公式与纯数字原样保留', 'Math & numbers untouched') }}</div>
            </div>
            <div>
              <b>2.2 实验结果</b>
              <p>表 1 维持对应位置，长段可悬停展开完整段落。</p>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="dw-reflow-preview">
        <div class="dw-reflow-sheet">
          <div class="dw-reflow-head">
            <span class="fr-dg-chip fr-dg-chip-teal">{{ t('适合窄屏 / 分屏 / 长时间阅读', 'Best for narrow & split screens') }}</span>
            <span class="fr-dg-chip fr-dg-chip-slate">{{ t('纸张 / 薄荷 / 深色 / 自定义配色', 'Paper / Mint / Dark / Custom themes') }}</span>
          </div>
          <p class="dw-reflow-orig">2.1 Architecture — The modular pipeline keeps layout and text synchronized.</p>
          <p class="dw-reflow-tr">2.1 架构设计 — 模块化管线让原文段落与译文在同一栏内逐段对齐，可自由调节字号、行距与段距。</p>
        </div>
      </div>
    </div>
  </div>

  <!-- 3. 视频与会议字幕能力矩阵图 -->
  <div v-else class="vm-wrap">
    <div class="fr-dg-grid-3 vm-tracks">
      <div class="fr-dg-card fr-dg-card-rose">
        <div class="fr-dg-card-title">
          <span>{{ t('① 平台原生字幕直译', '1. Native captions') }}</span>
          <span class="fr-dg-chip fr-dg-chip-rose">{{ t('最快最稳', 'Fastest') }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('优先读取人工字幕，支持双语/译文/原文切换、±10s 校时、读音标注与完整句学习。', 'Prefers human captions; supports mode switching, ±10s sync offset, phonetics & sentence study.') }}</p>
      </div>
      <div class="fr-dg-card fr-dg-card-blue">
        <div class="fr-dg-card-title">
          <span>{{ t('② 网页会议实时字幕', '2. Live web meetings') }}</span>
          <span class="fr-dg-chip fr-dg-chip-blue">Meet · Teams · Zoom</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('在网页版会议中实时对照翻译平台字幕，不开启录制或云端转录。', 'Translates live captions inside web meeting clients without recording or transcribing calls.') }}</p>
      </div>
      <div class="fr-dg-card fr-dg-card-teal">
        <div class="fr-dg-card-title">
          <span>{{ t('③ 无字幕本地 AI 转写', '3. On-device AI ASR') }}</span>
          <span class="fr-dg-chip fr-dg-chip-teal">Whisper / Qwen3</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('X、B 站及普通 HTML 音视频无字幕时，在本机解码转写（单次最长 20 分钟）。', 'Transcribes X, Bilibili & HTML media locally on-device (up to 20 min per run).') }}</p>
      </div>
    </div>

    <div class="fr-dg-matrix-wrap">
      <table class="fr-dg-matrix">
        <thead>
          <tr>
            <th>{{ t('平台 / 媒体类型', 'Platform / Media') }}</th>
            <th>{{ t('原生字幕翻译', 'Native captions') }}</th>
            <th>{{ t('本地 AI 转写', 'Local AI ASR') }}</th>
            <th>{{ t('完整句学习', 'Sentence study') }}</th>
            <th>{{ t('导出字幕', 'Export') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in videoPlatforms" :key="row.name">
            <td><strong>{{ row.name }}</strong></td>
            <td :class="row.native ? 'fr-dg-status-yes' : 'fr-dg-status-no'">{{ row.native ? '✓' : '—' }}</td>
            <td :class="row.aiAsr ? 'fr-dg-status-yes' : 'fr-dg-status-no'">{{ row.aiAsr ? '✓' : '—' }}</td>
            <td :class="row.study ? 'fr-dg-status-yes' : 'fr-dg-status-no'">{{ row.study ? '✓' : '—' }}</td>
            <td :class="row.exportable ? 'fr-dg-status-yes' : 'fr-dg-status-no'">{{ row.exportable ? 'SRT / VTT / MD' : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.im-step-title {
  flex: 1;
}
.im-modes {
  margin-top: 14px;
}

.dw-formats {
  margin-bottom: 16px;
}
.dw-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 6px 0 8px;
}
.dw-pdf-box {
  border: 1px solid var(--fr-line, #e7e7eb);
  border-radius: 10px;
  padding: 14px;
  background: #faf9fb;
}
.dw-pdf-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.dw-tabs {
  margin-bottom: 0;
}
.dw-sheet {
  border: 1px solid var(--fr-line, #e7e7eb);
  border-radius: 8px;
  padding: 12px;
  background: #ffffff;
}
.dw-sheet-tr {
  border-color: #efcbd7;
}
.dw-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 8px;
  font-size: 11.5px;
}
.dw-cols b {
  display: block;
  margin-bottom: 4px;
}
.dw-fig {
  margin-top: 6px;
  padding: 6px;
  border-radius: 5px;
  background: #f4f3f6;
  color: var(--fr-muted, #6b6872);
  font-size: 10.5px;
  text-align: center;
}
.dw-reflow-sheet {
  border: 1px solid #cbe6e0;
  border-radius: 8px;
  padding: 14px;
  background: #ffffff;
}
.dw-reflow-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.dw-reflow-orig {
  font-size: 12.5px;
  color: var(--fr-ink, #26232c);
}
.dw-reflow-tr {
  margin-top: 6px !important;
  padding-left: 10px;
  border-left: 2.5px solid #1f665c;
  font-size: 12.5px;
  color: #1f665c;
  font-weight: 550;
}

.vm-tracks {
  margin-bottom: 14px;
}
</style>

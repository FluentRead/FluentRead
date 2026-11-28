<script setup lang="ts">
import { computed, ref } from 'vue'
import { withBase } from 'vitepress'

const props = defineProps<{
  kind: 'ecosystem-map' | 'webpage-modes' | 'shortcuts-board' | 'appearance-styles'
  en: boolean
}>()

const t = (zh: string, english: string) => (props.en ? english : zh)
const link = (path: string) => withBase((props.en ? '/en' : '') + path)

/* 0. 译文外观预设交互体验 */
type StylePreset = 'quote' | 'highlight' | 'card' | 'blur'
const activeStyle = ref<StylePreset>('quote')
const stylePresets = computed(() => [
  { key: 'quote' as const, label: t('引用色条', 'Quote bar'), desc: t('轻量不抢眼，适合长时间技术文档与学术论文精读。', 'Low visual noise, ideal for long technical docs and papers.') },
  { key: 'highlight' as const, label: t('柔和荧光标记', 'Soft marker'), desc: t('一眼区分原文与译文，便于快速扫读双语段落。', 'Clear visual contrast for fast bilingual scanning.') },
  { key: 'card' as const, label: t('自适应卡片', 'Adaptive card'), desc: t('自动随网页明暗区域配色，深浅页面切换均清晰可读。', 'Adapts automatically to light and dark sections of any site.') },
  { key: 'blur' as const, label: t('模糊遮罩（悬停揭开）', 'Blur until hover'), desc: t('默认虚化译文，先逼自己读懂原文，悬停或键盘聚焦立即揭开。', 'Hides translation until hovered or focused—great for reading practice.') },
])
const activeStyleMeta = computed(
  () => stylePresets.value.find((s) => s.key === activeStyle.value) ?? stylePresets.value[0]
)

/* 1. 网页四种翻译方式对比状态 */
type WebpageModeKey = 'full' | 'section' | 'hover' | 'selection'
const activeWebMode = ref<WebpageModeKey>('full')

const webModes = computed(() => [
  {
    key: 'full' as const,
    label: t('全文双语', 'Full page'),
    trigger: t('点击工具栏图标 / Alt+T', 'Toolbar icon / Alt+T'),
    scope: t('随滚动逐步翻译正文，支持切换双语 / 仅译文', 'Translates visible paragraphs as you scroll; switch Bilingual / Translation only'),
    bestFor: t('长文博客、技术文档、arXiv 学术论文、新闻资讯', 'Long articles, technical docs, arXiv papers, news'),
    guidePath: '/guide/webpage-translation',
    guideText: t('全文与局部翻译指南', 'Page & section guide'),
  },
  {
    key: 'section' as const,
    label: t('局部翻译', 'Section'),
    trigger: t('菜单点击「局部」/ Alt+R', 'Menu "Section" / Alt+R'),
    scope: t('点选或拖拽框定指定正文、README 或评论区，并可记住区域', 'Pick or drag-select a specific block, README, or comment thread; optionally remember it'),
    bestFor: t('页面复杂、只想看评论区或某一个卡片模块', 'Dense pages where you only need one section or comment thread'),
    guidePath: t('/guide/webpage-translation#局部翻译', '/guide/webpage-translation#section-translation'),
    guideText: t('查看局部翻译步骤', 'Section translation steps'),
  },
  {
    key: 'hover' as const,
    label: t('悬浮段落', 'Hover paragraph'),
    trigger: t('鼠标停在段落上按 Control', 'Hover paragraph + press Control'),
    scope: t('仅翻译光标所在单段，再按一次立即恢复该段原文', 'Translates only the hovered paragraph; press again to restore'),
    bestFor: t('大部分看得懂，偶尔遇到生僻长段快速对照', 'Reading mostly in original language with occasional tough paragraphs'),
    guidePath: '/guide/hover-translation',
    guideText: t('悬浮段落翻译指南', 'Hover translation guide'),
  },
  {
    key: 'selection' as const,
    label: t('划词卡片', 'Selection card'),
    trigger: t('选中文字点击图标 / 快捷键', 'Select text + click icon / shortcut'),
    scope: t('弹出词卡：译文、多源朗读、英文词典、AI 句法拆解与收藏', 'Opens card with translation, multi-source TTS, dictionary, AI grammar & save'),
    bestFor: t('查生词音标、精读长难句、收藏表达到学习中心', 'Word lookup, pronunciation, deep grammar breakdown, saving vocabulary'),
    guidePath: '/guide/deepseek-harness',
    guideText: t('划词翻译指南', 'Selection translation guide'),
  },
])

const currentWebMode = computed(
  () => webModes.value.find((m) => m.key === activeWebMode.value) ?? webModes.value[0]
)

/* 2. 快捷键速查系统切换 */
const isMac = ref(false)
const modAlt = computed(() => (isMac.value ? 'Option' : 'Alt'))
const modCmd = computed(() => (isMac.value ? '⌘' : 'Ctrl'))

const shortcutGroups = computed(() => [
  {
    title: t('网页阅读与段落', 'Webpage & paragraphs'),
    tone: 'rose',
    items: [
      { keys: [modAlt.value, 'T'], desc: t('翻译整页 / 恢复原文', 'Translate page / Restore original') },
      { keys: ['Control'], desc: t('鼠标悬停段落翻译 / 恢复', 'Translate / restore hovered paragraph') },
      { keys: [modAlt.value, 'C'], desc: t('复制鼠标所在段落', 'Copy hovered paragraph') },
      { keys: [modAlt.value, 'H'], desc: t('开启 / 关闭当前页智能高亮（需开启）', 'Toggle Smart Highlighting (when enabled)') },
    ],
  },
  {
    title: t('选区、局部与校订', 'Selection, sections & edits'),
    tone: 'teal',
    items: [
      { keys: [modAlt.value, 'R'], desc: t('进入局部区域选择（需开启）', 'Start section picker (when enabled)') },
      { keys: [modAlt.value, 'Shift', 'S'], desc: t('两点选取文字（需开启）', 'Two-point selection (when enabled)') },
      { keys: [modAlt.value, 'Shift', 'E'], desc: t('打开个人校订编辑（需开启）', 'Open personal edit (when enabled)') },
      { keys: ['Esc'], desc: t('取消选区 / 关闭浮层卡片', 'Cancel selection / close overlay') },
    ],
  },
  {
    title: t('图片、视频与输入', 'Images, video & input'),
    tone: 'blue',
    items: [
      { keys: ['Shift', 'Z'], desc: t('启动圈选截屏翻译', 'Start area screenshot translation') },
      { keys: [modAlt.value, 'M'], desc: t('切换视频字幕模式（需开启）', 'Switch video subtitle mode (when enabled)') },
      { keys: ['Space ×3'], desc: t('输入框三连按触发翻译（可换键）', 'Triple-Space in input box (customizable)') },
      { keys: ['R / Q'], desc: t('完整句学习循环 / 句末暂停', 'Loop / pause sentence in video study') },
    ],
  },
  {
    title: t('翻译中心与侧边栏', 'Translation Center & sidebar'),
    tone: 'amber',
    items: [
      { keys: [modCmd.value, 'Enter'], desc: t('立即触发多服务对比翻译', 'Translate in Translation Center') },
      { keys: ['Enter'], desc: t('侧边栏发送翻译（Shift+Enter 换行）', 'Translate in sidebar (Shift+Enter newline)') },
      { keys: [modAlt.value, '↑ / ↓'], desc: t('键盘调整对比服务卡片顺序', 'Reorder comparison cards with keyboard') },
      { keys: ['← / →'], desc: t('在词性与句法拆解中切换片段', 'Step through sentence structure chunks') },
    ],
  },
])

/* 3. 全景架构图层高亮 */
const activeLayer = ref<number | null>(null)
const ecosystemLayers = computed(() => [
  {
    step: '01',
    chipClass: 'fr-dg-chip-rose',
    cardClass: 'fr-dg-card-rose',
    name: t('四大触发入口', '4 Quick Entry Points'),
    summary: t('任何页面零干扰唤起，不打断原有阅读流', 'Launch cleanly on any page without breaking reading flow'),
    links: [
      { text: t('工具栏快捷菜单', 'Toolbar popup'), to: '/guide/getting-started' },
      { text: t('边缘悬浮球', 'Floating ball'), to: '/guide/webpage-translation' },
      { text: t('键盘快捷键', 'Shortcuts'), to: '/guide/custom-hotkey' },
      { text: t('浏览器侧边栏', 'Side panel'), to: '/guide/translation-center' },
    ],
  },
  {
    step: '02',
    chipClass: 'fr-dg-chip-blue',
    cardClass: 'fr-dg-card-blue',
    name: t('全媒介阅读与表达场景', 'Every Reading & Writing Scenario'),
    summary: t('覆盖网页、PDF/EPUB 文档、图片漫画、视频会议与语言学习', 'Webpages, PDF/EPUB docs, images & manga, videos/meetings, and study'),
    links: [
      { text: t('网页全文 / 局部', 'Page & section'), to: '/guide/webpage-translation' },
      { text: t('划词与 AI 讲解', 'Selection & AI'), to: '/guide/deepseek-harness' },
      { text: t('文档翻译工作台', 'Document reader'), to: '/guide/document-translation' },
      { text: t('图片与漫画', 'Image & manga'), to: '/guide/image-translation' },
      { text: t('视频与会议字幕', 'Video & meetings'), to: '/guide/video-subtitles' },
      { text: t('学习中心与写作', 'Learning & writing'), to: '/guide/vocabulary-book' },
    ],
  },
  {
    step: '03',
    chipClass: 'fr-dg-chip-teal',
    cardClass: 'fr-dg-card-teal',
    name: t('按功能灵活路由的翻译引擎', 'Feature-Aware Translation Router'),
    summary: t('每个场景可独立指定服务：免费池、AI 大模型、云 API 或本机离线模型', 'Assign free pool, AI models, cloud APIs, or offline local models per feature'),
    links: [
      { text: t('翻译服务与模型', 'Translation providers'), to: '/config/translation-engines' },
      { text: t('浏览器内置翻译', 'Built-in browser AI'), to: '/guide/chrome-translator' },
      { text: t('术语库与 AI 精翻', 'Glossaries'), to: '/guide/glossary' },
      { text: t('翻译统计与用量', 'Stats & usage'), to: '/guide/translation-stats' },
    ],
  },
  {
    step: '04',
    chipClass: 'fr-dg-chip-amber',
    cardClass: 'fr-dg-card-amber',
    name: t('本地优先的隐私、适配与同步底座', 'Local-First Privacy, Rules & Sync'),
    summary: t('数据默认留在浏览器，支持脱敏防护、专站规则与跨设备云备份', 'Local storage by default, with privacy redaction, site rules, and optional cloud backup'),
    links: [
      { text: t('翻译隐私防护', 'Privacy shield'), to: '/config/privacy-protection' },
      { text: t('网站阅读范围', 'Site rules'), to: '/config/site-adaptation' },
      { text: t('备份与云同步', 'Backup & sync'), to: '/config/backup-sync' },
      { text: t('跨平台支持', 'More platforms'), to: '/guide/mobile-safari' },
    ],
  },
])
</script>

<template>
  <!-- 1. 全景能力架构图 -->
  <div v-if="kind === 'ecosystem-map'" class="eco-wrap">
    <div class="eco-stack">
      <div
        v-for="(layer, idx) in ecosystemLayers"
        :key="layer.step"
        class="fr-dg-card eco-layer"
        :class="[layer.cardClass, { 'eco-active': activeLayer === idx }]"
        @mouseenter="activeLayer = idx"
        @mouseleave="activeLayer = null"
      >
        <div class="eco-layer-head">
          <span class="fr-dg-chip" :class="layer.chipClass">{{ t('层级', 'Layer') }} {{ layer.step }}</span>
          <strong>{{ layer.name }}</strong>
          <span class="eco-summary">{{ layer.summary }}</span>
        </div>
        <div class="eco-pills">
          <a v-for="item in layer.links" :key="item.to + item.text" class="fr-dg-link-pill" :href="link(item.to)">
            {{ item.text }} <span aria-hidden="true">→</span>
          </a>
        </div>
      </div>
    </div>
  </div>

  <!-- 2. 四种网页翻译方式交互对比图 -->
  <div v-else-if="kind === 'webpage-modes'" class="wm-wrap">
    <div class="fr-dg-tabs" role="group" :aria-label="t('切换网页翻译模式', 'Choose webpage translation mode')">
      <button
        v-for="mode in webModes"
        :key="mode.key"
        type="button"
        class="fr-dg-tab"
        :aria-pressed="activeWebMode === mode.key"
        @click="activeWebMode = mode.key"
      >
        {{ mode.label }}
      </button>
    </div>

    <div class="wm-stage">
      <div class="wm-browser" aria-hidden="true">
        <div class="wm-bar">
          <span class="wm-dots"><i></i><i></i><i></i></span>
          <span class="wm-url">example.org/article</span>
          <span class="fr-dg-chip fr-dg-chip-rose">{{ currentWebMode.label }}</span>
        </div>
        <div class="wm-page">
          <div class="wm-block" :class="{ 'wm-focus': activeWebMode === 'full' || activeWebMode === 'hover' }">
            <p class="wm-orig">
              <span v-if="activeWebMode === 'selection'" class="wm-sel">Clear documentation turns complex tools</span>
              <span v-else>Clear documentation turns complex tools</span>
              into everyday habits.
            </p>
            <p v-if="activeWebMode === 'full' || activeWebMode === 'hover'" class="wm-trans">
              清晰的文档能把复杂工具变成日常习惯。
            </p>
            <div v-if="activeWebMode === 'selection'" class="wm-popover">
              <strong>{{ t('划词译文', 'Selection') }}</strong>
              <span>{{ t('清晰的文档能把复杂工具… · 词典 / 朗读 / AI 讲解', 'Clear documentation turns… · Dict / TTS / AI') }}</span>
            </div>
          </div>

          <div class="wm-block" :class="{ 'wm-section-box': activeWebMode === 'section' }">
            <p class="wm-orig">
              Readers compare originals and translations side by side without leaving the page.
            </p>
            <p v-if="activeWebMode === 'full' || activeWebMode === 'section'" class="wm-trans">
              读者无需离开当前网页，即可逐段对照原文与译文。
            </p>
            <span v-if="activeWebMode === 'section'" class="wm-section-tag">
              {{ t('仅翻译锁定区域', 'Locked section only') }}
            </span>
          </div>
        </div>
      </div>

      <div class="fr-dg-card fr-dg-card-soft wm-meta">
        <div class="wm-meta-row">
          <span class="fr-dg-chip fr-dg-chip-slate">{{ t('触发方式', 'Trigger') }}</span>
          <strong>{{ currentWebMode.trigger }}</strong>
        </div>
        <div class="wm-meta-row">
          <span class="fr-dg-chip fr-dg-chip-teal">{{ t('翻译范围', 'Scope') }}</span>
          <p class="fr-dg-card-desc">{{ currentWebMode.scope }}</p>
        </div>
        <div class="wm-meta-row">
          <span class="fr-dg-chip fr-dg-chip-blue">{{ t('适用场景', 'Best for') }}</span>
          <p class="fr-dg-card-desc">{{ currentWebMode.bestFor }}</p>
        </div>
        <a class="fr-dg-link-pill wm-go" :href="link(currentWebMode.guidePath)">
          {{ currentWebMode.guideText }} <span aria-hidden="true">→</span>
        </a>
      </div>
    </div>
  </div>

  <!-- 4. 译文外观样式与两种高亮对照示意 -->
  <div v-else-if="kind === 'appearance-styles'" class="ap-wrap">
    <div class="fr-dg-tabs" role="group" :aria-label="t('预览译文样式预设', 'Preview translation style presets')">
      <button
        v-for="preset in stylePresets"
        :key="preset.key"
        type="button"
        class="fr-dg-tab"
        :aria-pressed="activeStyle === preset.key"
        @click="activeStyle = preset.key"
      >
        {{ preset.label }}
      </button>
    </div>

    <div class="ap-sample-box">
      <p class="ap-orig">{{ t('Good typography stays quiet until you need to compare a difficult phrase.', '克制的排版在平时保持安静，只在需要核对难句时清晰浮现。') }}</p>
      <p class="ap-trans" :class="`ap-style-${activeStyle}`" tabindex="0">
        {{ t('克制的排版在平时保持安静，只在需要核对难句时清晰浮现。', 'Good typography stays quiet until you need to compare a difficult phrase.') }}
      </p>
      <p class="fr-dg-card-desc ap-desc">{{ activeStyleMeta.desc }}</p>
    </div>

    <div class="fr-dg-grid-2 ap-compare">
      <div class="fr-dg-card fr-dg-card-rose">
        <div class="fr-dg-card-title">
          <span>{{ t('双语逐句高亮', 'Bilingual sentence highlight') }}</span>
          <span class="fr-dg-chip fr-dg-chip-rose">{{ t('原译句对联动', 'Original ↔ Translation') }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('悬停任意一句（含行内公式）时，同步点亮原文与译文对应句；仅在双语模式下生效，支持 8 套预设与自定义 CSS。', 'Hovering a sentence (including inline math) highlights both original and translation counterparts simultaneously.') }}</p>
      </div>
      <div class="fr-dg-card fr-dg-card-teal">
        <div class="fr-dg-card-title">
          <span>{{ t('智能高亮（独立开关）', 'Smart Highlighting (separate)') }}</span>
          <span class="fr-dg-chip fr-dg-chip-teal">{{ t('正文扫读辅助', 'Skimming aid') }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('本机分析正文关键词或预测意外度，在单语或双语正文中标色，辅助快速抓取信息焦点。', 'Runs on-device keyword or surprisal analysis on article prose to help scan dense passages.') }}</p>
      </div>
    </div>
  </div>

  <!-- 3. 快捷键交互速查板 -->
  <div v-else class="kb-wrap">
    <div class="kb-bar">
      <div class="fr-dg-tabs kb-tabs" role="group" :aria-label="t('切换操作系统键位', 'Switch keyboard layout')">
        <button type="button" class="fr-dg-tab" :aria-pressed="!isMac" @click="isMac = false">
          Windows / Linux
        </button>
        <button type="button" class="fr-dg-tab" :aria-pressed="isMac" @click="isMac = true">
          macOS
        </button>
      </div>
      <span class="kb-note">
        {{ t('所有快捷键均在输入框内自动让行，避免打断打字。', 'Shortcuts automatically yield inside text inputs and editors.') }}
      </span>
    </div>

    <div class="fr-dg-grid-2">
      <div v-for="group in shortcutGroups" :key="group.title" class="fr-dg-card">
        <div class="fr-dg-card-title">
          <span>{{ group.title }}</span>
          <span class="fr-dg-chip" :class="`fr-dg-chip-${group.tone}`">{{ group.items.length }}</span>
        </div>
        <ul class="kb-list">
          <li v-for="item in group.items" :key="item.desc">
            <span class="fr-dg-kbd-row">
              <template v-for="(k, idx) in item.keys" :key="k + idx">
                <kbd class="fr-dg-kbd">{{ k }}</kbd>
                <span v-if="idx < item.keys.length - 1" class="fr-dg-plus">+</span>
              </template>
            </span>
            <span class="kb-desc">{{ item.desc }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.eco-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.eco-layer {
  transition: border-color 0.16s, box-shadow 0.16s;
}
.eco-active {
  box-shadow: 0 4px 16px rgba(38, 35, 44, 0.06);
}
.eco-layer-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  margin-bottom: 10px;
}
.eco-layer-head strong {
  font-size: 13.5px;
}
.eco-summary {
  font-size: 12px;
  color: var(--fr-muted, #6b6872);
}
.eco-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.wm-stage {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 14px;
  align-items: stretch;
}
.wm-browser {
  border: 1px solid var(--fr-line, #e7e7eb);
  border-radius: 10px;
  overflow: hidden;
  background: #ffffff;
}
.wm-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--fr-line, #e7e7eb);
  background: #f6f5f8;
  font-size: 11px;
  color: var(--fr-muted, #6b6872);
}
.wm-dots {
  display: inline-flex;
  gap: 4px;
}
.wm-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d2ceda;
}
.wm-url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wm-page {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wm-block {
  position: relative;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: #faf9fb;
}
.wm-focus {
  border-color: #f0cad6;
  background: #fff9fb;
}
.wm-section-box {
  border: 1.5px dashed #b92252;
  background: #fff9fb;
}
.wm-section-tag {
  display: inline-block;
  margin-top: 6px;
  font-size: 10.5px;
  font-weight: 650;
  color: #a61c48;
}
.wm-orig {
  font-size: 12.5px;
  color: var(--fr-ink, #26232c);
}
.wm-sel {
  background: #fce4ec;
  border-bottom: 2px solid #b92252;
  padding: 0 2px;
}
.wm-trans {
  margin-top: 5px !important;
  padding-left: 9px;
  border-left: 2.5px solid #b92252;
  font-size: 12.5px;
  color: #a61c48;
  font-weight: 550;
}
.wm-popover {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 7px;
  border: 1px solid #efcbd7;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11.5px;
  box-shadow: 0 4px 12px rgba(185, 34, 82, 0.08);
}
.wm-popover strong {
  color: #a61c48;
}
.wm-meta {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.wm-meta-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.wm-meta-row strong {
  font-size: 12.5px;
}
.wm-go {
  margin-top: auto;
  align-self: flex-start;
}

.kb-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
  margin-bottom: 14px;
}
.kb-tabs {
  margin-bottom: 0;
}
.kb-note {
  font-size: 11.5px;
  color: var(--fr-muted, #6b6872);
}
.kb-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 7px;
  border-top: 1px solid #f0eef4;
  font-size: 12px;
}
.kb-desc {
  color: var(--fr-muted, #6b6872);
  text-align: right;
}

.ap-sample-box {
  border: 1px solid var(--fr-line, #e7e7eb);
  border-radius: 10px;
  padding: 16px;
  background: #ffffff;
  margin-bottom: 14px;
}
.ap-orig {
  font-size: 13.5px;
  color: var(--fr-ink, #26232c);
  line-height: 1.7;
}
.ap-trans {
  margin-top: 10px !important;
  font-size: 13.5px;
  line-height: 1.7;
  transition: filter 0.2s ease, opacity 0.2s ease;
}
.ap-style-quote {
  padding-left: 12px;
  border-left: 3px solid #b92252;
  color: #a61c48;
}
.ap-style-highlight {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 6px;
  background: #fef3c7;
  color: #26232c;
}
.ap-style-card {
  padding: 10px 13px;
  border-radius: 8px;
  border: 1px solid #efcbd7;
  background: #fff9fb;
  color: #7c1738;
}
.ap-style-blur {
  padding: 8px 12px;
  border-radius: 7px;
  background: #f4f3f6;
  color: #26232c;
  filter: blur(5px);
  cursor: pointer;
}
.ap-style-blur:hover,
.ap-style-blur:focus {
  filter: none;
}
.ap-desc {
  margin-top: 10px !important;
  padding-top: 10px;
  border-top: 1px solid #f0eef4;
}

@container (max-width: 640px) {
  .wm-stage {
    grid-template-columns: minmax(0, 1fr);
  }
  .kb-list li {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .kb-desc {
    text-align: left;
  }
}
</style>

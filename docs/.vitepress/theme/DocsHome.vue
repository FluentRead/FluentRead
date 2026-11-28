<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'
import DocDiagram from './diagrams/DocDiagram.vue'

const { lang } = useData()
const en = computed(() => lang.value.startsWith('en'))
const t = (zh: string, english: string) => (en.value ? english : zh)
const link = (path: string) => withBase((en.value ? '/en' : '') + path)

interface GuideLinkItem {
  title: string
  desc: string
  path: string
}

interface GuideGroup {
  id: string
  title: string
  summary: string
  items: GuideLinkItem[]
}

const onboardingSteps = computed(() => [
  {
    num: '1',
    title: t('安装并固定图标', 'Install & pin'),
    desc: t('支持 Chrome、Edge、Firefox 及离线 ZIP 包', 'Chrome, Edge, Firefox, or offline ZIP'),
    path: '/guide/getting-started',
  },
  {
    num: '2',
    title: t('翻译第一篇网页', 'Translate your first page'),
    desc: t('默认免费翻译池开箱即用，支持双语对照与局部翻译', 'Bilingual reading out of the box with free pool & section mode'),
    path: '/guide/webpage-translation',
  },
  {
    num: '3',
    title: t('按场景接入服务', 'Assign your providers'),
    desc: t('为网页、划词、文档与字幕分别配置 AI 或本地模型', 'Pick AI, cloud APIs, or offline models per feature'),
    path: '/config/translation-engines',
  },
])

const groups = computed<GuideGroup[]>(() => [
  {
    id: 'webpage',
    title: t('网页与日常翻译', 'Webpage & daily reading'),
    summary: t('浏览外语文章、文档、评论与表单输入的核心工作流', 'Core workflows for articles, docs, comments, and input fields'),
    items: [
      { title: t('全文与局部翻译', 'Page & section translation'), desc: t('双语对照、仅译文、学术论文与局部区域记忆', 'Bilingual / translation-only, papers & remembered sections'), path: '/guide/webpage-translation' },
      { title: t('划词翻译', 'Selection translation'), desc: t('选区翻译卡、多源语音朗读、词典与 AI 讲解', 'Cards, multi-source TTS, dictionaries & AI explanations'), path: '/guide/deepseek-harness' },
      { title: t('悬浮段落翻译', 'Hover translation'), desc: t('鼠标指向段落按 Control 即时翻译或恢复', 'Hover any paragraph and press Control to toggle'), path: '/guide/hover-translation' },
      { title: t('输入框翻译', 'Input translation'), desc: t('在聊天与邮件框三连按或快捷键生成译文', 'Translate drafts in input boxes without auto-sending'), path: '/guide/input-translation' },
      { title: t('翻译中心与侧边栏', 'Translation Center & sidebar'), desc: t('同一段文本多服务并行对比与侧边栏速译', 'Compare multiple providers side by side or in sidebar'), path: '/guide/translation-center' },
      { title: t('智能高亮', 'Smart Highlighting'), desc: t('本机关键词与意外度标色，辅助长文扫读', 'On-device keyword & surprisal highlights for skimming'), path: '/guide/information-highlight' },
    ],
  },
  {
    id: 'media',
    title: t('图片、文档与视频', 'Images, documents & video'),
    summary: t('处理非纯文本网页内容：漫画、截图、PDF/EPUB 与在线视频', 'Beyond plain web text: comics, screenshots, PDFs & captions'),
    items: [
      { title: t('图片与漫画翻译', 'Image & manga translation'), desc: t('本地 PaddleOCR / LaMa 擦字排版与漫画连续预译', 'Local OCR, background inpainting & continuous manga'), path: '/guide/image-translation' },
      { title: t('圈选翻译', 'Area translation'), desc: t('Shift+Z 框选图表、海报或暂停视频画面识别', 'Crop any screen area with Vision AI or local OCR'), path: '/guide/area-translation' },
      { title: t('文档翻译', 'Document translation'), desc: t('PDF 原版/重排双视图、扫描 OCR、批注与 14 种格式导出', 'PDF dual views, OCR, annotations & 14 export formats'), path: '/guide/document-translation' },
      { title: t('视频与会议字幕', 'Video & meeting captions'), desc: t('YouTube/B站/课程/会议双语字幕与本地 Whisper 转写', 'Native captions, web meetings & local Whisper/Qwen3 ASR'), path: '/guide/video-subtitles' },
    ],
  },
  {
    id: 'learning',
    title: t('学习与表达', 'Learning & expression'),
    summary: t('从读懂外语到沉淀词句、解析长难句与辅助回复写作', 'Turn reading into vocabulary retention, grammar insight & writing'),
    items: [
      { title: t('学习中心与词书', 'Learning center'), desc: t('收藏词句、阅读材料、间隔复习与新网页再次遇见', 'Vocabulary, materials, spaced review & re-encounter'), path: '/guide/vocabulary-book' },
      { title: t('词典与学习卡', 'Dictionaries & study cards'), desc: t('MDict/StarDict/DSL/Yomitan 离线词典与 Anki 导出', 'Offline dictionaries, custom JSON APIs & Anki export'), path: '/guide/dictionaries' },
      { title: t('词性与句法', 'Sentence structure'), desc: t('可视化拆解句子主干、成分与词性作用', 'Visual breakdown of clause roles and parts of speech'), path: '/guide/sentence-analysis' },
      { title: t('双语分享卡片', 'Bilingual share cards'), desc: t('本机排版生成精美双语摘录图片保存分享', 'Generate clean bilingual quote images locally'), path: '/guide/share-cards' },
      { title: t('写作助手', 'Writing assistant'), desc: t('在 Gmail 与 GitHub 旁起草、润色并插入回复', 'Draft, polish, and insert replies in Gmail & GitHub'), path: '/guide/writing-assistant' },
    ],
  },
  {
    id: 'providers',
    title: t('翻译服务与隐私', 'Providers & privacy'),
    summary: t('配置免费池、云 API、AI 模型与本机离线方案，掌控数据去向', 'Configure free pools, cloud APIs, AI & local models safely'),
    items: [
      { title: t('翻译服务与模型配置', 'Translation providers'), desc: t('选型指南、AI 精翻、组合回退、多 Key 轮换与兼容接口', 'Selection guide, AI context, combo fallback & custom APIs'), path: '/config/translation-engines' },
      { title: t('浏览器内置翻译', 'Built-in browser translation'), desc: t('Chrome 138+ / Edge 148+ 设备端离线翻译准备', 'On-device Translator API setup for Chrome & Edge'), path: '/guide/chrome-translator' },
      { title: t('翻译隐私防护', 'Translation privacy shield'), desc: t('本机自动脱敏还原或发现敏感信息时阻止发送', 'Local PII redaction/restore or request blocking'), path: '/config/privacy-protection' },
      { title: t('ChatGPT 套餐接入状态', 'ChatGPT plan availability'), desc: t('说明当前公开版本的 ChatGPT 登录接入状态', 'Current availability of Sign in with ChatGPT'), path: '/config/chatgpt-plan' },
    ],
  },
  {
    id: 'customization',
    title: t('个性化与网站规则', 'Customization & site rules'),
    summary: t('打造契合阅读习惯的译文视觉、快捷键、专业术语与专站规则', 'Tailor translation styles, shortcuts, glossaries & site rules'),
    items: [
      { title: t('设置中心概览', 'Settings overview'), desc: t('全局总开关、不翻译语言、菜单栏布局与请求限速', 'Global switches, excluded languages, layout & rate limits'), path: '/config/' },
      { title: t('译文外观与阅读辅助', 'Appearance & reading aids'), desc: t('译文样式预设、自定义 CSS 与双语逐句高亮', 'Presets, custom CSS & sentence-by-sentence highlight'), path: '/config/appearance' },
      { title: t('快捷键与触发方式', 'Shortcuts & triggers'), desc: t('全功能快捷键速查、两点选取、段落复制与独立方案', 'Shortcut cheat sheet, two-point selection & profiles'), path: '/guide/custom-hotkey' },
      { title: t('术语库', 'Glossaries'), desc: t('统一专有名词译法、保留原文拼写与文档术语提取', 'Consistent terminology, keep-original rules & extraction'), path: '/guide/glossary' },
      { title: t('网站阅读范围与偏好', 'Site rules & reading area'), desc: t('解决漏译，配置始终翻译、仅译文或禁用扩展', 'Fix missed content, auto-translate, or disable per site'), path: '/config/site-adaptation' },
      { title: t('自定义网站正文规则', 'Custom site rules'), desc: t('编写与调试选择器规则、补充识别与限定范围', 'Author and preview custom CSS selector content rules'), path: '/guide/custom-site-rules' },
    ],
  },
  {
    id: 'sync',
    title: t('备份、同步与统计', 'Data, sync & analytics'),
    summary: t('跨设备迁移配置、撤回误操作以及监控翻译速度与 Token 用量', 'Migrate settings across devices, undo changes & monitor usage'),
    items: [
      { title: t('备份与同步', 'Backup & sync'), desc: t('本地完整备份、6 小时自动快照与 Google Drive 同步', 'Local backups, 6h snapshots & Google Drive sync'), path: '/config/backup-sync' },
      { title: t('WebDAV 云备份', 'WebDAV cloud backup'), desc: t('坚果云、Koofr、群晖 NAS 与 Nextcloud 配置步骤', 'Setup steps for Nutstore, Koofr, Synology & Nextcloud'), path: '/guide/webdav' },
      { title: t('翻译统计', 'Translation statistics'), desc: t('查看请求成功率、P95 耗时、缓存复用与免费线路表现', 'Success rates, P95 latency, cache hits & free routes'), path: '/guide/translation-stats' },
      { title: t('模型用量', 'AI model usage'), desc: t('追踪各 AI 服务的输入/输出 Token 与生成速度', 'Track input/output tokens and generation speed'), path: '/guide/model-usage' },
    ],
  },
  {
    id: 'platforms',
    title: t('安装环境与更多平台', 'Installation & more platforms'),
    summary: t('离线安装包、手机浏览器、油猴脚本、邮件与文献管理工具', 'Offline packages, mobile, userscripts, Thunderbird & Zotero'),
    items: [
      { title: t('功能全景', 'Feature overview'), desc: t('按使用目的快速浏览全部核心功能入口', 'Browse all core capabilities organized by goal'), path: '/guide/features' },
      { title: t('离线下载与安装', 'Offline installation'), desc: t('商店无法访问时手动安装与安全升级官方 ZIP', 'Manual ZIP installation and safe upgrades'), path: '/guide/offline-install' },
      { title: t('移动端与 Safari', 'Mobile & Safari'), desc: t('Android Edge/Firefox、Via 及 Safari 原生开发预览', 'Android Edge/Firefox, Via & Safari native preview'), path: '/guide/mobile-safari' },
      { title: t('油猴脚本', 'Userscript'), desc: t('在 Tampermonkey、Violentmonkey、Via 与 Safari 使用', 'Run core webpage translation in script managers'), path: '/guide/userscript' },
      { title: t('Thunderbird 邮件翻译', 'Thunderbird email'), desc: t('独立邮件客户端扩展，一键对照阅读外语邮件', 'Translate email bodies inside Thunderbird 140+'), path: '/guide/thunderbird' },
      { title: t('Zotero 文献翻译', 'Zotero literature'), desc: t('实验性 Zotero 插件，生成双语 PDF 附件与笔记', 'Experimental Zotero plugin for bilingual PDFs & notes'), path: '/guide/zotero' },
    ],
  },
])
</script>

<template>
  <div class="fr-docs">
    <div class="fr-docs-intro">
      <p class="fr-docs-eyebrow">{{ t('流畅阅读 · 官方使用文档', 'FluentRead · Official Documentation') }}</p>
      <h1>{{ t('使用文档', 'Documentation') }}</h1>
      <p>
        {{
          t(
            '按阅读任务与场景组织的完整操作指南，涵盖网页、文档、图片、视频翻译、语言学习与隐私配置。',
            'Task-oriented guides covering webpage, document, image, and video translation, language learning, and privacy controls.'
          )
        }}
      </p>
    </div>

    <section class="fr-docs-start" aria-labelledby="fr-start-title">
      <div class="fr-docs-start-top">
        <div>
          <h2 id="fr-start-title">{{ t('3 分钟快速上手', 'Get started in 3 minutes') }}</h2>
          <p>
            {{
              t(
                '安装插件、固定工具栏图标、选择目标语言，无需注册账号即可翻译第一篇网页。',
                'Install and pin the extension, pick your target language, and translate your first page—no account required.'
              )
            }}
          </p>
        </div>
        <a class="bv-button bv-primary" :href="link('/guide/getting-started')">
          {{ t('查看快速开始', 'Open quick start') }} →
        </a>
      </div>
      <div class="fr-docs-steps">
        <a v-for="s in onboardingSteps" :key="s.num" class="fr-docs-step-card" :href="link(s.path)">
          <span class="fr-docs-step-num">{{ s.num }}</span>
          <div>
            <strong>{{ s.title }}</strong>
            <small>{{ s.desc }}</small>
          </div>
        </a>
      </div>
    </section>

    <DocDiagram kind="ecosystem-map" :en="en" />

    <h2>{{ t('全部指南目录', 'Browse all guides') }}</h2>
    <div class="fr-docs-directory">
      <section v-for="group in groups" :key="group.id" class="fr-docs-group">
        <h3 :id="en ? group.title.toLowerCase().replace(/[^a-z]+/g, '-') : group.title">
          {{ group.title }}
        </h3>
        <p class="fr-docs-group-summary">{{ group.summary }}</p>
        <div class="fr-docs-links">
          <a v-for="item in group.items" :key="item.path" :href="link(item.path)">
            <span class="fr-docs-link-copy">
              <strong>{{ item.title }}</strong>
              <small>{{ item.desc }}</small>
            </span>
            <span class="fr-docs-link-arrow" aria-hidden="true">→</span>
          </a>
        </div>
      </section>
    </div>

    <div class="fr-docs-bottom-grid">
      <section class="fr-docs-help">
        <h2>{{ t('帮助与隐私', 'Help & privacy') }}</h2>
        <p>{{ t('遇到漏译、服务报错或想了解数据去向时，从这里快速排查。', 'Troubleshoot issues or review exactly how FluentRead handles data.') }}</p>
        <div class="fr-docs-help-links">
          <a :href="link('/guide/faq')">{{ t('常见问题与排查', 'Questions & troubleshooting') }} →</a>
          <a :href="link('/guide/privacy')">{{ t('数据与隐私政策', 'Data & privacy policy') }} →</a>
          <a :href="link('/guide/support')">{{ t('赞助与支持', 'Sponsorship & support') }} →</a>
        </div>
      </section>
      <section class="fr-docs-help">
        <h2>{{ t('设计与贡献', 'Design & contribution') }}</h2>
        <p>{{ t('查看视觉规范与真实组件，在不同主题和尺寸下体验界面交互。', 'Explore visual guidelines and real components across themes and screen sizes.') }}</p>
        <div class="fr-docs-help-links">
          <a :href="link('/guide/design-system')">{{ t('设计系统与组件预览', 'Design system & component previews') }} →</a>
          <a :href="link('/guide/chatgpt-application')">{{ t('维护者：ChatGPT 接入申请', 'Maintainers: ChatGPT application') }} →</a>
        </div>
      </section>
    </div>
  </div>
</template>

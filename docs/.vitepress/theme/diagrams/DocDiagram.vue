<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import CoreReadingDiagrams from './CoreReadingDiagrams.vue'
import MediaWorkDiagrams from './MediaWorkDiagrams.vue'
import ProviderPrivacyDiagrams from './ProviderPrivacyDiagrams.vue'
import LearningSyncDiagrams from './LearningSyncDiagrams.vue'

export type DiagramKind =
  | 'ecosystem-map'
  | 'webpage-modes'
  | 'shortcuts-board'
  | 'appearance-styles'
  | 'image-pipeline'
  | 'document-workflow'
  | 'video-matrix'
  | 'provider-routing'
  | 'privacy-shield'
  | 'site-rules-priority'
  | 'learning-loop'
  | 'backup-sync-compare'
  | 'platform-matrix'

const props = defineProps<{
  kind: DiagramKind
  en?: boolean
}>()

const { lang } = useData()
const english = computed(() => props.en ?? lang.value.startsWith('en'))
const t = (zh: string, en: string) => (english.value ? en : zh)

const meta = computed(() => {
  const map: Record<DiagramKind, { title: string; badge: string; foot: string }> = {
    'ecosystem-map': {
      title: t('流畅阅读能力全景图', 'FluentRead Capability Map'),
      badge: t('结构示意 · 可点击跳转', 'Interactive map'),
      foot: t('点击任意功能卡片即可直达对应操作指南。', 'Click any capability pill to jump straight to its guide.'),
    },
    'webpage-modes': {
      title: t('四种网页翻译方式对比', '4 Ways to Translate a Webpage'),
      badge: t('交互示意', 'Interactive schematic'),
      foot: t('点击上方标签对比触发方式、翻译范围与适用场景。', 'Switch tabs above to compare triggers, scope, and ideal use cases.'),
    },
    'shortcuts-board': {
      title: t('核心快捷键速查图', 'Keyboard Shortcuts Cheat Sheet'),
      badge: t('支持系统切换', 'OS switchable'),
      foot: t('除浏览器命令外，其余快捷键均可在扩展设置中自定义或关闭。', 'Customize or disable extension shortcuts anytime in Settings.'),
    },
    'appearance-styles': {
      title: t('译文样式实时预览与两种高亮对比', 'Translation Style Preview & Highlighting Comparison'),
      badge: t('可交互体验', 'Interactive preview'),
      foot: t('切换上方按钮预览典型样式；选择「模糊遮罩」后将鼠标移上或聚焦译文即可揭开。', 'Switch presets above to preview; hover or focus the blurred sample to reveal it.'),
    },
    'image-pipeline': {
      title: t('图片与漫画本地识别翻译管线', 'Local Image & Manga Pipeline'),
      badge: t('本地 OCR + 修补', 'On-device OCR & inpainting'),
      foot: t('文字识别与背景修补均在本机浏览器完成，仅识别后的文字交由所选翻译服务处理。', 'OCR and background inpainting run locally; only recognized text goes to your translation provider.'),
    },
    'document-workflow': {
      title: t('文档支持格式与 PDF 双阅读模式', 'Supported Document Formats & PDF Modes'),
      badge: t('交互对比', 'Interactive schematic'),
      foot: t('文件全程在本机浏览器解析，仅待译文本发送至所选服务；支持随时暂停、校订与导出。', 'Files are parsed locally in your browser; pause, edit, and export anytime.'),
    },
    'video-matrix': {
      title: t('视频与会议字幕工作模式与平台支持', 'Video & Meeting Caption Modes & Matrix'),
      badge: t('能力矩阵', 'Capability matrix'),
      foot: t('有原生字幕时优先直译；无字幕且可读取音轨时可在本机启动 Whisper 或 Qwen3 ASR。', 'Uses native captions when available; supports local Whisper or Qwen3 ASR where audio is readable.'),
    },
    'provider-routing': {
      title: t('翻译服务选型与按功能路由示意', 'Provider Selection & Per-Feature Routing'),
      badge: t('架构示意', 'Interactive schematic'),
      foot: t('编辑服务目录不会自动更改默认服务；可为网页、划词、文档与字幕分别指定最合适的引擎。', 'Editing credentials does not change your default provider; assign engines independently per feature.'),
    },
    'privacy-shield': {
      title: t('翻译隐私防护：本地脱敏与阻断流程', 'Translation Privacy Shield: Redact vs. Block'),
      badge: t('本地零上传演示', 'Interactive flow'),
      foot: t('此为本地交互示意，不发起真实网络请求。防护覆盖统一翻译链路中的文字内容。', 'Local illustration only — no network requests are made. Applies to unified text translation requests.'),
    },
    'site-rules-priority': {
      title: t('网站规则优先级与正文适配作用域', 'Site Rule Priority & Content Scope'),
      badge: t('优先级图解', 'Interactive schematic'),
      foot: t('规则从上到下判定；常规自动翻译与禁用只需配置「网站偏好」，无需手写选择器。', 'Evaluated top to bottom. Use Site Preferences for everyday auto-translate or disable toggles.'),
    },
    'learning-loop': {
      title: t('语言学习闭环与四大栏目职责', 'Learning Loop & 4-Tab Data Model'),
      badge: t('流程与数据图', 'Workflow & data model'),
      foot: t('打开学习页或浏览收藏不会自动调用 AI，也不会修改掌握度；隐私窗口不写入记录。', 'Viewing saved items never calls AI or changes mastery; private windows do not save history.'),
    },
    'backup-sync-compare': {
      title: t('备份、快照与云同步范围对照表', 'Backup, Snapshot & Cloud Sync Scope'),
      badge: t('安全边界对照', 'Scope & safety matrix'),
      foot: t('云备份始终由你手动触发，默认只同步不含密钥的基础配置（v2）。', 'Cloud backups are always manual and default to Basic settings (v2) without API keys.'),
    },
    'platform-matrix': {
      title: t('多平台版本能力矩阵', 'Cross-Platform Capability Matrix'),
      badge: t('平台对照', 'Platform matrix'),
      foot: t('桌面浏览器扩展具备最完整的本地模型、图片、文档与视频字幕能力。', 'Desktop browser extensions offer the full local-AI, image, document, and video feature set.'),
    },
  }
  return map[props.kind]
})

const isCore = computed(() =>
  ['ecosystem-map', 'webpage-modes', 'shortcuts-board', 'appearance-styles'].includes(props.kind)
)
const isMedia = computed(() =>
  ['image-pipeline', 'document-workflow', 'video-matrix'].includes(props.kind)
)
const isProvider = computed(() =>
  ['provider-routing', 'privacy-shield', 'site-rules-priority'].includes(props.kind)
)
</script>

<template>
  <figure class="fr-dg" :data-diagram="kind">
    <div class="fr-dg-head">
      <span class="fr-dg-title">
        <span class="fr-dg-dot" aria-hidden="true"></span>
        <span>{{ meta.title }}</span>
      </span>
      <span class="fr-dg-badge">{{ meta.badge }}</span>
    </div>
    <div class="fr-dg-body">
      <CoreReadingDiagrams
        v-if="isCore"
        :kind="kind as 'ecosystem-map' | 'webpage-modes' | 'shortcuts-board' | 'appearance-styles'"
        :en="english"
      />
      <MediaWorkDiagrams
        v-else-if="isMedia"
        :kind="kind as 'image-pipeline' | 'document-workflow' | 'video-matrix'"
        :en="english"
      />
      <ProviderPrivacyDiagrams
        v-else-if="isProvider"
        :kind="kind as 'provider-routing' | 'privacy-shield' | 'site-rules-priority'"
        :en="english"
      />
      <LearningSyncDiagrams
        v-else
        :kind="kind as 'learning-loop' | 'backup-sync-compare' | 'platform-matrix'"
        :en="english"
      />
    </div>
    <figcaption class="fr-dg-foot">{{ meta.foot }}</figcaption>
  </figure>
</template>

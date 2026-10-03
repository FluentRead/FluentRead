<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'
const { lang } = useData()
const en = computed(() => lang.value.startsWith('en'))
const t = (zh: string, english: string) => (en.value ? english : zh)
const link = (path: string) => withBase(`${en.value ? '/en' : ''}${path}`)
const groups = computed(() => [
  {
    title: t('网页翻译', 'Webpage translation'),
    items: [
      [
        t('全文与局部翻译', 'Full-page & section translation'),
        t(
          '整篇文章或选定区域，双语对照、仅译文与恢复原文。',
          'A whole page or a selected section. Read bilingually, show only translations, or restore the original.'
        ),
        '/guide/webpage-translation',
      ],
      [
        t('划词与 AI 讲解', 'Selection & AI explanations'),
        t(
          '选中一句，查看译文、词典、句法和用法。',
          'Select a sentence for translation, dictionary lookup, structure, and usage.'
        ),
        '/guide/deepseek-harness',
      ],
      [
        t('悬浮段落翻译', 'Hover translation'),
        t(
          '鼠标停在段落上，按 Control 即可翻译。',
          'Hover over a paragraph and press Control to translate it.'
        ),
        '/guide/hover-translation',
      ],
      [
        t('输入框翻译', 'Input translation'),
        t(
          '替换输入文字，或保留原文追加译文。',
          'Replace your input or append a translation while keeping the original.'
        ),
        '/guide/input-translation',
      ],
    ],
  },
  {
    title: t('图片、文档与视频', 'Images, documents & video'),
    items: [
      [
        t('图片翻译', 'Image translation'),
        t(
          '识别图片文字，在原图上查看译文。',
          'Recognize text in an image and view translated text over it.'
        ),
        '/guide/image-translation',
      ],
      [
        t('圈选翻译', 'Area translation'),
        t(
          '圈出网页上的一块画面，识别并翻译。',
          'Select an area of a webpage to recognize and translate its text.'
        ),
        '/guide/area-translation',
      ],
      [
        t('文档翻译', 'Document translation'),
        t(
          '导入、批量翻译、校订与下载文件。',
          'Import, translate in batches, edit, and download files.'
        ),
        '/guide/document-translation',
      ],
      [
        t('视频与会议字幕', 'Video & meeting captions'),
        t(
          '支持平台、字幕来源、显示方式与排查。',
          'Supported platforms, caption sources, display modes, and troubleshooting.'
        ),
        '/guide/video-subtitles',
      ],
    ],
  },
  {
    title: t('学习与表达', 'Learning & expression'),
    items: [
      [
        t('学习中心', 'Learning center'),
        t(
          '收藏词句，结合原句学用法，再安排复习。',
          'Save expressions, learn from their original context, and review.'
        ),
        '/guide/vocabulary-book',
      ],
      [
        t('句法讲解', 'Sentence structure'),
        t(
          '双行片段直接展示句中作用与词性。',
          'See sentence roles and parts of speech below each phrase.'
        ),
        '/guide/sentence-analysis',
      ],
      [
        t('双语分享卡片', 'Bilingual share cards'),
        t('把读到的好句子排成高清图片。', 'Turn a sentence you love into a high-resolution image.'),
        '/guide/share-cards',
      ],
      [
        t('写作助手', 'Writing assistant'),
        t('在 Gmail、GitHub 中起草或完善回复。', 'Draft or improve replies in Gmail and GitHub.'),
        '/guide/writing-assistant',
      ],
    ],
  },
  {
    title: t('服务与设置', 'Providers & settings'),
    items: [
      [
        t('选择翻译服务', 'Choose a provider'),
        t('免费翻译、AI、DeepL 与本地模型。', 'Free translation, AI, DeepL, and local models.'),
        '/config/translation-engines',
      ],
      [
        t('外观与阅读辅助', 'Appearance & reading aids'),
        t(
          '译文样式、逐句高亮、主题与菜单布局。',
          'Translation styles, sentence highlighting, themes, and menu layouts.'
        ),
        '/config/appearance',
      ],
      [
        t('快捷键与触发方式', 'Shortcuts & triggers'),
        t('把操作调整成适合自己的方式。', 'Make everyday translation actions work your way.'),
        '/guide/custom-hotkey',
      ],
      [
        t('备份与同步', 'Backup & sync'),
        t(
          '本地备份、设置历史和可选配置同步。',
          'Local backups, settings history, and optional configuration sync.'
        ),
        '/config/backup-sync',
      ],
    ],
  },
])
</script>

<template>
  <div class="fr-docs">
    <div class="fr-docs-intro">
      <p class="fr-eyebrow">FluentRead / {{ t('使用文档', 'DOCUMENTATION') }}</p>
      <h1>
        {{
          t('从第一次翻译，到读得更明白。', 'From your first translation to deeper understanding.')
        }}
      </h1>
      <p>
        {{
          t(
            '按你正在做的事找指南。先安装，再翻译一篇文章；更多功能，等需要时再了解。',
            'Find a guide for the task in front of you. Install FluentRead, translate an article, and explore more when you need it.'
          )
        }}
      </p>
      <div class="fr-actions">
        <a class="fr-button fr-primary" :href="link('/guide/getting-started')">{{
          t('安装与第一次翻译', 'Your first translation')
        }}</a
        ><a class="fr-button fr-secondary" :href="link('/guide/faq')">{{
          t('遇到问题', 'Troubleshooting')
        }}</a>
      </div>
    </div>
    <section v-for="group in groups" :key="group.title" class="fr-docs-group">
      <h2 :id="en ? group.title.toLowerCase().replaceAll(/[^a-z]+/g, '-') : group.title">
        {{ group.title }}
      </h2>
      <div class="fr-docs-grid">
        <a v-for="item in group.items" :key="item[2]" :href="link(item[2])"
          ><strong>{{ item[0] }}</strong>
          <p>{{ item[1] }}</p></a
        >
      </div>
    </section>
    <div class="fr-docs-callout">
      <strong>{{
        t(
          '免费服务可以直接开始，AI 功能按需连接。',
          'Start with free services. Connect AI when you need it.'
        )
      }}</strong>
      <p>
        {{
          t(
            '云端翻译会把待译内容发送给你选择的服务。账号、额度与计费由服务商决定。',
            'Cloud translation sends your text to the provider you choose. Accounts, quotas, and charges depend on that provider.'
          )
        }}
        <a :href="link('/guide/privacy')">{{
          t('了解数据与隐私', 'Read about data and privacy')
        }}</a>
      </p>
    </div>
  </div>
</template>

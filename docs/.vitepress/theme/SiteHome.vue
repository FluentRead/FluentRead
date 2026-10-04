<script setup lang="ts">
import { withBase } from 'vitepress'
import FeatureDemo from './FeatureDemo.vue'
import HeroOrbit from './HeroOrbit.vue'
import BrowserInstall from './BrowserInstall.vue'
import brandTaglines from '../../../src/core/i18n/messages/brand-taglines.json'
const props = defineProps<{ en?: boolean }>()
const t = (zh: string, english: string) => (props.en ? english : zh)
const link = (path: string) => withBase((props.en ? '/en' : '') + path)
const features = [
  {
    kind: 'webpage',
    title: t('网页双语翻译', 'Bilingual webpage translation'),
    description: t(
      '在文章、资讯和社交动态的原文下方显示译文，保留网页排版，方便对照阅读。',
      'Read articles, news and social posts with translations below the original text, keeping the page layout intact.'
    ),
    path: '/guide/webpage-translation',
  },
  {
    kind: 'selection',
    title: t('划词翻译', 'Selection translation'),
    description: t(
      '选中文字即可查看译文并朗读原文或译文，还可通过卡片查音标、释义，理解句子结构。',
      'Translate selected text and listen to both languages, with cards for word definitions, pronunciation and sentence structure.'
    ),
    path: '/guide/deepseek-harness',
  },
  {
    kind: 'document',
    title: t('文档翻译', 'Document translation'),
    description: t(
      '导入 PDF、ePub 或 Word 文件，对照阅读原文与译文，并可校订、下载翻译结果。',
      'Import PDF, ePub or Word files to read alongside their translations, then edit or download the results.'
    ),
    path: '/guide/document-translation',
  },
  {
    kind: 'image',
    title: t('图片与漫画翻译', 'Image & comic translation'),
    description: t(
      '识别图片和漫画中的文字，在原图上显示译文，保留画面与阅读顺序。',
      'Read translated text directly on images and comic panels while keeping the artwork and reading order.'
    ),
    path: '/guide/image-translation',
  },
  {
    kind: 'video',
    title: t('视频与会议翻译', 'Video & meeting translation'),
    description: t(
      '为视频和网页会议添加双语字幕，观看或交流时同步查看原文与译文。',
      'Follow videos and web meetings with bilingual captions that show the original text and translation together.'
    ),
    path: '/guide/video-subtitles',
  },
] as const
const faqs = [
  [
    t('免费开源', 'Free and open source'),
    t(
      '流畅阅读是一款免费的开源插件，安装后即可使用，无需注册流畅阅读账户。内置免费翻译服务可直接使用；连接其他服务时，账户、费用与额度以相应服务商的要求为准。',
      'FluentRead is free and open source, and you do not need a FluentRead account. Built-in free translation services are ready to use; other providers may require an account and apply their own fees and usage limits.'
    ),
    '/config/translation-engines',
    t('选择翻译服务', 'Choose a provider'),
  ],
  [
    t('浏览器兼容性', 'Browser compatibility'),
    t(
      'Chrome、Edge、Firefox 可从官方商店安装。脚本版与手机浏览器的能力和入口有所不同，安装指南中有具体说明。',
      'Install from the Chrome, Edge, or Firefox store. The installation guide explains userscript and mobile availability.'
    ),
    '/guide/getting-started',
    t('查看安装指南', 'Installation guide'),
  ],
  [
    t('翻译服务选择', 'Translation providers'),
    t(
      '可以连接 DeepSeek、OpenAI、Gemini 等服务，或使用本地 Ollama；不同功能可以独立选择服务。',
      'Connect DeepSeek, OpenAI, Gemini, or local Ollama. Each feature can use its own provider.'
    ),
    '/config/translation-engines',
    t('查看连接方法', 'Connection guide'),
  ],
  [
    t('数据处理与隐私', 'Data and privacy'),
    t(
      '使用云端翻译时，待译文字发送给你选择的服务。设置与学习记录保存在浏览器中；图片、文件和可选同步的具体范围见隐私政策。',
      'Cloud translation sends text to your selected provider. Settings and learning records stay in your browser. See the privacy policy for images, files, and optional sync.'
    ),
    '/guide/privacy',
    t('数据与隐私', 'Data & privacy'),
  ],
]
</script>
<template>
  <div class="bv-site product-home">
    <section class="bv-hero" :class="{ 'bv-hero-en': en }" aria-labelledby="fr-title">
      <HeroOrbit :en="en" />
      <div class="bv-hero-copy">
        <img
          class="bv-hero-icon"
          :src="withBase('/brand-icon.webp')"
          width="64"
          height="64"
          alt=""
        />
        <h1 id="fr-title" class="bv-hero-slogan product-tagline" :lang="en ? 'en' : 'zh-CN'">
          <span class="bv-slogan-line"
            ><span>{{ t('让语言更近', 'Closer languages') }}</span
            ><span class="bv-slogan-punctuation">{{ t('，', '. ') }}</span></span
          >
          <span class="bv-slogan-line"
            ><span>{{ t('让世界更大', 'A bigger world') }}</span
            ><span class="bv-slogan-punctuation">{{ t('。', '.') }}</span></span
          >
        </h1>
        <p class="bv-hero-intro">
          <span
            ><span class="bv-hero-name">{{ t('流畅阅读', 'FluentRead') }}</span
            >{{
              t(
                '，一款开源的浏览器双语翻译插件',
                ' is an open-source browser extension for bilingual translation.'
              )
            }}</span
          >
          <span v-if="!en" class="bv-hero-capabilities"
            ><span
              v-for="(capability, index) in [
                '双语翻译',
                '划词翻译',
                '文档翻译',
                '图片/漫画翻译',
                '视频翻译',
              ]"
              :key="capability"
              >{{ index === 0 ? '支持' : '' }}{{ capability }}{{ index === 4 ? '。' : '、' }}</span
            ></span
          >
          <span v-else
            >Translate webpages, selected text, documents, images and comics, and video
            captions.</span
          >
        </p>
        <BrowserInstall :en="en" show-docs />
      </div>
    </section>
    <section class="bv-section bv-promo" aria-labelledby="bv-promo-title">
      <span class="bv-section-number">{{ t('56 秒介绍', 'A 56-SECOND TOUR') }}</span>
      <h2 id="bv-promo-title">{{ t('先看一遍，再往下读', 'Watch first, then read on') }}</h2>
      <div v-if="!en" class="bv-promo-video bv-promo-embed">
        <iframe
          src="https://player.bilibili.com/player.html?bvid=BV1VLHE6hEnB&p=1&autoplay=0&danmaku=0&poster=1"
          title="流畅阅读 56 秒介绍视频（哔哩哔哩）"
          loading="lazy"
          allow="fullscreen; picture-in-picture; encrypted-media"
          allowfullscreen
        ></iframe>
      </div>
      <video
        v-else
        class="bv-promo-video"
        controls
        playsinline
        preload="none"
        width="1920"
        height="1080"
        :poster="withBase('/videos/fluentread-promo-en-poster.webp')"
        aria-label="FluentRead 56-second introduction video"
      >
        <source :src="withBase('/videos/fluentread-promo-en.mp4')" type="video/mp4" />
        <a :href="withBase('/videos/fluentread-promo-en.mp4')">Download the introduction video</a>
      </video>
      <a
        v-if="!en"
        class="bv-text-link bv-promo-link"
        href="https://www.bilibili.com/video/BV1VLHE6hEnB/"
        target="_blank"
        rel="noopener noreferrer"
        >在 B 站观看 <span aria-hidden="true">↗</span></a
      >
    </section>
    <section
      v-for="feature in features"
      :key="feature.kind"
      :id="feature.kind === 'webpage' ? 'features' : `feature-${feature.kind}`"
      class="bv-section bv-feature-row"
      :class="{ 'bv-translation-section': feature.kind === 'webpage' }"
      :data-feature="feature.kind"
      :aria-labelledby="`bv-${feature.kind}-title`"
    >
      <div class="bv-feature-copy">
        <h2 :id="`bv-${feature.kind}-title`">{{ feature.title }}</h2>
        <p>{{ feature.description }}</p>
        <div
          v-if="feature.kind === 'video'"
          class="bv-video-platforms"
          :aria-label="t('支持的视频与会议平台', 'Supported video and meeting platforms')"
        >
          <span>YouTube</span><span>X</span><span>Google Meet</span><span>Teams</span
          ><span>Zoom</span>
        </div>
        <small v-if="feature.kind === 'video'">{{
          t(
            '会议翻译适用于已开启且可读取字幕的网页会议。',
            'Meeting translation requires a web client with accessible captions enabled.'
          )
        }}</small>
        <a class="bv-text-link" :href="link(feature.path)"
          >{{ t('使用指南', 'Read the guide') }} <span aria-hidden="true">→</span></a
        >
      </div>
      <FeatureDemo :kind="feature.kind" :en="en" />
    </section>
    <section class="bv-section bv-faq">
      <div>
        <span class="bv-section-number">{{ t('使用须知', 'GETTING STARTED') }}</span>
        <h2>{{ t('常见问题', 'Common questions') }}</h2>
        <a class="bv-text-link" :href="link('/guide/faq')">{{ t('更多帮助', 'More help') }} →</a>
      </div>
      <div>
        <details v-for="faq in faqs" :key="faq[0]">
          <summary>{{ faq[0] }}</summary>
          <p>
            {{ faq[1] }}<a :href="link(faq[2])">{{ faq[3] }} →</a>
          </p>
        </details>
      </div>
    </section>
    <footer class="bv-footer">
      <div class="bv-footer-brand">
        <img
          :src="withBase('/brand-icon.webp')"
          width="32"
          height="32"
          alt=""
          loading="lazy"
        /><strong>{{ t('流畅阅读', 'FluentRead') }}</strong>
      </div>
      <div>
        <a :href="link('/docs/')">{{ t('使用指南', 'User guide') }}</a
        ><a :href="link('/guide/privacy')">{{ t('隐私政策', 'Privacy policy') }}</a
        ><a href="https://github.com/FluentRead/FluentRead">GitHub</a
        ><a href="https://github.com/FluentRead/FluentRead#support">{{
          t('支持项目', 'Support the project')
        }}</a>
      </div>
      <small>{{ en ? brandTaglines['en-US'] : brandTaglines['zh-CN'] }} · GPL-3.0</small>
    </footer>
  </div>
</template>

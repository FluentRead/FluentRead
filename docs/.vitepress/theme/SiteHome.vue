<script setup lang="ts">
import { withBase } from 'vitepress'
import TranslationDemo from './TranslationDemo.vue'
import GrammarDemo from './GrammarDemo.vue'
import brandTaglines from '../../../src/core/i18n/messages/brand-taglines.json'
const props = defineProps<{ en?: boolean }>()
const t = (zh: string, en: string) => (props.en ? en : zh)
const link = (path: string) => withBase(`${props.en ? '/en' : ''}${path}`)
const chrome = 'https://chromewebstore.google.com/detail/djnlaiohfaaifbibleebjggkghlmcpcj'
const formats = [
  {
    mark: 'Aa',
    title: t('图片与圈选', 'Images & areas'),
    description: t(
      '图片里的文字选不中？识别文字，在原图上看译文，或圈出需要的一块。',
      'Read text inside images, view translations over the image, or select just the area you need.'
    ),
    path: '/guide/image-translation',
    meta: t('OCR 文字识别', 'OCR text recognition'),
  },
  {
    mark: '▤',
    title: t('文档与电子书', 'Documents & books'),
    description: t(
      '导入 PDF、ePub、Word 等文件，双语阅读、校订译文，再下载结果。',
      'Import PDF, ePub, Word and more. Read in two languages, edit translations, and download your results.'
    ),
    path: '/guide/document-translation',
    meta: 'PDF · ePub · DOCX',
  },
  {
    mark: '↔',
    title: t('输入与写作', 'Translate & write'),
    description: t(
      '让输入框里的内容换一种语言，或在 Gmail、GitHub 中起草更自然的回复。',
      'Translate what you type, or draft a natural reply in Gmail and GitHub.'
    ),
    path: '/guide/input-translation',
    meta: t('输入框翻译 · 写作助手', 'Input translation · writing assistant'),
  },
]
const faqs = [
  [
    t('需要付费或注册账号吗？', 'Do I need an account or a subscription?'),
    t(
      'FluentRead 开源免费。安装后可使用免费翻译服务，无需注册 FluentRead 账号。AI 讲解及部分服务需要你自己的服务连接，服务商可能单独收费。',
      'FluentRead is free and open source. Start with free translation services without a FluentRead account. AI explanations and some providers require your own connection; provider fees may apply.'
    ),
  ],
  [
    t('可以使用哪些浏览器？', 'Which browsers can I use?'),
    t(
      'Chrome、Edge、Firefox 提供扩展安装入口。使用脚本管理器的浏览器可尝试油猴版；移动端及脚本版的能力差异见安装指南。',
      'Install the extension in Chrome, Edge, or Firefox. A userscript is available for compatible script managers. See the installation guide for mobile and userscript limitations.'
    ),
  ],
  [
    t('我能用自己的 AI 服务吗？', 'Can I use my own AI provider?'),
    t(
      '可以。连接 DeepSeek、OpenAI、Gemini 等兼容服务，或使用本地 Ollama。不同功能可以选择不同的服务与模型。',
      'Yes. Connect compatible services such as DeepSeek, OpenAI, and Gemini, or local Ollama. Choose a different service and model for each feature.'
    ),
  ],
  [
    t('网页和文件会发送到哪里？', 'Where does my content go?'),
    t(
      '云端翻译会将待译文字发给所选服务。配置和学习记录保存在浏览器中；图片识别、文档与可选同步的具体范围见隐私政策。',
      'Cloud translation sends the text to your selected provider. Settings and learning records stay in your browser. The privacy policy explains images, documents, and optional sync.'
    ),
  ],
]
</script>

<template>
  <div class="fr-site product-home">
    <section class="fr-hero" aria-labelledby="fr-title">
      <div class="fr-hero-copy">
        <p class="fr-eyebrow">
          FluentRead · {{ t('开源浏览器双语翻译插件', 'OPEN-SOURCE BROWSER TRANSLATION') }}
        </p>
        <h1 id="fr-title" class="product-tagline">{{ brandTaglines[en ? 'en-US' : 'zh-CN'] }}</h1>
        <p class="fr-hero-intro">
          {{
            t(
              '在原网页里对照阅读，选中一句深入理解。把文章、图片、文档与视频，变成你看得懂的内容。',
              'Read webpages in two languages. Select a sentence to understand it better. Make articles, images, documents, and videos part of your world.'
            )
          }}
        </p>
        <div class="fr-actions">
          <a
            class="fr-button fr-primary"
            :href="chrome"
            target="_blank"
            rel="noopener noreferrer"
            >{{ t('添加到 Chrome', 'Add to Chrome') }}</a
          ><a class="fr-button fr-secondary" :href="link('/docs/')">{{
            t('开始使用', 'Get started')
          }}</a>
        </div>
        <p class="fr-install-note">
          {{ t('开源免费 · 无需 FluentRead 账号', 'Free & open source · no FluentRead account')
          }}<a :href="link('/guide/getting-started')">{{ t('其他浏览器', 'Other browsers') }}</a>
        </p>
        <div class="fr-hero-facts">
          <span>{{ t('网页双语对照', 'Bilingual webpages') }}</span
          ><span>{{ t('划词与 AI 讲解', 'Selection & AI explanations') }}</span
          ><span>{{ t('使用自己的服务', 'Bring your own provider') }}</span>
        </div>
      </div>
      <div class="fr-hero-demo"><TranslationDemo :en="en" /></div>
    </section>

    <div class="fr-browser-strip">
      <span>{{ t('在你的浏览器里，继续探索', 'Keep exploring in your browser') }}</span
      ><a :href="chrome">Chrome</a
      ><a href="https://microsoftedge.microsoft.com/addons/detail/kakgmllfpjldjhcnkghpplmlbnmcoflp"
        >Edge</a
      ><a href="https://addons.mozilla.org/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/"
        >Firefox</a
      ><a :href="link('/guide/userscript')">{{ t('油猴脚本', 'Userscript') }}</a
      ><span class="fr-browser-license">GPL-3.0</span>
    </div>

    <section id="features" class="fr-section fr-reading">
      <div class="fr-section-heading">
        <p class="fr-eyebrow">01 / {{ t('从看懂开始', 'READ WITH CONFIDENCE') }}</p>
        <h2>
          {{ t('整篇读，或只读你需要的那一句。', 'A whole page. Or just the sentence you need.') }}
        </h2>
        <p>
          {{
            t(
              '原文与译文紧密对应。全文翻译、悬浮段落与划词翻译，顺着你的阅读习惯来。',
              'Keep the original and translation together. Translate a full page, hover over a paragraph, or select a sentence.'
            )
          }}
        </p>
      </div>
      <div class="fr-reading-options">
        <a :href="link('/guide/webpage-translation')"
          ><span>01</span>
          <h3>{{ t('全文双语翻译', 'Bilingual page translation') }}</h3>
          <p>
            {{
              t(
                '按阅读位置逐步显示译文，想回到原文时，随时恢复。',
                'Translations follow your reading position. Restore the original whenever you like.'
              )
            }}
          </p></a
        ><a :href="link('/guide/hover-translation')"
          ><span>02</span>
          <h3>{{ t('悬浮段落翻译', 'Hover translation') }}</h3>
          <p>
            {{
              t(
                '鼠标停在段落上，按 Control。只翻译眼前这一段。',
                'Hover over a paragraph and press Control. Translate just what you are reading.'
              )
            }}
          </p></a
        ><a :href="link('/guide/deepseek-harness')"
          ><span>03</span>
          <h3>{{ t('选中即查', 'Select and understand') }}</h3>
          <p>
            {{
              t(
                '看意思、听朗读、查单词。需要深入理解时，再打开 AI 讲解。',
                'See the meaning, listen, and look up words. Open AI explanations when you want more.'
              )
            }}
          </p></a
        >
      </div>
    </section>

    <section class="fr-section fr-story">
      <div class="fr-story-copy">
        <p class="fr-eyebrow">02 / {{ t('理解之后，学会表达', 'GO BEYOND THE TRANSLATION') }}</p>
        <h2>{{ t('一句话，也可以学得更深。', 'One sentence. A deeper understanding.') }}</h2>
        <p>
          {{
            t(
              '划词卡片把译文、词典与学习放在一起。读懂语气、拆解句子、学习用法，再用自己的话试一试。',
              'Translation, dictionary, and learning in one selection card. Explore tone, sentence structure, and usage. Then try it in your own words.'
            )
          }}
        </p>
        <ul class="fr-feature-list">
          <li>
            {{
              t('常见英文词典，无需 AI 也能查词', 'Common English dictionary entries without AI')
            }}
          </li>
          <li>{{ t('按需讲解与连续追问', 'On-demand explanations and follow-up questions') }}</li>
          <li>
            {{ t('收藏词句，回到学习中心复习', 'Save words and sentences for later review') }}
          </li>
        </ul>
        <a class="fr-text-link" :href="link('/guide/deepseek-harness')">{{
          t('了解划词翻译', 'Explore selection translation')
        }}</a>
        <p class="fr-small">
          {{
            t(
              'AI 讲解使用你配置的服务，点击学习动作后才生成。',
              'AI explanations use your configured provider and start when you choose an action.'
            )
          }}
        </p>
      </div>
      <TranslationDemo :en="en" variant="card" />
    </section>

    <section class="fr-section fr-grammar-story">
      <div class="fr-section-heading">
        <p class="fr-eyebrow">
          {{ t('看清结构，理解更轻松', 'SEE THE STRUCTURE, UNDERSTAND THE SENTENCE') }}
        </p>
        <h2>{{ t('句子拆开，意思就清楚了。', 'Break it down. Let the meaning come through.') }}</h2>
        <p>
          {{
            t(
              '主语、谓语、修饰关系直接标在原句下面。不必来回猜，点开每个片段，就能进一步理解。',
              'See the subject, verb, and modifiers directly below the original words. Choose a phrase to explore its role and meaning.'
            )
          }}
        </p>
      </div>
      <GrammarDemo :en="en" /><a
        class="fr-text-link"
        :href="
          link(
            '/guide/deepseek-harness#' + (en ? 'optional-ai-explanations' : '按需使用-ai-深入讲解')
          )
        "
        >{{ t('学习如何使用句法讲解', 'Learn how to use grammar explanations') }}</a
      >
    </section>

    <section class="fr-section fr-story fr-story-reverse">
      <TranslationDemo :en="en" variant="subtitles" />
      <div class="fr-story-copy">
        <p class="fr-eyebrow">03 / {{ t('看见更大的世界', 'FOLLOW THE CONVERSATION') }}</p>
        <h2>{{ t('精彩内容，不必隔着语言看。', 'Let the story come through.') }}</h2>
        <p>
          {{
            t(
              '在 YouTube、X 等支持的平台对照看字幕，也能在网页会议中翻译可用字幕。保留原话，跟上内容。',
              'Read bilingual subtitles on supported platforms including YouTube and X, and translate available captions in browser meetings. Keep the original words in view.'
            )
          }}
        </p>
        <ul class="fr-feature-list">
          <li>
            {{
              t(
                '双语、仅译文与仅原文自由切换',
                'Switch between bilingual, translation, and original'
              )
            }}
          </li>
          <li>
            {{
              t('字幕样式与翻译服务按需调整', 'Choose your subtitle style and translation provider')
            }}
          </li>
          <li>
            {{
              t(
                '支持场景和字幕来源，文档里说清楚',
                'Clear guidance on supported platforms and caption sources'
              )
            }}
          </li>
        </ul>
        <a class="fr-text-link" :href="link('/guide/video-subtitles')">{{
          t('查看字幕使用指南', 'Read the subtitle guide')
        }}</a>
      </div>
    </section>

    <section class="fr-section fr-formats">
      <div class="fr-section-heading">
        <p class="fr-eyebrow">{{ t('不止网页', 'BEYOND WEBPAGES') }}</p>
        <h2>
          {{ t('你想看的内容，都有合适的入口。', 'A way in for the content you care about.') }}
        </h2>
      </div>
      <div class="fr-format-grid">
        <a v-for="item in formats" :key="item.path" :href="link(item.path)"
          ><span class="fr-format-mark" aria-hidden="true">{{ item.mark }}</span>
          <p class="fr-format-meta">{{ item.meta }}</p>
          <h3>{{ item.title }}</h3>
          <p>{{ item.description }}</p>
          <span class="fr-text-link">{{ t('阅读指南', 'Read the guide') }}</span></a
        >
      </div>
    </section>

    <section class="fr-section fr-control">
      <div>
        <p class="fr-eyebrow">{{ t('按你的习惯来', 'MAKE IT YOURS') }}</p>
        <h2>{{ t('服务、外观、数据。选择在你。', 'Your providers. Your style. Your data.') }}</h2>
        <p>
          {{
            t(
              '免费服务可以直接开始。需要时，再连接自己的 AI、DeepL 或本地模型。各功能独立选服务，译文样式与网站规则也能调整。',
              'Start with free services. Connect your own AI, DeepL, or local model when you need it. Choose providers per feature and customize translation styles and site rules.'
            )
          }}
        </p>
        <div class="fr-provider-names">
          <span>DeepSeek</span><span>OpenAI</span><span>Gemini</span><span>DeepL</span
          ><span>Ollama</span>
        </div>
        <a class="fr-text-link" :href="link('/config/translation-engines')">{{
          t('选择适合你的翻译服务', 'Choose your translation provider')
        }}</a>
      </div>
      <div class="fr-control-notes">
        <div>
          <h3>{{ t('开源透明', 'Open and transparent') }}</h3>
          <p>
            {{
              t(
                '代码公开，GPL-3.0 授权。可以查看实现，也可以参与改进。',
                'Public source code under GPL-3.0. Inspect the code or help improve it.'
              )
            }}
          </p>
        </div>
        <div>
          <h3>{{ t('数据去向清楚', 'Know where your data goes') }}</h3>
          <p>
            {{
              t(
                '设置与学习记录在浏览器中。云端翻译发送给所选服务，可选同步单独开启。',
                'Settings and learning records stay in your browser. Cloud translation uses your chosen provider; sync is optional.'
              )
            }}
          </p>
          <a :href="link('/guide/privacy')">{{ t('隐私政策', 'Privacy policy') }}</a>
        </div>
        <div>
          <h3>{{ t('从免费开始', 'Start for free') }}</h3>
          <p>
            {{
              t(
                '第三方服务可能需要账号、密钥或额度，其费用由服务商收取。',
                'Third-party providers may require an account, a key, or credits, and can charge their own fees.'
              )
            }}
          </p>
        </div>
      </div>
    </section>

    <section class="fr-section fr-start">
      <div class="fr-section-heading">
        <p class="fr-eyebrow">{{ t('第一次使用', 'YOUR FIRST TRANSLATION') }}</p>
        <h2>{{ t('三步，让理解发生。', 'Three steps to understanding.') }}</h2>
      </div>
      <div class="fr-start-layout">
        <ol class="fr-start-steps">
          <li>
            <span>1</span>
            <h3>{{ t('安装并固定插件', 'Install and pin') }}</h3>
            <p>
              {{
                t(
                  '从浏览器商店安装，固定到工具栏。',
                  'Install from your browser store and pin to the toolbar.'
                )
              }}
            </p>
          </li>
          <li>
            <span>2</span>
            <h3>{{ t('选择目标语言', 'Choose your language') }}</h3>
            <p>
              {{
                t(
                  '打开普通网页，确认语言与翻译服务。',
                  'Open a regular webpage and confirm the language and provider.'
                )
              }}
            </p>
          </li>
          <li>
            <span>3</span>
            <h3>{{ t('点击翻译页面', 'Translate the page') }}</h3>
            <p>
              {{
                t(
                  '开始双语阅读，也可以随时恢复原文。',
                  'Start reading bilingually and restore the original at any time.'
                )
              }}
            </p>
          </li>
        </ol>
        <figure class="fr-install-shot">
          <a
            :href="withBase('/screenshots/ui/' + (en ? 'en-US' : 'zh-CN') + '/popup.webp')"
            target="_blank"
            rel="noopener noreferrer"
            ><img
              :src="withBase('/screenshots/ui/' + (en ? 'en-US' : 'zh-CN') + '/popup.webp')"
              :width="en ? 760 : 640"
              :height="en ? 984 : 874"
              :alt="
                t(
                  'FluentRead 当前扩展菜单：语言、服务、网页翻译与常用入口',
                  'Current FluentRead menu: languages, providers, page translation and everyday tools'
                )
              "
              loading="lazy"
              decoding="async"
          /></a>
          <figcaption>
            {{
              t(
                '真实扩展界面 · 点击查看高清图',
                'Actual extension interface · open for full resolution'
              )
            }}
          </figcaption>
        </figure>
      </div>
      <a class="fr-button fr-secondary" :href="link('/guide/getting-started')">{{
        t('查看完整安装指南', 'Full installation guide')
      }}</a>
    </section>

    <section class="fr-section fr-faq">
      <div>
        <p class="fr-eyebrow">{{ t('开始前，你可能想知道', 'BEFORE YOU START') }}</p>
        <h2>{{ t('常见问题', 'Common questions') }}</h2>
        <a class="fr-text-link" :href="link('/guide/faq')">{{ t('更多帮助', 'More help') }}</a>
      </div>
      <div>
        <details v-for="(faq, index) in faqs" :key="faq[0]" :open="index === 0">
          <summary>{{ faq[0] }}</summary>
          <p>{{ faq[1] }}</p>
        </details>
      </div>
    </section>

    <section class="fr-end">
      <img :src="withBase('/logo.webp')" width="64" height="64" alt="" loading="lazy" />
      <p class="fr-eyebrow">FluentRead</p>
      <h2>
        {{ t('下一篇好内容，读得更明白。', 'Make your next discovery easier to understand.') }}
      </h2>
      <div class="fr-actions">
        <a class="fr-button fr-primary" :href="chrome" target="_blank" rel="noopener noreferrer">{{
          t('添加到 Chrome', 'Add to Chrome')
        }}</a
        ><a class="fr-button fr-secondary" :href="link('/docs/')">{{
          t('打开使用文档', 'Open documentation')
        }}</a>
      </div>
    </section>
    <footer class="fr-footer">
      <div>
        <strong>FluentRead</strong>
        <p>{{ brandTaglines[en ? 'en-US' : 'zh-CN'] }}</p>
      </div>
      <div>
        <a :href="link('/docs/')">{{ t('使用文档', 'Documentation') }}</a
        ><a :href="link('/guide/privacy')">{{ t('隐私政策', 'Privacy') }}</a
        ><a href="https://github.com/FluentRead/FluentRead">GitHub</a
        ><a href="https://github.com/FluentRead/FluentRead#support">{{
          t('支持项目', 'Support')
        }}</a>
      </div>
      <small>© FluentRead · GPL-3.0</small>
    </footer>
  </div>
</template>

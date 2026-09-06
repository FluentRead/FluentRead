<script setup lang="ts">
import { withBase } from 'vitepress'
const chrome =
  'https://chromewebstore.google.com/detail/djnlaiohfaaifbibleebjggkghlmcpcj'
</script>

<template>
  <div class="product-home">
    <section class="product-hero" aria-labelledby="product-title">
      <img
        class="product-hero-icon"
        :src="withBase('/product-icon.png')"
        width="896"
        height="880"
        alt=""
        fetchpriority="high"
      />
      <p class="product-eyebrow">FluentRead · 流畅阅读</p>
      <h1 id="product-title">
        外语？<br class="mobile-break" /><span>照样读。</span>
      </h1>
      <p class="product-intro">
        刷到一篇好文章，别被外语劝退。<br />全文对照着读，难句随手翻，喜欢的表达顺便收下。
      </p>
      <div class="product-actions">
        <a
          class="product-button primary"
          :href="chrome"
          target="_blank"
          rel="noopener noreferrer"
          >添加到 Chrome <span aria-hidden="true">↗</span></a
        >
        <a
          class="product-button secondary"
          :href="withBase('/guide/getting-started#安装')"
          >其他浏览器 <span aria-hidden="true">→</span></a
        >
      </div>
      <p class="product-foundation">
        <a href="https://github.com/FluentRead/FluentRead"
          >开源 · GPL-3.0 <span aria-hidden="true">↗</span></a
        >
        <a :href="withBase('/guide/deepseek-harness')"
          >接入 DeepSeek Harness 会话内核 <span aria-hidden="true">→</span></a
        >
      </p>
      <figure class="product-main-shot">
        <a
          :href="withBase('/screenshots/translation.webp')"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="查看双语阅读的高清截图（新标签页）"
        >
          <img
            :src="withBase('/screenshots/translation.webp')"
            :srcset="`${withBase(
              '/screenshots/translation-small.webp'
            )} 1280w, ${withBase('/screenshots/translation.webp')} 2560w`"
            sizes="(max-width: 760px) calc(100vw - 40px), min(1104px, 92vw)"
            width="2560"
            height="1600"
            alt="FluentRead 在文章每个英文段落下显示中文译文，原文和译文可对照阅读"
            fetchpriority="high"
          />
        </a>
        <figcaption>
          <span>原文在上，译文在下。刚好一起看。</span
          ><a :href="withBase('/guide/getting-started')"
            >这就试试 <span aria-hidden="true">→</span></a
          >
        </figcaption>
      </figure>
    </section>

    <section class="product-story" aria-labelledby="reading-title">
      <div class="product-story-copy">
        <p class="product-eyebrow">整篇读</p>
        <h2 id="reading-title">长文章，<br />一段一段读。</h2>
        <p>
          新闻、帖子、论文，打开就接着读。译文跟在原文旁边，人名、术语和细节，一眼就能对照。看完想收起译文？恢复原文就好。
        </p>
        <a
          class="product-text-link"
          :href="withBase('/guide/features#页面翻译')"
          >了解双语阅读 <span aria-hidden="true">→</span></a
        >
      </div>
      <div class="product-rhythm">
        <div>
          <span>01</span>
          <h3>打开你想读的网页</h3>
          <p>新闻、博客、文档，接着原来的阅读。</p>
        </div>
        <div>
          <span>02</span>
          <h3>点击“翻译页面”</h3>
          <p>选择目标语言，原文与译文对照显示。</p>
        </div>
        <div>
          <span>03</span>
          <h3>按自己的节奏读</h3>
          <p>整篇读、逐段看，或随时恢复原文。</p>
        </div>
      </div>
    </section>

    <section
      class="product-story selection-story"
      aria-labelledby="selection-title"
    >
      <figure class="product-detail-shot">
        <a
          :href="withBase('/screenshots/reading-card-detail.webp')"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="查看 AI 翻译卡的高清截图（新标签页）"
          ><img
            :src="withBase('/screenshots/reading-card-detail.webp')"
            width="840"
            height="1140"
            loading="lazy"
            decoding="async"
            alt="FluentRead 翻译卡解释选中句子的含义与表达用法，并提供继续追问入口"
        /></a>
        <figcaption>解释原意，学个表达，还可以接着问。</figcaption>
      </figure>
      <div class="product-story-copy">
        <p class="product-eyebrow">翻译卡 × DeepSeek Harness</p>
        <h2 id="selection-title">这句话，<br />再讲讲。</h2>
        <p>
          意思大概懂了，但还是想知道“为什么这样说”？选中它，让翻译卡拆拆长句、讲讲用法。遇到喜欢的词句，收进学习中心，下次试着自己用。
        </p>
        <p>
          翻译卡接入 DeepSeek Harness
          会话内核的浏览器适配。围绕选中的原文，结合当前段落继续追问，用你选的
          AI 模型，把这句话聊明白。
        </p>
        <p class="product-subnote">
          翻译卡的讲解与练习需要配置 AI 服务，点击动作后才开始生成。
        </p>
        <a class="product-text-link" :href="withBase('/guide/deepseek-harness')"
          >看看翻译卡能做什么 <span aria-hidden="true">→</span></a
        >
      </div>
    </section>

    <section class="product-more" aria-labelledby="more-title">
      <p class="product-eyebrow">还有这些</p>
      <h2 id="more-title">图片、文件、视频，也能翻。</h2>
      <div class="product-use-cases">
        <a :href="withBase('/guide/image-translation')"
          ><span class="product-case-type">图片与圈选</span>
          <h3>图片里的字，圈一下 <span aria-hidden="true">↗</span></h3>
          <p>翻译网页图片，或圈出一小块文字，查看可复制的译文。</p></a
        >
        <a :href="withBase('/guide/document-translation')"
          ><span class="product-case-type">本地文档</span>
          <h3>文件放进来，慢慢读 <span aria-hidden="true">↗</span></h3>
          <p>
            打开 PDF、ePub 或 Word 等文件，对照阅读、校订译文，再下载保存。
          </p></a
        >
        <a :href="withBase('/guide/video-subtitles')"
          ><span class="product-case-type">视频字幕</span>
          <h3>看视频，带上双语字幕 <span aria-hidden="true">↗</span></h3>
          <p>在 YouTube 和 X 阅读双语字幕，按自己的习惯调整显示。</p></a
        >
      </div>
    </section>

    <section
      class="product-story product-control"
      aria-labelledby="control-title"
    >
      <div class="product-story-copy">
        <p class="product-eyebrow">按你的习惯来</p>
        <h2 id="control-title">怎么顺手，<br />怎么来。</h2>
        <p>
          常看的站点自动翻，不常用的按钮藏起来。译文换个样式，菜单挪个位置，调成自己用着舒服的样子。
        </p>
        <p>
          先用现成的免费翻译服务；有自己的偏好，再连接 DeepL、AI 服务或本地
          Ollama 模型。
        </p>
        <a
          class="product-text-link"
          :href="withBase('/config/translation-engines')"
          >选择翻译服务 <span aria-hidden="true">→</span></a
        >
        <p class="product-subnote">
          第三方服务可能需要账号、密钥或额度。云端翻译会将待译内容发送给所选服务。<a
            :href="withBase('/guide/privacy')"
            >了解数据与隐私</a
          >
        </p>
      </div>
      <figure class="product-popup-shot">
        <a
          :href="withBase('/screenshots/popup.webp')"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="查看扩展菜单的高清截图（新标签页）"
          ><img
            :src="withBase('/screenshots/popup.webp')"
            width="720"
            height="1120"
            loading="lazy"
            decoding="async"
            alt="FluentRead 扩展菜单：目标语言、翻译服务与常用功能入口"
        /></a>
      </figure>
    </section>

    <section class="product-open" aria-labelledby="open-title">
      <div>
        <p class="product-eyebrow">开源 · GPL-3.0</p>
        <h2 id="open-title">代码也给你，随便逛逛。</h2>
        <p>
          想看看怎么做的，想改个小地方，或者刚好有个点子，都欢迎。FluentRead
          的代码公开在 GitHub，一起把外语阅读做得更顺手。
        </p>
      </div>
      <a
        class="product-button secondary"
        href="https://github.com/FluentRead/FluentRead"
        >去 GitHub 看看 <span aria-hidden="true">↗</span></a
      >
    </section>

    <section class="product-end" aria-labelledby="start-title">
      <p class="product-eyebrow">已经想好要读什么了？</p>
      <h2 id="start-title">打开那一页，试试看。</h2>
      <div class="product-actions">
        <a
          class="product-button primary"
          :href="withBase('/guide/getting-started#安装')"
          >安装 FluentRead <span aria-hidden="true">→</span></a
        ><a class="product-button secondary" :href="withBase('/guide/')"
          >打开使用指南</a
        >
      </div>
      <a class="product-help-link" :href="withBase('/guide/faq')"
        >已经安装，遇到了一点问题？</a
      >
    </section>
  </div>
</template>

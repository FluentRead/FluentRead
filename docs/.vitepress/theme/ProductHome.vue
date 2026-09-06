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
      <p class="product-eyebrow">开源双语阅读与翻译扩展</p>
      <h1 id="product-title">
        FluentRead <span class="product-name-local">流畅阅读</span>
      </h1>
      <p class="product-intro">
        支持网页双语对照、划词翻译、AI 阅读辅助，以及图片、文档和视频字幕翻译。
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
          <span>网页中的原文与译文对照。</span
          ><a :href="withBase('/guide/getting-started')"
            >安装指南 <span aria-hidden="true">→</span></a
          >
        </figcaption>
      </figure>
    </section>

    <section class="product-story" aria-labelledby="reading-title">
      <div class="product-story-copy">
        <p class="product-eyebrow">网页阅读</p>
        <h2 id="reading-title">网页双语对照</h2>
        <p>
          在原网页中显示原文和译文，保留段落的对应关系。支持全文翻译、悬浮翻译和划词翻译，可随时恢复原文。
        </p>
        <a
          class="product-text-link"
          :href="withBase('/guide/features#页面翻译')"
          >网页翻译指南 <span aria-hidden="true">→</span></a
        >
      </div>
      <div class="product-rhythm">
        <div>
          <span>01</span>
          <h3>打开网页</h3>
          <p>在浏览器中打开需要阅读的网页。</p>
        </div>
        <div>
          <span>02</span>
          <h3>选择目标语言</h3>
          <p>选择目标语言，源语言默认自动检测。</p>
        </div>
        <div>
          <span>03</span>
          <h3>翻译与阅读</h3>
          <p>在页面中对照阅读原文与译文，或恢复原文。</p>
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
        <figcaption>选中文字的上下文讲解与连续追问。</figcaption>
      </figure>
      <div class="product-story-copy">
        <p class="product-eyebrow">DeepSeek Harness</p>
        <h2 id="selection-title">AI 翻译卡</h2>
        <p>
          解释选中文字的含义、分析句子结构、说明表达用法并提供练习，支持连续追问与词句收藏。
        </p>
        <p>
          翻译卡接入 DeepSeek Harness
          会话内核的浏览器适配，连接当前选区、允许参考的段落和阅读记录。可选择已配置的
          AI 服务与模型。
        </p>
        <p class="product-subnote">
          翻译卡的讲解与练习需要配置 AI 服务，点击动作后才开始生成。
        </p>
        <a class="product-text-link" :href="withBase('/guide/deepseek-harness')"
          >翻译卡使用指南 <span aria-hidden="true">→</span></a
        >
      </div>
    </section>

    <section class="product-more" aria-labelledby="more-title">
      <p class="product-eyebrow">翻译格式</p>
      <h2 id="more-title">图片、文档与视频字幕</h2>
      <div class="product-use-cases">
        <a :href="withBase('/guide/image-translation')"
          ><span class="product-case-type">图片与圈选</span>
          <h3>图片与圈选翻译 <span aria-hidden="true">↗</span></h3>
          <p>识别网页图片或选定区域中的文字，并显示可复制的译文。</p></a
        >
        <a :href="withBase('/guide/document-translation')"
          ><span class="product-case-type">本地文档</span>
          <h3>文档翻译 <span aria-hidden="true">↗</span></h3>
          <p>
            导入 PDF、ePub、Word 等文件，支持双语阅读、译文校订与文件导出。
          </p></a
        >
        <a :href="withBase('/guide/video-subtitles')"
          ><span class="product-case-type">视频字幕</span>
          <h3>双语字幕 <span aria-hidden="true">↗</span></h3>
          <p>在 YouTube 和 X 显示双语字幕，支持调整字幕样式。</p></a
        >
      </div>
    </section>

    <section
      class="product-story product-control"
      aria-labelledby="control-title"
    >
      <div class="product-story-copy">
        <p class="product-eyebrow">配置</p>
        <h2 id="control-title">翻译服务与阅读设置</h2>
        <p>按网站设置自动翻译规则，调整译文样式、快捷键和菜单栏布局。</p>
        <p>可使用免费翻译服务，连接 DeepL、AI 服务，或使用本地 Ollama 模型。</p>
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
        <p class="product-eyebrow">开源与贡献</p>
        <h2 id="open-title">GPL-3.0 开源项目</h2>
        <p>
          源代码公开托管于 GitHub。欢迎通过 Issue 反馈问题，并通过 Pull Request
          改进代码、文档、界面翻译与网站适配。
        </p>
      </div>
      <a
        class="product-button secondary"
        href="https://github.com/FluentRead/FluentRead"
        >查看 GitHub 源码 <span aria-hidden="true">↗</span></a
      >
    </section>

    <section class="product-end" aria-labelledby="start-title">
      <p class="product-eyebrow">Chrome · Edge · Firefox</p>
      <h2 id="start-title">安装与使用</h2>
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
        >帮助与常见问题</a
      >
    </section>
  </div>
</template>

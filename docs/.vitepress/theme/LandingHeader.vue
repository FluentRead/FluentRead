<script setup lang="ts">
import { withBase } from 'vitepress'
defineProps<{ en?: boolean; languageLink: string }>()
</script>
<template>
  <a class="bv-home-skip" href="#VPContent">{{ en ? 'Skip to content' : '跳到正文' }}</a>
  <header class="bv-home-header">
    <nav :aria-label="en ? 'Main navigation' : '主导航'">
      <a
        class="bv-home-brand"
        :href="withBase(en ? '/en/' : '/')"
        :aria-label="en ? 'FluentRead' : '流畅阅读'"
        ><img :src="withBase('/brand-icon.webp')" width="38" height="38" alt="" />
        <span class="bv-home-brand-text"
          ><strong :lang="en ? 'en' : 'zh-CN'">{{ en ? 'FluentRead' : '流畅阅读' }}</strong></span
        ></a
      >
      <div class="bv-home-links">
        <a class="bv-home-features" :href="withBase((en ? '/en/' : '/') + '#features')">{{
          en ? 'Features' : '功能'
        }}</a>
        <a :href="withBase((en ? '/en' : '') + '/docs/')">{{ en ? 'Docs' : '使用文档' }}</a>
        <a
          href="https://github.com/FluentRead/FluentRead"
          aria-label="GitHub"
          target="_blank"
          rel="noopener noreferrer"
          ><svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1.01.07 1.54 1.03 1.54 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.64-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.26-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.39.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
            /></svg
        ></a>
        <a
          class="bv-home-language bv-language"
          :href="languageLink"
          :hreflang="en ? 'zh-CN' : 'en'"
          :aria-label="en ? '切换到简体中文' : 'Switch to English'"
          >{{ en ? '中文' : 'EN' }}</a
        >
      </div>
    </nav>
  </header>
</template>

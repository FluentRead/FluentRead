<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useData, useRoute, withBase } from 'vitepress'
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import LandingHeader from './LandingHeader.vue'
const route = useRoute()
const { lang, page } = useData()
const english = computed(() => lang.value.startsWith('en'))
const landing = computed(() => /^(en\/)?index\.md$/.test(page.value.relativePath))
// Headings differ between languages. Keep the corresponding page, without carrying its hash.
const languageLink = computed(() => {
  if (page.value.isNotFound) return withBase(english.value ? '/' : '/en/')
  const path = page.value.relativePath
    .replace(/^en\//, '')
    .replace(/(^|\/)index\.md$/, '$1')
    .replace(/\.md$/, '')
  return withBase((english.value ? '/' : '/en/') + path)
})
let revision = 0
async function revealAnchor() {
  const current = ++revision
  await nextTick()
  if (current !== revision || !location.hash) return
  let id: string
  try {
    id = decodeURIComponent(location.hash.slice(1))
  } catch {
    return
  }
  const target = document.getElementById(id)
  if (!target) return
  const parents: HTMLDetailsElement[] = []
  let ancestor = target.parentElement
  while (ancestor) {
    if (ancestor instanceof HTMLDetailsElement) parents.push(ancestor)
    ancestor = ancestor.parentElement
  }
  if (!parents.length) return
  parents.forEach((details) => {
    details.open = true
  })
  await nextTick()
  if (current === revision) target.scrollIntoView({ block: 'start' })
}
onMounted(() => {
  window.addEventListener('hashchange', revealAnchor)
  void revealAnchor()
})
const stop = watch(() => route.path, revealAnchor, { flush: 'post' })
onBeforeUnmount(() => {
  revision++
  stop()
  window.removeEventListener('hashchange', revealAnchor)
})
</script>
<template>
  <div v-if="landing" class="bv-home-shell">
    <LandingHeader :en="english" :language-link="languageLink" />
    <main id="VPContent"><Content /></main>
  </div>
  <DefaultTheme.Layout v-else>
    <template #nav-bar-title-after>
      <span class="bv-home-brand-text">
        <strong :lang="english ? 'en' : 'zh-CN'">{{ english ? 'FluentRead' : '流畅阅读' }}</strong>
      </span>
    </template>
    <template #nav-bar-content-after>
      <a
        class="bv-language"
        :href="languageLink"
        :aria-label="english ? '切换到简体中文' : 'Switch to English'"
        :hreflang="english ? 'zh-CN' : 'en'"
      >
        {{ english ? '中文' : 'EN' }}
      </a>
    </template>
  </DefaultTheme.Layout>
</template>

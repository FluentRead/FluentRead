<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
defineProps<{ en?: boolean }>()
const root = ref<HTMLElement | null>(null)
const active = ref(false)
let visible = false
let observer: IntersectionObserver | undefined
function sync() {
  active.value = visible && !document.hidden
}
onMounted(() => {
  observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    sync()
  })
  if (root.value) observer.observe(root.value)
  document.addEventListener('visibilitychange', sync)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  document.removeEventListener('visibilitychange', sync)
})
</script>
<template>
  <div ref="root" class="bv-hero-orbit" :data-active="active" aria-hidden="true">
    <div class="bv-orbit-card bv-orbit-page">
      <div class="bv-orbit-window"><i></i><i></i><i></i></div>
      <p>Stay curious.</p>
      <p class="bv-orbit-translation">保持好奇。</p>
      <small>{{ en ? 'Bilingual webpages' : '网页双语翻译' }}</small>
    </div>
    <div class="bv-orbit-card bv-orbit-document">
      <div><span>PDF</span><small>explore.pdf</small></div>
      <i></i><i></i><i></i>
      <p>{{ en ? 'Read side by side' : '原文与译文，对照读' }}</p>
    </div>
    <div class="bv-orbit-card bv-orbit-grammar">
      <span>offers</span><small>{{ en ? 'Verb · predicate' : '动词 · 谓语' }}</small>
      <p>{{ en ? 'Understand each phrase' : '难句，拆开理解' }}</p>
    </div>
    <span class="bv-orbit-greeting bv-greeting-en" lang="en">Hello</span>
    <span class="bv-orbit-greeting bv-greeting-zh" lang="zh-CN">你好</span>
    <span class="bv-orbit-greeting bv-greeting-fr" lang="fr">Bonjour</span>
    <span class="bv-orbit-greeting bv-greeting-es" lang="es">Hola</span>
    <span class="bv-orbit-greeting bv-greeting-ja" lang="ja">こんにちは</span>
    <span class="bv-orbit-greeting bv-greeting-ko" lang="ko">안녕하세요</span>
    <span class="bv-orbit-greeting bv-greeting-de" lang="de">Hallo</span>
    <span class="bv-orbit-greeting bv-greeting-pt" lang="pt">Olá</span>
    <span class="bv-orbit-greeting bv-greeting-ru" lang="ru">Привет</span>
    <span class="bv-orbit-greeting bv-greeting-ar" lang="ar" dir="rtl">مرحبا</span>
  </div>
</template>

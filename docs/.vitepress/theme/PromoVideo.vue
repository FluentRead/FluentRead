<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

// 原视频接近视野后才开始加载；中文视频 8 秒内仍不可播放或加载失败时切换到 B 站。
// 只等待首次可播放状态，不等待整个文件下载，也不在正常播放时因后续缓冲而切换。
// B 站回退播放器静音自动播放，避免未点击页面的访客被浏览器拦截有声自动播放。
const props = defineProps<{ en?: boolean }>()
const primaryVideo = ref<HTMLVideoElement | null>(null)
const showBilibili = ref(false)
const fallbackDelay = 8000
let timer: ReturnType<typeof setTimeout> | undefined
let observer: IntersectionObserver | undefined
let started = false
let ready = false
let disposed = false

function stopMonitoring() {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  observer?.disconnect()
  observer = undefined
}

function releasePrimaryVideo() {
  const video = primaryVideo.value
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.querySelector('source')?.removeAttribute('src')
    video.load()
  }
}

function useBilibili() {
  if (disposed || props.en || showBilibili.value) return
  stopMonitoring()
  showBilibili.value = true
  // 移除原视频资源，停止超时请求，避免切换后继续占用带宽。
  releasePrimaryVideo()
}

function markReady() {
  if (
    showBilibili.value ||
    !primaryVideo.value ||
    primaryVideo.value.readyState < primaryVideo.value.HAVE_FUTURE_DATA
  ) return
  ready = true
  stopMonitoring()
}

function startLoading() {
  if (props.en || showBilibili.value || started || ready || !primaryVideo.value) return
  started = true
  observer?.disconnect()
  observer = undefined
  const video = primaryVideo.value
  if (video.readyState >= video.HAVE_FUTURE_DATA) {
    markReady()
    return
  }
  timer = setTimeout(() => {
    markReady()
    if (!ready) useBilibili()
  }, fallbackDelay)
  video.preload = 'auto'
  // 用户先点击播放时，浏览器已经开始请求，不重新 load，以免中断播放操作。
  if (video.networkState !== video.NETWORK_LOADING) video.load()
}

onMounted(() => {
  if (props.en || showBilibili.value || !primaryVideo.value) return
  markReady()
  if (ready) return
  if (typeof IntersectionObserver === 'undefined') {
    startLoading()
    return
  }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) startLoading()
    },
    { rootMargin: '200px 0px' }
  )
  observer.observe(primaryVideo.value)
})

onBeforeUnmount(() => {
  disposed = true
  stopMonitoring()
  releasePrimaryVideo()
})
</script>

<template>
  <div v-if="showBilibili && !en" class="bv-promo-video bv-promo-embed">
    <iframe
      src="https://player.bilibili.com/player.html?bvid=BV1VLHE6hEnB&p=1&autoplay=1&muted=1&danmaku=0&poster=1"
      title="流畅阅读 56 秒介绍视频（哔哩哔哩）"
      loading="lazy"
      allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
      allowfullscreen
    ></iframe>
  </div>
  <video
    v-else
    ref="primaryVideo"
    class="bv-promo-video"
    controls
    playsinline
    preload="none"
    width="1920"
    height="1080"
    :poster="withBase(`/videos/fluentread-promo-${en ? 'en' : 'zh'}-poster.webp`)"
    :aria-label="en ? 'FluentRead 56-second introduction video' : '流畅阅读 56 秒介绍视频'"
    @play="startLoading"
    @canplay="markReady"
    @error="useBilibili"
  >
    <source
      :src="withBase(`/videos/fluentread-promo-${en ? 'en' : 'zh'}.mp4`)"
      type="video/mp4"
      @error="useBilibili"
    />
    <a :href="withBase(`/videos/fluentread-promo-${en ? 'en' : 'zh'}.mp4`)">{{
      en ? 'Download the introduction video' : '下载介绍视频'
    }}</a>
  </video>
  <a
    v-if="!en"
    class="bv-text-link bv-promo-link"
    href="https://www.bilibili.com/video/BV1VLHE6hEnB/"
    target="_blank"
    rel="noopener noreferrer"
    >在 B 站观看 <span aria-hidden="true">↗</span></a
  >
</template>

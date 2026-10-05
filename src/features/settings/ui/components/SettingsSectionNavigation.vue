<!--
 @file src/features/settings/ui/components/SettingsSectionNavigation.vue
 文件职责：为连续设置表单提供固定在内容区上方的分区导航，点击后在原页滚动到对应模块。
 主要内容：从当前可见表单的分区标记按 DOM 顺序收集入口，复用分类名称并支持独立模块名称；监听懒加载、展开及尺寸变化，滚动时同步高亮，窄屏横向定位当前入口，尊重减少动态效果偏好，点击折叠模块时展开后定位。
 模块边界：只读取父级传入的内容容器和导航元数据，不改变路由、不隐藏表单、不读写配置；组件卸载或切换页面时清理观察器、事件和动画帧。
-->
<template>
  <nav v-if="anchors.length > 1" ref="navigation" class="settings-page-tabs settings-section-navigation" :aria-label="t('options.categories')">
    <button
      v-for="anchor in anchors"
      :key="anchor.id"
      type="button"
      :data-settings-anchor-link="anchor.id"
      :aria-current="activeAnchor === anchor.id ? 'location' : undefined"
      @click="scrollToAnchor(anchor)"
    >{{ anchor.labelKey ? t(anchor.labelKey) : translateLegacy(anchor.label) }}</button>
  </nav>
</template>
<script setup lang="ts">
import {nextTick, onBeforeUnmount, ref, shallowRef, watch} from 'vue'
import type {SettingsPagePanel} from '@/src/features/settings/model/navigation'
import {useUiI18n} from '@/src/ui/i18n'

type Anchor = {id: string; label: string; labelKey?: string; element: HTMLElement}
const props = defineProps<{container: HTMLElement | null; sectionId: string; panels: readonly SettingsPagePanel[]}>()
const emit = defineEmits<{
  (event: 'availability-change', available: boolean): void
  (event: 'navigate'): void
}>()
const {t, translateLegacy} = useUiI18n()
const anchors = shallowRef<Anchor[]>([])
const activeAnchor = ref('')
const navigation = ref<HTMLElement | null>(null)
let cleanup: (() => void) | undefined
let pendingAnchor: Anchor | undefined
let highlightedDestination = ''
let pendingTimeout: number | undefined
let pendingTop = -1

function cancelPendingAnchor(): void {
  pendingAnchor = undefined
  highlightedDestination = ''
  pendingTop = -1
  window.clearTimeout(pendingTimeout)
}
function highlightAnchor(id: string): void {
  if (!id) return
  cancelPendingAnchor()
  highlightedDestination = id
  pendingTimeout = window.setTimeout(cancelPendingAnchor, 3000)
  updateActiveAnchor()
}
defineExpose({cancelPendingAnchor, highlightAnchor})

function revealPendingAnchor(): void {
  const container = props.container
  const anchor = pendingAnchor
  if (!container || !anchor?.element.getClientRects().length) return
  const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight,
    container.scrollTop + anchor.element.getBoundingClientRect().top
      - container.getBoundingClientRect().top - container.clientTop - 2))
  if (Math.abs(top - pendingTop) < 1) return
  pendingTop = top
  container.scrollTo({top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'})
}

function updateActiveAnchor(): void {
  const container = props.container
  if (!container || !anchors.value.length) return
  if (pendingAnchor) {
    activeAnchor.value = pendingAnchor.id
    return
  }
  if (anchors.value.some(anchor => anchor.id === highlightedDestination)) {
    activeAnchor.value = highlightedDestination
    return
  }
  const top = container.getBoundingClientRect().top + container.clientTop + 24
  let current = anchors.value[0]
  for (const anchor of anchors.value) {
    if (anchor.element.getBoundingClientRect().top <= top) current = anchor
  }
  activeAnchor.value = current.id
}

async function scrollToAnchor(anchor: Anchor): Promise<void> {
  const container = props.container
  if (!container) return
  emit('navigate')
  cancelPendingAnchor()
  pendingAnchor = anchor
  activeAnchor.value = anchor.id
  // 折叠内容和懒加载组件会继续改变可滚动高度，短暂跟随目标，用户操作内容区即停止。
  pendingTimeout = window.setTimeout(cancelPendingAnchor, 3000)
  if (anchor.element instanceof HTMLDetailsElement) anchor.element.open = true
  await nextTick()
  if (container !== props.container || !anchors.value.some(item => item.element === anchor.element)) return
  revealPendingAnchor()
}

watch([activeAnchor, anchors], async () => {
  await nextTick()
  const nav = navigation.value
  const button = nav?.querySelector<HTMLElement>('[aria-current]')
  if (!nav || !button) return
  const navRect = nav.getBoundingClientRect()
  const buttonRect = button.getBoundingClientRect()
  if (buttonRect.left < navRect.left || buttonRect.right > navRect.right) {
    nav.scrollTo({left: nav.scrollLeft + buttonRect.left - navRect.left - (nav.clientWidth - buttonRect.width) / 2, behavior: 'instant'})
  }
})

watch(() => [props.container, props.sectionId] as const, ([container]) => {
  cleanup?.()
  cancelPendingAnchor()
  anchors.value = []
  activeAnchor.value = ''
  emit('availability-change', false)
  if (!container) return
  let frame = 0
  const sizeObserver = new ResizeObserver(() => scheduleRefresh())
  const refresh = () => {
    frame = 0
    const next: Anchor[] = []
    const seen = new Set<string>()
    for (const element of container.querySelectorAll<HTMLElement>('[data-settings-panel], [data-settings-anchor]')) {
      if (!element.getClientRects().length || !element.getBoundingClientRect().height) continue
      const id = element.dataset.settingsAnchor || element.dataset.settingsPanel || ''
      const panel = props.panels.find(item => item.id === id)
      const label = element.dataset.settingsAnchorLabel || ''
      if (seen.has(id) || (!panel && !label)) continue
      seen.add(id)
      next.push({id, label, labelKey: panel?.labelKey, element})
    }
    // 仅在目标集合改变时重订阅，避免 ResizeObserver 首次通知形成刷新循环。
    if (next.length !== anchors.value.length || next.some((item, index) => item.element !== anchors.value[index].element)) {
      sizeObserver.disconnect()
      sizeObserver.observe(container)
      for (const anchor of next) sizeObserver.observe(anchor.element)
    }
    anchors.value = next
    if (pendingAnchor && !next.some(anchor => anchor.element === pendingAnchor?.element)) cancelPendingAnchor()
    emit('availability-change', next.length > 1)
    revealPendingAnchor()
    updateActiveAnchor()
  }
  function scheduleRefresh(): void {
    if (!frame) frame = requestAnimationFrame(refresh)
  }
  const observer = new MutationObserver(scheduleRefresh)
  observer.observe(container, {subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'open', 'data-settings-anchor-label']})
  container.addEventListener('scroll', updateActiveAnchor, {passive: true})
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    container.addEventListener(event, cancelPendingAnchor, {capture: true, passive: true})
  }
  scheduleRefresh()
  cleanup = () => {
    observer.disconnect()
    sizeObserver.disconnect()
    cancelAnimationFrame(frame)
    cancelPendingAnchor()
    container.removeEventListener('scroll', updateActiveAnchor)
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      container.removeEventListener(event, cancelPendingAnchor, true)
    }
  }
}, {immediate: true, flush: 'post'})

onBeforeUnmount(() => cleanup?.())
</script>

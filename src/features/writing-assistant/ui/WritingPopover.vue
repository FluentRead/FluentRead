<!--
 * @file src/features/writing-assistant/ui/WritingPopover.vue
 * 文件职责：将写作卡片与入口菜单定位在当前回复操作旁，保持与宿主编辑器的空间关系。
 * 主要内容：每次打开只选择一次展开方向，空间不足时限制在视口内；只在宿主滚动和尺寸变化时跟随，避免生成时反复翻转。
 * 模块边界：只管理布局和观察器生命周期，不读取正文、不保存偏好，也不触发模型请求。
 -->
<template>
  <div v-show="active" ref="popover" class="writing-popover" :style="{left: `${left}px`, top: `${top}px`, width: `min(${width ?? 600}px, calc(100vw - 24px))`, visibility: positioned ? 'visible' : 'hidden'}"><slot /></div>
</template>
<script setup lang="ts">
import {nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
const props = defineProps<{active: boolean; anchor?: HTMLElement; width?: number}>();
const popover = ref<HTMLElement>();
const left = ref(12); const top = ref(12); const positioned = ref(false);
let direction: 'above' | 'below' | undefined;
let frame = 0; let observer: ResizeObserver | undefined;
const abort = new AbortController();
function place() {
  frame = 0;
  if (!props.active || !props.anchor?.isConnected || !popover.value) return;
  const anchor = props.anchor.getBoundingClientRect(); const box = popover.value.getBoundingClientRect();
  const viewport = window.visualViewport;
  const x = viewport?.offsetLeft ?? 0; const y = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth; const height = viewport?.height ?? window.innerHeight;
  const above = anchor.top - box.height - 8; const below = anchor.bottom + 8;
  direction ??= above >= y + 12 || below + box.height > y + height - 12 ? 'above' : 'below';
  left.value = Math.max(x + 12, Math.min(anchor.right - box.width, x + width - box.width - 12));
  top.value = Math.max(y + 12, Math.min(direction === 'above' ? above : below, y + height - box.height - 12));
  positioned.value = true;
}
function schedule() { if (!frame) frame = requestAnimationFrame(place); }
watch(() => [props.active, props.anchor], async () => { positioned.value = false; direction = undefined; await nextTick(); schedule(); }, {immediate: true});
onMounted(() => {
  observer = new ResizeObserver(schedule); observer.observe(popover.value!);
  document.addEventListener('scroll', event => { if (event.composedPath().some(node => node instanceof HTMLElement && node.id === 'fluent-read-writing-assistant')) return; schedule(); }, {capture: true, passive: true, signal: abort.signal});
  window.addEventListener('resize', schedule, {passive: true, signal: abort.signal});
  window.visualViewport?.addEventListener('resize', schedule, {passive: true, signal: abort.signal});
  window.visualViewport?.addEventListener('scroll', schedule, {passive: true, signal: abort.signal});
});
onBeforeUnmount(() => { abort.abort(); observer?.disconnect(); cancelAnimationFrame(frame); });
</script>
<style scoped>
.writing-popover{position:fixed;z-index:2147483646;max-height:calc(100dvh - 24px);box-sizing:border-box;}
</style>

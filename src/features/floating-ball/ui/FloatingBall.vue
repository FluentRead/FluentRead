<!--
 * @file src/features/floating-ball/ui/FloatingBall.vue
 * 文件职责：呈现低干扰、可拖拽和按需展开的页面悬浮球，并把全文翻译状态、拖动停靠、打开设置、高级外观参数和键盘关闭整合为可复用 Vue 组件。
 * 主要内容：组件按展示契约控制按钮显示方式、展开延迟、点击行为、紧凑尺寸与收起不透明度，使用指针位移阈值区分点击与拖拽，限制球体在视口内，发出位置变更与动作事件，并通过受控状态同步图标和文案。
 * 模块边界：它只负责视觉与局部交互，不直接调用浏览器消息、保存配置或执行全文翻译；这些副作用由 content/runtime 通过 props、事件和 defineExpose 桥接，外观配置的归一化留在 core/config。
 -->
<template>
  <div
    v-ui-i18n
    ref="floatingBall"
    class="fr-floating-ball"
    :class="{
      'floating-ball-expanded': isMenuExpanded,
      dragging: isDragging,
      'is-translating': isTranslating,
      'is-compact': presentation.compact,
    }"
    :data-position="currentDisplayPosition"
    :data-tools-display="presentation.toolsDisplay"
    :style="rootStyle"
    @mouseenter="expandBall"
    @mouseleave="collapseBall"
    @focusin="expandBallImmediately"
    @focusout="collapseBall"
  >
    <button
      v-if="showTranslateTool"
      class="floating-ball-tool floating-ball-translate floating-ball-item"
      type="button"
      :aria-label="isTranslating ? '恢复网页原文' : '翻译整个网页'"
      :aria-pressed="isTranslating"
      :title="isTranslating ? '恢复网页原文' : '翻译整个网页'"
      @pointerdown.stop
      @click.stop="toggleTranslation"
    >
      <svg class="translation-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <text x="0.8" y="12.5" fill="currentColor" font-size="12" font-weight="700" font-family="Arial, sans-serif">A</text>
        <text x="11.8" y="12.5" fill="currentColor" font-size="11.5" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">文</text>
        <path d="M4 16h16M4 16l2-2M4 16l2 2M20 16l-2-2M20 16l-2 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-if="isTranslating" class="check-mark" aria-hidden="true" />
    </button>

    <div
      ref="floatingBallMain"
      class="floating-ball-main floating-ball-item"
      :role="isMainActionable ? 'button' : 'img'"
      :tabindex="isMainActionable ? 0 : undefined"
      :aria-label="mainActionLabel"
      :title="mainActionTitle"
      @pointerdown="startDrag"
      @pointerup="finishPointerInteraction"
      @pointercancel="cancelPointerInteraction"
      @keydown="handleMainKeydown"
    >
      <svg class="floating-ball-mascot" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <image v-if="logoUrl" :href="logoUrl" x="0" y="0" width="32" height="32" preserveAspectRatio="none" image-rendering="auto" />
      </svg>
      <span v-if="isTranslating" class="check-mark" aria-hidden="true" />
    </div>

    <button
      v-if="showSettingsTool"
      class="floating-ball-tool floating-ball-settings floating-ball-item"
      type="button"
      aria-label="打开 FluentRead 设置"
      title="打开设置"
      @pointerdown.stop
      @click.stop="handleSettingsClick"
    >
      <svg viewBox="6 5 16 15" fill="none" aria-hidden="true">
        <path d="m19.43 12.98 1.25.98-1.5 2.6-1.5-.6a7.3 7.3 0 0 1-1.69.98L15.77 18h-3l-.22-1.06a7.3 7.3 0 0 1-1.69-.98l-1.5.6-1.5-2.6 1.25-.98a6.7 6.7 0 0 1 0-1.96l-1.25-.98 1.5-2.6 1.5.6a7.3 7.3 0 0 1 1.69-.98L12.77 6h3l.22 1.06c.6.24 1.16.57 1.69.98l1.5-.6 1.5 2.6-1.25.98a6.7 6.7 0 0 1 0 1.96Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
        <circle cx="14.27" cy="12" r="2.4" stroke="currentColor" stroke-width="1.7" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PropType, CSSProperties } from 'vue';
import type { FloatingBallPresentation } from '@/src/features/floating-ball/types';

const DRAG_THRESHOLD = 6;
const BALL_SIZE = 48;
const COMPACT_BALL_SIZE = 36;

/** 展示契约的保守默认值：与历史外观一致，供未传入配置的挂载方使用。 */
const DEFAULT_PRESENTATION: FloatingBallPresentation = {
  toolsDisplay: 'hover',
  hoverDelay: 0,
  clickAction: 'translate',
  compact: false,
  settingsEntryVisible: true,
  collapsedOpacity: 52,
};

const props = defineProps({
  position: {
    type: String as PropType<'left' | 'right'>,
    default: 'right',
    validator: (value: string) => ['left', 'right'].includes(value),
  },
  showMenu: {
    type: Boolean,
    default: true,
  },
  logoUrl: {
    type: String,
    default: '',
  },
  // defineProps 的默认值会被提升到 setup 之外，不能引用模块内常量；缺省值交由下方计算属性补齐。
  presentation: {
    type: Object as PropType<Partial<FloatingBallPresentation>>,
    default: undefined,
  },
  onSettingsClick: {
    type: Function as PropType<(event: MouseEvent) => void>,
    default: () => {},
  },
  onPositionChanged: {
    type: Function as PropType<(newPosition: 'left' | 'right') => void>,
    default: () => {},
  },
  onTranslationToggle: {
    type: Function as PropType<(isTranslating: boolean) => void>,
    default: () => {},
  },
  initialTranslating: {
    type: Boolean,
    default: false,
  },
});

interface PointerDragState {
  pointerId: number;
  startX: number;
  startY: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  mainWidth: number;
  mainHeight: number;
  dockHeight: number;
  moved: boolean;
}

const isExpanded = ref(false);
const positionStyle = ref<CSSProperties>({});
const isDragging = ref(false);
const draggedY = ref<number | null>(null);
const internalPosition = ref<'left' | 'right' | null>(null);
const isTranslating = ref(props.initialTranslating);
const floatingBall = ref<HTMLElement | null>(null);
const floatingBallMain = ref<HTMLElement | null>(null);
const dragState = ref<PointerDragState | null>(null);
let expandTimer: ReturnType<typeof setTimeout> | null = null;

// 缺失字段按默认值补齐，避免旧配置或部分更新让模板读到 undefined。
const presentation = computed<FloatingBallPresentation>(() => ({
  ...DEFAULT_PRESENTATION,
  ...(props.presentation ?? {}),
}));
const currentDisplayPosition = computed(() => internalPosition.value || props.position);
const isAlwaysExpanded = computed(() => presentation.value.toolsDisplay === 'always');
const showTranslateTool = computed(() => props.showMenu && presentation.value.toolsDisplay !== 'hidden');
const showSettingsTool = computed(() => showTranslateTool.value && presentation.value.settingsEntryVisible);
const isMenuExpanded = computed(() => showTranslateTool.value && (isAlwaysExpanded.value || isExpanded.value));
const isMainActionable = computed(() => presentation.value.clickAction !== 'none');
const mainActionLabel = computed(() => {
  if (presentation.value.clickAction === 'settings') return '打开 FluentRead 设置';
  if (presentation.value.clickAction === 'translate') {
    return isTranslating.value ? '恢复网页原文' : '翻译整个网页';
  }
  return 'FluentRead';
});
const mainActionTitle = computed(() => {
  if (presentation.value.clickAction === 'settings') return '打开设置，按住可拖动';
  if (presentation.value.clickAction === 'translate') {
    return isTranslating.value ? '恢复网页原文，按住可拖动' : '翻译整个网页，按住可拖动';
  }
  return '按住拖动调整位置';
});
const rootStyle = computed<CSSProperties>(() => ({
  ...positionStyle.value,
  '--fr-ball-collapsed-opacity': String(presentation.value.collapsedOpacity / 100),
} as CSSProperties));

function clearExpandTimer() {
  if (expandTimer === null) return;
  clearTimeout(expandTimer);
  expandTimer = null;
}

function expandBall() {
  if (isDragging.value || isAlwaysExpanded.value) return;
  const delay = Math.max(0, presentation.value.hoverDelay);
  clearExpandTimer();
  if (delay === 0) {
    isExpanded.value = true;
    return;
  }
  // 悬停延迟只推迟展开，不改变已展开状态；越过页面边缘时不再误触工具按钮。
  expandTimer = setTimeout(() => {
    expandTimer = null;
    if (!isDragging.value) isExpanded.value = true;
  }, delay);
}

/** 键盘聚焦必须立即展开，延迟只服务于鼠标悬停。 */
function expandBallImmediately() {
  if (isDragging.value || isAlwaysExpanded.value) return;
  clearExpandTimer();
  isExpanded.value = true;
}

function collapseBall() {
  clearExpandTimer();
  if (!isDragging.value && !floatingBall.value?.matches(':focus-within')) isExpanded.value = false;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function applyDockPositionStyle(containerHeight: number) {
  const halfHeight = containerHeight / 2;
  const centerY = draggedY.value === null
    ? '50%'
    : `${clamp(draggedY.value, halfHeight, Math.max(halfHeight, window.innerHeight - halfHeight))}px`;

  positionStyle.value = {
    top: centerY,
    left: undefined,
    right: undefined,
    transform: undefined,
  };
}

function updatePositionStyle() {
  if (isDragging.value) return;
  applyDockPositionStyle(floatingBall.value?.getBoundingClientRect().height || fallbackBallSize());
}

function fallbackBallSize() {
  return presentation.value.compact ? COMPACT_BALL_SIZE : BALL_SIZE;
}

function startDrag(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  event.preventDefault();
  const dockRect = floatingBall.value?.getBoundingClientRect();
  const rect = floatingBallMain.value?.getBoundingClientRect() || dockRect;
  const mainWidth = rect?.width || fallbackBallSize();
  const mainHeight = rect?.height || fallbackBallSize();
  dragState.value = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    pointerOffsetX: rect ? event.clientX - rect.left : mainWidth / 2,
    pointerOffsetY: rect ? event.clientY - rect.top : mainHeight / 2,
    mainWidth,
    mainHeight,
    dockHeight: dockRect?.height || mainHeight,
    moved: false,
  };

  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', finishPointerInteraction);
  window.addEventListener('pointercancel', cancelPointerInteraction);
}

function handlePointerMove(event: PointerEvent) {
  const currentDrag = dragState.value;
  if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;

  if (!currentDrag.moved) {
    if (Math.hypot(event.clientX - currentDrag.startX, event.clientY - currentDrag.startY) <= DRAG_THRESHOLD) return;
    currentDrag.moved = true;
    clearExpandTimer();
    isExpanded.value = false;
    isDragging.value = true;
  }

  const nextLeft = clamp(
    event.clientX - currentDrag.pointerOffsetX,
    0,
    Math.max(0, window.innerWidth - currentDrag.mainWidth),
  );
  const nextTop = clamp(
    event.clientY - currentDrag.pointerOffsetY,
    0,
    Math.max(0, window.innerHeight - currentDrag.mainHeight),
  );
  positionStyle.value = {
    left: `${nextLeft}px`,
    top: `${nextTop}px`,
    right: 'auto',
    transform: 'none',
  };
}

function finishPointerInteraction(event: PointerEvent) {
  const currentDrag = dragState.value;
  if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;

  removePointerListeners();
  dragState.value = null;
  if (!currentDrag.moved) {
    isDragging.value = false;
    // 未越过拖动阈值即视为点击；点击行为由配置决定，默认切换全文翻译。
    runMainAction(event);
    return;
  }

  const rect = floatingBallMain.value?.getBoundingClientRect();
  const finalCenterY = rect ? rect.top + rect.height / 2 : event.clientY;
  const nextPosition = event.clientX < window.innerWidth / 2 ? 'left' : 'right';
  const halfHeight = currentDrag.dockHeight / 2;
  draggedY.value = clamp(finalCenterY, halfHeight, Math.max(halfHeight, window.innerHeight - halfHeight));
  internalPosition.value = nextPosition;
  props.onPositionChanged(nextPosition);
  applyDockPositionStyle(currentDrag.dockHeight);
  nextTick(() => {
    isDragging.value = false;
  });
}

function cancelPointerInteraction(event: PointerEvent) {
  const currentDrag = dragState.value;
  if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;

  removePointerListeners();
  dragState.value = null;
  if (!currentDrag.moved) {
    isDragging.value = false;
    return;
  }
  applyDockPositionStyle(currentDrag.dockHeight);
  nextTick(() => {
    isDragging.value = false;
  });
}

function removePointerListeners() {
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', finishPointerInteraction);
  window.removeEventListener('pointercancel', cancelPointerInteraction);
}

/** 悬浮球主体的点击与回车行为；'none' 保留纯拖动手柄语义。 */
function runMainAction(event: PointerEvent | KeyboardEvent) {
  const action = presentation.value.clickAction;
  if (action === 'translate') {
    props.onTranslationToggle(!isTranslating.value);
    return;
  }
  if (action === 'settings') {
    props.onSettingsClick(event as unknown as MouseEvent);
  }
}

function handleMainKeydown(event: KeyboardEvent) {
  if (!isMainActionable.value || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  runMainAction(event);
}

function toggleTranslation(event?: MouseEvent) {
  if (event && event.detail > 0) {
    (event.currentTarget as HTMLElement | null)?.blur();
    isExpanded.value = false;
  }
  props.onTranslationToggle(!isTranslating.value);
}

function setTranslationState(nextState: boolean) {
  isTranslating.value = nextState;
}

defineExpose({ toggleTranslation, setTranslationState });

function handleSettingsClick(event: MouseEvent) {
  props.onSettingsClick(event);
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !isExpanded.value) return;
  floatingBall.value?.querySelector<HTMLElement>(':focus')?.blur();
  isExpanded.value = false;
}

onMounted(() => {
  internalPosition.value = props.position;
  updatePositionStyle();
  window.addEventListener('resize', updatePositionStyle);
  document.addEventListener('keydown', handleDocumentKeydown);
});

onBeforeUnmount(() => {
  clearExpandTimer();
  removePointerListeners();
  window.removeEventListener('resize', updatePositionStyle);
  document.removeEventListener('keydown', handleDocumentKeydown);
});

watch(() => props.position, (newPosition) => {
  if (newPosition === internalPosition.value) return;
  internalPosition.value = newPosition;
  draggedY.value = null;
  updatePositionStyle();
});

watch(() => props.initialTranslating, (nextState) => {
  isTranslating.value = nextState;
});

// 尺寸切换会改变停靠高度，必须重新计算纵向居中，避免紧凑模式下出现偏移。
watch(() => presentation.value.compact, () => {
  nextTick(updatePositionStyle);
});

watch(() => presentation.value.toolsDisplay, (display) => {
  if (display !== 'hover') clearExpandTimer();
  if (display === 'hidden') isExpanded.value = false;
});
</script>

<style scoped>
.fr-floating-ball {
  --fr-ball-size: 48px;
  --fr-ball-tool-size: 32px;
  --fr-ball-icon-size: 18px;
  --fr-ball-mascot-size: 24px;
  position: fixed;
  z-index: 2147483647;
  display: flex;
  width: var(--fr-ball-size);
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  color: #596273;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  transition: transform 0.46s cubic-bezier(0.22, 1, 0.36, 1);
  user-select: none;
  touch-action: none;
  will-change: transform;
}

.fr-floating-ball.is-compact {
  --fr-ball-size: 36px;
  --fr-ball-tool-size: 26px;
  --fr-ball-icon-size: 15px;
  --fr-ball-mascot-size: 19px;
  gap: 6px;
}

.fr-floating-ball[data-position="left"] {
  left: 0;
  align-items: flex-start;
  transform: translateY(-50%);
}

.fr-floating-ball[data-position="right"] {
  right: 0;
  transform: translateY(-50%);
}

.floating-ball-item {
  position: relative;
  flex: 0 0 auto;
  transform: translateX(var(--fr-ball-size));
  transition: transform 0.46s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.24s ease, box-shadow 0.24s ease, border-color 0.24s ease, background 0.24s ease;
  will-change: transform;
}

.fr-floating-ball[data-position="left"] .floating-ball-item {
  transform: translateX(calc(var(--fr-ball-size) * -1));
}

.fr-floating-ball.floating-ball-expanded .floating-ball-item {
  opacity: 1;
  transform: translateX(0) !important;
}

.floating-ball-translate {
  transition-delay: 0.06s;
}

.floating-ball-main {
  position: relative;
  z-index: 1;
  display: flex;
  width: var(--fr-ball-size);
  height: var(--fr-ball-size);
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  cursor: grab;
  opacity: 1;
  overflow: visible;
}

.fr-floating-ball:not(.floating-ball-expanded):not(.dragging)[data-position="right"] .floating-ball-main {
  opacity: var(--fr-ball-collapsed-opacity, 0.52);
  transform: translateX(50%);
}

.fr-floating-ball:not(.floating-ball-expanded):not(.dragging)[data-position="left"] .floating-ball-main {
  opacity: var(--fr-ball-collapsed-opacity, 0.52);
  transform: translateX(-50%);
}

.fr-floating-ball.floating-ball-expanded .floating-ball-main {
  filter: drop-shadow(0 8px 10px rgba(15, 23, 42, 0.16));
}

.floating-ball-main:hover,
.floating-ball-main:focus-visible {
  outline: none;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  filter: drop-shadow(0 8px 12px rgba(240, 106, 146, 0.3));
}

.floating-ball-mascot {
  display: block;
  width: var(--fr-ball-mascot-size);
  height: var(--fr-ball-mascot-size);
  pointer-events: none;
  image-rendering: auto;
}

.translation-icon {
  width: var(--fr-ball-icon-size);
  height: var(--fr-ball-icon-size);
}

.floating-ball-tool {
  display: inline-flex;
  width: var(--fr-ball-tool-size);
  height: var(--fr-ball-tool-size);
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(217, 222, 231, 0.96);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.94);
  color: #626b79;
  cursor: pointer;
  opacity: 0;
}

.fr-floating-ball.floating-ball-expanded .floating-ball-tool {
  opacity: 1;
}

.floating-ball-settings {
  transition-delay: 0.1s;
}

.floating-ball-tool:hover,
.floating-ball-tool:focus-visible {
  outline: none;
  border-color: #f06a92;
  background: #fff7fa;
  color: #ec4d7d;
  box-shadow: 0 8px 22px rgba(240, 106, 146, 0.2);
}

.floating-ball-expanded.is-translating .floating-ball-main {
  border-color: transparent;
  box-shadow: none;
  filter: drop-shadow(0 8px 12px rgba(240, 106, 146, 0.3));
}

.check-mark {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border: 1px solid #fff;
  border-radius: 50%;
  background: rgba(34, 197, 94, 0.82);
}

.check-mark::after {
  position: absolute;
  top: 1px;
  left: 2px;
  width: 3px;
  height: 5px;
  border-right: 1px solid #fff;
  border-bottom: 1px solid #fff;
  content: '';
  transform: rotate(45deg);
}

.fr-floating-ball[data-position="right"] .floating-ball-main .check-mark {
  right: auto;
  left: -1px;
}

.fr-floating-ball[data-position="left"] .floating-ball-main .check-mark {
  right: -1px;
  left: auto;
}

.floating-ball-settings svg {
  width: var(--fr-ball-icon-size);
  height: var(--fr-ball-icon-size);
}

.dragging {
  transition: none;
}

.dragging .floating-ball-main {
  transform: none !important;
  opacity: 1;
  cursor: grabbing;
  border-color: #f06a92;
  box-shadow: 0 8px 25px rgba(240, 106, 146, 0.28);
}

.dragging .floating-ball-tool {
  visibility: hidden;
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .fr-floating-ball,
  .floating-ball-item,
  .floating-ball-main,
  .floating-ball-tool {
    transition: none;
  }
}
</style>

<!--
 * @file src/features/floating-ball/ui/FloatingBall.vue
 * 文件职责：呈现用户开启后的页面悬浮工具，将全文翻译、品牌手柄和漫画入口按顺序组织，并保留拖动停靠与可选常驻模式。
 * 主要内容：品牌主体只显示圆形本地图标，上方翻译按钮分别呈现处理中、成功与失败，活动会话仍提供恢复原文动作；默认悬停展开、移出和 Escape 收回边缘，键盘聚焦与触屏轻点保持入口可操作。
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
      'is-compact': presentation.compact,
      'manga-reader': !!manga?.available,
    }"
    :data-position="currentDisplayPosition"
    :data-tools-display="presentation.toolsDisplay"
    :data-translation-status="displayTranslationStatus"
    :style="rootStyle"
    @mouseenter="expandBall"
    @mouseleave="collapseBall"
    @pointermove="keepMangaToolsVisible"
    @focusin="expandBallImmediately"
    @focusout="collapseBall"
    @keydown.esc.stop="handleDocumentKeydown"
  >
    <button
      v-if="showTranslateTool"
      class="floating-ball-tool floating-ball-translate floating-ball-item"
      type="button"
      :aria-label="translationActionLabel"
      :aria-pressed="isTranslating"
      :aria-busy="displayTranslationStatus === 'translating'"
      :title="translationActionLabel"
      @pointerdown.stop
      @click.stop="toggleTranslation"
    >
      <svg class="translation-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <text x="0.8" y="12.5" fill="currentColor" font-size="12" font-weight="700" font-family="Arial, sans-serif">A</text>
        <text x="11.8" y="12.5" fill="currentColor" font-size="11.5" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">文</text>
        <path d="M4 16h16M4 16l2-2M4 16l2 2M20 16l-2-2M20 16l-2 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-if="displayTranslationStatus === 'translated'" class="check-mark" aria-hidden="true" />
      <span v-else-if="displayTranslationStatus === 'error'" class="translation-error" aria-hidden="true">!</span>
      <span v-else-if="displayTranslationStatus === 'translating'" class="translation-progress" aria-hidden="true">…</span>
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
        <path v-else d="M16 8c-4-3-8-3-12-1v19c4-2 8-2 12 1m0-19c4-3 8-3 12-1v19c-4-2-8-2-12 1V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      </svg>
    </div>

    <button
      v-if="manga?.available"
      class="floating-ball-tool floating-ball-manga floating-ball-item"
      :class="{'manga-active': manga.active, 'manga-pending': manga.pending}"
      type="button"
      :aria-label="t(manga.areaFallback ? '圈选漫画翻译' : manga.active ? '暂停并显示原图' : '漫画翻译')"
      :aria-pressed="manga.active"
      :aria-busy="manga.pending"
      :title="mangaTitle"
      @pointerdown.stop
      @click.stop="handleMangaClick"
    >
      <svg class="manga-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1V6Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M5.5 8.5h4v4h-2l-1.5 1v-1h-.5v-4Zm9.5.5h3m-3 3h3m-3 3h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-if="manga.active && !manga.pending && (manga.errors > 0 || (manga.completed ?? 0) > 0)" class="manga-check" :class="{'manga-error': manga.errors > 0}" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none"><path :d="manga.errors ? 'M8 4.5v4.3m0 2.2v.1' : 'm4 8 2.7 2.7L12 5.5'" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </span>
      <span v-if="manga.pending" class="manga-progress" aria-hidden="true" />
    </button>

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
import {useUiI18n} from '@/src/ui/i18n';
import type {MangaTranslationStatus} from '@/src/features/image-translation/public';
import type {TranslationToolbarStatus} from '@/src/features/full-page-translation/public';
import type { FloatingBallPresentation } from '@/src/features/floating-ball/types';
import {resolveFloatingBallCenterY, toFloatingBallVerticalPosition} from '@/src/features/floating-ball/position';

const {translateLegacy: t, t: translateMessage} = useUiI18n();

const DRAG_THRESHOLD = 6;
const BALL_SIZE = 40;
const COMPACT_BALL_SIZE = 32;

/** 与配置默认值一致；独立挂载时同样按悬停展开。 */
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
  verticalPosition: {
    type: Number as PropType<number | null>,
    default: null,
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
    type: Function as PropType<(newPosition: 'left' | 'right', verticalPosition: number) => void>,
    default: () => {},
  },
  onTranslationToggle: {
    type: Function as PropType<(isTranslating: boolean) => void>,
    default: () => {},
  },
  manga: {type: Object as PropType<MangaTranslationStatus>, default: undefined},
  onMangaToggle: {type: Function as PropType<(event: MouseEvent) => void>, default: () => {}},
  initialTranslating: {
    type: Boolean,
    default: false,
  },
  initialTranslationStatus: {
    type: String as PropType<TranslationToolbarStatus>,
    default: 'idle',
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
const verticalPosition = ref<number | null>(props.verticalPosition);
const internalPosition = ref<'left' | 'right' | null>(null);
const isTranslating = ref(props.initialTranslating);
const translationStatus = ref(props.initialTranslationStatus);
const floatingBall = ref<HTMLElement | null>(null);
const floatingBallMain = ref<HTMLElement | null>(null);
const dragState = ref<PointerDragState | null>(null);
const touchExpanded = ref(false);
let expandTimer: ReturnType<typeof setTimeout> | null = null;
let mangaIdleTimer: ReturnType<typeof setTimeout> | null = null;

// 缺失字段按默认值补齐，避免旧配置或部分更新让模板读到 undefined。
const presentation = computed<FloatingBallPresentation>(() => ({
  ...DEFAULT_PRESENTATION,
  ...(props.presentation ?? {}),
}));
const currentDisplayPosition = computed(() => internalPosition.value || props.position);
const isAlwaysExpanded = computed(() => presentation.value.toolsDisplay === 'always');
const showTranslateTool = computed(() => props.showMenu && presentation.value.toolsDisplay !== 'hidden');
const showSettingsTool = computed(() => showTranslateTool.value && presentation.value.settingsEntryVisible);
// 隐藏工具按钮不影响主体展开，键盘与触屏仍能完整访问悬浮球。
const isMenuExpanded = computed(() => isAlwaysExpanded.value || isExpanded.value || touchExpanded.value);
const isMainActionable = computed(() => presentation.value.clickAction !== 'none');
const displayTranslationStatus = computed(() => isTranslating.value ? translationStatus.value : 'idle');
const translationActionLabel = computed(() => {
  const action = t(isTranslating.value ? '恢复网页原文' : '翻译整个网页');
  const status = displayTranslationStatus.value;
  const key = status === 'translating' ? 'fullPage.progress.title'
    : status === 'error' ? 'fullPage.progress.failuresTitle'
    : status === 'translated' ? 'fullPage.progress.completed' : null;
  return key ? `${action} · ${translateMessage(key)}` : action;
});
const mangaTitle = computed(() => {
  const manga = props.manga;
  if (manga?.areaFallback) return t('画布或分片漫画 · 拖选可见区域翻译');
  if (!manga?.active) return t('漫画翻译 · 自动翻译新页面');
  const message = manga.pending ? manga.message || '正在处理当前漫画页' : manga.errors ? '部分页面未完成' : '连续翻译已开启';
  return `${t(message)} · ${t('暂停并显示原图')}`;
});
const mainActionLabel = computed(() => {
  if (presentation.value.clickAction === 'settings') return `FluentRead · ${t('打开 FluentRead 设置')}`;
  if (presentation.value.clickAction === 'translate') {
    return `FluentRead · ${translationActionLabel.value}`;
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

function clearMangaIdleTimer() {
  if (mangaIdleTimer !== null) clearTimeout(mangaIdleTimer);
  mangaIdleTimer = null;
}

/** 单页反馈承担进度，工具入口不因后台推理常驻；键盘用户操作时不自动收起。 */
function scheduleMangaCollapse() {
  clearMangaIdleTimer();
  if (!props.manga?.available || isAlwaysExpanded.value || isDragging.value || floatingBall.value?.querySelector(':focus-visible')) return;
  mangaIdleTimer = setTimeout(() => {
    mangaIdleTimer = null;
    if (isDragging.value || floatingBall.value?.querySelector(':focus-visible')) return;
    isExpanded.value = false;
    touchExpanded.value = false;
  }, 2500);
}

function keepMangaToolsVisible(event: PointerEvent) {
  if (!props.manga?.available || event.pointerType !== 'mouse' || isDragging.value) return;
  if (!isMenuExpanded.value) expandBall();
  else scheduleMangaCollapse();
}

function handleMangaClick(event: MouseEvent) {
  props.onMangaToggle(event);
  // 鼠标点击留下的 focus 不应把工具锁在屏幕上，键盘点击则保留焦点。
  if (event.detail > 0) (event.currentTarget as HTMLElement)?.blur();
  scheduleMangaCollapse();
}

function expandBall() {
  if (isDragging.value || isAlwaysExpanded.value) return;
  const delay = Math.max(0, presentation.value.hoverDelay);
  clearExpandTimer();
  if (delay === 0) {
    isExpanded.value = true;
    scheduleMangaCollapse();
    return;
  }
  // 悬停延迟只推迟展开，不改变已展开状态；越过页面边缘时不再误触工具按钮。
  expandTimer = setTimeout(() => {
    expandTimer = null;
    if (!isDragging.value) {isExpanded.value = true; scheduleMangaCollapse();}
  }, delay);
}

/** 键盘聚焦必须立即展开，延迟只服务于鼠标悬停。 */
function expandBallImmediately() {
  if (isDragging.value || isAlwaysExpanded.value) return;
  clearExpandTimer();
  isExpanded.value = true;
  scheduleMangaCollapse();
}

function collapseBall() {
  clearExpandTimer();
  // 鼠标仍在工具内时，点击后 blur 只释放焦点，不移动下一次点击的目标。
  if (props.manga?.available && (floatingBall.value?.matches(':hover') || floatingBall.value?.querySelector(':focus-visible'))) {
    scheduleMangaCollapse();
    return;
  }
  // 鼠标点击留下的焦点不能阻止移出收起；键盘可见焦点继续保留工具。
  if (!isDragging.value && !floatingBall.value?.querySelector(':focus-visible')) isExpanded.value = false;
  scheduleMangaCollapse();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function applyDockPositionStyle(containerHeight: number) {
  const centerY = `${resolveFloatingBallCenterY(verticalPosition.value, window.innerHeight, containerHeight)}px`;

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
  return presentation.value.compact || props.manga?.available ? COMPACT_BALL_SIZE : BALL_SIZE;
}

function startDrag(event: PointerEvent) {
  if (dragState.value) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;

  event.preventDefault();
  // 触屏没有稳定的 hover；轻点时展开主体和允许显示的工具，直到点击球外或开始拖动。
  if (event.pointerType === 'touch' && !isAlwaysExpanded.value) {
    touchExpanded.value = true;
  }
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
  window.addEventListener('blur', cancelActivePointerInteraction);
}

function handlePointerMove(event: PointerEvent) {
  const currentDrag = dragState.value;
  if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;

  if (!currentDrag.moved) {
    if (Math.hypot(event.clientX - currentDrag.startX, event.clientY - currentDrag.startY) <= DRAG_THRESHOLD) return;
    currentDrag.moved = true;
    clearExpandTimer();
    isExpanded.value = false;
    touchExpanded.value = false;
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
  verticalPosition.value = toFloatingBallVerticalPosition(finalCenterY, window.innerHeight);
  internalPosition.value = nextPosition;
  props.onPositionChanged(nextPosition, verticalPosition.value);
  applyDockPositionStyle(currentDrag.dockHeight);
  nextTick(() => {
    isDragging.value = false;
  });
}

function cancelPointerInteraction(event: PointerEvent) {
  const currentDrag = dragState.value;
  if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;

  cancelActivePointerInteraction();
}

/** 失焦时没有可靠的 pointerup；释放当前手势并回到原停靠位置。 */
function cancelActivePointerInteraction() {
  const currentDrag = dragState.value;
  if (!currentDrag) return;

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
  window.removeEventListener('blur', cancelActivePointerInteraction);
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
  if (event.repeat) return;
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

function setTranslationStatus(nextStatus: TranslationToolbarStatus) {
  translationStatus.value = nextStatus;
}

/** 其他页面更改配置后，让已打开的页面同步位置；同值广播不打断当前拖动。 */
function setPosition(side: 'left' | 'right', nextVerticalPosition: number | null) {
  if (side === internalPosition.value && nextVerticalPosition === verticalPosition.value) return;
  internalPosition.value = side;
  verticalPosition.value = nextVerticalPosition;
  nextTick(updatePositionStyle);
}

defineExpose({ toggleTranslation, setTranslationState, setTranslationStatus, setPosition });

function handleSettingsClick(event: MouseEvent) {
  props.onSettingsClick(event);
  if (event.detail > 0) {
    (event.currentTarget as HTMLElement | null)?.blur();
    isExpanded.value = false;
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  clearExpandTimer();
  clearMangaIdleTimer();
  if (!isMenuExpanded.value) return;
  floatingBall.value?.querySelector<HTMLElement>(':focus')?.blur();
  isExpanded.value = false;
  touchExpanded.value = false;
}

function handleDocumentPointerDown(event: PointerEvent) {
  // closed Shadow DOM 在宿主外隐藏内部路径；比较 Shadow 宿主才能保留球内工具的触摸。
  const root = floatingBall.value?.getRootNode();
  const boundary = root instanceof ShadowRoot ? root.host : floatingBall.value;
  if (touchExpanded.value && boundary && !event.composedPath().includes(boundary)) {
    touchExpanded.value = false;
  }
}

onMounted(() => {
  internalPosition.value = props.position;
  updatePositionStyle();
  window.addEventListener('resize', updatePositionStyle);
  document.addEventListener('keydown', handleDocumentKeydown);
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
});

onBeforeUnmount(() => {
  clearExpandTimer();
  clearMangaIdleTimer();
  removePointerListeners();
  window.removeEventListener('resize', updatePositionStyle);
  document.removeEventListener('keydown', handleDocumentKeydown);
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
});

watch(() => props.position, (newPosition) => {
  if (newPosition === internalPosition.value) return;
  internalPosition.value = newPosition;
  updatePositionStyle();
});

watch(() => props.verticalPosition, (nextPosition) => {
  verticalPosition.value = nextPosition;
  updatePositionStyle();
});

watch(() => props.initialTranslating, (nextState) => {
  isTranslating.value = nextState;
});

watch(() => props.initialTranslationStatus, setTranslationStatus);

// 尺寸切换会改变停靠高度，必须重新计算纵向居中，避免紧凑模式下出现偏移。
watch(() => [presentation.value.compact, props.manga?.available], () => {
  nextTick(updatePositionStyle);
});

watch(() => presentation.value.toolsDisplay, () => {
  clearMangaIdleTimer();
  clearExpandTimer();
  isExpanded.value = false;
  touchExpanded.value = false;
  nextTick(updatePositionStyle);
});

watch(() => props.showMenu, (visible) => {
  if (!visible) touchExpanded.value = false;
});

watch(() => presentation.value.settingsEntryVisible, () => {
  nextTick(updatePositionStyle);
});
</script>

<style scoped>
.fr-floating-ball {
  --fr-ball-size: 40px;
  --fr-ball-tool-size: 40px;
  --fr-ball-icon-size: 18px;
  --fr-ball-mascot-size: 24px;
  --fr-ball-edge-gap: 20px;
  position: fixed;
  /* 工具入口位于独立阅读面板和操作弹窗之下，窄屏时不遮住正文。 */
  z-index: 2147483646;
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
  pointer-events: none;
  will-change: transform;
}

/* 收起时不让透明容器覆盖网页；展开后连接主体与页面边缘，避免图标移入页面时悬停中断。 */
.fr-floating-ball.floating-ball-expanded {
  pointer-events: auto;
}

.fr-floating-ball.floating-ball-expanded::after {
  position: absolute;
  top: 0;
  bottom: 0;
  width: var(--fr-ball-edge-gap);
  content: '';
}

.fr-floating-ball.floating-ball-expanded[data-position="right"]::after {
  right: calc(var(--fr-ball-edge-gap) * -1);
}

.fr-floating-ball.floating-ball-expanded[data-position="left"]::after {
  left: calc(var(--fr-ball-edge-gap) * -1);
}

.fr-floating-ball.is-compact {
  --fr-ball-size: 32px;
  --fr-ball-tool-size: 32px;
  --fr-ball-icon-size: 15px;
  --fr-ball-mascot-size: 19px;
  gap: 6px;
}
.fr-floating-ball.manga-reader {
  --fr-ball-size:32px;--fr-ball-tool-size:32px;--fr-ball-icon-size:15px;--fr-ball-mascot-size:19px;--fr-ball-reader-inset:16px;gap:6px;
}

.fr-floating-ball[data-position="left"] {
  left: var(--fr-ball-edge-gap);
  align-items: flex-start;
  transform: translateY(-50%);
}

.fr-floating-ball[data-position="right"] {
  right: var(--fr-ball-edge-gap);
  transform: translateY(-50%);
}

.floating-ball-item {
  position: relative;
  flex: 0 0 auto;
  transform: translateX(4px);
  transition: transform 0.46s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.24s ease, box-shadow 0.24s ease, border-color 0.24s ease, background 0.24s ease;
  will-change: transform;
}

.fr-floating-ball[data-position="left"] .floating-ball-item {
  transform: translateX(-4px);
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
  border: 1px solid rgba(217, 222, 231, 0.96);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.94);
  cursor: grab;
  pointer-events: auto;
  opacity: 1;
  overflow: visible;
  order: 1;
  color: #ec4d7d;
}

.floating-ball-translate {order:0;}
.floating-ball-manga {order:2;}
.floating-ball-settings {order:3;}

.fr-floating-ball:not(.floating-ball-expanded):not(.dragging)[data-position="right"] .floating-ball-main {
  opacity: var(--fr-ball-collapsed-opacity, 0.52);
  transform: translateX(calc(50% + var(--fr-ball-edge-gap)));
}

.fr-floating-ball:not(.floating-ball-expanded):not(.dragging)[data-position="left"] .floating-ball-main {
  opacity: var(--fr-ball-collapsed-opacity, 0.52);
  transform: translateX(calc(-50% - var(--fr-ball-edge-gap)));
}

.fr-floating-ball.floating-ball-expanded .floating-ball-main {
  filter: drop-shadow(0 8px 10px rgba(15, 23, 42, 0.16));
}

.floating-ball-main:hover,
.floating-ball-main:focus-visible {
  outline: none;
  border-color: rgba(240, 106, 146, 0.7);
  background: rgba(255, 255, 255, 0.98);
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
  pointer-events: none;
}

.fr-floating-ball.floating-ball-expanded .floating-ball-tool {
  opacity: 1;
  pointer-events: auto;
}

.fr-floating-ball .floating-ball-manga {
  opacity: var(--fr-ball-collapsed-opacity, 0.52);
  pointer-events: auto;
}
/* 半圆把手留在滚动条内侧；macOS 滚动时出现的原生滚动条不能吞掉全部命中区域。 */
.fr-floating-ball.manga-reader:not(.floating-ball-expanded):not(.dragging)[data-position="right"] :is(.floating-ball-manga,.floating-ball-main) {transform:translateX(calc(50% + var(--fr-ball-edge-gap) - var(--fr-ball-reader-inset)));clip-path:inset(-6px 50% -6px -6px);opacity:var(--fr-ball-collapsed-opacity,.52);}
.fr-floating-ball.manga-reader:not(.floating-ball-expanded):not(.dragging)[data-position="left"] :is(.floating-ball-manga,.floating-ball-main) {transform:translateX(calc(-50% - var(--fr-ball-edge-gap) + var(--fr-ball-reader-inset)));clip-path:inset(-6px -6px -6px 50%);opacity:var(--fr-ball-collapsed-opacity,.52);}
.fr-floating-ball .floating-ball-manga.manga-active,
.fr-floating-ball .floating-ball-manga:hover,
.fr-floating-ball .floating-ball-manga:focus-visible { opacity: 1; color: #ec4d7d; }
.fr-floating-ball .floating-ball-manga.manga-active {
  border-color:#ec4d7d;background:#fff7fa;
}
.manga-check {
  position: absolute; right: -4px; bottom: -4px; width: 19px; height: 19px;
  display: grid; place-items: center; border: 2px solid #fff; border-radius: 50%;
  background: #15803d; color: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); pointer-events: none;
}
.manga-check svg { width: 15px; height: 15px; }
.manga-check.manga-error { background: #b45309; }
.manga-progress {
  position: absolute; inset: 1px; border: 2px solid rgba(236,77,125,.18); pointer-events: none;
  border-top-color: #ec4d7d; border-right-color: #ec4d7d; border-radius: 50%; animation: fr-manga-spin 1.2s linear infinite;
}
.manga-icon {width:18px;height:18px;}
@keyframes fr-manga-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .manga-progress { animation: none; border-style: dotted; } }

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

.floating-ball-settings svg {
  width: var(--fr-ball-icon-size);
  height: var(--fr-ball-icon-size);
}

.translation-error,
.translation-progress {
  position: absolute;
  right: -2px;
  bottom: -2px;
  display: grid;
  width: 12px;
  height: 12px;
  place-items: center;
  border: 1px solid #fff;
  border-radius: 50%;
  background: #fff0f5;
  color: #bd2f62;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}

.translation-error {
  background: #fff4dd;
  color: #9a5d08;
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

<!--
 * @file src/features/floating-ball/ui/FloatingBall.vue
 * 文件职责：呈现可拖动的网页悬浮球，协调翻译状态、漫画入口、快捷面板与隐藏选项的交互。
 * 主要内容：以品牌按钮为固定停靠锚点，辅助工具沿其纵向中线展开并避让视口上下边缘；同一按钮支持原生点击、焦点和指针拖动，拖动预览按帧更新变换。
 * 模块边界：组件只拥有局部布局和交互；content/runtime 负责执行动作、订阅翻译状态与持久化位置，core/config 负责外观配置归一化。
 -->
<template>
  <div
    v-ui-i18n
    ref="floatingBall"
    class="fr-floating-ball"
    :class="{'floating-ball-expanded': isMenuExpanded, dragging: isDragging, 'is-touch-capable': touchSized,
      'is-compact': presentation.compact, 'is-tucked': dock.tucked, 'manga-reader': !!manga?.available, 'viewport-sync': syncingViewport}"
    :data-position="side"
    :data-tools-display="presentation.toolsDisplay"
    :data-translation-status="displayTranslationStatus"
    :data-theme="presentation.theme"
    :style="rootStyle"
    @pointerenter="handlePointerEnter"
    @pointerleave="handlePointerLeave"
    @pointermove="keepMangaToolsVisible"
    @focusin="handleFocusIn"
    @focusout="handleFocusOut"
    @pointerdown.capture="!isUserscript && handleBallPointerDown($event)"
    @keydown.esc="handleDocumentKeydown"
  >
    <button
      ref="floatingBallMain"
      class="floating-ball-main"
      type="button"
      :aria-disabled="presentation.clickAction === 'none' || undefined"
      :aria-label="mainActionLabel"
      :aria-pressed="mainTranslates ? isTranslating : undefined"
      :aria-busy="mainTranslates ? displayTranslationStatus === 'translating' : undefined"
      :aria-expanded="!isUserscript && presentation.clickAction === 'settings' ? popupOpen : undefined"
      :title="mainActionTitle"
      @pointerdown="startDrag"
      @lostpointercapture="cancelPointerInteraction"
      @click.stop="handleMainClick"
      @keydown="preventRepeatActivation"
    >
      <img v-if="logoUrl" class="floating-ball-mascot" :src="logoUrl" alt="" draggable="false" />
      <svg v-else class="floating-ball-mascot" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M16 8c-4-3-8-3-12-1v19c4-2 8-2 12 1m0-19c4-3 8-3 12-1v19c-4-2-8-2-12 1V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      </svg>
      <span v-if="mainTranslates && translationIndicator" class="translation-indicator" :data-status="displayTranslationStatus" aria-hidden="true">{{ translationIndicator }}</span>
    </button>

    <button
      v-if="manga?.available"
      class="floating-ball-manga"
      :class="{'manga-active': manga.active}"
      type="button"
      :aria-label="t(manga.areaFallback ? '圈选漫画翻译' : manga.active ? '暂停并显示原图' : '漫画翻译')"
      :aria-pressed="manga.active"
      :aria-busy="manga.pending"
      :title="mangaTitle"
      @click.stop="handleMangaClick"
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1V6Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M5.5 8.5h4v4h-2l-1.5 1v-1h-.5v-4Zm9.5.5h3m-3 3h3m-3 3h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span v-if="manga.active && !manga.pending && (manga.errors > 0 || (manga.completed ?? 0) > 0)" class="translation-indicator" :data-status="manga.errors ? 'error' : 'translated'" aria-hidden="true">{{ manga.errors ? '!' : '✓' }}</span>
      <span v-if="manga.pending" class="manga-progress" aria-hidden="true" />
    </button>

    <div
      v-for="stack in toolLayout.stacks"
      :key="stack.side"
      class="floating-ball-tools"
      :class="{'is-scrollable': stack.scrollable}"
      :data-stack="stack.side"
      :style="stack.style"
      :inert="!isMenuExpanded"
    >
      <button
        v-if="stack.tools.includes('translate')"
        class="floating-ball-tool floating-ball-translate"
        type="button"
        :aria-label="translationActionLabel"
        :aria-pressed="isTranslating"
        :aria-busy="displayTranslationStatus === 'translating'"
        :title="translationActionLabel"
        @click.stop="toggleTranslation"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 16 7 6l4 10m-6.7-3h5.4M14 8h8m-4-3v3m2.5 0c-.5 3.5-2.5 6.5-7 9m1.5-6c.8 2.2 3.5 4.7 6.5 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span v-if="translationIndicator" class="translation-indicator" :data-status="displayTranslationStatus" aria-hidden="true">{{ translationIndicator }}</span>
      </button>

      <button
        v-if="stack.tools.includes('reading')"
        class="floating-ball-tool floating-ball-reading"
        type="button"
        :aria-label="mangaReadingLabel"
        :aria-expanded="isMangaReadingOpen"
        :title="mangaReadingLabel"
        @click.stop="onMangaReading?.($event)"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 5h12M6 9.5h12M6 14h12M6 18.5h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
      </button>

      <button
        v-if="stack.tools.includes('settings')"
        class="floating-ball-tool floating-ball-settings"
        type="button"
        :aria-label="settingsActionLabel"
        :title="settingsActionLabel"
        :aria-expanded="isUserscript ? undefined : popupOpen"
        @click.stop="onSettingsClick($event)"
      >
        <svg viewBox="6 4 16 16" fill="none" aria-hidden="true">
          <path d="m19.43 12.98 1.25.98-1.5 2.6-1.5-.6a7.3 7.3 0 0 1-1.69.98L15.77 18h-3l-.22-1.06a7.3 7.3 0 0 1-1.69-.98l-1.5.6-1.5-2.6 1.25-.98a6.7 6.7 0 0 1 0-1.96l-1.25-.98 1.5-2.6 1.5.6a7.3 7.3 0 0 1 1.69-.98L12.77 6h3l.22 1.06c.6.24 1.16.57 1.69.98l1.5-.6 1.5 2.6-1.25.98a6.7 6.7 0 0 1 0 1.96Z" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
          <circle cx="14.27" cy="12" r="2.2" stroke="currentColor" stroke-width="1.35" />
        </svg>
      </button>

      <button
        v-if="stack.tools.includes('hide')"
        ref="hideButtons"
        class="floating-ball-tool floating-ball-hide"
        type="button"
        :aria-label="hideActionLabel"
        :aria-expanded="isUserscript ? undefined : hideMenuOpen"
        :aria-controls="!isUserscript && hideMenuOpen ? 'fr-floating-ball-hide-options' : undefined"
        :title="hideActionLabel"
        @click.stop="handleHideClick"
      >
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div
      v-if="!isUserscript && hideMenuOpen"
      id="fr-floating-ball-hide-options"
      ref="hidePanel"
      class="floating-ball-hide-panel"
      role="group"
      :aria-label="hideActionLabel"
      :style="hidePanelStyle"
    >
      <button v-for="scope in hideChoices" :key="scope" type="button" @click.stop="selectHideScope(scope, $event)">
        {{ translateMessage(`floatingBall.hide.${scope}`) }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch} from 'vue';
import type {CSSProperties} from 'vue';
import type {MangaTranslationStatus} from '@/src/features/image-translation/public';
import type {TranslationToolbarStatus} from '@/src/features/full-page-translation/public';
import type {FloatingBallHideScope, FloatingBallPresentation} from '@/src/features/floating-ball/types';
import {resolveFloatingBallCenterY, toFloatingBallVerticalPosition} from '@/src/features/floating-ball/position';
import {getSafeVisualViewportRect, observeVisualViewport} from '@/src/platform/dom/visualViewport';
import {useUiI18n} from '@/src/ui/i18n';

const {translateLegacy: t, t: translateMessage} = useUiI18n();
const isUserscript = import.meta.env.BROWSER === 'userscript';
const DRAG_THRESHOLD = 6;
const HOVER_EXIT_DELAY = 140;
const MANGA_IDLE_DELAY = 2500;
const EDGE_GAP = 6;
const TOOL_GAP = 4;

const props = withDefaults(defineProps<{
  position?: 'left' | 'right';
  verticalPosition?: number | null;
  showMenu?: boolean;
  logoUrl?: string;
  presentation?: Partial<FloatingBallPresentation>;
  onSettingsClick?: (event: MouseEvent) => void;
  onPositionChanged?: (side: 'left' | 'right', vertical: number) => void;
  onTranslationToggle?: (active: boolean) => void;
  canHideOnSite?: boolean;
  onHideMenuOpen?: () => void;
  onHide?: (scope: FloatingBallHideScope, event: MouseEvent) => void;
  manga?: MangaTranslationStatus;
  onMangaToggle?: (event: MouseEvent) => void;
  onMangaReading?: (event: MouseEvent) => void;
  mangaReadingOpen?: boolean;
  mangaReadingState?: {open: boolean};
  initialTranslating?: boolean;
  initialTranslationStatus?: TranslationToolbarStatus;
}>(), {
  position: 'right',
  verticalPosition: null,
  showMenu: true,
  logoUrl: '',
  onSettingsClick: () => {},
  initialTranslationStatus: 'idle',
});

const DEFAULT_PRESENTATION: FloatingBallPresentation = {
  toolsDisplay: 'hover',
  hoverDelay: 0,
  clickAction: 'translate',
  compact: false,
  settingsEntryVisible: true,
  collapsedOpacity: 36,
  defaultMargin: 0,
  popoutMargin: 20,
  theme: 'auto',
};
const presentation = computed(() => ({...DEFAULT_PRESENTATION, ...props.presentation}));
const side = ref(props.position);
const verticalPosition = ref(props.verticalPosition);
const floatingBall = ref<HTMLElement>();
const floatingBallMain = ref<HTMLButtonElement>();
const hideButtons = ref<HTMLButtonElement[]>([]);
const hideButton = computed(() => hideButtons.value[0]);
const hidePanel = ref<HTMLElement>();
const viewport = shallowRef(getSafeVisualViewportRect());
const syncingViewport = ref(false);
const hasTouch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
const touchSized = ref(hasTouch);
const hoverExpanded = ref(false);
const focusExpanded = ref(false);
const touchExpanded = ref(false);
const hideMenuOpen = ref(false);
const popupOpen = ref(false);
const isDragging = ref(false);
const isTranslating = ref(props.initialTranslating);
const translationStatus = ref(props.initialTranslationStatus);
const mainTranslates = computed(() => presentation.value.clickAction === 'translate');
const isAlwaysExpanded = computed(() => presentation.value.toolsDisplay === 'always');
const isMangaReadingOpen = computed(() => props.mangaReadingOpen || props.mangaReadingState?.open === true);
const isMenuExpanded = computed(() => !isDragging.value && (isAlwaysExpanded.value || hoverExpanded.value
  || focusExpanded.value || touchExpanded.value || isMangaReadingOpen.value || hideMenuOpen.value || popupOpen.value));

const showPageTools = computed(() => props.showMenu && presentation.value.toolsDisplay !== 'hidden');
const showTranslateTool = computed(() => showPageTools.value && !mainTranslates.value);
const showSettingsTool = computed(() => showPageTools.value && presentation.value.settingsEntryVisible
  && presentation.value.clickAction !== 'settings');
const showMangaReadingTool = computed(() => !!(props.manga?.available && props.manga.active && !props.manga.areaFallback && props.onMangaReading));

const hideChoices = computed<FloatingBallHideScope[]>(() => props.canHideOnSite ? ['page', 'site', 'global'] : ['page', 'global']);
const hideActionLabel = computed(() => translateMessage(isUserscript ? 'floatingBall.hide.page' : 'floatingBall.hide.title'));
const displayTranslationStatus = computed(() => isTranslating.value ? translationStatus.value : 'idle');
const translationIndicator = computed(() => ({idle: '', translating: '…', translated: '✓', error: '!'}[displayTranslationStatus.value]));
const translationActionLabel = computed(() => {
  const action = t(isTranslating.value ? '恢复网页原文' : '翻译整个网页');
  const key = {
    idle: '',
    translating: 'fullPage.progress.title',
    translated: 'fullPage.progress.completed',
    error: 'fullPage.progress.failuresTitle',
  }[displayTranslationStatus.value];
  return key ? `${action} · ${translateMessage(key)}` : action;
});
const mangaTitle = computed(() => {
  const manga = props.manga;
  if (manga?.areaFallback) return t('画布或分片漫画 · 拖选可见区域翻译');
  if (!manga?.active) return t('漫画翻译 · 自动翻译新页面');
  const message = manga.pending ? manga.message || '正在处理当前漫画页' : manga.errors ? '部分页面未完成' : '连续翻译已开启';
  return `${t(message)} · ${t('暂停并显示原图')}`;
});
const mangaReadingLabel = computed(() => t(isMangaReadingOpen.value ? '关闭漫画文字' : '查看漫画文字'));
const settingsActionLabel = computed(() => translateMessage(isUserscript
  ? 'settings.floatingBall.click.settings' : 'settings.floatingBall.click.quickPanel'));
const mainAction = computed(() => mainTranslates.value ? translationActionLabel.value
  : presentation.value.clickAction === 'settings' ? settingsActionLabel.value : '');
const mainActionLabel = computed(() => {
  const brand = translateMessage('common.brand');
  return mainAction.value ? `${brand} · ${mainAction.value}` : brand;
});
const mainActionTitle = computed(() => [mainAction.value, t('按住拖动调整位置')].filter(Boolean).join(' · '));

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

const compact = computed(() => presentation.value.compact || props.manga?.available);
const ballSize = computed(() => touchSized.value ? 44 : compact.value ? 30 : 34);
const toolSize = computed(() => touchSized.value ? 44 : compact.value ? 28 : 30);

// 主按钮独立停靠；工具增减和进度变化只影响工具栏的尺寸。
const dock = computed(() => {
  const bounds = viewport.value;
  const size = ballSize.value;
  const {defaultMargin, popoutMargin, toolsDisplay} = presentation.value;
  const dockX = (inset: number) => side.value === 'left' ? bounds.left + inset : bounds.right - size - inset;
  // 自定义负边距保留可拖动部分；触屏始终保留完整点击区。
  const min = touchSized.value ? 0 : Math.min(0, 28 - size);
  const max = bounds.width - size;
  // 桌面悬停模式的 0 / 正边距组合在闲置时半藏；相同边距保持原地。
  const tucked = !touchSized.value && toolsDisplay === 'hover' && defaultMargin === 0 && popoutMargin > 0;
  const restX = dockX(tucked ? -size / 2 : clamp(defaultMargin, min, max));
  const x = toolsDisplay === 'hover' && isMenuExpanded.value && !touchExpanded.value ? dockX(clamp(popoutMargin, min, max)) : restX;
  const y = bounds.top + resolveFloatingBallCenterY(verticalPosition.value, bounds.height, size) - size / 2;
  return {x, y, restX, tucked};
});

type Tool = 'translate' | 'reading' | 'settings' | 'hide';
type StackSide = 'above' | 'below';

const toolLayout = computed(() => {
  const bounds = viewport.value;
  const {x, y} = dock.value;
  const size = ballSize.value;
  const rowHeight = toolSize.value;
  const left = clamp(x + (size - rowHeight) / 2, bounds.left, bounds.right - rowHeight);
  const spaceAbove = y - bounds.top;
  const spaceBelow = bounds.bottom - y - size;
  // 漫画入口收起时也可点，展开后保留原来的纵向位置。
  const mangaBelow = spaceBelow >= size + TOOL_GAP || spaceBelow > spaceAbove;
  const mangaTop = clamp(mangaBelow ? y + size + TOOL_GAP : y - size - TOOL_GAP, bounds.top, bounds.bottom - size);
  const clusterTop = props.manga?.available ? Math.min(y, mangaTop) : y;
  const clusterBottom = props.manga?.available ? Math.max(y, mangaTop) + size : y + size;
  const stacksBySide = {
    above: {room: Math.max(0, clusterTop - bounds.top - TOOL_GAP), tools: [] as Tool[]},
    below: {room: Math.max(0, bounds.bottom - clusterBottom - TOOL_GAP), tools: [] as Tool[]},
  };

  const heightFor = (count: number) => count * rowHeight + Math.max(0, count - 1) * TOOL_GAP;
  const place = (tool: Tool, preferred: StackSide) => {
    const first = stacksBySide[preferred];
    const second = stacksBySide[preferred === 'above' ? 'below' : 'above'];
    const stack = first.room >= heightFor(first.tools.length + 1) ? first
      : second.room >= heightFor(second.tools.length + 1) ? second
      : first.room >= second.room ? first : second;
    stack.tools.push(tool);
  };

  // 优先留出主按钮下方的关闭入口。靠近上下边缘时，把放不下的工具排到另一侧。
  if (props.onHide) place('hide', 'below');
  if (showTranslateTool.value) place('translate', 'above');
  if (showMangaReadingTool.value) place('reading', 'above');
  if (showSettingsTool.value) place('settings', 'above');

  const stacks = (['above', 'below'] as const).flatMap(side => {
    const {room, tools} = stacksBySide[side];
    if (!tools.length || room === 0) return [];
    const fullHeight = heightFor(tools.length);
    const height = Math.min(room, fullHeight);
    const top = side === 'above' ? clusterTop - TOOL_GAP - height : clusterBottom + TOOL_GAP;
    return [{
      side, tools, left, top, height,
      scrollable: height < fullHeight,
      style: {left: `${left - x}px`, top: `${top - y}px`, maxHeight: `${height}px`},
    }];
  });
  return {stacks, mangaTop, top: Math.min(clusterTop, ...stacks.map(stack => stack.top)),
    bottom: Math.max(clusterBottom, ...stacks.map(stack => stack.top + stack.height))};
});

const rootStyle = computed<CSSProperties>(() => {
  const {x, y, restX, tucked} = dock.value;
  const bounds = viewport.value;
  const size = ballSize.value;
  const {mangaTop} = toolLayout.value;
  const collapsedRatio = clamp(presentation.value.collapsedOpacity, 20, 100) / 100;
  // 半隐停靠时进一步柔和透明度，保留 100% 明确设定与最低可见度；同时降低闲置图标饱和度减少干扰。
  const restOpacity = tucked ? Math.max(0.2, Number((collapsedRatio ** 1.3).toFixed(3))) : collapsedRatio;
  const restGrayscale = Number(clamp((1 - collapsedRatio) / 0.4, 0, 0.85).toFixed(3));
  return {
    '--fr-ball-x': `${x}px`,
    '--fr-ball-y': `${y}px`,
    '--fr-ball-size': `${size}px`,
    '--fr-logo-size': `${touchSized.value ? 26 : compact.value ? 22 : 25}px`,
    '--fr-tool-size': `${toolSize.value}px`,
    '--fr-tool-gap': `${TOOL_GAP}px`,
    '--fr-manga-y': `${mangaTop - y}px`,
    '--fr-manga-x': `${clamp(x, bounds.left, bounds.right - size) - x}px`,
    '--fr-ball-hit-left': `${Math.max(0, x - restX)}px`,
    '--fr-ball-hit-right': `${Math.max(0, restX - x)}px`,
    '--fr-ball-collapsed-opacity': String(restOpacity),
    '--fr-ball-collapsed-grayscale': String(restGrayscale),
  };
});

// 隐藏菜单向网页内侧打开，避免覆盖纵向工具，窄视口再使用整组工具的上下空间。
const hidePanelStyle = computed<CSSProperties>(() => {
  const bounds = viewport.value;
  const {x, y} = dock.value;
  const layout = toolLayout.value;
  const hideStack = layout.stacks.find(stack => stack.tools.includes('hide'));
  const anchorLeft = hideStack?.left ?? x;
  // 关闭按钮位于其工具组的最后一行。
  const anchorTop = hideStack ? hideStack.top + Math.max(0, hideStack.height - toolSize.value) : y;
  const width = Math.min(192, Math.max(1, bounds.width - 2 * EDGE_GAP));
  const preferredLeft = side.value === 'right' ? anchorLeft - EDGE_GAP - width : anchorLeft + toolSize.value + EDGE_GAP;
  const minLeft = bounds.left + EDGE_GAP;
  const maxLeft = bounds.right - EDGE_GAP - width;
  const otherLeft = side.value === 'right' ? anchorLeft + toolSize.value + EDGE_GAP : anchorLeft - EDGE_GAP - width;
  const idealHeight = hideChoices.value.length * (touchSized.value ? 44 : 34) + 12;
  let left = preferredLeft >= minLeft && preferredLeft <= maxLeft ? preferredLeft : otherLeft;
  let top = clamp(anchorTop, bounds.top + EDGE_GAP, bounds.bottom - EDGE_GAP - idealHeight);
  let maxHeight = Math.max(1, bounds.bottom - EDGE_GAP - top);
  if (left < minLeft || left > maxLeft) {
    const above = layout.top - bounds.top - 2 * EDGE_GAP;
    const below = bounds.bottom - layout.bottom - 2 * EDGE_GAP;
    left = clamp(x + (ballSize.value - width) / 2, minLeft, maxLeft);
    if (Math.max(above, below) >= (touchSized.value ? 44 : 32)) {
      maxHeight = Math.max(above, below);
      top = above > below ? layout.top - EDGE_GAP - Math.min(idealHeight, maxHeight) : layout.bottom + EDGE_GAP;
    }
  }
  return {left: `${left - x}px`, top: `${top - y}px`, width: `${width}px`, maxHeight: `${maxHeight}px`};
});

let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let mangaIdleTimer: ReturnType<typeof setTimeout> | undefined;
let lastMangaActivity = 0;

function clearHoverTimer() {
  clearTimeout(hoverTimer);
  hoverTimer = undefined;
}

function clearMangaTimer() {
  clearTimeout(mangaIdleTimer);
  mangaIdleTimer = undefined;
}

function expandBall() {
  if (isAlwaysExpanded.value || isDragging.value || hoverTimer !== undefined) return;
  const open = () => {
    hoverTimer = undefined;
    hoverExpanded.value = true;
    markMangaActivity();
  };
  const delay = presentation.value.hoverDelay;
  if (delay > 0) hoverTimer = setTimeout(open, delay);
  else open();
}

function handlePointerEnter(event: PointerEvent) {
  if (event.pointerType !== 'mouse') return;
  clearHoverTimer();
  if (!hoverExpanded.value) expandBall();
  else markMangaActivity();
}

function handlePointerLeave(event: PointerEvent) {
  if (event.pointerType !== 'mouse') return;
  clearHoverTimer();
  if (!hoverExpanded.value) return;
  // 给鼠标跨过按钮和工具栏之间的小间距留一点时间。
  hoverTimer = setTimeout(() => {
    hoverTimer = undefined;
    hoverExpanded.value = false;
  }, HOVER_EXIT_DELAY);
}

function handleFocusIn(event: FocusEvent) {
  focusExpanded.value = !!(event.target as HTMLElement)?.matches(':focus-visible');
  if (focusExpanded.value && !hoverExpanded.value) clearHoverTimer();
}

function handleFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null;
  if (!floatingBall.value?.contains(next)) focusExpanded.value = false;
  if (next !== hideButton.value && !hidePanel.value?.contains(next)) closeHideMenu();
}

/** 漫画连续翻译保留独立入口；指针闲置时收起工具，计时器在一段手势内复用。 */
function markMangaActivity() {
  if (!props.manga?.available || isAlwaysExpanded.value || isDragging.value) return;
  lastMangaActivity = performance.now();
  if (mangaIdleTimer !== undefined) return;
  const checkIdle = () => {
    mangaIdleTimer = undefined;
    if (focusExpanded.value || isMangaReadingOpen.value || !props.manga?.available) return;
    const remaining = MANGA_IDLE_DELAY - (performance.now() - lastMangaActivity);
    if (remaining > 0) {
      mangaIdleTimer = setTimeout(checkIdle, remaining);
      return;
    }
    clearHoverTimer();
    hoverExpanded.value = false;
    touchExpanded.value = false;
  };
  mangaIdleTimer = setTimeout(checkIdle, MANGA_IDLE_DELAY);
}

function keepMangaToolsVisible(event: PointerEvent) {
  if (!props.manga?.available || event.pointerType !== 'mouse' || isDragging.value) return;
  if (!hoverExpanded.value) expandBall();
  else markMangaActivity();
}

function handleMangaClick(event: MouseEvent) {
  props.onMangaToggle?.(event);
  markMangaActivity();
}

interface PointerGesture {
  id: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  bounds: ReturnType<typeof getSafeVisualViewportRect>;
  size: number;
  moved: boolean;
}

let gesture: PointerGesture | undefined;
let dragFrame: number | undefined;
let lastPointerType = '';
let suppressPointerClick = false;

/** 几何只在按下时读取；鼠标移动只更新坐标，渲染帧一次写入 transform 的参数。 */
function startDrag(event: PointerEvent) {
  if (gesture || event.isPrimary === false || event.button !== 0) return;
  const target = floatingBallMain.value;
  if (!target) return;
  const rect = target.getBoundingClientRect();
  lastPointerType = event.pointerType;
  suppressPointerClick = false;
  gesture = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    // 也允许从展开前的点击区拖动，抓取点限制在可见按钮内。
    offsetX: clamp(event.clientX - rect.left, 0, rect.width),
    offsetY: clamp(event.clientY - rect.top, 0, rect.height),
    x: rect.left,
    y: rect.top,
    bounds: viewport.value,
    size: rect.width || ballSize.value,
    moved: false,
  };
  window.addEventListener('pointermove', handlePointerMove, {capture: true, passive: true});
  window.addEventListener('pointerup', finishPointerInteraction, true);
  window.addEventListener('pointercancel', cancelPointerInteraction, true);
  window.addEventListener('blur', cancelActivePointerInteraction);
  window.addEventListener('pagehide', cancelActivePointerInteraction);
}

function moveGesture(current: PointerGesture, event: PointerEvent) {
  const {bounds, size} = current;
  current.x = clamp(event.clientX - current.offsetX, bounds.left, bounds.right - size);
  current.y = clamp(event.clientY - current.offsetY, bounds.top, bounds.bottom - size);
}

function paintDrag() {
  dragFrame = undefined;
  if (!gesture || !floatingBall.value) return;
  floatingBall.value.style.setProperty('--fr-drag-x', `${gesture.x}px`);
  floatingBall.value.style.setProperty('--fr-drag-y', `${gesture.y}px`);
  isDragging.value = true;
}

function handlePointerMove(event: PointerEvent) {
  const current = gesture;
  if (!current || current.id !== event.pointerId) return;
  if (!current.moved) {
    if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) <= DRAG_THRESHOLD) return;
    // 捕获只在确认拖动时启用，轻点仍由浏览器原生 click 判定。
    floatingBallMain.value?.setPointerCapture?.(current.id);
    suppressPointerClick = true;
    clearHoverTimer();
    clearMangaTimer();
    hoverExpanded.value = false;
    touchExpanded.value = false;
    closeHideMenu();
    current.moved = true;
  }

  moveGesture(current, event);
  dragFrame ??= window.requestAnimationFrame(paintDrag);
}

function finishPointerInteraction(event: PointerEvent) {
  const current = gesture;
  if (!current || current.id !== event.pointerId) return;
  const movedFar = Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > DRAG_THRESHOLD;
  if (current.moved || movedFar) {
    // pointerup 可能早于最后一个预览帧，按松手坐标提交，避免存到上一帧的位置。
    suppressPointerClick = true;
    moveGesture(current, event);
    const {bounds, size, x, y} = current;
    const nextSide = x + size / 2 < bounds.left + bounds.width / 2 ? 'left' : 'right';
    const nextVertical = toFloatingBallVerticalPosition(y + size / 2 - bounds.top, bounds.height);
    side.value = nextSide;
    verticalPosition.value = nextVertical;
    props.onPositionChanged?.(nextSide, nextVertical);
  }
  releaseGesture();
}

function releaseGesture() {
  const current = gesture;
  if (!current) return;
  gesture = undefined;
  const target = floatingBallMain.value;
  // 在释放捕获前清除事件所有权，避免随后的 lostpointercapture 再次撤销完成的操作。
  if (target?.hasPointerCapture?.(current.id)) target.releasePointerCapture(current.id);
  window.removeEventListener('pointermove', handlePointerMove, true);
  window.removeEventListener('pointerup', finishPointerInteraction, true);
  window.removeEventListener('pointercancel', cancelPointerInteraction, true);
  window.removeEventListener('blur', cancelActivePointerInteraction);
  window.removeEventListener('pagehide', cancelActivePointerInteraction);
  if (dragFrame !== undefined) window.cancelAnimationFrame(dragFrame);
  dragFrame = undefined;
  floatingBall.value?.style.removeProperty('--fr-drag-x');
  floatingBall.value?.style.removeProperty('--fr-drag-y');
  isDragging.value = false;
}

function cancelActivePointerInteraction() {
  if (!gesture) return;
  suppressPointerClick = true;
  releaseGesture();
}

function cancelPointerInteraction(event: PointerEvent) {
  if (gesture?.id === event.pointerId) cancelActivePointerInteraction();
}

function handleMainClick(event: MouseEvent) {
  if (event.detail > 0) {
    if (suppressPointerClick) {
      suppressPointerClick = false;
      return;
    }
    if (lastPointerType === 'touch' || lastPointerType === 'pen') {
      touchExpanded.value = true;
      markMangaActivity();
    }
  }
  if (mainTranslates.value) toggleTranslation();
  else if (presentation.value.clickAction === 'settings') props.onSettingsClick(event);
}

function preventRepeatActivation(event: KeyboardEvent) {
  if (event.repeat && presentation.value.clickAction !== 'none' && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
  }
}

function toggleTranslation() {
  props.onTranslationToggle?.(!isTranslating.value);
}

function setTranslationState(active: boolean) {
  isTranslating.value = active;
}

function setTranslationStatus(status: TranslationToolbarStatus) {
  translationStatus.value = status;
}

/** 同值广播不打断拖动；从其他页面收到新位置时先结束旧坐标系下的手势。 */
function setPosition(nextSide: 'left' | 'right', nextVertical: number | null) {
  if (nextSide === side.value && nextVertical === verticalPosition.value) return;
  cancelActivePointerInteraction();
  side.value = nextSide;
  verticalPosition.value = nextVertical;
}

defineExpose(isUserscript
  ? {toggleTranslation, setTranslationState, setTranslationStatus, setPosition}
  : {toggleTranslation, setTranslationState, setTranslationStatus, setPosition,
    setPopupOpen: (open: boolean) => {
      if (!open && popupOpen.value) touchExpanded.value = false;
      popupOpen.value = open;
    }});

function closeHideMenu(restoreFocus = false) {
  if (!hideMenuOpen.value) return;
  hideMenuOpen.value = false;
  if (restoreFocus) hideButton.value?.focus({preventScroll: true});
}

function handleHideClick(event: MouseEvent) {
  if (isUserscript) {
    props.onHide?.('page', event);
    return;
  }
  if (hideMenuOpen.value) {
    closeHideMenu();
    return;
  }
  hideMenuOpen.value = true;
  props.onHideMenuOpen?.();
  if (event.detail === 0) nextTick(() => hidePanel.value?.querySelector('button')?.focus({preventScroll: true}));
}

function selectHideScope(scope: FloatingBallHideScope, event: MouseEvent) {
  closeHideMenu();
  props.onHide?.(scope, event);
}

function handleBallPointerDown(event: PointerEvent) {
  if (!hideMenuOpen.value) return;
  const path = event.composedPath();
  if (!(hideButton.value && path.includes(hideButton.value)) && !(hidePanel.value && path.includes(hidePanel.value))) closeHideMenu();
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  clearHoverTimer();
  if (!hideMenuOpen.value && !hoverExpanded.value && !focusExpanded.value && !touchExpanded.value) return;
  if (hideMenuOpen.value) closeHideMenu(true);
  else {
    clearMangaTimer();
    if (focusExpanded.value) floatingBallMain.value?.focus({preventScroll: true});
    hoverExpanded.value = false;
    focusExpanded.value = false;
    touchExpanded.value = false;
  }
  event.stopPropagation();
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!touchExpanded.value && !hideMenuOpen.value) return;
  const root = floatingBall.value?.getRootNode();
  const boundary = root instanceof ShadowRoot ? root.host : floatingBall.value;
  if (!boundary || event.composedPath().includes(boundary)) return;
  touchExpanded.value = false;
  closeHideMenu();
}

let stopObservingViewport: (() => void) | undefined;
let viewportFrame: number | undefined;
let coarsePointer: MediaQueryList | undefined;
function syncPointerSize() {
  const next = hasTouch || !!coarsePointer?.matches;
  if (next !== touchSized.value) cancelActivePointerInteraction();
  touchSized.value = next;
}

function handleViewportChange() {
  cancelActivePointerInteraction();
  // 跟随键盘、缩放和平移时在同一帧更新命中位置；停靠过渡只用于可见的交互。
  syncingViewport.value = true;
  viewport.value = getSafeVisualViewportRect();
  if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = undefined;
    syncingViewport.value = false;
  });
}

onMounted(() => {
  coarsePointer = window.matchMedia?.('(any-pointer: coarse)');
  syncPointerSize();
  coarsePointer?.addEventListener('change', syncPointerSize);
  stopObservingViewport = observeVisualViewport(handleViewportChange);
  document.addEventListener('keydown', handleDocumentKeydown);
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
});
onBeforeUnmount(() => {
  clearHoverTimer();
  clearMangaTimer();
  releaseGesture();
  coarsePointer?.removeEventListener('change', syncPointerSize);
  stopObservingViewport?.();
  if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
  document.removeEventListener('keydown', handleDocumentKeydown);
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
});

watch(() => [props.position, props.verticalPosition] as const, ([nextSide, nextVertical]) => setPosition(nextSide, nextVertical));
watch(() => props.initialTranslating, setTranslationState);
watch(() => props.initialTranslationStatus, setTranslationStatus);
watch(ballSize, cancelActivePointerInteraction);
watch(() => presentation.value.toolsDisplay, () => {
  clearHoverTimer();
  clearMangaTimer();
  hoverExpanded.value = false;
  touchExpanded.value = false;
  closeHideMenu();
});
</script>

<style scoped>
.fr-floating-ball {
  --fr-surface: #ffffff;
  --fr-border: rgba(22, 27, 38, 0.14);
  --fr-ink: #161b26;
  --fr-accent: #cc2655;
  --fr-active: #fff1f5;
  --fr-shadow: 0 2px 8px rgba(17, 24, 39, 0.1);
  --fr-face-inset: 0px;
  color: var(--fr-ink);
  position: fixed;
  z-index: 2147483646;
  top: 0;
  left: 0;
  width: var(--fr-ball-size);
  height: var(--fr-ball-size);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  user-select: none;
  pointer-events: none;
  transform: translate3d(var(--fr-drag-x, var(--fr-ball-x)), var(--fr-drag-y, var(--fr-ball-y)), 0);
  transition: transform 180ms cubic-bezier(.22, 1, .36, 1);
}

.fr-floating-ball[data-theme="dark"] {
  --fr-surface: #171b24;
  --fr-border: rgba(240, 243, 248, 0.14);
  --fr-ink: #f0f3f8;
  --fr-accent: #ff7fa3;
  --fr-active: rgba(239, 71, 118, 0.18);
  --fr-shadow: 0 4px 12px rgba(0, 0, 0, 0.36);
}

@media (prefers-color-scheme: dark) {
  .fr-floating-ball:not([data-theme="light"]) {
    --fr-surface: #171b24;
    --fr-border: rgba(240, 243, 248, 0.14);
    --fr-ink: #f0f3f8;
    --fr-accent: #ff7fa3;
    --fr-active: rgba(239, 71, 118, 0.18);
    --fr-shadow: 0 4px 12px rgba(0, 0, 0, 0.36);
  }
}

.fr-floating-ball button {
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.fr-floating-ball button:focus-visible {
  outline: 2px solid var(--fr-accent);
  outline-offset: -3px;
}

.fr-floating-ball button:is(:hover, :focus-visible, [aria-pressed="true"], [aria-expanded="true"]) {
  color: var(--fr-accent);
}

.fr-floating-ball .floating-ball-hide-panel button:is(:hover, :focus-visible, [aria-pressed="true"], [aria-expanded="true"]) {
  background: var(--fr-active);
}

.fr-floating-ball .floating-ball-hide-panel {
  box-sizing: border-box;
  background-color: var(--fr-surface);
  box-shadow: inset 0 0 0 1px var(--fr-border), var(--fr-shadow);
}

.fr-floating-ball :is(.floating-ball-main, .floating-ball-manga) {
  position: absolute;
  width: var(--fr-ball-size);
  height: var(--fr-ball-size);
  border-radius: 11px;
  isolation: isolate;
  opacity: var(--fr-ball-collapsed-opacity);
  pointer-events: auto;
  transition: opacity 140ms ease;
}

.floating-ball-main {
  z-index: 1;
  inset: 0;
  color: var(--fr-accent);
  touch-action: none;
}

.floating-ball-main[aria-disabled="true"] { cursor: grab; }

.fr-floating-ball.is-touch-capable { --fr-face-inset: 4px; }

/* 触屏保留 44px 命中区，视觉底板收紧；收起时让网页透过控件的周边区域。 */
.fr-floating-ball :is(.floating-ball-main, .floating-ball-manga, .floating-ball-tool)::before {
  position: absolute;
  z-index: -1;
  inset: var(--fr-face-inset);
  border-radius: 11px;
  background: var(--fr-surface);
  box-shadow: inset 0 0 0 1px var(--fr-border), var(--fr-shadow);
  opacity: 0;
  pointer-events: none;
  transition: opacity 140ms ease;
  content: '';
}

.fr-floating-ball :is(.floating-ball-main, .floating-ball-manga, .floating-ball-tool):is(:hover, [aria-pressed="true"], [aria-expanded="true"])::before {
  background: var(--fr-active);
}

.fr-floating-ball.floating-ball-expanded :is(.floating-ball-main, .floating-ball-manga, .floating-ball-tool)::before,
.fr-floating-ball :is(.floating-ball-main, .floating-ball-manga):focus-visible::before,
.fr-floating-ball.dragging .floating-ball-main::before {
  opacity: 1;
}

/* 衔接主按钮的收起与展开位置；工具栏外的空白区域仍可操作网页。 */
.floating-ball-expanded .floating-ball-main::after {
  position: absolute;
  inset: 0 calc(-1 * var(--fr-ball-hit-right)) 0 calc(-1 * var(--fr-ball-hit-left));
  content: '';
}

.floating-ball-mascot {
  width: var(--fr-logo-size);
  height: var(--fr-logo-size);
  display: block;
  object-fit: contain;
  pointer-events: none;
  filter: grayscale(var(--fr-ball-collapsed-grayscale));
  transition: filter 140ms ease;
}

.floating-ball-manga {
  top: var(--fr-manga-y);
  left: var(--fr-manga-x);
}

.floating-ball-manga svg { width: 18px; height: 18px; }

.fr-floating-ball.floating-ball-expanded :is(.floating-ball-main, .floating-ball-manga),
.fr-floating-ball:not(.is-touch-capable) :is(.floating-ball-main, .floating-ball-manga):hover,
.fr-floating-ball :is(.floating-ball-main, .floating-ball-manga):focus-visible,
.fr-floating-ball.dragging .floating-ball-main {
  opacity: 1;
}

.fr-floating-ball.floating-ball-expanded .floating-ball-mascot,
.fr-floating-ball:not(.is-touch-capable) .floating-ball-main:hover .floating-ball-mascot,
.fr-floating-ball .floating-ball-main:focus-visible .floating-ball-mascot,
.fr-floating-ball.dragging .floating-ball-mascot {
  filter: none;
}

.floating-ball-tools {
  position: absolute;
  display: grid;
  width: var(--fr-tool-size);
  grid-auto-rows: var(--fr-tool-size);
  gap: var(--fr-tool-gap);
  opacity: 0;
  visibility: hidden;
  transition: opacity 150ms ease, visibility 0s linear 150ms;
}

.floating-ball-tools.is-scrollable {
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}

.floating-ball-expanded .floating-ball-tools {
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}

.floating-ball-tool {
  position: relative;
  isolation: isolate;
  width: var(--fr-tool-size);
  height: var(--fr-tool-size);
  border-radius: 10px;
}

.floating-ball-expanded :is(.floating-ball-tool, .floating-ball-tools.is-scrollable) {
  pointer-events: auto;
}

.floating-ball-tool svg { width: 17px; height: 17px; }
.is-touch-capable :is(.floating-ball-tool, .floating-ball-manga) svg { width: 20px; height: 20px; }

.translation-indicator {
  position: absolute;
  right: 2px;
  bottom: 2px;
  display: grid;
  width: 14px;
  height: 14px;
  place-items: center;
  border: 1px solid var(--fr-surface);
  border-radius: 50%;
  background: #15803d;
  color: #fff;
  font: 700 9px/1 system-ui, sans-serif;
  pointer-events: none;
}

.fr-floating-ball[data-position="right"] .floating-ball-main .translation-indicator,
.fr-floating-ball[data-position="right"] .floating-ball-manga .translation-indicator {
  left: 2px;
  right: auto;
}

.translation-indicator[data-status="error"] { background: #b45309; }
.translation-indicator[data-status="translating"] { background: var(--fr-accent); color: var(--fr-surface); }

.manga-progress {
  position: absolute;
  inset: 2px;
  border: 2px solid var(--fr-border);
  border-top-color: var(--fr-accent);
  border-radius: 50%;
  pointer-events: none;
  animation: fr-manga-spin 1.2s linear infinite;
}

@keyframes fr-manga-spin { to { transform: rotate(360deg); } }

.floating-ball-hide-panel {
  position: absolute;
  z-index: 2;
  display: grid;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--fr-border);
  border-radius: 12px;
  overflow: auto;
  overscroll-behavior: contain;
  pointer-events: auto;
}

.floating-ball-hide-panel button {
  display: block;
  min-height: 32px;
  padding: 5px 8px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.4;
  text-align: start;
}

.is-touch-capable .floating-ball-hide-panel button { min-height: 44px; }

.fr-floating-ball.dragging,
.fr-floating-ball.viewport-sync { transition: none; }
.fr-floating-ball.dragging .floating-ball-main { cursor: grabbing; }
.fr-floating-ball.dragging :is(.floating-ball-tools, .floating-ball-manga) { visibility: hidden; pointer-events: none; transition: none; }

@media (prefers-reduced-motion: reduce) {
  .fr-floating-ball, .fr-floating-ball *, .fr-floating-ball button::before { transition: none !important; }
  .manga-progress { animation: none; border-style: dotted; }
}
</style>

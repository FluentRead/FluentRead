<!--
 * @file src/features/full-page-translation/ui/TranslationProgressPanel.vue
 * 文件职责：以半透明工作面板和低存在感状态勾选展示全文翻译进度，并允许用户临时收起，同时跟随扩展主题与系统深浅色偏好。
 * 主要内容：组件订阅实时进度和配置更新，通过展示控制器延迟短任务的展开并等待连续空闲后收起；失败时保留完成/失败摘要和局部重试入口；按可视视口与安全区保持工作面板和触摸操作在软键盘上方，后台恢复后重新定位并在卸载时释放视口监听；弹窗等待时保留静态提示，仅剩离屏候选且悬浮球关闭或被站点名单隐藏时退化为淡勾选。
 * 模块边界：组件通过会话限定端口请求失败重试或定位，不直接发出翻译请求，也不保存业务进度；数据只来自 progress.ts，是否创建 Shadow UI 由 content/progressPanel.ts 决定，样式局限于组件作用域。
 -->
<template>
  <Transition name="fr-progress-panel">
    <aside
      v-if="isVisible"
      class="fr-translation-progress"
      :style="viewportStyle"
      :class="{ 'fr-dark': isDark, 'fr-static': !animationsEnabled, 'fr-modal-waiting': isModalWaiting, 'fr-compact': isCompact, 'fr-failed': hasFailures, 'fr-idle': progress.running === 0 && progress.queued === 0 }"
      :data-session-id="progress.sessionId"
      :data-running="progress.running"
      :data-remaining="progress.remaining"
      :data-queued="progress.queued"
      :data-offscreen="progress.offscreen"
      :data-deferred="progress.deferred"
      :data-modal-phase="progress.modalPhase"
      :data-completed="progress.completed ?? 0"
      :data-failed="progress.failed ?? 0"
      :data-retryable="progress.retryable ?? 0"
    >
      <span
        v-if="isCompact"
        class="fr-progress-compact-check"
        role="status"
        aria-live="polite"
        :aria-label="compactStatusLabel"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="9" />
          <path d="m5.8 10.2 2.5 2.5 5.8-6" />
        </svg>
      </span>

      <template v-else>
        <span v-if="hasFailures && progress.running === 0" class="fr-progress-warning" aria-hidden="true">!</span>
        <span v-else class="fr-progress-indicator" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>

        <span
          class="fr-progress-copy"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          :aria-label="statusLabel"
        >
          <strong>{{ panelTitle }}</strong>
          <span class="fr-progress-counts">
            <span>{{ t('fullPage.progress.running') }} <b>{{ progress.running }}</b></span>
            <span>{{ t('fullPage.progress.remaining') }} <b>{{ progress.remaining }}</b></span>
          </span>
          <span class="fr-progress-counts" v-if="(progress.completed ?? 0) > 0 || hasFailures">
            <span>{{ t('fullPage.progress.completed') }} <b>{{ progress.completed ?? 0 }}</b></span>
            <span>{{ t('fullPage.progress.failed') }} <b>{{ progress.failed ?? 0 }}</b></span>
          </span>
          <small v-if="isModalWaiting">
            {{ t('fullPage.progress.modalWaiting') }}
          </small>
          <small v-else-if="progress.offscreen > 0">
            {{ t('fullPage.progress.offscreenHint', {count: progress.offscreen}) }}
          </small>
        </span>

        <div v-if="hasFailures" class="fr-progress-actions">
          <button type="button" class="fr-progress-action" :disabled="!canRecover" @click="runFailureAction('retry')">{{ t('fullPage.progress.retryFailed') }}</button>
          <button type="button" class="fr-progress-action" :disabled="!canRecover" @click="runFailureAction('locate')">{{ t('fullPage.progress.locateFailed') }}</button>
        </div>

        <button type="button" class="fr-progress-dismiss" :aria-label="t('fullPage.progress.hide')" :title="t('fullPage.progress.hideTitle')" @click="dismiss">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 4 8 8m0-8-8 8" />
          </svg>
        </button>
      </template>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  getFullPageTranslationProgress,
  runFullPageFailureAction,
  type FullPageFailureAction,
  subscribeFullPageTranslationProgress,
} from '@/src/features/full-page-translation/progress';
import {config, subscribeConfig} from '@/src/services/config/store';
import {isFloatingBallDisabledOnSite} from '@/src/core/site-rules/domain';
import {useUiI18n} from '@/src/ui/i18n';
import {createProgressPanelVisibility, type ProgressPanelDisplayMode} from './progressPanelVisibility';
import {getSafeVisualViewportRect, observeVisualViewport} from '@/src/platform/dom/visualViewport';

const progress = ref(getFullPageTranslationProgress());
const dismissedSessionId = ref<number | null>(null);
const animationsEnabled = ref(config.animations !== false);
const configuredTheme = ref(config.theme || 'auto');
function isFloatingBallEnabled(source: typeof config): boolean {
  return source.disableFloatingBall !== true
    && !isFloatingBallDisabledOnSite(window.location.href, source.floatingBallDisabledDomains);
}
const floatingBallEnabled = ref(isFloatingBallEnabled(config));
const prefersDark = ref(false);
const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
const {t} = useUiI18n();

let unsubscribeProgress: (() => void) | null = null;
let unsubscribeConfig: (() => void) | null = null;
let unsubscribeViewport: (() => void) | null = null;
const viewport = ref(getSafeVisualViewportRect());
const viewportStyle = computed(() => {
  const bounds = viewport.value;
  const gap = bounds.width <= 420 ? 10 : 16;
  return {
    right: `${Math.max(0, window.innerWidth - bounds.right) + gap}px`,
    bottom: `${Math.max(0, window.innerHeight - bounds.bottom) + gap}px`,
    maxWidth: `${Math.max(1, bounds.width - gap * 2)}px`,
    maxHeight: `${Math.max(1, bounds.height - gap * 2)}px`,
  };
});

const isDark = computed(() => configuredTheme.value === 'dark' || (
  configuredTheme.value === 'auto' && prefersDark.value
));

const displayMode = ref<ProgressPanelDisplayMode>('hidden');
const visibility = createProgressPanelVisibility((mode) => { displayMode.value = mode; });
watch([progress, floatingBallEnabled, dismissedSessionId], () => {
  visibility.update(progress.value, floatingBallEnabled.value, progress.value.sessionId === dismissedSessionId.value);
}, {immediate: true, flush: 'sync'});
const isModalWaiting = computed(() => progress.value.modalPhase === 'waiting');
const hasFailures = computed(() => (progress.value.failed ?? 0) > 0);
const canRecover = computed(() => (progress.value.retryable ?? progress.value.failed ?? 0) > 0);
const panelTitle = computed(() => hasFailures.value && progress.value.running === 0 && progress.value.queued === 0
  ? t('fullPage.progress.failuresTitle')
  : progress.value.modalPhase === 'translating'
  ? t('fullPage.progress.modalTranslating')
  : t('fullPage.progress.title'));
const isCompact = computed(() => displayMode.value === 'compact');
const isVisible = computed(() => displayMode.value !== 'hidden');

const compactStatusLabel = computed(() => progress.value.offscreen > 0
  ? t('fullPage.progress.compactOffscreen', {count: progress.value.offscreen})
  : t('fullPage.progress.compactActive'));

const statusLabel = computed(() => {
  return t('fullPage.progress.aria', {
    running: progress.value.running,
    remaining: progress.value.remaining,
    offscreen: progress.value.offscreen,
  }) + (hasFailures.value ? ` · ${t('fullPage.progress.summaryAria', {completed: progress.value.completed ?? 0, failed: progress.value.failed ?? 0})}` : '');
});

function updatePreferredTheme(event?: MediaQueryListEvent): void {
  prefersDark.value = event?.matches ?? darkModeMediaQuery.matches;
}

function runFailureAction(action: FullPageFailureAction): void {
  if (canRecover.value) runFullPageFailureAction(progress.value.sessionId, action);
}

function dismiss(): void {
  dismissedSessionId.value = progress.value.sessionId;
}

onMounted(() => {
  unsubscribeViewport = observeVisualViewport(() => {viewport.value = getSafeVisualViewportRect();});
  updatePreferredTheme();
  darkModeMediaQuery.addEventListener('change', updatePreferredTheme);
  unsubscribeProgress = subscribeFullPageTranslationProgress((nextProgress) => {
    progress.value = nextProgress;
  });
  unsubscribeConfig = subscribeConfig((nextConfig) => {
    animationsEnabled.value = nextConfig.animations !== false;
    configuredTheme.value = nextConfig.theme || 'auto';
    floatingBallEnabled.value = isFloatingBallEnabled(nextConfig);
  });
});

onBeforeUnmount(() => {
  unsubscribeViewport?.();
  unsubscribeViewport = null;
  visibility.dispose();
  darkModeMediaQuery.removeEventListener('change', updatePreferredTheme);
  unsubscribeProgress?.();
  unsubscribeProgress = null;
  unsubscribeConfig?.();
  unsubscribeConfig = null;
});
</script>

<style scoped>
.fr-translation-progress {
  box-sizing: border-box;
  position: fixed;
  right: max(16px, env(safe-area-inset-right));
  bottom: max(16px, env(safe-area-inset-bottom));
  z-index: 2147483645;
  display: grid;
  overflow: auto;
  overscroll-behavior: contain;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  width: min(244px, calc(100vw - 32px));
  padding: 8px 8px 8px 10px;
  border: 1px solid rgba(22, 27, 38, 0.12);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 4px 16px rgba(17, 24, 39, 0.1);
  color: #161b26;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.4;
  pointer-events: auto;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.fr-progress-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 22px;
  height: 22px;
  color: #ef4776;
}

.fr-translation-progress.fr-compact {
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  grid-template-columns: 1fr;
  gap: 0;
  place-items: center;
  border-color: rgba(21, 128, 61, 0.22);
  border-radius: 50%;
  background: rgba(240, 253, 244, 0.88);
  box-shadow: 0 2px 8px rgba(17, 24, 39, 0.08);
  pointer-events: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.fr-progress-compact-check,
.fr-progress-compact-check svg {
  display: block;
  width: 16px;
  height: 16px;
}

.fr-progress-compact-check circle {
  fill: #15803d;
}

.fr-progress-compact-check path {
  fill: none;
  stroke: #ffffff;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.fr-progress-indicator i {
  display: block;
  width: 3px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
  animation: fr-progress-pulse 0.72s ease-in-out infinite alternate;
}

.fr-progress-indicator i:nth-child(2) {
  height: 14px;
  animation-delay: 0.16s;
}

.fr-progress-indicator i:nth-child(3) {
  height: 11px;
  animation-delay: 0.32s;
}

.fr-progress-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  overflow-wrap: anywhere;
}

.fr-progress-copy strong {
  color: #161b26;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.fr-progress-counts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 8px;
  color: #5b6476;
}

.fr-progress-counts b {
  color: #d4235a;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}

.fr-progress-copy small {
  color: #5b6476;
  font-size: 11px;
}

.fr-progress-dismiss {
  display: grid;
  grid-area: 1 / 3;
  place-items: center;
  align-self: start;
  width: 28px;
  height: 28px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #5b6476;
  cursor: pointer;
  transition: background-color 120ms cubic-bezier(.22, 1, .36, 1), color 120ms cubic-bezier(.22, 1, .36, 1);
}

.fr-progress-dismiss:hover,
.fr-progress-dismiss:focus-visible {
  background: #f6f7f9;
  color: #161b26;
  outline: none;
}

.fr-progress-dismiss:focus-visible {
  outline: 2px solid #d4235a;
  outline-offset: -2px;
}

.fr-progress-dismiss svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-width: 1.6;
}

.fr-progress-warning { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: #fef3c7; color: #92400e; font-size: 14px; font-weight: 700; }
.fr-progress-actions { display: grid; grid-area: 2 / 1 / auto / -1; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.fr-progress-action { min-height: 32px; border: 1px solid #d5dbe6; border-radius: 8px; padding: 3px 8px; background: #ffffff; color: #161b26; cursor: pointer; font: inherit; font-weight: 500; overflow-wrap: anywhere; transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease; }
.fr-progress-action:active:not(:disabled) { transform: scale(.98); }
.fr-progress-action:first-child { border-color: transparent; background: #fff0f5; color: #d4235a; font-weight: 600; }
.fr-progress-action:disabled { opacity: .45; cursor: default; }
.fr-progress-action:focus-visible { outline: 2px solid #d4235a; outline-offset: 2px; }
.fr-idle .fr-progress-indicator i { animation: none; }

.fr-dark {
  border-color: #272e3d;
  background: rgba(23, 27, 36, 0.86);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.38);
  color: #f0f3f8;
}

.fr-dark.fr-compact {
  border-color: rgba(74, 222, 128, 0.24);
  background: rgba(20, 45, 30, 0.85);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
}

.fr-dark .fr-progress-indicator {
  color: #ff7fa3;
}

.fr-dark .fr-progress-copy strong {
  color: #f0f3f8;
}

.fr-dark .fr-progress-counts {
  color: #9aa4b5;
}

.fr-dark .fr-progress-counts b {
  color: #ff7fa3;
}

.fr-dark .fr-progress-warning { background: rgba(245, 158, 11, 0.16); color: #fbbf24; }
.fr-dark .fr-progress-action { border-color: #272e3d; background: #1e2430; color: #f0f3f8; }
.fr-dark .fr-progress-action:first-child { border-color: transparent; background: rgba(239, 71, 118, 0.18); color: #ff7fa3; }

.fr-dark .fr-progress-copy small,
.fr-dark .fr-progress-dismiss {
  color: #9aa4b5;
}

.fr-dark .fr-progress-dismiss:hover,
.fr-dark .fr-progress-dismiss:focus-visible {
  background: #252c3b;
  color: #f0f3f8;
}

.fr-progress-panel-enter-active,
.fr-progress-panel-leave-active {
  transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.fr-progress-panel-enter-from,
.fr-progress-panel-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.fr-static .fr-progress-indicator i {
  animation: none;
}

.fr-modal-waiting .fr-progress-indicator i {
  animation: none;
  opacity: 0.58;
}

.fr-modal-waiting .fr-progress-indicator {
  color: #a87389;
}

.fr-static.fr-progress-panel-enter-active,
.fr-static.fr-progress-panel-leave-active {
  transition: none;
}

@keyframes fr-progress-pulse {
  from { transform: scaleY(0.5); opacity: 0.5; }
  to { transform: scaleY(1); opacity: 1; }
}

@media (max-width: 420px) {
  .fr-translation-progress {
    right: max(10px, env(safe-area-inset-right));
    bottom: max(10px, env(safe-area-inset-bottom));
    width: min(240px, calc(100vw - 20px));
  }
}

@media (any-pointer: coarse), (max-width: 420px) {
  .fr-progress-dismiss { width: 44px; height: 44px; touch-action: manipulation; }
  .fr-progress-action { min-width: 44px; min-height: 44px; touch-action: manipulation; }
}

@media (prefers-reduced-motion: reduce) {
  .fr-translation-progress,
  .fr-progress-indicator i {
    animation: none;
    transition: none;
  }
}
</style>

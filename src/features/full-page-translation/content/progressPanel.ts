/**
 * @file src/features/full-page-translation/content/progressPanel.ts
 * 文件职责：管理全文翻译进度面板在内容页中的异步 Shadow UI 生命周期，并依据配置开关、翻译活动状态和请求代次决定保留或清理挂载结果。
 * 主要内容：包含单例实例和 UI 句柄、ContentScriptContext 缓存、mountRequestId 所有权校验、Shadow Root 创建，以及面板和原生弹窗内提示的卸载清理。
 * 模块边界：该文件不计算进度也不渲染面板内容；状态发布归 progress.ts，视觉和关闭行为归 TranslationProgressPanel.vue，何时启用由 content composition root 和配置服务控制。
 */
import TranslationProgressPanel from '@/src/features/full-page-translation/ui/TranslationProgressPanel.vue';
import {config} from '@/src/services/config/store';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import {createVueShadowUi, type VueShadowMount} from '@/src/platform/shadow-ui';
import {syncModalTranslationHint} from '../ui/modalProgressHint';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import {dismissPageNotice, showPageNotice} from '@/src/features/page-notice/public';

let progressPanelInstance: unknown = null;
let progressPanelUi: ShadowRootContentScriptUi<VueShadowMount> | null = null;
let mountingPromise: Promise<unknown | null> | null = null;
let mountRequestId = 0;
let contentScriptContext: ContentScriptContext | null = null;
let mountRequested = false;
let unfinishedMounts = 0;
let retryWhenAvailable = false;
const MOUNT_WAIT_NOTICE = 'translation-progress-mount-wait';
let removeWaitVisibility: (() => void) | null = null;

function clearWaitNotice(): void {
  const remove = removeWaitVisibility;
  removeWaitVisibility = null;
  try {remove?.();} catch (error) {console.error('[FluentRead] 翻译进度面板恢复提示清理失败', error);}
  try {dismissPageNotice(MOUNT_WAIT_NOTICE);} catch (error) {console.error('[FluentRead] 翻译进度面板恢复提示清理失败', error);}
}

function announceMountWait(): void {
  const show = () => {
    try {showPageNotice(translate('fullPage.progress.mountPending', normalizeUiLanguage(config.uiLanguage)), 'error', {key: MOUNT_WAIT_NOTICE, durationMs: 10_000});}
    catch (error) {console.error('[FluentRead] 翻译进度面板恢复提示失败', error);}
  };
  if (document.visibilityState !== 'hidden') {show(); return;}
  let active = true;
  const reveal = () => {
    if (!active || document.visibilityState === 'hidden') return;
    const remove = removeWaitVisibility;
    removeWaitVisibility = null;
    try {remove?.();} catch (error) {console.error('[FluentRead] 翻译进度面板恢复提示清理失败', error);}
    if (mountRequested && config.on !== false && config.translationProgressPanelEnabled === true && !progressPanelUi) show();
  };
  document.addEventListener('visibilitychange', reveal);
  removeWaitVisibility = () => {active = false; document.removeEventListener('visibilitychange', reveal);};
}

function finishMountAttempt(): void {
  unfinishedMounts -= 1;
  if (retryWhenAvailable && unfinishedMounts < 2 && mountRequested && config.on !== false) {
    retryWhenAvailable = false;
    void mountTranslationProgressPanel();
  }
}

export function mountTranslationProgressPanel(ctx?: ContentScriptContext) {
  if (ctx) contentScriptContext = ctx;
  mountRequested = config.on !== false && config.translationProgressPanelEnabled === true;
  if (progressPanelUi || progressPanelInstance || mountingPromise || !mountRequested) {
    return mountingPromise;
  }
  if (!contentScriptContext || contentScriptContext.isInvalid) return;
  // WXT 创建不可取消；允许新一代越过一个卡住的旧请求，但限制重叠数量。
  if (unfinishedMounts >= 2) {
    const shouldNotify = !retryWhenAvailable;
    retryWhenAvailable = true;
    if (shouldNotify) {
      try {announceMountWait();} catch (error) {console.error('[FluentRead] 翻译进度面板恢复提示失败', error);}
    }
    return null;
  }
  retryWhenAvailable = false;
  const requestId = ++mountRequestId;
  unfinishedMounts += 1;
  let creation: ReturnType<typeof createVueShadowUi>;
  try { creation = createVueShadowUi(contentScriptContext, {
    name: 'fluent-read-translation-progress-ui',
    // 保留旧版 host id，继续兼容既有 DOM 排除规则和自动化定位。
    hostId: 'fluent-read-translation-status-container',
    component: TranslationProgressPanel,
    zIndex: 2_147_483_645,
  }); } catch (error) {
    console.error('[FluentRead] 翻译进度面板挂载失败', error);
    finishMountAttempt();
    return Promise.resolve(null);
  }
  const request = creation.then((ui) => {
    if (requestId !== mountRequestId || config.on === false || config.translationProgressPanelEnabled !== true) {
      ui.remove();
      return null;
    }
    progressPanelUi = ui;
    progressPanelInstance = ui.mounted?.instance ?? null;
    clearWaitNotice();
    return progressPanelInstance;
  }).catch((error) => {
    console.error('[FluentRead] 翻译进度面板挂载失败', error);
    return null;
  }).finally(() => {
    if (requestId === mountRequestId) mountingPromise = null;
    finishMountAttempt();
  });
  if (requestId === mountRequestId) mountingPromise = request;
  return request;
}

export function unmountTranslationProgressPanel(): void {
  syncModalTranslationHint(null, 'none', false);
  mountRequested = false;
  retryWhenAvailable = false;
  clearWaitNotice();
  mountRequestId += 1;
  mountingPromise = null;
  progressPanelUi?.remove();
  progressPanelUi = null;
  progressPanelInstance = null;
}

/**
 * @file src/features/floating-ball/content/runtime.ts
 * 文件职责：协调悬浮球组件在网页中的创建、恢复位置、显隐、全屏避让、高级外观同步、权威翻译状态同步和卸载，并向组件注入全文翻译、漫画连续翻译切换与打开设置页的动作。
 * 主要内容：维护单例 Shadow UI、迟到挂载 requestId、站点名单守卫、页面全屏显隐监听、响应式展示契约与配置订阅、全文活动及结果状态和漫画会话订阅，并将拖动后的停靠侧和纵向比例作为同一配置补丁保存；卸载入口只释放自身 UI，不恢复独立的全文会话。
 * 模块边界：运行时只拥有挂载和桥接职责，不实现拖拽视觉、外观归一化或全文翻译算法；FloatingBall.vue 负责交互，core/config 负责字段归一化，full-page feature 提供翻译动作，配置持久化通过 services/config 完成。
 */
import FloatingBall from '@/src/features/floating-ball/ui/FloatingBall.vue';
import type {FloatingBallPresentation} from '@/src/features/floating-ball/types';
import {config, requestConfigPatch, subscribeConfig} from '@/src/services/config/store';
import type {Config} from '@/src/core/config/model';
import {isFloatingBallDisabledOnSite} from '@/src/core/site-rules/domain';
import {reactive} from 'vue';
import {subscribeMangaTranslation, openMangaEntry, type MangaTranslationStatus} from '@/src/features/image-translation/public';
import browser from 'webextension-polyfill';
import {
  autoTranslateEnglishPage,
  getTranslationToolbarStatus,
  isFullPageTranslationActive,
  restoreOriginalContent,
  subscribeFullPageTranslationProgress,
  subscribeTranslationToolbarStatus,
  type TranslationToolbarStatus,
} from '@/src/features/full-page-translation/public';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import {createVueShadowUi, type VueShadowMount} from '@/src/platform/shadow-ui';

interface FloatingBallExposed {
  toggleTranslation: () => void;
  setTranslationState: (isTranslating: boolean) => void;
  setTranslationStatus: (status: TranslationToolbarStatus) => void;
  setPosition: (side: 'left' | 'right', verticalPosition: number | null) => void;
}

let floatingBallInstance: FloatingBallExposed | null = null;
let floatingBallUi: ShadowRootContentScriptUi<VueShadowMount> | null = null;
let mountingPromise: Promise<FloatingBallExposed | null> | null = null;
let mountRequestId = 0;
let contentScriptContext: ContentScriptContext | null = null;
let unsubscribeFullPageTranslationProgress: (() => void) | null = null;
let unsubscribeTranslationToolbarStatus: (() => void) | null = null;
let unsubscribePresentationConfig: (() => void) | null = null;
let floatingBallPresentation: FloatingBallPresentation | null = null;
let removeFullscreenListener: (() => void) | null = null;
let unsubscribeMangaTranslation: (() => void) | null = null;

/** 把实时配置折叠为组件需要的展示契约；字段语义与归一化都由 core/config 保证。 */
function readPresentation(source: Config): FloatingBallPresentation {
    return {
        toolsDisplay: source.floatingBallToolsDisplay,
        hoverDelay: source.floatingBallHoverDelay,
        clickAction: source.floatingBallClickAction,
        compact: source.floatingBallCompact === true,
        settingsEntryVisible: source.floatingBallSettingsEntryVisible !== false,
        collapsedOpacity: source.floatingBallCollapsedOpacity,
    };
}

/** 当前页面地址；内容脚本之外（测试、后台导入）没有 location 时按“无站点”处理。 */
function currentPageHref(): string {
    return typeof location === 'undefined' ? '' : location.href;
}

/** 悬浮球禁用网站只隐藏入口，扩展其余能力和快捷键仍然可用。 */
export function isFloatingBallAllowedOnPage(href: string = currentPageHref()): boolean {
    return !isFloatingBallDisabledOnSite(href, config.floatingBallDisabledDomains);
}

function openOptionsPage(): void {
    void browser.runtime.sendMessage({type: 'openOptionsPage'}).catch((error: unknown) => {
        console.error('[FluentRead] 打开设置页失败', error);
    });
}

/** 仅视频全屏时隐藏 Shadow 内的组件容器；宿主的 display 被基础样式锁定。 */
function subscribeFullscreenVisibility(ui: ShadowRootContentScriptUi<VueShadowMount>): () => void {
    if (typeof document === 'undefined') return () => {};

    const syncVisibility = () => {
        const fullscreenElement = document.fullscreenElement;
        const isVideoFullscreen = fullscreenElement != null
            && (fullscreenElement.matches('video') || fullscreenElement.querySelector('video') !== null);
        if (isVideoFullscreen) {
            ui.uiContainer.style.setProperty('display', 'none', 'important');
        } else {
            ui.uiContainer.style.removeProperty('display');
        }
    };
    document.addEventListener('fullscreenchange', syncVisibility, true);
    syncVisibility();
    return () => {
        document.removeEventListener('fullscreenchange', syncVisibility, true);
        ui.uiContainer.style.removeProperty('display');
    };
}

/** 创建并挂载悬浮球 */
export function mountFloatingBall(ctx?: ContentScriptContext) {
  if (ctx) contentScriptContext = ctx;

  // 配置禁用悬浮球、当前站点在悬浮球禁用名单中，或已存在实例时都不创建
  if (config.disableFloatingBall || !isFloatingBallAllowedOnPage()
    || floatingBallUi || floatingBallInstance || mountingPromise) {
    return mountingPromise;
  }

  if (!contentScriptContext) return;

  const ballPosition = config.floatingBallPosition || 'right';
  const requestId = ++mountRequestId;
  // 更新配置
  config.floatingBallPosition = ballPosition;
  // 展示契约是响应式对象，设置页改动无需重新挂载即可同步到已显示的悬浮球。
  const presentation = reactive(readPresentation(config));
  floatingBallPresentation = presentation;
  const manga = reactive<MangaTranslationStatus>({available: false, active: false, pending: false, errors: 0});
  const stopManga = subscribeMangaTranslation(status => Object.assign(manga, status));
  unsubscribeMangaTranslation = stopManga;

  mountingPromise = createVueShadowUi(contentScriptContext, {
    name: 'fluent-read-floating-ball-ui',
    hostId: 'fluent-read-floating-ball-container',
    component: FloatingBall,
    props: {
      position: ballPosition,
      verticalPosition: config.floatingBallVerticalPosition,
      showMenu: true,
      logoUrl: browser.runtime.getURL('/icon/128.png'),
      initialTranslating: isFullPageTranslationActive(),
      initialTranslationStatus: getTranslationToolbarStatus(),
      presentation,
      manga,
      onMangaToggle: (event: MouseEvent) => { if (event.isTrusted) openMangaEntry(); },
      onSettingsClick: () => openOptionsPage(),
      // 两个坐标字段必须一起提交，避免连续拖动或跨页面保存时只留下其中一个。
      onPositionChanged: (newPosition: 'left' | 'right', verticalPosition: number) => {
        void requestConfigPatch(
          {floatingBallPosition: newPosition, floatingBallVerticalPosition: verticalPosition},
          browser.runtime.sendMessage.bind(browser.runtime),
        ).catch((error: unknown) => console.error('Failed to save config:', error));
      },
      // 添加翻译状态变化事件监听
      onTranslationToggle: (isTranslating: boolean) => {
        if (isTranslating === isFullPageTranslationActive()) return;

        if (isTranslating) {
          autoTranslateEnglishPage();
        } else {
          restoreOriginalContent();
        }
      },
    },
    // 宿主页可以向开放的 Shadow Tree 派发合成点击，因此翻译、设置和位置控件必须留在 closed 边界内。
    mode: 'closed',
  }).then((ui) => {
    // 异步挂载返回时重新核对请求所有权，禁止已禁用的旧实例回到页面。
    if (requestId !== mountRequestId || config.disableFloatingBall || !isFloatingBallAllowedOnPage()) {
      ui.remove();
      return null;
    }

    floatingBallUi = ui;
    removeFullscreenListener?.();
    removeFullscreenListener = subscribeFullscreenVisibility(ui);
    // 订阅只服务当前实例；迟到的旧订阅不得继续写回已被替换的展示契约。
    unsubscribePresentationConfig?.();
    unsubscribePresentationConfig = subscribeConfig((nextConfig) => {
      if (floatingBallPresentation !== presentation) return;
      Object.assign(presentation, readPresentation(nextConfig));
      floatingBallInstance?.setPosition?.(nextConfig.floatingBallPosition, nextConfig.floatingBallVerticalPosition);
    });
    floatingBallInstance = (ui.mounted?.instance as FloatingBallExposed | null | undefined) ?? null;
    if (floatingBallInstance) {
      const instance = floatingBallInstance;
      unsubscribeFullPageTranslationProgress?.();
      unsubscribeFullPageTranslationProgress = subscribeFullPageTranslationProgress((progress) => {
        if (floatingBallInstance === instance) instance.setTranslationState(progress.active);
      });
      unsubscribeTranslationToolbarStatus = subscribeTranslationToolbarStatus((status) => {
        if (floatingBallInstance === instance) instance.setTranslationStatus(status);
      });
    }

    return floatingBallInstance;
  }).catch((error: unknown) => {
    console.error('[FluentRead] 悬浮球挂载失败', error);
    return null;
  }).finally(() => {
    if (!floatingBallUi || requestId !== mountRequestId) {
      stopManga();
      if (unsubscribeMangaTranslation === stopManga) unsubscribeMangaTranslation = null;
    }
    mountingPromise = null;
  });

  return mountingPromise;
}

/**
 * 通过隔离的 Vue 实例切换翻译，不使用 DOM CustomEvent。宿主页与内容脚本共享 DOM
 * 事件面，不能让页面脚本借此调用扩展动作。
 */
export function toggleFloatingBallTranslation(): boolean {
  if (!floatingBallInstance?.toggleTranslation) return false;
  floatingBallInstance.toggleTranslation();
  return true;
}

/**
 * 卸载悬浮球
 */
export function unmountFloatingBall() {
  // 先使仍在等待的挂载失效，再释放当前实例，避免迟到的 Promise 重新写回句柄。
  mountRequestId++;
  unsubscribeMangaTranslation?.();
  unsubscribeMangaTranslation = null;
  unsubscribeFullPageTranslationProgress?.();
  unsubscribeFullPageTranslationProgress = null;
  unsubscribeTranslationToolbarStatus?.();
  unsubscribeTranslationToolbarStatus = null;
  unsubscribePresentationConfig?.();
  unsubscribePresentationConfig = null;
  removeFullscreenListener?.();
  removeFullscreenListener = null;
  floatingBallPresentation = null;
  if (floatingBallUi || floatingBallInstance) {
    floatingBallUi?.remove();
    floatingBallUi = null;
    floatingBallInstance = null;
  }
}

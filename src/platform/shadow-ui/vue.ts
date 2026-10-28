/**
 * @file src/platform/shadow-ui/vue.ts
 *
 * 文件职责：把 Vue 应用挂载到扩展创建的隔离 Shadow DOM，并注入跨 feature 共享的基础样式与事件隔离设置。
 * 主要内容：定义 VueShadowMount 与 VueShadowUiOptions，把独立浮层宿主挂到 html 以跨越软导航的 body 替换，创建隔离样式和 app，将当前自有容器交给装配 hook；异步创建前后检查扩展上下文，释放失败构建的 app 与 DOM，并按挂载归属返回由 WXT 管理的资源句柄。
 * 模块边界：本文件属于 platform 基础设施边界，只封装浏览器、网络、存储上下文或 Shadow DOM 机制；不决定翻译业务策略，不直接实现 feature，业务层通过类型化端口消费这里的能力。
 */

import { createApp, type App as VueApp, type Component } from 'vue';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from 'wxt/utils/content-script-ui/shadow-root';
import {createUiI18nPlugin} from '@/src/ui/i18n';

export interface VueShadowMount {
  app: VueApp;
  instance: unknown;
}

export interface VueShadowUiOptions {
  name: string;
  hostId: string;
  component: Component;
  props?: Record<string, unknown> | ((container: HTMLElement) => Record<string, unknown>);
  zIndex?: number;
  mode?: 'open' | 'closed';
  /** 将当前 app 与本次挂载的自有容器交给调用方注册插件和组件；默认只安装基础 i18n。 */
  configureApp?: (app: VueApp, container: HTMLElement) => void;
  /** 让 Shadow UI 承载一个独立的全视口页面，而不是零尺寸浮层。 */
  viewport?: boolean;
}

function buildShadowFoundation(viewport = false): string {
  return `
  :host {
    all: initial !important;
    display: block !important;
    position: ${viewport ? 'fixed' : 'relative'} !important;
    ${viewport ? 'left: 0 !important; top: 0 !important; width: 100vw !important; height: 100vh !important; overflow: hidden !important;' : 'width: 0 !important; height: 0 !important; overflow: visible !important;'}
    contain: none !important;
    color-scheme: light dark;
  }

  html,
  body {
    width: 0 !important;
    height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: visible !important;
  }

  :host[data-fluent-read-viewport-ui="true"] {
    display: block !important;
    position: fixed !important;
    left: 0 !important;
    top: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    overflow: hidden !important;
    pointer-events: auto !important;
  }

  :host[data-fluent-read-viewport-ui="true"] > div {
    width: 100% !important;
    height: 100% !important;
    overflow: hidden !important;
  }

  :host([data-fluent-read-ui-suspended="true"]) {
    visibility: hidden !important;
    pointer-events: none !important;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
`;
}

/**
 * 把 Vue 组件挂载到隔离的 Shadow DOM。
 *
 * 步骤 1：WXT 负责 host 的生命周期和内容脚本失效清理。
 * 步骤 2：这里统一 Vue 的 mount/unmount，避免每个 feature 重复维护 glue。
 * 步骤 3：显式的 host 基础样式阻断宿主页的继承和裁剪影响。
 */
export async function createVueShadowUi(
  ctx: ContentScriptContext,
  options: VueShadowUiOptions,
): Promise<ShadowRootContentScriptUi<VueShadowMount>> {
  if (ctx.isInvalid) throw new DOMException('扩展上下文已失效', 'AbortError');
  let currentMount: VueShadowMount | undefined;
  let initialMount: VueShadowMount | null | undefined;
  // `viewport` 是 userscript 对 WXT Shadow UI 契约的扩展字段；扩展构建使用 WXT
  // 类型，userscript alias 使用本地兼容实现，因此在边界处保留运行时字段并收窄类型。
  const shadowUiOptions = {
    name: options.name,
    position: 'overlay',
    // Turbo 等软导航会在路由事件后替换整个 body；独立浮层放在 html 下，
    // 保留同一 Vue 实例和交互状态，清理仍由 WXT 与 feature 生命周期负责。
    anchor: 'html',
    alignment: 'top-left',
    zIndex: options.zIndex ?? 2_147_483_647,
    mode: options.mode ?? 'open',
    viewport: options.viewport,
    scopeRoot: options.viewport,
    inheritStyles: false,
    isolateEvents: ['keydown', 'keyup', 'keypress'],
    css: buildShadowFoundation(Boolean(options.viewport)),
    onMount(container) {
      const props = typeof options.props === 'function' ? options.props(container) : options.props ?? {};
      const app = createApp(options.component, props);
      const mounted: VueShadowMount = {app, instance: undefined};
      const previousChildren = new Set(container.childNodes ?? []);
      currentMount = mounted;
      if (initialMount === undefined) initialMount = mounted;
      try {
        if (options.configureApp) options.configureApp(app, container);
        else app.use(createUiI18nPlugin());
        if (ctx.isInvalid) throw new DOMException('扩展上下文已失效', 'AbortError');
        // 配置 hook 同步重装时，旧 app 不能再覆盖新 owner 的容器。
        if (currentMount === mounted) mounted.instance = app.mount(container);
        return mounted;
      } catch (error) {
        try { app.unmount(); } catch { /* 保留配置或 render 的原始错误。 */ }
        if (currentMount === mounted) {
          currentMount = undefined;
          for (const child of Array.from(container.childNodes ?? [])) {
            if (!previousChildren.has(child)) {
              try { child.parentNode?.removeChild(child); } catch { /* 继续释放其他节点并保留构建错误。 */ }
            }
          }
        }
        throw error;
      }
    },
    onRemove(mounted) {
      if (currentMount === mounted) currentMount = undefined;
      try { mounted?.app.unmount(); }
      catch (error) {
        // WXT 在此 hook 返回后才移除宿主和自己的样式；不能让 Vue 清理异常截断它。
        console.error('[FluentRead] Vue UI 卸载失败', error);
      }
    },
  } as Parameters<typeof createShadowRootUi<VueShadowMount>>[1] & {
    viewport?: boolean;
    scopeRoot?: boolean;
  };
  const ui = await createShadowRootUi<VueShadowMount>(ctx, shadowUiOptions);
  // WXT 创建 Shadow UI 会等待样式资源；期间失效的旧脚本不能重新挂载 Vue。
  if (ctx.isInvalid) {
    ui.remove();
    throw new DOMException('扩展上下文已失效', 'AbortError');
  }

  try {
    ui.shadowHost.id = options.hostId;
    ui.shadowHost.setAttribute('data-fluent-read-ui', options.name);
    if (options.viewport) ui.shadowHost.setAttribute('data-fluent-read-viewport-ui', 'true');
    ui.mount();
    // WXT 在 onMount 返回后才记录 mounted；Vue 同步挂载时失效需要再清理一次已返回的 app。
    if (ctx.isInvalid) throw new DOMException('扩展上下文已失效', 'AbortError');
  } catch (error) {
    // mount 端口可能在 app 已返回后抛错；新一代已接管时只保留新 UI。
    if (ctx.isInvalid || !ui.mounted || ui.mounted === initialMount) {
      try { ui.remove(); } catch { /* 清理失败不能覆盖构建错误。 */ }
    }
    throw error;
  } finally {
    initialMount = null;
  }
  return ui;
}

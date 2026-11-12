/**
 * @file src/app/popup/index.ts
 * 文件职责：连接 Popup HTML 的无框架预唤醒与配置就绪后的应用组装入口。
 * 主要内容：加载尺寸和皮肤样式，工具栏利用早期提示预取候选界面；页内 iframe 先完成授权，再动态载入配置与挂载模块。
 * 模块边界：提示只用于预取，不缓存、不渲染、不写入；未经授权的嵌入页不导入配置，mount.ts 从新配置快照决定实际界面。
 */
import './popup.css';
import 'element-plus/es/components/base/style/css';
import '@/src/ui/styles/interface-skins.css';
import '@/src/ui/styles/brand-icon.css';
import {isEmbeddedPopup, isPopupSurfaceActive, observeEmbeddedPopupSize, preparePopupSurface} from './embedded';
type PopupRuntime = {
  sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
  lastError?: unknown;
};

function prepareRoute(response: unknown): void {
  const result = response as {success?: boolean; uiLanguageSetupCompleted?: boolean} | null;
  if (result?.success !== true) return;
  // 提示过期最多多加载一个模块；配置 store 的新快照仍决定最终路由和页面内容。
  if (result.uiLanguageSetupCompleted === true) void import('./PopupApp.vue').catch(() => {});
  else if (result.uiLanguageSetupCompleted === false) void import('./PopupOnboarding.vue').catch(() => {});
}

function wakePopupWorker(): void {
  const globals = globalThis as typeof globalThis & {
    browser?: {runtime?: PopupRuntime};
    chrome?: {runtime?: PopupRuntime};
    __fluentReadPopupWarmup?: Promise<unknown>;
  };
  const message = {type: 'popupStartup'};
  try {
    if (globals.__fluentReadPopupWarmup) {
      void globals.__fluentReadPopupWarmup.then(prepareRoute).catch(() => {});
    } else if (globals.browser?.runtime) {
      void Promise.resolve(globals.browser.runtime.sendMessage(message)).then(prepareRoute).catch(() => {});
    } else if (globals.chrome?.runtime) {
      const runtime = globals.chrome.runtime;
      runtime.sendMessage(message, (response: unknown) => { if (!runtime.lastError) prepareRoute(response); });
    }
  } catch {
    // 正常配置读取负责失败与回退；预唤醒失败不能阻断挂载。
  }
}

export async function mountPopupApp(selector: string): Promise<void> {
  if (!await preparePopupSurface() || !isPopupSurfaceActive()) return;
  wakePopupWorker();
  const {mountPreparedPopupApp} = await import('./mount');
  if (!isPopupSurfaceActive()) return;
  await mountPreparedPopupApp(selector);
  if (isEmbeddedPopup()) observeEmbeddedPopupSize();
}

/**
 * @file src/features/selection-translation/content/runtime.ts
 * 文件职责：管理 SelectionTranslator Vue 覆盖层在内容脚本中的单例挂载、异步所有权校验与卸载，避免配置快速切换时旧 Promise 污染新实例。
 * 主要内容：缓存 ContentScriptContext，维护 mountRequestId、实例与 Shadow UI 句柄；普通翻译与学习卡片共用 closed Shadow Root，通过 modal host 控制器承接组件选区；观察自有 host 的祖先链，在页面重建时先由组件复核来源再有界恢复同一实例，并在关闭或卸载时停止恢复。
 * 模块边界：运行时只负责编排组件生命周期，不读取 Selection API、不调用翻译或 TTS；这些行为归 Vue 组件与控制器，Shadow DOM 创建由 platform/shadow-ui 提供。
 * 来源复核：祖先节点发生移除（如替换 body）时即使 host 仍连接也复核来源。
 */
import SelectionTranslator from '@/src/features/selection-translation/ui/SelectionTranslator.vue';
import { config } from '@/src/services/config/store';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import type { ShadowRootContentScriptUi } from 'wxt/utils/content-script-ui/shadow-root';
import {createVueShadowUi, type VueShadowMount} from '@/src/platform/shadow-ui';
import {createModalDialogHostController} from './modalDialogHost';

let selectionTranslatorInstance: any = null;
let selectionTranslatorUi: ShadowRootContentScriptUi<VueShadowMount> | null = null;
let mountingPromise: Promise<any> | null = null;
let mountRequestId = 0;
let contentScriptContext: ContentScriptContext | null = null;
let modalDialogHost: ReturnType<typeof createModalDialogHostController> | null = null;
let selectionHostRecovery: {selectionChanged(range: Range | null): void; dispose(): void} | null = null;

/** 使用已经由可信页面交互命中的范围，保留浏览器当前选区。 */
export function translateSelectionFromRange(range: Range): boolean {
  return selectionTranslatorInstance?.translateExplicitRange?.(range) === true;
}

/** 只观察 host 的祖先节点，不扫描正文子树；连续拒绝两次后等待下一次有效选区。 */
function watchSelectionHost(host: HTMLElement, requestId: number, context: ContentScriptContext) {
  if (!host?.ownerDocument || typeof MutationObserver === 'undefined') return null;
  const ownerDocument = host.ownerDocument;
  let range: Range | null = null;
  let repairs = 0;
  let disposed = false;
  let observed: Node[] = [];
  const sync = () => {
    if (disposed || requestId !== mountRequestId || context.isInvalid || !config.on
      || config.disableSelectionTranslator || config.selectionTranslatorMode === 'disabled') {
      observer.disconnect();
      return;
    }
    const parent = ownerDocument.body ?? ownerDocument.documentElement;
    if (!host.isConnected && repairs < 2 && parent?.isConnected) {
      repairs += 1;
      // Safari 已收起原生选区时，正文替换不一定再触发 selectionchange。
      // 由当前组件复用来源校验并取消失效请求，不能把旧卡片随 host 一起复活。
      selectionTranslatorInstance?.revalidateSource?.();
      // 原生 dialog 的迁移仍交给已有控制器；一般页面仅重新连接既有 host，不重建 Vue 或请求。
      modalDialogHost?.placeForRange(range);
      if (!host.isConnected) parent.appendChild(host);
    }
    const ancestors: Node[] = [];
    for (let node: Node | null = host.parentNode; node; node = node.parentNode) ancestors.push(node);
    // 即使 body 或 documentElement 暂时不存在，也保留文档层观察以等待可用挂载点。
    if (!ancestors.includes(ownerDocument)) ancestors.push(ownerDocument);
    if (ancestors.length === observed.length && ancestors.every((node, index) => node === observed[index])) return;
    observer.disconnect();
    observed = ancestors;
    for (const node of ancestors) observer.observe(node, {childList: true});
  };
  // host 挂在 html 下时替换 body 不会使其断开；祖先变化后仍复用来源校验收起已失效的卡片。
  const observer = new MutationObserver((records) => {
    // 仅新增节点（包括本模块重新接入 host）不会让来源失效，只有移除祖先子节点时才复核。
    if (host.isConnected && records.some(record => record.removedNodes.length > 0)) selectionTranslatorInstance?.revalidateSource?.();
    sync();
  });
  sync();
  return {
    selectionChanged(next: Range | null) {
      range = next;
      if (next) repairs = 0;
      sync();
    },
    dispose() { disposed = true; observer.disconnect(); observed = []; range = null; },
  };
}

/**
 * 挂载选词翻译组件
 */
export function mountSelectionTranslator(ctx?: ContentScriptContext) {
  if (ctx) contentScriptContext = ctx;

  // 如果已存在实例或配置禁用了此功能，则不创建
  if (selectionTranslatorInstance || mountingPromise || (config.disableSelectionTranslator || config.selectionTranslatorMode === 'disabled')) {
    return mountingPromise;
  }

  if (!contentScriptContext) return;

  const requestId = ++mountRequestId;
  mountingPromise = createVueShadowUi(contentScriptContext, {
    name: 'fluent-read-selection-translator-ui',
    hostId: 'fluent-read-selection-translator-container',
    component: SelectionTranslator,
    zIndex: 2_147_483_646,
    // 词卡包含复制、朗读和翻译动作，closed root 防止宿主页通过合成 DOM 事件调用这些能力。
    mode: 'closed',
    props: {
      onSelectionRangeChange: (range: Range | null) => {
        if (requestId !== mountRequestId) return;
        modalDialogHost?.placeForRange(range);
        selectionHostRecovery?.selectionChanged(range);
      },
      onFocusedCardDismiss: () => {
        if (requestId !== mountRequestId) return;
        modalDialogHost?.restoreFromFocusedCard();
      },
    },
  }).then((ui) => {
    // 异步创建结束后复核代次和开关，旧请求不得覆盖较新的挂载状态。
    if (requestId !== mountRequestId || (config.disableSelectionTranslator || config.selectionTranslatorMode === 'disabled')) {
      ui.remove();
      return null;
    }

    ui.shadowHost?.style?.setProperty('position', 'static', 'important');
    modalDialogHost = ui.shadowHost?.style
      ? createModalDialogHostController(ui.shadowHost)
      : null;
    selectionTranslatorUi = ui;
    selectionTranslatorInstance = ui.mounted?.instance ?? null;
    selectionHostRecovery = watchSelectionHost(ui.shadowHost, requestId, contentScriptContext!);
    return selectionTranslatorInstance;
  }).finally(() => {
    if (requestId === mountRequestId) mountingPromise = null;
  });

  return mountingPromise;
}

/**
 * 卸载选词翻译组件
 */
export function unmountSelectionTranslator() {
  // 先使未完成的挂载失效，再清空 UI 与实例引用。
  mountRequestId++;
  mountingPromise = null;
  selectionHostRecovery?.dispose();
  selectionHostRecovery = null;
  modalDialogHost?.dispose();
  modalDialogHost = null;
  selectionTranslatorUi?.remove();
  selectionTranslatorUi = null;
  selectionTranslatorInstance = null;
}

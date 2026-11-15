/**
 * @file src/features/personal-corrections/content/runtime.ts
 * 文件职责：把网页译文上的主动校订入口接入既有内容脚本生命周期。
 * 主要内容：根据指针或焦点选中已翻译原译文对，用快捷键或独立浮层入口打开编辑器；封闭 Shadow UI 懒挂载，失效时归还节点与观察器所有权，保证同节点重译后可再次观察，失效代次与 AbortSignal 清理监听和迟到挂载。
 * 模块边界：只读宿主译文发现，不把按钮插入翻译容器；原译文读取和刷新通过全文翻译公开端口注入，存储由 services 公共接口负责。
 */
import type {ContentScriptContext} from 'wxt/utils/content-script-context';
import {createVueShadowUi} from '@/src/platform/shadow-ui';
import {createPersonalCorrectionController} from '../controller';
import type {PersonalCorrectionUiPorts} from '../types';
import PersonalCorrectionPanel from '../ui/PersonalCorrectionPanel.vue';

let owner: {dispose(): void} | undefined;
export function unmountPersonalCorrections(): void {owner?.dispose();}

export function mountPersonalCorrections(ctx: ContentScriptContext, signal: AbortSignal, ports: PersonalCorrectionUiPorts): () => void {
  if (owner || signal.aborted || ctx.isInvalid) return () => {};
  let active = true; let ui: Awaited<ReturnType<typeof createVueShadowUi>> | undefined;
  let mounting: Promise<void> | undefined; let failures = 0;
  let selectedElement: Element | undefined; let pairObserver: MutationObserver | undefined;
  const current = () => active && !signal.aborted && !ctx.isInvalid;
  const controller = createPersonalCorrectionController(ports, current);
  function ensureUi(): void {
    if (ui && !ui.shadowHost.isConnected) {try {ui.remove();} catch { /* 已失效宿主不妨碍释放归属。 */ } ui = undefined; failures += 1;}
    if (!current() || ui || mounting || failures >= 2) return;
    mounting = createVueShadowUi(ctx, {name: 'fluent-read-personal-corrections', hostId: 'fluent-read-personal-corrections',
      mode: 'closed', component: PersonalCorrectionPanel, props: {controller}})
      .then(mounted => {if (current()) ui = mounted; else mounted.remove();})
      .catch(() => {failures += 1; controller.close();})
      .finally(() => {mounting = undefined;});
  }
  function discover(event: Event): void {
    if (!current()) return;
    if (ui && !ui.shadowHost.isConnected) ensureUi();
    if (controller.state.open) return;
    if (controller.state.candidate && !controller.state.candidate.isCurrent()) controller.state.candidate = null;
    const path = event.composedPath();
    const element = path.find(node => node instanceof Element && node.matches('.fluent-read-bilingual-content'))
      ?? (event.target instanceof Element ? event.target.closest('.fluent-read-bilingual-content') : null);
    if (!(element instanceof Element)) return;
    const pair = ports.readPair(element);
    if (!pair || !pair.isCurrent()) return;
    controller.state.candidate = pair;
    if (selectedElement !== element) {
      selectedElement = element; pairObserver?.disconnect();
      const observer = new MutationObserver(() => {
        // 切换节点会同步替换观察器，清理会同时释放两者；观察器身份已能唯一确定节点归属。
        if (pairObserver !== observer) return;
        if (current() && !pair.isCurrent()) {
          controller.state.candidate = null; controller.close(); observer.disconnect();
          pairObserver = undefined; selectedElement = undefined;
        }
      });
      pairObserver = observer;
      observer.observe(element.parentElement ?? element, {childList: true, characterData: true, subtree: true});
    }
    ensureUi();
  }
  function keydown(event: KeyboardEvent): void {
    if (!current() || controller.state.open || !event.isTrusted || event.repeat || event.defaultPrevented || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.code !== 'KeyE') return;
    if (event.composedPath().some(node => node instanceof Element && (node.matches('input,textarea,select') || node.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[data-fluent-read-ui]')))) return;
    discover(event);
    const candidate = controller.state.candidate;
    if (!candidate?.isCurrent()) {controller.state.candidate = null; return;}
    event.preventDefault(); ensureUi(); void controller.open(candidate);
  }
  const instance = {dispose() {
    if (!active) return;
    active = false; controller.dispose(); pairObserver?.disconnect(); pairObserver = undefined; selectedElement = undefined;
    document.removeEventListener('pointerover', discover, true); document.removeEventListener('focusin', discover, true);
    document.removeEventListener('keydown', keydown, true); signal.removeEventListener('abort', instance.dispose);
    try {ui?.remove();} catch { /* 扩展重载后仍继续释放监听器和单例。 */ }
    // owner 非空时 mount 拒绝新实例，只有本次清理可以释放它。
    finally {ui = undefined; owner = undefined;}
  }};
  owner = instance;
  document.addEventListener('pointerover', discover, true); document.addEventListener('focusin', discover, true);
  document.addEventListener('keydown', keydown, true); signal.addEventListener('abort', instance.dispose, {once: true});
  return instance.dispose;
}

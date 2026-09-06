<!--
 * @file src/features/area-translation/ui/AreaTranslator.vue
 * 文件职责：提供独立圈选阅读工具，按 Shift+Z 进入选区模式，松开鼠标后展示可核对、可复制的原文与译文卡片。
 * 主要内容：管理选择、截图、识别、翻译、结果和失败状态；缺少语言包时一键下载后续接原截图，重试复用同一截图，取消或新选区使旧请求失效，卡片显示本次服务与模型，支持原图核对、AI 校对文和清晰的质量说明。
 * 模块边界：组件只调用圈选客户端，不执行 OCR 或网络请求；截图权限归后台，像素只在封闭 Shadow UI 展示，所有页面监听、异步状态与临时截图在关闭或卸载时清理。
 -->
<template>
  <div v-ui-i18n v-show="phase !== 'idle'" class="fr-area-translator-root" :class="{'fr-area-dark': isDarkTheme}" @pointerdown.stop>
    <div v-if="isSelecting" class="fr-area-selecting" aria-label="拖拽选择翻译区域">
      <div class="fr-area-hint" role="status">拖拽选择区域 · 松开鼠标翻译 · Esc 取消</div>
      <div v-if="selectionRect" class="fr-area-selection" :style="areaStyle(selectionRect)" aria-hidden="true" />
    </div>
    <section v-else-if="activeRect && !capturePending" class="fr-area-panel" :style="panelStyle(activeRect)" :class="{'fr-area-error': phase === 'error'}" role="dialog" :aria-label="translateLegacy('圈选翻译结果')">
      <header class="fr-area-toolbar">
        <div class="fr-area-heading">
          <div class="fr-area-title-row">
            <strong>圈选翻译</strong>
            <span v-if="result" class="fr-area-mode">{{ result.mode === 'ai' ? 'AI 文本增强' : '本地识别翻译' }}</span>
          </div>
          <div v-if="result" class="fr-area-provider" data-i18n-ignore>
            <span>{{ isCustomOpenAIProviderId(result.service) ? result.serviceName : translateLegacy(result.serviceName) }}</span>
            <span v-if="result.model" class="fr-area-model"> · {{ result.model }}</span>
          </div>
        </div>
        <button type="button" aria-label="关闭圈选翻译结果" title="关闭" @click="clearResult">×</button>
      </header>
      <div v-if="phase === 'loading'" class="fr-area-loading" role="status" aria-live="polite">
        <span class="fr-area-spinner" :class="{'fr-area-static': !animationsEnabled}" aria-hidden="true" />
        <span>{{ preparingLanguages ? '下载中…' : progressStage === 'translating' ? '正在翻译选区文字…' : '正在识别选区文字…' }}</span>
        <button type="button" @click="clearResult">取消</button>
      </div>
      <div v-else-if="phase === 'error'" class="fr-area-error-body" role="alert">
        <strong>圈选翻译失败</strong>
        <p>{{ errorMessage }}</p>
        <div class="fr-area-actions">
          <button v-if="needsLanguages" type="button" @click="downloadLanguagesAndRetry">下载语言包并重试</button>
          <button v-else type="button" @click="retryTranslation">重试</button>
          <button type="button" @click="beginSelection">重新圈选</button>
          <button type="button" @click="openSettings">圈选设置</button>
        </div>
      </div>
      <template v-else-if="result">
        <div class="fr-area-content">
          <section class="fr-area-text-block">
            <div class="fr-area-text-heading"><span>译文</span><button type="button" @click="copyText(result.translatedText)">复制译文</button></div>
            <p data-i18n-ignore class="fr-area-translation" dir="auto">{{ result.translatedText }}</p>
          </section>
          <details class="fr-area-source">
            <summary>识别原文</summary>
            <button type="button" @click="copyText(result.sourceText)">复制原文</button>
            <p data-i18n-ignore dir="auto">{{ result.sourceText }}</p>
          </details>
          <details v-if="result.correctedText && result.correctedText !== result.sourceText" class="fr-area-source">
            <summary>AI 校对文</summary>
            <p class="fr-area-note">AI 根据文字上下文校对，请与识别原文核对。</p>
            <p data-i18n-ignore dir="auto">{{ result.correctedText }}</p>
          </details>
          <details class="fr-area-source"><summary>查看选区原图</summary><img :src="result.image" alt="选区原图" draggable="false" /></details>
          <p class="fr-area-note" role="note">{{ result.mode === 'ai' ? 'AI 仅处理识别文字，无法找回图片中的漏字；请核对名称和数字。' : '本地识别可能遗漏模糊、手写或复杂排版的文字，翻译质量也会受影响。' }}</p>
        </div>
        <footer class="fr-area-actions">
          <button type="button" @click="beginSelection">重新圈选</button>
          <button type="button" @click="retryTranslation">重新翻译</button>
          <button type="button" @click="openSettings">圈选设置</button>
        </footer>
      </template>
      <p v-if="feedback" class="fr-area-feedback" role="status" aria-live="polite">{{ feedback }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import browser from 'webextension-polyfill';
import { config, subscribeConfig } from '@/src/services/config/store';
import { isCustomOpenAIProviderId } from '@/src/core/config/customOpenAI';
import { useUiI18n } from '@/src/ui/i18n';
import { captureVisibleAreaInExtension, translateCapturedAreaInExtension, type AreaTranslationResult } from '@/src/features/area-translation/services/client';
import { isAreaHotkey, isUsableAreaRect, normalizeAreaRect, type AreaPoint, type AreaRect, type AreaTranslationSelection } from '@/src/features/area-translation/core';
import {prepareImageOcrLanguages} from '@/src/features/image-translation/public';
import type { ImageTranslationStage } from '@/src/features/image-translation/protocol';

const {translateLegacy} = useUiI18n();
type AreaPhase = 'idle' | 'selecting' | 'loading' | 'translated' | 'error';
const phase = ref<AreaPhase>('idle');
const selectionRect = ref<AreaRect | null>(null);
const activeRect = ref<AreaRect | null>(null);
const result = ref<AreaTranslationResult | null>(null);
const errorMessage = ref('');
const needsLanguages = ref(false);
const preparingLanguages = ref(false);
let requestedSourceLanguage = config.from;
const feedback = ref('');
const isDarkTheme = ref(false);
const animationsEnabled = ref(config.animations !== false);
const capturePending = ref(false);
const progressStage = ref<ImageTranslationStage>('recognizing');
const isSelecting = computed(() => phase.value === 'selecting');
let startPoint: AreaPoint | null = null;
let activePointerId: number | null = null;
let translationRequestId = 0;
let translationAbortController: AbortController | null = null;
let systemThemeMedia: MediaQueryList | null = null;
// 截图仅供本次选区重试使用，永不写入存储。成功后换成裁剪原图，释放整屏像素字符串。
let capturedImage = '';
let capturedSelection: AreaTranslationSelection | null = null;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

function areaStyle(rect: AreaRect): Record<string, string> {
  return {left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`};
}
function panelStyle(rect: AreaRect): Record<string, string> {
  const width = Math.min(460, Math.max(1, window.innerWidth - 24));
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const below = rect.top + rect.height + 10;
  const top = Math.max(12, Math.min(below + 220 < window.innerHeight ? below : rect.top, window.innerHeight - 240));
  return {left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${Math.max(1, window.innerHeight - top - 12)}px`};
}
function updateTheme(): void {
  isDarkTheme.value = config.theme === 'dark' || (config.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function isInsideExtensionUi(target: EventTarget | null): boolean {
  const host = document.getElementById('fluent-read-area-translator-container');
  return Boolean(host && target instanceof Node && host.contains(target));
}
function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : document.activeElement;
  if (!(element instanceof HTMLElement)) return false;
  return element.isContentEditable || Boolean(element.closest('[contenteditable="true"], [contenteditable="plaintext-only"]'))
    || ['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(element.tagName);
}
function isEditingInPage(event: KeyboardEvent): boolean {
  if (event.composedPath().some(isEditableTarget)) return true;
  // 封闭网页 ShadowRoot 隐藏真实输入节点；已聚焦的容器按交互控件保守处理。
  const focused = document.activeElement;
  return focused instanceof HTMLElement && focused === event.target
    && !['BODY', 'HTML', 'A', 'BUTTON'].includes(focused.tagName);
}
function isEnabled(): boolean { return config.on !== false && config.selectionAreaEnabled === true; }
function clearResult(): void {
  translationRequestId += 1;
  translationAbortController?.abort();
  translationAbortController = null;
  capturePending.value = false;
  startPoint = null;
  activePointerId = null;
  phase.value = 'idle';
  selectionRect.value = null;
  activeRect.value = null;
  result.value = null;
  errorMessage.value = '';
  needsLanguages.value = false;
  preparingLanguages.value = false;
  capturedImage = '';
  capturedSelection = null;
  clearTimeout(feedbackTimer);
  feedback.value = '';
}
function beginSelection(): void {
  clearResult();
  if (isEnabled()) phase.value = 'selecting';
}
function handleKeydown(event: KeyboardEvent): void {
  if (!event.isTrusted) return;
  if (event.key === 'Escape' && phase.value !== 'idle') {
    event.preventDefault();
    clearResult();
    return;
  }
  if (!isEnabled() || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
    || !isAreaHotkey(event) || isInsideExtensionUi(event.target) || isEditingInPage(event)) return;
  event.preventDefault();
  beginSelection();
}
function pointFromEvent(event: PointerEvent): AreaPoint {
  return {x: Math.min(window.innerWidth, Math.max(0, event.clientX)), y: Math.min(window.innerHeight, Math.max(0, event.clientY))};
}
function handlePointerdown(event: PointerEvent): void {
  if (!event.isTrusted) return;
  if (!isSelecting.value || activePointerId !== null || event.button !== 0 || !isEnabled()) return;
  event.preventDefault();
  event.stopPropagation();
  activePointerId = event.pointerId;
  startPoint = pointFromEvent(event);
  selectionRect.value = {left: startPoint.x, top: startPoint.y, width: 0, height: 0};
}
function handlePointermove(event: PointerEvent): void {
  if (!event.isTrusted) return;
  if (!isSelecting.value || !startPoint || activePointerId !== event.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  selectionRect.value = normalizeAreaRect(startPoint, pointFromEvent(event), {width: window.innerWidth, height: window.innerHeight});
}
function handlePointerup(event: PointerEvent): void {
  if (!event.isTrusted) return;
  if (!isSelecting.value || !startPoint || activePointerId !== event.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = normalizeAreaRect(startPoint, pointFromEvent(event), {width: window.innerWidth, height: window.innerHeight});
  clearResult();
  if (!isUsableAreaRect(rect)) return;
  activeRect.value = rect;
  phase.value = 'loading';
  capturePending.value = true;
  void requestTranslation(rect);
}
function handlePointercancel(event: PointerEvent): void {
  if (!event.isTrusted) return;
  if (isSelecting.value && event.pointerId === activePointerId) clearResult();
}
function handleWindowBlur(): void { if (isSelecting.value) clearResult(); }
async function requestTranslation(rect: AreaRect, prepareLanguages = false): Promise<void> {
  translationAbortController?.abort();
  const controller = new AbortController();
  translationAbortController = controller;
  const requestId = ++translationRequestId;
  errorMessage.value = '';
  progressStage.value = 'recognizing';
  result.value = null;
  preparingLanguages.value = prepareLanguages;
  if (!prepareLanguages) requestedSourceLanguage = config.from;
  const sourceLanguage = requestedSourceLanguage;
  // ref 会代理选区对象，不能将原始对象与代理比较；代次和取消信号才是请求所有权。
  const stale = () => controller.signal.aborted || requestId !== translationRequestId || document.visibilityState === 'hidden';
  try {
    if (prepareLanguages) {
      await prepareImageOcrLanguages(sourceLanguage, controller.signal);
      if (stale()) return;
      preparingLanguages.value = false;
      needsLanguages.value = false;
    }
    if (!capturedImage || !capturedSelection) {
      const selection = {...rect, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight};
      // 等待 Vue 和浏览器完成选区层的隐藏，避免边框和提示文字被截图识别。
      await nextTick();
      await new Promise<void>(resolve => {
        let frame: number;
        const finish = () => {
          cancelAnimationFrame(frame);
          controller.signal.removeEventListener('abort', finish);
          resolve();
        };
        controller.signal.addEventListener('abort', finish, {once: true});
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(finish); });
        if (controller.signal.aborted) finish();
      });
      if (stale()) return;
      const screenshot = await captureVisibleAreaInExtension();
      if (stale()) return;
      capturedImage = screenshot;
      capturedSelection = selection;
    }
    capturePending.value = false;
    const translated = await translateCapturedAreaInExtension(capturedImage, capturedSelection, sourceLanguage, document.title, {
      signal: controller.signal,
      timeoutMs: 180_000,
      onProgress: stage => { if (!stale()) progressStage.value = stage; },
    });
    if (stale()) return;
    result.value = translated;
    // 将重试输入替换为同一选区原图；归一化选区维度避免再次截取/编码整屏。
    capturedImage = translated.image;
    capturedSelection = {left: 0, top: 0, width: rect.width, height: rect.height, viewportWidth: rect.width, viewportHeight: rect.height};
    phase.value = 'translated';
  } catch (error) {
    if (stale()) return;
    capturePending.value = false;
    errorMessage.value = error instanceof Error ? error.message : String(error);
    needsLanguages.value = preparingLanguages.value || /^图片文字识别需要先下载.+语言包/u.test(errorMessage.value) || /^请先下载语言包$/u.test(errorMessage.value);
    phase.value = 'error';
  } finally {
    if (translationAbortController === controller) {
      translationAbortController = null;
      preparingLanguages.value = false;
    }
  }
}
function downloadLanguagesAndRetry(): void {
  if (!activeRect.value || phase.value !== 'error') return;
  phase.value = 'loading';
  void requestTranslation(activeRect.value, true);
}
function retryTranslation(): void {
  if (!activeRect.value) return;
  phase.value = 'loading';
  capturePending.value = !capturedImage;
  void requestTranslation(activeRect.value);
}
function showFeedback(message: string): void {
  clearTimeout(feedbackTimer);
  feedback.value = message;
  feedbackTimer = setTimeout(() => {feedback.value = '';}, 2500);
}
async function copyText(text: string): Promise<void> {
  const requestId = translationRequestId;
  try {
    await navigator.clipboard.writeText(text);
    if (requestId === translationRequestId) showFeedback('已复制');
  } catch {
    if (requestId === translationRequestId) showFeedback('复制失败，请选中文字后手动复制');
  }
}
async function openSettings(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-area-translation'}) as {success?: boolean} | undefined;
    if (response?.success === false) throw new Error('打开设置失败');
  } catch { showFeedback('无法打开设置，请从扩展菜单打开圈选设置'); }
}
function handleViewportChange(event: Event): void {
  // 卡片自己的滚动不能销毁结果；页面滚动/缩放则使旧截图坐标失效。
  if (!isInsideExtensionUi(event.target)) clearResult();
}
function handleVisibilityChange(): void {
  // captureVisibleTab 截取窗口的活动标签页，切走后不得将新标签页的内容作为本次选区处理。
  if (document.visibilityState === 'hidden') clearResult();
}
// config 是共享普通对象；使用配置仓库订阅接收跨页面变更，不能用 Vue watch 观察它。
const stopConfigWatch = subscribeConfig(() => {
  updateTheme();
  animationsEnabled.value = config.animations !== false;
  if (!isEnabled()) clearResult();
});
onMounted(() => {
  updateTheme();
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  systemThemeMedia.addEventListener('change', updateTheme);
  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('pointerdown', handlePointerdown, true);
  document.addEventListener('pointermove', handlePointermove, true);
  document.addEventListener('pointerup', handlePointerup, true);
  document.addEventListener('pointercancel', handlePointercancel, true);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('scroll', handleViewportChange, true);
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('blur', handleWindowBlur);
});
onBeforeUnmount(() => {
  systemThemeMedia?.removeEventListener('change', updateTheme);
  document.removeEventListener('keydown', handleKeydown, true);
  document.removeEventListener('pointerdown', handlePointerdown, true);
  document.removeEventListener('pointermove', handlePointermove, true);
  document.removeEventListener('pointerup', handlePointerup, true);
  document.removeEventListener('pointercancel', handlePointercancel, true);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('scroll', handleViewportChange, true);
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('blur', handleWindowBlur);
  stopConfigWatch();
  clearResult();
});
</script>

<style scoped>
.fr-area-translator-root { position: fixed; inset: 0; z-index: 2147483647; width: 100vw; height: 100vh; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #272733; font-size: 13px; line-height: 1.5; }
.fr-area-selecting { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: rgba(20, 20, 30, .08); touch-action: none; }
.fr-area-hint { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); max-width: calc(100vw - 32px); box-sizing: border-box; border-radius: 12px; background: #292735; color: #fff; padding: 10px 16px; text-align: center; box-shadow: 0 4px 24px #0003; }
.fr-area-selection { position: fixed; box-sizing: border-box; border: 2px solid #ef4b86; border-radius: 5px; background: rgba(239, 75, 134, .08); box-shadow: 0 0 0 1px #fff9; pointer-events: none; }
.fr-area-panel { position: fixed; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; border: 1px solid #e4dfe7; border-radius: 14px; background: #fff; box-shadow: 0 12px 40px #241c3833; pointer-events: auto; }
.fr-area-toolbar { display: flex; align-items: center; gap: 10px; flex-shrink: 0; padding: 12px 14px; border-bottom: 1px solid #ece8ef; }
.fr-area-heading { flex: 1; min-width: 0; }
.fr-area-title-row { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.fr-area-provider { margin-top: 3px; color: #777080; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; user-select: text; }
.fr-area-toolbar strong { font-size: 14px; }
.fr-area-mode { color: #777080; font-size: 11px; }
.fr-area-translator-root button { font: inherit; padding: 5px 9px; border: 1px solid #e5dce8; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
.fr-area-translator-root button:hover { background: #f7f0f5; }
.fr-area-translator-root button:focus-visible, .fr-area-translator-root summary:focus-visible { outline: 2px solid #db4781; outline-offset: 2px; }
.fr-area-toolbar button { margin-left: auto; flex-shrink: 0; align-self: flex-start; border: 0; font-size: 22px; line-height: 22px; padding: 2px 6px; }
.fr-area-loading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 22px 16px; }
.fr-area-loading button { margin-left: auto; }
.fr-area-spinner { width: 16px; height: 16px; flex-shrink: 0; border: 2px solid #e4dbe3; border-top-color: #ef4b86; border-radius: 50%; animation: fr-area-spin .7s linear infinite; }
@keyframes fr-area-spin { to { transform: rotate(360deg); } }
.fr-area-static { animation: none; }
.fr-area-content { overflow: auto; min-height: 0; overscroll-behavior: contain; padding: 14px 16px; }
.fr-area-text-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: #73677a; font-size: 12px; }
.fr-area-translator-root p { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.fr-area-translation { font-size: 15px; line-height: 1.75; user-select: text; }
.fr-area-source { border-top: 1px solid #ece8ef; margin-top: 14px; padding-top: 11px; }
.fr-area-source summary { cursor: pointer; color: #73677a; }
.fr-area-source button { margin-top: 8px; }
.fr-area-source img { display: block; width: 100%; height: auto; margin-top: 10px; border-radius: 5px; }
.fr-area-translator-root .fr-area-note { font-size: 11px; color: #817584; margin-top: 14px; }
.fr-area-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 11px 14px; border-top: 1px solid #ece8ef; flex-shrink: 0; }
.fr-area-error-body { padding: 16px; overflow: auto; }
.fr-area-error-body > strong { color: #bc355e; }
.fr-area-error-body .fr-area-actions { border: 0; padding: 14px 0 0; }
.fr-area-translator-root .fr-area-feedback { margin: 0; padding: 7px 14px; color: #ab3565; font-size: 12px; flex-shrink: 0; }
.fr-area-dark { color: #ece5ef; }
.fr-area-dark .fr-area-panel { border-color: #514653; background: #2b2630; }
.fr-area-dark .fr-area-toolbar, .fr-area-dark .fr-area-source, .fr-area-dark .fr-area-actions { border-color: #49404c; }
.fr-area-dark button { border-color: #65556a; }
.fr-area-dark button:hover { background: #413548; }
.fr-area-dark .fr-area-provider, .fr-area-dark .fr-area-mode, .fr-area-dark .fr-area-note, .fr-area-dark .fr-area-text-heading, .fr-area-dark summary { color: #c1b1c5; }
.fr-area-dark .fr-area-feedback, .fr-area-dark .fr-area-error-body > strong { color: #ffa7ca; }
@media (prefers-reduced-motion: reduce) { .fr-area-spinner { animation: none; } }
</style>

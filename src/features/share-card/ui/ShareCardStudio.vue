<!--
 * @file src/features/share-card/ui/ShareCardStudio.vue
 * 文件职责：提供划词翻译结果的双语卡片编辑预览与图片导出。
 * 主要内容：让多语言导出操作完整换行，原生模态对话框、品牌色分段选择与开关、八套图片风格、双语编辑及 PNG 复制、保存；固定底栏提供醒目的成功、错误和忙碌反馈，外观等待配置水合并跟随外部更新，排队写回共享配置；署名按当前界面语言渲染，同语言资源到达后复用既有重绘与取消机制。
 * 模块边界：组件位于封闭 Shadow UI，不读取网页正文、不调用翻译服务；渲染与导出委托独立适配器，关闭时取消渲染、释放位图与 Blob URL，并使迟到回调失效。
 -->
<template>
  <div class="fr-card-root" :class="{'fr-card-root--dark': isDarkTheme}" @pointerdown.stop @pointerup.stop @click.stop @wheel.stop.passive>
    <dialog ref="dialog" class="fr-card-dialog" :lang="language" aria-labelledby="fr-card-title" @cancel.prevent="close" @close="cleanup" @keydown.stop @pointerdown.stop @click.stop>
      <template v-if="opened">
        <header class="fr-card-header">
          <div class="fr-card-title-row">
            <h2 id="fr-card-title">{{ t('shareCard.create') }}</h2>
            <span v-if="result" class="fr-card-meta">{{ Math.ceil(result.blob.size / 1024) }} KB · PNG</span>
          </div>
          <div class="fr-card-header-actions">
            <button class="fr-card-icon-btn" type="button" :aria-label="t('shareCard.more')" :title="t('shareCard.more')" :aria-expanded="moreOpen ? 'true' : 'false'" :aria-pressed="moreOpen" @click="moreOpen = !moreOpen"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg></button>
            <button class="fr-card-close" type="button" :aria-label="t('shareCard.close')" autofocus @click="close"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M6 18 18 6" /></svg></button>
          </div>
        </header>
        <div class="fr-card-body">
        <div class="fr-card-workspace">
          <section class="fr-card-preview" :aria-label="t('shareCard.preview')" :aria-busy="rendering">
            <div class="fr-card-image-wrap">
              <div ref="canvasSlot" class="fr-card-canvas-slot fr-card-sr-only" aria-hidden="true" />
              <div
                class="fr-card-live"
                :class="[
                  `fr-card-live--${preferences.theme}`,
                  `is-size-${preferences.fontSize}`,
                  {
                    'is-columns': preferences.theme === 'pearl' || preferences.theme === 'blueprint',
                    'is-centered': preferences.theme === 'sky' || preferences.theme === 'sunset',
                    'is-reverse': preferences.translationFirst,
                    'is-square': preferences.format === 'square',
                  }
                ]"
              >
                <div class="fr-card-live-sheet">
                  <span v-if="preferences.theme === 'coral' || preferences.theme === 'prism' || preferences.theme === 'linen'" class="fr-card-live-accent" aria-hidden="true" />
                  <div class="fr-card-live-fields">
                    <div class="fr-card-autogrow fr-card-live-original" :data-value="`${excerpt.original || ' '} `">
                      <textarea v-model="excerpt.original" dir="auto" rows="1" spellcheck="false" :aria-label="t('shareCard.original')" :placeholder="t('shareCard.original')" />
                    </div>
                    <span class="fr-card-live-divider" aria-hidden="true" />
                    <div class="fr-card-autogrow fr-card-live-translation" :data-value="`${excerpt.translation || ' '} `">
                      <textarea v-model="excerpt.translation" dir="auto" rows="1" spellcheck="false" :aria-label="t('shareCard.translation')" :placeholder="t('shareCard.translation')" />
                    </div>
                  </div>
                  <label v-if="preferences.showSource" class="fr-card-source">
                    <span class="fr-card-sr-only">{{ t('shareCard.source') }}</span>
                    <input v-model="excerpt.source" maxlength="160" :aria-label="t('shareCard.source')" :placeholder="t('shareCard.sourceHint')" />
                  </label>
                </div>
              </div>
            </div>
          </section>
          <aside class="fr-card-controls" :aria-label="t('shareCard.customize')">
            <fieldset class="fr-card-fieldset"><legend class="fr-card-sr-only">{{ t('shareCard.style') }}</legend>
              <div class="fr-card-themes">
                <button v-for="theme in SHARE_CARD_THEMES" :key="theme" type="button" :data-theme="theme" :aria-pressed="preferences.theme === theme" @click="setPreference('theme', theme)">
                  <span class="fr-card-swatch" :class="`fr-card-swatch--${theme}`" aria-hidden="true"><i /><i /></span><span>{{ t(`shareCard.theme.${theme}`) }}</span>
                </button>
              </div>
            </fieldset>
            <div v-show="moreOpen" class="fr-card-more-panel">
              <div class="fr-card-options-row">
                <fieldset class="fr-card-choice"><legend>{{ t('shareCard.format') }}</legend><div class="fr-card-segments">
                  <button v-for="format in ['auto', 'square'] as const" :key="format" type="button" :data-format="format" :aria-pressed="preferences.format === format" @click="setPreference('format', format)">{{ t(`shareCard.${format}`) }}</button>
                </div></fieldset>
                <fieldset class="fr-card-choice"><legend>{{ t('shareCard.fontSize') }}</legend><div class="fr-card-segments">
                  <button v-for="size in ['small', 'medium', 'large'] as const" :key="size" type="button" :data-font-size="size" :aria-pressed="preferences.fontSize === size" @click="setPreference('fontSize', size)">{{ t(`shareCard.${size}`) }}</button>
                </div></fieldset>
              </div>
              <div class="fr-card-checks">
                <label v-for="key in ['translationFirst', 'showSource'] as const" :key="key"><span>{{ t(`shareCard.${key}`) }}</span><input type="checkbox" role="switch" :data-setting="key" :checked="preferences[key]" @change="setPreference(key, ($event.target as HTMLInputElement).checked)" /></label>
              </div>
            </div>
          </aside>
        </div>
        <footer class="fr-card-footer">
          <div class="fr-card-feedback-region" aria-live="polite" aria-atomic="true">
            <p v-if="status || renderError || rendering" :key="feedbackSequence" class="fr-card-feedback" :class="{'is-error': renderError || statusError, 'is-success': status && !statusError && !renderError, 'is-pending': !status && !renderError}">
              <svg v-if="status || renderError" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path v-if="statusError || renderError" d="M10 5v6m0 3v.2"/><path v-else d="m6 10 3 3 5-6"/></svg>
              <span v-else class="fr-card-spinner" aria-hidden="true" />
              <span>{{ renderError || status || t('shareCard.rendering') }}</span>
            </p>
          </div>
          <span class="fr-card-local-note">{{ t('shareCard.local') }}</span>
          <div class="fr-card-export-actions">
            <button type="button" data-action="copy" :disabled="!ready || busy || !copyAvailable" :aria-busy="activeAction === 'copy'" :title="copyAvailable ? t('shareCard.copy') : t('shareCard.copyUnavailable')" @click="copyImage"><span v-if="activeAction === 'copy'" class="fr-card-spinner" aria-hidden="true" />{{ t('shareCard.copy') }}</button>
            <button class="fr-card-primary" type="button" :disabled="!ready || busy" @click="saveImage">{{ t('shareCard.save') }}</button>
          </div>
          <p v-if="!copyAvailable" class="fr-card-fallback">{{ t('shareCard.copyUnavailable') }}</p>
        </footer>
        </div>
      </template>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import browser from 'webextension-polyfill';
import {computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch} from 'vue';
import {config, configReady, requestConfigPatch} from '@/src/services/config/store';
import {normalizeShareCardPreferences, SHARE_CARD_THEMES, type ShareCardPreferences} from '@/src/core/config/shareCard';
import {useUiI18n} from '@/src/ui/i18n';
import {type ShareCardExcerpt} from '../core';
import {renderShareCard, ShareCardRenderError, type RenderedShareCard} from '../render';
import {canCopyCardImage, copyCardImage, shareCardFilename} from '../export';

const emit = defineEmits<{closed: []}>();
const {t, language} = useUiI18n();
const dialog = ref<HTMLDialogElement>();
const canvasSlot = ref<HTMLElement>();
const opened = ref(false);
const moreOpen = ref(false);
const preferences = ref(normalizeShareCardPreferences());
const excerpt = reactive<ShareCardExcerpt>({original: '', translation: '', source: ''});
const result = shallowRef<RenderedShareCard | null>(null);
const imageUrl = ref('');
const renderError = ref('');
const rendering = ref(false);
const busy = ref(false);
const status = ref('');
const statusError = ref(false);
const feedbackSequence = ref(0);
const activeAction = ref<'copy' | ''>('');
const copyAvailable = canCopyCardImage();
const isDarkTheme = computed(() => config.theme === 'dark'
    || (config.theme === 'auto' && typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)')?.matches)));
const ready = computed(() => Boolean(result.value && !renderError.value && !rendering.value));
let generation = 0;
let openGeneration = 0;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let saveQueue = Promise.resolve();
let renderController: AbortController | undefined;
const pendingPreferences = new Map<keyof ShareCardPreferences, {value: unknown}>();

function releaseImage(): void {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
    if (result.value) { result.value.canvas.width = 0; result.value.canvas.height = 0; }
    imageUrl.value = ''; result.value = null; canvasSlot.value?.replaceChildren();
}
function cleanup(): void {
    const wasOpened = opened.value;
    opened.value = false; openGeneration++; generation++;
    renderController?.abort(); renderController = undefined;
    clearTimeout(renderTimer); clearTimeout(saveTimer); releaseImage(); rendering.value = false;
    Object.assign(excerpt, {original: '', translation: '', source: ''});
    status.value = ''; statusError.value = false; renderError.value = ''; busy.value = false; activeAction.value = '';
    if (wasOpened) emit('closed');
}
function close(): void { dialog.value?.close(); cleanup(); }
async function open(value: ShareCardExcerpt): Promise<void> {
    const current = ++openGeneration;
    generation++; renderController?.abort(); clearTimeout(renderTimer); clearTimeout(saveTimer);
    rendering.value = true;
    await configReady;
    if (disposed || current !== openGeneration) return;
    moreOpen.value = false;
    busy.value = false; activeAction.value = ''; status.value = ''; statusError.value = false;
    syncPreferences();
    Object.assign(excerpt, value);
    opened.value = true;
    await nextTick();
    if (disposed || !opened.value || current !== openGeneration) return;
    if (!dialog.value?.open) dialog.value?.showModal();
    scheduleRender();
}
function syncPreferences(): void {
    preferences.value = normalizeShareCardPreferences({...config.shareCard,
        ...Object.fromEntries(Array.from(pendingPreferences, ([key, entry]) => [key, entry.value]))});
}
function setPreference(key: keyof ShareCardPreferences, value: unknown): void {
    const entry = {value}; pendingPreferences.set(key, entry);
    preferences.value = normalizeShareCardPreferences({...preferences.value, [key]: value});
    const current = openGeneration;
    // 执行时等待水合并合并最新配置；旧回执不能覆盖尚未保存的新选择。
    saveQueue = saveQueue.then(async () => {
        await configReady;
        await requestConfigPatch({shareCard: normalizeShareCardPreferences({...config.shareCard, [key]: value})}, browser.runtime.sendMessage.bind(browser.runtime));
    }).catch(() => {
        if (disposed || !opened.value || current !== openGeneration) return;
        showFeedback('shareCard.preferenceFailed', true);
    }).finally(() => {
        if (pendingPreferences.get(key) === entry) pendingPreferences.delete(key);
        if (!disposed && opened.value) syncPreferences();
    });
}
function scheduleRender(): void {
    if (!opened.value) return;
    const current = ++generation;
    rendering.value = true; renderError.value = '';
    // 渲染期间保留上张画面避免布局闪动；ready 立即变为 false，不允许保存过期内容。
    clearTimeout(renderTimer); renderController?.abort();
    const controller = new AbortController(); renderController = controller;
    renderTimer = setTimeout(async () => {
        try {
            const rendered = await renderShareCard({...excerpt}, {...preferences.value}, controller.signal);
            if (!opened.value || current !== generation || disposed) { rendered.canvas.width = 0; rendered.canvas.height = 0; return; }
            releaseImage();
            rendered.canvas.setAttribute('role', 'img');
            rendered.canvas.setAttribute('aria-label', t('shareCard.previewAlt'));
            canvasSlot.value?.replaceChildren(rendered.canvas);
            result.value = rendered; imageUrl.value = URL.createObjectURL(rendered.blob);
        } catch (error) {
            if (!opened.value || current !== generation || disposed) return;
            releaseImage();
            renderError.value = t(`shareCard.error.${error instanceof ShareCardRenderError ? error.reason : 'canvas'}`);
        } finally { if (current === generation) rendering.value = false; }
    }, 100);
}
function showFeedback(key: string, error = false): void {
    statusError.value = error; status.value = t(key); feedbackSequence.value++;
}
function saveImage(): void {
    if (!ready.value || !dialog.value || busy.value) return;
    const current = openGeneration; busy.value = true;
    let link: HTMLAnchorElement | undefined;
    try {
        link = document.createElement('a'); link.href = imageUrl.value; link.download = shareCardFilename();
        dialog.value.append(link); link.click();
        if (!disposed && opened.value && current === openGeneration) showFeedback('shareCard.saved');
    } catch { if (!disposed && opened.value && current === openGeneration) showFeedback('shareCard.saveFailed', true); }
    finally {
        try { link?.remove(); } catch { /* 清理失败不影响提示和后续操作。 */ }
        // 下载是同步交付，短暂锁定覆盖真实双击的第二个事件；关闭/重开会清除此计时器。
        if (!disposed && opened.value && current === openGeneration) {
            clearTimeout(saveTimer); saveTimer = setTimeout(() => {
                if (!disposed && opened.value && current === openGeneration) busy.value = false;
            }, 400);
        }
    }
}
async function copyImage(): Promise<void> {
    if (!ready.value || !result.value || busy.value) return;
    const current = openGeneration;
    busy.value = true; activeAction.value = 'copy'; status.value = ''; statusError.value = false;
    try {
        // PNG 已在预览时生成；可信点击内立即调用，避免异步渲染耗掉瞬时用户激活。
        await copyCardImage(result.value.blob);
        if (current !== openGeneration || !opened.value || disposed) return;
        showFeedback('shareCard.copied');
    } catch {
        if (current !== openGeneration || !opened.value || disposed) return;
        showFeedback('shareCard.copyFailed', true);
    } finally { if (!disposed && current === openGeneration) { busy.value = false; activeAction.value = ''; } }
}
watch(() => config.shareCard, () => { if (opened.value) syncPreferences(); }, {deep: true});
watch([preferences, excerpt, language], scheduleRender, {deep: true, flush: 'sync'});
onBeforeUnmount(() => { disposed = true; dialog.value?.close(); cleanup(); clearTimeout(renderTimer); releaseImage(); });
defineExpose({open, close});
</script>

<style scoped>
.fr-card-root {
  --fr-sc-bg: #ffffff;
  --fr-sc-soft: #f7f8fb;
  --fr-sc-stage: #f2f4f8;
  --fr-sc-hover: #eff1f6;
  --fr-sc-line: #e7eaf1;
  --fr-sc-line-strong: #d2d7e2;
  --fr-sc-ink: #172033;
  --fr-sc-muted: #5d6678;
  --fr-sc-brand: #ef4776;
  --fr-sc-brand-strong: #d4235a;
  --fr-sc-brand-soft: #fff0f5;
  --fr-sc-brand-border: rgba(239, 71, 118, .28);
  --fr-sc-switch-off: #c2c8d6;
  --fr-sc-ease: cubic-bezier(.23, 1, .32, 1);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
  color: var(--fr-sc-ink);
  text-align: left;
  color-scheme: light;
}
.fr-card-root--dark {
  --fr-sc-bg: #1c2028;
  --fr-sc-soft: #232833;
  --fr-sc-stage: #14171c;
  --fr-sc-hover: #2b313e;
  --fr-sc-line: #2f3542;
  --fr-sc-line-strong: #434b5c;
  --fr-sc-ink: #f1f3f7;
  --fr-sc-muted: #a5aebf;
  --fr-sc-brand: #f46590;
  --fr-sc-brand-strong: #ff85ab;
  --fr-sc-brand-soft: rgba(244, 101, 144, .16);
  --fr-sc-brand-border: rgba(244, 101, 144, .34);
  --fr-sc-switch-off: #434b5c;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; }
button, input, textarea, select { font: inherit; } button, select, input[type=checkbox], summary { cursor: pointer; }
button { border: 1px solid var(--fr-sc-line); border-radius: 8px; background: var(--fr-sc-bg); color: inherit; padding: 8px 13px; transition: background-color 120ms var(--fr-sc-ease), border-color 120ms var(--fr-sc-ease), color 120ms var(--fr-sc-ease), transform 120ms var(--fr-sc-ease); }
button:hover:not(:disabled) { border-color: var(--fr-sc-line-strong); background: var(--fr-sc-hover); }
button:active:not(:disabled) { transform: scale(.985); }
button:disabled { cursor: not-allowed; opacity: .45; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--fr-sc-brand-strong); outline-offset: 2px; }
.fr-card-dialog { position: fixed; inset: 0; margin: auto; width: min(364px, calc(100vw - 24px)); max-width: none; max-height: min(520px, calc(100dvh - 32px)); padding: 0; border: 1px solid var(--fr-sc-line); border-radius: 13px; background: var(--fr-sc-bg); color: var(--fr-sc-ink); box-shadow: 0 16px 44px rgba(17, 22, 34, .20), 0 2px 8px rgba(17, 22, 34, .08); overflow: hidden; overscroll-behavior: contain; }
.fr-card-root--dark .fr-card-dialog { box-shadow: 0 20px 52px rgba(0, 0, 0, .56), 0 2px 10px rgba(0, 0, 0, .30); }
.fr-card-dialog[open] { display: flex; flex-direction: column; }
.fr-card-dialog::backdrop { background: rgba(16, 20, 30, .42); }
.fr-card-body { display: contents; }
.fr-card-header { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--fr-sc-line); background: var(--fr-sc-soft); flex-shrink: 0; }
.fr-card-title-row { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
h2 { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.3; letter-spacing: -.01em; }
.fr-card-meta { color: var(--fr-sc-muted); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fr-card-header-actions { display: flex; align-items: center; gap: 3px; flex: none; }
.fr-card-icon-btn, .fr-card-close { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border-color: transparent; border-radius: 6px; background: transparent; color: var(--fr-sc-muted); }
.fr-card-icon-btn:hover, .fr-card-close:hover { border-color: transparent; background: var(--fr-sc-hover); color: var(--fr-sc-ink); }
.fr-card-icon-btn[aria-pressed=true] { border-color: var(--fr-sc-brand-border); background: var(--fr-sc-brand-soft); color: var(--fr-sc-brand-strong); }
.fr-card-workspace { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(93, 102, 120, .35) transparent; }
.fr-card-preview { padding: 10px 12px 4px; min-width: 0; }
.fr-card-image-wrap { position: relative; display: flex; justify-content: center; align-items: center; }
.fr-card-live {
  --ed-outer: linear-gradient(135deg, #fffbfc, #fff0f4);
  --ed-border: rgba(239, 71, 118, .18);
  --ed-ink: #172033;
  --ed-sub: #4d576b;
  --ed-muted: #7d8699;
  --ed-rule: rgba(239, 71, 118, .30);
  --ed-footer-line: rgba(23, 32, 51, .08);
  --ed-accent: linear-gradient(90deg, #f45686, #e53268);
  --ed-font: Georgia, 'Songti SC', 'Noto Serif CJK SC', serif;
  --ed-primary-size: 14px;
  --ed-secondary-size: 11.5px;
  width: 100%;
  border: 1px solid var(--ed-border);
  border-radius: 10px;
  background: var(--ed-outer);
  box-shadow: 0 3px 12px rgba(17, 24, 39, .06);
  transition: background 160ms var(--fr-sc-ease), border-color 160ms var(--fr-sc-ease);
}
.fr-card-live.is-size-small { --ed-primary-size: 12.5px; --ed-secondary-size: 11px; }
.fr-card-live.is-size-large { --ed-primary-size: 15.5px; --ed-secondary-size: 12.5px; }
.fr-card-live.is-square { max-width: 236px; aspect-ratio: 1 / 1; display: flex; }
.fr-card-live.is-square .fr-card-live-sheet { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.fr-card-live--coral { --ed-outer: linear-gradient(135deg, #fffbfc, #fff0f4); --ed-border: rgba(239, 71, 118, .18); --ed-ink: #172033; --ed-sub: #4d576b; --ed-muted: #7d8699; --ed-rule: rgba(239, 71, 118, .30); --ed-footer-line: rgba(23, 32, 51, .08); --ed-accent: linear-gradient(90deg, #f45686, #e53268); --ed-font: Georgia, 'Songti SC', 'Noto Serif CJK SC', serif; }
.fr-card-live--sky { --ed-outer: linear-gradient(145deg, #f4f9ff, #e5f1ff 55%, #d3e7fd); --ed-border: rgba(59, 130, 196, .18); --ed-ink: #142d4c; --ed-sub: #3d5c7e; --ed-muted: #617f9e; --ed-rule: rgba(59, 130, 196, .34); --ed-footer-line: rgba(20, 45, 76, .09); --ed-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
.fr-card-live--prism { --ed-outer: radial-gradient(circle at 18% 12%, rgba(79, 108, 240, .24), transparent 55%), radial-gradient(circle at 86% 90%, rgba(232, 77, 133, .20), transparent 55%), linear-gradient(135deg, #10141e, #161b29); --ed-border: rgba(255, 255, 255, .10); --ed-ink: #f3f5fa; --ed-sub: #b6c1d6; --ed-muted: #8692a8; --ed-rule: rgba(244, 101, 144, .55); --ed-footer-line: rgba(255, 255, 255, .10); --ed-accent: linear-gradient(90deg, #77b7ff, #b09cff, #f46590); --ed-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
.fr-card-live--pearl { --ed-outer: #ffffff; --ed-border: #e2e6ef; --ed-ink: #172033; --ed-sub: #525c70; --ed-muted: #7e889b; --ed-rule: #e2e6ef; --ed-footer-line: rgba(23, 32, 51, .08); --ed-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
.fr-card-live--moss { --ed-outer: linear-gradient(#f4f7f0, #e9f0e2); --ed-border: rgba(86, 122, 88, .20); --ed-ink: #1f3528; --ed-sub: #4c6254; --ed-muted: #718677; --ed-rule: rgba(86, 122, 88, .34); --ed-footer-line: rgba(31, 53, 40, .09); --ed-font: Georgia, 'Songti SC', 'Noto Serif CJK SC', serif; }
.fr-card-live--linen { --ed-outer: linear-gradient(#fbf8f1, #f4ecdc); --ed-border: rgba(166, 114, 71, .22); --ed-ink: #2d241c; --ed-sub: #655647; --ed-muted: #8a7a69; --ed-rule: rgba(166, 114, 71, .36); --ed-footer-line: rgba(45, 36, 28, .09); --ed-accent: #a67247; --ed-font: Georgia, 'Songti SC', 'Noto Serif CJK SC', serif; }
.fr-card-live--sunset { --ed-outer: linear-gradient(145deg, #fff8f1, #fce7db 55%, #f6d2c7); --ed-border: rgba(212, 106, 89, .20); --ed-ink: #3d2222; --ed-sub: #6e4945; --ed-muted: #8f6862; --ed-rule: rgba(212, 106, 89, .36); --ed-footer-line: rgba(61, 34, 34, .09); --ed-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
.fr-card-live--blueprint { --ed-outer: repeating-linear-gradient(0deg, transparent 0 13px, rgba(165, 208, 238, .06) 13px 14px), repeating-linear-gradient(90deg, transparent 0 13px, rgba(165, 208, 238, .06) 13px 14px), linear-gradient(135deg, #102136, #152c47); --ed-border: rgba(148, 198, 232, .24); --ed-ink: #eff7ff; --ed-sub: #b8d3e8; --ed-muted: #89aec9; --ed-rule: rgba(148, 198, 232, .28); --ed-footer-line: rgba(148, 198, 232, .16); --ed-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
.fr-card-live-sheet { position: relative; width: 100%; padding: 16px 18px 14px; }
.fr-card-live--moss .fr-card-live-sheet { padding-left: 22px; }
.fr-card-live--moss .fr-card-live-sheet::before { content: ''; position: absolute; left: 11px; top: 16px; bottom: 16px; width: 2px; border-radius: 2px; background: #6b8f6d; }
.fr-card-live-accent { display: block; width: 18px; height: 2px; margin: 0 0 9px 2px; border-radius: 2px; background: var(--ed-accent); }
.fr-card-live--prism .fr-card-live-accent { width: 24px; }
.fr-card-live-fields { display: flex; flex-direction: column; gap: 7px; }
.fr-card-live.is-reverse .fr-card-live-fields { flex-direction: column-reverse; }
.fr-card-live.is-columns .fr-card-live-fields { display: grid; grid-template-columns: 1fr 1px 1fr; align-items: start; gap: 10px; }
.fr-card-live.is-columns.is-reverse .fr-card-live-original { order: 3; }
.fr-card-live.is-columns.is-reverse .fr-card-live-divider { order: 2; }
.fr-card-live.is-columns.is-reverse .fr-card-live-translation { order: 1; }
.fr-card-live-divider { display: block; width: 18px; height: 2px; margin-left: 2px; border-radius: 2px; background: var(--ed-rule); }
.fr-card-live.is-centered .fr-card-live-divider { margin-inline: auto; }
.fr-card-live.is-columns .fr-card-live-divider { width: 1px; height: 100%; min-height: 28px; margin-left: 0; align-self: stretch; }
.fr-card-autogrow { display: grid; min-width: 0; }
.fr-card-autogrow::after, .fr-card-autogrow textarea {
  grid-area: 1 / 1;
  font: inherit;
  color: inherit;
  text-align: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  padding: 2px 3px;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.fr-card-autogrow::after { content: attr(data-value); visibility: hidden; pointer-events: none; }
.fr-card-autogrow textarea { width: 100%; min-width: 0; min-height: 0; border: 1px solid transparent; border-radius: 5px; background: transparent; overflow: hidden; resize: none; outline: none; transition: border-color 120ms var(--fr-sc-ease), background-color 120ms var(--fr-sc-ease); }
.fr-card-autogrow textarea:hover { background: color-mix(in srgb, var(--ed-ink) 3.5%, transparent); }
.fr-card-autogrow textarea:focus { border-color: color-mix(in srgb, var(--fr-sc-brand) 48%, transparent); background: color-mix(in srgb, var(--ed-ink) 4.5%, transparent); outline: none; }
.fr-card-live-original { font-family: var(--ed-font); font-size: var(--ed-primary-size); font-weight: 600; line-height: 1.46; color: var(--ed-ink); }
.fr-card-live-translation { font-size: var(--ed-secondary-size); font-weight: 400; line-height: 1.6; color: var(--ed-sub); }
.fr-card-live.is-reverse .fr-card-live-translation { font-family: var(--ed-font); font-size: var(--ed-primary-size); font-weight: 600; line-height: 1.46; color: var(--ed-ink); }
.fr-card-live.is-reverse .fr-card-live-original { font-family: inherit; font-size: var(--ed-secondary-size); font-weight: 400; line-height: 1.6; color: var(--ed-sub); }
.fr-card-live.is-centered .fr-card-live-original, .fr-card-live.is-centered .fr-card-live-translation, .fr-card-live.is-centered .fr-card-source input { text-align: center; }
.fr-card-live .fr-card-source { display: block; margin: 10px 0 0; padding-top: 7px; border-top: 1px solid var(--ed-footer-line); }
.fr-card-live .fr-card-source input { width: 100%; padding: 1px 3px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--ed-muted); font-size: 11px; line-height: 1.4; }
.fr-card-live .fr-card-source input:hover { background: color-mix(in srgb, var(--ed-ink) 3.5%, transparent); }
.fr-card-live .fr-card-source input:focus { border-color: color-mix(in srgb, var(--fr-sc-brand) 48%, transparent); background: color-mix(in srgb, var(--ed-ink) 4.5%, transparent); color: var(--ed-ink); outline: none; }
.fr-card-controls { padding: 6px 12px 8px; min-width: 0; display: grid; grid-template-columns: 1fr 1fr; column-gap: 10px; }
.fr-card-fieldset { border: 0; padding: 0; margin: 0; grid-column: 1/-1; }
.fr-card-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.fr-card-themes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.fr-card-themes button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 27px; padding: 0 5px; font-size: 11px; font-weight: 500; color: var(--fr-sc-muted); background: var(--fr-sc-soft); border: 1px solid var(--fr-sc-line); border-radius: 7px; white-space: nowrap; }
.fr-card-themes button:hover { background: var(--fr-sc-hover); border-color: var(--fr-sc-line-strong); color: var(--fr-sc-ink); }
.fr-card-themes button[aria-pressed=true] { border-color: var(--fr-sc-brand); background: var(--fr-sc-brand-soft); color: var(--fr-sc-brand-strong); font-weight: 600; box-shadow: inset 0 0 0 0.5px var(--fr-sc-brand); }
.fr-card-swatch { position: relative; flex: none; display: block; width: 12px; height: 12px; border-radius: 4px; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .12); }
.fr-card-root--dark .fr-card-swatch { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .22); }
.fr-card-swatch i { display: none; }
.fr-card-swatch--coral { background: linear-gradient(135deg, #ffffff 48%, #f45686 48%); }
.fr-card-swatch--sky { background: linear-gradient(135deg, #f4f9ff, #9ec8f5); }
.fr-card-swatch--prism { background: linear-gradient(135deg, #121622 52%, #b09cff 82%, #f46590); }
.fr-card-swatch--pearl { background: linear-gradient(90deg, #ffffff 50%, #e4e7f0 50%); }
.fr-card-swatch--moss { background: linear-gradient(135deg, #edf3e6 42%, #6b8f6d); }
.fr-card-swatch--linen { background: linear-gradient(135deg, #fbf7ee 45%, #d6be9c); }
.fr-card-swatch--sunset { background: linear-gradient(135deg, #fff5eb, #efa79c); }
.fr-card-swatch--blueprint { background: linear-gradient(135deg, #102136 55%, #4a83b5); }
.fr-card-more-panel { grid-column: 1/-1; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--fr-sc-line); }
.fr-card-options-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
label { display: grid; gap: 3px; font-size: 11px; font-weight: 500; color: var(--fr-sc-ink); }
select, input:not([type=checkbox]), textarea { width: 100%; min-width: 0; border: 1px solid var(--fr-sc-line); background: var(--fr-sc-soft); color: var(--fr-sc-ink); border-radius: 7px; padding: 5px 8px; font-size: 11.5px; transition: border-color 120ms var(--fr-sc-ease), background-color 120ms var(--fr-sc-ease); }
input:not([type=checkbox]):focus, textarea:focus { border-color: var(--fr-sc-brand-strong); background: var(--fr-sc-bg); }
.fr-card-choice { min-width: 0; border: 0; padding: 0; margin: 0; }
.fr-card-choice legend { margin-bottom: 4px; padding: 0; font-size: 11px; font-weight: 500; color: var(--fr-sc-muted); }
.fr-card-segments { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--fr-sc-line); border-radius: 7px; background: var(--fr-sc-soft); }
.fr-card-segments button { flex: 1; min-width: 0; min-height: 24px; padding: 2px 4px; border: 0; border-radius: 5px; background: transparent; font-size: 11px; font-weight: 500; color: var(--fr-sc-muted); }
.fr-card-segments button:hover { background: var(--fr-sc-hover); color: var(--fr-sc-ink); }
.fr-card-segments button[aria-pressed=true] { background: var(--fr-sc-bg); color: var(--fr-sc-brand-strong); font-weight: 600; box-shadow: 0 1px 2px rgba(22, 27, 38, .08); }
.fr-card-checks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0 0; }
.fr-card-checks label { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; min-height: 30px; padding: 0 9px; border: 1px solid var(--fr-sc-line); border-radius: 7px; background: var(--fr-sc-soft); cursor: pointer; }
.fr-card-checks label span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input[type=checkbox] { appearance: none; flex: none; position: relative; margin: 0; width: 30px; height: 17px; border: 0; border-radius: 20px; background: var(--fr-sc-switch-off); transition: background-color 160ms var(--fr-sc-ease); }
input[type=checkbox]::before { content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%; background: #ffffff; box-shadow: 0 1px 2px rgba(23, 32, 51, .18); transition: transform 160ms var(--fr-sc-ease); }
input[type=checkbox]:checked { background: var(--fr-sc-brand); }
input[type=checkbox]:checked::before { transform: translateX(13px); }
.fr-card-source { margin-bottom: 4px; }
.fr-card-edit:not([open]) summary span { display: none; }
.fr-card-edit p { color: var(--fr-sc-muted); font-size: 11px; margin: 4px 0; }
.fr-card-edit label { margin-top: 6px; }
textarea { resize: vertical; min-height: 48px; line-height: 1.5; }
.fr-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 7px 12px 8px; border-top: 1px solid var(--fr-sc-line); background: var(--fr-sc-soft); flex-shrink: 0; }
.fr-card-feedback-region { width: 100%; } .fr-card-feedback-region:empty { display: none; }
.fr-card-feedback { display: flex; align-items: center; gap: 6px; margin: 0; width: 100%; padding: 6px 9px; border: 1px solid rgba(37, 99, 166, .22); border-radius: 7px; background: #edf4ff; color: #2563a6; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.fr-card-feedback.is-success { background: #eaf7f3; border-color: rgba(20, 126, 92, .24); color: #147e5c; }
.fr-card-feedback.is-error { background: #fff0f3; border-color: rgba(180, 35, 72, .22); color: #b42348; }
.fr-card-root--dark .fr-card-feedback { background: #1f3045; border-color: rgba(155, 197, 242, .24); color: #9bc5f2; }
.fr-card-root--dark .fr-card-feedback.is-success { background: #19322b; border-color: rgba(140, 224, 196, .24); color: #8ce0c4; }
.fr-card-root--dark .fr-card-feedback.is-error { background: #3b2029; border-color: rgba(245, 163, 184, .24); color: #f5a3b8; }
.fr-card-feedback svg { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.fr-card-export-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; max-width: 100%; }
.fr-card-export-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 28px; padding: 0 11px; border-radius: 7px; font-size: 11.5px; font-weight: 500; }
.fr-card-primary { border-color: #eb3a70; background: linear-gradient(135deg, #f45686, #e53268); color: #ffffff; font-weight: 600; box-shadow: 0 4px 12px rgba(233, 50, 103, .20); }
.fr-card-primary:hover:not(:disabled) { border-color: #dc2d63; background: linear-gradient(135deg, #eb4677, #d6265c); color: #ffffff; }
.fr-card-root--dark .fr-card-primary { border-color: #e6376b; background: linear-gradient(135deg, #f35484, #df2e63); }
.fr-card-local-note { color: var(--fr-sc-muted); font-size: 11px; }
.fr-card-fallback { flex-basis: 100%; margin: 0; font-size: 11px; color: var(--fr-sc-muted); }
.fr-card-spinner { display: inline-block; width: 14px; height: 14px; flex: none; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: fr-card-spin .8s linear infinite; }
@keyframes fr-card-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .fr-card-spinner { animation: none; }
  button, summary::before, input, textarea, input[type=checkbox], input[type=checkbox]::before { transition: none; }
}
@media (max-width: 460px) { .fr-card-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); border-radius: 12px; } .fr-card-header { padding: 12px 16px; } .fr-card-preview { padding: 10px 14px 4px; } .fr-card-controls { padding: 10px 14px 6px; } .fr-card-footer { padding: 12px 14px; } .fr-card-local-note { width: 100%; } .fr-card-export-actions { width: 100%; } .fr-card-export-actions button { flex: 1; min-width: 0; min-height: 36px; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; } }
@media (max-width: 460px) { .fr-card-dialog:not(:lang(zh)) .fr-card-options-row { grid-template-columns: 1fr; } }
@media (max-width: 380px) { .fr-card-options-row { grid-template-columns: 1fr; } }
@media (any-pointer: coarse) {
  .fr-card-dialog button, summary { min-width: 44px; min-height: 44px; }
  .fr-card-close { width: 44px; height: 44px; flex: none; }
  .fr-card-header > div { min-width: 0; overflow-wrap: anywhere; }
  summary, .fr-card-export-actions button { font-size: 14px; }
  .fr-card-segments button { font-size: 13px; }
  input:not([type=checkbox]), textarea { min-height: 44px; font-size: 16px; }
}
@media (any-pointer: coarse) and (max-height: 480px) {
  .fr-card-body { display: block; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .fr-card-workspace { overflow: visible; }
}
</style>

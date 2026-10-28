<!--
 * @file src/features/share-card/ui/ShareCardStudio.vue
 * 文件职责：提供划词翻译结果的双语卡片编辑预览与图片导出。
 * 主要内容：让多语言导出操作完整换行，原生模态对话框、品牌色分段选择与开关、八套图片风格、双语编辑及 PNG 复制、保存；固定底栏提供醒目的成功、错误和忙碌反馈，外观等待配置水合并跟随外部更新，排队写回共享配置；署名按当前界面语言渲染，同语言资源到达后复用既有重绘与取消机制。
 * 模块边界：组件位于封闭 Shadow UI，不读取网页正文、不调用翻译服务；渲染与导出委托独立适配器，关闭时取消渲染、释放位图与 Blob URL，并使迟到回调失效。
 -->
<template>
  <div class="fr-card-root" @pointerdown.stop @pointerup.stop @click.stop @wheel.stop.passive>
    <dialog ref="dialog" class="fr-card-dialog" :lang="language" aria-labelledby="fr-card-title" @cancel.prevent="close" @close="cleanup" @keydown.stop @pointerdown.stop @click.stop>
      <template v-if="opened">
        <header class="fr-card-header">
          <div><h2 id="fr-card-title">{{ t('shareCard.create') }}</h2></div>
          <button class="fr-card-close" type="button" :aria-label="t('shareCard.close')" autofocus @click="close">×</button>
        </header>
        <div class="fr-card-body">
        <div class="fr-card-workspace">
          <section class="fr-card-preview" :aria-label="t('shareCard.preview')" :aria-busy="rendering">
            <div class="fr-card-preview-top"><span>{{ t('shareCard.preview') }}</span><span v-if="result">{{ Math.ceil(result.blob.size / 1024) }} KB · PNG</span></div>
            <div class="fr-card-image-wrap">
              <div v-show="result && !renderError" ref="canvasSlot" class="fr-card-canvas-slot" :class="{'is-rendering': rendering}" />
              <p v-if="!result || renderError" class="fr-card-placeholder" role="status">{{ renderError || t('shareCard.rendering') }}</p>
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
            <details class="fr-card-more"><summary>{{ t('shareCard.more') }}</summary>
            <div class="fr-card-options-row">
              <fieldset class="fr-card-choice"><legend>{{ t('shareCard.format') }}</legend><div class="fr-card-segments">
                <button v-for="format in ['auto', 'square'] as const" :key="format" type="button" :data-format="format" :aria-pressed="preferences.format === format" @click="setPreference('format', format)">{{ t(`shareCard.${format}`) }}</button>
              </div></fieldset>
              <fieldset class="fr-card-choice"><legend>{{ t('shareCard.fontSize') }}</legend><div class="fr-card-segments">
                <button v-for="size in ['small', 'medium', 'large'] as const" :key="size" type="button" :data-font-size="size" :aria-pressed="preferences.fontSize === size" @click="setPreference('fontSize', size)">{{ t(`shareCard.${size}`) }}</button>
              </div></fieldset>
            </div>
            <div class="fr-card-checks">
              <label v-for="key in ['translationFirst', 'showSource', 'showBrand'] as const" :key="key"><span>{{ t(`shareCard.${key}`) }}</span><input type="checkbox" role="switch" :data-setting="key" :checked="preferences[key]" @change="setPreference(key, ($event.target as HTMLInputElement).checked)" /></label>
            </div>
            <label v-if="preferences.showSource" class="fr-card-source">{{ t('shareCard.source') }}<input v-model="excerpt.source" maxlength="160" :placeholder="t('shareCard.sourceHint')" /></label>
            </details>
            <details class="fr-card-edit" :open="editorOpen" @toggle="editorOpen = ($event.target as HTMLDetailsElement).open">
              <summary>{{ t('shareCard.edit') }}<span>{{ excerpt.original.length + excerpt.translation.length }} / {{ SHARE_CARD_MAX_CHARACTERS }}</span></summary>
              <p>{{ t('shareCard.editHint') }}</p>
              <label>{{ t('shareCard.original') }}<textarea v-model="excerpt.original" dir="auto" rows="4" spellcheck="false" /></label>
              <label>{{ t('shareCard.translation') }}<textarea v-model="excerpt.translation" dir="auto" rows="4" spellcheck="false" /></label>
            </details>

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
import {SHARE_CARD_MAX_CHARACTERS, type ShareCardExcerpt} from '../core';
import {renderShareCard, ShareCardRenderError, type RenderedShareCard} from '../render';
import {canCopyCardImage, copyCardImage, shareCardFilename} from '../export';

const emit = defineEmits<{closed: []}>();
const {t, language} = useUiI18n();
const dialog = ref<HTMLDialogElement>();
const canvasSlot = ref<HTMLElement>();
const opened = ref(false);
const editorOpen = ref(false);
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
    editorOpen.value = false;
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
            const rendered = await renderShareCard({...excerpt}, {...preferences.value}, controller.signal, t('common.brand'));
            if (!opened.value || current !== generation || disposed) { rendered.canvas.width = 0; rendered.canvas.height = 0; return; }
            releaseImage();
            rendered.canvas.setAttribute('role', 'img');
            rendered.canvas.setAttribute('aria-label', t('shareCard.previewAlt'));
            canvasSlot.value?.replaceChildren(rendered.canvas);
            result.value = rendered; imageUrl.value = URL.createObjectURL(rendered.blob);
        } catch (error) {
            if (!opened.value || current !== generation || disposed) return;
            releaseImage(); editorOpen.value = true;
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
watch([preferences, excerpt, language, () => t('common.brand')], scheduleRender, {deep: true, flush: 'sync'});
onBeforeUnmount(() => { disposed = true; dialog.value?.close(); cleanup(); clearTimeout(renderTimer); releaseImage(); });
defineExpose({open, close});
</script>

<style scoped>
.fr-card-root { --fr-card-accent: #ef4776; --fr-card-soft: #fff0f4; font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; color: #172033; text-align: left; color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
button, input, textarea, select { font: inherit; } button, select, input[type=checkbox], summary { cursor: pointer; }
button { border: 1px solid #dfe1e8; border-radius: 8px; background: #fff; color: inherit; padding: 9px 13px; } button:hover { background: #f5f6fa; } button:disabled { cursor: default; opacity: .45; }
button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--fr-card-accent); outline-offset: 3px; }
.fr-card-dialog { position: fixed; inset: 0; margin: auto; width: min(560px, calc(100vw - 24px)); max-width: none; max-height: min(800px, calc(100dvh - 32px)); padding: 0; border: 1px solid #e5e8ef; border-radius: 16px; background: #ffffff; color: #172033; box-shadow: 0 24px 80px #14261f30; overflow: hidden; overscroll-behavior: contain; }
.fr-card-dialog[open] { display: flex; flex-direction: column; } .fr-card-dialog::backdrop { background: #171b3066; }
.fr-card-body { display: contents; }
.fr-card-header { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 16px 22px 12px; flex-shrink: 0; }
h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.5; } .fr-card-close { font-size: 22px; line-height: 1; padding: 4px 7px; border-color: transparent; background: transparent; color: #747888; }
.fr-card-workspace { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #cdd2df transparent; }
.fr-card-preview { padding: 0 22px 6px; min-width: 0; }
.fr-card-preview-top { display: flex; justify-content: space-between; gap: 12px; color: #858997; font-size: 10px; margin-bottom: 9px; }
.fr-card-image-wrap { min-height: 180px; display: flex; justify-content: center; align-items: flex-start; }
.fr-card-canvas-slot { width: 100%; } .fr-card-canvas-slot.is-rendering { opacity: .65; } .fr-card-image-wrap :deep(canvas) { display: block; width: 100%; height: auto; border-radius: 5px; box-shadow: 0 3px 14px #283c2212; }
.fr-card-placeholder { margin: auto; padding: 28px 16px; color: #806752; text-align: center; line-height: 1.8; }
.fr-card-controls { padding: 14px 22px 8px; min-width: 0; display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }
.fr-card-fieldset { border: 0; padding: 0; margin: 0 0 15px; grid-column: 1/-1; }
.fr-card-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.fr-card-themes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.fr-card-themes button { padding: 5px 5px 6px; display: grid; justify-items: center; gap: 5px; font-size: 11px; background: transparent; border: 2px solid transparent; border-radius: 9px; }
.fr-card-themes button:hover { background: #f3f4f8; }
.fr-card-themes button[aria-pressed=true] { border-color: var(--fr-card-accent); background: var(--fr-card-soft); color: #dc315f; }
.fr-card-swatch { position: relative; display: flex; flex-direction: column; justify-content: center; gap: 6px; overflow: hidden; width: 100%; height: 39px; padding: 9px 12px; border-radius: 4px; box-shadow: inset 0 0 0 1px #00000008; }
.fr-card-swatch i { position: relative; display: block; width: 90%; height: 2px; background: #ffffffd9; z-index: 1; }
.fr-card-swatch i + i { width: 65%; height: 1px; background: #e2eaff; }
.fr-card-swatch--coral { background: linear-gradient(#eb4635 54%, #fff3dd 54%); }
.fr-card-swatch--coral i + i { background: #573a30; margin-top: 5px; }
.fr-card-swatch--sky { background: linear-gradient(135deg, #f5faff, #a9d4f6); align-items: center; }
.fr-card-swatch--sky i { background: #153d65; width: 85%; } .fr-card-swatch--sky i + i { background: #47728f; width: 65%; }
.fr-card-swatch--prism { background: #12131a; }
.fr-card-swatch--prism i { background: linear-gradient(90deg, #77b7ff, #b09cff, #ef9dcd, #ffc3a3); }
.fr-card-swatch--prism i + i { background: #c4c5d0; }
.fr-card-swatch--pearl { background: #fff; border: 3px solid #e8eaf2; flex-direction: row; align-items: flex-start; gap: 5px; }
.fr-card-swatch--pearl i { width: 46%; height: 11px; background: repeating-linear-gradient(#575b69 0 1px, transparent 1px 4px); }
.fr-card-swatch--pearl i + i { width: 38%; height: 7px; background: repeating-linear-gradient(#9196a6 0 1px, transparent 1px 4px); }
.fr-card-swatch--moss { background: #edf3e6; border-left: 5px solid #dce8cd; } .fr-card-swatch--moss i { background: #2d4935; } .fr-card-swatch--moss i + i { background: #739063; }
.fr-card-swatch--linen { background: #faf4e8; border: 1px solid #c9b89b; } .fr-card-swatch--linen i { background: #493b30; } .fr-card-swatch--linen i + i { background: #9a6740; }
.fr-card-swatch--sunset { background: linear-gradient(#fff1df, #efb5ad); align-items: center; } .fr-card-swatch--sunset i { background: #63372e; } .fr-card-swatch--sunset i + i { background: #a35242; }
.fr-card-swatch--blueprint { background: repeating-linear-gradient(0deg, transparent 0 9px, #aacde012 9px 10px), #15324d; flex-direction: row; align-items: flex-start; gap: 5px; } .fr-card-swatch--blueprint i { width: 46%; height: 11px; background: repeating-linear-gradient(#eef7ff 0 1px, transparent 1px 4px); } .fr-card-swatch--blueprint i + i { width: 38%; height: 7px; background: repeating-linear-gradient(#a5c1d4 0 1px, transparent 1px 4px); }
.fr-card-more, .fr-card-edit { grid-column: 1/-1; border-top: 1px solid #eceef3; padding: 10px 0; }
summary { display: flex; align-items: center; gap: 8px; min-height: 32px; list-style: none; font-size: 12px; font-weight: 600; color: #515b70; } summary::-webkit-details-marker { display: none; } summary::before { content: ''; width: 6px; height: 6px; flex: none; border: solid currentColor; border-width: 0 1.5px 1.5px 0; transform: rotate(-45deg); } details[open] > summary::before { transform: rotate(45deg); } summary span { margin-left: auto; color: #9095a2; font-size: 10px; font-weight: 400; }
.fr-card-options-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 15px; }
label { display: grid; gap: 5px; font-size: 12px; } select, input:not([type=checkbox]), textarea { width: 100%; min-width: 0; border: 1px solid #dfe1e8; background: #fff; color: #292e3d; border-radius: 7px; padding: 7px 9px; }
.fr-card-choice { min-width: 0; border: 0; padding: 0; margin: 0; }
.fr-card-choice legend { margin-bottom: 7px; padding: 0; font-size: 12px; color: #515b70; }
.fr-card-segments { display: flex; gap: 3px; padding: 3px; border: 1px solid #e5e8ef; border-radius: 10px; background: #f7f8fb; }
.fr-card-segments button { flex: 1; min-width: 0; min-height: 34px; padding: 5px 4px; border: 0; border-radius: 7px; background: transparent; font-size: 11px; color: #737c8f; }
.fr-card-segments button[aria-pressed=true] { background: #fff; color: #dc315f; font-weight: 600; box-shadow: 0 1px 5px #17203312; }
.fr-card-checks { display: grid; gap: 0; margin: 16px 0; padding: 2px 12px; border: 1px solid #e5e8ef; border-radius: 12px; background: #f7f8fb; }
.fr-card-checks label { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; cursor: pointer; } .fr-card-checks label + label { border-top: 1px solid #e5e8ef; }
input[type=checkbox] { appearance: none; flex: none; position: relative; margin: 0; width: 36px; height: 22px; border: 0; border-radius: 20px; background: #aab2c1; transition: background 160ms ease; }
input[type=checkbox]::before { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px #17203326; transition: transform 160ms ease; } input[type=checkbox]:checked { background: var(--fr-card-accent); } input[type=checkbox]:checked::before { transform: translateX(14px); }
input:not([type=checkbox]), textarea { border-radius: 10px; background: #f7f8fb; } input:not([type=checkbox]):focus, textarea:focus { background: #fff; }
.fr-card-source { margin-bottom: 8px; } .fr-card-edit:not([open]) summary span { display: none; } .fr-card-edit p { color: #818796; font-size: 11px; margin: 10px 0; } .fr-card-edit label { margin-top: 10px; } textarea { resize: vertical; min-height: 65px; line-height: 1.6; }
.fr-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 14px 22px 18px; border-top: 1px solid #eceef3; flex-shrink: 0; }
.fr-card-feedback-region { width: 100%; } .fr-card-feedback-region:empty { display: none; }
.fr-card-feedback { display: flex; align-items: center; gap: 9px; margin: 0; width: 100%; padding: 10px 12px; border: 1px solid #cddff5; border-radius: 10px; background: #eaf3ff; color: #306ba3; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.fr-card-feedback.is-success { background: #eaf8f4; border-color: #bce5d8; color: #267260; } .fr-card-feedback.is-error { background: #fff0f3; border-color: #f1ccd7; color: #b1435e; }
.fr-card-feedback svg { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.fr-card-export-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-left: auto; max-width: 100%; } .fr-card-export-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 10px; }
.fr-card-primary { background: var(--fr-card-accent); color: #fff; border-color: var(--fr-card-accent); } .fr-card-primary:hover { background: #dc315f; border-color: #dc315f; } .fr-card-local-note { color: #858997; font-size: 10px; } .fr-card-fallback { flex-basis: 100%; margin: 0; font-size: 11px; color: #747b8b; }
.fr-card-spinner { display: inline-block; width: 14px; height: 14px; flex: none; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: fr-card-spin .8s linear infinite; } @keyframes fr-card-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .fr-card-spinner { animation: none; } input[type=checkbox], input[type=checkbox]::before { transition: none; } }
@media (max-width: 460px) { .fr-card-dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); border-radius: 12px; } .fr-card-header { padding: 12px 16px; } .fr-card-preview { padding: 0 14px 4px; } .fr-card-controls { padding: 12px 14px 6px; } .fr-card-footer { padding: 12px 14px; } .fr-card-local-note { width: 100%; } .fr-card-export-actions { width: 100%; } .fr-card-export-actions button { flex: 1; min-width: 0; min-height: 36px; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; } }
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

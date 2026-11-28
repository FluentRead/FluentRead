<!--
 * @file src/features/image-translation/ui/MangaEntry.vue
 * 文件职责：提供安静的漫画入口、实时进度遥测、按住对照原图按钮以及按需资源首次下载说明。
 * 主要内容：普通悬浮球不可见时在视口右侧停靠连贯悬浮操作坞，内置主入口（含进度计数徽标与上下文提示）、按住对照原图按钮及次级文字面板入口；唯一文字面板与入口共享打开状态与主题；弹窗配有柔和遮罩层并遵循显式深浅主题，按源语言说明资源，圈选页使用区域入口，路由、语言、服务或会话变化关闭旧阅读内容并释放对照原图态。
 * 模块边界：不自动展开阅读面板，不下载资源、不扫描图片；单页进度属于图片运行时，所有动作通过注入端口和可信事件执行，界面只属于 closed Shadow UI。
 -->
<template>
  <div v-if="standalone" ref="dock" class="fr-manga-dock" :class="{'is-expanded': dockExpanded}" :data-theme="resolvedTheme" :data-animated="settings.animations" @mouseenter="reveal" @mouseleave="retract" @focusin="reveal" @focusout="retract">
    <button ref="launcher" class="fr-manga-launcher" :class="{'is-expanded': expanded || alwaysExpanded, 'is-touch': touchCapable, 'has-progress': !!progressPill}" type="button" :data-animated="settings.animations" :aria-label="actionLabel" :title="buttonTitle" :aria-pressed="status.active" :aria-busy="busy || status.pending" @mouseenter="reveal" @pointerdown="noteTouch" @pointermove="pointerReveal" @mouseleave="retract" @focusin="reveal" @focusout="retract" @keydown.esc.stop="collapseLauncher" @click="activate" @contextmenu.prevent="openSettings">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1V6Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M5.5 8.5h4v4h-2l-1.5 1v-1h-.5v-4Zm9.5.5h3m-3 3h3m-3 3h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <span v-if="progressPill" class="fr-manga-progress-pill" aria-hidden="true">{{ progressPill }}</span>
      <span v-if="busy || status.pending" class="fr-manga-spinner" aria-hidden="true" />
      <span v-else-if="status.errors" class="fr-manga-badge fr-manga-error-badge" aria-hidden="true">{{ errorBadge }}</span>
      <span v-else-if="status.active && completedCount > 0" class="fr-manga-badge" aria-hidden="true">✓</span>
    </button>
    <button v-if="status.active && !status.areaFallback && completedCount > 0 && onPeekOriginal" ref="peekLauncher" class="fr-manga-peek-launcher" :class="{'is-expanded': expanded || alwaysExpanded || peeking, 'is-peeking': peeking, 'is-touch': touchCapable}" type="button" :aria-label="t('按住对照原图')" :aria-pressed="peeking" :title="t('按住对照原图')" @mouseenter="reveal" @pointerdown.stop="startPeek($event)" @pointerup.stop="stopPeek" @pointercancel.stop="stopPeek" @pointerleave="stopPeek" @blur="stopPeek" @mouseleave="retract" @focusin="reveal" @focusout="retract" @contextmenu.prevent @keydown="onPeekKeydown($event)" @keyup="onPeekKeyup($event)">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /><circle cx="12" cy="12" r="2.75" stroke="currentColor" stroke-width="1.7" /></svg>
    </button>
    <button v-if="status.active && !status.areaFallback && readManga" ref="readingLauncher" class="fr-manga-reading-launcher" :class="{'is-expanded': expanded || readingOpen || readingState?.open, 'is-touch': touchCapable}" type="button" :aria-label="t(readingOpen || readingState?.open ? '关闭漫画文字' : '查看漫画文字')" :aria-expanded="!!(readingOpen || readingState?.open)" :title="t(readingOpen || readingState?.open ? '关闭漫画文字' : '查看漫画文字')" @mouseenter="reveal" @pointerdown="noteTouch" @mouseleave="retract" @focusin="reveal" @focusout="retract" @keydown.esc.stop="collapseLauncher" @click.stop="readManga($event)"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 5h12M6 9.5h12M6 14h12M6 18.5h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg></button>
  </div>
  <MangaReadingPanel v-if="reading" ref="reader" :list="reading.list" :read="reading.read" :observe="reading.observe" :copy="reading.copy" :theme="reading.theme" :translate="t" @opened="readingChanged?.(true)" @closed="readingChanged?.(false)" />
  <div v-if="visible" class="fr-manga-backdrop" :data-theme="resolvedTheme" aria-hidden="true" @click="close" />
  <aside v-if="visible" ref="dialog" class="fr-manga-entry" :data-theme="resolvedTheme" role="dialog" aria-modal="true" tabindex="-1" :aria-label="t('漫画翻译')" @keydown.esc.stop="close">
    <header><strong>{{ t('漫画翻译') }}</strong><button type="button" class="fr-manga-close" :aria-label="t('关闭')" @click="close"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></header>
    <template v-if="consent">
      <h3>{{ t('首次使用，先准备阅读资源') }}</h3>
      <p>{{ resourceDescription }}</p>
      <p class="fr-manga-hint">{{ t('首次等待可能较长。图片在本地处理，识别出的文字交给你选择的翻译服务。') }}</p>
      <button type="button" class="fr-manga-primary" :disabled="busy" @click="confirm">{{ t('准备资源并开始') }}</button>
      <button type="button" class="fr-manga-later" :disabled="busy" @click="close">{{ t('稍后') }}</button>
    </template>
    <template v-else>
      <p class="fr-manga-error" role="alert" data-i18n-ignore>{{ error }}</p>
      <button type="button" class="fr-manga-primary" :disabled="busy" @click="start">{{ t('重试') }}</button>
    </template>
    <p v-if="consent && error" class="fr-manga-error" role="alert" data-i18n-ignore>{{ error }}</p>
    <footer><button type="button" @click="openSettings">{{ t('漫画设置') }}</button></footer>
  </aside>
</template>
<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, ref, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import type {MangaTranslationStatus} from '../content/mangaSession';
import {getMangaTesseractPack} from '../ocrLanguages';
import MangaReadingPanel from './MangaReadingPanel.vue';
import type {MangaReadingList, MangaReadingResult} from '../content/mangaReadingCoordinator';
const props = defineProps<{
  status: MangaTranslationStatus; page: {site: string; route: string};
  settings: {sourceLanguage?: string; to?:string; service?:string; promptEnabled: boolean; floatingBallVisible: boolean; downloadConfirmed: boolean; animations: boolean; toolsDisplay?: string};
  toggle: () => void; inspectResources: () => Promise<boolean>; persist: (patch: Record<string, unknown>) => Promise<unknown>; openSettings: () => void;
  startAreaTranslation: () => Promise<boolean>;
  onPeekOriginal?: (peeking: boolean) => void;
  readManga?: (event: MouseEvent) => void;
  readingOpen?: boolean;
  readingState?: {open:boolean};
  readingChanged?: (open: boolean) => void;
  reading?: {list:()=>MangaReadingList;read:(token:object,signal:AbortSignal)=>Promise<MangaReadingResult>;observe:(token:object,invalid:()=>void)=>(()=>void)|undefined;copy:(text:string)=>Promise<void>;theme:'light'|'dark'|'auto'};
}>();
const {translateLegacy: t} = useUiI18n();
const consent = ref(false), busy = ref(false), error = ref(''), peeking = ref(false);
const resolvedTheme = computed<'light' | 'dark' | 'auto'>(() => props.reading?.theme ?? 'auto');
const standalone = computed(() => props.status.available && !props.settings.floatingBallVisible && props.settings.promptEnabled);
const alwaysExpanded = computed(() => props.settings.toolsDisplay !== 'hover');
const visible = computed(() => props.status.available && (consent.value || !!error.value));
const completedCount = computed(() => props.status.completed ?? 0);
const pageCount = computed(() => props.status.pageCount ?? 0);
const errorBadge = computed(() => props.status.errors > 1 ? `!${props.status.errors}` : '!');
const progressPill = computed(() => {
  if (!props.status.active || props.status.areaFallback) return '';
  if (pageCount.value > 0) return `${completedCount.value}/${pageCount.value}`;
  if (props.status.pending && typeof props.status.progress === 'number' && Number.isFinite(props.status.progress)) {
    return `${Math.max(0, Math.min(100, Math.round(props.status.progress)))}%`;
  }
  return '';
});
const tesseractResourceDescriptions = {
  rus: '需要准备俄语和英语识别资源，约 16 MB。复杂画面另需约 197 MB 的文字清除资源，已下载资源可重复使用。',
  kor: '需要准备韩语和英语识别资源，约 13 MB。复杂画面另需约 197 MB 的文字清除资源，已下载资源可重复使用。',
  ara: '需要准备阿拉伯语和英语识别资源，约 4.6 MB。复杂画面另需约 197 MB 的文字清除资源，已下载资源可重复使用。',
  heb: '需要准备希伯来语和英语识别资源，约 3.5 MB。复杂画面另需约 197 MB 的文字清除资源，已下载资源可重复使用。',
} satisfies Record<NonNullable<ReturnType<typeof getMangaTesseractPack>>, string>;
const resourceDescription = computed(() => {
  const pack = getMangaTesseractPack(props.settings.sourceLanguage ?? 'auto');
  return t(pack ? tesseractResourceDescriptions[pack] : '需要下载约 30 MB 的文字识别资源，复杂画面另需约 197 MB 的文字清除资源。下载一次后可重复使用。');
});
const actionLabel = computed(() => t(props.status.areaFallback ? '圈选漫画翻译' : props.status.active ? '暂停并显示原图' : '开启连续翻译'));
const buttonTitle = computed(() => {
  const message = busy.value ? t('正在检查阅读资源') : props.status.pending ? t(props.status.message || '正在处理当前漫画页') : props.status.errors ? t('部分页面未完成') : '';
  const pct = props.status.pending && typeof props.status.progress === 'number' && Number.isFinite(props.status.progress)
    ? `${Math.max(0, Math.min(100, Math.round(props.status.progress)))}%` : '';
  const summary = props.status.active && pageCount.value > 0
    ? (!props.status.pending && !props.status.errors && completedCount.value >= pageCount.value
      ? `${t('翻译完成')} (${completedCount.value}/${pageCount.value})`
      : `${t('已翻译')} ${completedCount.value}/${pageCount.value} ${t('页')}`)
    : '';
  const ahead = props.status.active && (props.status.ahead ?? 0) > 0 ? `${t('已预译')} ${props.status.ahead} ${t('页')}` : '';
  return [t('漫画翻译'), message, pct, summary, ahead, actionLabel.value].filter(Boolean).join(' · ');
});
let disposed = false, request = 0;
const dock = ref<HTMLElement | null>(null), dialog = ref<HTMLElement | null>(null), launcher = ref<HTMLButtonElement | null>(null), peekLauncher = ref<HTMLButtonElement | null>(null), readingLauncher = ref<HTMLButtonElement | null>(null), expanded = ref(false);
const dockExpanded = computed(() => expanded.value || alwaysExpanded.value || peeking.value || !!props.readingOpen || !!props.readingState?.open);
const touchCapable = ref((typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  || (typeof window !== 'undefined' && window.matchMedia?.('(any-pointer: coarse)').matches === true));
const reader = ref<{open:(event:Event,from?:HTMLElement|null)=>Promise<boolean>;close:()=>void}|null>(null);
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function hasVisibleFocus() {return [launcher.value, peekLauncher.value, readingLauncher.value].some(el => !!el?.matches(':focus-visible'));}
function clearIdle() {if (idleTimer !== null) clearTimeout(idleTimer);idleTimer = null;}
function reveal() {
  expanded.value = true;clearIdle();
  if (alwaysExpanded.value) return;
  if (hasVisibleFocus()) return;
  idleTimer = setTimeout(() => {idleTimer = null;if (!hasVisibleFocus() && !peeking.value) expanded.value = false;}, 2500);
}
function pointerReveal(event: PointerEvent) {if (event.pointerType === 'mouse') reveal();}
function noteTouch(event: PointerEvent) {if (event.pointerType === 'touch') touchCapable.value = true;}
function retract(event?: MouseEvent | FocusEvent) {
  if (event?.relatedTarget && [dock.value, launcher.value, peekLauncher.value, readingLauncher.value].includes(event.relatedTarget as never)) return;
  clearIdle();if (!hasVisibleFocus()) expanded.value = false;
}
function beginPeek() {
  if (peeking.value || !props.status.active || !props.onPeekOriginal) return;
  peeking.value = true;
  props.onPeekOriginal(true);
}
function startPeek(event: PointerEvent) {
  noteTouch(event);
  if (!event.isTrusted || event.button !== 0 || event.isPrimary === false) return;
  beginPeek();
}
function onPeekKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {event.stopPropagation();collapseLauncher();return;}
  if (event.key !== ' ' && event.key !== 'Enter') return;
  event.preventDefault();
  if (!event.isTrusted || event.repeat) return;
  beginPeek();
}
function onPeekKeyup(event: KeyboardEvent) {
  if (event.key === ' ' || event.key === 'Enter') stopPeek();
}
function stopPeek() {
  if (!peeking.value) return;
  peeking.value = false;
  props.onPeekOriginal?.(false);
}
function collapseLauncher() {stopPeek();launcher.value?.blur();peekLauncher.value?.blur();readingLauncher.value?.blur();clearIdle();expanded.value = false;}
function activate(event: MouseEvent) {void start();if (event.detail > 0) launcher.value?.blur();reveal();}
function close() {request++;busy.value = false;consent.value = false;error.value = '';}
async function start() {
  if (busy.value || !props.status.available) return;
  if (props.status.areaFallback) {
    const owner = ++request;busy.value = true;consent.value = false;error.value = '';
    try {const started = await props.startAreaTranslation();
      if (!disposed && owner === request) {if (started) close();else error.value = t('请在图片/漫画设置中启用圈选翻译，再拖选漫画区域。');}
    } catch (cause) {if (!disposed && owner === request) error.value = t(cause instanceof Error ? cause.message : String(cause));}
    finally {if (!disposed && owner === request) busy.value = false;}return;
  }
  if (props.status.active || props.settings.downloadConfirmed) {close();props.toggle();return;}
  const owner = ++request; busy.value = true; error.value = '';
  try {
    const ready = await props.inspectResources();
    if (disposed || owner !== request || !props.status.available) return;
    if (!ready) consent.value = true;
    else {close();props.toggle();}
  } catch (cause) {if (!disposed && owner === request) error.value = t(cause instanceof Error ? cause.message : String(cause));}
  finally {if (!disposed && owner === request) busy.value = false;}
}
async function confirm() {
  if (busy.value || !consent.value || !props.status.available) return;
  const owner = ++request;busy.value = true;error.value = '';
  try {
    await props.persist({imageTranslationMangaDownloadConfirmed: true});
    if (!disposed && owner === request && props.status.available) {close();props.toggle();}
  } catch (cause) {if (!disposed && owner === request) error.value = t(cause instanceof Error ? cause.message : String(cause));}
  finally {if (!disposed && owner === request) busy.value = false;}
}
function closeReading() {reader.value?.close();}
// 同一任务中 Promise 完成后可能立即换页；必须先撤销旧请求，不能等下一轮 Vue 更新。
watch(() => props.page.route, () => {stopPeek();close();closeReading();}, {flush:'sync'});
watch(() => props.settings.sourceLanguage, () => {close();closeReading();}, {flush:'sync'});
watch(() => [props.settings.to,props.settings.service], closeReading);
watch(() => props.status.active, active => {close();if (!active) {stopPeek();closeReading();}}, {flush:'sync'});
watch(() => props.status.areaFallback, () => {stopPeek();close();closeReading();}, {flush:'sync'});
watch(() => props.status.available, available => {if (!available) {stopPeek();close();closeReading();}}, {flush:'sync'});
watch(standalone, () => {stopPeek();clearIdle();expanded.value = false;});
watch(visible, async shown => {if (!shown) return;await nextTick();if (!disposed && visible.value) dialog.value?.focus({preventScroll: true});});
onBeforeUnmount(() => {disposed = true;stopPeek();clearIdle();close();});
defineExpose({open: start, openReading:(event:Event,from?:HTMLElement|null) => props.status.active && props.status.available && !props.status.areaFallback ? reader.value?.open(event,from) ?? Promise.resolve(false) : Promise.resolve(false), closeReading});
</script>

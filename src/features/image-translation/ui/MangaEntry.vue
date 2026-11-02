<!--
 * @file src/features/image-translation/ui/MangaEntry.vue
 * 文件职责：提供安静的漫画入口，仅在用户主动启动且缺少资源时说明首次下载。
 * 主要内容：普通悬浮球不可见时显示紧凑漫画按钮，提供可聚焦的次级文字入口；唯一文字面板与两种入口共享打开状态；按源语言说明资源，圈选页使用区域入口，路由、语言、服务或会话变化关闭旧阅读内容。
 * 模块边界：不自动展开阅读面板，不下载资源、不扫描图片；单页进度属于图片运行时，动作通过注入端口执行，界面只属于 closed Shadow UI。
 -->
<template>
  <button v-if="standalone" ref="launcher" class="fr-manga-launcher" :class="{'is-expanded': expanded || alwaysExpanded}" type="button" :data-animated="settings.animations" :aria-label="actionLabel" :title="buttonTitle" :aria-pressed="status.active" :aria-busy="busy || status.pending" @mouseenter="reveal" @pointerdown="noteTouch" @pointermove="pointerReveal" @mouseleave="retract" @focusin="reveal" @focusout="retract" @keydown.esc.stop="collapseLauncher" @click="activate" @contextmenu.prevent="openSettings">
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1m0-14c3-2 6-2 9-1v14c-3-1-6-1-9 1V6Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M5.5 8.5h4v4h-2l-1.5 1v-1h-.5v-4Zm9.5.5h3m-3 3h3m-3 3h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
    <span v-if="busy || status.pending" class="fr-manga-spinner" aria-hidden="true" />
    <span v-else-if="status.errors" class="fr-manga-badge fr-manga-error-badge" aria-hidden="true">!</span>
    <span v-else-if="status.active && (status.completed ?? 0) > 0" class="fr-manga-badge" aria-hidden="true">✓</span>
  </button>
  <button v-if="standalone && status.active && !status.areaFallback && readManga" ref="readingLauncher" class="fr-manga-reading-launcher" :class="{'is-expanded': expanded || readingOpen || readingState?.open, 'is-touch': touchCapable}" type="button" :aria-label="t(readingOpen || readingState?.open ? '关闭漫画文字' : '查看漫画文字')" :aria-expanded="!!(readingOpen || readingState?.open)" :title="t(readingOpen || readingState?.open ? '关闭漫画文字' : '查看漫画文字')" @mouseenter="reveal" @pointerdown="noteTouch" @mouseleave="retract" @focusin="reveal" @focusout="retract" @keydown.esc.stop="collapseLauncher" @click.stop="readManga($event)"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 5h12M6 9.5h12M6 14h12M6 18.5h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg></button>
  <MangaReadingPanel v-if="reading" ref="reader" :list="reading.list" :read="reading.read" :observe="reading.observe" :copy="reading.copy" :theme="reading.theme" :translate="t" @opened="readingChanged?.(true)" @closed="readingChanged?.(false)" />
  <aside v-if="visible" class="fr-manga-entry" role="dialog" :aria-label="t('漫画翻译')" @keydown.esc.stop="close">
    <header><strong>{{ t('漫画翻译') }}</strong><button type="button" class="fr-manga-close" :aria-label="t('关闭')" @click="close">×</button></header>
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
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import type {MangaTranslationStatus} from '../content/mangaSession';
import {getMangaOcrEngine, getRequiredImageOcrLanguages} from '../ocrLanguages';
import MangaReadingPanel from './MangaReadingPanel.vue';
import type {MangaReadingList, MangaReadingResult} from '../content/mangaReadingCoordinator';
const props = defineProps<{
  status: MangaTranslationStatus; page: {site: string; route: string};
  settings: {sourceLanguage?: string; to?:string; service?:string; promptEnabled: boolean; floatingBallVisible: boolean; downloadConfirmed: boolean; animations: boolean; toolsDisplay?: string};
  toggle: () => void; inspectResources: () => Promise<boolean>; persist: (patch: Record<string, unknown>) => Promise<unknown>; openSettings: () => void;
  startAreaTranslation: () => Promise<boolean>;
  readManga?: (event: MouseEvent) => void;
  readingOpen?: boolean;
  readingState?: {open:boolean};
  readingChanged?: (open: boolean) => void;
  reading?: {list:()=>MangaReadingList;read:(token:object,signal:AbortSignal)=>Promise<MangaReadingResult>;observe:(token:object,invalid:()=>void)=>(()=>void)|undefined;copy:(text:string)=>Promise<void>;theme:'light'|'dark'|'auto'};
}>();
const {translateLegacy: t} = useUiI18n();
const consent = ref(false), busy = ref(false), error = ref('');
const standalone = computed(() => props.status.available && !props.settings.floatingBallVisible && props.settings.promptEnabled);
const alwaysExpanded = computed(() => props.settings.toolsDisplay !== 'hover');
const visible = computed(() => props.status.available && (consent.value || !!error.value));
const resourceDescription = computed(() => {
  const sourceLanguage = props.settings.sourceLanguage ?? 'auto';
  if (getMangaOcrEngine(sourceLanguage) === 'paddle') return t('需要下载约 30 MB 的文字识别资源，复杂画面另需约 197 MB 的文字清除资源。下载一次后可重复使用。');
  return t(getRequiredImageOcrLanguages(sourceLanguage).includes('rus')
    ? '需要准备俄语和英语识别资源，约 16 MB。复杂画面另需约 197 MB 的文字清除资源，已下载资源可重复使用。'
    : '需要准备韩语和英语识别资源，约 13 MB。复杂画面另需约 197 MB 的文字清除资源，已下载资源可重复使用。');
});
const actionLabel = computed(() => t(props.status.areaFallback ? '圈选漫画翻译' : props.status.active ? '暂停并显示原图' : '开启连续翻译'));
const buttonTitle = computed(() => {
  const message = busy.value ? '正在检查阅读资源' : props.status.pending ? props.status.message || '正在处理当前漫画页' : props.status.errors ? '部分页面未完成' : '';
  return [t('漫画翻译'), message && t(message), actionLabel.value].filter(Boolean).join(' · ');
});
let disposed = false, request = 0;
const launcher = ref<HTMLButtonElement | null>(null), readingLauncher = ref<HTMLButtonElement | null>(null), expanded = ref(false);
const touchCapable = ref((typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  || (typeof window !== 'undefined' && window.matchMedia?.('(any-pointer: coarse)').matches === true));
const reader = ref<{open:(event:Event,from?:HTMLElement|null)=>Promise<boolean>;close:()=>void}|null>(null);
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function hasVisibleFocus() {return !!launcher.value?.matches(':focus-visible') || !!readingLauncher.value?.matches(':focus-visible');}
function clearIdle() {if (idleTimer !== null) clearTimeout(idleTimer);idleTimer = null;}
function reveal() {
  expanded.value = true;clearIdle();
  if (alwaysExpanded.value) return;
  if (hasVisibleFocus()) return;
  idleTimer = setTimeout(() => {idleTimer = null;if (!hasVisibleFocus()) expanded.value = false;}, 2500);
}
function pointerReveal(event: PointerEvent) {if (event.pointerType === 'mouse') reveal();}
function noteTouch(event: PointerEvent) {if (event.pointerType === 'touch') touchCapable.value = true;}
function retract(event?: MouseEvent | FocusEvent) {
  if (event?.relatedTarget && (event.relatedTarget === launcher.value || event.relatedTarget === readingLauncher.value)) return;
  clearIdle();if (!hasVisibleFocus()) expanded.value = false;
}
function collapseLauncher() {launcher.value?.blur();readingLauncher.value?.blur();clearIdle();expanded.value = false;}
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
watch(() => props.page.route, () => {close();closeReading();}, {flush:'sync'});
watch(() => props.settings.sourceLanguage, () => {close();closeReading();}, {flush:'sync'});
watch(() => [props.settings.to,props.settings.service], closeReading);
watch(() => props.status.active, active => {close();if (!active) closeReading();}, {flush:'sync'});
watch(() => props.status.areaFallback, () => {close();closeReading();}, {flush:'sync'});
watch(() => props.status.available, available => {if (!available) {close();closeReading();}}, {flush:'sync'});
watch(standalone, () => {clearIdle();expanded.value = false;});
onBeforeUnmount(() => {disposed = true;clearIdle();close();});
defineExpose({open: start, openReading:(event:Event,from?:HTMLElement|null) => props.status.active && props.status.available && !props.status.areaFallback ? reader.value?.open(event,from) ?? Promise.resolve(false) : Promise.resolve(false), closeReading});
</script>

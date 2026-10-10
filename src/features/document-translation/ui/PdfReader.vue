<!--
 @file src/features/document-translation/ui/PdfReader.vue
 文件职责：以左右对照的连续页面显示可划词的 PDF 原页和保持原版排版的译文页，并保留“重排阅读”作为可选的显示方式。
 主要内容：页面占满阅读区且不再附带逐页标题；原版排版在原页像素上按段落叠加可选择的译文文字层，译文逐段到达时只更新对应段落，等待中的段落显示设置中选定的翻译加载样式；公式、图表和页眉页脚保持原样，放不下的段落悬停展开；悬停译文高亮对应原文；拖选原文时把选区终点钉在指针附近，避免划过空白选中整页；重排阅读按统一计划显示完整段落并保持阅读位置；目录按阅读顺序列出识别到的章节标题并标出当前位置，点击即跳转，可自行展开或传送到页面侧栏；触控板捏合与 Ctrl/Cmd 加减号只缩放阅读内容，保留指针所在页内坐标，捏合期间复用画布和文字层、停下后重绘；缩放与显示方式使用与页面一致的菜单而非浏览器原生下拉；搜索同时匹配原文与译文并逐处跳转，译文样式可调字号与字体；只挂载附近五页，目录开关、页码、缩放和显示方式控件可以传送到页面工具栏；卸载时释放全部页面资源；显式开启的信息高亮只评分真实可选文字，进度放在按钮提示里、只有出错才在工具栏显示并可重试，配置、页面和文档失效时取消旧绘制。
 模块边界：组件只组织阅读布局、叠加层与页面调度；文档由组合根导入、翻译由既有服务提供，划词卡片由页面组合根复用统一翻译卡。
-->
<template>
  <section class="pdf-layout-viewer" :aria-label="t('document.pdfReading.readerLabel')" data-document-reader="pdf" :data-pdf-presentation="presentation" :data-segment-count="document.segments.length" :data-fluentread-pdf-title="document.fileName" :data-fluentread-pdf-source-url="sourceUrl || undefined" :data-fluentread-pdf-document-id="documentIdentity">
    <Teleport :to="controlsTarget || 'body'" :disabled="!controlsTarget">
      <div ref="toolbar" class="pdf-viewer-toolbar" :class="{inline: !controlsTarget}" data-fluentread-pdf-decoration>
        <button v-if="!outlineTarget" type="button" class="pdf-outline-toggle" :class="{active: outlineOpen}" :aria-label="t('document.pdfReading.outline')" :title="t('document.pdfReading.outline')" :aria-expanded="outlineOpen" aria-controls="pdf-reader-outline" @click="outlineOpen = !outlineOpen"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M7.5 3.5v13" stroke="currentColor" stroke-width="1.4"/></svg></button>
        <div class="pdf-page-navigation">
          <button type="button" :aria-label="t('document.pdfReading.previousPage')" :title="t('document.pdfReading.previousPage')" :disabled="currentPage <= 1" @click="jumpTo(currentPage - 1)">‹</button>
          <label><span class="pdf-control-label">{{ t('document.pdfReading.pageLabel') }}</span><input v-model="pageInput" type="number" inputmode="numeric" min="1" :max="pages.length" :aria-label="t('document.pdfReading.pageInput')" @input="editPageInput" @change="commitPageInput" @blur="commitPageInput" @keydown.enter.prevent="commitPageInput" /></label>
          <span class="pdf-page-total">/ {{ pages.length }}</span>
          <button type="button" :aria-label="t('document.pdfReading.nextPage')" :title="t('document.pdfReading.nextPage')" :disabled="currentPage >= pages.length" @click="jumpTo(currentPage + 1)">›</button>
        </div>
        <div class="pdf-zoom-control" :title="t('document.readerZoom.pdfHint')">
          <button type="button" :aria-label="t('document.pdfReading.zoomOut')" :title="t('document.pdfReading.zoomOut')" :disabled="scale <= ZOOM_STEPS[0]" @click="stepZoom(-1)">−</button>
          <div class="pdf-menu" :class="{open: openMenu === 'zoom'}">
            <button type="button" class="pdf-menu-button" aria-haspopup="listbox" :aria-expanded="openMenu === 'zoom'" :aria-label="t('document.pdfReading.zoomLabel')" @click="openMenu = openMenu === 'zoom' ? null : 'zoom'">{{ zoomLabel }}<i aria-hidden="true" /></button>
            <ul v-if="openMenu === 'zoom'" class="pdf-menu-list" role="listbox" :aria-label="t('document.pdfReading.zoomLabel')">
              <li v-for="option in zoomOptions" :key="option.value" role="option" :aria-selected="zoom === option.value" :class="{selected: zoom === option.value}" :data-value="option.value" @click="chooseZoom(option.value); openMenu = null">{{ option.label }}</li>
            </ul>
          </div>
          <button type="button" :aria-label="t('document.pdfReading.zoomIn')" :title="t('document.pdfReading.zoomIn')" :disabled="scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1]" @click="stepZoom(1)">+</button>
        </div>
        <div v-if="mode !== 'source'" class="pdf-presentation-control pdf-menu" :class="{open: openMenu === 'presentation'}">
          <button type="button" class="pdf-menu-button" aria-haspopup="listbox" :aria-expanded="openMenu === 'presentation'" :aria-label="t('document.pdfReading.presentationLabel')" @click="openMenu = openMenu === 'presentation' ? null : 'presentation'">{{ t(presentation === 'layout' ? 'document.pdfReading.layoutPresentation' : 'document.pdfReading.readablePresentation') }}<i aria-hidden="true" /></button>
          <ul v-if="openMenu === 'presentation'" class="pdf-menu-list" role="listbox" :aria-label="t('document.pdfReading.presentationLabel')">
            <li v-for="value in PRESENTATIONS" :key="value" role="option" :aria-selected="presentation === value" :class="{selected: presentation === value}" :data-value="value" @click="choosePresentation(value)">{{ t(value === 'layout' ? 'document.pdfReading.layoutPresentation' : 'document.pdfReading.readablePresentation') }}</li>
          </ul>
        </div>
        <div class="pdf-menu pdf-search" :class="{open: openMenu === 'search'}">
          <button type="button" class="pdf-tool-button" :class="{active: openMenu === 'search' || searchHits.length > 0}" aria-haspopup="dialog" :aria-expanded="openMenu === 'search'" :aria-label="t('document.pdfReading.search')" :title="t('document.pdfReading.search')" @click="toggleSearch"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="m13.2 13.2 3.6 3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
          <div v-if="openMenu === 'search'" class="pdf-menu-panel pdf-search-panel" role="dialog" :aria-label="t('document.pdfReading.search')">
            <input ref="searchInput" v-model="searchQuery" type="search" :placeholder="t('document.pdfReading.searchPlaceholder')" :aria-label="t('document.pdfReading.search')" @keydown.enter.prevent="stepSearch($event.shiftKey ? -1 : 1)" />
            <span class="pdf-search-count" role="status">{{ searchHits.length ? `${searchIndex + 1} / ${searchHits.length}` : searchQuery.trim() ? '0' : '' }}</span>
            <button type="button" :disabled="!searchHits.length" :aria-label="t('document.pdfReading.searchPrevious')" :title="t('document.pdfReading.searchPrevious')" @click="stepSearch(-1)">‹</button>
            <button type="button" :disabled="!searchHits.length" :aria-label="t('document.pdfReading.searchNext')" :title="t('document.pdfReading.searchNext')" @click="stepSearch(1)">›</button>
          </div>
        </div>
        <div v-if="mode !== 'source'" class="pdf-menu pdf-style" :class="{open: openMenu === 'style'}">
          <button type="button" class="pdf-tool-button" :class="{active: openMenu === 'style'}" aria-haspopup="dialog" :aria-expanded="openMenu === 'style'" :aria-label="t('document.pdfReading.style')" :title="t('document.pdfReading.style')" @click="openMenu = openMenu === 'style' ? null : 'style'"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 15.5 8.2 4.5h1.2l4.2 11M5.6 11.8h6.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 6.5v6M13 9.5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
          <div v-if="openMenu === 'style'" class="pdf-menu-panel pdf-style-panel" role="dialog" :aria-label="t('document.pdfReading.style')">
            <div class="pdf-style-row"><span>{{ t('document.pdfReading.styleSize') }}</span><div class="pdf-style-stepper"><button type="button" :disabled="textScale <= 0.8" :aria-label="t('document.pdfReading.zoomOut')" @click="textScale = Math.max(0.8, Math.round((textScale - 0.05) * 100) / 100)">−</button><output>{{ Math.round(textScale * 100) }}%</output><button type="button" :disabled="textScale >= 1.3" :aria-label="t('document.pdfReading.zoomIn')" @click="textScale = Math.min(1.3, Math.round((textScale + 0.05) * 100) / 100)">+</button></div></div>
            <label class="pdf-style-row pdf-style-switch"><span>{{ t('document.pdfReading.styleHighlight') }}</span><input v-model="hoverHighlight" type="checkbox" role="switch" /></label>
            <div class="pdf-style-row"><span>{{ t('document.pdfReading.styleFont') }}</span><div class="pdf-style-fonts" role="group"><button v-for="font in FONT_CHOICES" :key="font" type="button" :class="{selected: textFont === font}" :aria-pressed="textFont === font" @click="textFont = font">{{ t(`document.pdfReading.styleFont.${font}`) }}</button></div></div>
          </div>
        </div>
        <button v-if="informationHighlight" class="pdf-information-highlight" type="button" :aria-pressed="informationState.enabled" :disabled="!informationHighlight.available" :title="informationState.enabled ? `${t(`informationHighlight.phase.${informationState.phase}`)} · ${t('informationHighlight.progress', {paragraphs: informationState.processedParagraphs, spans: informationState.highlightedSpans})}` : undefined" @click="informationController?.setEnabled(!informationState.enabled)">{{ t('informationHighlight.title') }}</button>
        <span v-if="informationState.enabled && informationState.phase === 'error'" class="pdf-information-status" role="status">{{ t('informationHighlight.phase.error') }} <button type="button" @click="informationController?.retry()">{{ t('informationHighlight.retry') }}</button></span>
      </div>
    </Teleport>
    <div class="pdf-reader-body">
    <Teleport :to="outlineTarget || 'body'" :disabled="!outlineTarget">
    <nav v-if="outlineOpen || outlineTarget" id="pdf-reader-outline" class="pdf-reader-outline" :class="{hosted: outlineTarget}" :aria-label="t('document.pdfReading.outline')" data-fluentread-pdf-decoration>
      <div v-if="outline.length" class="pdf-outline-language" role="group" :aria-label="t('document.pdfReading.outline')">
        <button type="button" :class="{selected: outlineLanguage === 'source'}" :aria-pressed="outlineLanguage === 'source'" @click="outlineLanguage = 'source'">{{ t('document.pdfReading.original') }}</button>
        <button type="button" :class="{selected: outlineLanguage === 'translated'}" :aria-pressed="outlineLanguage === 'translated'" @click="outlineLanguage = 'translated'">{{ t('document.pdfReading.translated') }}</button>
      </div>
      <button v-for="item in outlineItems" :key="item.id" type="button" class="pdf-outline-item" :class="{current: item.id === activeOutlineId}" :style="{paddingLeft: `${12 + (item.level - 1) * 14}px`}" :aria-current="item.id === activeOutlineId ? 'location' : undefined" :title="item.source" data-i18n-ignore @click="jumpToPosition(item.pageIndex, item.y)"><span>{{ item.title }}</span><small>{{ item.pageIndex + 1 }}</small></button>
    </nav>
    </Teleport>
    <div ref="viewport" class="pdf-page-scroll" data-pdf-scroll tabindex="0" :data-reader-zoom="scale" :aria-label="t('document.pdfReading.continuousPages')" @scroll.passive="scheduleViewport" @keydown="handleViewportKey">
      <div class="pdf-page-list" :style="{ height: `${totalHeight}px`, width: `${totalWidth}px` }">
        <article v-for="layout in residentLayouts" :key="layout.page.pageNumber" class="pdf-page-row" :aria-label="t('document.pdfReading.pageNumber', {page: layout.page.pageNumber})" :data-page-number="layout.page.pageNumber" :data-render-state="states.get(layout.page.pageNumber)?.status ?? 'pending'" :style="{ top: `${layout.top}px`, height: `${layout.rowHeight}px` }">
          <div class="pdf-page-stage" :class="{single: mode !== 'bilingual', stacked: stackedBilingual}" :style="{'--pdf-page-width': `${layout.width}px`, '--pdf-page-height': `${layout.height}px`}">
            <figure v-if="mode !== 'translated'" class="pdf-page-column" :aria-label="t('document.pdfReading.original')">
              <div class="pdf-page-frame">
                <div :ref="element => setPageHost(layout.page.pageNumber, 'source', element)" class="pdf-canvas-host" :style="canvasHostStyle(layout)" />
                <i v-if="highlight?.pageNumber === layout.page.pageNumber" class="pdf-source-highlight" :style="highlight.style" data-fluentread-pdf-decoration aria-hidden="true" />
                <i v-if="searchHighlight?.pageNumber === layout.page.pageNumber" class="pdf-source-highlight search" :style="searchHighlight.style" data-fluentread-pdf-decoration aria-hidden="true" />
                <span v-if="!states.has(layout.page.pageNumber) || states.get(layout.page.pageNumber)?.status === 'loading'" class="pdf-page-loading" data-fluentread-pdf-decoration role="status">{{ t('document.pdfReading.loadingSource') }}</span>
              </div>
            </figure>
            <figure v-if="mode !== 'source'" class="pdf-page-column translated" :aria-label="t('document.pdfReading.translated')">
              <article v-if="presentation === 'readable'" :ref="element => setReadingHost(layout.page.pageNumber, element)" class="pdf-reading-sheet" :data-pdf-reading-page="layout.page.pageNumber" :style="{'--pdf-reading-font-size': `${readingFontSize}px`}">
                <template v-for="entry in readingPlans.get(layout.page.pageNumber)?.entries" :key="entry.id">
                  <figure v-if="entry.kind === 'region'" class="pdf-reading-region" :data-pdf-region-id="entry.id" :data-pdf-region-kind="entry.role" :data-pdf-source-rect="JSON.stringify(entry.sourceRect)">
                    <div :ref="element => setRegionHost(layout.page.pageNumber, entry.id, element)" class="pdf-region-canvas" :style="{width: `${entry.sourceRect.width * (entry.role === 'figure' ? 2 : 1.5) * readingFontSize / 16}px`, aspectRatio: `${entry.sourceRect.width} / ${entry.sourceRect.height}`}" :aria-label="t('document.pdfReading.preservedRegion')" />
                  </figure>
                  <p v-else class="pdf-reading-paragraph" :class="paragraphClasses(entry)" :data-pdf-segment-index="entry.segmentIndex" :data-pdf-source-text="entry.source" :data-pdf-source-id="entry.id" :data-pdf-role="entry.role" data-i18n-ignore>{{ entry.text }}<span v-if="translating && !entry.translated && isPending(entry.segmentIndex)" class="pdf-translation-spinner inline" data-fluentread-pdf-decoration aria-hidden="true"><TranslationLoadingPreview :loading-style="loadingStyle" :animated="animated" /></span></p>
                </template>
              </article>
              <div v-else class="pdf-page-frame">
                <div :ref="element => setPageHost(layout.page.pageNumber, 'translated', element)" class="pdf-canvas-host" :style="canvasHostStyle(layout)" />
                <div class="pdf-translation-layer" data-fluentread-pdf-translation :data-pdf-reading-page="layout.page.pageNumber" :style="layerStyle(layout)" @pointerleave="highlight = undefined">
                  <i v-if="searchHighlight?.pageNumber === layout.page.pageNumber" class="pdf-source-highlight search" :style="searchHighlight.style" data-fluentread-pdf-decoration aria-hidden="true" />
                  <template v-for="entry in overlayPages.get(layout.page.pageNumber)" :key="entry.id">
                    <div v-if="entry.translated" class="pdf-translation-block" :class="{overflowing: entry.overflow, heading: entry.role === 'heading'}" :style="entry.boxStyle" :data-pdf-segment-index="entry.segmentIndex" :data-pdf-source-text="entry.source" :data-pdf-source-id="entry.id" :data-pdf-role="entry.role" data-i18n-ignore @pointerenter="showHighlight(layout, entry)">
                      <i v-for="(rect, index) in entry.eraseStyles" :key="index" class="pdf-translation-erase" :style="rect" aria-hidden="true" />
                      <p class="pdf-translation-text" :style="entry.textStyle" data-fluentread-pdf-lines><span v-for="(line, index) in entry.lines" :key="index" :class="{justified: line.justified}">{{ line.text }}</span></p>
                    </div>
                    <span v-else-if="translating && entry.pending" class="pdf-translation-spinner" :style="entry.spinnerStyle" :data-pdf-pending-segment="entry.segmentIndex" data-fluentread-pdf-decoration role="status" :aria-label="t('document.pdfReading.translatingBlock')"><TranslationLoadingPreview :loading-style="loadingStyle" :animated="animated" /></span>
                  </template>
                </div>
                <span v-if="!states.has(layout.page.pageNumber) || states.get(layout.page.pageNumber)?.status === 'loading'" class="pdf-page-loading" data-fluentread-pdf-decoration role="status">{{ t('document.pdfReading.loadingTranslation') }}</span>
              </div>
            </figure>
          </div>
          <div v-if="states.get(layout.page.pageNumber)?.status === 'error'" class="pdf-page-error" role="alert"><span>{{ errorFor(layout.page.pageNumber) }}</span><button type="button" @click="scheduler?.retry(layout.index)">{{ t('document.pdfReading.retryPage') }}</button></div>
        </article>
      </div>
    </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import TranslationLoadingPreview from '@/src/ui/components/TranslationLoadingPreview.vue';
import {DEFAULT_TRANSLATION_LOADING_STYLE, type TranslationLoadingStyle} from '@/src/core/config/translationLoadingStyle';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import type {ParsedDocument, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {fitPdfBlockText, pdfOverlayBlocks, type PdfBlockFit, type PdfOverlayBlock} from '@/src/features/document-translation/core/pdfBlockFit';
import {buildPdfReadingPlan, type PdfReadingPlan, type PdfReadingPresentation, type PdfReadingTextEntry} from '@/src/features/document-translation/core/pdfReadingPlan';
import {sampledBackgroundRgb, sampledForegroundColor} from '@/src/features/document-translation/ui/pdfPreview';
import {createPdfReaderRenderPort, pdfReaderPageKey, pdfReaderPageWindow, PdfReaderScheduler, type PdfReaderMode, type PdfReaderPageState} from '@/src/features/document-translation/ui/pdfReader';
import {installInformationHighlight, type InformationHighlightController} from '@/src/features/information-highlight/public';
import {DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, type InformationHighlightPreferences} from '@/src/core/config/informationHighlight';
import {matchesConfiguredHotkey} from '@/src/core/hotkey';
import type {InformationHighlightResult, InformationHighlightState} from '@/src/features/information-highlight/protocol';
import {installDocumentZoomGestures, type DocumentZoomPoint} from './documentZoom';

const props = withDefaults(defineProps<{document: ParsedDocument; translations?: readonly string[]; mode: PdfReaderMode; sourceUrl?: string; presentation?: PdfReadingPresentation; translating?: boolean; controlsTarget?: HTMLElement | null; outlineTarget?: HTMLElement | null; loadingStyle?: TranslationLoadingStyle; animated?: boolean; informationHighlight?: {preferences: InformationHighlightPreferences; scoreLocal(text: string, signal: AbortSignal): Promise<InformationHighlightResult>; available: boolean}}>(), {translations: () => [], sourceUrl: '', presentation: 'layout', translating: false, controlsTarget: null, outlineTarget: null, loadingStyle: DEFAULT_TRANSLATION_LOADING_STYLE, animated: true});
const emit = defineEmits<{ 'update:presentation': [value: PdfReadingPresentation]; 'page-change': [page: number] }>();
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const PRESENTATIONS: PdfReadingPresentation[] = ['layout', 'readable'];
const PAGE_GUTTER = 12;
const SERIF_FAMILY = '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, Georgia, "Times New Roman", serif';
const SANS_FAMILY = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Arial Unicode MS", Arial, sans-serif';
function paragraphClasses(entry: PdfReadingTextEntry): Record<string, boolean> {
  return {'pdf-reading-heading': entry.role === 'heading', 'pdf-reading-caption': entry.role === 'caption', 'pdf-reading-metadata': entry.role === 'metadata', 'pdf-reading-footer': entry.role === 'footer', 'pdf-reading-untranslated': !entry.translated};
}
const presentation = ref<PdfReadingPresentation>(props.presentation);
watch(() => props.presentation, value => {presentation.value = value;});
const {t} = useUiI18n();
const viewport = ref<HTMLElement>();
const toolbar = ref<HTMLElement>();
const rasterScale = ref(1);
let disposeZoomGestures: (() => void) | undefined;
let rasterTimer: ReturnType<typeof setTimeout> | undefined;
let zoomPoint: DocumentZoomPoint | undefined;
interface ZoomAnchor {page: number; column: number; x: number; y: number; clientX: number; clientY: number}
let pendingZoomAnchor: ZoomAnchor | undefined;
let informationController: InformationHighlightController | undefined, informationWanted = false;
const informationState = shallowRef<InformationHighlightState>({enabled: false, phase: 'idle', sessionId: '0', processedParagraphs: 0, queuedParagraphs: 0, highlightedSpans: 0, mode: props.informationHighlight?.preferences.mode ?? DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES.mode});
/** 与网页相同的快捷键开关当前文档，等同于点击工具栏按钮。 */
function handleInformationHotkey(event: KeyboardEvent): void {
  const settings = props.informationHighlight;
  if (!event.isTrusted || event.repeat || !settings?.available || !settings.preferences.hotkeyEnabled || !informationController
    || !matchesConfiguredHotkey(event, 'custom', settings.preferences.hotkey)) return;
  event.preventDefault(); event.stopPropagation();
  informationController.setEnabled(!informationState.value.enabled);
}
function syncInformationHighlight(): void {
  const settings = props.informationHighlight;
  if (!settings || !viewport.value) {informationController?.dispose(); informationController = undefined; informationWanted = false; return;}
  informationController ??= installInformationHighlight(viewport.value.ownerDocument, settings.preferences, {
    scope: viewport.value, isCurrent: () => !closed && Boolean(props.informationHighlight?.available),
    scoreLocal: (text, signal) => props.informationHighlight!.scoreLocal(text, signal), changed: state => {informationState.value = state;},
  });
  informationController.updatePreferences(settings.preferences);
  // 设置中的开关决定文档打开时的初始状态；工具栏按钮只临时切换当前文档。
  const wanted = settings.available && settings.preferences.enabled;
  if (!settings.available) informationController.setEnabled(false);
  else if (wanted !== informationWanted) informationController.setEnabled(wanted);
  informationWanted = wanted;
}
watch(() => [props.informationHighlight?.available, props.informationHighlight?.preferences.enabled, props.informationHighlight?.preferences.mode, props.informationHighlight?.preferences.density, props.informationHighlight?.preferences.color, props.informationHighlight?.preferences.style, props.informationHighlight?.preferences.intensity], syncInformationHighlight, {flush: 'post'});
const zoom = ref('fit');
/** 工具栏菜单同一时间只展开一个；点击别处或按 Esc 收起。 */
const openMenu = ref<'zoom' | 'presentation' | 'search' | 'style' | null>(null);
/** 工具栏可在小窗口分组换行；浮层按实际按钮位置展开，再把横向边界收进窗口。 */
function fitToolbarMenus(): void {
  if (closed || !openMenu.value) return;
  const view = toolbar.value?.ownerDocument.defaultView;
  const width = view?.innerWidth, height = view?.innerHeight;
  if (!width || !height) return;
  for (const menu of toolbar.value?.querySelectorAll<HTMLElement>('.pdf-menu-list,.pdf-menu-panel') ?? []) {
    if (typeof menu.getBoundingClientRect !== 'function') continue;
    menu.style.marginLeft = '0px'; menu.style.top = ''; menu.style.bottom = ''; menu.style.maxHeight = '';
    let box = menu.getBoundingClientRect();
    const above = Math.max(0, (menu.parentElement?.getBoundingClientRect().top ?? box.top) - 8);
    const below = Math.max(0, height - 8 - box.top);
    if (below < Math.min(200, box.height) && above > below) {
      menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 8px)'; menu.style.maxHeight = `${above}px`;
    } else menu.style.maxHeight = `${below}px`;
    menu.style.overflowY = 'auto';
    box = menu.getBoundingClientRect();
    const offset = Math.max(8 - box.left, Math.min(0, width - 8 - box.right));
    menu.style.marginLeft = `${offset}px`;
  }
}
watch(openMenu, () => {void nextTick(fitToolbarMenus);}, {flush: 'post'});
/** 译文样式只影响原版排版里的译文文字：字号在原文字号上按比例调整，字体可以跟随原文或固定为宋体、黑体；选择保存在本机。 */
const FONT_CHOICES = ['auto', 'serif', 'sans'] as const;
const STYLE_KEY = 'fluentread.pdfReader.textStyle';
function storedStyle(): {scale: number; font: typeof FONT_CHOICES[number]; highlight: boolean} {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(STYLE_KEY) || '{}');
    return {scale: Number.isFinite(value.scale) ? Math.min(1.3, Math.max(0.8, value.scale)) : 1, font: FONT_CHOICES.includes(value.font) ? value.font : 'auto', highlight: value.highlight !== false};
  } catch {return {scale: 1, font: 'auto', highlight: true};}
}
/** 悬停译文时在原文页标出对应段落；觉得干扰可以关掉。 */
const hoverHighlight = ref(storedStyle().highlight);
const textScale = ref(storedStyle().scale);
const textFont = ref<typeof FONT_CHOICES[number]>(storedStyle().font);
watch([textScale, textFont, hoverHighlight], ([scaleValue, font, highlightValue]) => {if (!highlightValue) highlight.value = undefined; try {globalThis.localStorage?.setItem(STYLE_KEY, JSON.stringify({scale: scaleValue, font, highlight: highlightValue}));} catch { /* 无法写入时只在本次阅读生效。 */ }});
/** 搜索同时匹配原文与译文，按阅读顺序列出命中的段落；回车跳到下一处，Shift+回车回到上一处。 */
const searchInput = ref<HTMLInputElement>();
const searchQuery = ref('');
const searchIndex = ref(0);
const searchHits = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (!query) return [];
  return pages.value.flatMap((page, pageIndex) => page.blocks.flatMap(block => {
    const source = props.document.segments[block.segmentIndex]?.source ?? '';
    const translation = props.translations[block.segmentIndex] ?? '';
    return block.segmentIndex >= 0 && (source.toLocaleLowerCase().includes(query) || translation.toLocaleLowerCase().includes(query)) ? [{pageIndex, pageNumber: page.pageNumber, rotation: page.rotation, x: block.x, y: block.y, width: block.width, height: block.height}] : [];
  }));
});
const searchHighlight = computed(() => {
  const hit = searchHits.value[searchIndex.value];
  if (!hit || hit.rotation || openMenu.value !== 'search') return undefined;
  const s = scale.value;
  return {pageNumber: hit.pageNumber, style: {left: px(hit.x * s - 3), top: px(hit.y * s - 3), width: px(hit.width * s + 6), height: px(hit.height * s + 6)}};
});
function showSearchHit(): void {const hit = searchHits.value[searchIndex.value]; if (hit) jumpToPosition(hit.pageIndex, hit.y);}
function stepSearch(direction: 1 | -1): void {
  const count = searchHits.value.length;
  if (!count) return;
  searchIndex.value = (searchIndex.value + direction + count) % count;
  showSearchHit();
}
function toggleSearch(): void {
  openMenu.value = openMenu.value === 'search' ? null : 'search';
  if (openMenu.value === 'search') void nextTick(() => searchInput.value?.focus());
}
watch(searchQuery, () => {searchIndex.value = 0; showSearchHit();});
const zoomOptions = computed(() => [{value: 'fit', label: t('document.pdfReading.fitWidth')}, {value: 'page', label: t('document.pdfReading.fitPage')}, ...ZOOM_STEPS.map(step => ({value: String(step), label: `${Math.round(step * 100)}%`}))]);
const zoomLabel = computed(() => zoomOptions.value.find(option => option.value === zoom.value)?.label ?? `${Math.round(Number(zoom.value) * 100)}%`);
function choosePresentation(value: PdfReadingPresentation): void {openMenu.value = null; if (presentation.value === value) return; presentation.value = value; emit('update:presentation', value);}
function closeMenus(event: Event): void {
  if (!openMenu.value) return;
  if (event.type === 'keydown' ? (event as KeyboardEvent).key === 'Escape' : !(event.target as Element | null)?.closest?.('.pdf-menu')) openMenu.value = null;
}
const pageInput = ref(1);
const currentPage = ref(1);
const viewportWidth = ref(920);
const viewportHeight = ref(720);
const states = shallowRef(new Map<number, PdfReaderPageState>());
const residentIndexes = ref<number[]>([]);
const documentIdentity = ref(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
const pages = computed(() => props.document.binary?.kind === 'pdf' ? props.document.binary.pages : []);
const numericZoom = computed(() => zoom.value === 'fit' || zoom.value === 'page' ? 1 : Number(zoom.value));
const readingFontSize = computed(() => 16 * numericZoom.value);
const readingHeights = shallowRef(new Map<number, number>());
const readable = computed(() => presentation.value === 'readable' && props.mode !== 'source');
const readingPlans = computed(() => new Map<number, PdfReadingPlan>(readable.value ? residentIndexes.value.flatMap(index => {
  const page = pages.value[index];
  return page ? [[page.pageNumber, buildPdfReadingPlan(props.document, page, props.translations)] as [number, PdfReadingPlan]] : [];
}) : []));
const stackedBilingual = computed(() => props.mode === 'bilingual' && viewportWidth.value < 900);
const scale = computed(() => {
  if (zoom.value !== 'fit' && zoom.value !== 'page') return Number(zoom.value);
  const maxPageWidth = pages.value.reduce((width, page) => Math.max(width, page.width), 1);
  const columns = props.mode === 'bilingual' && !stackedBilingual.value ? 2 : 1;
  const widthScale = (viewportWidth.value - PAGE_GUTTER * 2 - (columns - 1) * PAGE_GUTTER) / columns / maxPageWidth;
  const maxPageHeight = pages.value.reduce((height, page) => Math.max(height, page.height), 1);
  const fitted = zoom.value === 'page' ? Math.min(widthScale, (viewportHeight.value - PAGE_GUTTER * 2) / maxPageHeight) : widthScale;
  return Math.max(1 / maxPageWidth, Math.min(3, fitted));
});
interface PageLayout {page: PdfDocumentPage; index: number; top: number; rowHeight: number; width: number; height: number}
const layouts = computed<PageLayout[]>(() => {
  let top = PAGE_GUTTER;
  return pages.value.map((page, index) => {
    const width = Math.max(1, page.width * scale.value);
    const height = Math.max(1, page.height * scale.value);
    const translatedHeight = readable.value ? readingHeights.value.get(page.pageNumber) ?? height : height;
    const rowHeight = props.mode === 'source' ? height : props.mode === 'translated' ? translatedHeight
      : stackedBilingual.value ? height + PAGE_GUTTER + translatedHeight : Math.max(height, translatedHeight);
    const layout = {page, index, top, rowHeight, width, height};
    top += rowHeight + PAGE_GUTTER;
    return layout;
  });
});
const totalHeight = computed(() => {const last = layouts.value.at(-1); return last ? last.top + last.rowHeight + PAGE_GUTTER : 0;});
const totalWidth = computed(() => {
  const columns = props.mode === 'bilingual' && !stackedBilingual.value ? 2 : 1;
  return layouts.value.reduce((width, layout) => Math.max(width, layout.width * columns + PAGE_GUTTER * (columns + 1)), 0);
});
const residentLayouts = computed(() => residentIndexes.value.map(index => layouts.value[index]).filter(Boolean).sort((left, right) => left.index - right.index));
function canvasHostStyle(layout: PageLayout): Record<string, string> {
  return {width: `${layout.page.width * rasterScale.value}px`, height: `${layout.page.height * rasterScale.value}px`, transform: `scale(${scale.value / rasterScale.value})`};
}

/** 记录指针下页面内的坐标；单独记录栏位，双语间距和居中留白不会被误当作页面一起放大。 */
function captureZoomAnchor(point?: DocumentZoomPoint): ZoomAnchor | undefined {
  const scroll = viewport.value;
  if (!scroll || typeof scroll.getBoundingClientRect !== 'function') return;
  const rect = scroll.getBoundingClientRect();
  const clientX = point?.clientX ?? rect.left + scroll.clientWidth / 2;
  const clientY = point?.clientY ?? rect.top + scroll.clientHeight / 2;
  let nearest: {element: HTMLElement; distance: number; page: number; column: number} | undefined;
  for (const row of scroll.querySelectorAll<HTMLElement>('.pdf-page-row')) {
    for (const [column, element] of Array.from(row.querySelectorAll<HTMLElement>('.pdf-page-column')).entries()) {
      if (typeof element.getBoundingClientRect !== 'function') continue;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const distance = Math.max(box.left - clientX, 0, clientX - box.right) + Math.max(box.top - clientY, 0, clientY - box.bottom);
      if (!nearest || distance < nearest.distance) nearest = {element, distance, page: Number(row.dataset.pageNumber), column};
    }
  }
  if (!nearest) return;
  const box = nearest.element.getBoundingClientRect();
  return {page: nearest.page, column: nearest.column, x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height, clientX, clientY};
}
function restoreZoomAnchor(anchor: ZoomAnchor): boolean {
  const scroll = viewport.value;
  const column = scroll?.querySelector(`[data-page-number="${anchor.page}"]`)?.querySelectorAll<HTMLElement>('.pdf-page-column')[anchor.column];
  if (!scroll || !column || typeof column.getBoundingClientRect !== 'function') return false;
  const box = column.getBoundingClientRect();
  if (!box.width || !box.height) return false;
  scroll.scrollLeft += box.left + box.width * anchor.x - anchor.clientX;
  scroll.scrollTop += box.top + box.height * anchor.y - anchor.clientY;
  return true;
}
function setGestureZoom(value: number, point?: DocumentZoomPoint): void {
  zoomPoint = point;
  if (point) {
    // 捏合时复用当前画布和文字层，手势停下再按最终比例重绘，避免连续取消 PDF.js 渲染。
    clearTimeout(rasterTimer);
    rasterTimer = setTimeout(() => {rasterTimer = undefined; if (!closed) {rasterScale.value = scale.value; updateViewport();}}, 160);
  } else {clearTimeout(rasterTimer); rasterTimer = undefined;}
  zoom.value = String(value);
  if (!point) rasterScale.value = scale.value;
}
function bindZoomGestures(): void {
  disposeZoomGestures?.();
  if (viewport.value) disposeZoomGestures = installDocumentZoomGestures(viewport.value, {getScale: () => scale.value, setScale: setGestureZoom, minScale: 0.1, maxScale: 3, reset: resetZoom});
}
function chooseZoom(value: string): void {
  bindZoomGestures();
  clearTimeout(rasterTimer); rasterTimer = undefined; zoomPoint = undefined;
  zoom.value = value; rasterScale.value = scale.value;
}
function resetZoom(): void {chooseZoom('fit');}
watch(zoom, () => {pendingZoomAnchor = captureZoomAnchor(zoomPoint); zoomPoint = undefined;}, {flush: 'pre'});
watch(scale, value => {if (rasterTimer === undefined) rasterScale.value = value;}, {flush: 'sync'});

interface OverlayEntry {
  id: string; segmentIndex: number; source: string; role: string; translated: boolean; pending: boolean; overflow: boolean;
  lines: Array<{text: string; justified: boolean}>; boxStyle: Record<string, string>; textStyle: Record<string, string>; eraseStyles: Array<Record<string, string>>; spinnerStyle: Record<string, string>;
  rect: {x: number; y: number; width: number; height: number};
}
const overlayBlocks = new WeakMap<PdfDocumentPage, PdfOverlayBlock[]>();
const fitCache = new WeakMap<object, {text: string; scale: number; style: string; fit: PdfBlockFit}>();
const blockColors = shallowRef(new Map<string, {background: string; foreground: string}>());
const highlight = ref<{pageNumber: number; style: Record<string, string>}>();
/** 目录来自版面分析识别出的标题；编号的层数决定缩进，已有译文时显示译文标题。 */
interface OutlineItem {id: string; pageIndex: number; y: number; level: number; source: string; segmentIndex: number}
const outlineOpen = ref(false);
/** 目录标题的语言由读者选择；选了译文而某个标题尚未译出时先显示原文。 */
const outlineLanguage = ref<'source' | 'translated'>('translated');
const activeOutlineId = ref('');
const outline = computed<OutlineItem[]>(() => pages.value.flatMap((page, pageIndex) => page.blocks.flatMap(block => {
  const source = props.document.segments[block.segmentIndex]?.source?.trim() ?? '';
  if (block.kind !== 'heading' || !source || source.length > 140) return [];
  const numbering = /^(\d+(?:\.\d+)*)\.?\s/u.exec(source)?.[1];
  return [{id: `pdf-${page.pageNumber}-segment-${block.segmentIndex}`, pageIndex, y: block.y, level: Math.min(3, numbering ? numbering.split('.').length : 1), source, segmentIndex: block.segmentIndex}];
})));
const outlineItems = computed(() => (outline.value.length ? outline.value : pages.value.map((page, pageIndex) => ({id: `pdf-page-${page.pageNumber}`, pageIndex, y: 0, level: 1, source: t('document.pdfReading.pageNumber', {page: page.pageNumber}), segmentIndex: -1}))).map(item => {
  const value = props.translations[item.segmentIndex];
  return {...item, title: outlineLanguage.value === 'translated' && hasDistinctTranslation(item.source, value) ? value! : item.source};
}));
let measureContext: CanvasRenderingContext2D | null | undefined;
function measureText(family: string): (text: string, fontSize: number, weight: number) => number {
  if (measureContext === undefined) {
    try {measureContext = globalThis.document.createElement('canvas').getContext('2d');} catch {measureContext = null;}
  }
  const context = measureContext;
  return (text, fontSize, weight) => {
    const measured = context?.measureText ? (context.font = `${weight} ${fontSize}px ${family}`, context.measureText(text).width) : NaN;
    // 无法测量字体的环境按全角一字宽、半角半字宽估算，保证分行仍然确定。
    return Number.isFinite(measured) && measured > 0 ? measured : Array.from(text).reduce((sum, character) => sum + (/[⺀-￿]/u.test(character) ? fontSize : fontSize * 0.55), 0);
  };
}
function isPending(segmentIndex: number): boolean {return !props.translations[segmentIndex]?.trim();}
const px = (value: number) => `${Math.round(value * 100) / 100}px`;
const overlayPages = computed(() => {
  const result = new Map<number, OverlayEntry[]>();
  if (presentation.value !== 'layout' || props.mode === 'source') return result;
  const s = scale.value;
  for (const index of residentIndexes.value) {
    const page = pages.value[index];
    if (!page) continue;
    let blocks = overlayBlocks.get(page);
    if (!blocks) overlayBlocks.set(page, blocks = pdfOverlayBlocks(page));
    result.set(page.pageNumber, blocks.map(({block, spaceBelow, spaceRight}) => {
      const source = props.document.segments[block.segmentIndex]?.source ?? '';
      const value = props.translations[block.segmentIndex] ?? '';
      const translated = hasDistinctTranslation(source, value);
      const id = `pdf-${page.pageNumber}-segment-${block.segmentIndex}`;
      const lines = block.lines?.length ? block.lines : [block];
      const last = lines[lines.length - 1];
      const spinnerSize = Math.max(10, Math.min(16, block.fontSize * s));
      const entry: OverlayEntry = {
        id, segmentIndex: block.segmentIndex, source, role: block.kind ?? 'text', translated, pending: !value.trim(), overflow: false, lines: [],
        rect: {x: block.x, y: block.y, width: block.width, height: block.height},
        boxStyle: {left: px(block.x * s), top: px(block.y * s), width: px(block.width * s), height: px(block.height * s)}, textStyle: {}, eraseStyles: [],
        spinnerStyle: {left: px((last.x + last.width) * s + 2), top: px((last.y + last.height / 2) * s - 8), transform: `scale(${Math.round(spinnerSize / 16 * 100) / 100})`},
      };
      if (!translated) return entry;
      const singleLine = block.lineCount <= 1;
      const width = (block.width + (singleLine ? spaceRight : 0)) * s;
      const serif = textFont.value === 'auto' ? /serif|roman|times|song|ming/iu.test(block.fontFamily) && !/sans/iu.test(block.fontFamily) : textFont.value === 'serif';
      const styleKey = `${textScale.value}|${textFont.value}`;
      const cached = fitCache.get(block);
      const measure = measureText(serif ? SERIF_FAMILY : SANS_FAMILY);
      const fit = cached && cached.text === value && cached.scale === s && cached.style === styleKey ? cached.fit : fitPdfBlockText({
        text: value, width: width * 0.985, height: (block.height + spaceBelow) * s, fontSize: block.fontSize * s * textScale.value, lineHeight: (singleLine ? block.fontSize : block.lineHeight) * s * textScale.value,
        minFontSize: Math.max(6, block.fontSize * s * 0.5), weight: block.fontWeight,
      }, measure);
      fitCache.set(block, {text: value, scale: s, style: styleKey, fit});
      const colors = blockColors.value.get(id);
      // 只把接近满行的行拉齐到栏宽；被长引文提前折断的短行保持自然字距，段落末行不拉齐。
      const justify = !singleLine && block.textAlign === 'left' && block.kind !== 'heading';
      entry.lines = fit.lines.map((text, at) => ({text, justified: justify && at < fit.lines.length - 1 && Boolean(fit.lines[at + 1]) && measure(text, fit.fontSize, block.fontWeight) >= width * 0.88}));
      entry.overflow = fit.overflow;
      entry.boxStyle = {...entry.boxStyle, width: px(width), height: px((block.height + spaceBelow) * s), '--pdf-block-background': colors?.background ?? '#fff'};
      entry.textStyle = {fontSize: px(fit.fontSize), lineHeight: px(fit.lineHeight), fontWeight: String(block.fontWeight), textAlign: block.textAlign, color: colors?.foreground ?? '#111827', fontFamily: serif ? SERIF_FAMILY : SANS_FAMILY};
      entry.eraseStyles = lines.map(line => ({left: px((line.x - block.x - 1) * s), top: px((line.y - block.y - 1) * s), width: px((line.width + 2) * s), height: px((line.height + 3) * s)}));
      return entry;
    }));
  }
  return result;
});
/** 译文层使用未旋转的内容坐标；展示方向与 PDF.js 画布一致。 */
function layerStyle(layout: PageLayout): Record<string, string> {
  const rotation = layout.page.rotation ?? 0;
  const quarterTurn = rotation === 90 || rotation === 270;
  const width = quarterTurn ? layout.height : layout.width, height = quarterTurn ? layout.width : layout.height;
  const transform = rotation === 90 ? `translateX(${layout.width}px) rotate(90deg)` : rotation === 180 ? `translate(${layout.width}px, ${layout.height}px) rotate(180deg)`
    : rotation === 270 ? `translateY(${layout.height}px) rotate(270deg)` : '';
  return {width: px(width), height: px(height), ...(transform ? {transform} : {})};
}
function showHighlight(layout: PageLayout, entry: OverlayEntry): void {
  if (!hoverHighlight.value || props.mode !== 'bilingual' || layout.page.rotation) {highlight.value = undefined; return;}
  const s = scale.value;
  highlight.value = {pageNumber: layout.page.pageNumber, style: {left: px(entry.rect.x * s - 3), top: px(entry.rect.y * s - 3), width: px(entry.rect.width * s + 6), height: px(entry.rect.height * s + 6)}};
}
/** 从原页像素取段落的底色与字色，译文在彩色或灰底版面上也不突兀；每个段落只取一次。 */
function sampleBlockColors(): void {
  let next: Map<string, {background: string; foreground: string}> | undefined;
  for (const [pageNumber, entries] of overlayPages.value) {
    const state = states.value.get(pageNumber);
    const page = pages.value.find(entry => entry.pageNumber === pageNumber);
    const canvas = state?.status === 'ready' ? state.output.translatedCanvas : undefined;
    if (!canvas || !page || page.rotation || !canvas.width) continue;
    for (const entry of entries) {
      if (!entry.translated || blockColors.value.has(entry.id) || next?.has(entry.id)) continue;
      let colors = {background: '#fff', foreground: '#111827'};
      try {
        const context = canvas.getContext('2d');
        const ratio = canvas.width / page.width;
        if (context) {
          const line = page.blocks.find(block => block.segmentIndex === entry.segmentIndex)?.lines?.[0] ?? entry.rect;
          const background = sampledBackgroundRgb(context, line.x * ratio, line.y * ratio, line.width * ratio, line.height * ratio);
          colors = {background: `rgb(${background.join(', ')})`, foreground: sampledForegroundColor(context, line.x * ratio, line.y * ratio, line.width * ratio, line.height * ratio, background)};
        }
      } catch { /* 读不到像素时使用白底深色字。 */ }
      (next ??= new Map(blockColors.value)).set(entry.id, colors);
    }
  }
  if (next) blockColors.value = next;
}

const sourceHosts = new Map<number, HTMLElement>();
const translatedHosts = new Map<number, HTMLElement>();
const readingHosts = new Map<number, HTMLElement>();
const regionHosts = new Map<string, HTMLElement>();
let scheduler: PdfReaderScheduler | undefined;
let observer: ResizeObserver | undefined;
let animationFrame: number | undefined;
let mounted = false;
let closed = false;
let nativePins: number[] = [];
let cardPins: number[] = [];
let pointerPin: number | undefined;
let pageInputEditing = false;
interface ReadingAnchor {id: string; pageNumber: number; offset: number}
let pendingReadingAnchor: ReadingAnchor | undefined;
let lastReadingAnchor: ReadingAnchor | undefined;
let readingUpdateGeneration = 0;
let layoutUpdateGeneration = 0;

function captureReadingAnchor(): ReadingAnchor | undefined {
  const scroll = viewport.value;
  if (!readable.value || !scroll || typeof scroll.getBoundingClientRect !== 'function') return;
  const top = scroll.getBoundingClientRect().top, bottom = top + scroll.clientHeight;
  let partial: ReadingAnchor | undefined;
  for (const element of scroll.querySelectorAll<HTMLElement>('.pdf-reading-sheet [data-pdf-source-id]')) {
    if (typeof element.getBoundingClientRect !== 'function') continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= top || rect.top >= bottom) continue;
    const anchor = {id: element.getAttribute('data-pdf-source-id')!, pageNumber: Number(element.closest('[data-pdf-reading-page]')!.getAttribute('data-pdf-reading-page')), offset: rect.top - top};
    if (rect.top >= top) return anchor;
    partial ??= anchor;
  }
  return partial;
}
function restoreReadingAnchor(anchor: ReadingAnchor): boolean {
  const scroll = viewport.value, host = readingHosts.get(anchor.pageNumber);
  if (!scroll || !host || typeof scroll.getBoundingClientRect !== 'function') return false;
  const element = Array.from(host.querySelectorAll<HTMLElement>('[data-pdf-source-id]')).find(entry => entry.getAttribute('data-pdf-source-id') === anchor.id);
  if (!element || typeof element.getBoundingClientRect !== 'function') return false;
  scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
  return true;
}
function measureReadingHeights(targets: Iterable<Element> = readingHosts.values()): boolean {
  const next = new Map(readingHeights.value);
  let changed = false;
  for (const target of targets) {
    const page = Number(target.getAttribute('data-pdf-reading-page'));
    if (!readingHosts.has(page) || typeof target.getBoundingClientRect !== 'function') continue;
    const height = target.getBoundingClientRect().height;
    if (height > 0 && Math.abs((next.get(page) ?? 0) - height) > 1) {next.set(page, height); changed = true;}
  }
  if (changed) {
    if (!pendingReadingAnchor && props.mode !== 'source') pendingReadingAnchor = lastReadingAnchor;
    readingHeights.value = next;
  }
  return changed;
}

function indexesForRange(range?: Range | null): number[] {
  if (!range || !viewport.value?.contains(range.startContainer) || !viewport.value.contains(range.endContainer)) return [];
  const pageNumber = (node: Node) => {const layer = (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-fluentread-pdf-text], [data-pdf-reading-page]'); return Number(layer?.getAttribute('data-pdf-page-number') ?? layer?.getAttribute('data-pdf-reading-page'));};
  const first = pages.value.findIndex(page => page.pageNumber === pageNumber(range.startContainer));
  const last = pages.value.findIndex(page => page.pageNumber === pageNumber(range.endContainer));
  if (first < 0 || last < 0) return [];
  const low = Math.min(first, last); const high = Math.max(first, last);
  return Array.from({length: Math.min(5, high - low + 1)}, (_, index) => low + index);
}

/**
 * PDF 文字层的字块各自绝对定位；指针划过字块之间的空白时，浏览器会把选区终点落到整层末尾而选中整页。
 * 拖选期间在选区活动端旁放一块透明垫片接住指针，选区便只延伸到刚划过的文字；松开指针后垫片退回层尾。
 */
const TEXT_LAYER = '[data-fluentread-pdf-text]';
let selectionPointerDown = false;
let previousSelectionRange: Range | undefined;
function selectionGuard(layer: HTMLElement): HTMLElement {
  let guard = layer.querySelector<HTMLElement>('[data-fluentread-pdf-selection-guard]');
  if (!guard) {
    guard = globalThis.document.createElement('div');
    guard.className = 'fluentread-pdf-selection-guard';
    guard.setAttribute('data-fluentread-pdf-selection-guard', '');
    layer.append(guard);
  }
  return guard;
}
function resetSelectionGuards(): void {
  previousSelectionRange = undefined;
  for (const layer of viewport.value?.querySelectorAll<HTMLElement>(TEXT_LAYER) ?? []) {
    const guard = selectionGuard(layer);
    if (guard.parentElement !== layer || layer.lastElementChild !== guard) layer.append(guard);
    guard.style.width = guard.style.height = '';
    layer.classList.remove('selecting');
  }
}
function guardSelection(selection: Selection | null): void {
  if (!selectionPointerDown) return;
  if (!selection?.rangeCount || selection.isCollapsed) {const pointer = selectionPointerDown; resetSelectionGuards(); selectionPointerDown = pointer; return;}
  const range = selection.getRangeAt(0);
  for (const layer of viewport.value?.querySelectorAll<HTMLElement>(TEXT_LAYER) ?? []) {
    if (range.intersectsNode(layer)) {selectionGuard(layer); layer.classList.add('selecting');} else layer.classList.remove('selecting');
  }
  const previous = previousSelectionRange;
  const modifyStart = Boolean(previous) && (range.compareBoundaryPoints(Range.END_TO_END, previous!) === 0 || range.compareBoundaryPoints(Range.START_TO_END, previous!) === 0);
  let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
  if (anchor.nodeType === 3) anchor = anchor.parentNode;
  const parent = anchor?.parentElement;
  const layer = parent?.closest<HTMLElement>(TEXT_LAYER);
  if (anchor && parent && layer && !(anchor as Element).hasAttribute?.('data-fluentread-pdf-selection-guard')) {
    const guard = selectionGuard(layer);
    guard.style.width = px(layer.offsetWidth); guard.style.height = px(layer.offsetHeight);
    const before = modifyStart ? anchor : anchor.nextSibling;
    if (before !== guard && guard.nextSibling !== before) parent.insertBefore(guard, before);
  }
  previousSelectionRange = range.cloneRange();
}
function handleSelectionChange(): void {
  const selection = window.getSelection();
  guardSelection(selection);
  nativePins = indexesForRange(selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : undefined);
  scheduleViewport();
}
function handleCardRange(event: Event): void {cardPins = indexesForRange((event as CustomEvent<{range?: Range}>).detail?.range); scheduleViewport();}
function handlePointerDown(event: PointerEvent): void {
  const target = event.target as Element;
  if (!viewport.value?.contains(target)) return;
  const layer = target.closest?.('[data-fluentread-pdf-text], [data-pdf-reading-page]');
  const page = Number(layer?.getAttribute('data-pdf-page-number') ?? layer?.getAttribute('data-pdf-reading-page'));
  const index = pages.value.findIndex(entry => entry.pageNumber === page);
  pointerPin = index >= 0 ? index : undefined;
  if (event.button === 0 && layer?.matches(TEXT_LAYER)) {selectionPointerDown = true; previousSelectionRange = undefined; selectionGuard(layer as HTMLElement); layer.classList.add('selecting');}
}
function handlePointerUp(): void {
  pointerPin = undefined;
  if (selectionPointerDown) {selectionPointerDown = false; resetSelectionGuards();}
  handleSelectionChange();
}

function pageIndexAt(offset: number, list = layouts.value): number {
  let low = 0;
  let high = list.length - 1;
  while (low < high) {const middle = Math.floor((low + high + 1) / 2); if (list[middle].top <= offset) low = middle; else high = middle - 1;}
  return low;
}
/** 当前页取阅读线所在的页；滚到底时末页可能比视口矮、够不到阅读线，此时当前页就是末页。 */
function currentIndexAt(offset: number, list = layouts.value): number {
  const height = viewport.value?.clientHeight || 720;
  const last = list.at(-1);
  if (last && offset > 0 && offset + height >= last.top + last.rowHeight + PAGE_GUTTER - 1) return list.length - 1;
  return pageIndexAt(offset + Math.min(80, height / 4), list);
}
function readAnchor(list = layouts.value): {index: number; fraction: number} {
  const offset = viewport.value?.scrollTop ?? 0;
  const index = currentIndexAt(offset, list);
  const layout = list[index];
  return {index, fraction: layout ? Math.max(0, Math.min(1, (offset - layout.top) / layout.rowHeight)) : 0};
}
function mountPage(pageNumber: number): void {
  const state = states.value.get(pageNumber);
  if (state?.status !== 'ready') return;
  const source = sourceHosts.get(pageNumber);
  const translated = translatedHosts.get(pageNumber);
  if (source && state.output.sourceCanvas && source.firstChild !== state.output.sourceCanvas) source.replaceChildren(state.output.sourceCanvas, ...(state.output.sourceText ? [state.output.sourceText] : []));
  if (translated && state.output.translatedCanvas && translated.firstChild !== state.output.translatedCanvas) translated.replaceChildren(state.output.translatedCanvas);
  for (const [id, canvas] of state.output.regions ?? []) {
    const host = regionHosts.get(id);
    if (host && host.firstChild !== canvas) {host.replaceChildren(canvas); canvas.setAttribute('aria-label', t('document.pdfReading.preservedRegion'));}
  }
}
function setReadingHost(pageNumber: number, element: Element | ComponentPublicInstance | null): void {
  const previous = readingHosts.get(pageNumber);
  if (previous && previous !== element) observer?.unobserve(previous);
  if (!element) {readingHosts.delete(pageNumber); return;}
  readingHosts.set(pageNumber, element as HTMLElement);
  observer?.observe(element as HTMLElement);
}
function setRegionHost(pageNumber: number, id: string, element: Element | ComponentPublicInstance | null): void {
  if (!element) {regionHosts.delete(id); return;}
  regionHosts.set(id, element as HTMLElement);
  mountPage(pageNumber);
}
function setPageHost(pageNumber: number, kind: 'source' | 'translated', element: Element | ComponentPublicInstance | null): void {
  const hosts = kind === 'source' ? sourceHosts : translatedHosts;
  if (!element) {hosts.delete(pageNumber); return;}
  hosts.set(pageNumber, element as HTMLElement);
  mountPage(pageNumber);
}
function updateViewport(): void {
  if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
  animationFrame = undefined;
  if (!mounted || closed || pages.value.length === 0) return;
  const scroll = viewport.value;
  const top = scroll?.scrollTop ?? 0;
  const bottom = top + (scroll?.clientHeight || 720);
  const index = currentIndexAt(top);
  const lastIndex = pageIndexAt(bottom);
  const visible = Array.from({length: Math.min(5, Math.max(1, lastIndex - index + 1))}, (_, at) => index + at);
  const nextIndexes = [...new Set([...visible, ...(pointerPin === undefined ? [] : [pointerPin]), ...cardPins, ...nativePins, ...pdfReaderPageWindow(pages.value.length, index, visible)])].slice(0, 5);
  if (nextIndexes.length !== residentIndexes.value.length || nextIndexes.some((entry, at) => entry !== residentIndexes.value[at])) residentIndexes.value = nextIndexes;
  if (currentPage.value !== index + 1) {currentPage.value = index + 1; emit('page-change', currentPage.value);}
  if (!pageInputEditing) pageInput.value = currentPage.value;
  if (outlineOpen.value || props.outlineTarget) {
    // 阅读线之上最近的一个标题就是当前章节。
    const line = top + Math.min(120, (scroll?.clientHeight || 720) / 4);
    let active = '';
    let best = -Infinity;
    // 双栏页的目录按阅读顺序排列，右栏标题的纵坐标可能小于左栏；取阅读线之上最靠下的一个。
    for (const item of outlineItems.value) {const layout = layouts.value[item.pageIndex]; const position = layout ? layout.top + item.y * scale.value : Infinity; if (position <= line && position >= best) {best = position; active = item.id;}}
    activeOutlineId.value = active;
  }
  scheduler?.update(residentIndexes.value, pageIndex => ({
    scale: rasterScale.value, mode: props.mode, presentation: presentation.value,
    key: pdfReaderPageKey(pages.value[pageIndex], rasterScale.value, props.mode, presentation.value),
  }));
  lastReadingAnchor = captureReadingAnchor();
}
function scheduleViewport(): void {
  if (animationFrame !== undefined || closed) return;
  animationFrame = window.requestAnimationFrame(updateViewport);
}
function jumpTo(page: number): void {
  pendingReadingAnchor = lastReadingAnchor = undefined;
  readingUpdateGeneration += 1;
  const number = Math.max(1, Math.min(pages.value.length, Math.round(Number.isFinite(page) ? page : currentPage.value)));
  pageInputEditing = false;
  if (viewport.value) viewport.value.scrollTop = Math.max(0, (layouts.value[number - 1]?.top ?? 0) - PAGE_GUTTER / 2);
  updateViewport();
  pageInput.value = currentPage.value;
}
function jumpToPosition(pageIndex: number, y: number): void {
  const layout = layouts.value[pageIndex];
  if (!layout || !viewport.value) return;
  pendingReadingAnchor = lastReadingAnchor = undefined;
  readingUpdateGeneration += 1;
  pageInputEditing = false;
  // 重排阅读的段落位置与原页坐标无关，只能定位到所在页的开头。
  viewport.value.scrollTop = Math.max(0, layout.top + (readable.value && props.mode === 'translated' ? 0 : Math.min(layout.height, y * scale.value)) - PAGE_GUTTER * 2);
  updateViewport();
  pageInput.value = currentPage.value;
}
function stepZoom(direction: 1 | -1): void {
  const current = scale.value;
  const next = direction > 0 ? ZOOM_STEPS.find(step => step > current + 0.01) : [...ZOOM_STEPS].reverse().find(step => step < current - 0.01);
  if (next) chooseZoom(String(next));
}
function editPageInput(): void {pageInputEditing = true;}
function commitPageInput(): void {jumpTo(Number(pageInput.value));}
function handleViewportKey(event: KeyboardEvent): void {
  if (event.target !== viewport.value || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'PageDown') {event.preventDefault(); jumpTo(currentPage.value + 1);}
  else if (event.key === 'PageUp') {event.preventDefault(); jumpTo(currentPage.value - 1);}
  else if (event.key === 'Home') {event.preventDefault(); jumpTo(1);}
  else if (event.key === 'End') {event.preventDefault(); jumpTo(pages.value.length);}
}
function errorFor(pageNumber: number): string {const state = states.value.get(pageNumber); return state?.status === 'error' ? state.message : '';}
function createScheduler(): void {
  bindZoomGestures();
  clearTimeout(rasterTimer); rasterTimer = undefined; rasterScale.value = scale.value;
  pendingZoomAnchor = undefined; zoomPoint = undefined;
  scheduler?.dispose();
  states.value = new Map();
  sourceHosts.clear();
  translatedHosts.clear();
  readingHosts.clear(); regionHosts.clear(); readingHeights.value = new Map(); blockColors.value = new Map(); highlight.value = undefined;
  nativePins = []; cardPins = []; pointerPin = undefined; pageInputEditing = false; selectionPointerDown = false; previousSelectionRange = undefined;
  pendingReadingAnchor = lastReadingAnchor = undefined; readingUpdateGeneration += 1;
  documentIdentity.value = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  scheduler = new PdfReaderScheduler(pages.value, createPdfReaderRenderPort(props.document), (pageNumber, state) => {
    if (closed) return;
    const next = new Map(states.value);
    if (state) next.set(pageNumber, state); else next.delete(pageNumber);
    states.value = next;
    if (state?.status === 'ready') {mountPage(pageNumber); void nextTick(() => {if (!closed) mountPage(pageNumber);});}
  });
  if (viewport.value) {viewport.value.scrollTop = 0; viewport.value.scrollLeft = 0;}
  currentPage.value = pageInput.value = 1;
  emit('page-change', 1);
  updateViewport();
}
watch(() => props.document, () => {informationController?.setEnabled(false); informationWanted = false; if (mounted) {createScheduler(); syncInformationHighlight();}}, {flush: 'post'});
watch([zoom, presentation, () => props.mode], () => informationController?.refresh(), {flush: 'pre'});
watch([presentation, () => props.mode, outlineOpen], () => {highlight.value = undefined; if (mounted) scheduleViewport();}, {flush: 'post'});
watch([overlayPages, states], sampleBlockColors, {flush: 'post'});
// 在 DOM 更新前记录可见段落；新译文或换行只移动其前后的内容，不能把同页阅读点按比例移走。
watch([readingPlans, zoom, presentation, viewportWidth, () => props.mode], () => {
  if (!mounted || closed) return;
  pendingReadingAnchor = readable.value ? captureReadingAnchor() ?? lastReadingAnchor : undefined;
  const generation = ++readingUpdateGeneration;
  void nextTick(() => {
    if (closed || generation !== readingUpdateGeneration) return;
    if (!measureReadingHeights()) {
      if (pendingReadingAnchor && !pendingZoomAnchor) restoreReadingAnchor(pendingReadingAnchor);
      pendingReadingAnchor = undefined;
      scheduleViewport();
    }
  });
}, {flush: 'pre'});
// 必须在 DOM 改变总高度前读取旧页；否则切到较短的阅读模式时，浏览器已把 scrollTop 限制到新底部。
watch(layouts, async (_next, previous) => {
  if (!mounted || closed) return;
  const generation = ++layoutUpdateGeneration, identity = documentIdentity.value;
  const anchor = readAnchor(previous);
  const zoomAnchor = pendingZoomAnchor;
  const readingAnchor = readable.value ? pendingReadingAnchor ?? lastReadingAnchor : undefined;
  await nextTick();
  if (closed || generation !== layoutUpdateGeneration || identity !== documentIdentity.value) return;
  if (!(zoomAnchor && restoreZoomAnchor(zoomAnchor)) && !(readingAnchor && restoreReadingAnchor(readingAnchor)) && viewport.value) {const layout = layouts.value[anchor.index]; if (layout) viewport.value.scrollTop = layout.top + layout.rowHeight * anchor.fraction;}
  if (pendingZoomAnchor === zoomAnchor) pendingZoomAnchor = undefined;
  if (pendingReadingAnchor === readingAnchor) pendingReadingAnchor = undefined;
  updateViewport();
}, {flush: 'pre'});
onMounted(() => {
  mounted = true;
  syncInformationHighlight();
  viewportWidth.value = viewport.value?.clientWidth || 920;
  viewportHeight.value = viewport.value?.clientHeight || 720;
  createScheduler();
  window.addEventListener('resize', fitToolbarMenus);
  globalThis.document.addEventListener('selectionchange', handleSelectionChange);
  globalThis.document.addEventListener('keydown', handleInformationHotkey, true);
  globalThis.document.addEventListener('pointerdown', handlePointerDown, true);
  globalThis.document.addEventListener('pointerdown', closeMenus, true);
  globalThis.document.addEventListener('keydown', closeMenus, true);
  globalThis.document.addEventListener('pointerup', handlePointerUp, true);
  globalThis.document.addEventListener('pointercancel', handlePointerUp, true);
  globalThis.document.body.addEventListener('fluentread-pdf-selection-range-change', handleCardRange);
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    observer = new ResizeObserver(entries => {
      if (!pendingReadingAnchor && readable.value) pendingReadingAnchor = lastReadingAnchor;
      viewportWidth.value = viewport.value?.clientWidth || 920;
      viewportHeight.value = viewport.value?.clientHeight || 720;
      measureReadingHeights(entries.map(entry => entry.target));
      void nextTick(fitToolbarMenus);
    });
    observer.observe(viewport.value);
    readingHosts.forEach(host => observer!.observe(host));
  }
});
onBeforeUnmount(() => {
  closed = true;
  disposeZoomGestures?.();
  clearTimeout(rasterTimer); rasterTimer = undefined; pendingZoomAnchor = undefined;
  window.removeEventListener('resize', fitToolbarMenus);
  informationController?.dispose(); informationController = undefined;
  readingUpdateGeneration += 1;
  observer?.disconnect();
  globalThis.document.removeEventListener('selectionchange', handleSelectionChange);
  globalThis.document.removeEventListener('keydown', handleInformationHotkey, true);
  globalThis.document.removeEventListener('pointerdown', handlePointerDown, true);
  globalThis.document.removeEventListener('pointerdown', closeMenus, true);
  globalThis.document.removeEventListener('keydown', closeMenus, true);
  globalThis.document.removeEventListener('pointerup', handlePointerUp, true);
  globalThis.document.removeEventListener('pointercancel', handlePointerUp, true);
  globalThis.document.body.removeEventListener('fluentread-pdf-selection-range-change', handleCardRange);
  if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
  scheduler?.dispose();
  sourceHosts.clear();
  translatedHosts.clear();
  readingHosts.clear(); regionHosts.clear();
});
</script>

<style scoped>
.pdf-layout-viewer {width: 100%; height: 100%; min-height: 0; flex: 1; min-width: 0; display: flex; flex-direction: column; color: var(--ink);}
.pdf-viewer-toolbar {display: flex; align-items: center; gap: 14px; min-width: 0; font-size: 12px; color: var(--ink);}
.pdf-viewer-toolbar.inline {padding: 8px 12px; flex-wrap: wrap; background: var(--surface); border-bottom: 1px solid var(--line);}
.pdf-page-navigation, .pdf-page-navigation label, .pdf-zoom-control, .pdf-presentation-control {display: flex; align-items: center; gap: 6px; flex: none;}
.pdf-viewer-toolbar button {width: 28px; height: 28px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: inherit; font-size: 17px; line-height: 1; cursor: pointer;}
.pdf-viewer-toolbar button:hover:not(:disabled) {background: var(--surface-soft);}
.pdf-viewer-toolbar button:disabled {opacity: .3; cursor: default;}
.pdf-page-navigation input {width: 44px; height: 28px; padding: 0 4px; border: 1px solid var(--line); border-radius: 7px; text-align: center; color: inherit; background: transparent; font: inherit; appearance: textfield; -moz-appearance: textfield;}
.pdf-page-navigation input::-webkit-outer-spin-button, .pdf-page-navigation input::-webkit-inner-spin-button {appearance: none; margin: 0;}
.pdf-control-label {position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;}
.pdf-page-total {color: var(--muted); white-space: nowrap;}
.pdf-menu {position: relative; flex: none;}
.pdf-viewer-toolbar .pdf-tool-button {display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: var(--muted);}
.pdf-tool-button svg {width: 17px; height: 17px;}
.pdf-viewer-toolbar .pdf-tool-button.active {color: var(--brand-strong); background: var(--brand-soft);}
.pdf-menu-panel {position: absolute; top: calc(100% + 8px); left: 0; white-space: nowrap; z-index: 30; display: flex; align-items: center; gap: 6px; max-width: calc(100vw - 16px); box-sizing: border-box; padding: 8px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: 0 12px 32px #10182826;}
.pdf-search-panel input {width: min(220px, calc(100vw - 176px)); min-width: 0; height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); color: var(--ink); font: inherit; font-size: 12.5px; outline: none;}
.pdf-search-panel input:focus {border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft);}
.pdf-search-count {min-width: 44px; color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; text-align: center;}
.pdf-style-panel {flex-direction: column; align-items: stretch; gap: 12px; width: max-content; min-width: min(280px, calc(100vw - 16px)); padding: 14px;}
.pdf-style-row {display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 20px; color: var(--muted); font-size: 12px; white-space: nowrap;}
.pdf-style-switch {cursor: pointer;}
.pdf-style-switch input {appearance: none; position: relative; width: 34px; height: 20px; margin: 0; border-radius: 10px; background: var(--line); cursor: pointer; transition: background .15s;}
.pdf-style-switch input::after {content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px #10182833; transition: transform .15s;}
.pdf-style-switch input:checked {background: var(--brand);}
.pdf-style-switch input:checked::after {transform: translateX(14px);}
.pdf-style-stepper {display: flex; align-items: center; gap: 4px; color: var(--ink);}
.pdf-style-stepper output {min-width: 44px; text-align: center; font-variant-numeric: tabular-nums;}
.pdf-style-fonts {display: flex; padding: 2px; border-radius: 8px; background: var(--surface-soft);}
.pdf-viewer-toolbar .pdf-style-fonts button {width: auto; height: 26px; padding: 0 11px; white-space: nowrap; border-radius: 6px; color: var(--muted); font-size: 12px;}
.pdf-viewer-toolbar .pdf-style-fonts button.selected {color: var(--brand-strong); background: var(--surface); box-shadow: 0 1px 4px rgba(35, 47, 82, .1); font-weight: 700;}
.pdf-source-highlight.search {background: color-mix(in srgb, #ffcf33, transparent 72%); outline: 2px solid #f0a800;}
.pdf-viewer-toolbar .pdf-menu-button {display: inline-flex; align-items: center; gap: 6px; width: auto; height: 28px; padding: 0 8px 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: inherit; font: inherit; font-size: 12px; white-space: nowrap;}
.pdf-viewer-toolbar .pdf-menu-button:hover, .pdf-menu.open .pdf-menu-button {border-color: var(--brand); background: var(--surface);}
.pdf-menu.open .pdf-menu-button {box-shadow: 0 0 0 3px var(--brand-soft);}
.pdf-menu-button i {width: 6px; height: 6px; margin: -3px 2px 0; border: solid var(--muted); border-width: 0 1.4px 1.4px 0; transform: rotate(45deg); transition: transform .15s;}
.pdf-menu.open .pdf-menu-button i {margin-top: 3px; transform: rotate(225deg);}
.pdf-menu-list {position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; min-width: 100%; max-width: calc(100vw - 16px); box-sizing: border-box; max-height: min(360px, 50dvh); overflow: auto; margin: 0; padding: 5px; list-style: none; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); box-shadow: 0 12px 32px #10182826;}
.pdf-menu-list li {padding: 7px 12px; border-radius: 7px; color: var(--ink); font-size: 12px; white-space: nowrap; cursor: pointer;}
.pdf-menu-list li:hover {background: var(--surface-soft);}
.pdf-menu-list li.selected {color: var(--brand-strong); background: var(--brand-soft); font-weight: 650;}
.pdf-reader-body {display: flex; flex: 1; min-height: 0; min-width: 0;}
.pdf-outline-toggle svg {display: block; width: 17px; height: 17px; margin: auto;}
.pdf-viewer-toolbar .pdf-outline-toggle.active {color: var(--brand-strong); background: var(--brand-soft);}
.pdf-reader-outline {flex: none; width: min(260px, 40%); overflow-y: auto; padding: 8px 6px; border-right: 1px solid var(--line); background: var(--surface); scrollbar-width: thin;}
.pdf-reader-outline.hosted {width: 100%; padding: 0; border: 0; background: none; overflow: visible;}
.pdf-outline-language {display: flex; margin: 0 4px 8px; padding: 2px; border-radius: 8px; background: var(--surface-soft);}
.pdf-outline-language button {flex: 1; height: 26px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer;}
.pdf-outline-language button.selected {color: var(--brand-strong); background: var(--surface); box-shadow: 0 1px 4px rgba(35, 47, 82, .1); font-weight: 700;}
.pdf-outline-item {display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 10px 6px 12px; border: 0; border-radius: 7px; background: transparent; color: var(--ink); font: inherit; font-size: 12.5px; line-height: 1.45; text-align: left; cursor: pointer;}
.pdf-outline-item span {flex: 1; min-width: 0; overflow-wrap: anywhere;}
.pdf-outline-item small {flex: none; color: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums;}
.pdf-outline-item:hover {background: var(--surface-soft);}
.pdf-outline-item.current {color: var(--brand-strong); background: var(--brand-soft); font-weight: 600;}
.pdf-page-scroll {flex: 1; height: auto; min-width: 0; min-height: 0; overflow: auto; background: var(--reader-canvas, var(--surface-soft)); overscroll-behavior: contain; scrollbar-gutter: stable; overflow-anchor: none; outline: none;}
.pdf-viewer-toolbar .pdf-information-highlight, .pdf-viewer-toolbar .pdf-information-status button {width: auto; height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); font: inherit; font-size: 12px; white-space: nowrap;}
.pdf-viewer-toolbar .pdf-information-highlight[aria-pressed="true"] {border-color: var(--brand); color: var(--brand-strong); background: var(--brand-soft);}
.pdf-information-highlight:focus-visible, .pdf-information-status button:focus-visible {outline: 2px solid var(--brand); outline-offset: 2px;}
.pdf-information-status {color: var(--muted); white-space: nowrap;}
.pdf-page-list {position: relative; min-width: 100%;}
.pdf-page-row {position: absolute; left: 0; width: 100%; padding: 0 12px; box-sizing: border-box;}
.pdf-page-stage {display: flex; gap: 12px; width: max-content; min-width: 100%; justify-content: center; align-items: flex-start;}
.pdf-page-stage.stacked:not(.single) {flex-direction: column; align-items: center;}
.pdf-page-column {margin: 0; width: var(--pdf-page-width); flex: none;}
.pdf-page-frame {position: relative; width: var(--pdf-page-width); height: var(--pdf-page-height); background: #fff; box-shadow: 0 1px 3px #1018281f, 0 0 0 1px #1018280a;}
.pdf-canvas-host {position: absolute; top: 0; left: 0; overflow: hidden; transform-origin: 0 0;}
.pdf-canvas-host :deep(canvas) {display: block; max-width: none;}
.pdf-page-loading {position: absolute; inset: 0; display: flex; justify-content: center; align-items: center; color: #788196; font-size: 12px; pointer-events: none;}
.pdf-page-error {position: absolute; inset: 50px 20px auto; max-width: 520px; margin: auto; padding: 16px; background: #fff7f5; color: #1d2535; border: 1px solid #efc9c1; border-radius: 8px; display: flex; flex-direction: column; gap: 12px; font-size: 12px; z-index: 4;}
.pdf-page-error button {align-self: center; padding: 6px 12px; border-radius: 6px; border: 1px solid #e2e6f0; background: #fff; color: #1d2535; cursor: pointer;}
.pdf-source-highlight {position: absolute; z-index: 2; border-radius: 3px; background: color-mix(in srgb, var(--brand), transparent 88%); outline: 1.5px solid color-mix(in srgb, var(--brand), transparent 45%); pointer-events: none;}
/* 译文层：段落按原文坐标绝对定位，底色遮住原文字形，文字可选择可复制。 */
.pdf-translation-layer {position: absolute; top: 0; left: 0; transform-origin: 0 0; z-index: 1; pointer-events: none;}
.pdf-translation-block {position: absolute; pointer-events: auto; user-select: text; cursor: text;}
.pdf-translation-erase {position: absolute; background: var(--pdf-block-background, #fff);}
.pdf-translation-text {position: relative; margin: 0; max-height: 100%; overflow: hidden; white-space: pre; font-synthesis: weight; font-kerning: normal; text-rendering: geometricPrecision;}
.pdf-translation-text span {display: block;}
.pdf-translation-text span.justified {text-align-last: justify;}
.pdf-translation-block.overflowing .pdf-translation-text::after {content: ""; position: absolute; inset: auto 0 0; height: 1.2em; background: linear-gradient(transparent, var(--pdf-block-background, #fff)); pointer-events: none;}
.pdf-translation-block.overflowing:hover {z-index: 3;}
.pdf-translation-block.overflowing:hover .pdf-translation-text {max-height: none; overflow: visible; background: var(--pdf-block-background, #fff); box-shadow: 0 0 0 4px var(--pdf-block-background, #fff), 0 6px 18px 4px #10182833;}
.pdf-translation-block.overflowing:hover .pdf-translation-text::after {display: none;}
.pdf-translation-block ::selection, .pdf-reading-sheet ::selection {background: color-mix(in srgb, var(--brand), transparent 65%);}
/* 等待中的段落使用设置里选定的翻译加载样式，按原文字号缩放并跟在段落末行之后。 */
.pdf-translation-spinner {position: absolute; display: inline-flex; width: 16px; height: 16px; transform-origin: 0 50%; pointer-events: none;}
.pdf-translation-spinner.inline {position: static; margin-left: .3em; vertical-align: -.15em;}
.pdf-reading-sheet {padding: 32px; box-sizing: border-box; width: 100%; background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px #1018281f; font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; font-size: var(--pdf-reading-font-size); line-height: 1.7; user-select: text; overflow-wrap: anywhere;}
.pdf-reading-paragraph {margin: 0 0 1.2em; white-space: pre-wrap; text-align: start; font-weight: 400;}
.pdf-reading-paragraph:last-child {margin-bottom: 0;}
.pdf-reading-heading {font-size: 1.35em; font-weight: 650; line-height: 1.45; margin-top: 1.25em;}
.pdf-reading-heading:first-child {margin-top: 0;}
.pdf-reading-caption {font-size: .9em; line-height: 1.65;}
.pdf-reading-metadata, .pdf-reading-footer {font-size: .8125em; line-height: 1.55; margin-bottom: .45em;}
.pdf-reading-untranslated {color: var(--muted);}
.pdf-reading-region {margin: 0 0 1.2em; width: 100%;}
.pdf-region-canvas {max-width: 100%; margin-inline: auto; background: #fff;}
.pdf-region-canvas :deep(canvas) {display: block; width: 100%; height: auto;}
/* 锁定 PDF.js 4.10.38 TextLayer 的必需几何规则，限定在阅读器内，避免导入整个 viewer 的全局样式。 */
.pdf-canvas-host :deep(.fluentread-pdf-text-layer) {position: absolute; text-align: initial; inset: 0; overflow: clip; line-height: 1; text-size-adjust: none; forced-color-adjust: none; transform-origin: 0 0; caret-color: transparent; z-index: 1; user-select: text;}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer :is(span, br)) {color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0 0;}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer > :not(.markedContent)), .pdf-canvas-host :deep(.fluentread-pdf-text-layer .markedContent span:not(.markedContent)) {z-index: 1;}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer span.markedContent) {top: 0; height: 0;}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer span[role='img']) {user-select: none; cursor: default;}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer[data-main-rotation='90']) {transform: rotate(90deg) translateY(-100%);}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer[data-main-rotation='180']) {transform: rotate(180deg) translate(-100%, -100%);}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer[data-main-rotation='270']) {transform: rotate(270deg) translateX(-100%);}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer ::selection) {background: color-mix(in srgb, var(--brand), transparent 65%);}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer br::selection) {background: transparent;}
/* 选区垫片平时收在层底之外；拖选时铺满文字层并位于字块之下，接住划过空白的指针。 */
.pdf-canvas-host :deep(.fluentread-pdf-selection-guard) {display: block; position: absolute; inset: 100% 0 0; z-index: 0 !important; cursor: default; user-select: none;}
.pdf-canvas-host :deep(.fluentread-pdf-text-layer.selecting .fluentread-pdf-selection-guard) {top: 0;}
@media (max-width: 600px) {.pdf-viewer-toolbar {gap: 8px;} .pdf-reading-sheet {padding: 24px 20px;} .pdf-page-row {padding: 0 6px;} .pdf-style-row {gap: 8px; flex-wrap: wrap;} .pdf-style-fonts {max-width: 100%; flex-wrap: wrap;} }
</style>

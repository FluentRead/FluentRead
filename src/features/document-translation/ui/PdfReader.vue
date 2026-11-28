<!--
 @file src/features/document-translation/ui/PdfReader.vue
 协作批注：批注面板提供官方 Hypothesis 侧栏开关与连接状态，复用 PDF 租约与虚拟页定位；重排按实际文字隔离指纹，翻译中暂停，可主动关闭，切换文件撤销；不读取账号或上传文件。
 智能配色：固定版式使用 sRGB SVG 滤镜更换纸张与文字颜色，并合回识别到的原图像素，按解析器确认的图形区域保护原色；遮罩不接管鼠标、选区或页资源，切换主题复用原始画布。
 阅读外观：原文、双语与译文均可重排，宽屏双语重排支持上下堆叠或左右分栏对照并保留全宽原图；字体、字号、行距、段距及六种配色按本机偏好显示；阅读外观变化复用页面资源，并在 DOM 更新前保留段落锚点。
 扫描核对：原页按 OCR 返回的有效页面坐标显示待核对内容的虚线框与独立校订角标按钮（点击触发原文校订）；识别行叠加透明原文选择层，沿用划词、复制和页内定位，缩放或其他页更新时保留节点；原图与画布不因补入文字层而重建。
 文件职责：以左右对照的连续页面显示可划词的 PDF 原页和保持原版排版的译文页，每个新译文段落用一次有界局部像素读回匹配版面配色，并保留“重排阅读”作为可选的显示方式。
 主要内容：智能高亮按所选模型重新评分，模型切换传递固定请求身份；页面占满阅读区且不再附带逐页标题；原版排版在原页像素上按段落叠加可选择的译文文字层，取色与版面计算解耦避免双重重算，译文逐段到达时只更新对应段落，等待中的段落使用纯 CSS 轻量加载指示器，译前双语列显示非侵入式等待提示；公式、图表和页眉页脚保持原样，放不下的段落悬停展开并提供键盘可达的全文对照弹窗，拖选与原生选区保留期间保持展开，译文文字层接住段间空白且背景不拦截选择；悬停译文高亮对应原文；拖选原文时把选区终点钉在指针附近，避免划过空白选中整页；重排阅读使用同一实际计划组织正文与原图裁剪，区域身份或坐标变化才重裁剪，普通译文变化复用原像素并保持阅读位置；目录优先读取 PDF 原生书签并匹配译文标题，缺失时回退到版面识别标题与页码，滚动时用二分查找定位当前章节；搜索使用防抖输入与小写原文缓存，同时匹配原文与译文并在原版和重排视图保持高亮直至清空，支持 Cmd/Ctrl+F 搜索与左右方向键翻页；快速跨页滚动使用轻量防抖避免瞬时中间页浪费渲染，页签隐藏零尺寸时不重置视口与页码；加载表面跟随界面主题并在可视区居中提示；只挂载附近五页，卸载时释放全部页面资源、租约与定时器。
 扫描续读：同源 OCR 逐页检查点保留当前页、滚动位置与已就绪画布；只在实际几何变化时调整阅读锚点。
 缩放与排版：原版译文固定在 PDF 页面坐标系中排版，画布、原文文字层、译文和遮罩共享同一个视口变换；缩放结束后才请求可见页补足画布清晰度。
 材料续读：仅公开等待 DOM 提交并淘汰旧布局锚点的 resumePage 页码方法，供已验证文件身份的文档组合根调用；原页渲染与下载结构保持自身职责。
 原位遮罩：表格单元格和图文卡片共用解析阶段确认的边界，避免擦除相邻版块。
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
              <li v-for="option in zoomOptions" :key="option.value" role="presentation" :class="{selected: zoom === option.value}"><button type="button" role="option" :aria-selected="zoom === option.value" :class="{selected: zoom === option.value}" :data-value="option.value" @click="chooseZoom(option.value); closeMenu(true)">{{ option.label }}</button></li>
            </ul>
          </div>
          <button type="button" :aria-label="t('document.pdfReading.zoomIn')" :title="t('document.pdfReading.zoomIn')" :disabled="scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1]" @click="stepZoom(1)">+</button>
        </div>
        <div class="pdf-presentation-control pdf-menu" :class="{open: openMenu === 'presentation'}">
          <button type="button" class="pdf-menu-button" aria-haspopup="listbox" :aria-expanded="openMenu === 'presentation'" :aria-label="t('document.pdfReading.presentationLabel')" @click="openMenu = openMenu === 'presentation' ? null : 'presentation'">{{ t(presentation === 'layout' ? 'document.pdfReading.layoutPresentation' : 'document.pdfReading.readablePresentation') }}<i aria-hidden="true" /></button>
          <ul v-if="openMenu === 'presentation'" class="pdf-menu-list" role="listbox" :aria-label="t('document.pdfReading.presentationLabel')">
            <li v-for="value in PRESENTATIONS" :key="value" role="presentation" :class="{selected: presentation === value}"><button type="button" role="option" :aria-selected="presentation === value" :class="{selected: presentation === value}" :data-value="value" @click="closeMenu(true); choosePresentation(value)">{{ t(value === 'layout' ? 'document.pdfReading.layoutPresentation' : 'document.pdfReading.readablePresentation') }}</button></li>
          </ul>
        </div>
        <div class="pdf-menu pdf-search" :class="{open: openMenu === 'search'}">
          <button type="button" class="pdf-tool-button" :class="{active: openMenu === 'search' || searchHits.length > 0}" aria-haspopup="dialog" :aria-expanded="openMenu === 'search'" :aria-label="t('document.pdfReading.search')" :title="t('document.pdfReading.search')" @click="toggleSearch"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="m13.2 13.2 3.6 3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
          <div v-if="openMenu === 'search'" class="pdf-menu-panel pdf-search-panel" role="dialog" :aria-label="t('document.pdfReading.search')">
            <input ref="searchInput" :value="searchInputValue" dir="auto" type="search" :placeholder="t('document.pdfReading.searchPlaceholder')" :aria-label="t('document.pdfReading.search')" @input="onSearchInput(($event.target as HTMLInputElement).value)" @keydown.enter.prevent="submitSearch($event.shiftKey ? -1 : 1)" />
            <span class="pdf-search-count" role="status">{{ searchHits.length ? `${searchIndex + 1} / ${searchHits.length}` : searchQuery.trim() ? '0' : '' }}</span>
            <button type="button" :disabled="!searchHits.length" :aria-label="t('document.pdfReading.searchPrevious')" :title="t('document.pdfReading.searchPrevious')" @click="stepSearch(-1)">‹</button>
            <button type="button" :disabled="!searchHits.length" :aria-label="t('document.pdfReading.searchNext')" :title="t('document.pdfReading.searchNext')" @click="stepSearch(1)">›</button>
          </div>
        </div>
        <div class="pdf-menu pdf-style" :class="{open: openMenu === 'style'}">
          <button type="button" class="pdf-tool-button" :class="{active: openMenu === 'style'}" aria-haspopup="dialog" :aria-expanded="openMenu === 'style'" :aria-label="t('document.pdfReading.style')" :title="t('document.pdfReading.style')" @click="openMenu = openMenu === 'style' ? null : 'style'"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 15.5 8.2 4.5h1.2l4.2 11M5.6 11.8h6.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 6.5v6M13 9.5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
          <div v-if="openMenu === 'style'" class="pdf-menu-panel pdf-style-panel" role="dialog" :aria-label="t('document.pdfReading.style')">
            <div class="pdf-style-row"><span>{{ t('document.pdfReading.styleSize') }}</span><div class="pdf-style-stepper"><button type="button" :disabled="textScale <= 0.8" :aria-label="t('document.pdfReading.zoomOut')" @click="textScale = Math.max(0.8, Math.round((textScale - 0.05) * 100) / 100)">−</button><output>{{ Math.round(textScale * 100) }}%</output><button type="button" :disabled="textScale >= 1.3" :aria-label="t('document.pdfReading.zoomIn')" @click="textScale = Math.min(1.3, Math.round((textScale + 0.05) * 100) / 100)">+</button></div></div>
            <label v-if="mode !== 'source' && !readable" class="pdf-style-row pdf-style-switch"><span>{{ t('document.pdfReading.styleHighlight') }}</span><input v-model="hoverHighlight" type="checkbox" role="switch" /></label>
            <div class="pdf-style-row"><span>{{ t('document.pdfReading.styleFont') }}</span><div class="pdf-style-fonts" role="group"><button v-for="font in FONT_CHOICES" :key="font" type="button" :class="{selected: textFont === font}" :aria-pressed="textFont === font" @click="textFont = font">{{ t(`document.pdfReading.styleFont.${font}`) }}</button></div></div>
            <template v-if="readable">
              <div v-if="mode === 'bilingual'" class="pdf-style-row"><span>{{ t('document.pdfReading.presentationLabel') }}</span><div class="pdf-style-fonts pdf-reflow-layout-toggle" role="group"><button type="button" :class="{selected: reflowBilingualLayout === 'stacked'}" :aria-pressed="reflowBilingualLayout === 'stacked'" @click="reflowBilingualLayout = 'stacked'">{{ t('document.pdfReading.bilingualStacked') }}</button><button type="button" :class="{selected: reflowBilingualLayout === 'split'}" :aria-pressed="reflowBilingualLayout === 'split'" @click="reflowBilingualLayout = 'split'">{{ t('document.pdfReading.bilingualSplit') }}</button></div></div>
              <label class="pdf-style-row"><span>{{ t('document.pdfReading.lineSpacing') }}</span><input v-model.number="lineSpacing" type="range" min="1.3" max="2.2" step="0.1" /><output>{{ lineSpacing.toFixed(1) }}</output></label>
              <label class="pdf-style-row"><span>{{ t('document.pdfReading.paragraphSpacing') }}</span><input v-model.number="paragraphSpacing" type="range" min="0.4" max="1.8" step="0.1" /><output>{{ paragraphSpacing.toFixed(1) }}</output></label>
            </template>
            <div class="pdf-style-row"><span>{{ t('document.pdfReading.theme') }}</span><div class="pdf-theme-choices" role="group" :aria-label="t('document.pdfReading.theme')"><button v-for="choice in THEME_CHOICES" :key="choice" type="button" :class="{selected: readingTheme === choice}" :aria-pressed="readingTheme === choice" @click="readingTheme = choice">{{ t(`document.pdfReading.theme.${choice}`) }}</button></div></div>
            <div v-if="readingTheme === 'custom'" class="pdf-style-row"><label>{{ t('document.pdfReading.backgroundColor') }} <input v-model="backgroundColor" type="color" /></label><label>{{ t('document.pdfReading.textColor') }} <input v-model="textColor" type="color" /></label></div>
            <p v-if="!readable" class="pdf-style-hint">{{ t('document.pdfReading.reflowStyleHint') }}</p>
          </div>
        </div>
        <PdfAnnotations ref="annotationControls" :document="document" :root="viewport" :annotations="annotations" :translations="translations"
          :storage-unavailable="annotationStorageUnavailable" :open="openMenu === 'annotations'" @toggle="openMenu = openMenu === 'annotations' ? null : 'annotations'"
          @update:annotations="emit('update:annotations', $event)" @jump="jumpToAnnotation">
          <template #collaboration>
            <button class="pdf-hypothesis-toggle" type="button" data-testid="pdf-hypothesis-toggle" :aria-pressed="hypothesisCanCancel ? undefined : hypothesisRequested"
              :aria-busy="hypothesisBusy && !hypothesisRequested" :aria-disabled="translating && !hypothesisRequested || undefined" :disabled="hypothesisBusy && !hypothesisRequested"
              :title="t(hypothesisCanCancel ? 'document.pdfReading.hypothesisCancelConnection' : translating && !hypothesisRequested ? 'document.pdfReading.hypothesisWaiting' : 'document.pdfReading.hypothesisEmbeddedNotice')" @click="toggleHypothesis">
              {{ t(hypothesisCanCancel ? 'document.pdfReading.hypothesisCancelConnection' : 'document.pdfReading.hypothesisToggle') }}
            </button>
          </template>
          <template #collaboration-feedback>
            <div v-if="hypothesisStatus" class="pdf-hypothesis-feedback">
              <p role="status">{{ t(hypothesisStatus) }}</p>
              <details v-if="hypothesisMessage === 'document.pdfReading.hypothesisFailed'">
                <summary>{{ t('document.pdfReading.hypothesisFallback') }}</summary>
                <p>{{ t(hypothesisUrl ? 'document.pdfReading.hypothesisNotice' : 'document.pdfReading.hypothesisLocal') }}</p>
                <a v-if="hypothesisUrl" :href="hypothesisUrl" target="_blank" rel="noopener noreferrer">{{ t('document.pdfReading.hypothesisOpen') }}</a>
                <a v-else href="https://web.hypothes.is/help/annotating-locally-saved-pdfs/" target="_blank" rel="noopener noreferrer">{{ t('document.pdfReading.hypothesisHelp') }}</a>
              </details>
            </div>
          </template>
        </PdfAnnotations>
        <button v-if="informationHighlight" class="pdf-information-highlight" type="button" :aria-pressed="informationState.enabled" :disabled="!informationHighlight.available" :title="informationState.enabled ? `${t(`informationHighlight.phase.${informationState.phase}`)} · ${t('informationHighlight.progress', {paragraphs: informationState.processedParagraphs, spans: informationState.highlightedSpans})}` : t('informationHighlight.title')" @click="informationController?.setEnabled(!informationState.enabled)">{{ t('informationHighlight.title') }}</button>
        <span v-if="informationState.enabled && informationState.phase === 'error'" class="pdf-information-status" role="status">{{ t('informationHighlight.phase.error') }} <button type="button" @click="informationController?.retry()">{{ t('informationHighlight.retry') }}</button></span>
      </div>
    </Teleport>
    <div class="pdf-reader-body">
    <Teleport :to="outlineTarget || 'body'" :disabled="!outlineTarget">
    <nav v-if="outlineOpen || outlineTarget" id="pdf-reader-outline" class="pdf-reader-outline" :class="{hosted: outlineTarget}" :aria-label="t('document.pdfReading.outline')" data-fluentread-pdf-decoration>
      <div v-if="outline.length" class="pdf-outline-language" role="group" :aria-label="t('document.pdfReading.outlineLanguageToggle')">
        <button type="button" :class="{selected: outlineLanguage === 'source'}" :aria-pressed="outlineLanguage === 'source'" @click="outlineLanguage = 'source'">{{ t('document.pdfReading.original') }}</button>
        <button type="button" :class="{selected: outlineLanguage === 'translated'}" :aria-pressed="outlineLanguage === 'translated'" @click="outlineLanguage = 'translated'">{{ t('document.pdfReading.translated') }}</button>
      </div>
      <p v-else class="pdf-outline-empty">{{ t('document.pdfReading.outlineEmpty') }}</p>
      <button v-for="item in outlineItems" :key="item.id" type="button" class="pdf-outline-item" :class="{current: item.id === activeOutlineId}" :style="{paddingLeft: `${12 + (item.level - 1) * 14}px`}" :aria-current="item.id === activeOutlineId ? 'location' : undefined" :title="item.source" data-i18n-ignore @click="jumpToPosition(item.pageIndex, item.y, item.segmentIndex)"><span dir="auto">{{ item.title }}</span><small>{{ item.pageIndex + 1 }}</small></button>
    </nav>
    </Teleport>
    <div ref="viewport" class="pdf-page-scroll" :class="{'pdf-reflow': readable}" :data-pdf-theme="readingTheme" data-pdf-scroll tabindex="0" :data-reader-zoom="scale" :style="{'--pdf-display-scale': scale, ...readingStyle}" :aria-label="t('document.pdfReading.continuousPages')" @scroll.passive="scheduleScrollViewport" @keydown="handleViewportKey">
      <p v-if="!pages.length" class="pdf-empty-state" role="status">{{ t('document.pdfReading.emptyPages') }}</p>
      <div v-else class="pdf-page-list" :style="{ height: `${totalHeight}px`, width: `${totalWidth}px` }">
        <article v-for="layout in residentLayouts" :key="layout.page.pageNumber" class="pdf-page-row" :aria-label="t('document.pdfReading.pageNumber', {page: layout.page.pageNumber})" :data-page-number="layout.page.pageNumber" :data-render-state="states.get(layout.page.pageNumber)?.status ?? 'pending'" :style="{ top: `${layout.top}px`, height: `${layout.rowHeight}px` }">
          <svg v-if="fixedTheme" class="pdf-theme-definitions" width="0" height="0" data-fluentread-pdf-decoration aria-hidden="true"><defs>
            <filter :id="themeId(layout.page.pageNumber)" filterUnits="objectBoundingBox" primitiveUnits="objectBoundingBox" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
              <feComponentTransfer in="SourceGraphic" result="readingColors"><feFuncR type="linear" :slope="themeTransfer[0].slope" :intercept="themeTransfer[0].intercept" /><feFuncG type="linear" :slope="themeTransfer[1].slope" :intercept="themeTransfer[1].intercept" /><feFuncB type="linear" :slope="themeTransfer[2].slope" :intercept="themeTransfer[2].intercept" /></feComponentTransfer>
              <template v-if="themeRegions.get(layout.page.pageNumber)?.length">
                <feFlood v-for="(rect, index) in themeRegions.get(layout.page.pageNumber)" :key="index" :x="rect.x" :y="rect.y" :width="rect.width" :height="rect.height" flood-color="white" :result="`figure-${index}`" />
                <feMerge result="figureMask"><feMergeNode v-for="(_rect, index) in themeRegions.get(layout.page.pageNumber)" :key="index" :in="`figure-${index}`" /></feMerge>
                <feComposite in="SourceGraphic" in2="figureMask" operator="in" result="originalFigures" />
                <feMerge><feMergeNode in="readingColors" /><feMergeNode in="originalFigures" /></feMerge>
              </template>
            </filter>
          </defs></svg>
          <div class="pdf-page-stage" :class="{single: mode !== 'bilingual' || readable, stacked: stackedBilingual}" :style="{'--pdf-page-width': `${layout.width}px`, '--pdf-page-height': `${layout.height}px`, '--pdf-content-width': `${layout.page.width}px`, '--pdf-content-height': `${layout.page.height}px`}">
            <figure v-if="mode !== 'translated' && !readable" class="pdf-page-column" :aria-label="t('document.pdfReading.original')">
              <div class="pdf-page-frame" :data-page-number="layout.page.pageNumber">
                <div class="pdf-page-content" :style="fixedThemeStyle(layout.page.pageNumber)">
                  <div :ref="element => setPageHost(layout.page.pageNumber, 'source', element)" class="pdf-canvas-host" />
                  <i v-if="highlight?.pageNumber === layout.page.pageNumber" class="pdf-source-highlight" :style="highlight.style" data-fluentread-pdf-decoration aria-hidden="true" />
                  <i v-if="searchHighlight?.pageNumber === layout.page.pageNumber" class="pdf-source-highlight search" :style="searchHighlight.style" data-fluentread-pdf-decoration aria-hidden="true" />
                  <i v-for="(region, index) in layout.page.ocrReviewRegions" :key="index" class="pdf-ocr-review" :style="{left: `${region.x}px`, top: `${region.y}px`, width: `${region.width}px`, height: `${region.height}px`}" data-fluentread-pdf-decoration aria-hidden="true" />
                  <button v-for="(region, index) in layout.page.ocrReviewRegions" :key="`ocr-edit-${index}`" type="button" class="pdf-ocr-review-edit" :style="{left: `${region.x + region.width}px`, top: `${region.y}px`}" :aria-label="t('document.sourceEdit.open')" :title="t('document.sourceEdit.open')" data-fluentread-pdf-decoration @pointerdown.stop @click.stop="emitSourceEditForRegion(layout.page, region)">✎</button>
                </div>

                <template v-for="annotation in annotationsByPage.get(layout.page.pageNumber)" :key="annotation.id"><i v-for="(rect, index) in annotation.rects" :key="index" class="pdf-user-annotation" :class="annotation.kind" :data-pdf-annotation="annotation.id" :style="{left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, '--annotation-color': PDF_ANNOTATION_COLORS[annotation.color]}" data-fluentread-pdf-decoration aria-hidden="true" /></template>
                <span v-if="!states.has(layout.page.pageNumber) || states.get(layout.page.pageNumber)?.status === 'loading'" class="pdf-page-loading" data-fluentread-pdf-decoration role="status"><span class="pdf-page-loading-label">{{ t('document.pdfReading.loadingSource') }}</span></span>
              </div>
            </figure>
            <figure v-if="mode !== 'source' || readable" class="pdf-page-column" :class="{translated: mode !== 'source'}" :aria-label="t(mode === 'source' ? 'document.pdfReading.original' : 'document.pdfReading.translated')">
              <article v-if="presentation === 'readable'" :ref="element => setReadingHost(layout.page.pageNumber, element)" class="pdf-reading-sheet" :class="{'pdf-reflow-split': reflowSplitActive}" :data-page-number="layout.page.pageNumber" :data-pdf-reading-page="layout.page.pageNumber" :style="{'--pdf-reading-font-size': `${readingFontSize}px`}">
                <template v-for="entry in readingPlans.get(layout.page.pageNumber)?.entries" :key="entry.id">
                  <figure v-if="entry.kind === 'region'" class="pdf-reading-region" :data-pdf-region-id="entry.id" :data-pdf-region-kind="entry.role" :data-pdf-source-rect="JSON.stringify(entry.sourceRect)">
                    <div :ref="element => setRegionHost(layout.page.pageNumber, entry.id, element)" class="pdf-region-canvas" :style="{width: `${entry.sourceRect.width * (entry.role === 'figure' ? 2 : 1.5) * readingFontSize / 16}px`, aspectRatio: `${entry.sourceRect.width} / ${entry.sourceRect.height}`}" :aria-label="t('document.pdfReading.preservedRegion')" />
                  </figure>
                  <p v-else class="pdf-reading-paragraph" :class="paragraphClasses(entry)" :style="paragraphAnnotationStyle(entry)" :data-pdf-segment-index="entry.segmentIndex" :data-pdf-source-text="entry.source" :data-pdf-source-id="entry.id" :data-pdf-role="entry.role" data-i18n-ignore><span v-if="mode === 'bilingual' && entry.translated" class="pdf-reflow-source" dir="auto">{{ entry.source }}</span><span class="pdf-reflow-target" dir="auto">{{ entry.text }}<span v-if="mode !== 'source' && translating && !entry.translated && isPending(entry.segmentIndex)" class="pdf-translation-spinner inline" :class="{animated}" :data-loading-style="loadingStyle" data-fluentread-pdf-decoration aria-hidden="true"><i class="pdf-spinner-glyph" /></span><button v-if="continuationBySegment.has(entry.segmentIndex)" type="button" class="pdf-cross-page-context" data-fluentread-pdf-decoration :aria-label="t('document.pdfReading.crossPageContext')" :title="t('document.pdfReading.crossPageContext')" @click="openFullPassage(layout.page.pageNumber, entry.segmentIndex)"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="m6 4-3 3 3 3M3 7h9a4 4 0 0 1 0 8H9m2-3-3 3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></button></span></p>
                </template>
              </article>
              <div v-else class="pdf-page-frame" :data-page-number="layout.page.pageNumber">
                <div class="pdf-page-content" :style="fixedThemeStyle(layout.page.pageNumber)">
                  <div :ref="element => setPageHost(layout.page.pageNumber, 'translated', element)" class="pdf-canvas-host" />
                  <div class="pdf-translation-layer" data-fluentread-pdf-translation :data-pdf-reading-page="layout.page.pageNumber" :style="layerStyle(layout.page)" @pointerleave="highlight = undefined">
                    <i v-if="searchHighlight?.pageNumber === layout.page.pageNumber" class="pdf-source-highlight search" :style="searchHighlight.style" data-fluentread-pdf-decoration aria-hidden="true" />
                    <template v-for="entry in overlayPages.get(layout.page.pageNumber)" :key="entry.id">
                      <div v-if="entry.translated" class="pdf-translation-block" :class="{overflowing: entry.overflow, heading: entry.role === 'heading', 'selection-expanded': expandedSelectionBlocks.has(entry.id)}" :style="entryBoxStyle(entry)" :data-pdf-segment-index="entry.segmentIndex" :data-pdf-source-text="entry.source" :data-pdf-source-id="entry.id" :data-pdf-role="entry.role" data-i18n-ignore @pointerenter="showHighlight(layout, entry)">
                        <i v-for="(rect, index) in entry.eraseStyles" :key="index" class="pdf-translation-erase" :style="rect" aria-hidden="true" />
                        <p class="pdf-translation-text" :style="entryTextStyle(entry)" data-fluentread-pdf-lines><span v-for="(line, index) in entry.lines" :key="index" :class="{justified: line.justified}">{{ line.text }}</span></p>
                        <button v-if="entry.overflow || continuationBySegment.has(entry.segmentIndex)" type="button" class="pdf-full-passage-button" data-fluentread-pdf-decoration :aria-label="t(continuationBySegment.has(entry.segmentIndex) ? 'document.pdfReading.crossPageContext' : 'document.pdfReading.fullPassage')" :title="t(continuationBySegment.has(entry.segmentIndex) ? 'document.pdfReading.crossPageContext' : 'document.pdfReading.fullPassage')" @click.stop="openFullPassage(layout.page.pageNumber, entry.segmentIndex)"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><path d="M10 5v11M3 4.5c2.4-.8 4.7-.5 7 1.2 2.3-1.7 4.6-2 7-1.2v10c-2.4-.8-4.7-.5-7 1.2-2.3-1.7-4.6-2-7-1.2z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
                      </div>
                      <span v-else-if="translating && entry.pending" class="pdf-translation-spinner" :class="{animated}" :data-loading-style="loadingStyle" :style="entry.spinnerStyle" :data-pdf-pending-segment="entry.segmentIndex" data-fluentread-pdf-decoration role="status" :aria-label="t('document.pdfReading.translatingBlock')"><i class="pdf-spinner-glyph" /></span>
                    </template>
                  </div>
                </div>

                <span v-if="showPreTranslationHint" class="pdf-pre-translation-hint" data-fluentread-pdf-decoration aria-hidden="true">{{ t('document.pdfReading.waitingTranslation') }}</span>
                <span v-if="!states.has(layout.page.pageNumber) || states.get(layout.page.pageNumber)?.status === 'loading'" class="pdf-page-loading" data-fluentread-pdf-decoration role="status"><span class="pdf-page-loading-label">{{ t('document.pdfReading.loadingTranslation') }}</span></span>
              </div>
            </figure>
          </div>
          <div v-if="errorFor(layout.page.pageNumber) !== undefined" class="pdf-page-error" role="alert"><span>{{ errorFor(layout.page.pageNumber) }}</span><button type="button" @click="scheduler?.retry(layout.index)">{{ t('document.pdfReading.retryPage') }}</button></div>
        </article>
      </div>
    </div>
    </div>
    <dialog ref="fullPassageDialog" class="pdf-full-passage-dialog" aria-labelledby="pdf-full-passage-heading" @close="fullPassage = undefined">
      <header><h2 id="pdf-full-passage-heading">{{ t(fullPassageParts.length > 1 ? 'document.pdfReading.crossPageContext' : 'document.pdfReading.fullPassage') }}<small v-if="fullPassage">{{ fullPassageParts.map(part => t('document.pdfReading.pageNumber', {page: part.page})).join(' → ') }}</small></h2><button type="button" autofocus :aria-label="t('document.pdfReading.closePassage')" @click="fullPassageDialog?.close()">×</button></header>
      <div v-if="fullPassage" class="pdf-full-passage-content">
        <div v-for="part in fullPassageParts" :key="part.segmentIndex" class="pdf-full-passage-pair">
          <section class="pdf-full-passage-source"><h3>{{ t('document.pdfReading.original') }}<small v-if="fullPassageParts.length > 1"> · {{ t('document.pdfReading.pageNumber', {page: part.page}) }}</small></h3><p dir="auto" data-i18n-ignore>{{ document.segments[part.segmentIndex]?.source }}</p></section>
          <section><h3>{{ t('document.pdfReading.translated') }}</h3><p dir="auto" class="pdf-full-passage-translation" data-i18n-ignore>{{ translations[part.segmentIndex] || t('document.pdfReading.waitingTranslation') }}</p></section>
        </div>
      </div>
    </dialog>
  </section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import PdfAnnotations from './PdfAnnotations.vue';
import {pdfHypothesisUrl, PDF_ANNOTATION_COLORS, type PdfAnnotation} from '../core/pdfAnnotations';
import {PDF_READING_THEMES as THEME_CHOICES, pdfReadingThemeColors, pdfReadingThemeTransfer, pdfReadingThemeRegions} from '../core/pdfReadingTheme';
import {DEFAULT_TRANSLATION_LOADING_STYLE, type TranslationLoadingStyle} from '@/src/core/config/translationLoadingStyle';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import {findPdfContinuations} from '@/src/features/document-translation/core/pdfContinuations';
import type {ParsedDocument, PdfDocumentBlock, PdfDocumentPage} from '@/src/features/document-translation/core/document';
import {fitPdfBlockText, pdfOverlayBlocks, type PdfBlockFit, type PdfOverlayBlock} from '@/src/features/document-translation/core/pdfBlockFit';
import {buildPdfReadingPlan, type PdfReadingPlan, type PdfReadingPresentation, type PdfReadingRegionEntry, type PdfReadingTextEntry} from '@/src/features/document-translation/core/pdfReadingPlan';
import {sampledPdfBlockColors, acquirePdfDocument} from '@/src/features/document-translation/ui/pdfPreview';
import {createHypothesisClient, injectHypothesisDocumentScript} from '@/src/features/hypothesis/public';
import {installPdfHypothesisAdapter} from './pdfHypothesis';
import {createPdfReaderRenderPort, pdfReaderDisplayRect, pdfReaderPageKey, pdfReaderPageWindow, PdfReaderScheduler, type PdfReaderMode, type PdfReaderPageState} from '@/src/features/document-translation/ui/pdfReader';
import {updatePdfOcrTextLayer} from './pdfOcrTextLayer';
import {installInformationHighlight, type InformationHighlightController} from '@/src/features/information-highlight/public';
import {DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, type InformationHighlightPreferences} from '@/src/core/config/informationHighlight';
import type {InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
import {matchesConfiguredHotkey} from '@/src/core/hotkey';
import type {InformationHighlightResult, InformationHighlightState} from '@/src/features/information-highlight/protocol';
import {installDocumentZoomGestures, type DocumentZoomPoint} from './documentZoom';
import {captureVisiblePdfMaterialLocation, createPdfMaterialNavigation, resolvePdfMaterialSelection, waitPdfMaterialFrame, type PdfMaterialLocation} from './pdfMaterialNavigation';

const annotationControls = ref<{markSelection(range: Range, kind: 'highlight' | 'underline'): boolean}>();
const props = withDefaults(defineProps<{document: ParsedDocument; translations?: readonly string[]; annotations?: readonly PdfAnnotation[]; annotationStorageUnavailable?: boolean; mode: PdfReaderMode; sourceUrl?: string; presentation?: PdfReadingPresentation; translating?: boolean; controlsTarget?: HTMLElement | null; outlineTarget?: HTMLElement | null; loadingStyle?: TranslationLoadingStyle; animated?: boolean; informationHighlight?: {preferences: InformationHighlightPreferences; scoreLocal(text: string, signal: AbortSignal, modelId?: InformationHighlightModelId): Promise<InformationHighlightResult>; available: boolean}}>(), {translations: () => [], annotations: () => [], annotationStorageUnavailable: false, sourceUrl: '', presentation: 'layout', translating: false, controlsTarget: null, outlineTarget: null, loadingStyle: DEFAULT_TRANSLATION_LOADING_STYLE, animated: true});
const emit = defineEmits<{ 'update:presentation': [value: PdfReadingPresentation]; 'update:annotations': [value: PdfAnnotation[]]; 'page-change': [page: number]; 'material-position-change': []; 'source-edit': [segmentIndex?: number] }>();
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const PRESENTATIONS: PdfReadingPresentation[] = ['layout', 'readable'];
const PAGE_GUTTER = 12;
const RASTER_REFRESH_DELAY_MS = 160;
const SEARCH_DEBOUNCE_MS = 150;
const SCROLL_SETTLE_DELAY_MS = 80;
const SERIF_FAMILY = '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, Georgia, "Times New Roman", serif';
const SANS_FAMILY = '"Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", "Arial Unicode MS", Arial, sans-serif';
const annotationsByPage = computed(() => {
  const map = new Map<number, PdfAnnotation[]>();
  for (const annotation of props.annotations) {const list = map.get(annotation.page) ?? []; list.push(annotation); map.set(annotation.page, list);}
  return map;
});
function paragraphAnnotations(entry: PdfReadingTextEntry): PdfAnnotation[] {
  const list = annotationsByPage.value.get(entry.pageNumber);
  if (!list?.length) return [];
  const page = pageByNumber.value.get(entry.pageNumber);
  if (!page) return [];
  const source = pdfReaderDisplayRect(entry.sourceRect, page);
  return list.filter(annotation => annotation.rects.some(rect =>
    rect.x * page.width < source.x + source.width && (rect.x + rect.width) * page.width > source.x && rect.y * page.height < source.y + source.height && (rect.y + rect.height) * page.height > source.y));
}
function paragraphAnnotationStyle(entry: PdfReadingTextEntry): Record<string, string> {
  const annotations = paragraphAnnotations(entry);
  if (!annotations.length) return {};
  return {'--pdf-annotation-highlight': PDF_ANNOTATION_COLORS[annotations.find(annotation => annotation.kind === 'highlight')?.color ?? 'yellow'],
    '--pdf-annotation-underline': PDF_ANNOTATION_COLORS[annotations.find(annotation => annotation.kind === 'underline')?.color ?? 'green']};
}
function isReadingSearchHit(entry: PdfReadingTextEntry): boolean {
  const hit = activeSearchHit.value;
  if (!hit || hit.pageNumber !== entry.pageNumber) return false;
  return entry.segmentIndex >= 0 ? hit.segmentIndex === entry.segmentIndex : hit.sourceId === entry.id;
}
function paragraphClasses(entry: PdfReadingTextEntry): Record<string, boolean> {
  const annotations = paragraphAnnotations(entry);
  return {'pdf-reading-heading': entry.role === 'heading', 'pdf-reading-caption': entry.role === 'caption', 'pdf-reading-metadata': entry.role === 'metadata', 'pdf-reading-footer': entry.role === 'footer', 'pdf-reading-untranslated': !entry.translated, 'pdf-bilingual-pair': props.mode === 'bilingual' && entry.translated, 'pdf-reading-search-hit': isReadingSearchHit(entry), 'pdf-annotated-highlight': annotations.some(annotation => annotation.kind === 'highlight'), 'pdf-annotated-underline': annotations.some(annotation => annotation.kind === 'underline')};
}
const presentation = ref<PdfReadingPresentation>(props.presentation);
watch(() => props.presentation, value => {presentation.value = value;});
const {t} = useUiI18n();
const viewport = ref<HTMLElement>();
const toolbar = ref<HTMLElement>();
/** 原位放不下的译文可用键盘打开独立全文；原生 dialog 管理焦点、Esc 与返回触发按钮。 */
const fullPassageDialog = ref<HTMLDialogElement>();
const fullPassage = ref<{page: number; segmentIndex: number}>();
const continuationBySegment = computed(() => {
  const map = new Map<number, ReturnType<typeof findPdfContinuations>>();
  for (const pair of findPdfContinuations(props.document)) for (const part of [pair.from, pair.to]) {
    const linked = map.get(part.segmentIndex) ?? []; linked.push(pair); map.set(part.segmentIndex, linked);
  }
  return map;
});
const fullPassageParts = computed(() => {
  const current = fullPassage.value;
  if (!current) return [];
  const parts = new Map([[current.segmentIndex, current]]), queue = [current.segmentIndex];
  for (let index = 0; index < queue.length; index++) for (const pair of continuationBySegment.value.get(queue[index]) ?? []) {
    for (const part of [pair.from, pair.to]) if (!parts.has(part.segmentIndex)) {
      parts.set(part.segmentIndex, {page: part.pageNumber, segmentIndex: part.segmentIndex}); queue.push(part.segmentIndex);
    }
  }
  return [...parts.values()].sort((left, right) => left.page - right.page);
});
async function openFullPassage(page: number, segmentIndex: number): Promise<void> {
  fullPassage.value = {page, segmentIndex};
  await nextTick();
  if (!closed && fullPassage.value) fullPassageDialog.value?.showModal();
}
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
    scoreLocal: (text, signal, modelId) => props.informationHighlight!.scoreLocal(text, signal, modelId), changed: state => {informationState.value = state;},
  });
  informationController.updatePreferences(settings.preferences);
  // 设置中的开关决定文档打开时的初始状态；工具栏按钮只临时切换当前文档。
  const wanted = settings.available && settings.preferences.enabled;
  if (!settings.available) informationController.setEnabled(false);
  else if (wanted !== informationWanted) informationController.setEnabled(wanted);
  informationWanted = wanted;
}
watch(() => [props.informationHighlight?.available, props.informationHighlight?.preferences.enabled, props.informationHighlight?.preferences.mode, props.informationHighlight?.preferences.model, props.informationHighlight?.preferences.density, props.informationHighlight?.preferences.color, props.informationHighlight?.preferences.style, props.informationHighlight?.preferences.intensity], syncInformationHighlight, {flush: 'post'});
const zoom = ref('fit');
/** 工具栏菜单同一时间只展开一个；点击别处或按 Esc 收起。 */
const openMenu = ref<'zoom' | 'presentation' | 'search' | 'style' | 'annotations' | null>(null);
/** 工具栏可在小窗口分组换行；浮层按实际按钮位置展开，再把横向边界收进窗口。 */
function fitToolbarMenus(): void {
  if (closed || !openMenu.value) return;
  const view = toolbar.value?.ownerDocument.defaultView;
  const width = view?.innerWidth, height = view?.innerHeight;
  if (!width || !height) return;
  for (const menu of toolbar.value?.querySelectorAll<HTMLElement>('.pdf-menu-list,.pdf-menu-panel') ?? []) {
    if (typeof menu.getBoundingClientRect !== 'function') continue;
    const rightAnchored = Boolean(menu.closest('.pdf-annotations'));
    menu.style.marginLeft = '0px';
    if (rightAnchored) menu.style.marginRight = '0px';
    menu.style.top = ''; menu.style.bottom = ''; menu.style.maxHeight = '';
    let box = menu.getBoundingClientRect();
    const above = Math.max(0, (menu.parentElement?.getBoundingClientRect().top ?? box.top) - 8);
    const below = Math.max(0, height - 8 - box.top);
    if (below < Math.min(200, box.height) && above > below) {
      menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 8px)'; menu.style.maxHeight = `${above}px`;
    } else menu.style.maxHeight = `${below}px`;
    menu.style.overflowY = 'auto';
    box = menu.getBoundingClientRect();
    const offset = Math.max(8 - box.left, Math.min(0, width - 8 - box.right));
    if (rightAnchored) menu.style.marginRight = `${-offset}px`;
    else menu.style.marginLeft = `${offset}px`;
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
const initialTextStyle = storedStyle();
const hoverHighlight = ref(initialTextStyle.highlight);
const textScale = ref(initialTextStyle.scale);
const textFont = ref<typeof FONT_CHOICES[number]>(initialTextStyle.font);
watch([textScale, textFont, hoverHighlight], ([scaleValue, font, highlightValue]) => {if (!highlightValue) highlight.value = undefined; try {globalThis.localStorage?.setItem(STYLE_KEY, JSON.stringify({scale: scaleValue, font, highlight: highlightValue}));} catch { /* 无法写入时只在本次阅读生效。 */ }});
/** 阅读外观与译文拟合参数分开保存；颜色仅接受十六进制，范围值在存储边界归一。 */
const READING_STYLE_KEY = 'fluentread.pdfReader.readingStyle';
function storedReadingStyle() {
  let value: Record<string, unknown> = {};
  try {value = JSON.parse(globalThis.localStorage?.getItem(READING_STYLE_KEY) || '{}') ?? {};} catch { /* 损坏设置使用默认阅读外观。 */ }
  const bounded = (input: unknown, fallback: number, min: number, max: number) => typeof input === 'number' && Number.isFinite(input) ? Math.min(max, Math.max(min, input)) : fallback;
  const color = (input: unknown, fallback: string) => typeof input === 'string' && /^#[\da-f]{6}$/iu.test(input) ? input : fallback;
  return {theme: THEME_CHOICES.includes(value.theme as typeof THEME_CHOICES[number]) ? value.theme as typeof THEME_CHOICES[number] : 'auto' as const,
    lineSpacing: bounded(value.lineSpacing, 1.7, 1.3, 2.2), paragraphSpacing: bounded(value.paragraphSpacing, 1.2, 0.4, 1.8),
    background: color(value.background, '#fff7e6'), text: color(value.text, '#302b24'),
    bilingualLayout: value.bilingualLayout === 'split' ? 'split' as const : 'stacked' as const};
}
const initialReadingStyle = storedReadingStyle();
const readingTheme = ref(initialReadingStyle.theme), lineSpacing = ref(initialReadingStyle.lineSpacing), paragraphSpacing = ref(initialReadingStyle.paragraphSpacing);
const backgroundColor = ref(initialReadingStyle.background), textColor = ref(initialReadingStyle.text);
const reflowBilingualLayout = ref<'stacked' | 'split'>(initialReadingStyle.bilingualLayout);
const themeColors = computed(() => pdfReadingThemeColors(readingTheme.value, backgroundColor.value, textColor.value));
const themeTransfer = computed(() => pdfReadingThemeTransfer(themeColors.value ?? {background: '#ffffff', text: '#111827'}));
const readingStyle = computed(() => {
  return {'--pdf-reading-background': themeColors.value?.background ?? 'var(--surface)', '--pdf-reading-color': themeColors.value?.text ?? 'var(--ink)', '--pdf-reading-line-height': lineSpacing.value,
    '--pdf-reading-paragraph-gap': `${paragraphSpacing.value}em`, '--pdf-reading-family': textFont.value === 'serif' ? SERIF_FAMILY : SANS_FAMILY};
});
watch([readingTheme, lineSpacing, paragraphSpacing, backgroundColor, textColor, reflowBilingualLayout], () => {
  try {globalThis.localStorage?.setItem(READING_STYLE_KEY, JSON.stringify({theme: readingTheme.value, lineSpacing: lineSpacing.value, paragraphSpacing: paragraphSpacing.value, background: backgroundColor.value, text: textColor.value, bilingualLayout: reflowBilingualLayout.value}));} catch { /* 存储不可用时本次阅读继续生效。 */ }
});
/** 搜索同时匹配原文与译文，按阅读顺序列出命中的段落；输入 150ms 防抖并缓存小写原文，回车立即跳转，关闭面板后保留高亮直至清空。 */
const searchInput = ref<HTMLInputElement>();
const searchQuery = ref('');
const searchInputValue = ref('');
const searchIndex = ref(0);
let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
const blockSourceLowerCache = new WeakMap<PdfDocumentBlock, {source: string; lower: string}>();
function cachedBlockSourceLower(block: PdfDocumentBlock, rawSource: string): string {
  const cached = blockSourceLowerCache.get(block);
  if (cached && cached.source === rawSource) return cached.lower;
  const lower = rawSource.toLocaleLowerCase();
  blockSourceLowerCache.set(block, {source: rawSource, lower});
  return lower;
}
function onSearchInput(value: string): void {
  searchInputValue.value = value;
  clearTimeout(searchDebounceTimer);
  if (!value.trim()) {
    searchDebounceTimer = undefined;
    searchQuery.value = value;
    return;
  }
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = undefined;
    searchQuery.value = searchInputValue.value;
  }, SEARCH_DEBOUNCE_MS);
}
function flushSearchDebounce(): boolean {
  if (searchDebounceTimer === undefined) return false;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = undefined;
  if (searchQuery.value !== searchInputValue.value) {
    searchQuery.value = searchInputValue.value;
    return true;
  }
  return false;
}
function submitSearch(direction: 1 | -1): void {
  if (flushSearchDebounce()) return;
  stepSearch(direction);
}
watch(searchQuery, value => {if (searchInputValue.value !== value) searchInputValue.value = value;});
const searchHits = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  if (!query) return [];
  return pages.value.flatMap((page, pageIndex) => page.blocks.flatMap((block, blockIndex) => {
    const source = props.document.segments[block.segmentIndex]?.source ?? block.source ?? (block.lines ?? []).map(line => line.text).join(' ');
    const translation = props.translations[block.segmentIndex] ?? '';
    const sourceId = `pdf-${page.pageNumber}-${block.segmentIndex >= 0 ? `segment-${block.segmentIndex}` : `block-${blockIndex}`}`;
    return cachedBlockSourceLower(block, source).includes(query) || translation.toLocaleLowerCase().includes(query)
      ? [{pageIndex, pageNumber: page.pageNumber, rotation: page.rotation, segmentIndex: block.segmentIndex, sourceId, x: block.x, y: block.y, width: block.width, height: block.height}]
      : [];
  }));
});
const activeSearchHit = computed(() => searchHits.value[searchIndex.value]);
const searchHighlight = computed(() => {
  const hit = activeSearchHit.value;
  if (!hit || hit.rotation) return undefined;
  return {pageNumber: hit.pageNumber, style: highlightStyle(hit)};
});
function showSearchHit(): void {const hit = activeSearchHit.value; if (hit) jumpToPosition(hit.pageIndex, hit.y, hit.segmentIndex);}
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
watch([searchQuery, searchHits, () => props.document], ([query, hits, document], [previousQuery, previousHits, previousDocument]) => {
  const previous = previousHits[searchIndex.value];
  const preserved = query === previousQuery && document === previousDocument && previous
    ? hits.findIndex(hit => hit.pageNumber === previous.pageNumber && hit.x === previous.x && hit.y === previous.y) : -1;
  searchIndex.value = Math.max(0, preserved);
  // 翻译分批完成可能在当前命中前新增结果；保留当前段落，只有原命中消失才跳回首个结果。
  if (preserved < 0) showSearchHit();
});
const zoomOptions = computed(() => [{value: 'fit', label: t('document.pdfReading.fitWidth')}, {value: 'page', label: t('document.pdfReading.fitPage')}, ...ZOOM_STEPS.map(step => ({value: String(step), label: `${Math.round(step * 100)}%`}))]);
const zoomLabel = computed(() => zoomOptions.value.find(option => option.value === zoom.value)?.label ?? `${Math.round(Number(zoom.value) * 100)}%`);
function closeMenu(restoreFocus = false): void {
  if (restoreFocus) toolbar.value?.querySelector<HTMLButtonElement>('.pdf-menu.open > .pdf-menu-button')?.focus();
  openMenu.value = null;
}
function choosePresentation(value: PdfReadingPresentation): void {if (presentation.value === value) return; presentation.value = value; emit('update:presentation', value);}
function closeMenus(event: Event): void {
  if (!openMenu.value) return;
  if (event.type === 'keydown') {if ((event as KeyboardEvent).key === 'Escape') closeMenu(true);}
  else if (!(event.target as Element | null)?.closest?.('.pdf-menu')) closeMenu();
}
const pageInput = ref(1);
const currentPage = ref(1);
const viewportWidth = ref(920);
const viewportHeight = ref(720);
const states = shallowRef(new Map<number, PdfReaderPageState>());
const residentIndexes = ref<number[]>([]);
const documentIdentity = ref(`${Date.now()}-${Math.random().toString(36).slice(2)}`);
const pages = computed(() => props.document.binary?.kind === 'pdf' ? props.document.binary.pages : []);
const pageByNumber = computed(() => new Map(pages.value.map(page => [page.pageNumber, page])));
const pageIndexByNumber = computed(() => new Map(pages.value.map((page, index) => [page.pageNumber, index])));
const blockByPageSegment = computed(() => {
  const map = new Map<number, Map<number, PdfDocumentBlock>>();
  for (const page of pages.value) {
    const blocks = new Map<number, PdfDocumentBlock>();
    for (const block of page.blocks) {
      if (block.segmentIndex >= 0 && !blocks.has(block.segmentIndex)) blocks.set(block.segmentIndex, block);
    }
    map.set(page.pageNumber, blocks);
  }
  return map;
});
const numericZoom = computed(() => zoom.value === 'fit' || zoom.value === 'page' ? 1 : Number(zoom.value));
const readingFontSize = computed(() => 16 * numericZoom.value * textScale.value);
const readingHeights = shallowRef(new Map<number, number>());
const readable = computed(() => presentation.value === 'readable');
const reflowSplitActive = computed(() => readable.value && props.mode === 'bilingual' && reflowBilingualLayout.value === 'split' && viewportWidth.value >= 1100);
const hasAnyTranslation = computed(() => {
  const length = Math.min(props.document.segments.length, props.translations.length);
  for (let index = 0; index < length; index += 1) {
    if (hasDistinctTranslation(props.document.segments[index]?.source ?? '', props.translations[index])) return true;
  }
  return false;
});
const showPreTranslationHint = computed(() => props.mode === 'bilingual' && !readable.value && !hasAnyTranslation.value && !props.translating);
const readingPlans = computed(() => new Map<number, PdfReadingPlan>(readable.value ? residentIndexes.value.flatMap(index => {
  const page = pages.value[index];
  return page ? [[page.pageNumber, buildPdfReadingPlan(props.document, page, props.mode === 'source' ? [] : props.translations)] as [number, PdfReadingPlan]] : [];
}) : []));
const stackedBilingual = computed(() => !readable.value && props.mode === 'bilingual' && viewportWidth.value < 900);
const scale = computed(() => {
  if (zoom.value !== 'fit' && zoom.value !== 'page') return Number(zoom.value);
  const maxPageWidth = pages.value.reduce((width, page) => Math.max(width, page.width), 1);
  const columns = !readable.value && props.mode === 'bilingual' && !stackedBilingual.value ? 2 : 1;
  const widthScale = (viewportWidth.value - PAGE_GUTTER * 2 - (columns - 1) * PAGE_GUTTER) / columns / maxPageWidth;
  const maxPageHeight = pages.value.reduce((height, page) => Math.max(height, page.height), 1);
  const fitted = zoom.value === 'page' ? Math.min(widthScale, (viewportHeight.value - PAGE_GUTTER * 2) / maxPageHeight) : widthScale;
  return Math.max(1 / maxPageWidth, Math.min(3, fitted));
});
interface PageLayout {page: PdfDocumentPage; index: number; top: number; rowHeight: number; width: number; height: number}
const layouts = computed<PageLayout[]>(() => {
  let top = PAGE_GUTTER;
  const maxReadableWidth = reflowSplitActive.value ? 1240 : 900;
  return pages.value.map((page, index) => {
    const width = readable.value ? Math.max(1, Math.min(maxReadableWidth, viewportWidth.value - PAGE_GUTTER * 2)) : Math.max(1, page.width * scale.value);
    const height = Math.max(1, page.height * scale.value);
    const translatedHeight = readable.value ? readingHeights.value.get(page.pageNumber) ?? height : height;
    const rowHeight = readable.value ? translatedHeight : props.mode === 'source' ? height : props.mode === 'translated' ? translatedHeight
      : stackedBilingual.value ? height + PAGE_GUTTER + translatedHeight : Math.max(height, translatedHeight);
    const layout = {page, index, top, rowHeight, width, height};
    top += rowHeight + PAGE_GUTTER;
    return layout;
  });
});
const totalHeight = computed(() => {const last = layouts.value.at(-1); return last ? last.top + last.rowHeight + PAGE_GUTTER : 0;});
const totalWidth = computed(() => {
  const columns = !readable.value && props.mode === 'bilingual' && !stackedBilingual.value ? 2 : 1;
  return layouts.value.reduce((width, layout) => Math.max(width, layout.width * columns + PAGE_GUTTER * (columns + 1)), 0);
});
const residentLayouts = computed(() => residentIndexes.value.map(index => layouts.value[index]).filter(Boolean).sort((left, right) => left.index - right.index));
/** 遮罩只存在于附近五页；SVG 颜色映射与原图合成复用原画布，不重绘或覆盖原生文字层。 */
const fixedTheme = computed(() => !readable.value && readingTheme.value !== 'auto');
const themeRegions = computed(() => new Map(residentLayouts.value.map(({page}) => [page.pageNumber, pdfReadingThemeRegions(page).map(region => {
  const rect = pdfReaderDisplayRect(region, page);
  return {x: rect.x / page.width, y: rect.y / page.height, width: rect.width / page.width, height: rect.height / page.height};
})])));
function themeId(page: number): string {return `fluentread-pdf-colors-${documentIdentity.value}-${page}`;}
function fixedThemeStyle(page: number): Record<string, string> {
  return fixedTheme.value ? {filter: `url(#${themeId(page)})`} : {};
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
  zoom.value = String(value);
}
function bindZoomGestures(): void {
  disposeZoomGestures?.();
  if (viewport.value) disposeZoomGestures = installDocumentZoomGestures(viewport.value, {getScale: () => scale.value, setScale: setGestureZoom, minScale: 0.1, maxScale: 3, reset: resetZoom});
}
function chooseZoom(value: string): void {
  bindZoomGestures();
  zoomPoint = undefined;
  zoom.value = value;
}
function resetZoom(): void {chooseZoom('fit');}
watch(zoom, () => {pendingZoomAnchor = captureZoomAnchor(zoomPoint); zoomPoint = undefined;}, {flush: 'pre'});
watch(scale, value => {
  // 手势、工具栏和适合宽度共用一次延迟；页面几何立即提交，底图在连续操作中复用。
  clearTimeout(rasterTimer);
  rasterTimer = setTimeout(() => {
    rasterTimer = undefined;
    if (!closed) {rasterScale.value = value; updateViewport();}
  }, RASTER_REFRESH_DELAY_MS);
}, {flush: 'sync'});

type OverlayLine = {text: string; justified: boolean};
interface OverlayEntry {
  id: string; segmentIndex: number; source: string; role: string; translated: boolean; pending: boolean; overflow: boolean;
  lines: OverlayLine[]; boxStyle: Record<string, string>; textStyle: Record<string, string>; eraseStyles: Array<Record<string, string>>; spinnerStyle: Record<string, string>;
  rect: {x: number; y: number; width: number; height: number};
}
const overlayBlocks = new WeakMap<PdfDocumentPage, PdfOverlayBlock[]>();
const fitCache = new WeakMap<PdfOverlayBlock, {text: string; style: string; fit: PdfBlockFit; lines: OverlayLine[]}>();
const blockColors = shallowRef(new Map<string, {background: string; foreground: string}>());
const highlight = ref<{pageNumber: number; style: Record<string, string>}>();
/** 目录优先采用 PDF 原生书签（匹配已有译文标题），无书签时回退到版面分析识别出的标题。 */
interface OutlineItem {id: string; pageIndex: number; y: number; level: number; source: string; segmentIndex: number}
interface NativeOutlineEntry {id: string; pageIndex: number; y: number; level: number; source: string}
interface PdfJsOutlineNode {title?: string; dest?: string | unknown[] | null; items?: PdfJsOutlineNode[]}
const outlineOpen = ref(false);
/** 目录标题的语言由读者选择；选了译文而某个标题尚未译出时先显示原文。 */
const outlineLanguage = ref<'source' | 'translated'>('translated');
const activeOutlineId = ref('');
const nativeOutline = shallowRef<NativeOutlineEntry[]>([]);
let outlineLease: ReturnType<typeof acquirePdfDocument> | undefined;
let outlineGeneration = 0;

function normalizeOutlineTitle(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}
function releaseOutlineLease(): void {
  outlineLease?.release();
  outlineLease = undefined;
}
async function loadNativeOutline(): Promise<void> {
  releaseOutlineLease();
  nativeOutline.value = [];
  const binary = props.document.binary;
  if (binary?.kind !== 'pdf' || !pages.value.length) return;
  const generation = ++outlineGeneration;
  const lease = acquirePdfDocument(binary.bytes);
  outlineLease = lease;
  try {
    const pdf = await lease.promise as {
      getOutline?: () => Promise<PdfJsOutlineNode[] | null>;
      getDestination?: (dest: string) => Promise<unknown[] | null>;
      getPageIndex?: (ref: unknown) => Promise<number>;
    };
    if (closed || generation !== outlineGeneration || typeof pdf?.getOutline !== 'function') return;
    const raw = await pdf.getOutline();
    if (closed || generation !== outlineGeneration || !raw?.length) return;
    const entries: NativeOutlineEntry[] = [];
    const MAX_OUTLINE_ITEMS = 500;
    const walk = async (nodes: readonly PdfJsOutlineNode[], depth: number): Promise<void> => {
      for (const node of nodes) {
        if (closed || generation !== outlineGeneration || entries.length >= MAX_OUTLINE_ITEMS) return;
        const source = typeof node.title === 'string' ? node.title.trim() : '';
        if (source) {
          let pageIndex = -1;
          let y = 0;
          try {
            const dest = typeof node.dest === 'string'
              ? (typeof pdf.getDestination === 'function' ? await pdf.getDestination(node.dest) : null)
              : Array.isArray(node.dest) ? node.dest : null;
            if (Array.isArray(dest) && dest[0] !== undefined && dest[0] !== null) {
              if (typeof dest[0] === 'number') pageIndex = dest[0];
              else if (typeof pdf.getPageIndex === 'function') pageIndex = await pdf.getPageIndex(dest[0]);
              const targetPage = Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pages.value.length ? pages.value[pageIndex] : undefined;
              if (targetPage && typeof dest[1] === 'object' && dest[1] !== null && (dest[1] as {name?: string}).name === 'XYZ' && typeof dest[3] === 'number' && Number.isFinite(dest[3])) {
                y = Math.max(0, Math.min(targetPage.height, targetPage.height - dest[3]));
              }
            }
          } catch { /* 跳过无效书签目标，继续解析其余目录。 */ }
          if (Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < pages.value.length) {
            entries.push({id: `pdf-outline-${entries.length}`, pageIndex, y, level: Math.min(3, depth), source});
          }
        }
        if (node.items?.length && depth < 6) await walk(node.items, depth + 1);
      }
    };
    await walk(raw, 1);
    if (!closed && generation === outlineGeneration && entries.length) nativeOutline.value = entries;
  } catch { /* 无法读取 PDF 原生书签时回退到版面标题。 */ }
  finally {
    if (outlineLease === lease) outlineLease = undefined;
    lease.release();
  }
}
const heuristicOutline = computed<OutlineItem[]>(() => pages.value.flatMap((page, pageIndex) => page.blocks.flatMap(block => {
  const source = props.document.segments[block.segmentIndex]?.source?.trim() ?? '';
  if (block.kind !== 'heading' || !source || source.length > 140) return [];
  const numbering = /^(\d+(?:\.\d+)*)\.?\s/u.exec(source)?.[1];
  return [{id: `pdf-${page.pageNumber}-segment-${block.segmentIndex}`, pageIndex, y: block.y, level: Math.min(3, numbering ? numbering.split('.').length : 1), source, segmentIndex: block.segmentIndex}];
})));
const outline = computed<OutlineItem[]>(() => {
  if (!nativeOutline.value.length) return heuristicOutline.value;
  return nativeOutline.value.map(entry => {
    const page = pages.value[entry.pageIndex];
    const normalized = normalizeOutlineTitle(entry.source);
    let matched: PdfDocumentBlock | undefined;
    if (page && normalized) {
      for (const block of page.blocks) {
        if (block.segmentIndex < 0) continue;
        const text = props.document.segments[block.segmentIndex]?.source;
        if (!text || normalizeOutlineTitle(text) !== normalized) continue;
        if (block.kind === 'heading') {matched = block; break;}
        matched ??= block;
      }
    }
    return {...entry, y: entry.y || matched?.y || 0, segmentIndex: matched?.segmentIndex ?? -1};
  });
});
const outlineItems = computed(() => (outline.value.length ? outline.value : pages.value.map((page, pageIndex) => ({id: `pdf-page-${page.pageNumber}`, pageIndex, y: 0, level: 1, source: t('document.pdfReading.pageNumber', {page: page.pageNumber}), segmentIndex: -1}))).map(item => {
  const value = props.translations[item.segmentIndex];
  return {...item, title: outlineLanguage.value === 'translated' && hasDistinctTranslation(item.source, value) ? value! : item.source};
}));
const outlineByPosition = computed(() => outlineItems.value.map((item, order) => {
  const layout = layouts.value[item.pageIndex];
  return {id: item.id, order, position: layout ? layout.top + item.y * scale.value : Infinity};
}).sort((left, right) => left.position - right.position || left.order - right.order));
function findActiveOutlineId(line: number): string {
  const list = outlineByPosition.value;
  if (!list.length || list[0].position > line) return '';
  let low = 0, high = list.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (list[middle].position <= line) low = middle;
    else high = middle - 1;
  }
  return list[low].id;
}
function emitSourceEditForRegion(page: PdfDocumentPage, region: {x: number; y: number; width: number; height: number}): void {
  let matched = page.blocks.find(block => block.segmentIndex >= 0
    && region.x < block.x + block.width && region.x + region.width > block.x
    && region.y < block.y + block.height && region.y + region.height > block.y);
  if (!matched) {
    const cx = region.x + region.width / 2, cy = region.y + region.height / 2;
    let bestDistance = Infinity;
    for (const block of page.blocks) {
      if (block.segmentIndex < 0) continue;
      const dx = Math.max(block.x - cx, 0, cx - (block.x + block.width));
      const dy = Math.max(block.y - cy, 0, cy - (block.y + block.height));
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {bestDistance = distance; matched = block;}
    }
  }
  emit('source-edit', matched?.segmentIndex);
}
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
function entryBoxStyle(entry: OverlayEntry): Record<string, string> {
  const background = blockColors.value.get(entry.id)?.background;
  return background ? {...entry.boxStyle, '--pdf-block-background': background} : entry.boxStyle;
}
function entryTextStyle(entry: OverlayEntry): Record<string, string> {
  const foreground = blockColors.value.get(entry.id)?.foreground;
  return foreground ? {...entry.textStyle, color: foreground} : entry.textStyle;
}
const overlayPages = computed(() => {
  const result = new Map<number, OverlayEntry[]>();
  if (presentation.value !== 'layout' || props.mode === 'source') return result;
  const styleKey = `${textScale.value}|${textFont.value}`;
  for (const index of residentIndexes.value) {
    const page = pages.value[index];
    if (!page) continue;
    let blocks = overlayBlocks.get(page);
    if (!blocks) overlayBlocks.set(page, blocks = pdfOverlayBlocks(page));
    result.set(page.pageNumber, blocks.map(geometry => {
      const {block, spaceBelow, spaceRight} = geometry;
      const source = props.document.segments[block.segmentIndex]?.source ?? '';
      const value = props.translations[block.segmentIndex] ?? '';
      const translated = hasDistinctTranslation(source, value);
      const id = `pdf-${page.pageNumber}-segment-${block.segmentIndex}`;
      const lines = block.lines?.length ? block.lines : [block];
      const last = lines[lines.length - 1];
      const spinnerSize = Math.max(10, Math.min(16, block.fontSize));
      const entry: OverlayEntry = {
        id, segmentIndex: block.segmentIndex, source, role: block.kind ?? 'text', translated, pending: !value.trim(), overflow: false, lines: [],
        rect: {x: block.x, y: block.y, width: block.width, height: block.height},
        boxStyle: {left: px(block.x), top: px(block.y), width: px(block.width), height: px(block.height)}, textStyle: {}, eraseStyles: [],
        spinnerStyle: {left: px(last.x + last.width + 2), top: px(last.y + last.height / 2 - 8), transform: `scale(${Math.round(spinnerSize / 16 * 100) / 100})`},
      };
      if (!translated) return entry;
      const singleLine = block.lineCount <= 1;
      const width = block.width + (singleLine ? spaceRight : 0);
      const height = block.height + spaceBelow;
      const serif = textFont.value === 'auto' ? /serif|roman|times|song|ming/iu.test(block.fontFamily) && !/sans/iu.test(block.fontFamily) : textFont.value === 'serif';
      const family = serif ? SERIF_FAMILY : SANS_FAMILY;
      let cached = fitCache.get(geometry);
      if (!cached || cached.text !== value || cached.style !== styleKey) {
        const measure = measureText(family);
        const fit = fitPdfBlockText({
          text: value, width: width * 0.985, height, fontSize: block.fontSize * textScale.value, lineHeight: (singleLine ? block.fontSize : block.lineHeight) * textScale.value,
          minFontSize: Math.max(6, block.fontSize * 0.5), weight: block.fontWeight,
        }, measure);
        // 提前折断的短行和段落末行保留自然字距；把测量结果和断行一起复用。
        const justify = !singleLine && block.textAlign === 'left' && block.kind !== 'heading';
        const fittedLines = fit.lines.map((text, at) => ({text, justified: justify && at < fit.lines.length - 1 && Boolean(fit.lines[at + 1]) && measure(text, fit.fontSize, block.fontWeight) >= width * 0.88}));
        cached = {text: value, style: styleKey, fit, lines: fittedLines};
        fitCache.set(geometry, cached);
      }
      const {fit} = cached;
      entry.lines = cached.lines;
      entry.overflow = fit.overflow;
      entry.boxStyle = {...entry.boxStyle, width: px(width), height: px(height), '--pdf-block-background': '#fff'};
      entry.textStyle = {fontSize: px(fit.fontSize), lineHeight: px(fit.lineHeight), fontWeight: String(block.fontWeight), textAlign: block.textAlign, color: '#111827', fontFamily: family};
      entry.eraseStyles = lines.flatMap(line => {
        // 擦除范围留在单元格或图文卡片内部，与导出画布一致。
        const boundary = block.cellBounds ?? block.panelBounds;
        const left = Math.max(line.x - 1, boundary ? boundary.x + 0.5 : -Infinity);
        const top = Math.max(line.y - 1, boundary ? boundary.y + 0.5 : -Infinity);
        const right = Math.min(line.x + line.width + 1, boundary ? boundary.x + boundary.width - 0.5 : Infinity);
        const bottom = Math.min(line.y + line.height + 2, boundary ? boundary.y + boundary.height - 0.5 : Infinity);
        return right > left && bottom > top ? [{left: px(left - block.x), top: px(top - block.y), width: px(right - left), height: px(bottom - top)}] : [];
      });
      return entry;
    }));
  }
  return result;
});
/** 译文层使用未旋转的内容坐标；展示方向与 PDF.js 画布一致。 */
function layerStyle(page: PdfDocumentPage): Record<string, string> {
  const rotation = page.rotation ?? 0;
  const quarterTurn = rotation === 90 || rotation === 270;
  const width = quarterTurn ? page.height : page.width, height = quarterTurn ? page.width : page.height;
  const transform = rotation === 90 ? `translateX(${page.width}px) rotate(90deg)` : rotation === 180 ? `translate(${page.width}px, ${page.height}px) rotate(180deg)`
    : rotation === 270 ? `translateY(${page.height}px) rotate(270deg)` : '';
  return {width: `${width}px`, height: `${height}px`, ...(transform ? {transform} : {})};
}
function highlightStyle(rect: OverlayEntry['rect']): Record<string, string> {
  return {left: px(rect.x - 3), top: px(rect.y - 3), width: px(rect.width + 6), height: px(rect.height + 6)};
}
function showHighlight(layout: PageLayout, entry: OverlayEntry): void {
  if (!hoverHighlight.value || props.mode !== 'bilingual' || layout.page.rotation) {highlight.value = undefined; return;}
  highlight.value = {pageNumber: layout.page.pageNumber, style: highlightStyle(entry.rect)};
}
/** 从原页像素取段落的底色与字色；每个段落只读回一次有界局部快照，不保留整页像素。 */
function sampleBlockColors(): void {
  let next: Map<string, {background: string; foreground: string}> | undefined;
  for (const [pageNumber, entries] of overlayPages.value) {
    const state = states.value.get(pageNumber);
    const page = pageByNumber.value.get(pageNumber);
    const canvas = state?.status === 'ready' ? state.output.translatedCanvas : undefined;
    if (!canvas || !page || page.rotation || !canvas.width) continue;
    const pageBlocks = blockByPageSegment.value.get(pageNumber);
    for (const entry of entries) {
      if (!entry.translated || blockColors.value.has(entry.id) || next?.has(entry.id)) continue;
      let colors = {background: '#fff', foreground: '#111827'};
      try {
        const context = canvas.getContext('2d');
        const ratio = canvas.width / page.width;
        if (context) {
          const line = pageBlocks?.get(entry.segmentIndex)?.lines?.[0] ?? entry.rect;
          const sampled = sampledPdfBlockColors(context, line.x * ratio, line.y * ratio, line.width * ratio, line.height * ratio);
          colors = {background: `rgb(${sampled.background.join(', ')})`, foreground: sampled.foreground};
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
let viewportHidden = false;
let materialRenderDocument = props.document;
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
  const first = pageIndexByNumber.value.get(pageNumber(range.startContainer));
  const last = pageIndexByNumber.value.get(pageNumber(range.endContainer));
  if (first === undefined || last === undefined) return [];
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
/** 长译文在拖选及原生选区保留期间保持展开；只更新附近页面的溢出段落，不改变文字节点或页面高度。 */
const expandedSelectionBlocks = shallowRef<ReadonlySet<string>>(new Set());
function retainTranslationSelection(selection: Selection | null): void {
  const next = new Set<string>();
  if (selection?.rangeCount && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const translated = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest('[data-fluentread-pdf-translation]');
    if (translated(range.startContainer) && translated(range.endContainer)) {
      for (const block of viewport.value?.querySelectorAll<HTMLElement>('.pdf-translation-block.overflowing') ?? []) {
        if (range.intersectsNode(block)) next.add(block.getAttribute('data-pdf-source-id')!);
      }
    }
  }
  const previous = expandedSelectionBlocks.value;
  if (next.size !== previous.size || [...next].some(id => !previous.has(id))) expandedSelectionBlocks.value = next;
}
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
  retainTranslationSelection(selection);
  const nextPins = indexesForRange(selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : undefined);
  const pinsChanged = nextPins.length !== nativePins.length || nextPins.some((pin, index) => pin !== nativePins[index]);
  nativePins = nextPins;
  if (pinsChanged && !viewportHidden) scheduleViewport();
}
function handleCardRange(event: Event): void {cardPins = indexesForRange((event as CustomEvent<{range?: Range}>).detail?.range); scheduleViewport();}
function handlePointerDown(event: PointerEvent): void {
  const target = event.target as Element;
  if (!viewport.value?.contains(target)) return;
  const layer = target.closest?.('[data-fluentread-pdf-text], [data-pdf-reading-page]');
  const page = Number(layer?.getAttribute('data-pdf-page-number') ?? layer?.getAttribute('data-pdf-reading-page'));
  pointerPin = pageIndexByNumber.value.get(page);
  if (event.button === 0) {
    const block = target.closest?.('.pdf-translation-block.overflowing');
    const id = block?.getAttribute('data-pdf-source-id');
    const previous = expandedSelectionBlocks.value;
    if (id ? previous.size !== 1 || !previous.has(id) : previous.size > 0) expandedSelectionBlocks.value = new Set(id ? [id] : []);
  }
  if (event.button === 0 && layer?.matches(TEXT_LAYER)) {selectionPointerDown = true; previousSelectionRange = undefined; selectionGuard(layer as HTMLElement); layer.classList.add('selecting');}
}
function handlePointerUp(): void {
  const hadPointerPin = pointerPin !== undefined;
  pointerPin = undefined;
  if (selectionPointerDown) {selectionPointerDown = false; resetSelectionGuards();}
  handleSelectionChange();
  if (hadPointerPin && !viewportHidden) scheduleViewport();
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
  const sourceText = state.output.sourceText?.element;
  const model = pageByNumber.value.get(pageNumber);
  if (sourceText && model) updatePdfOcrTextLayer(sourceText, model);
  if (source && state.output.sourceCanvas && source.firstChild !== state.output.sourceCanvas) {
    if (sourceText?.parentNode === source) source.insertBefore(state.output.sourceCanvas, sourceText);
    else source.replaceChildren(state.output.sourceCanvas, ...(sourceText ? [sourceText] : []));
  }
  if (translated && state.output.translatedCanvas && translated.firstChild !== state.output.translatedCanvas) translated.replaceChildren(state.output.translatedCanvas);
  for (const [id, canvas] of state.output.regions ?? []) {
    const host = regionHosts.get(id);
    if (host && host.firstChild !== canvas) {host.replaceChildren(canvas); canvas.setAttribute('aria-label', t('document.pdfReading.preservedRegion'));}
  }
}
function setReadingHost(pageNumber: number, element: Element | ComponentPublicInstance | null): void {
  const previous = readingHosts.get(pageNumber);
  if (previous === element) return;
  if (previous) observer?.unobserve(previous);
  if (!element) {readingHosts.delete(pageNumber); return;}
  readingHosts.set(pageNumber, element as HTMLElement);
  observer?.observe(element as HTMLElement);
}
function setRegionHost(pageNumber: number, id: string, element: Element | ComponentPublicInstance | null): void {
  if (!element) {regionHosts.delete(id); return;}
  if (regionHosts.get(id) === element) return;
  regionHosts.set(id, element as HTMLElement);
  mountPage(pageNumber);
}
function setPageHost(pageNumber: number, kind: 'source' | 'translated', element: Element | ComponentPublicInstance | null): void {
  const hosts = kind === 'source' ? sourceHosts : translatedHosts;
  if (!element) {hosts.delete(pageNumber); return;}
  if (hosts.get(pageNumber) === element) return;
  hosts.set(pageNumber, element as HTMLElement);
  mountPage(pageNumber);
}
let scrollSettleTimer: ReturnType<typeof setTimeout> | undefined;
let lastRenderedPageIndex = 0;
let lastScrollEventAt = 0;
let pendingFromScroll = false;

function syncScheduler(visible: readonly number[], index: number): void {
  clearTimeout(scrollSettleTimer);
  scrollSettleTimer = undefined;
  lastRenderedPageIndex = index;
  scheduler?.update(residentIndexes.value, pageIndex => {
    const page = pages.value[pageIndex];
    const renderPresentation = readable.value ? 'readable' : 'layout';
    const regionEntries = readingPlans.value.get(page.pageNumber)?.entries.filter((entry): entry is PdfReadingRegionEntry => entry.kind === 'region');
    return {scale: rasterScale.value, mode: props.mode, presentation: renderPresentation, regionEntries, refine: !readable.value && visible.includes(pageIndex),
      key: pdfReaderPageKey(page, rasterScale.value, props.mode, renderPresentation, regionEntries)};
  }, pages.value);
}
function updateViewport(): void {
  if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
  animationFrame = undefined;
  const fromScroll = pendingFromScroll;
  pendingFromScroll = false;
  if (!mounted || closed || viewportHidden || pages.value.length === 0) return;
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
    // 阅读线之上最近的一个标题就是当前章节；通过预排序数组二分查找定位。
    const line = top + Math.min(120, (scroll?.clientHeight || 720) / 4);
    activeOutlineId.value = findActiveOutlineId(line);
  }
  const now = Date.now();
  if (fromScroll && Math.abs(index - lastRenderedPageIndex) > 2 && now - lastScrollEventAt < 160) {
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = setTimeout(() => {
      scrollSettleTimer = undefined;
      if (!closed && mounted) updateViewport();
    }, SCROLL_SETTLE_DELAY_MS);
  } else {
    syncScheduler(visible, index);
  }
  if (fromScroll) lastScrollEventAt = now;
  emit('material-position-change');
}
function scheduleViewport(): void {
  if (animationFrame !== undefined || closed) return;
  animationFrame = window.requestAnimationFrame(updateViewport);
}
function scheduleScrollViewport(): void {
  pendingFromScroll = true;
  scheduleViewport();
}
function jumpTo(page: number, restoringMaterial = false): void {
  if (!restoringMaterial) materialNavigation.cancel();
  pendingReadingAnchor = lastReadingAnchor = undefined;
  readingUpdateGeneration += 1;
  const number = Math.max(1, Math.min(pages.value.length, Math.round(Number.isFinite(page) ? page : currentPage.value)));
  pageInputEditing = false;
  if (viewport.value) viewport.value.scrollTop = Math.max(0, (layouts.value[number - 1]?.top ?? 0) - PAGE_GUTTER / 2);
  updateViewport();
  pageInput.value = currentPage.value;
}
let resumeRevision = 0;
/** 等待首次 DOM 与页面高度提交，再淘汰此前排队的布局锚点；文档切换或后续请求取消旧恢复。 */
async function resumePage(page: number, exactLocation = false): Promise<void> {
  if (!exactLocation) materialNavigation.cancel();
  const revision = ++resumeRevision; const document = props.document;
  await nextTick();
  if (closed || !mounted || revision !== resumeRevision || document !== props.document) return;
  layoutUpdateGeneration += 1;
  jumpTo(page, true);
}
/** 坐标属于当前已解析模型；每次落点都淘汰旧布局锚点，重排使用实际段落节点。 */
function alignMaterialLocation(location: PdfMaterialLocation): {position: number; visible: boolean} | undefined {
  const scroll = viewport.value;
  const pageIndex = pageIndexByNumber.value.get(location.page.pageNumber);
  const layout = pageIndex === undefined ? undefined : layouts.value[pageIndex];
  if (!scroll || !layout) return;
  layoutUpdateGeneration += 1; readingUpdateGeneration += 1;
  pendingReadingAnchor = undefined; pendingZoomAnchor = undefined;
  if (readable.value) {
    const host = readingHosts.get(location.page.pageNumber);
    const elements = host ? Array.from(host.querySelectorAll<HTMLElement>(`[data-pdf-segment-index="${location.segmentIndex}"]`)) : [];
    if (elements.length !== 1 || elements[0].getAttribute('data-pdf-source-text') !== props.document.segments[location.segmentIndex]?.source) return;
    const element = elements[0], bounds = scroll.getBoundingClientRect();
    scroll.scrollTop = Math.max(0, scroll.scrollTop + element.getBoundingClientRect().top - bounds.top - PAGE_GUTTER * 2);
    updateViewport();
    const placed = element.getBoundingClientRect();
    return {position: scroll.scrollTop, visible: placed.bottom > bounds.top && placed.top < bounds.top + scroll.clientHeight};
  }
  const rect = pdfReaderDisplayRect(location.block, location.page);
  if (![rect.y, rect.height].every(Number.isFinite)) return;
  scroll.scrollTop = Math.max(0, layout.top + rect.y * scale.value - PAGE_GUTTER * 2);
  updateViewport();
  const top = layout.top + rect.y * scale.value - scroll.scrollTop;
  return {position: scroll.scrollTop, visible: top + rect.height * scale.value > 0 && top < scroll.clientHeight};
}
const materialNavigation = createPdfMaterialNavigation({
  document: () => props.document,
  active: () => mounted && !closed && materialRenderDocument === props.document,
  mode: () => `${presentation.value}:${props.mode}`,
  resumePage: page => resumePage(page, true), nextTick,
  nextFrame: signal => waitPdfMaterialFrame(window, signal),
  prepare: () => {if (readable.value) measureReadingHeights();},
  align: alignMaterialLocation,
  landed: location => {
    if (!readable.value) return;
    const element = readingHosts.get(location.page.pageNumber)?.querySelector<HTMLElement>(`[data-pdf-segment-index="${location.segmentIndex}"]`);
    const id = element?.getAttribute('data-pdf-source-id');
    if (id && element && viewport.value) lastReadingAnchor = {id, pageNumber: location.page.pageNumber, offset: element.getBoundingClientRect().top - viewport.value.getBoundingClientRect().top};
  },
});
async function resumeLocation(segmentIndex: number): Promise<boolean> {return materialNavigation.resumeLocation(segmentIndex);}
/** 可信用户阅读操作抢占自动恢复，同时淘汰此前排队的页码、布局与重排锚点。 */
function cancelMaterialResume(): void {
  resumeRevision += 1; materialNavigation.cancel();
  layoutUpdateGeneration += 1; readingUpdateGeneration += 1;
  pendingReadingAnchor = lastReadingAnchor = undefined; pendingZoomAnchor = undefined;
}
function resolveMaterialSelection(range: Range): number | undefined {
  if (!mounted || closed || !viewport.value) return;
  return resolvePdfMaterialSelection(range, {document: props.document, renderedDocument: materialRenderDocument, identity: documentIdentity.value, viewport: viewport.value, sourceHosts});
}
/** 与选区一样只返回当前模型索引；存储身份仍由文档组合根创建。 */
function captureMaterialLocation(): number | undefined {
  if (!mounted || closed || !viewport.value) return;
  return captureVisiblePdfMaterialLocation({document: props.document, renderedDocument: materialRenderDocument, identity: documentIdentity.value,
    viewport: viewport.value, sourceHosts, translatedHosts, readingHosts, mode: props.mode, readable: readable.value,
    residentPages: residentLayouts.value.map(layout => layout.page),
    readyPages: new Set(residentLayouts.value.filter(layout => states.value.get(layout.page.pageNumber)?.status === 'ready').map(layout => layout.page.pageNumber))});
}
function markSelection(range: Range, kind: 'highlight' | 'underline'): boolean {return annotationControls.value?.markSelection(range, kind) ?? false;}
const hypothesisRequested = ref(false), hypothesisBusy = ref(false), hypothesisMessage = ref('');
const hypothesisCanCancel = computed(() => hypothesisBusy.value && hypothesisRequested.value);
const hypothesisUrl = computed(() => pdfHypothesisUrl(props.sourceUrl));
const hypothesisStatus = computed(() => {
  if (hypothesisMessage.value) return hypothesisMessage.value;
  if (props.translating && hypothesisRequested.value) return 'document.pdfReading.hypothesisWaiting';
  return hypothesisBusy.value && hypothesisRequested.value ? 'document.pdfReading.hypothesisConnecting' : '';
});
let hypothesisRevision = 0;
let hypothesisClient: ReturnType<typeof createHypothesisClient> | undefined;
function documentHypothesisClient() {
  return hypothesisClient ??= createHypothesisClient({document: globalThis.document, window,
    assetUrl: path => browser.runtime.getURL(`/${path}`),
    inject: () => injectHypothesisDocumentScript(globalThis.document, browser.runtime.getURL('/hypothesis/build/scripts/annotator.bundle.js')),
    prepare: async signal => {
      const binary = props.document.binary;
      if (binary?.kind !== 'pdf' || !viewport.value) throw new Error('PDF reader unavailable');
      const reading = readable.value;
      const text = reading ? pages.value.map(page => buildPdfReadingPlan(props.document, page, props.mode === 'source' ? [] : props.translations).entries.map(entry => entry.kind === 'text' ? `${props.mode === 'bilingual' && entry.translated ? entry.source : ''}${entry.text}` : '').join('')) : undefined;
      return installPdfHypothesisAdapter({window, viewport: viewport.value, viewer: viewport.value.querySelector('.pdf-page-list')!,
        container: viewport.value.closest('.pdf-layout-viewer')!, sourceUrl: props.sourceUrl, text,
        acquire: () => acquirePdfDocument(binary.bytes), top: index => layouts.value[index]?.top ?? 0,
        page: index => {
          const number = index + 1;
          if (reading) {const frame = readingHosts.get(number); return frame ? {frame, text: frame} : undefined;}
          const host = sourceHosts.get(number), frame = host?.closest<HTMLElement>('.pdf-page-frame');
          return frame ? {frame, text: states.value.get(number)?.status === 'ready' ? host!.querySelector<HTMLElement>('[data-fluentread-pdf-text]') ?? undefined : undefined} : undefined;
        },
      }, signal);
    },
  });
}
async function syncHypothesis(): Promise<boolean> {
  const revision = ++hypothesisRevision;
  hypothesisBusy.value = true; hypothesisMessage.value = '';
  const client = documentHypothesisClient();
  await client.setEnabled(false);
  if (closed || revision !== hypothesisRevision) return false;
  let result = {status: 'success', active: false};
  if (hypothesisRequested.value && !props.translating) {
    await nextTick();
    if (closed || revision !== hypothesisRevision) return false;
    result = await client.setEnabled(true);
  }
  if (closed || revision !== hypothesisRevision) return false;
  hypothesisBusy.value = false;
  if (result.status !== 'success') {
    hypothesisRequested.value = false;
    hypothesisMessage.value = result.status === 'external' ? 'document.pdfReading.hypothesisExternal' : 'document.pdfReading.hypothesisFailed';
  }
  return result.active;
}
async function toggleHypothesis(event: MouseEvent): Promise<void> {
  if (hypothesisBusy.value && !hypothesisRequested.value) return;
  const button = event.currentTarget as HTMLButtonElement | null;
  if (props.translating && !hypothesisRequested.value) {
    hypothesisMessage.value = 'document.pdfReading.hypothesisWaiting';
    return;
  }
  if (!hypothesisRequested.value && (props.mode === 'translated' || pages.value.some(page => page.ocrRecognized)) && !readable.value) {
    choosePresentation('readable');
    await nextTick();
  }
  hypothesisRequested.value = !hypothesisRequested.value;
  // 等待期间可能已打开备注编辑器，或收起后重新打开了面板。
  if (await syncHypothesis() && button?.isConnected && openMenu.value === 'annotations') closeMenu(true);
}
watch([presentation, () => props.mode, () => props.translating, () => props.translations, () => props.document], () => {
  if (!props.translating && hypothesisMessage.value === 'document.pdfReading.hypothesisWaiting') hypothesisMessage.value = '';
  if (!hypothesisRequested.value) return;
  if ((props.mode === 'translated' || pages.value.some(page => page.ocrRecognized)) && !readable.value) {hypothesisRequested.value = false;}
  void syncHypothesis();
}, {flush: 'post'});
watch(() => props.document.binary?.bytes, () => {
  hypothesisMessage.value = '';
  if (hypothesisClient) {hypothesisRequested.value = false; void syncHypothesis();}
}, {flush: 'sync'});
defineExpose({resumePage, resumeLocation, cancelMaterialResume, resolveMaterialSelection, captureMaterialLocation, markSelection});
function jumpToAnnotation(annotation: PdfAnnotation): void {
  closeMenu(true);
  const index = annotation.page - 1;
  const page = pages.value[index];
  if (readable.value || !page || !annotation.rects.length) {
    jumpTo(annotation.page);
    return;
  }
  jumpToPosition(index, Math.min(...annotation.rects.map(rect => rect.y)) * page.height);
}
function alignReadingParagraph(pageNumber: number, segmentIndex: number): boolean {
  const scroll = viewport.value, host = readingHosts.get(pageNumber);
  if (!scroll || !host || typeof scroll.getBoundingClientRect !== 'function') return false;
  const element = host.querySelector<HTMLElement>(`[data-pdf-segment-index="${segmentIndex}"]`);
  if (!element || typeof element.getBoundingClientRect !== 'function') return false;
  const bounds = scroll.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (!bounds.height && !rect.top && !rect.height) return false;
  scroll.scrollTop = Math.max(0, scroll.scrollTop + rect.top - bounds.top - PAGE_GUTTER * 2);
  updateViewport();
  return true;
}
function jumpToPosition(pageIndex: number, y: number, segmentIndex?: number): void {
  materialNavigation.cancel();
  const layout = layouts.value[pageIndex];
  if (!layout || !viewport.value) return;
  pendingReadingAnchor = lastReadingAnchor = undefined;
  const generation = ++readingUpdateGeneration;
  pageInputEditing = false;
  if (readable.value) {
    viewport.value.scrollTop = Math.max(0, layout.top - PAGE_GUTTER * 2);
    updateViewport();
    if (segmentIndex !== undefined && segmentIndex >= 0) {
      if (!alignReadingParagraph(layout.page.pageNumber, segmentIndex)) {
        void nextTick(() => {
          if (!closed && readable.value && generation === readingUpdateGeneration) alignReadingParagraph(layout.page.pageNumber, segmentIndex);
        });
      }
    }
    pageInput.value = currentPage.value;
    return;
  }
  viewport.value.scrollTop = Math.max(0, layout.top + Math.min(layout.height, y * scale.value) - PAGE_GUTTER * 2);
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
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const ARROW_WIDGET_SELECTOR = '[role="slider"], [role="listbox"], [role="combobox"], [role="tab"], [role="tablist"], [role="radiogroup"]';
function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  if (typeof element.closest === 'function') {
    if (element.closest('input, textarea, select')) return true;
    const ceHost = element.closest('[contenteditable]');
    if (ceHost) return ceHost.getAttribute('contenteditable')?.toLowerCase() !== 'false';
  }
  if (typeof element.matches === 'function' && element.matches(EDITABLE_SELECTOR)) return true;
  return Boolean(element.isContentEditable);
}
function handleGlobalShortcuts(event: KeyboardEvent): void {
  if (event.defaultPrevented || closed || !mounted || viewportHidden || !viewport.value || viewport.value.clientWidth === 0 || fullPassage.value) return;
  if (globalThis.document?.querySelector?.('dialog[open]')) return;
  const targetElement = event.target as Element | null;
  const inPdfSearch = Boolean(targetElement?.closest?.('.pdf-search'));
  const isFind = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f';
  if (targetElement?.closest?.('dialog[open], [role="dialog"], [aria-modal="true"]')) {
    if (!isFind || !inPdfSearch) return;
  }
  if (isFind) {
    if (openMenu.value && openMenu.value !== 'search' && isEditableTarget(event.target)) return;
    event.preventDefault();
    openMenu.value = 'search';
    void nextTick(() => {searchInput.value?.focus(); searchInput.value?.select?.();});
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || openMenu.value || isEditableTarget(event.target)) return;
  if (targetElement?.closest?.(ARROW_WIDGET_SELECTOR)) return;
  if (event.key === 'ArrowLeft') {event.preventDefault(); jumpTo(currentPage.value - 1);}
  else if (event.key === 'ArrowRight') {event.preventDefault(); jumpTo(currentPage.value + 1);}
}
function handleViewportKey(event: KeyboardEvent): void {
  if (event.target !== viewport.value || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === 'PageDown') {event.preventDefault(); jumpTo(currentPage.value + 1);}
  else if (event.key === 'PageUp') {event.preventDefault(); jumpTo(currentPage.value - 1);}
  else if (event.key === 'Home') {event.preventDefault(); jumpTo(1);}
  else if (event.key === 'End') {event.preventDefault(); jumpTo(pages.value.length);}
}
function errorFor(pageNumber: number): string | undefined {
  const state = states.value.get(pageNumber);
  return state?.status === 'error' ? state.message : state?.status === 'ready' ? state.refreshError : undefined;
}
function createScheduler(): void {
  materialNavigation.cancel(); materialRenderDocument = props.document;
  bindZoomGestures();
  clearTimeout(rasterTimer); rasterTimer = undefined; rasterScale.value = scale.value;
  clearTimeout(scrollSettleTimer); scrollSettleTimer = undefined; lastRenderedPageIndex = 0; lastScrollEventAt = 0; pendingFromScroll = false;
  clearTimeout(searchDebounceTimer); searchDebounceTimer = undefined;
  pendingZoomAnchor = undefined; zoomPoint = undefined;
  scheduler?.dispose();
  releaseOutlineLease();
  outlineGeneration += 1;
  nativeOutline.value = [];
  states.value = new Map();
  sourceHosts.clear();
  translatedHosts.clear();
  readingHosts.clear(); regionHosts.clear(); readingHeights.value = new Map(); blockColors.value = new Map(); highlight.value = undefined;
  nativePins = []; cardPins = []; pointerPin = undefined; pageInputEditing = false; selectionPointerDown = false; previousSelectionRange = undefined;
  expandedSelectionBlocks.value = new Set();
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
  void loadNativeOutline();
}
watch(() => props.document, (document, previous) => {
  fullPassageDialog.value?.close(); fullPassage.value = undefined;
  informationController?.setEnabled(false); informationWanted = false;
  if (!mounted) return;
  if (document.binary?.kind === 'pdf' && previous.binary?.kind === 'pdf' && document.binary.bytes === previous.binary.bytes) {
    // OCR 逐页补入文字时保持当前页、缩放和已有画布，不把读者拉回第一页。
    materialNavigation.cancel(); materialRenderDocument = document;
    updateViewport();
    for (const pageNumber of sourceHosts.keys()) mountPage(pageNumber);
  } else createScheduler();
  syncInformationHighlight();
}, {flush: 'post'});
// 原版缩放保留文字节点与 Range；重排阅读或切换视图时再重新扫描正文。
watch([() => readable.value ? zoom.value : undefined, presentation, () => props.mode], () => informationController?.refresh(), {flush: 'pre'});
watch([presentation, () => props.mode, outlineOpen], () => {highlight.value = undefined; if (mounted) scheduleViewport();}, {flush: 'post'});
watch([overlayPages, states], sampleBlockColors, {flush: 'post'});
// 在 DOM 更新前记录可见段落；新译文或换行只移动其前后的内容，不能把同页阅读点按比例移走。
watch([readingPlans, zoom, presentation, viewportWidth, textScale, textFont, lineSpacing, paragraphSpacing, reflowBilingualLayout, () => props.mode], () => {
  if (!mounted || closed) return;
  const captured = readable.value ? captureReadingAnchor() : undefined;
  if (captured) lastReadingAnchor = captured;
  pendingReadingAnchor = readable.value ? captured ?? lastReadingAnchor : undefined;
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
watch(layouts, async (next, previous) => {
  if (!mounted || closed) return;
  if (next.length === previous.length && next.every((layout, index) => {
    const old = previous[index];
    return layout.page.pageNumber === old.page.pageNumber && layout.top === old.top && layout.rowHeight === old.rowHeight
      && layout.width === old.width && layout.height === old.height;
  })) {scheduleViewport(); return;}
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
  globalThis.document.addEventListener('keydown', handleGlobalShortcuts);
  globalThis.document.addEventListener('pointerdown', handlePointerDown, true);
  globalThis.document.addEventListener('pointerdown', closeMenus, true);
  globalThis.document.addEventListener('keydown', closeMenus, true);
  globalThis.document.addEventListener('pointerup', handlePointerUp, true);
  globalThis.document.addEventListener('pointercancel', handlePointerUp, true);
  globalThis.document.body.addEventListener('fluentread-pdf-selection-range-change', handleCardRange);
  if (typeof ResizeObserver !== 'undefined' && viewport.value) {
    observer = new ResizeObserver(entries => {
      const scroll = viewport.value;
      // 页签隐藏（v-show）时尺寸变为 0；标记隐藏并忽略零尺寸回调，避免重置视口宽度或把用户退回第一页。
      if (!scroll || scroll.clientWidth === 0 || scroll.clientHeight === 0) {
        viewportHidden = true;
        return;
      }
      viewportHidden = false;
      if (!pendingReadingAnchor && readable.value) pendingReadingAnchor = lastReadingAnchor;
      // 末页比视口短时页码定位会停在滚动底部；工具栏提示压缩视口不能把读者退到前一页。
      const keepBottom = scroll.scrollTop > 0 && scroll.scrollTop + viewportHeight.value >= scroll.scrollHeight - 1;
      viewportWidth.value = scroll.clientWidth;
      viewportHeight.value = scroll.clientHeight;
      if (keepBottom) scroll.scrollTop = Math.max(0, scroll.scrollHeight - viewportHeight.value);
      measureReadingHeights(entries.map(entry => entry.target));
      scheduleViewport();
      void nextTick(fitToolbarMenus);
    });
    observer.observe(viewport.value);
    readingHosts.forEach(host => observer!.observe(host));
  }
});
onBeforeUnmount(() => {
  hypothesisRequested.value = false; hypothesisRevision += 1; void hypothesisClient?.dispose();
  materialNavigation.dispose();
  closed = true;
  outlineGeneration += 1;
  releaseOutlineLease();
  fullPassageDialog.value?.close();
  disposeZoomGestures?.();
  clearTimeout(rasterTimer); rasterTimer = undefined; pendingZoomAnchor = undefined;
  clearTimeout(scrollSettleTimer); scrollSettleTimer = undefined;
  clearTimeout(searchDebounceTimer); searchDebounceTimer = undefined;
  window.removeEventListener('resize', fitToolbarMenus);
  informationController?.dispose(); informationController = undefined;
  readingUpdateGeneration += 1;
  observer?.disconnect();
  globalThis.document.removeEventListener('selectionchange', handleSelectionChange);
  globalThis.document.removeEventListener('keydown', handleInformationHotkey, true);
  globalThis.document.removeEventListener('keydown', handleGlobalShortcuts);
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

<style scoped src="./pdf-reader.css"></style>

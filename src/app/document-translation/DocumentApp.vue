<!--
 @file src/app/document-translation/DocumentApp.vue
 文件职责：实现独立文档翻译页面的完整 Vue 应用，承载文件导入、格式化预览、分段翻译、人工校订和双语文件导出的用户流程。
 主要内容：组织文档阅读与翻译任务，维护校订和未下载保护；PDF 与 ZIP 导出显示逐页进度，支持取消、重试和离开时中止，保留异步提交所有权。
 模块边界：组件负责页面交互与响应式状态，不自行解析二进制格式、不实现片段翻译队列、配置存储协议或导出编码；解析渲染来自 document-translation feature，配置协调来自 services/config，运行时适配由本目录 runtime 注入。
-->
<!-- 文档页面归 app 层所有；WXT 入口只负责启动。 -->
<template>
  <div class="document-app" :class="{ dark: isDark, 'is-workspace': parsedDocument }">
    <header class="document-header">
      <div class="document-brand" aria-label="流畅阅读文档翻译">
        <img src="/icon/128.png" alt="" />
        <span>
          <strong>流畅阅读</strong>
          <small>文档翻译</small>
        </span>
      </div>
      <div class="header-actions">
        <button v-if="parsedDocument" class="ghost-button" type="button" :disabled="queueBusy" @click="openFilePicker">添加文件</button>
        <button v-if="!parsedDocument" class="header-settings" type="button" aria-label="打开翻译设置" @click="openSettings"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 2 3h3l1-3 3-1 2-3-2-2 1-3-3-2-2 1-2-3H9Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="11.5" cy="11" r="3" stroke="currentColor" stroke-width="1.4"/></svg><span>设置</span></button>
      </div>
    </header>

    <input ref="fileInput" class="visually-hidden" type="file" multiple :accept="accept" tabindex="-1" @change="handleFileInput" />
    <main class="document-main">
      <p v-if="hydrated && !config.on" class="notice" role="status" data-testid="document-translation-paused">{{ t('popup.heroDisabled') }} · <button type="button" @click="openGeneralSettings">通用设置</button></p>
      <section v-if="documentQueue.length > 1 || documentQueue.some(item => item.error && !item.document)" class="document-batch" :aria-label="t('document.batch.queue')" :aria-busy="openingFile">
        <div class="batch-toolbar">
          <button class="batch-toggle" type="button" :aria-expanded="queueExpanded" aria-controls="document-queue-files" @click="queueExpanded = !queueExpanded"><strong>{{ t('document.batch.queue') }} · {{ documentQueue.length }}</strong><span aria-hidden="true">{{ queueExpanded ? '−' : '+' }}</span></button>
          <span role="status">{{ batchRunning ? t('document.batch.running') : openingFile ? t('document.batch.importing') : t('document.batch.completed', {count: batchCompletedCount}) }}</span>
          <button v-if="batchRunning" type="button" @click="pauseTranslation">{{ t('document.batch.pause') }}</button>
          <button v-else-if="batchPendingCount" type="button" :disabled="!config.on || queueBusy || !hydrated || Boolean(credentialWarning)" @click="startBatch">{{ t('document.batch.start') }}</button>
          <span v-if="!queueExpanded && documentQueue.some(item => !item.document)" class="queue-error">有文件导入失败，请展开查看</span>
          <label v-if="queueExpanded && batchCompletedCount">{{ t('document.batch.output') }}<ElSelect class="batch-output" v-model="outputMode" :disabled="queueBusy" :aria-label="t('document.batch.output')" append-to=".document-app"><ElOption value="bilingual" :label="translateLegacy('双语')" /><ElOption value="translated" :label="translateLegacy('仅译文')" /></ElSelect></label>
          <button v-if="queueExpanded && batchCompletedCount" type="button" :disabled="queueBusy" @click="downloadBatch">{{ t('document.batch.zip') }}</button>
          <button v-if="preparingDownload && !downloadOpen" type="button" :disabled="cancelingDownload" @click="cancelDownload">{{ t(cancelingDownload ? 'document.export.canceling' : 'document.export.cancel') }}</button>
        </div>
        <ul v-show="queueExpanded" id="document-queue-files" class="batch-files">
          <li v-for="item in documentQueue" :key="item.id" :class="{ selected: item.id === activeDocumentId }">
            <button class="batch-file" type="button" :disabled="queueBusy || !item.document" :aria-pressed="item.id === activeDocumentId" @click="selectDocument(item)">
              <span data-i18n-ignore>{{ item.name }}</span><small>{{ queueStatus(item) }}</small>
            </button>
            <button type="button" :disabled="queueBusy" :aria-label="`${t('document.batch.remove')} ${item.name}`" @click="removeDocument(item)">{{ t('document.batch.remove') }}</button>
            <p v-if="item.error" class="notice error" role="alert" data-i18n-ignore>{{ item.error }}</p>
          </li>
        </ul>
        <p v-if="batchNotice" class="notice" role="status">{{ batchNotice }}</p>
      </section>
      <section v-if="!parsedDocument" class="landing-section">
        <div class="landing-copy">
          <h1>文档换一种语言，阅读依然流畅</h1>
          <p>论文、电子书、工作资料与字幕，从打开文件到双语阅读。</p>
        </div>

        <div
          class="file-drop-zone"
          :class="{ dragging: isDragging }"
          :aria-busy="openingFile"
          aria-label="文档拖放区域"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="handleDrop"
        >
          <div class="upload-symbol" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path d="M28 7H13a3 3 0 0 0-3 3v28a3 3 0 0 0 3 3h22a3 3 0 0 0 3-3V17L28 7Z" stroke="currentColor" stroke-width="2"/><path d="M28 7v10h10M24 33V22m-5 5 5-5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <h2>{{ openingFile ? '正在整理文档' : '把文件拖到这里' }}</h2>
          <p class="upload-description">{{ openingFile ? '解析完成后，即可确认语言并开始翻译' : t('document.batch.pickMany') }}</p>
          <button class="open-file-button" type="button" :disabled="openingFile" @click.stop="openFilePicker">
            {{ openingFile ? '正在解析文件…' : '选择文件' }}
          </button>
          <small>{{ t('document.fileLimitNote', {size: maxFileSizeLabel}) }}</small>
        </div>

        <div class="format-list" aria-label="支持的文件格式">
          <span v-for="item in formatCards" :key="item.code" class="format-card"><b :class="item.tone">{{ item.code }}</b>{{ item.label }}</span>
        </div>
        <p class="local-processing-note">文件在本地解析，待译文字会发送给你选择的翻译服务。扫描版 PDF 暂不支持文字识别。</p>
        <details class="document-samples"><summary>没有文件？先用范例试试</summary>
          <div><p>导入后确认设置，再开始翻译。范例也可以校订和下载。</p></div>
          <div class="sample-buttons"><button v-for="sample in DOCUMENT_QUICK_SAMPLES" :key="sample.name" type="button" :disabled="queueBusy" @click="loadSample(sample)"><strong>{{ sample.label }}<span aria-hidden="true"> ↗</span></strong><small>{{ sample.description }}</small></button></div>
        </details>
        <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>
      </section>

      <section v-else class="workspace-section">
        <section class="document-taskbar" aria-label="当前文档与翻译任务">
          <div class="workspace-heading">
            <div class="file-heading"><span class="task-file-format">{{ formatCode }}</span><div><h1 data-i18n-ignore>{{ parsedDocument.fileName }}</h1><p class="document-status" role="status">{{ statusLabel }}<span v-if="hasTranslation"> · {{ completedSegments }} / {{ parsedDocument.segments.length }}</span></p></div></div>
          </div>
          <div class="taskbar-actions">
            <button class="document-settings-button" type="button" aria-label="调整文档翻译设置" @click="openDocumentSettings"><span data-i18n-ignore>{{ translationSettingsSummary }}</span><small>调整设置</small></button>
            <div class="translation-actions">
              <button v-if="translating" class="ghost-button pause-button" type="button" @click="pauseTranslation">暂停翻译</button>
              <button v-else-if="!translationComplete || settingsChanged" class="translate-document-button" type="button" :disabled="!config.on || !hydrated || queueBusy || Boolean(credentialWarning)" @click="requestTranslation">{{ translationActionLabel }}</button>
            </div>
          </div>
          <div class="task-progress" :class="{ complete: translationComplete }" role="progressbar" aria-label="文档翻译进度" :aria-valuenow="progress" :aria-valuemin="0" :aria-valuemax="100"><i :style="{width: `${progress}%`}" /></div>
          <p v-if="errorMessage || credentialWarning || configSaveError" class="notice error task-notice" role="alert">{{ errorMessage || credentialWarning || configSaveError }} <button v-if="credentialWarning || configSaveError" type="button" @click="documentSettingsDialog?.showModal()">调整设置</button></p>
          <p v-if="settingsChanged" class="notice warning task-notice">设置已更改。现有译文保留，按新设置翻译会从头开始。</p>
        </section>
        <article class="document-reading-pane" aria-label="文档内容">
        <div class="reader-toolbar">
          <div class="mode-buttons reader-tabs" role="group" aria-label="文档工作区">
            <button type="button" :class="{ selected: readerTab === 'read' }" :aria-pressed="readerTab === 'read'" @click="readerTab = 'read'">阅读</button>
            <button type="button" :class="{ selected: readerTab === 'edit' }" :aria-pressed="readerTab === 'edit'" @click="readerTab = 'edit'">校订译文</button>
          </div>
          <div v-if="readerTab === 'read'" class="mode-buttons" role="group" aria-label="阅读方式">
            <button v-for="mode in readingModes" :key="mode.value" type="button" :class="{ selected: effectivePreviewMode === mode.value }" :aria-pressed="effectivePreviewMode === mode.value" :disabled="!hasTranslation && mode.value !== 'source'" @click="previewMode = mode.value">{{ mode.label }}</button>
          </div>
          <button class="download-button" type="button" :disabled="!hasTranslation || queueBusy" @click="openDownload">下载文件 ↓</button>
        </div>
        <DocumentSegmentEditor :key="activeDocumentId ?? 0" v-show="readerTab === 'edit'" :document="parsedDocument" :translations="translatedSegments" :disabled="queueBusy" @update="editSegment" />
        <div v-show="readerTab === 'read'" class="reading-content">
        <section
          v-if="isPdfDocument"
          class="pdf-layout-viewer"
          aria-label="PDF 版式翻译预览"
          data-document-reader="pdf"
          :data-segment-count="parsedDocument.segments.length"
        >
          <div class="pdf-viewer-toolbar">
            <div class="pdf-page-summary" aria-label="PDF 连续页面阅读状态">
              <strong>{{ t('document.pageCount', {count: pdfPageCount}) }}</strong>
              <span>按页面连续阅读，可切换原文与译文</span>
            </div>
            <label class="pdf-zoom-control">
              <span>缩放</span>
              <ElSelect class="document-select"  append-to=".document-app" v-model="pdfZoom" aria-label="PDF 预览缩放">
                <ElOption :value="1" :label="translateLegacy('适合宽度')" />
                <ElOption :value="1.25" label="125%" />
                <ElOption :value="1.5" label="150%" />
              </ElSelect>
            </label>
          </div>

          <div class="pdf-page-scroll" data-pdf-scroll>
            <article
              v-for="pdfPage in pdfPreviewPageStates"
              :key="pdfPage.pageNumber"
              class="pdf-page-row"
              :data-page-number="pdfPage.pageNumber"
            >
              <div class="pdf-page-row-heading">
                <strong>{{ t('document.pageNumber', {page: pdfPage.pageNumber}) }}</strong>
                <span>{{ pdfPage.loading ? '正在渲染…' : '版式已保留' }}</span>
              </div>
              <div
                class="pdf-page-stage"
                :class="{ single: effectivePreviewMode !== 'bilingual' }"
                :style="{ '--pdf-zoom': pdfZoom, '--pdf-page-max-width': `${720 * pdfZoom}px` }"
              >
                <figure v-if="effectivePreviewMode !== 'translated'" class="pdf-page-column">
                  <figcaption><span>原文</span><strong>{{ t('document.pageNumber', {page: pdfPage.pageNumber}) }}</strong></figcaption>
                  <div class="pdf-page-frame" :style="{ aspectRatio: `${pdfPage.width} / ${pdfPage.height}` }">
                    <img v-if="pdfPage.originalUrl" :src="pdfPage.originalUrl" :alt="t('document.pdfOriginalPage', {page: pdfPage.pageNumber})" />
                    <span v-else class="pdf-page-loading">正在渲染原页…</span>
                  </div>
                </figure>
                <figure v-if="effectivePreviewMode !== 'source'" class="pdf-page-column translated">
                  <figcaption><span>译文</span><strong>保留原版式</strong></figcaption>
                  <div class="pdf-page-frame" :style="{ aspectRatio: `${pdfPage.width} / ${pdfPage.height}` }">
                    <img v-if="pdfPage.translatedUrl" :src="pdfPage.translatedUrl" :alt="t('document.pdfTranslatedPage', {page: pdfPage.pageNumber})" />
                    <div v-else class="pdf-page-pending">
                      <span v-if="pdfPage.loading || pdfPreviewLoading" class="spinner dark-spinner" />
                      <strong>{{ translating ? '正在翻译并重排本页' : '等待生成译页' }}</strong>
                      <small>译文会写回对应文本框，图表与页面布局保持原位</small>
                    </div>
                  </div>
                </figure>
              </div>

            </article>
            <div v-if="!pdfPreviewPageStates.length" class="pdf-page-empty">
              <span class="spinner dark-spinner" />
              <strong>正在准备 PDF 连续阅读页…</strong>
            </div>
          </div>
        </section>

        <section
          v-else-if="isRichDocument"
          class="rich-document-reader"
          :class="`reader-${parsedDocument.format}`"
          data-document-reader="rich"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="排版文档双语阅读预览"
        >
          <nav v-if="isEpubDocument" class="reader-native-toolbar" aria-label="ePub 章节导航">
            <button
              v-for="(chapter, index) in epubChapters"
              :key="chapter.path"
              type="button"
              :class="{ selected: epubChapterIndex === index }"
              @click="epubChapterIndex = index"
            >
              <span>{{ index + 1 }}</span>{{ chapter.title }}
            </button>
          </nav>
          <iframe
            class="rich-preview-frame"
            :srcdoc="richPreviewHtml"
            sandbox=""
            :title="t('document.layoutPreview', {format: parsedDocument.label})"
          />
        </section>

        <section
          v-else-if="isDocxDocument"
          class="docx-document-reader"
          data-document-reader="docx"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="Word 文档页面预览"
        >
          <nav class="reader-native-toolbar" aria-label="Word 文档部分">
            <button
              v-for="(part, index) in docxParts"
              :key="part.path"
              type="button"
              :class="{ selected: docxPartIndex === index }"
              @click="docxPartIndex = index"
            >
              {{ docxPartLabel(part.path) }}
            </button>
          </nav>
          <div class="docx-page-stage">
            <article class="docx-page">
              <span class="docx-page-label">{{ docxPartLabel(currentDocxPart?.path || '') }}</span>
              <section
                v-for="row in currentDocxRows"
                :key="row.index"
                class="docx-paragraph"
                :class="`docx-role-${row.role || 'paragraph'}`"
              >
                <p v-if="effectivePreviewMode !== 'translated'" class="docx-source document-source" data-i18n-ignore>{{ row.source }}</p>
                <p v-if="effectivePreviewMode !== 'source'" class="docx-translation document-translation" data-i18n-ignore>{{ row.translation || translateLegacy('等待翻译…') }}</p>
              </section>
            </article>
          </div>
        </section>

        <section
          v-else-if="isSubtitleDocument"
          class="subtitle-document-reader"
          :class="{single: effectivePreviewMode !== 'bilingual'}"
          data-document-reader="subtitle"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="字幕时间轴翻译表格"
        >
          <div class="subtitle-table-scroll">
            <table>
              <thead><tr><th>#</th><th>时间范围</th><th v-if="effectivePreviewMode !== 'translated'">原文</th><th v-if="effectivePreviewMode !== 'source'">译文</th></tr></thead>
              <tbody>
                <tr v-for="row in subtitleRows" :key="row.index">
                  <td class="subtitle-index">{{ row.index + 1 }}</td>
                  <td class="subtitle-timing"><time>{{ row.timeStart || '—' }}</time><span aria-hidden="true"> → </span><time>{{ row.timeEnd || '—' }}</time></td>
                  <td v-if="effectivePreviewMode !== 'translated'"><p class="subtitle-source document-source" data-i18n-ignore>{{ readerText(row.source) }}</p></td>
                  <td v-if="effectivePreviewMode !== 'source'">
                    <p class="subtitle-translation document-translation" data-i18n-ignore>{{ row.translation || translateLegacy('等待翻译…') }}</p>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section
          v-else-if="isJsonDocument"
          class="json-document-reader"
          data-document-reader="json"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="JSON 字符串路径翻译表格"
        >
          <div class="json-table-header" :class="{ single: effectivePreviewMode !== 'bilingual' }"><span>JSONPath</span><span v-if="effectivePreviewMode !== 'translated'">原字符串</span><span v-if="effectivePreviewMode !== 'source'">译文</span></div>
          <article v-for="row in jsonRows" :key="row.index" class="json-table-row" :class="{ single: effectivePreviewMode !== 'bilingual' }">
            <code>{{ row.pathLabel || '$' }}</code>
            <p v-if="effectivePreviewMode !== 'translated'" class="json-source document-source" data-i18n-ignore>{{ row.source }}</p>
            <p v-if="effectivePreviewMode !== 'source'" class="json-translation document-translation" data-i18n-ignore>{{ row.translation || translateLegacy('等待翻译…') }}</p>
          </article>
        </section>

        <div v-else class="document-reader" data-document-reader="generic" :data-segment-count="parsedDocument.segments.length" :class="`reader-${parsedDocument.format}`" aria-label="文档双语阅读预览">
          <article v-for="row in previewRows" :key="row.index" class="reader-block">
            <span v-if="row.contextLabel" class="reader-context">{{ row.contextLabel }}</span>
            <div v-if="effectivePreviewMode !== 'translated'" class="reader-source document-source" data-i18n-ignore :class="readerSourceClass(row.source)">
              {{ readerText(row.source) }}
            </div>
            <p v-if="effectivePreviewMode !== 'source'" class="reader-translation document-translation" data-i18n-ignore>{{ row.translation || translateLegacy('等待翻译…') }}</p>
          </article>
        </div>
        <p v-if="!hasTranslation" class="reader-empty">
          {{ emptyReaderHint }}
        </p>
        <nav v-if="readerPageCount > 1" class="reader-pagination" aria-label="文档阅读分页"><button type="button" :disabled="readerPage === 1" @click="readerPage--">上一页</button><span>第 {{ readerPage }} / {{ readerPageCount }} 页</span><button type="button" :disabled="readerPage === readerPageCount" @click="readerPage++">下一页</button></nav>
        </div>
        <p v-if="hasTranslation || downloadNotice" class="reader-save-note" role="status">{{ downloadNotice || '译文仅保留在本页，请下载后再离开。' }}</p>
        </article>
      </section>
    </main>

    <dialog ref="documentSettingsDialog" class="document-dialog document-settings-dialog" aria-labelledby="document-settings-heading">
      <h2 id="document-settings-heading">翻译设置</h2>
        <!-- 弹窗外壳先挂载；导入后再创建下拉控件，确保 Teleport 目标已存在。 -->
        <section v-if="parsedDocument" class="translation-setup" aria-label="翻译设置">
        <div class="control-panel">
          <label class="language-control">
            <span>源语言</span>
            <ElSelect class="document-select" :wrap-label="false" :show-search-icon="false" append-to=".document-settings-dialog" v-model="config.from" :disabled="queueBusy" aria-label="文档源语言" filterable>
              <ElOption v-for="item in sourceLanguageOptions" :key="item.value" :value="item.value" data-i18n-ignore :label="item.value === 'auto' ? translateLegacy(item.label) : getMultilingualTargetLanguageLabel(item.value, item.label, language)" />
            </ElSelect>
          </label>
          <span class="language-arrow" aria-hidden="true">→</span>
          <label class="language-control">
            <span>目标语言</span>
            <ElSelect class="document-select" :wrap-label="false" :show-search-icon="false" append-to=".document-settings-dialog" v-model="config.to" :disabled="queueBusy" aria-label="文档目标语言" filterable>
              <ElOption v-for="item in options.to" :key="item.value" :value="item.value" data-i18n-ignore :label="getMultilingualTargetLanguageLabel(item.value, item.label, language)" />
            </ElSelect>
          </label>
          <label class="service-control">
            <span>翻译服务</span>
            <ElSelect class="document-select" :wrap-label="false" :show-search-icon="false" append-to=".document-settings-dialog" v-model="config.documentService" :empty-values="[null, undefined]" :disabled="queueBusy" aria-label="文档翻译服务" filterable>
              <ElOption :label="t('featureServices.followDefault')" value="" />
              <ElOption v-if="config.documentService && documentServiceUnavailableMessage" :value="config.documentService" disabled :label="translateLegacy('Chrome内置AI翻译（当前浏览器不可用）')" />
              <ElOption v-for="item in serviceOptions" :key="item.value" :value="item.value" :label="translateLegacy(item.label)" />
            </ElSelect>
          </label>
          <label v-if="documentUsesModel" class="model-control">
            <span class="model-control-heading">模型<button v-if="!documentIsCustomOpenAIProvider" type="button" @click.prevent="openSettings">管理模型 ↗</button></span>
            <ElSelect class="document-select" :wrap-label="false" :show-search-icon="false" append-to=".document-settings-dialog" v-model="selectedDocumentModel" :disabled="queueBusy" aria-label="文档翻译模型" filterable>
              <ElOption v-for="model in documentModelOptions" :key="model" :value="model" data-i18n-ignore :label="model" />
            </ElSelect>
          </label>
        </div>
        <GlossaryLibrarySelect
          v-if="config.glossaryLibraries.length || config.glossaryEnabled"
          v-model="config.documentGlossaryIds"
          :libraries="config.glossaryLibraries"
          :enabled="config.glossaryEnabled"
          :unsupported="!supportsTranslationGlossary(effectiveDocumentService, selectedDocumentModel)"
          :disabled="queueBusy"
        >
          <template #mode-control="{mode, changeMode}">
            <ElSelect class="document-select" :wrap-label="false" :show-search-icon="false" append-to=".document-settings-dialog" :model-value="mode" :disabled="queueBusy" :aria-label="t('glossary.mode')" @change="changeMode">
              <ElOption value="inherit" :label="t('glossary.inherit')" />
              <ElOption value="none" :label="t('glossary.none')" />
              <ElOption value="selected" :disabled="!config.glossaryLibraries.length" :label="t('glossary.choose')" />
            </ElSelect>
          </template>
        </GlossaryLibrarySelect>
        <p v-if="credentialWarning" class="notice warning" role="alert">{{ credentialWarning }} <button type="button" @click="openSettings">去配置</button></p>
        <p v-if="settingsChanged" class="notice warning">设置已更改。现有译文和下载内容仍使用之前的结果，按新设置翻译会从头开始。</p>
        <p class="setup-privacy">文件在本地解析，文字发送至所选服务。</p>
        </section>
      <p v-if="configSaveError" class="notice error" role="alert">{{ configSaveError }}</p>
      <div class="document-settings-footer"><button class="sidebar-change-file" type="button" :aria-label="documentQueue.length > 1 ? t('document.batch.clear') : translateLegacy('打开新文件')" :disabled="queueBusy" @click="changeDocument">{{ documentQueue.length > 1 ? t('document.batch.clear') : translateLegacy('更换文件') }}</button><button class="settings-link" type="button" @click="openSettings">服务连接设置 ↗</button></div>
      <div class="dialog-actions"><button class="ghost-button" type="button" autofocus @click="documentSettingsDialog?.close()">返回文档</button><button class="translate-document-button" type="button" :disabled="!config.on || !hydrated || queueBusy || Boolean(credentialWarning) || !parsedDocument" @click="translateFromSettings">{{ translationActionLabel }}</button></div>
    </dialog>
    <dialog ref="confirmDialog" class="document-dialog" aria-labelledby="confirm-document-heading" @close="pendingAction = null">
      <h2 id="confirm-document-heading">{{ pendingAction === 'remove' ? t('document.batch.removeTitle') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clearTitle') : '打开另一份文档？') : '重新翻译这份文档？' }}</h2>
      <p>{{ pendingAction === 'remove' ? t('document.batch.removeWarning') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clearWarning') : '当前翻译和校订结果只保留在本页，离开后无法恢复。建议先下载需要的结果。') : '重新翻译会替换现有译文和人工校订。你也可以返回并先下载当前结果。' }}</p>
      <div class="dialog-actions"><button class="ghost-button" type="button" autofocus @click="confirmDialog?.close()">返回文档</button><button class="translate-document-button" type="button" @click="confirmAction">{{ pendingAction === 'remove' ? t('document.batch.remove') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clear') : '打开新文件') : '重新翻译' }}</button></div>
    </dialog>
    <dialog ref="downloadDialog" class="document-dialog download-dialog" aria-labelledby="download-document-heading" :aria-busy="preparingDownload" @close="downloadOpen = false" @cancel="preparingDownload && $event.preventDefault()">
      <h2 id="download-document-heading">下载翻译结果</h2><p>按原格式另存一份文件。下载内容包含你的校订。</p>
      <div class="export-options" role="group" aria-label="下载内容">
        <button type="button" :disabled="queueBusy" :aria-pressed="outputMode === 'bilingual'" :class="{ selected: outputMode === 'bilingual' }" @click="outputMode = 'bilingual'"><strong>双语对照</strong><span>{{ isPdfDocument ? '原页与译页左右并排' : '同时保留原文和译文' }}</span></button>
        <button type="button" :disabled="queueBusy" :aria-pressed="outputMode === 'translated'" :class="{ selected: outputMode === 'translated' }" @click="outputMode = 'translated'"><strong>仅译文</strong><span>适合直接阅读和分享</span></button>
      </div>
      <p class="export-file-name" data-i18n-ignore>{{ downloadFileName }}</p>
      <section v-if="downloadOpen" class="export-preview" aria-label="文件内容预览">
        <strong>{{ parsedDocument?.binary ? '文字摘录 · 下载时保留原文件格式' : '文件内容预览' }}</strong><pre data-i18n-ignore>{{ downloadPreview }}</pre>
      </section>
      <p v-if="!translationComplete" class="notice warning">{{ t("document.untranslatedWarning", {count: (parsedDocument?.segments.length || 0) - completedSegments}) }}</p>
      <label v-if="!translationComplete" class="partial-export"><input v-model="partialExportAcknowledged" type="checkbox" :disabled="queueBusy" />我已了解，下载当前结果</label>
      <p v-if="settingsChanged" class="notice warning">设置已更改，本次下载仍是当前保留的译文。</p>
      <p v-if="isSubtitleDocument" class="export-note">保留字幕序号和时间轴。仅译文替换字幕文字，双语在同一时间段内保留原文和译文。</p>
      <p v-if="isPdfDocument" class="export-note">PDF 译页以图像呈现，适合保留版面阅读，暂不支持复制译文。</p>
      <p v-if="downloadProgress" class="notice export-progress" role="status" aria-live="polite">{{ downloadProgress }}</p>
      <p v-if="downloadError" class="notice error" role="alert">{{ downloadError }}</p>
      <div class="dialog-actions"><button v-if="preparingDownload" class="ghost-button" type="button" :disabled="cancelingDownload" @click="cancelDownload">{{ t(cancelingDownload ? 'document.export.canceling' : 'document.export.cancel') }}</button><button v-else class="ghost-button" type="button" :disabled="queueBusy" @click="downloadDialog?.close()">返回文档</button><button class="translate-document-button" type="button" :disabled="queueBusy || !hasTranslation || (!translationComplete && !partialExportAcknowledged)" @click="downloadDocument">{{ preparingDownload ? '正在生成文件…' : `下载${outputMode === 'bilingual' ? '双语' : '译文'}文件` }}</button></div>
    </dialog>
    <footer v-if="!parsedDocument" class="document-footer">
      <span>让语言更近，让世界更大。</span>
      <a href="https://github.com/Bistutu/FluentRead" target="_blank" rel="noreferrer">开源项目 ↗</a>
    </footer>
  </div>
</template>

<script lang="ts" setup>

import {ElOption} from 'element-plus';
import 'element-plus/es/components/select/style/css';
import {markRaw, computed, onMounted, onUnmounted, reactive, ref, watch} from 'vue';
import DocumentSegmentEditor from './DocumentSegmentEditor.vue';
import browser from 'webextension-polyfill';
import {
  Config,
  TranslationRequestError,
  buildGlossaryRevision,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_QUICK_SAMPLES,
  createDocumentDownload,
  createDocumentDownloadName,
  createDocumentFileLoadGuard,
  createDocumentPreviewHtml,
  createPdfPagePreview,
  filterAvailableTranslationServices,
  formatDocumentReaderText,
  getDocumentAcceptAttribute,
  getDocumentEmptyReaderHint,
  getDocumentExportPreview,
  getDocumentFormat,
  getDocumentReaderSourceClass,
  getDocxPartLabel as docxPartLabel,
  getCustomOpenAIProvider,
  getMissingCredentialMessage,
  getMultilingualTargetLanguageLabel,
  getTranslationServiceUnavailableMessage,
  isRichDocumentFormat,
  isSubtitleDocumentFormat,
  customModelString,
  configReady,
  models,
  options,
  parseDocument,
  parseDocumentFile,
  requestConfigPatch,
  resolveConfiguredModel,
  runtimeConfig,
  servicesType,
  subscribeConfig,
  translateDocumentSegments,
  withCustomOpenAIServiceOptions,
  GlossaryLibrarySelect,
  supportsTranslationGlossary,
  useUiI18n,
  type DocumentRenderMode,
  type ParsedDocument,
  ElSelect,
} from '@/src/app/document-translation';

const READER_PAGE_SIZE = 80;

interface PdfPreviewPageState {
  pageNumber: number;
  width: number;
  height: number;
  originalUrl: string;
  translatedUrl: string;
  loading: boolean;
}

type DocumentConfigPatch = Partial<Pick<Config,
  'from' | 'to' | 'documentService' | 'documentModel' | 'documentCustomModel' | 'documentGlossaryIds'
>>;
type DocumentModelMapping = Config['documentModel'];

function sameDocumentModelMapping(left: DocumentModelMapping, right: DocumentModelMapping): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

function mergeChangedDocumentModelMapping(
  latest: DocumentModelMapping,
  previous: DocumentModelMapping,
  next: DocumentModelMapping,
): DocumentModelMapping {
  const merged = {...latest};
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  keys.forEach((key) => {
    if (previous[key] === next[key]) return;
    if (Object.prototype.hasOwnProperty.call(next, key)) merged[key] = next[key];
    else delete merged[key];
  });
  return merged;
}

const config = reactive(new Config());
const {language, t, translateLegacy} = useUiI18n();
const fileInput = ref<HTMLInputElement | null>(null);
const parsedDocument = ref<ParsedDocument | null>(null);
const translatedSegments = ref<string[]>([]);
const outputMode = ref<DocumentRenderMode>('bilingual');
const previewMode = ref<'source' | DocumentRenderMode>('bilingual');
const readerTab = ref<'read' | 'edit'>('read');
const readerPage = ref(1);
const runState = ref<'ready' | 'paused' | 'failed'>('ready');
const taskFingerprint = ref('');
const settledTranslations = ref<string[]>([]);
const confirmDialog = ref<HTMLDialogElement | null>(null);
const downloadDialog = ref<HTMLDialogElement | null>(null);
const downloadOpen = ref(false);
const queueExpanded = ref(false);
const documentSettingsDialog = ref<HTMLDialogElement | null>(null);
const configSaveError = ref('');
const pendingAction = ref<'reset' | 'restart' | 'remove' | null>(null);
let pendingRemoval: DocumentQueueItem | null = null;
const partialExportAcknowledged = ref(false);
const downloadError = ref('');
const downloadNotice = ref('');
const editRevision = ref(0);
const downloadedRevision = ref(0);
const readingModes = [{value: 'source', label: '原文'}, {value: 'bilingual', label: '双语'}, {value: 'translated', label: '译文'}] as const;
const isDragging = ref(false);
const translating = ref(false);

const errorMessage = ref('');
const openingFile = ref(false);
const preparingDownload = ref(false);
const cancelingDownload = ref(false);
const downloadProgress = ref('');
let downloadController: AbortController | null = null;
const pdfZoom = ref(1);
const pdfPreviewLoading = ref(false);
const pdfPreviewPageStates = ref<PdfPreviewPageState[]>([]);
const epubChapterIndex = ref(0);
const docxPartIndex = ref(0);
const hydrated = ref(false);
const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = ref(colorSchemeMedia.matches);
let abortController: AbortController | null = null;
const documentFileLoads = createDocumentFileLoadGuard();
let translationRequestId = 0;
let lastSerialized = '';
let applyingExternalConfig = false;
let configSaveRequest = 0;
let unsubscribeConfig: (() => void) | undefined;
let pdfPreviewTimer: ReturnType<typeof setTimeout> | undefined;
let pdfPreviewRequest = 0;

interface DocumentQueueItem {
  id: number;
  name: string;
  document: ParsedDocument | null;
  translations: string[];
  fingerprint: string;
  state: 'ready' | 'paused' | 'failed';
  revision: number;
  downloaded: number;
  error: string;
}
const documentQueue = ref<DocumentQueueItem[]>([]);
const activeDocumentId = ref<number | null>(null);
const batchRunning = ref(false);
const batchNotice = ref('');
let nextDocumentId = 0;
let batchGeneration = 0;
const queueBusy = computed(() => translating.value || batchRunning.value || openingFile.value || preparingDownload.value);
const completeItem = (item: DocumentQueueItem) => Boolean(item.document && item.document.segments.every(segment => item.translations[segment.id]?.trim()));
const batchCompletedCount = computed(() => documentQueue.value.filter(item => item.id === activeDocumentId.value ? translationComplete.value : completeItem(item)).length);
const batchPendingCount = computed(() => documentQueue.value.filter(item => item.document && !(item.id === activeDocumentId.value ? translationComplete.value : completeItem(item))).length);

function saveActiveDocument(): void {
  const item = documentQueue.value.find(item => item.id === activeDocumentId.value);
  if (!item) return;
  Object.assign(item, {translations: [...translatedSegments.value], fingerprint: taskFingerprint.value,
    state: runState.value, revision: editRevision.value, downloaded: downloadedRevision.value, error: errorMessage.value});
}

function selectDocument(item: DocumentQueueItem): void {
  if (!item.document) return;
  saveActiveDocument();
  clearPdfPreviewUrls();
  pdfPreviewRequest += 1;
  if (pdfPreviewTimer) clearTimeout(pdfPreviewTimer);
  activeDocumentId.value = item.id;
  parsedDocument.value = item.document;
  translatedSegments.value = [...item.translations];
  settledTranslations.value = [...item.translations];
  taskFingerprint.value = item.fingerprint;
  runState.value = item.state;
  editRevision.value = item.revision;
  downloadedRevision.value = item.downloaded;
  errorMessage.value = item.error;
  downloadNotice.value = '';
  readerPage.value = 1;
  readerTab.value = 'read';
  epubChapterIndex.value = 0;
  docxPartIndex.value = 0;
  pdfZoom.value = 1;
  pdfPreviewLoading.value = false;
}

function queueStatus(item: DocumentQueueItem): string {
  if (!item.document) return t('document.batch.importFailed');
  if (item.id === activeDocumentId.value) return `${translateLegacy(statusLabel.value)} · ${progress.value}%`;
  if (completeItem(item)) return translateLegacy('翻译完成');
  const done = item.translations.filter(text => text?.trim()).length;
  return `${translateLegacy(item.state === 'failed' ? '翻译中断' : item.state === 'paused' ? '已暂停' : '等待翻译')} · ${done}/${item.document.segments.length}`;
}

async function startBatch(): Promise<void> {
  if (!config.on || queueBusy.value || !hydrated.value || credentialWarning.value) return;
  saveActiveDocument();
  const pending = documentQueue.value.filter(item => item.document && !completeItem(item));
  // 已有译文的语言或术语设置不同，留给单文件的重译确认处理，避免批量按钮抹掉校订。
  if (pending.some(item => item.translations.some(text => text?.trim()) && item.fingerprint !== currentFingerprint.value)) {
    batchNotice.value = t('document.batch.settingsChanged');
    return;
  }
  const generation = ++batchGeneration;
  const fingerprint = currentFingerprint.value;
  batchRunning.value = true;
  batchNotice.value = '';
  try {
    for (const item of pending) {
      if (generation !== batchGeneration) break;
      if (fingerprint !== currentFingerprint.value) {
        batchNotice.value = t('document.batch.externalSettings');
        break;
      }
      selectDocument(item);
      await startTranslation(settingsChanged.value);
      saveActiveDocument();
    }
  } finally {
    if (generation === batchGeneration) batchRunning.value = false;
  }
}

function removeDocument(item: DocumentQueueItem, confirmed = false): void {
  if (queueBusy.value) return;
  saveActiveDocument();
  if (!confirmed && item.revision > item.downloaded) {
    pendingRemoval = item;
    pendingAction.value = 'remove';
    confirmDialog.value?.showModal();
    return;
  }
  documentQueue.value = documentQueue.value.filter(entry => entry.id !== item.id);
  if (item.id === activeDocumentId.value) {
    const next = documentQueue.value.find(entry => entry.document);
    if (next) selectDocument(next);
    else {
      activeDocumentId.value = null;
      parsedDocument.value = null;
      translatedSegments.value = [];
      settledTranslations.value = [];
      editRevision.value = downloadedRevision.value = 0;
      pdfPreviewRequest += 1;
      clearPdfPreviewUrls();
    }
  }
}

async function downloadBatch(): Promise<void> {
  if (queueBusy.value) return;
  saveActiveDocument();
  const items = documentQueue.value.filter(completeItem);
  if (!items.length) return;
  preparingDownload.value = true;
  const controller = new AbortController();
  downloadController = controller;
  cancelingDownload.value = false;
  batchNotice.value = '';
  const generation = batchGeneration;
  const mode = outputMode.value;
  try {
    const {default: JSZip} = await import('jszip');
    const zip = new JSZip();
    for (const [index, item] of items.entries()) {
      const download = await createDocumentDownload(item.document!, item.translations, mode, {
        signal: controller.signal,
        onPdfProgress: progress => { batchNotice.value = `${item.name} · ${pdfExportProgress(progress)}`; },
      });
      controller.signal.throwIfAborted();
      if (generation !== batchGeneration) return;
      // 独立目录避免同名文件覆盖，文件名不能在 ZIP 中创建任意路径。
      const name = download.fileName.replace(/[\\/\x00-\x1f]/g, '_');
      zip.file(`${index + 1}/${name}`, download.data);
    }
    batchNotice.value = t('document.export.saving');
    const blob = await zip.generateAsync({type: 'blob'}, () => controller.signal.throwIfAborted());
    controller.signal.throwIfAborted();
    if (generation !== batchGeneration) return;
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = 'FluentRead-documents.zip';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    for (const item of items) item.downloaded = item.revision;
    const active = items.find(item => item.id === activeDocumentId.value);
    if (active) downloadedRevision.value = active.revision;
    batchNotice.value = t('document.batch.downloaded', {count: items.length});
  } catch (error) {
    if (generation === batchGeneration) batchNotice.value = controller.signal.aborted
      ? t('document.export.canceled')
      : t('document.batch.downloadFailed', {error: error instanceof Error ? error.message : String(error)});
  } finally {
    if (downloadController === controller) {
      preparingDownload.value = false;
      cancelingDownload.value = false;
      downloadController = null;
    }
  }
}

const accept = getDocumentAcceptAttribute();
const maxFileSizeLabel = `${Math.round(DOCUMENT_MAX_BYTES / 1024 / 1024)} MB`;
const sourceLanguageOptions = options.from;
const translationSettingsSummary = computed(() => {
  const label = (items: typeof options.from, value: string) => items.find(item => item.value === value)?.label || value;
  const service = serviceOptions.value.find(item => item.value === effectiveDocumentService.value)?.label || effectiveDocumentService.value;
  return `${translateLegacy(label(options.from, config.from))} → ${translateLegacy(label(options.to, config.to))} · ${service}`;
});
const downloadFileName = computed(() => parsedDocument.value ? createDocumentDownloadName(parsedDocument.value.fileName, outputMode.value) : '');
const downloadPreview = computed(() => downloadOpen.value && parsedDocument.value
  ? getDocumentExportPreview(parsedDocument.value, translatedSegments.value, outputMode.value) : '');
const formatCards = [
  {code: 'PDF', label: '论文 / 资料', tone: 'coral'},
  {code: 'EPUB', label: '电子书', tone: 'teal'},
  {code: 'HTML', label: '网页', tone: 'coral'},
  {code: 'JSON', label: '语言文件', tone: 'teal'},
  {code: 'TXT', label: '纯文本', tone: 'slate'},
  {code: 'DOCX', label: 'Word 文档', tone: 'slate'},
  {code: 'MD', label: 'Markdown', tone: 'sand'},
  {code: 'SUB', label: '字幕 / 歌词', tone: 'violet'},
];

const serviceOptions = computed(() => filterAvailableTranslationServices(withCustomOpenAIServiceOptions(
  options.services,
  config.customOpenAIProviders,
)).filter((item: any) => !item.disabled).map((item: any) => ({
  ...item,
  label: translateLegacy(item.label),
  description: item.description ? translateLegacy(item.description) : item.description,
})));
const effectiveDocumentService = computed(() => config.documentService || config.service);
const activeDocumentModels = computed(() => config.documentService ? config.documentModel : config.model);
const activeDocumentCustomModels = computed(() => config.documentService ? config.documentCustomModel : config.customModel);
const documentServiceUnavailableMessage = computed(() => getTranslationServiceUnavailableMessage(effectiveDocumentService.value));
const selectedCustomOpenAIProvider = computed(() => getCustomOpenAIProvider(
  config.customOpenAIProviders,
  effectiveDocumentService.value,
));
const documentIsCustomOpenAIProvider = computed(() => Boolean(selectedCustomOpenAIProvider.value));
const documentUsesModel = computed(() => documentIsCustomOpenAIProvider.value
  || servicesType.isUseModel(effectiveDocumentService.value));
const builtInDocumentModels = computed(() => (models.get(effectiveDocumentService.value) || [])
  .filter((model) => model !== customModelString));
const documentModelOptions = computed(() => {
  if (selectedCustomOpenAIProvider.value) return selectedCustomOpenAIProvider.value.models;
  return Array.from(new Set([
    ...builtInDocumentModels.value,
    ...(config.customModels[effectiveDocumentService.value] || []),
    activeDocumentModels.value[effectiveDocumentService.value] === customModelString
      ? activeDocumentCustomModels.value[effectiveDocumentService.value] || ''
      : '',
  ].filter(Boolean)));
});
const selectedDocumentModel = computed({
  get: () => documentIsCustomOpenAIProvider.value
    ? activeDocumentModels.value[effectiveDocumentService.value] || documentModelOptions.value[0] || ''
    : resolveConfiguredModel(
      activeDocumentModels.value[effectiveDocumentService.value],
      activeDocumentCustomModels.value[effectiveDocumentService.value],
    ) || documentModelOptions.value[0] || '',
  set: (value: string) => {
    const service = effectiveDocumentService.value;
    config.documentService = service;
    if (documentIsCustomOpenAIProvider.value || builtInDocumentModels.value.includes(value)) {
      config.documentModel[service] = value;
      return;
    }
    // requestConfigPatch 只提交显式请求的顶层字段，因此必须在同一轮同时写入
    // sentinel 和真实模型；post-flush watcher 会把它们合并成一个原子 patch。
    config.documentCustomModel[service] = value;
    config.documentModel[service] = customModelString;
  },
});
const documentModelValue = computed(() => selectedDocumentModel.value);
const credentialWarning = computed(() => {
  if (documentServiceUnavailableMessage.value) return documentServiceUnavailableMessage.value;
  if (documentUsesModel.value && !documentModelValue.value.trim()) {
    return documentIsCustomOpenAIProvider.value
      ? '这个自定义服务尚未保存模型，请先前往服务设置添加模型。'
      : '文档翻译模型尚未配置，请先选择模型或填写自定义模型名称。';
  }

  const credentialConfig = {
    ...config,
    model: {...config.model, [effectiveDocumentService.value]: activeDocumentModels.value[effectiveDocumentService.value]},
    customModel: {...config.customModel, [effectiveDocumentService.value]: activeDocumentCustomModels.value[effectiveDocumentService.value]},
  };
  return getMissingCredentialMessage(effectiveDocumentService.value, credentialConfig);
});
const rowForSegment = (segment: ParsedDocument['segments'][number]) => ({
  ...segment, index: segment.id, translation: translatedSegments.value[segment.id] || '',
});
const pageRows = <T,>(rows: readonly T[]) => rows.slice((readerPage.value - 1) * READER_PAGE_SIZE, readerPage.value * READER_PAGE_SIZE);
const previewRows = computed(() => pageRows(parsedDocument.value?.segments || []).map(rowForSegment));
const hasTranslation = computed(() => translatedSegments.value.some((item) => Boolean(item?.trim())));
const completedSegments = computed(() => parsedDocument.value?.segments.filter(segment => translatedSegments.value[segment.id]?.trim()).length || 0);
const translationComplete = computed(() => Boolean(parsedDocument.value && completedSegments.value === parsedDocument.value.segments.length));
const progress = computed(() => parsedDocument.value ? Math.floor(completedSegments.value / parsedDocument.value.segments.length * 100) : 0);
const effectivePreviewMode = computed(() => hasTranslation.value ? previewMode.value : 'source');
const currentFingerprint = computed(() => JSON.stringify({
  from: config.from, to: config.to, service: effectiveDocumentService.value, model: selectedDocumentModel.value,
  glossaryIds: config.documentGlossaryIds, glossaryRevision: buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
}));
const settingsChanged = computed(() => Boolean(taskFingerprint.value && taskFingerprint.value !== currentFingerprint.value));
const translationActionLabel = computed(() => settingsChanged.value ? '按新设置翻译' : translationComplete.value ? '重新翻译' : hasTranslation.value || runState.value === 'paused' ? '继续翻译' : runState.value === 'failed' ? '重试翻译' : '开始翻译');
const statusLabel = computed(() => translating.value ? '正在翻译' : translationComplete.value ? '翻译完成' : runState.value === 'paused' ? '已暂停' : runState.value === 'failed' ? '翻译中断' : hasTranslation.value ? '部分完成' : '准备就绪');
const hasUnsavedWork = computed(() => translating.value || batchRunning.value || openingFile.value || editRevision.value > downloadedRevision.value
  || documentQueue.value.some(item => item.id !== activeDocumentId.value && item.revision > item.downloaded));
const isPdfDocument = computed(() => parsedDocument.value?.binary?.kind === 'pdf');
const isEpubDocument = computed(() => parsedDocument.value?.binary?.kind === 'epub');
const isDocxDocument = computed(() => parsedDocument.value?.binary?.kind === 'docx');
const isSubtitleDocument = computed(() => isSubtitleDocumentFormat(parsedDocument.value?.format));
const isJsonDocument = computed(() => parsedDocument.value?.format === 'json');
const isRichDocument = computed(() => isRichDocumentFormat(parsedDocument.value?.format));
const pdfPageCount = computed(() => parsedDocument.value?.binary?.kind === 'pdf' ? parsedDocument.value.binary.pages.length : 0);
const epubChapters = computed(() => parsedDocument.value?.binary?.kind === 'epub'
  ? parsedDocument.value.binary.chapters
  : []);
const currentEpubChapter = computed(() => epubChapters.value[epubChapterIndex.value]);
const richPreviewDocument = computed<ParsedDocument | null>(() => {
  const document = parsedDocument.value;
  if (!document) return null;
  if (document.binary?.kind === 'epub') {
    const chapter = currentEpubChapter.value;
    return chapter ? parseDocument('chapter.html', chapter.source) : null;
  }
  return ['html', 'markdown', 'txt'].includes(document.format) ? document : null;
});
const richPreviewTranslations = computed(() => {
  const chapter = currentEpubChapter.value;
  return chapter
    ? settledTranslations.value.slice(chapter.segmentOffset, chapter.segmentOffset + chapter.segmentCount)
    : settledTranslations.value;
});
const richPreviewHtml = computed(() => {
  const document = richPreviewDocument.value;
  if (!document) return '';
  const html = createDocumentPreviewHtml(
    document,
    richPreviewTranslations.value,
    settledTranslations.value.some(Boolean) ? previewMode.value : 'source',
  );
  // 只为当前隔离阅读页补充固定主题规则，不改变原文件或导出内容。
  return isDark.value ? html.replace('</head>', `<style>
    :root { color-scheme: dark; color: #e8edf7; background: #202632; }
    h1,h2,h3,h4,h5,h6,.reader-source,.reader-translation,.fluentread-translation,[data-fluent-read-document-translation="true"] { color: #e8edf7; }
    blockquote { color: #aab2c3; } a,.reader-link { color: #ff8bad; }
    pre,code,.document-security-note { color: #e8edf7; background: #29303d; border-color: #434b5d; }
    td,th { border-color: #434b5d; }
  </style></head>`) : html;
});
const docxParts = computed(() => parsedDocument.value?.binary?.kind === 'docx'
  ? parsedDocument.value.binary.parts
  : []);
const currentDocxPart = computed(() => docxParts.value[docxPartIndex.value]);
const currentDocxRows = computed(() => {
  const document = parsedDocument.value;
  const part = currentDocxPart.value;
  if (!document || !part) return [];
  return pageRows(part.paragraphSegments).map(({segmentIndex}) => {
    const segment = document.segments[segmentIndex];
    return {
      index: segmentIndex,
      source: segment?.source || '',
      role: segment?.role,
      translation: translatedSegments.value[segmentIndex] || '',
    };
  });
});
const subtitleRows = computed(() => previewRows.value);
const jsonRows = computed(() => previewRows.value);
const emptyReaderHint = computed(() => getDocumentEmptyReaderHint(parsedDocument.value));
const readerPageCount = computed(() => isPdfDocument.value || isRichDocument.value ? 1 : Math.max(1, Math.ceil((isDocxDocument.value ? currentDocxPart.value?.paragraphSegments.length || 0 : parsedDocument.value?.segments.length || 0) / READER_PAGE_SIZE)));
const formatCode = computed(() => parsedDocument.value?.format === 'markdown' ? 'MD' : parsedDocument.value?.format.toUpperCase() || 'FILE');

function pngObjectUrl(bytes: Uint8Array): string {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return URL.createObjectURL(new Blob([buffer], {type: 'image/png'}));
}

function clearPdfPreviewUrls(): void {
  pdfPreviewPageStates.value.forEach((page) => {
    if (page.originalUrl) URL.revokeObjectURL(page.originalUrl);
    if (page.translatedUrl) URL.revokeObjectURL(page.translatedUrl);
  });
  pdfPreviewPageStates.value = [];
}

async function refreshPdfPreviews(): Promise<void> {
  const document = parsedDocument.value;
  if (document?.binary?.kind !== 'pdf') {
    clearPdfPreviewUrls();
    return;
  }
  // 每轮预览刷新取得独立代次；旧渲染在创建或写入 Object URL 前都必须放弃提交权。
  const request = ++pdfPreviewRequest;
  pdfPreviewLoading.value = true;

  const previousPages = new Map(pdfPreviewPageStates.value.map((page) => [page.pageNumber, page]));
  previousPages.forEach((page) => {
    if (page.translatedUrl) URL.revokeObjectURL(page.translatedUrl);
  });
  pdfPreviewPageStates.value = document.binary.pages.map((page) => {
    const previous = previousPages.get(page.pageNumber);
    return {
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      // 仅译文栅格变化时复用原始页面，避免重复创建和释放相同的 Object URL。
      originalUrl: previous?.originalUrl || '',
      translatedUrl: '',
      loading: true,
    };
  });

  try {
    for (const page of document.binary.pages) {
      if (request !== pdfPreviewRequest) return;
      const preview = await createPdfPagePreview(
        document,
        page.pageNumber,
        hasTranslation.value ? translatedSegments.value : undefined,
      );
      if (request !== pdfPreviewRequest) return;
      const state = pdfPreviewPageStates.value.find((entry) => entry.pageNumber === page.pageNumber);
      if (!state) continue;
      if (!state.originalUrl) state.originalUrl = pngObjectUrl(preview.original);
      if (preview.translated) state.translatedUrl = pngObjectUrl(preview.translated);
      state.loading = false;
    }
  } catch (error) {
    if (request === pdfPreviewRequest) showError(error instanceof Error ? error.message : String(error));
  } finally {
    if (request === pdfPreviewRequest) pdfPreviewLoading.value = false;
  }
}

function schedulePdfPreview(): void {
  if (pdfPreviewTimer) clearTimeout(pdfPreviewTimer);
  pdfPreviewTimer = setTimeout(() => { void refreshPdfPreviews(); }, 350);
}

function readerText(value: string): string {
  return formatDocumentReaderText(parsedDocument.value?.format, value);
}

function readerSourceClass(value: string): string {
  return getDocumentReaderSourceClass(parsedDocument.value?.format, value);
}

function applyTheme(): void {
  isDark.value = colorSchemeMedia.matches;
}

async function hydrateConfig(): Promise<void> {
  await configReady;
  Object.assign(config, runtimeConfig);
  lastSerialized = JSON.stringify(config);
  hydrated.value = true;
}
void hydrateConfig();

unsubscribeConfig = subscribeConfig((nextConfig) => {
  const serialized = JSON.stringify(nextConfig);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  applyingExternalConfig = true;
  try {
    Object.assign(config, nextConfig);
    if (!config.on && (translating.value || batchRunning.value)) pauseTranslation();
  } finally {
    applyingExternalConfig = false;
  }
});

// post flush 会把一次模型选择对 documentModel/documentCustomModel 的同步修改
// 合并成一个字段 patch，避免先保存 sentinel 或 scalar 的半成品。
watch(config, (value) => {
  if (!hydrated.value || applyingExternalConfig) return;
  const serialized = JSON.stringify(value);
  if (serialized === lastSerialized) return;
  const previous = JSON.parse(lastSerialized) as Config;
  lastSerialized = serialized;
  const patch: DocumentConfigPatch = {};
  if (value.from !== previous.from) patch.from = value.from;
  if (value.to !== previous.to) patch.to = value.to;
  if (value.documentService !== previous.documentService) patch.documentService = value.documentService;
  if (JSON.stringify(value.documentGlossaryIds) !== JSON.stringify(previous.documentGlossaryIds)) {
    patch.documentGlossaryIds = value.documentGlossaryIds === null ? null : [...value.documentGlossaryIds];
  }
  if (!sameDocumentModelMapping(value.documentModel, previous.documentModel)) {
    patch.documentModel = mergeChangedDocumentModelMapping(
      runtimeConfig.documentModel,
      previous.documentModel,
      value.documentModel,
    );
  }
  if (!sameDocumentModelMapping(value.documentCustomModel, previous.documentCustomModel)) {
    patch.documentCustomModel = mergeChangedDocumentModelMapping(
      runtimeConfig.documentCustomModel,
      previous.documentCustomModel,
      value.documentCustomModel,
    );
  }
  if (Object.keys(patch).length === 0) return;
  const request = ++configSaveRequest;
  void requestConfigPatch(patch, browser.runtime.sendMessage.bind(browser.runtime)).then(() => {
    if (request === configSaveRequest) configSaveError.value = '';
  }).catch(() => {
    if (request === configSaveRequest) configSaveError.value = '设置未能保存，请重新调整后再试。';
  });
}, {deep: true, flush: 'post'});

watch(parsedDocument, () => {
  if (isPdfDocument.value) void refreshPdfPreviews();
}, {flush: 'post'});

watch([translatedSegments, translating], () => {
  if (translating.value) return;
  settledTranslations.value = [...translatedSegments.value];
  if (isPdfDocument.value) schedulePdfPreview();
}, {deep: true});
watch(docxPartIndex, () => { readerPage.value = 1; });

function openFilePicker(): void {
  fileInput.value?.click();
}

async function loadSample(sample: typeof DOCUMENT_QUICK_SAMPLES[number]): Promise<void> {
  await loadFiles([new File([sample.content], sample.name, {type: 'text/plain;charset=utf-8'})]);
}

function showError(message: string): void {
  errorMessage.value = message;

}

async function loadFiles(files: File[]): Promise<void> {
  if (queueBusy.value || !files.length) return;
  const loadRequest = documentFileLoads.begin();
  openingFile.value = true;
  batchNotice.value = '';
  errorMessage.value = '';
  try {
    for (const file of files) {
      const item: DocumentQueueItem = {id: ++nextDocumentId, name: file.name, document: null,
        translations: [], fingerprint: '', state: 'ready', revision: 0, downloaded: 0, error: ''};
      try {
        if (!getDocumentFormat(file.name)) throw new Error('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件。');
        if (file.size > DOCUMENT_MAX_BYTES) throw new Error(`文件大小超过 ${maxFileSizeLabel}，请先拆分文件后再翻译。`);
        const parsed = await parseDocumentFile(file);
        if (!loadRequest.isCurrent()) return;
        if (!parsed.segments.length) throw new Error('文件中没有找到可翻译的文本片段。');
        item.document = markRaw(parsed);
      } catch (error) {
        if (!loadRequest.isCurrent()) return;
        item.error = error instanceof Error ? error.message : String(error);
      }
      documentQueue.value.push(item);
      if (item.error) queueExpanded.value = true;
      if (item.document && activeDocumentId.value === null) selectDocument(item);
    }
  } finally {
    if (loadRequest.isCurrent()) openingFile.value = false;
  }
}

function handleFileInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  void loadFiles(Array.from(input.files || []));
  input.value = '';
}

function handleDrop(event: DragEvent): void {
  isDragging.value = false;
  void loadFiles(Array.from(event.dataTransfer?.files || []));
}

function resetDocument(): void {
  downloadController?.abort();
  downloadController = null;
  cancelingDownload.value = false;
  downloadProgress.value = '';
  downloadDialog.value?.close();
  documentSettingsDialog.value?.close();
  downloadOpen.value = false;
  batchGeneration += 1;
  batchRunning.value = false;
  documentQueue.value = [];
  activeDocumentId.value = null;
  batchNotice.value = '';
  documentFileLoads.invalidate();
  translationRequestId += 1;
  abortController?.abort();
  abortController = null;
  translating.value = false;
  parsedDocument.value = null;
  translatedSegments.value = [];
  settledTranslations.value = [];
  taskFingerprint.value = '';
  runState.value = 'ready';
  editRevision.value = 0;
  downloadedRevision.value = 0;
  downloadNotice.value = '';
  errorMessage.value = '';
  openingFile.value = false;
  preparingDownload.value = false;
  pdfZoom.value = 1;
  epubChapterIndex.value = 0;
  docxPartIndex.value = 0;
  pdfPreviewLoading.value = false;
  pdfPreviewRequest += 1;
  if (pdfPreviewTimer) clearTimeout(pdfPreviewTimer);
  clearPdfPreviewUrls();
}

function changeDocument(): void {
  documentSettingsDialog.value?.close();
  requestReset();
}

function openDocumentSettings(): void {
  if (parsedDocument.value) documentSettingsDialog.value?.showModal();
}

function translateFromSettings(): void {
  documentSettingsDialog.value?.close();
  requestTranslation();
}

function requestReset(): void {
  if (openingFile.value || preparingDownload.value || batchRunning.value) return;
  if (hasUnsavedWork.value) {
    pendingAction.value = 'reset';
    confirmDialog.value?.showModal();
  } else resetDocument();
}

function requestTranslation(): void {
  if (!config.on || queueBusy.value) return;
  if (translationComplete.value || (settingsChanged.value && hasTranslation.value)) {
    pendingAction.value = 'restart';
    confirmDialog.value?.showModal();
  } else void startTranslation(settingsChanged.value);
}

function confirmAction(): void {
  const action = pendingAction.value;
  confirmDialog.value?.close();
  if (action === 'remove' && pendingRemoval) {
    removeDocument(pendingRemoval, true);
    pendingRemoval = null;
  } else if (action === 'reset') resetDocument();
  else if (action === 'restart') void startTranslation(true);
}

function pauseTranslation(): void {
  batchGeneration += 1;
  batchRunning.value = false;
  translationRequestId += 1;
  abortController?.abort();
  abortController = null;
  translating.value = false;
  runState.value = 'paused';
}

async function startTranslation(restart = false): Promise<void> {
  const document = parsedDocument.value;
  if (!config.on || !document || translating.value || !hydrated.value || preparingDownload.value || credentialWarning.value) return;
  if (restart) {
    translatedSegments.value = [];
    settledTranslations.value = [];
  }
  taskFingerprint.value = currentFingerprint.value;
  const glossaryIds = config.documentGlossaryIds === null ? null : [...config.documentGlossaryIds];
  const glossaryRevision = buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled);
  runState.value = 'ready';
  translating.value = true;
  errorMessage.value = '';
  downloadNotice.value = '';
  const controller = new AbortController();
  const requestId = ++translationRequestId;
  abortController = controller;
  try {
    await translateDocumentSegments(document.segments, {
      fileName: document.fileName,
      serviceOverride: effectiveDocumentService.value,
      modelOverride: documentUsesModel.value ? documentModelValue.value : undefined,
      sourceLanguage: config.from, targetLanguage: config.to,
      glossaryIds, glossaryRevision,
      initialTranslations: [...translatedSegments.value],
      signal: controller.signal,
      onSegment: ({id, translation}) => {
        if (requestId !== translationRequestId || parsedDocument.value !== document || controller.signal.aborted) return;
        translatedSegments.value[id] = translation;
        editRevision.value += 1;
      },
    });
  } catch (error) {
    if (requestId !== translationRequestId || parsedDocument.value !== document) return;
    if (error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED') {
      pauseTranslation();
      return;
    }
    runState.value = 'failed';
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    if (requestId === translationRequestId) {
      translating.value = false;
      if (abortController === controller) abortController = null;
    }
  }
}

function editSegment(index: number, value: string): void {
  if (queueBusy.value || !parsedDocument.value?.segments.some(segment => segment.id === index)) return;
  if (!taskFingerprint.value) taskFingerprint.value = currentFingerprint.value;
  translatedSegments.value[index] = value;
  editRevision.value += 1;
  downloadNotice.value = '';
}

function openDownload(): void {
  if (queueBusy.value || !hasTranslation.value) return;
  // 从正在阅读的译文/双语模式进入下载时采用同一内容；原文阅读保留上次选择。
  if (previewMode.value !== 'source') outputMode.value = previewMode.value;
  partialExportAcknowledged.value = false;
  downloadError.value = '';
  downloadProgress.value = '';
  downloadOpen.value = true;
  downloadDialog.value?.showModal();
}

function pdfExportProgress(progress: {phase: 'rendering' | 'saving'; completedPages: number; totalPages: number}): string {
  return progress.phase === 'saving' ? t('document.export.saving')
    : t('document.export.pages', {completed: progress.completedPages, total: progress.totalPages});
}

function cancelDownload(): void {
  if (!downloadController) return;
  cancelingDownload.value = true;
  downloadController.abort();
}

async function downloadDocument(): Promise<void> {
  const document = parsedDocument.value;
  if (!document || !hasTranslation.value || queueBusy.value || (!translationComplete.value && !partialExportAcknowledged.value)) return;
  preparingDownload.value = true;
  const controller = new AbortController();
  downloadController = controller;
  cancelingDownload.value = false;
  downloadProgress.value = '';
  downloadError.value = '';
  const revision = editRevision.value;
  const requestId = translationRequestId;
  try {
    const download = await createDocumentDownload(document, [...translatedSegments.value], outputMode.value, {
      signal: controller.signal,
      onPdfProgress: progress => { downloadProgress.value = pdfExportProgress(progress); },
    });
    controller.signal.throwIfAborted();
    if (document !== parsedDocument.value || requestId !== translationRequestId) return;
    const url = URL.createObjectURL(new Blob([download.data], {type: download.mimeType}));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = download.fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    downloadedRevision.value = revision;
    downloadNotice.value = '已生成下载文件，请在浏览器下载列表中查看。';
    downloadProgress.value = '';
    downloadDialog.value?.close();
  } catch (error) {
    if (document === parsedDocument.value) {
      downloadProgress.value = controller.signal.aborted ? t('document.export.canceled') : '';
      if (!controller.signal.aborted) downloadError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (downloadController === controller) {
      preparingDownload.value = false;
      cancelingDownload.value = false;
      downloadController = null;
    }
  }
}

function guardBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedWork.value && !preparingDownload.value) return;
  event.preventDefault();
  event.returnValue = '';
}

async function openGeneralSettings(): Promise<void> {
  await browser.tabs.create({url: `${browser.runtime.getURL('options.html')}#settings-general`});
}

async function openSettings(): Promise<void> {
  await browser.tabs.create({url: `${browser.runtime.getURL('options.html')}#settings-services`});
}

onMounted(() => {
  colorSchemeMedia.addEventListener?.('change', applyTheme);
  window.addEventListener('pagehide', resetDocument);
  window.addEventListener('beforeunload', guardBeforeUnload);
});

onUnmounted(() => {
  downloadController?.abort();
  downloadController = null;
  batchGeneration += 1;
  unsubscribeConfig?.();
  documentFileLoads.invalidate();
  translationRequestId += 1;
  abortController?.abort();
  if (pdfPreviewTimer) clearTimeout(pdfPreviewTimer);
  clearPdfPreviewUrls();
  colorSchemeMedia.removeEventListener?.('change', applyTheme);
  window.removeEventListener('pagehide', resetDocument);
  window.removeEventListener('beforeunload', guardBeforeUnload);
});
</script>

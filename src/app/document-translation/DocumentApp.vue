<!--
 @file src/app/document-translation/DocumentApp.vue
 文件职责：实现独立文档翻译页面的完整 Vue 应用，承载文件导入、格式化预览、分段翻译、人工校订和双语文件导出的用户流程。
 主要内容：相同译文保留原文且不重复展示；文档打开后按窗口宽度用一行或多行工具栏承载文件、阅读方式、页码缩放、翻译服务与目标语言、翻译与下载，窄窗口用翻译设置弹窗，矮小窗口用覆盖式侧栏保留正文高度；各种格式支持只缩放正文的触控板捏合与键盘操作，复用富文本预览并保持阅读位置；左侧可折叠的侧栏放文件列表与目录，其余空间留给正文；首页列出保存在本机的最近翻译，重新打开同一份文件时接着上次的译文继续；PDF 默认按原版排版左右对照，各种格式都从正在阅读的位置开始翻译；没有文字层的扫描版 PDF 在开始翻译时先逐页识别文字并显示进度；HTML、Markdown、纯文本与 ePub 的隔离预览只载入一次，译文逐段到达后原位更新并保留滚动位置，整篇译文几乎都与原文相同时状态里提示可换目标语言，带标题的文档（含 Word）在侧栏提供可按原文或译文显示的目录，Word 里的表格在阅读视图中仍按表格排版、只有一个部分时不显示部分切换，ePub 的全部章节列在侧栏目录里（按译文显示时用章内标题的译文）、当前章节下接着它其余的各级标题，正文上方不再占一行章节按钮，Word 与文本类预览在宽窗口左右对照；组织文档阅读与翻译、增量统计和人工校订；导入与在线下载绑定独立取消所有权；PDF 清晰阅读流式显示完整段落和原图区域，源页文字层与译文更新分离，下载按原版布局左右配对，长译文以完整批注保留；切换、删除、重置及卸载释放 PDF 任务和 URL；PDF/ePub/DOCX/ZIP 导出显示进度、支持取消重试，迟到结果不得回写。
 模块边界：组件负责页面交互与响应式状态，不自行解析二进制格式、不实现片段翻译队列、配置存储协议或导出编码；解析渲染来自 document-translation feature，配置协调来自 services/config，运行时适配由本目录 runtime 注入。
-->
<!-- 文档页面归 app 层所有；WXT 入口只负责启动。 -->
<template>
  <div class="document-app" :class="{ dark: isDark, 'is-workspace': parsedDocument, 'is-restoring': restoring && !parsedDocument, 'is-focus': parsedDocument && focusMode }">
    <!-- 专注阅读：隐藏工具栏与侧栏，只留下文档；指针移到顶部边缘或按 Esc 退出。 -->
    <button v-if="parsedDocument && focusMode" class="focus-exit" type="button" @click="setFocusMode(false)">{{ translateLegacy('退出专注阅读') }}<kbd>Esc</kbd></button>
    <header v-if="!parsedDocument && !restoring" class="document-header">
      <div class="document-brand" aria-label="流畅阅读文档翻译">
        <img src="/icon/128.png" alt="" />
        <span>
          <strong>流畅阅读</strong>
          <small>文档翻译</small>
        </span>
      </div>
      <div class="header-actions">
        <button class="header-settings" type="button" aria-label="打开翻译设置" @click="openSettings"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 2 3h3l1-3 3-1 2-3-2-2 1-3-3-2-2 1-2-3H9Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="11.5" cy="11" r="3" stroke="currentColor" stroke-width="1.4"/></svg><span>设置</span></button>
      </div>
    </header>

    <input ref="fileInput" class="visually-hidden" type="file" multiple :accept="accept" tabindex="-1" @change="handleFileInput" />
    <main class="document-main">
      <p v-if="hydrated && !config.on" class="notice" role="status" data-testid="document-translation-paused">{{ t('popup.heroDisabled') }} · <button type="button" @click="openGeneralSettings">通用设置</button></p>
      <!-- 打开文档后，文件与目录收进左侧可折叠的侧栏；未打开文档时这里只显示导入失败的文件。 -->
      <div class="document-layout">
      <aside v-show="!parsedDocument || sidebarOpen" class="document-sidebar" :aria-label="parsedDocument ? translateLegacy('文件与目录') : undefined">
        <div v-if="parsedDocument" class="sidebar-tabs" role="tablist">
          <button type="button" role="tab" :aria-selected="activeSidebarTab === 'files'" :class="{selected: activeSidebarTab === 'files'}" @click="sidebarTab = 'files'">{{ translateLegacy('文件') }}<small v-if="documentQueue.length > 1">{{ documentQueue.length }}</small></button>
          <button v-if="hasOutline" type="button" role="tab" :aria-selected="activeSidebarTab === 'outline'" :class="{selected: activeSidebarTab === 'outline'}" @click="sidebarTab = 'outline'">{{ t('document.pdfReading.outline') }}</button>
        </div>
      <section v-if="parsedDocument || documentQueue.length > 1 || documentQueue.some(item => item.error && !item.document)" v-show="!parsedDocument || activeSidebarTab === 'files'" class="document-batch" :aria-label="t('document.batch.queue')" :aria-busy="openingFile">
          <div class="batch-toolbar">
          <button class="batch-toggle" type="button" :aria-expanded="queueExpanded" aria-controls="document-queue-files" @click="queueExpanded = !queueExpanded"><strong>{{ t('document.batch.queue') }} · {{ documentQueue.length }}</strong><span aria-hidden="true">{{ queueExpanded ? '−' : '+' }}</span></button>
          <span class="batch-status" :class="{idle: !batchRunning && !openingFile}" role="status">{{ batchRunning ? t('document.batch.running') : openingFile ? t('document.batch.importing') : t('document.batch.completed', {count: batchCompletedCount}) }}</span>
          <button v-if="batchRunning" type="button" @click="pauseTranslation">{{ t('document.batch.pause') }}</button>
          <button v-else-if="batchPendingCount && (!parsedDocument || documentQueue.length > 1)" class="batch-start" type="button" :disabled="!config.on || queueBusy || !hydrated || Boolean(credentialWarning)" @click="startBatch">{{ t('document.batch.start') }}</button>
          <span v-if="!queueExpanded && documentQueue.some(item => !item.document)" class="queue-error">有文件导入失败，请展开查看</span>
          <label v-if="(queueExpanded || (parsedDocument && documentQueue.length > 1)) && batchCompletedCount">{{ t('document.batch.output') }}<ElSelect class="batch-output" v-model="outputMode" :disabled="queueBusy" :aria-label="t('document.batch.output')" append-to=".document-app"><ElOption value="bilingual" :label="translateLegacy('双语')" /><ElOption value="translated" :label="translateLegacy('仅译文')" /></ElSelect></label>
          <button v-if="(queueExpanded || (parsedDocument && documentQueue.length > 1)) && batchCompletedCount" type="button" :disabled="queueBusy" @click="downloadBatch">{{ t('document.batch.zip') }}</button>
          <button v-if="preparingDownload && !downloadOpen" type="button" :disabled="cancelingDownload" @click="cancelDownload">{{ t(cancelingDownload ? 'document.export.canceling' : 'document.export.cancel') }}</button>
        </div>
        <ul v-show="queueExpanded" id="document-queue-files" class="batch-files">
            <li v-for="item in documentQueue" :key="item.id" :class="{ selected: item.id === activeDocumentId }">
              <button class="batch-file" type="button" :disabled="queueBusy || !item.document" :aria-pressed="item.id === activeDocumentId" @click="selectDocument(item)">
                <span data-i18n-ignore :title="item.name">{{ item.name }}</span><small>{{ queueStatus(item) }}</small>
              <i v-if="item.document?.segments.length" class="batch-progress" aria-hidden="true"><b :style="{width: `${queueProgress(item)}%`}" /></i>
            </button>
              <button class="batch-remove" type="button" :disabled="queueBusy" :aria-label="`${t('document.batch.remove')} ${item.name}`" :title="t('document.batch.remove')" @click="removeDocument(item)">{{ t('document.batch.remove') }}</button>
              <p v-if="item.error" class="notice error" role="alert" data-i18n-ignore>{{ item.error }}</p>
            </li>
          </ul>
          <button v-if="parsedDocument" class="ghost-button sidebar-add-file" type="button" :disabled="queueBusy" @click="openFilePicker">添加文件</button>
          <p v-if="batchNotice" class="notice" role="status">{{ batchNotice }}</p>
        </section>
        <div v-if="parsedDocument" v-show="activeSidebarTab === 'outline' && isPdfDocument" ref="outlineHost" class="sidebar-outline" />
        <nav v-if="parsedDocument && !isPdfDocument && outlineRows.length" v-show="activeSidebarTab === 'outline'" class="sidebar-outline document-outline" :aria-label="t('document.pdfReading.outline')">
          <div class="document-outline-language" role="group" :aria-label="t('document.pdfReading.outline')">
            <button type="button" :class="{selected: richOutlineLanguage === 'source'}" :aria-pressed="richOutlineLanguage === 'source'" @click="richOutlineLanguage = 'source'">{{ t('document.pdfReading.original') }}</button>
            <button type="button" :class="{selected: richOutlineLanguage === 'translated'}" :aria-pressed="richOutlineLanguage === 'translated'" @click="richOutlineLanguage = 'translated'">{{ t('document.pdfReading.translated') }}</button>
          </div>
          <button v-for="row in outlineRows" :key="row.key" type="button" class="document-outline-item" :class="{chapter: row.chapter !== undefined, current: row.current}" :aria-current="row.current ? 'location' : undefined" :style="{paddingLeft: `${12 + (row.level - 1) * 14}px`}" :title="row.title" data-i18n-ignore @click="row.item ? jumpOutline(row.item) : epubChapterIndex = row.chapter!">{{ row.label }}</button>
        </nav>
        <button v-if="parsedDocument" class="document-settings-button" type="button" aria-label="调整文档翻译设置" @click="openDocumentSettings"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 2 3h3l1-3 3-1 2-3-2-2 1-3-3-2-2 1-2-3H9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="11.5" cy="11" r="3" stroke="currentColor" stroke-width="1.5"/></svg><strong>{{ translateLegacy('源语言与术语库') }}</strong><span data-i18n-ignore>{{ translationSettingsSummary }}</span><small>调整设置</small></button>
      </aside>
      <div class="document-content">
      <section v-if="!parsedDocument && restoring" class="restoring-section" role="status" aria-live="polite"><i class="spinner dark-spinner" aria-hidden="true" /></section>
      <section v-else-if="!parsedDocument" class="landing-section">
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
          <h2>{{ openingFile || downloadingPdf ? '正在整理文档' : '把文件拖到这里' }}</h2>
          <p class="upload-description">{{ openingFile || downloadingPdf ? importProgress || '解析完成后，即可确认语言并开始翻译' : t('document.batch.pickMany') }}</p>
          <button v-show="!openingFile && !downloadingPdf" class="open-file-button" type="button" :disabled="queueBusy" @click.stop="openFilePicker">
            {{ openingFile ? '正在解析文件…' : '选择文件' }}
          </button>
          <!-- 导入中用进度条代替按钮；取消是次要操作，只留一个文字链接。 -->
          <div v-if="openingFile || downloadingPdf" class="import-progress" :class="{indeterminate: !importRatio}" role="progressbar" :aria-valuenow="Math.round(importRatio * 100)" aria-valuemin="0" aria-valuemax="100"><i :style="{width: `${Math.max(4, importRatio * 100)}%`}" /></div>
          <button v-if="openingFile || downloadingPdf" class="import-cancel" type="button" @click.stop="cancelImport">{{ t('document.pdfReading.cancelImport') }}</button>
          <small>{{ t('document.fileLimitNote', {size: maxFileSizeLabel}) }}</small>
        </div>

        <form class="online-pdf-form" @submit.prevent="openOnlinePdf">
          <label for="online-pdf-url">{{ t('document.pdfReading.onlineLabel') }}</label>
          <div><input id="online-pdf-url" v-model="onlinePdfUrl" type="url" inputmode="url" required placeholder="https://arxiv.org/pdf/1706.03762" :disabled="queueBusy" /><button class="ghost-button" type="submit" :disabled="queueBusy">{{ t('document.pdfReading.openOnline') }}</button></div>
          <small>{{ t('document.pdfReading.onlineHint') }}</small>
        </form>
        <section v-if="historyEntries.length" class="document-history" aria-label="最近翻译">
          <header><h2>最近翻译</h2><button type="button" :disabled="queueBusy" @click="clearHistory">清空记录</button></header>
          <ul>
            <li v-for="entry in historyEntries" :key="entry.id">
              <button class="history-open" type="button" :disabled="queueBusy" @click="openHistory(entry)">
                <b>{{ historyFormat(entry) }}</b>
                <span><strong data-i18n-ignore :title="entry.name">{{ entry.name }}</strong><small>{{ historyStatus(entry) }}</small></span>
              </button>
              <button class="history-remove" type="button" :disabled="queueBusy" :aria-label="`移除记录 ${entry.name}`" title="移除记录" @click="removeHistory(entry)">×</button>
            </li>
          </ul>
        </section>
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
        <section class="document-taskbar" :class="{'has-pdf-controls': readerTab === 'read' && isPdfDocument}" aria-label="当前文档与翻译任务">
          <div class="workspace-heading">
            <button class="sidebar-toggle" type="button" :class="{active: sidebarOpen}" :aria-expanded="sidebarOpen" :aria-label="translateLegacy('文件与目录')" :title="translateLegacy('文件与目录')" @click="sidebarOpen = !sidebarOpen"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M7.5 3.5v13" stroke="currentColor" stroke-width="1.4"/></svg><small v-if="documentQueue.length > 1">{{ documentQueue.length }}</small></button>
            <img class="taskbar-logo" src="/icon/128.png" alt="" />
            <div class="file-heading"><div><h1 data-i18n-ignore :title="parsedDocument.fileName">{{ parsedDocument.fileName }}</h1><p class="document-status" role="status">{{ statusLabel }}<span v-if="hasTranslation"> · {{ completedSegments }} / {{ parsedDocument.segments.length }}</span></p></div></div>
          </div>
          <div class="reader-toolbar">
            <div class="mode-buttons reader-tabs" role="group" aria-label="文档工作区">
              <button type="button" :class="{ selected: readerTab === 'read' }" :aria-pressed="readerTab === 'read'" @click="readerTab = 'read'">阅读</button>
              <button type="button" :class="{ selected: readerTab === 'edit' }" :aria-pressed="readerTab === 'edit'" @click="readerTab = 'edit'">校订译文</button>
            </div>
            <div class="reader-reading-controls">
            <div v-if="readerTab === 'read'" class="mode-buttons" role="group" aria-label="阅读方式">
              <button v-for="mode in readingModes" :key="mode.value" type="button" :class="{ selected: effectivePreviewMode === mode.value }" :aria-pressed="effectivePreviewMode === mode.value" :disabled="!canCompare && mode.value !== 'source'" @click="previewMode = mode.value">{{ mode.label }}</button>
            </div>
            <!-- PDF 的页码、缩放和显示方式由阅读器传送到这里，随阅读功能组响应式分行。 -->
            <div v-show="readerTab === 'read' && isPdfDocument" ref="readerControls" class="reader-controls-slot" />
            <div v-if="readerTab === 'read' && !isPdfDocument" class="document-zoom-control" role="group" :aria-label="t('document.readerZoom.label')">
              <button type="button" :disabled="readerScale <= .5" :aria-label="t('document.pdfReading.zoomOut')" :title="t('document.pdfReading.zoomOut')" @click="stepReaderZoom(-1)">−</button>
              <button type="button" class="document-zoom-reset" data-document-zoom :aria-label="t('document.readerZoom.reset')" :title="t('document.readerZoom.hint')" @click="resetReaderZoom">{{ Math.round(readerScale * 100) }}%</button>
              <button type="button" :disabled="readerScale >= 3" :aria-label="t('document.pdfReading.zoomIn')" :title="t('document.pdfReading.zoomIn')" @click="stepReaderZoom(1)">+</button>
            </div>
            <button class="focus-toggle" type="button" :aria-label="translateLegacy('专注阅读')" :title="translateLegacy('专注阅读')" @click="setFocusMode(true)"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7.5 3.5h-4v4M12.5 3.5h4v4M7.5 16.5h-4v-4M12.5 16.5h4v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            </div>
          </div>
          <div class="taskbar-actions">
            <!-- 宽窗口直接在工具栏选择服务、模型与目标语言，窄窗口打开既有翻译设置弹窗；源语言和术语库在侧栏底部的“调整设置”里。 -->
            <div class="toolbar-translation-settings">
            <label class="toolbar-field"><span>翻译服务</span><ElSelect class="document-select toolbar-select toolbar-service" :wrap-label="false" :show-search-icon="false" append-to=".document-app" v-model="config.documentService" :empty-values="[null, undefined]" :disabled="queueBusy" aria-label="翻译服务" filterable>
              <ElOption :label="followDefaultLabel" value="" />
              <ElOption v-if="config.documentService && documentServiceUnavailableMessage" :value="config.documentService" disabled :label="translateLegacy('Chrome内置AI翻译（当前浏览器不可用）')" />
              <ElOption v-for="item in serviceOptions" :key="item.value" :value="item.value" :label="translateLegacy(item.label)" />
            </ElSelect></label>
            <label class="toolbar-field"><span>目标语言</span><ElSelect class="document-select toolbar-select toolbar-language" :wrap-label="false" :show-search-icon="false" append-to=".document-app" v-model="config.to" :disabled="queueBusy" aria-label="目标语言" filterable>
              <ElOption v-for="item in options.to" :key="item.value" :value="item.value" :label="translateLegacy(item.label)" />
            </ElSelect></label>
            <label v-if="documentUsesModel" class="toolbar-field"><span>模型</span><ElSelect class="document-select toolbar-select toolbar-model" :wrap-label="false" :show-search-icon="false" append-to=".document-app" v-model="selectedDocumentModel" :disabled="queueBusy" aria-label="模型" filterable>
              <ElOption v-for="model in documentModelOptions" :key="model" :value="model" data-i18n-ignore :label="model" />
            </ElSelect></label>
            </div>
            <div class="toolbar-primary-actions">
            <button class="ghost-button toolbar-settings-toggle" type="button" :title="translationSettingsSummary" @click="openDocumentSettings">{{ translateLegacy('翻译设置') }}</button>
            <button class="download-button" type="button" :disabled="!hasTranslation || queueBusy" @click="openDownload">下载文件 ↓</button>
            <div class="translation-actions">
              <button v-if="translating" class="ghost-button pause-button" type="button" @click="pauseTranslation"><i class="spinner dark-spinner" aria-hidden="true" />暂停翻译</button>
              <button v-else-if="(parsedDocument.segments.length || needsOcr) && (!translationComplete || settingsChanged)" class="translate-document-button" type="button" :disabled="!config.on || !hydrated || queueBusy || Boolean(credentialWarning)" @click="requestTranslation">{{ translationActionLabel }}</button>
            </div>
            </div>
          </div>
          <div class="task-progress" :class="{ complete: translationComplete }" role="progressbar" aria-label="文档翻译进度" :aria-valuenow="progress" :aria-valuemin="0" :aria-valuemax="100"><i :style="{width: `${progress}%`}" /></div>
          <!-- 提示统一浮在工具栏下方，出现和消失都不改变版面高度。 -->
          <div class="taskbar-notices">
          <p v-if="openingFile || downloadingPdf" class="document-import-progress" role="status">{{ importProgress }} <button class="ghost-button" type="button" @click="cancelImport">{{ t('document.pdfReading.cancelImport') }}</button></p>
          <p v-if="errorMessage || credentialWarning || configSaveError" class="notice error task-notice" role="alert">{{ errorMessage || credentialWarning || configSaveError }} <button v-if="credentialWarning || configSaveError" type="button" @click="documentSettingsDialog?.showModal()">调整设置</button></p>
          <p v-if="settingsChanged" class="notice warning task-notice">设置已更改。现有译文保留，按新设置翻译会从头开始。</p>
          <p v-if="retryNotice" class="notice warning task-notice" role="status" data-i18n-ignore>{{ retryNotice }}</p>
          <p v-if="downloadNotice" class="taskbar-toast" role="status">{{ downloadNotice }}</p>
          </div>
        </section>
        <article class="document-reading-pane" aria-label="文档内容">
        <DocumentSegmentEditor :key="activeDocumentId ?? 0" v-show="readerTab === 'edit'" :document="parsedDocument" :translations="translatedSegments" :disabled="queueBusy" @update="editSegment" />
        <div v-show="readerTab === 'read'" ref="readingContent" class="reading-content" :class="{'reading-pdf': isPdfDocument}" :data-reader-zoom="isPdfDocument ? undefined : readerScale" :tabindex="isPdfDocument || isRichDocument ? undefined : 0" @pointerdown="focusNativeReader">
        <PdfReader
          v-if="isPdfDocument"
          :key="activeDocumentId ?? 0"
          :document="parsedDocument"
          :translations="translatedSegments"
          v-model:presentation="pdfPresentation"
          :mode="effectivePreviewMode"
          :translating="translating"
          :loading-style="config.translationLoadingStyle"
          :animated="config.animations"
          :controls-target="readerControls"
          :outline-target="outlineHost"
          :source-url="documentQueue.find(item => item.id === activeDocumentId)?.sourceUrl"
          @page-change="pdfPage = $event"
          :information-highlight="{preferences: config.informationHighlight, scoreLocal: scoreDocumentInformation, available: config.on && hydrated && readerTab === 'read'}"
        />

        <section
          v-else-if="isRichDocument"
          class="rich-document-reader"
          :class="`reader-${parsedDocument.format}`"
          data-document-reader="rich"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="排版文档双语阅读预览"
        >
          <iframe
            ref="richFrame"
            class="rich-preview-frame"
            :srcdoc="richFrameHtml"
            sandbox="allow-same-origin"
            @load="handleRichFrameLoad"
            :title="t('document.layoutPreview', {format: parsedDocument.label})"
          />
        </section>

        <section
          v-else-if="isDocxDocument"
          class="docx-document-reader"
          :class="{bilingual: effectivePreviewMode === 'bilingual'}"
          data-document-reader="docx"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="Word 文档页面预览"
        >
          <nav v-if="docxParts.length > 1" class="reader-native-toolbar" aria-label="Word 文档部分">
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
            <article class="docx-page" :style="readerZoomStyle">
              <span v-if="docxParts.length > 1" class="docx-page-label">{{ docxPartLabel(currentDocxPart?.path || '') }}</span>
              <template v-for="block in currentDocxBlocks" :key="block.key">
                <table v-if="block.table" class="docx-table">
                  <tbody>
                    <tr v-for="(cells, rowIndex) in block.table" :key="rowIndex">
                      <td v-for="(cell, cellIndex) in cells" :key="cellIndex">
                        <section v-for="row in cell" :key="row.index" class="docx-paragraph" :class="`docx-role-${row.role || 'paragraph'}`" :data-segment="row.index">
                          <p v-if="docxShowsSource(row)" class="docx-source document-source" data-i18n-ignore>{{ row.source }}</p>
                          <p v-if="docxShowsTranslation(row)" class="docx-translation document-translation" data-i18n-ignore>{{ row.translation || translateLegacy('等待翻译…') }}</p>
                        </section>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <section v-else class="docx-paragraph" :class="`docx-role-${block.row.role || 'paragraph'}`" :data-segment="block.row.index">
                  <p v-if="docxShowsSource(block.row)" class="docx-source document-source" data-i18n-ignore>{{ block.row.source }}</p>
                  <p v-if="docxShowsTranslation(block.row)" class="docx-translation document-translation" data-i18n-ignore>{{ block.row.translation || translateLegacy('等待翻译…') }}</p>
                </section>
              </template>
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
            <table :style="readerZoomStyle" data-native-zoom-content>
              <thead><tr><th>#</th><th>时间范围</th><th v-if="effectivePreviewMode !== 'translated'">原文</th><th v-if="effectivePreviewMode !== 'source'">译文</th></tr></thead>
              <tbody>
                <tr v-for="row in subtitleRows" :key="row.index">
                  <td class="subtitle-index">{{ row.index + 1 }}</td>
                  <td class="subtitle-timing"><time>{{ row.timeStart || '—' }}</time><span aria-hidden="true"> → </span><time>{{ row.timeEnd || '—' }}</time></td>
                  <td v-if="effectivePreviewMode !== 'translated' || (row.translation && !hasDistinctTranslation(readerText(row.source), readerText(row.translation)))" :colspan="effectivePreviewMode === 'bilingual' && row.translation && !hasDistinctTranslation(readerText(row.source), readerText(row.translation)) ? 2 : 1"><p class="subtitle-source document-source" data-i18n-ignore>{{ readerText(row.source) }}</p></td>
                  <td v-if="effectivePreviewMode !== 'source' && (!row.translation || hasDistinctTranslation(readerText(row.source), readerText(row.translation)))">
                    <p class="subtitle-translation document-translation" data-i18n-ignore>{{ row.translation ? readerText(row.translation) : translateLegacy('等待翻译…') }}</p>
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
          <div :style="readerZoomStyle" data-native-zoom-content>
          <div class="json-table-header" :class="{ single: effectivePreviewMode !== 'bilingual' }"><span>JSONPath</span><span v-if="effectivePreviewMode !== 'translated'">原字符串</span><span v-if="effectivePreviewMode !== 'source'">译文</span></div>
          <article v-for="row in jsonRows" :key="row.index" class="json-table-row" :class="{ single: effectivePreviewMode !== 'bilingual' || (row.translation && !hasDistinctTranslation(row.source, row.translation)) }">
            <code>{{ row.pathLabel || '$' }}</code>
            <p v-if="effectivePreviewMode !== 'translated' || (row.translation && !hasDistinctTranslation(row.source, row.translation))" class="json-source document-source" data-i18n-ignore>{{ row.source }}</p>
            <p v-if="effectivePreviewMode !== 'source' && (!row.translation || hasDistinctTranslation(row.source, row.translation))" class="json-translation document-translation" data-i18n-ignore>{{ row.translation || translateLegacy('等待翻译…') }}</p>
          </article>
          </div>
        </section>

        <div v-else class="document-reader" data-document-reader="generic" :data-segment-count="parsedDocument.segments.length" :class="`reader-${parsedDocument.format}`" :style="readerZoomStyle" data-native-zoom-content aria-label="文档双语阅读预览">
          <article v-for="row in previewRows" :key="row.index" class="reader-block">
            <span v-if="row.contextLabel" class="reader-context">{{ row.contextLabel }}</span>
            <div v-if="effectivePreviewMode !== 'translated' || (row.translation && !hasDistinctTranslation(row.source, row.translation))" class="reader-source document-source" data-i18n-ignore :class="readerSourceClass(row.source)">
              {{ readerText(row.source) }}
            </div>
            <p v-if="effectivePreviewMode !== 'source' && (!row.translation || hasDistinctTranslation(row.source, row.translation))" class="reader-translation document-translation" data-i18n-ignore>{{ row.translation ? readerText(row.translation) : translateLegacy('等待翻译…') }}</p>
          </article>
        </div>
        <p v-if="!hasTranslation && !isPdfDocument" class="reader-empty">
          {{ emptyReaderHint }}
        </p>
        <nav v-if="readerPageCount > 1" class="reader-pagination" aria-label="文档阅读分页"><button type="button" :disabled="readerPage === 1" @click="readerPage--">上一页</button><span>第 {{ readerPage }} / {{ readerPageCount }} 页</span><button type="button" :disabled="readerPage === readerPageCount" @click="readerPage++">下一页</button></nav>
        </div>
        </article>
      </section>
      </div>
      </div>
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
        <label class="document-batch-translation"><input v-model="documentBatchTranslation" type="checkbox" :disabled="queueBusy" /><span><strong>{{ t('document.batchTranslation.label') }}</strong><small>{{ t('document.batchTranslation.hint') }}</small></span></label>
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
    <dialog ref="confirmDialog" class="document-dialog" aria-labelledby="confirm-document-heading" @close="clearConfirmation">
      <h2 id="confirm-document-heading">{{ pendingAction === 'remove' ? t('document.batch.removeTitle') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clearTitle') : '打开另一份文档？') : '重新翻译这份文档？' }}</h2>
      <p>{{ pendingAction === 'remove' ? t('document.batch.removeWarning') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clearWarning') : '当前翻译和校订结果只保留在本页，离开后无法恢复。建议先下载需要的结果。') : '重新翻译会替换现有译文和人工校订。你也可以返回并先下载当前结果。' }}</p>
      <div class="dialog-actions"><button class="ghost-button" type="button" autofocus @click="confirmDialog?.close()">返回文档</button><button class="translate-document-button" type="button" @click="confirmAction">{{ pendingAction === 'remove' ? t('document.batch.remove') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clear') : '打开新文件') : '重新翻译' }}</button></div>
    </dialog>
    <dialog ref="downloadDialog" class="document-dialog download-dialog" aria-labelledby="download-document-heading" :aria-busy="preparingDownload" @close="downloadOpen = false" @cancel="preparingDownload && $event.preventDefault()">
      <h2 id="download-document-heading">下载翻译结果</h2><p>按原格式另存一份文件。下载内容包含你的校订。</p>
      <div class="export-options" role="group" aria-label="下载内容">
        <button type="button" :disabled="queueBusy" :aria-pressed="outputMode === 'bilingual'" :class="{ selected: outputMode === 'bilingual' }" @click="outputMode = 'bilingual'"><strong>双语对照</strong><span>{{ isPdfDocument ? t('document.pdfReading.exportBilingualHint') : '同时保留原文和译文' }}</span></button>
        <button type="button" :disabled="queueBusy" :aria-pressed="outputMode === 'translated'" :class="{ selected: outputMode === 'translated' }" @click="outputMode = 'translated'"><strong>仅译文</strong><span>适合直接阅读和分享</span></button>
      </div>
      <p class="export-file-name" data-i18n-ignore>{{ downloadFileName }}</p>
      <section v-if="downloadOpen && isPdfDocument" class="pdf-export-summary" :aria-label="t('document.pdfReading.layoutPresentation')">
        <div class="pdf-export-page-pair" :class="{single: outputMode === 'translated'}" aria-hidden="true"><div v-if="outputMode === 'bilingual'" class="pdf-export-page"><span>{{ t('document.pdfReading.original') }}</span><i /><i /><i /><i /></div><div class="pdf-export-page translated"><span>{{ t('document.pdfReading.translated') }}</span><i /><i /><i /><i /></div></div>
        <div><strong>{{ outputMode === 'bilingual' ? t('document.pdfReading.exportBilingualHint') : t('document.pdfReading.layoutPresentation') }}</strong><p>{{ t('document.pdfReading.exportPageCount', {count: pdfExportPageCount}) }}</p></div>
      </section>
      <section v-else-if="downloadOpen" class="export-preview" aria-label="文件内容预览">
        <strong>{{ parsedDocument && isDocumentExportExcerpt(parsedDocument) ? '文字摘录 · 下载时保留原文件格式' : '文件内容预览' }}</strong><pre data-i18n-ignore>{{ downloadPreview }}</pre>
      </section>
      <p v-if="!translationComplete" class="notice warning">{{ t("document.untranslatedWarning", {count: (parsedDocument?.segments.length || 0) - completedSegments}) }}</p>
      <label v-if="!translationComplete" class="partial-export"><input v-model="partialExportAcknowledged" type="checkbox" :disabled="queueBusy" />我已了解，下载当前结果</label>
      <p v-if="settingsChanged" class="notice warning">设置已更改，本次下载仍是当前保留的译文。</p>
      <p v-if="isSubtitleDocument" class="export-note">保留字幕序号和时间轴。仅译文替换字幕文字，双语在同一时间段内保留原文和译文。</p>
      <p v-if="isPdfDocument" class="export-note">{{ t('document.pdfReading.exportHint') }}</p>
      <div v-if="downloadProgress" class="export-progress"><p class="notice" role="status" aria-live="polite">{{ downloadProgress }}</p><progress v-if="downloadPdfProgress" :value="downloadPdfProgress.phase === 'rendering' ? downloadPdfProgress.completedPages : undefined" :max="downloadPdfProgress.totalPages || 1" :aria-label="downloadProgress" /></div>
      <p v-if="downloadError" class="notice error" role="alert">{{ downloadError }}</p>
      <div class="dialog-actions"><button v-if="preparingDownload" class="ghost-button" type="button" :disabled="cancelingDownload" @click="cancelDownload">{{ t(cancelingDownload ? 'document.export.canceling' : 'document.export.cancel') }}</button><button v-else class="ghost-button" type="button" :disabled="queueBusy" @click="downloadDialog?.close()">返回文档</button><button class="translate-document-button" type="button" :disabled="queueBusy || !hasTranslation || (!translationComplete && !partialExportAcknowledged)" @click="downloadDocument">{{ preparingDownload ? '正在生成文件…' : `下载${outputMode === 'bilingual' ? '双语' : '译文'}文件` }}</button></div>
    </dialog>
    <footer v-if="!parsedDocument && !restoring" class="document-footer">
      <span>让语言更近，让世界更大。</span>
      <a href="https://github.com/Bistutu/FluentRead" target="_blank" rel="noreferrer">开源项目 ↗</a>
    </footer>
  </div>
</template>

<script lang="ts" setup>

import {ElOption} from 'element-plus';
import 'element-plus/es/components/select/style/css';
import {markRaw, computed, nextTick, onMounted, onUnmounted, reactive, ref, toRaw, watch} from 'vue';
import DocumentSegmentEditor from './DocumentSegmentEditor.vue';
import browser from 'webextension-polyfill';
import {
  Config,
  PdfReader,
  syncRichPreview,
  richPreviewInterval,
  collectRichOutline,
  scrollRichOutline,
  markRichPreviewBusy,
  richPreviewPosition,
  installDocumentZoomGestures,
  pdfPagesNeedingOcr,
  recognizePdfDocument,
  type RichOutlineItem,
  type PdfExportProgress,
  scoreDocumentInformation,
  hasDistinctTranslation,
  TranslationRequestError,
  buildGlossaryRevision,
  DOCUMENT_MAX_BYTES,
  PDF_MAX_BYTES,
  getDocumentMaxBytes,
  DOCUMENT_QUICK_SAMPLES,
  createDocumentDownload,
  createPdfPageRecognizer,
  documentRetryBackoff,
  generateDocumentArchive,
  createDocumentDownloadName,
  createDocumentFileLoadGuard,
  createDocumentHistory,
  documentHistoryId,
  restoreDocumentHistoryTranslations,
  createDocumentPreviewHtml,
  fetchOnlinePdf,
  readPdfSourceFragment,
  releasePdfDocument,
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
  isDocumentExportExcerpt,
  isSubtitleDocumentFormat,
  customModelString,
  configReady,
  models,
  options,
  parseDocument,
  restoreSubtitleTags,
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
  type DocumentHistorySummary,
  type PdfReadingPresentation,
  type ParsedDocument,
  ElSelect,
} from '@/src/app/document-translation';

const READER_PAGE_SIZE = 80;

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
const pdfPresentation = ref<PdfReadingPresentation>('layout');
const readerControls = ref<HTMLElement | null>(null);
const outlineHost = ref<HTMLElement | null>(null);
// 侧栏默认展开，PDF 先显示目录、其他格式显示文件；添加第二份文件或导入失败时切到文件页。
const sidebarOpen = ref(true);
// 专注阅读隐藏本页的全部控件，并尽量让浏览器进入全屏；退出全屏或按 Esc 即恢复。
const focusMode = ref(false);
function setFocusMode(value: boolean): void {
  focusMode.value = value;
  try {
    if (value) void window.document.documentElement.requestFullscreen?.()?.catch?.(() => undefined);
    else if (window.document.fullscreenElement) void window.document.exitFullscreen?.()?.catch?.(() => undefined);
  } catch { /* 浏览器不允许全屏时仍然隐藏控件。 */ }
}
function leaveFocusOnEscape(event: KeyboardEvent): void {if (event.key === 'Escape' && focusMode.value) setFocusMode(false);}
function leaveFocusWithFullscreen(): void {if (!window.document.fullscreenElement && focusMode.value) focusMode.value = false;}
const sidebarTab = ref<'files' | 'outline'>('outline');
const recognitionProgress = ref('');
const richOutline = ref<RichOutlineItem[]>([]);
const richOutlineLanguage = ref<'source' | 'translated'>('translated');
const pdfPage = ref(1);
const readerTab = ref<'read' | 'edit'>('read');
const readingContent = ref<HTMLElement | null>(null);
const readerScale = ref(1);
const readerZoomStyle = computed(() => ({zoom: String(readerScale.value)}));
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
let downloadNoticeTimer: ReturnType<typeof setTimeout> | undefined;
const editRevision = ref(0);
const downloadedRevision = ref(0);
const readingModes = [{value: 'source', label: '原文'}, {value: 'bilingual', label: '双语'}, {value: 'translated', label: '译文'}] as const;
const isDragging = ref(false);
const translating = ref(false);
const liveCompletedSegments = ref(0);

const errorMessage = ref('');
const retryNotice = ref('');
const openingFile = ref(false);
const preparingDownload = ref(false);
const cancelingDownload = ref(false);
const downloadProgress = ref('');
const downloadPdfProgress = ref<PdfExportProgress | null>(null);
let downloadController: AbortController | null = null;
const onlinePdfUrl = ref('');
const downloadingPdf = ref(false);
const importProgress = ref('');
/** 导入进度 0–1：下载按字节、解析按页；未知时为 0，进度条显示为往复动画。 */
const importRatio = ref(0);
let onlinePdfController: AbortController | null = null;
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
let fileLoadController: AbortController | null = null;
let disposed = false;
const downloadUrls = new Map<string, ReturnType<typeof setTimeout>>();

interface DocumentQueueItem {
  id: number;
  name: string;
  /** 原始文件内容的摘要与字节，仅在浏览器支持本地历史时保留，用于“最近翻译”。 */
  historyId?: string;
  bytes?: Uint8Array;
  mimeType?: string;
  /** 已写入本地历史的修订号，避免没有变化时重复保存。 */
  savedRevision?: number;
  sourceUrl?: string;
  document: ParsedDocument | null;
  translations: string[];
  fingerprint: string;
  state: 'ready' | 'paused' | 'failed';
  revision: number;
  downloaded: number;
  error: string;
  /** 仅在本页为这份文档保留批量选择，不写入全局配置或本地历史。 */
  batchTranslation?: boolean;
}
const documentBatchTranslation = ref(true);
const documentQueue = ref<DocumentQueueItem[]>([]);
const activeDocumentId = ref<number | null>(null);
const batchRunning = ref(false);
const batchNotice = ref('');
let nextDocumentId = 0;
let batchGeneration = 0;
const queueBusy = computed(() => translating.value || batchRunning.value || openingFile.value || downloadingPdf.value || preparingDownload.value);
const completeItem = (item: DocumentQueueItem) => Boolean(item.document && item.document.segments.every(segment => item.translations[segment.id]?.trim()));
const batchCompletedCount = computed(() => documentQueue.value.filter(item => item.id === activeDocumentId.value ? translationComplete.value : completeItem(item)).length);
const batchPendingCount = computed(() => documentQueue.value.filter(item => item.document && !(item.id === activeDocumentId.value ? translationComplete.value : completeItem(item))).length);

function saveActiveDocument(): void {
  const item = documentQueue.value.find(item => item.id === activeDocumentId.value);
  if (!item) return;
  Object.assign(item, {translations: [...translatedSegments.value], fingerprint: taskFingerprint.value,
    state: runState.value, revision: editRevision.value, downloaded: downloadedRevision.value, error: errorMessage.value, batchTranslation: documentBatchTranslation.value});
}

function selectDocument(item: DocumentQueueItem): void {
  if (!item.document || item.id === activeDocumentId.value) return;
  saveActiveDocument();
  releaseDocumentPreview(parsedDocument.value);
  activeDocumentId.value = item.id;
  documentBatchTranslation.value = item.batchTranslation !== false;
  rememberOpenDocument(item.historyId);
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
}

function queueProgress(item: DocumentQueueItem): number {
  if (item.id === activeDocumentId.value) return progress.value;
  const total = item.document?.segments.length || 0;
  return total ? Math.floor(item.translations.filter(text => text?.trim()).length / total * 100) : 0;
}

// 最近翻译：只在浏览器提供 IndexedDB 时启用；记录留在本机，重新打开同一份文件会接着上次的译文继续。
const historyAvailable = typeof indexedDB !== 'undefined';
const history = createDocumentHistory();
const historyEntries = ref<DocumentHistorySummary[]>([]);
let historyTimer: ReturnType<typeof setTimeout> | undefined;
async function refreshHistory(): Promise<void> {
  if (!historyAvailable) return;
  const entries = await history.list();
  if (!disposed) historyEntries.value = entries;
}
function persistHistory(): void {
  if (historyTimer !== undefined) {clearTimeout(historyTimer); historyTimer = undefined;}
  if (!historyAvailable) return;
  saveActiveDocument();
  for (const item of documentQueue.value) {
    const completed = item.translations.filter(text => text?.trim()).length;
    if (!item.document || !item.historyId || !item.bytes || item.revision === item.savedRevision) continue;
    item.savedRevision = item.revision;
    void history.save({id: item.historyId, name: item.name, format: item.document.format, size: item.bytes.byteLength, sourceUrl: item.sourceUrl, mimeType: item.mimeType || '',
      total: item.document.segments.length, completed, updatedAt: Date.now(), bytes: item.bytes, translations: [...item.translations], fingerprint: item.fingerprint, parsed: toRaw(item.document), parsedVersion: PARSED_VERSION}).then(refreshHistory);
  }
}
function scheduleHistorySave(): void {
  if (!historyAvailable || historyTimer !== undefined) return;
  historyTimer = setTimeout(persistHistory, 2000);
}
// 刷新后回到正在阅读的文档：当前标签页记住它在本地历史里的标识，新开的标签页仍从首页开始。
const SESSION_KEY = 'fluentread.document.open';
/** 版面分析或分段规则变化时递增：旧快照作废，改为按原始文件重新解析。 */
const PARSED_VERSION = 7;
function rememberOpenDocument(id: string | undefined | null): void {
  try {
    if (id) globalThis.sessionStorage?.setItem(SESSION_KEY, id);
    else globalThis.sessionStorage?.removeItem(SESSION_KEY);
  } catch { /* 无法使用会话存储时刷新回到首页。 */ }
}
function openDocumentId(): string | null {
  try {return historyAvailable ? globalThis.sessionStorage?.getItem(SESSION_KEY) ?? null : null;} catch {return null;}
}
// 刷新时先保持阅读界面的底色而不是闪回首页；本地快照还原后直接显示原来的文档。
const restoring = ref(Boolean(openDocumentId()));
async function restoreOpenDocument(): Promise<void> {
  const id = openDocumentId();
  try {
    if (id && !parsedDocument.value) await openHistory({id} as DocumentHistorySummary);
  } finally {restoring.value = false;}
}
async function openHistory(entry: DocumentHistorySummary): Promise<void> {
  if (queueBusy.value) return;
  const record = await history.load(entry.id);
  if (!record) {await refreshHistory(); return;}
  if (disposed || queueBusy.value) return;
  const snapshot = record.parsedVersion === PARSED_VERSION ? record.parsed as ParsedDocument | undefined : undefined;
  if (!snapshot?.segments) {
    // 没有快照或解析规则已经更新：重新解析原文件，按原文匹配恢复未改变段落的译文。
    await loadFiles([new File([record.bytes], record.name, {type: record.mimeType})], record.sourceUrl);
    return;
  }
  const item: DocumentQueueItem = {id: ++nextDocumentId, name: record.name, sourceUrl: record.sourceUrl, document: markRaw(snapshot), historyId: record.id, bytes: record.bytes, mimeType: record.mimeType,
    translations: restoreDocumentHistoryTranslations(record, snapshot, PARSED_VERSION), fingerprint: record.fingerprint, state: 'ready', revision: 0, savedRevision: 0, downloaded: 0, error: ''};
  documentQueue.value.push(item);
  if (documentQueue.value.length > 1) {sidebarOpen.value = true; sidebarTab.value = 'files';}
  selectDocument(item);
}
async function removeHistory(entry: DocumentHistorySummary): Promise<void> {
  await history.remove(entry.id);
  await refreshHistory();
}
async function clearHistory(): Promise<void> {
  await history.clear();
  await refreshHistory();
}
function historyFormat(entry: DocumentHistorySummary): string {
  return entry.format === 'markdown' ? 'MD' : entry.format.toUpperCase();
}
function historyStatus(entry: DocumentHistorySummary): string {
  const date = new Date(entry.updatedAt).toLocaleDateString(language.value, {month: 'short', day: 'numeric'});
  return `${!entry.completed ? translateLegacy('尚未翻译') : entry.completed >= entry.total ? translateLegacy('翻译完成') : `${entry.completed} / ${entry.total}`} · ${date}`;
}

function queueStatus(item: DocumentQueueItem): string {
  if (!item.document) return t('document.batch.importFailed');
  if (!item.document.segments.length && item.document.binary?.kind === 'pdf') return t('document.pdfReading.selectableSource');
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
  releaseDocumentPreview(item.document);
  documentQueue.value = documentQueue.value.filter(entry => entry.id !== item.id);
  if (item.id === activeDocumentId.value) {
    const next = documentQueue.value.find(entry => entry.document);
    if (next) selectDocument(next);
    else {
      rememberOpenDocument(null);
      activeDocumentId.value = null;
      parsedDocument.value = null;
      translatedSegments.value = [];
      settledTranslations.value = [];
      editRevision.value = downloadedRevision.value = 0;
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
        pdfPresentation: 'layout',
        signal: controller.signal,
        onPdfProgress: progress => { if (!controller.signal.aborted && downloadController === controller) batchNotice.value = `${item.name} · ${pdfExportProgress(progress)}`; },
        onArchiveProgress: percent => { if (!controller.signal.aborted && downloadController === controller) batchNotice.value = `${item.name} · ${archiveExportProgress(percent)}`; },
      });
      controller.signal.throwIfAborted();
      if (generation !== batchGeneration) return;
      // 独立目录避免同名文件覆盖，文件名不能在 ZIP 中创建任意路径。
      const name = download.fileName.replace(/[\\/\x00-\x1f]/g, '_');
      zip.file(`${index + 1}/${name}`, download.data);
    }
    batchNotice.value = t('document.export.saving');
    const bytes = await generateDocumentArchive(zip, {streamFiles: true}, {
      signal: controller.signal,
      onProgress: percent => { if (!controller.signal.aborted && downloadController === controller) batchNotice.value = archiveExportProgress(percent); },
    });
    const blob = new Blob([bytes], {type: 'application/zip'});
    controller.signal.throwIfAborted();
    if (generation !== batchGeneration) return;
    saveDownloadBlob(blob, 'FluentRead-documents.zip');
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
const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const maxFileSizeLabel = `${megabytes(DOCUMENT_MAX_BYTES)} (PDF ${megabytes(PDF_MAX_BYTES)})`;
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
// “跟随默认”后面写明当前默认的是哪个服务，读者不必去设置页确认。
const followDefaultLabel = computed(() => {
  const name = serviceOptions.value.find(item => item.value === config.service)?.label;
  return name ? `${t('featureServices.followDefault')} · ${name}` : t('featureServices.followDefault');
});
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
// 字幕的样式标签被翻译服务改写时（实体或括号写法）先还原，阅读视图才能像原文一样把它们当作样式而不是文字。
const rowForSegment = (segment: ParsedDocument['segments'][number]) => ({
  ...segment, index: segment.id, translation: isSubtitleDocument.value ? restoreSubtitleTags(segment.source, translatedSegments.value[segment.id] || '') : translatedSegments.value[segment.id] || '',
});
const pageRows = <T,>(rows: readonly T[]) => rows.slice((readerPage.value - 1) * READER_PAGE_SIZE, readerPage.value * READER_PAGE_SIZE);
const previewRows = computed(() => pageRows(parsedDocument.value?.segments || []).map(rowForSegment));
const hasTranslation = computed(() => translatedSegments.value.some((item) => Boolean(item?.trim())));
const completedSegments = computed(() => translating.value ? liveCompletedSegments.value
  : parsedDocument.value?.segments.filter(segment => translatedSegments.value[segment.id]?.trim()).length || 0);
const translationComplete = computed(() => Boolean(parsedDocument.value?.segments.length && completedSegments.value === parsedDocument.value.segments.length));
const progress = computed(() => parsedDocument.value?.segments.length ? Math.floor(completedSegments.value / parsedDocument.value.segments.length * 100) : 0);
// PDF 打开即左右对照，其他格式从翻译开始进入所选方式：译文页先显示原页，各段译文到达后逐段替换。
const canCompare = computed(() => translating.value || hasTranslation.value || (isPdfDocument.value && Boolean(parsedDocument.value?.segments.length)));
const effectivePreviewMode = computed(() => canCompare.value ? previewMode.value : 'source');
const currentFingerprint = computed(() => JSON.stringify({
  from: config.from, to: config.to, service: effectiveDocumentService.value, model: selectedDocumentModel.value,
  glossaryIds: config.documentGlossaryIds, glossaryRevision: buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
}));
const settingsChanged = computed(() => Boolean(taskFingerprint.value && taskFingerprint.value !== currentFingerprint.value));
const translationActionLabel = computed(() => settingsChanged.value ? '按新设置翻译' : translationComplete.value ? '重新翻译' : hasTranslation.value || runState.value === 'paused' ? '继续翻译' : runState.value === 'failed' ? '重试翻译' : '开始翻译');
/**
 * 整篇译完、译文却几乎都和原文一样：多半是文档本来就是目标语言。状态里直接说明，读者不必对着没有变化的页面猜原因。
 * 片段太少时不下这个判断（专名、数字本来就会原样返回）。
 */
const sameAsSource = computed(() => {
  const segments = parsedDocument.value?.segments ?? [];
  if (translating.value || segments.length < 5 || !translationComplete.value) return false;
  const unchanged = segments.filter(segment => !hasDistinctTranslation(segment.source, translatedSegments.value[segment.id])).length;
  return unchanged >= segments.length * 0.9;
});
const statusLabel = computed(() => recognitionProgress.value ? recognitionProgress.value : needsOcr.value ? t('document.pdfReading.scanned') : isPdfDocument.value && !parsedDocument.value?.segments.length ? t('document.pdfReading.selectableSource') : translating.value ? '正在翻译' : translationComplete.value ? (sameAsSource.value ? '译文与原文相同，可换目标语言' : '翻译完成') : runState.value === 'paused' ? '已暂停' : runState.value === 'failed' ? '翻译中断' : hasTranslation.value ? '部分完成' : '准备就绪');
const hasUnsavedWork = computed(() => translating.value || batchRunning.value || openingFile.value || editRevision.value > downloadedRevision.value
  || documentQueue.value.some(item => item.id !== activeDocumentId.value && item.revision > item.downloaded));
const isPdfDocument = computed(() => parsedDocument.value?.binary?.kind === 'pdf');
const pdfExportPageCount = computed(() => parsedDocument.value?.binary?.kind === 'pdf' ? parsedDocument.value.binary.pages.length : 0);
const isEpubDocument = computed(() => parsedDocument.value?.binary?.kind === 'epub');
const isDocxDocument = computed(() => parsedDocument.value?.binary?.kind === 'docx');
const isSubtitleDocument = computed(() => isSubtitleDocumentFormat(parsedDocument.value?.format));
const isJsonDocument = computed(() => parsedDocument.value?.format === 'json');
const isRichDocument = computed(() => isRichDocumentFormat(parsedDocument.value?.format));
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
/** 富文本预览的完整 HTML：直接读取逐段写入的译文，翻译进行中也能反映最新进度。 */
function buildRichPreview(): string {
  const document = richPreviewDocument.value;
  if (!document) return '';
  const chapter = currentEpubChapter.value;
  const translations = toRaw(translatedSegments.value);
  const html = createDocumentPreviewHtml(
    document,
    chapter ? translations.slice(chapter.segmentOffset, chapter.segmentOffset + chapter.segmentCount) : translations,
    effectivePreviewMode.value,
  );
  // 只为当前隔离阅读页补充固定主题规则，不改变原文件或导出内容。
  return isDark.value ? html.replace('</head>', `<style>
    :root { color-scheme: dark; color: #e8edf7; background: #202632; }
    h1,h2,h3,h4,h5,h6,.reader-source,.reader-translation,.fluentread-translation,[data-fluent-read-document-translation="true"] { color: #e8edf7; }
    blockquote { color: #aab2c3; } a,.reader-link { color: #ff8bad; }
    pre,code,.document-security-note { color: #e8edf7; background: #29303d; border-color: #434b5d; }
    td,th { border-color: #434b5d; }
    body[data-translating] article[data-reader-mode="bilingual"] .reader-unit:has(> .reader-source:only-child)::after { background-image: linear-gradient(90deg, #2c3442 25%, #384153 50%, #2c3442 75%); }
  </style></head>`) : html;
}
const richFrame = ref<HTMLIFrameElement | null>(null);
const richFrameHtml = ref('');
type ReaderZoomPoint = {clientX: number; clientY: number};
type ReaderZoomSurface = {content: HTMLElement; viewport: HTMLElement; xScroller: HTMLElement; yScroller: HTMLElement; document: Document; frame: boolean};
let readerZoomDisposer: (() => void) | undefined;
let loadedRichDocument: Document | null = null;
let readerZoomRevision = 0;

/** 缩放只影响正文，工具栏和滚动视口保持原尺寸。 */
function applyRichReaderZoom(): void {
  richFrame.value?.contentDocument?.body?.style.setProperty('zoom', String(readerScale.value));
}
/** 不同格式和窄窗口的横向、纵向滚动容器可能不同。 */
function nativeReaderScroller(content: HTMLElement, axis: 'x' | 'y'): HTMLElement {
  const viewport = readingContent.value!;
  for (let element = content.parentElement; element && viewport.contains(element); element = element.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
    const overflow = axis === 'x' ? style?.overflowX : style?.overflowY;
    const overflows = axis === 'x' ? element.scrollWidth > element.clientWidth + 1 : element.scrollHeight > element.clientHeight + 1;
    if (overflows && (element === viewport || overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay')) return element;
    if (element === viewport) break;
  }
  return viewport;
}
function readerZoomSurface(): ReaderZoomSurface | null {
  if (isRichDocument.value) {
    const document = richFrame.value?.contentDocument;
    const scroller = document?.scrollingElement as HTMLElement | null;
    return document?.body && scroller ? {content: document.body, viewport: scroller, xScroller: scroller, yScroller: scroller, document, frame: true} : null;
  }
  const viewport = readingContent.value;
  const content = viewport?.querySelector?.<HTMLElement>('.docx-page,[data-native-zoom-content]');
  if (!viewport || !content) return null;
  return {content, viewport, xScroller: nativeReaderScroller(content, 'x'), yScroller: nativeReaderScroller(content, 'y'), document: content.ownerDocument, frame: false};
}
function clearReaderZoomGestures(): void {
  readerZoomRevision += 1;
  readerZoomDisposer?.();
  readerZoomDisposer = undefined;
}

/** 保留指针下的正文位置；键盘和工具栏缩放以当前视口中央为锚点。 */
function setReaderScale(value: number, point?: ReaderZoomPoint): void {
  if (!parsedDocument.value || isPdfDocument.value || readerTab.value !== 'read' || !Number.isFinite(value)) return;
  const next = Math.round(Math.min(3, Math.max(.5, value)) * 10000) / 10000;
  if (next === readerScale.value) return;
  const surface = readerZoomSurface();
  let anchor: {element: Element; x: number; y: number; point: ReaderZoomPoint} | undefined;
  if (surface && typeof surface.content.getBoundingClientRect === 'function') {
    const viewport = surface.frame ? {left: 0, top: 0, width: surface.viewport.clientWidth, height: surface.viewport.clientHeight} : surface.viewport.getBoundingClientRect();
    const position = point || {clientX: viewport.left + viewport.width / 2, clientY: viewport.top + viewport.height / 2};
    const hit = surface.document.elementFromPoint?.(position.clientX, position.clientY);
    const unit = hit?.closest('p,h1,h2,h3,h4,h5,h6,img,pre,td,th,[data-reader-unit],.json-table-row,.docx-paragraph') || surface.content;
    const element = surface.content.contains(unit) ? unit : surface.content;
    const rect = element.getBoundingClientRect();
    if (rect.width && rect.height) anchor = {element, point: position, x: (position.clientX - rect.left) / rect.width, y: (position.clientY - rect.top) / rect.height};
  }
  readerScale.value = next;
  applyRichReaderZoom();
  const revision = ++readerZoomRevision;
  void nextTick().then(() => {
    if (revision !== readerZoomRevision || !surface || !anchor || !anchor.element.isConnected || readerTab.value !== 'read') return;
    const rect = anchor.element.getBoundingClientRect();
    const xScroller = surface.frame ? surface.xScroller : nativeReaderScroller(surface.content, 'x');
    const yScroller = surface.frame ? surface.yScroller : nativeReaderScroller(surface.content, 'y');
    xScroller.scrollLeft += rect.left + rect.width * anchor.x - anchor.point.clientX;
    yScroller.scrollTop += rect.top + rect.height * anchor.y - anchor.point.clientY;
  });
}
function resetReaderZoom(): void {
  // 工具栏复位也应撤销尚未提交的触控板手势。
  bindReaderZoomGestures();
  setReaderScale(1);
}
function stepReaderZoom(direction: 1 | -1): void {
  const steps = [.5, .75, 1, 1.25, 1.5, 2, 3];
  const next = direction > 0 ? steps.find(value => value > readerScale.value + .001) : steps.reverse().find(value => value < readerScale.value - .001);
  if (next !== undefined) {bindReaderZoomGestures(); setReaderScale(next);}
}
function bindReaderZoomGestures(): void {
  clearReaderZoomGestures();
  if (!parsedDocument.value || isPdfDocument.value || readerTab.value !== 'read') return;
  const target = isRichDocument.value
    ? loadedRichDocument === richFrame.value?.contentDocument ? loadedRichDocument?.documentElement : null
    : readingContent.value;
  if (!target?.ownerDocument) return;
  readerZoomDisposer = installDocumentZoomGestures(target, {
    getScale: () => readerScale.value, setScale: setReaderScale, minScale: .5, maxScale: 3, reset: resetReaderZoom,
  });
}
function focusNativeReader(event: PointerEvent): void {
  if (isRichDocument.value || isPdfDocument.value || readerTab.value !== 'read') return;
  const target = event.composedPath().find(node => (node as Node)?.nodeType === 1) as Element | undefined;
  if (target?.closest('button,a,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[data-fluent-read-ui]')) return;
  readingContent.value?.focus?.({preventScroll: true});
}
function handleRichFrameLoad(): void {
  loadedRichDocument = richFrame.value?.contentDocument || null;
  refreshRichPreview();
  bindReaderZoomGestures();
}
watch([parsedDocument, readerTab], ([document], [previousDocument]) => {
  clearReaderZoomGestures();
  if (document !== previousDocument) {readerScale.value = 1; loadedRichDocument = null;}
  const revision = readerZoomRevision;
  void nextTick().then(() => {if (revision === readerZoomRevision) bindReaderZoomGestures();});
}, {flush: 'sync'});
onUnmounted(clearReaderZoomGestures);

let richPreviewTimer: ReturnType<typeof setTimeout> | undefined;
/** 译文或阅读方式变化时原位更新预览框，保留滚动位置；预览框不可访问时才整页重载。 */
function refreshRichPreview(): void {
  clearTimeout(richPreviewTimer);
  richPreviewTimer = undefined;
  if (!richPreviewDocument.value) return;
  const html = buildRichPreview();
  if (!syncRichPreview(richFrame.value, html)) {richFrameHtml.value = html; return;}
  applyRichReaderZoom();
  markRichPreviewBusy(richFrame.value, translating.value);
  richOutline.value = collectRichOutline(richFrame.value);
}
/** 翻译进行中逐段到达的译文按节流间隔刷新：先译完的先显示，不必等全文结束。 */
function scheduleRichPreview(): void {
  if (richPreviewTimer !== undefined || !richPreviewDocument.value) return;
  richPreviewTimer = setTimeout(refreshRichPreview, richPreviewInterval(richPreviewDocument.value.segments.length));
}
// 换文档、换章节或换主题时整页载入一次；之后的译文与阅读方式变化都原位更新。
watch([richPreviewDocument, isDark], () => {
  clearTimeout(richPreviewTimer);
  richPreviewTimer = undefined;
  richOutline.value = [];
  richFrameHtml.value = buildRichPreview();
}, {immediate: true});
watch([settledTranslations, effectivePreviewMode, translating], refreshRichPreview);
// 只有带目录的文档才有“目录”页；其余文档始终显示文件页，避免停在不存在的页签上。
/** Word 文档的目录取自标题样式的段落；翻译停下后显示它们的译文。 */
const docxOutline = computed<RichOutlineItem[]>(() => {
  const document = parsedDocument.value;
  if (document?.binary?.kind !== 'docx') return [];
  return document.binary.parts.flatMap(part => part.paragraphSegments).flatMap(({segmentIndex}) => {
    const segment = document.segments[segmentIndex];
    return segment?.role === 'title' || segment?.role === 'heading'
      ? [{index: segmentIndex, level: segment.role === 'title' ? 1 : 2, source: segment.source, translation: settledTranslations.value[segmentIndex] || ''}] : [];
  });
});
const documentOutline = computed(() => isDocxDocument.value ? docxOutline.value : richOutline.value);
/** 跳到目录项：富文本预览滚动到对应标题；Word 先切到标题所在的部分和分页，再滚动到该段落。 */
async function jumpOutline(item: RichOutlineItem): Promise<void> {
  if (!isDocxDocument.value) {scrollRichOutline(richFrame.value, item.index); return;}
  const partIndex = docxParts.value.findIndex(part => part.paragraphSegments.some(paragraph => paragraph.segmentIndex === item.index));
  if (partIndex < 0) return;
  docxPartIndex.value = partIndex;
  await nextTick();
  readerPage.value = Math.floor(docxParts.value[partIndex].paragraphSegments.findIndex(paragraph => paragraph.segmentIndex === item.index) / READER_PAGE_SIZE) + 1;
  await nextTick();
  window.document.querySelector?.(`.docx-paragraph[data-segment="${item.index}"]`)?.scrollIntoView({block: 'start', behavior: 'smooth'});
}
/** PDF 里还有没识别的扫描页（整份扫描件，或文字 PDF 里夹着的扫描页）：开始翻译时先识别文字。空白页不触发识别。 */
const needsOcr = computed(() => pdfPagesNeedingOcr(parsedDocument.value).length > 0);
/**
 * 侧栏目录的行。ePub 列出全部章节，当前章节下面接着它的各级标题：章节多的书也能一眼看到位置并直接跳转，
 * 正文上方不再占一行章节按钮；其他格式就是文档自己的标题。
 */
const outlineRows = computed(() => {
  const label = (item: RichOutlineItem) => richOutlineLanguage.value === 'translated' && item.translation ? item.translation : item.source;
  const headings = (offset: number) => documentOutline.value.map(item => ({key: `h${item.index}`, level: item.level + offset, label: label(item), title: item.source, item, chapter: undefined as number | undefined, current: false}));
  if (!isEpubDocument.value) return headings(0);
  const segments = parsedDocument.value!.segments, wanted = richOutlineLanguage.value === 'translated';
  return epubChapters.value.flatMap((chapter, index) => {
    const current = index === epubChapterIndex.value;
    // 章节名取自章内开头的标题；按译文显示时用那个标题的译文（翻译停下后），没有就仍显示原名。
    const name = chapter.title.toLocaleLowerCase();
    const heading = segments.slice(chapter.segmentOffset, chapter.segmentOffset + Math.min(3, chapter.segmentCount)).find(segment => segment.source.toLocaleLowerCase().includes(name));
    const row = {key: `c${index}`, level: 1, label: (wanted && heading && settledTranslations.value[heading.id]) || chapter.title, title: chapter.title, item: undefined as RichOutlineItem | undefined, chapter: index, current};
    // 当前章节下面不重复列出作为章节名的那个标题。
    return [row, ...(current ? headings(1).filter(entry => entry.title !== row.title && entry.title !== heading?.source) : [])];
  });
});
const hasOutline = computed(() => isPdfDocument.value || outlineRows.value.length > 0);
const activeSidebarTab = computed(() => hasOutline.value ? sidebarTab.value : 'files');
onUnmounted(() => clearTimeout(richPreviewTimer));
const docxParts = computed(() => parsedDocument.value?.binary?.kind === 'docx'
  ? parsedDocument.value.binary.parts
  : []);
const currentDocxPart = computed(() => docxParts.value[docxPartIndex.value]);
const currentDocxRows = computed(() => {
  const document = parsedDocument.value;
  const part = currentDocxPart.value;
  if (!document || !part) return [];
  return pageRows(part.paragraphSegments).map(({segmentIndex, table}) => {
    const segment = document.segments[segmentIndex];
    return {
      index: segmentIndex,
      source: segment?.source || '',
      role: segment?.role,
      translation: translatedSegments.value[segmentIndex] || '',
      table,
    };
  });
});
type DocxRow = (typeof currentDocxRows.value)[number];
/** 相同译文只显示原文；只看译文时，没有不同译文的段落仍显示原文。 */
const docxShowsSource = (row: DocxRow) => effectivePreviewMode.value !== 'translated' || Boolean(row.translation && !hasDistinctTranslation(row.source, row.translation));
const docxShowsTranslation = (row: DocxRow) => effectivePreviewMode.value !== 'source' && (!row.translation || hasDistinctTranslation(row.source, row.translation));
/** 把连续属于同一张表格的段落收成“行 → 单元格 → 段落”，其余段落各自成块；阅读视图里表格仍是表格。 */
const currentDocxBlocks = computed(() => {
  const blocks: Array<{key: string; row: DocxRow; table?: DocxRow[][][]; id?: number}> = [];
  for (const row of currentDocxRows.value) {
    const place = row.table, last = blocks.at(-1);
    if (!place) {blocks.push({key: `p${row.index}`, row}); continue;}
    const block = last?.table && last.id === place.table ? last : blocks[blocks.push({key: `t${row.index}`, row, table: [], id: place.table}) - 1];
    ((block.table![place.row] ??= [])[place.cell] ??= []).push(row);
  }
  // 分页或空单元格会留下空位：补成空单元格、去掉空行，表格的列才能对齐。
  for (const block of blocks) if (block.table) block.table = block.table.filter(Boolean).map(cells => Array.from(cells, cell => cell ?? []));
  return blocks;
});
const subtitleRows = computed(() => previewRows.value);
const jsonRows = computed(() => previewRows.value);
const emptyReaderHint = computed(() => isPdfDocument.value ? t(parsedDocument.value?.segments.length ? 'document.pdfReading.startHint' : 'document.pdfReading.selectableSource') : getDocumentEmptyReaderHint(parsedDocument.value));
const readerPageCount = computed(() => isPdfDocument.value || isRichDocument.value ? 1 : Math.max(1, Math.ceil((isDocxDocument.value ? currentDocxPart.value?.paragraphSegments.length || 0 : parsedDocument.value?.segments.length || 0) / READER_PAGE_SIZE)));

const pdfSegmentPages = computed(() => {
  const binary = parsedDocument.value?.binary;
  if (binary?.kind !== 'pdf') return null;
  const map = new Map<number, number>();
  binary.pages.forEach((page, index) => page.segmentIndexes.forEach(segment => { if (!map.has(segment)) map.set(segment, index); }));
  return {map, count: binary.pages.length};
});
/** 从正在阅读的位置开始向后翻译，读到哪里先译哪里；前面的内容排在全文末尾之后。 */
function prioritizeReadingPosition<T extends {id: number}>(pending: readonly T[]): T[] {
  const pages = pdfSegmentPages.value;
  if (pages) {
    const current = pdfPage.value - 1;
    const rank = (segment: T) => ((pages.map.get(segment.id) ?? 0) - current + pages.count) % pages.count;
    return [...pending].sort((left, right) => rank(left) - rank(right) || left.id - right.id);
  }
  // 其他格式按片段顺序排列：ePub 从当前章节、Word 从当前部分的当前页、字幕与表格类从当前页的第一段开始。
  const total = parsedDocument.value?.segments.length || 1;
  const offset = (readerPage.value - 1) * READER_PAGE_SIZE;
  const anchor = currentEpubChapter.value?.segmentOffset
    ?? (currentDocxPart.value ? currentDocxPart.value.paragraphSegments[offset]?.segmentIndex ?? 0 : isRichDocument.value ? 0 : offset);
  // 富文本预览是一整页长文：按滚动到的比例估算正在阅读的片段（ePub 在当前章节之内估算）。
  const chapter = currentEpubChapter.value;
  const scrolled = isRichDocument.value ? Math.floor(richPreviewPosition(richFrame.value) * (chapter ? chapter.segmentCount : total)) : 0;
  const start = anchor + scrolled;
  if (!start) return [...pending];
  const rank = (segment: T) => (segment.id - start + total) % total;
  return [...pending].sort((left, right) => rank(left) - rank(right));
}

function releaseDocumentPreview(document: ParsedDocument | null): void {
  if (document?.binary?.kind === 'pdf') releasePdfDocument(document.binary.bytes);
}

function clearDownloadUrls(): void {
  downloadUrls.forEach((timer, url) => {
    clearTimeout(timer);
    URL.revokeObjectURL(url);
  });
  downloadUrls.clear();
}

function saveDownloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadUrls.delete(url);
    }, 1000);
    downloadUrls.set(url, timer);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
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
  if (disposed) return;
  lastSerialized = JSON.stringify(runtimeConfig);
  // 页面编辑不能借共享对象引用提前修改运行时配置；保存仍通过字段级协调器。
  Object.assign(config, JSON.parse(lastSerialized));
  hydrated.value = true;
}
void hydrateConfig();

unsubscribeConfig = subscribeConfig((nextConfig) => {
  if (disposed) return;
  const serialized = JSON.stringify(nextConfig);
  if (serialized === lastSerialized) return;
  lastSerialized = serialized;
  applyingExternalConfig = true;
  try {
    Object.assign(config, JSON.parse(serialized));
    if (!config.on && (translating.value || batchRunning.value)) pauseTranslation();
  } finally {
    applyingExternalConfig = false;
  }
});

// post flush 会把一次模型选择对 documentModel/documentCustomModel 的同步修改
// 合并成一个字段 patch，避免先保存 sentinel 或 scalar 的半成品。
watch(config, (value) => {
  if (disposed || !hydrated.value || applyingExternalConfig) return;
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

// 翻译期间不订阅整份数组，避免每个片段都触发 O(n) 的深度遍历。
watch(() => translating.value ? null : [...translatedSegments.value], (translations) => {
  if (!translations) return;
  settledTranslations.value = translations;
});
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

async function loadFiles(files: File[], sourceUrl?: string): Promise<void> {
  if (disposed || queueBusy.value || !files.length) return;
  const loadRequest = documentFileLoads.begin();
  const controller = new AbortController();
  fileLoadController = controller;
  openingFile.value = true;
  importProgress.value = '';
  importRatio.value = 0;
  batchNotice.value = '';
  errorMessage.value = '';
  let opened = false;
  try {
    for (const file of files) {
      const item: DocumentQueueItem = {id: ++nextDocumentId, name: file.name, sourceUrl, document: null,
        translations: [], fingerprint: '', state: 'ready', revision: 0, downloaded: 0, error: ''};
      try {
        if (!getDocumentFormat(file.name)) throw new Error('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件。');
        if (file.size > getDocumentMaxBytes(file.name)) throw new Error(`文件大小超过 ${megabytes(getDocumentMaxBytes(file.name))}，请先拆分文件后再翻译。`);
        const parsed = await parseDocumentFile(file, {signal: controller.signal, onPdfProgress: ({completed, total}) => {
          if (loadRequest.isCurrent()) {importProgress.value = t('document.pdfReading.importPages', {completed, total}); importRatio.value = total ? completed / total : 0;}
        }});
        if (!loadRequest.isCurrent()) return;
        if (!parsed.segments.length && parsed.binary?.kind !== 'pdf') throw new Error('文件中没有找到可翻译的文本片段。');
        item.document = markRaw(parsed);
        if (historyAvailable) {
          const bytes = parsed.binary?.bytes ?? new Uint8Array(await file.arrayBuffer());
          const historyId = await documentHistoryId(bytes);
          const saved = historyId ? await history.load(historyId) : null;
          if (!loadRequest.isCurrent()) return;
          Object.assign(item, {historyId, bytes, mimeType: file.type});
          if (item.id === activeDocumentId.value) rememberOpenDocument(historyId);
          // 分段规则变化时按原文恢复校订；片段数相等也不能按旧索引错位套用。
          if (saved) Object.assign(item, {translations: restoreDocumentHistoryTranslations(saved, parsed, PARSED_VERSION), fingerprint: saved.fingerprint});
        }
      } catch (error) {
        if (!loadRequest.isCurrent()) return;
        item.error = error instanceof Error ? error.message : String(error);
      }
      documentQueue.value.push(item);
      if (item.error) queueExpanded.value = true;
      if (item.error || documentQueue.value.length > 1) {sidebarOpen.value = true; sidebarTab.value = 'files';}
      // 新添加的文件立即成为当前文档；一次添加多份时停在第一份，其余在文件列表中等待。
      if (item.document && !opened) {opened = true; selectDocument(item);}
    }
  } finally {
    if (loadRequest.isCurrent()) {openingFile.value = false; importProgress.value = ''; persistHistory();}
    if (fileLoadController === controller) fileLoadController = null;
  }
}

function cancelImport(): void {
  onlinePdfController?.abort();
  onlinePdfController = null;
  downloadingPdf.value = false;
  documentFileLoads.invalidate();
  fileLoadController?.abort();
  fileLoadController = null;
  openingFile.value = false;
  importProgress.value = '';
}

async function openOnlinePdf(): Promise<void> {
  if (disposed || queueBusy.value) return;
  const sourceUrl = onlinePdfUrl.value;
  const controller = new AbortController();
  onlinePdfController = controller;
  downloadingPdf.value = true;
  errorMessage.value = '';
  importProgress.value = t('document.pdfReading.downloading');
  try {
    const file = await fetchOnlinePdf(sourceUrl, {signal: controller.signal, onProgress: ({received, total}) => {
      if (onlinePdfController !== controller) return;
      const size = (received / 1024 / 1024).toFixed(1);
      importRatio.value = total ? received / total : 0;
      importProgress.value = total ? t('document.pdfReading.downloadProgress', {size, percent: Math.round(received / total * 100)})
        : t('document.pdfReading.downloadBytes', {size});
    }});
    if (disposed || onlinePdfController !== controller) return;
    downloadingPdf.value = false;
    await loadFiles([file], sourceUrl);
  } catch (error) {
    if (!disposed && onlinePdfController === controller && !controller.signal.aborted) {
      showError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (onlinePdfController === controller) {
      onlinePdfController = null;
      downloadingPdf.value = false;
      importProgress.value = '';
    }
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
  persistHistory();
  if (downloadNoticeTimer !== undefined) {clearTimeout(downloadNoticeTimer); downloadNoticeTimer = undefined;}
  cancelImport();
  releaseDocumentPreview(parsedDocument.value);
  documentQueue.value.forEach(item => releaseDocumentPreview(item.document));
  clearDownloadUrls();
  fileLoadController?.abort();
  fileLoadController = null;
  clearConfirmation();
  configSaveRequest += 1;
  downloadController?.abort();
  downloadController = null;
  cancelingDownload.value = false;
  downloadProgress.value = '';
  downloadPdfProgress.value = null;
  downloadDialog.value?.close();
  documentSettingsDialog.value?.close();
  downloadOpen.value = false;
  batchGeneration += 1;
  batchRunning.value = false;
  documentQueue.value = [];
  activeDocumentId.value = null;
  documentBatchTranslation.value = true;
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
  epubChapterIndex.value = 0;
  docxPartIndex.value = 0;
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
  } else {rememberOpenDocument(null); resetDocument();}
}

function requestTranslation(): void {
  if (!config.on || queueBusy.value || !(parsedDocument.value?.segments.length || needsOcr.value)) return;
  if (translationComplete.value || (settingsChanged.value && hasTranslation.value)) {
    pendingAction.value = 'restart';
    confirmDialog.value?.showModal();
  } else void startTranslation(settingsChanged.value);
}

function confirmAction(): void {
  const action = pendingAction.value;
  const removal = pendingRemoval;
  clearConfirmation();
  confirmDialog.value?.close();
  if (action === 'remove' && removal) {
    removeDocument(removal, true);
  } else if (action === 'reset') {rememberOpenDocument(null); resetDocument();}
  else if (action === 'restart') void startTranslation(true);
}

function clearConfirmation(): void {
  pendingAction.value = null;
  pendingRemoval = null;
}

function pauseTranslation(): void {
  retryNotice.value = '';
  batchGeneration += 1;
  batchRunning.value = false;
  translationRequestId += 1;
  abortController?.abort();
  abortController = null;
  translating.value = false;
  runState.value = 'paused';
}

async function startTranslation(restart = false): Promise<void> {
  let document = parsedDocument.value;
  // 扫描版 PDF 还没有任何文字：先逐页识别，再翻译识别出的段落。
  const scanned = needsOcr.value;
  if (!config.on || !document || !(document.segments.length || scanned) || translating.value || !hydrated.value || preparingDownload.value || credentialWarning.value) return;
  if (restart) {
    translatedSegments.value = [];
    settledTranslations.value = [];
  }
  taskFingerprint.value = currentFingerprint.value;
  const glossaryIds = config.documentGlossaryIds === null ? null : [...config.documentGlossaryIds];
  const glossaryRevision = buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled);
  // OCR 可能持续较久；整个任务使用同一设置快照，外部配置更新不混入正在处理的文件。
  const settings = {serviceOverride: effectiveDocumentService.value,
    modelOverride: documentUsesModel.value ? documentModelValue.value : undefined,
    sourceLanguage: config.from, targetLanguage: config.to, batchTranslation: documentBatchTranslation.value};
  runState.value = 'ready';
  liveCompletedSegments.value = completedSegments.value;
  translating.value = true;
  errorMessage.value = '';
  downloadNotice.value = '';
  const controller = new AbortController();
  const requestId = ++translationRequestId;
  abortController = controller;
  try {
    if (scanned) {
      const source = document;
      const recognized = await recognizePdfDocument(source, createPdfPageRecognizer(settings.sourceLanguage), {
        signal: controller.signal, startPage: pdfPage.value - 1,
        onProgress: ({completed, total}) => { if (requestId === translationRequestId) recognitionProgress.value = t('document.pdfReading.recognizing', {completed, total}); },
      });
      if (requestId !== translationRequestId || parsedDocument.value !== source) return;
      recognitionProgress.value = '';
      if (!recognized.segments.length) {
        // 一个字也没认出来：仍然采用识别后的文档（扫描页不再反复识别），并说明原因。
        const empty = markRaw(recognized);
        const item = documentQueue.value.find(entry => entry.id === activeDocumentId.value);
        if (item) item.document = empty;
        parsedDocument.value = empty;
        throw new Error(t('document.pdfReading.ocrEmpty'));
      }
      // 识别结果成为这份文档新的解析结果；之后的翻译、校订、保存和下载都基于它。
      document = markRaw(recognized);
      const item = documentQueue.value.find(entry => entry.id === activeDocumentId.value);
      if (item) item.document = document;
      parsedDocument.value = document;
      translatedSegments.value = [];
      settledTranslations.value = [];
      liveCompletedSegments.value = 0;
    }
    const current = document;
    await translateDocumentSegments(document.segments, {
      fileName: document.fileName,
      ...settings,
      glossaryIds, glossaryRevision,
      initialTranslations: [...translatedSegments.value],
      signal: controller.signal,
      // 服务限流或暂时不可用时自动退避重试，累计最多等两分钟；仍然失败才停下并显示原因。
      retryBackoff: documentRetryBackoff,
      onRetry: ({delayMs, reason}) => {
        if (requestId === translationRequestId && !controller.signal.aborted) retryNotice.value = `${translateLegacy('翻译服务暂时没有响应，将自动重试')} · ${Math.ceil(delayMs / 1000)}s · ${reason}`;
      },
      // 默认合并多段，使用 feature 的有界批量与并发；开关只作用于当前文档。
      prioritize: prioritizeReadingPosition,
      onSegment: ({id, translation}) => {
        if (requestId !== translationRequestId || parsedDocument.value !== current || controller.signal.aborted) return;
        retryNotice.value = '';
        liveCompletedSegments.value += Number(Boolean(translation.trim())) - Number(Boolean(translatedSegments.value[id]?.trim()));
        translatedSegments.value[id] = translation;
        editRevision.value += 1;
        scheduleHistorySave();
        scheduleRichPreview();
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
      retryNotice.value = '';
      recognitionProgress.value = '';
      if (abortController === controller) abortController = null;
      persistHistory();
    }
  }
}

function editSegment(index: number, value: string): void {
  if (queueBusy.value || !parsedDocument.value?.segments.some(segment => segment.id === index)) return;
  if (!taskFingerprint.value) taskFingerprint.value = currentFingerprint.value;
  translatedSegments.value[index] = value;
  editRevision.value += 1;
  downloadNotice.value = '';
  scheduleHistorySave();
}

function openDownload(): void {
  if (queueBusy.value || !hasTranslation.value) return;
  // 从正在阅读的译文/双语模式进入下载时采用同一内容；原文阅读保留上次选择。
  if (previewMode.value !== 'source') outputMode.value = previewMode.value;
  partialExportAcknowledged.value = false;
  downloadError.value = '';
  downloadProgress.value = '';
  downloadPdfProgress.value = null;
  downloadOpen.value = true;
  downloadDialog.value?.showModal();
}

function pdfExportProgress(progress: PdfExportProgress): string {
  return progress.phase === 'saving' ? t('document.export.saving')
    : t('document.export.pages', {completed: progress.completedPages, total: progress.totalPages});
}

function archiveExportProgress(percent: number): string {
  return t('document.export.packaging', {percent: Math.floor(percent)});
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
  downloadPdfProgress.value = null;
  downloadError.value = '';
  const revision = editRevision.value;
  const requestId = translationRequestId;
  try {
    const download = await createDocumentDownload(document, [...translatedSegments.value], outputMode.value, {
      pdfPresentation: 'layout',
      signal: controller.signal,
      onPdfProgress: progress => { if (!controller.signal.aborted && downloadController === controller) {downloadPdfProgress.value = progress; downloadProgress.value = pdfExportProgress(progress);} },
      onArchiveProgress: percent => { if (!controller.signal.aborted && downloadController === controller) downloadProgress.value = archiveExportProgress(percent); },
    });
    controller.signal.throwIfAborted();
    if (document !== parsedDocument.value || requestId !== translationRequestId) return;
    saveDownloadBlob(new Blob([download.data], {type: download.mimeType}), download.fileName);
    downloadedRevision.value = revision;
    downloadNotice.value = '已生成下载文件，请在浏览器下载列表中查看。';
    // 浮动提示几秒后自行消失，不占用工具栏的行高。
    const shown = downloadNotice.value;
    if (downloadNoticeTimer !== undefined) clearTimeout(downloadNoticeTimer);
    downloadNoticeTimer = setTimeout(() => {downloadNoticeTimer = undefined; if (downloadNotice.value === shown) downloadNotice.value = '';}, 5000);
    downloadProgress.value = '';
    downloadPdfProgress.value = null;
    downloadDialog.value?.close();
  } catch (error) {
    if (document === parsedDocument.value) {
      downloadPdfProgress.value = null;
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
  window.addEventListener('keydown', leaveFocusOnEscape);
  window.document.addEventListener?.('fullscreenchange', leaveFocusWithFullscreen);
  void refreshHistory();
  const source = readPdfSourceFragment(window.location.hash || '');
  if (source) {onlinePdfUrl.value = source; void openOnlinePdf();}
  else void restoreOpenDocument();
});

onUnmounted(() => {
  disposed = true;
  unsubscribeConfig?.();
  unsubscribeConfig = undefined;
  resetDocument();
  colorSchemeMedia.removeEventListener?.('change', applyTheme);
  window.removeEventListener('pagehide', resetDocument);
  window.removeEventListener('beforeunload', guardBeforeUnload);
  window.removeEventListener('keydown', leaveFocusOnEscape);
  window.document.removeEventListener?.('fullscreenchange', leaveFocusWithFullscreen);
});
</script>

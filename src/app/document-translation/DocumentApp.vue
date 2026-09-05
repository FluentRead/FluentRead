<!--
 @file src/app/document-translation/DocumentApp.vue
 文件职责：实现独立文档翻译页面的完整 Vue 应用，承载文件导入、格式化预览、分段翻译、人工校订和双语文件导出的用户流程。
 主要内容：组织导入、设置、可暂停续译、阅读与全量校订、独立导出流程；维护设置快照、增量译文、未下载保护、异步提交所有权，并复用格式阅读器与配置同步。
 模块边界：组件负责页面交互与响应式状态，不自行解析二进制格式、不实现翻译队列、配置存储协议或导出编码；解析渲染来自 document-translation feature，配置协调来自 services/config，运行时适配由本目录 runtime 注入。
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
        <UiLanguageSelector compact />
        <button class="header-settings" type="button" aria-label="打开翻译设置" @click="openSettings"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 2 3h3l1-3 3-1 2-3-2-2 1-3-3-2-2 1-2-3H9Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="11.5" cy="11" r="3" stroke="currentColor" stroke-width="1.4"/></svg><span>设置</span></button>
      </div>
    </header>

    <input ref="fileInput" class="visually-hidden" type="file" :accept="accept" tabindex="-1" @change="handleFileInput" />
    <main class="document-main">
      <ol v-if="!parsedDocument" class="document-steps" aria-label="文档翻译流程">
        <li :class="{ current: !parsedDocument, done: parsedDocument }"><span>1</span>导入文档</li>
        <li :class="{ current: parsedDocument && !translationComplete, done: translationComplete }"><span>2</span>确认并翻译</li>
        <li :class="{ current: translationComplete }"><span>3</span>阅读与下载</li>
      </ol>
      <section v-if="!parsedDocument" class="landing-section">
        <div class="landing-copy">
          <span class="eyebrow">流畅阅读 · 文档翻译</span>
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
          <p class="upload-description">{{ openingFile ? '解析完成后，即可确认语言并开始翻译' : '或选择电脑中的一个文件' }}</p>
          <button class="open-file-button" type="button" :disabled="openingFile" @click.stop="openFilePicker">
            {{ openingFile ? '正在解析文件…' : '选择文件' }}
          </button>
          <small>{{ t('document.fileLimitNote', {size: maxFileSizeLabel}) }}</small>
        </div>

        <div class="format-list" aria-label="支持的文件格式">
          <span v-for="item in formatCards" :key="item.code" class="format-card"><b :class="item.tone">{{ item.code }}</b>{{ item.label }}</span>
        </div>
        <p class="local-processing-note">文件在本地解析，待译文字会发送给你选择的翻译服务。扫描版 PDF 暂不支持文字识别。</p>
        <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>
      </section>

      <section v-else class="workspace-section">
        <aside class="document-sidebar" aria-label="文档与翻译任务">
        <div class="sidebar-label"><span>当前文档</span><button class="sidebar-change-file" type="button" aria-label="打开新文件" :disabled="preparingDownload" @click="requestReset">更换文件</button></div>
        <div class="workspace-heading">
          <div class="file-heading">
            <span class="file-type-badge" :class="formatTone">{{ formatCode }}</span>
            <div>
              <h1 data-i18n-ignore>{{ parsedDocument.fileName }}</h1>
              <p>{{ parsedDocument.label }} · {{ t('document.translatableSegments', {count: parsedDocument.segments.length}) }}</p>
            </div>
          </div>
        </div>

        <p class="sidebar-file-meta">{{ fileSizeLabel }} · {{ sourceCharacterCount.toLocaleString() }} 字符</p>
        <button class="mobile-settings-toggle" type="button" :aria-expanded="sidebarExpanded" @click="sidebarExpanded = !sidebarExpanded"><span>翻译设置</span><span>{{ sidebarExpanded ? '收起 −' : '展开 +' }}</span></button>
        <section class="translation-setup sidebar-settings" :class="{ collapsed: !sidebarExpanded }" aria-label="翻译设置">
        <div class="setup-heading"><h2>翻译设置</h2></div>
        <div class="control-panel">
          <label class="language-control">
            <span>源语言</span>
            <select v-model="config.from" :disabled="translating" aria-label="文档源语言">
              <option v-for="item in sourceLanguageOptions" :key="item.value" :value="item.value" data-i18n-ignore>{{ item.value === 'auto' ? translateLegacy(item.label) : getMultilingualTargetLanguageLabel(item.value, item.label, language) }}</option>
            </select>
          </label>
          <span class="language-arrow" aria-hidden="true">→</span>
          <label class="language-control">
            <span>目标语言</span>
            <select v-model="config.to" :disabled="translating" aria-label="文档目标语言">
              <option v-for="item in options.to" :key="item.value" :value="item.value" data-i18n-ignore>{{ getMultilingualTargetLanguageLabel(item.value, item.label, language) }}</option>
            </select>
          </label>
          <label class="service-control">
            <span>翻译服务</span>
            <select v-model="config.documentService" :disabled="translating" aria-label="文档翻译服务">
              <option v-if="documentServiceUnavailableMessage" :value="config.documentService" disabled>Chrome内置AI翻译（当前浏览器不可用）</option>
              <option v-for="item in serviceOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label v-if="documentUsesModel" class="model-control">
            <span class="model-control-heading">模型<button v-if="!documentIsCustomOpenAIProvider" type="button" @click.prevent="openSettings">管理模型 ↗</button></span>
            <select v-model="selectedDocumentModel" :disabled="translating" aria-label="文档翻译模型">
              <option v-for="model in documentModelOptions" :key="model" :value="model" data-i18n-ignore>{{ model }}</option>
            </select>
          </label>
        </div>
        <GlossaryLibrarySelect
          v-if="config.glossaryLibraries.length || config.glossaryEnabled"
          v-model="config.documentGlossaryIds"
          :libraries="config.glossaryLibraries"
          :enabled="config.glossaryEnabled"
          :unsupported="!supportsTranslationGlossary(config.documentService, selectedDocumentModel)"
          :disabled="translating"
        />
        <p v-if="credentialWarning" class="notice warning" role="alert">{{ credentialWarning }} <button type="button" @click="openSettings">去配置</button></p>
        <p v-if="settingsChanged" class="notice warning">设置已更改。现有译文仍保留，按新设置翻译会从头开始。</p>
        <p class="setup-privacy">文件在本地解析，文字发送至所选服务。</p>
        </section>
        <p v-if="errorMessage" class="notice error" role="alert">{{ errorMessage }}</p>

        <div class="progress-panel" :class="{ complete: translationComplete }" aria-live="polite">
          <div class="progress-copy"><strong class="document-status" role="status">{{ statusLabel }}</strong><span>{{ progress }}%</span></div>
          <div class="progress-track" role="progressbar" aria-label="文档翻译进度" :aria-valuenow="progress" :aria-valuemin="0" :aria-valuemax="100"><i :style="{ width: `${progress}%` }" /></div>
        </div>

        <p class="sidebar-progress-count">{{ t('document.progressSegments', {completed: completedSegments, total: parsedDocument.segments.length}) }}</p>
        <p class="sidebar-status-hint">{{ statusHint }}</p>
          <div class="translation-actions">
            <button v-if="translating" class="ghost-button pause-button" type="button" @click="pauseTranslation">暂停翻译</button>
            <button v-else class="translate-document-button" :class="{ 'is-secondary': translationComplete }" type="button" :disabled="!hydrated || preparingDownload || Boolean(credentialWarning)" @click="requestTranslation">
              {{ translationActionLabel }}<span aria-hidden="true"> →</span>
            </button>
          </div>

        <p class="sidebar-save-note" role="status">{{ downloadNotice || '译文仅保留在本页，请下载后再离开。' }}</p>
        </aside>
        <article class="document-reading-pane" aria-label="文档内容">
        <div class="reader-toolbar">
          <div class="mode-buttons reader-tabs" role="group" aria-label="文档工作区">
            <button type="button" :class="{ selected: readerTab === 'read' }" :aria-pressed="readerTab === 'read'" @click="readerTab = 'read'">阅读</button>
            <button type="button" :class="{ selected: readerTab === 'edit' }" :aria-pressed="readerTab === 'edit'" @click="readerTab = 'edit'">校订译文</button>
          </div>
          <div v-if="readerTab === 'read'" class="mode-buttons" role="group" aria-label="阅读方式">
            <button v-for="mode in readingModes" :key="mode.value" type="button" :class="{ selected: effectivePreviewMode === mode.value }" :aria-pressed="effectivePreviewMode === mode.value" :disabled="!hasTranslation && mode.value !== 'source'" @click="previewMode = mode.value">{{ mode.label }}</button>
          </div>
          <button class="download-button" type="button" :disabled="!hasTranslation || translating || preparingDownload" @click="openDownload">下载文件 ↓</button>
        </div>
        <DocumentSegmentEditor v-show="readerTab === 'edit'" :document="parsedDocument" :translations="translatedSegments" :disabled="translating || preparingDownload" @update="editSegment" />
        <div v-show="readerTab === 'read'" class="reading-content">
        <div class="preview-heading"><div><span class="eyebrow">{{ previewMeta.eyebrow }}</span><h2>{{ previewMeta.title }}</h2></div><span class="preview-hint">{{ previewMeta.hint }}</span></div>
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
              <select v-model.number="pdfZoom" aria-label="PDF 预览缩放">
                <option :value="1">适合宽度</option>
                <option :value="1.25">125%</option>
                <option :value="1.5">150%</option>
              </select>
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
                    <img v-if="pdfPage.originalUrl" :src="pdfPage.originalUrl" :alt="`PDF 原文第 ${pdfPage.pageNumber} 页`" />
                    <span v-else class="pdf-page-loading">正在渲染原页…</span>
                  </div>
                </figure>
                <figure v-if="effectivePreviewMode !== 'source'" class="pdf-page-column translated">
                  <figcaption><span>译文</span><strong>保留原版式</strong></figcaption>
                  <div class="pdf-page-frame" :style="{ aspectRatio: `${pdfPage.width} / ${pdfPage.height}` }">
                    <img v-if="pdfPage.translatedUrl" :src="pdfPage.translatedUrl" :alt="`PDF 译文第 ${pdfPage.pageNumber} 页`" />
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
            :title="`${parsedDocument.label}排版阅读预览`"
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
                <p v-if="effectivePreviewMode !== 'source'" class="docx-translation document-translation" data-i18n-ignore>{{ row.translation || '等待翻译…' }}</p>
              </section>
            </article>
          </div>
        </section>

        <section
          v-else-if="isSubtitleDocument"
          class="subtitle-document-reader"
          data-document-reader="subtitle"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="字幕时间轴翻译表格"
        >
          <div class="subtitle-table-scroll">
            <table>
              <thead><tr><th>#</th><th>开始时间</th><th>结束时间</th><th v-if="effectivePreviewMode !== 'translated'">原文</th><th v-if="effectivePreviewMode !== 'source'">译文</th></tr></thead>
              <tbody>
                <tr v-for="row in subtitleRows" :key="row.index">
                  <td class="subtitle-index">{{ row.index + 1 }}</td>
                  <td><time>{{ row.timeStart || '—' }}</time></td>
                  <td><time>{{ row.timeEnd || '—' }}</time></td>
                  <td v-if="effectivePreviewMode !== 'translated'"><p class="subtitle-source document-source" data-i18n-ignore>{{ readerText(row.source) }}</p></td>
                  <td v-if="effectivePreviewMode !== 'source'">
                    <p class="subtitle-translation document-translation" data-i18n-ignore>{{ row.translation || '等待翻译…' }}</p>
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
            <p v-if="effectivePreviewMode !== 'source'" class="json-translation document-translation" data-i18n-ignore>{{ row.translation || '等待翻译…' }}</p>
          </article>
        </section>

        <div v-else class="document-reader" data-document-reader="generic" :data-segment-count="parsedDocument.segments.length" :class="`reader-${parsedDocument.format}`" aria-label="文档双语阅读预览">
          <article v-for="row in previewRows" :key="row.index" class="reader-block">
            <span v-if="row.contextLabel" class="reader-context">{{ row.contextLabel }}</span>
            <div v-if="effectivePreviewMode !== 'translated'" class="reader-source document-source" data-i18n-ignore :class="readerSourceClass(row.source)">
              {{ readerText(row.source) }}
            </div>
            <p v-if="effectivePreviewMode !== 'source'" class="reader-translation document-translation" data-i18n-ignore>{{ row.translation || '等待翻译…' }}</p>
          </article>
        </div>
        <p v-if="!hasTranslation" class="reader-empty">
          {{ emptyReaderHint }}
        </p>
        <nav v-if="readerPageCount > 1" class="reader-pagination" aria-label="文档阅读分页"><button type="button" :disabled="readerPage === 1" @click="readerPage--">上一页</button><span>第 {{ readerPage }} / {{ readerPageCount }} 页</span><button type="button" :disabled="readerPage === readerPageCount" @click="readerPage++">下一页</button></nav>
        </div>
        </article>
      </section>
    </main>

    <dialog ref="confirmDialog" class="document-dialog" aria-labelledby="confirm-document-heading" @close="pendingAction = null">
      <h2 id="confirm-document-heading">{{ pendingAction === 'reset' ? '打开另一份文档？' : '重新翻译这份文档？' }}</h2>
      <p>{{ pendingAction === 'reset' ? '当前翻译和校订结果只保留在本页，离开后无法恢复。建议先下载需要的结果。' : '重新翻译会替换现有译文和人工校订。你也可以返回并先下载当前结果。' }}</p>
      <div class="dialog-actions"><button class="ghost-button" type="button" autofocus @click="confirmDialog?.close()">返回文档</button><button class="translate-document-button" type="button" @click="confirmAction">{{ pendingAction === 'reset' ? '打开新文件' : '重新翻译' }}</button></div>
    </dialog>
    <dialog ref="downloadDialog" class="document-dialog" aria-labelledby="download-document-heading" :aria-busy="preparingDownload" @cancel="preparingDownload && $event.preventDefault()">
      <h2 id="download-document-heading">下载翻译结果</h2><p>保留原文件格式，选择适合你的阅读方式。</p>
      <div class="export-options" role="group" aria-label="下载内容">
        <button type="button" :disabled="preparingDownload" :aria-pressed="outputMode === 'bilingual'" :class="{ selected: outputMode === 'bilingual' }" @click="outputMode = 'bilingual'"><strong>双语对照</strong><span>{{ isPdfDocument ? '原页与译页左右并排' : '同时保留原文和译文' }}</span></button>
        <button type="button" :disabled="preparingDownload" :aria-pressed="outputMode === 'translated'" :class="{ selected: outputMode === 'translated' }" @click="outputMode = 'translated'"><strong>仅译文</strong><span>适合直接阅读和分享</span></button>
      </div>
      <p v-if="!translationComplete" class="notice warning">还有 {{ (parsedDocument?.segments.length || 0) - completedSegments }} 段未翻译，这些位置会保留原文。</p>
      <label v-if="!translationComplete" class="partial-export"><input v-model="partialExportAcknowledged" type="checkbox" :disabled="preparingDownload" />我已了解，下载当前结果</label>
      <p v-if="isPdfDocument" class="export-note">PDF 译页以图像呈现，适合保留版面阅读，暂不支持复制译文。</p>
      <p v-if="downloadError" class="notice error" role="alert">{{ downloadError }}</p>
      <div class="dialog-actions"><button class="ghost-button" type="button" :disabled="preparingDownload" @click="downloadDialog?.close()">返回文档</button><button class="translate-document-button" type="button" :disabled="preparingDownload || (!translationComplete && !partialExportAcknowledged)" @click="downloadDocument">{{ preparingDownload ? '正在生成文件…' : `下载${outputMode === 'bilingual' ? '双语' : '译文'}文件` }}</button></div>
    </dialog>
    <footer v-if="!parsedDocument" class="document-footer">
      <span>流畅阅读文档翻译 · PDF / ePub / HTML / JSON / TXT / DOCX / Markdown / 字幕</span>
      <a href="https://github.com/Bistutu/FluentRead" target="_blank" rel="noreferrer">开源项目 ↗</a>
    </footer>
  </div>
</template>

<script lang="ts" setup>
import {computed, onMounted, onUnmounted, reactive, ref, watch} from 'vue';
import DocumentSegmentEditor from './DocumentSegmentEditor.vue';
import browser from 'webextension-polyfill';
import {
  Config,
  buildGlossaryRevision,
  DOCUMENT_MAX_BYTES,
  createDocumentDownload,
  createDocumentFileLoadGuard,
  createDocumentPreviewHtml,
  createPdfPagePreview,
  filterAvailableTranslationServices,
  formatDocumentReaderText,
  getDocumentAcceptAttribute,
  getDocumentEmptyReaderHint,
  getDocumentFormatTone,
  getDocumentFormat,
  getDocumentPreviewMeta,
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
  UiLanguageSelector,
  GlossaryLibrarySelect,
  supportsTranslationGlossary,
  useUiI18n,
  type DocumentRenderMode,
  type ParsedDocument,
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
const sidebarExpanded = ref(false);
const fileSize = ref(0);
const runState = ref<'ready' | 'paused' | 'failed'>('ready');
const taskFingerprint = ref('');
const settledTranslations = ref<string[]>([]);
const confirmDialog = ref<HTMLDialogElement | null>(null);
const downloadDialog = ref<HTMLDialogElement | null>(null);
const pendingAction = ref<'reset' | 'restart' | null>(null);
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
let unsubscribeConfig: (() => void) | undefined;
let pdfPreviewTimer: ReturnType<typeof setTimeout> | undefined;
let pdfPreviewRequest = 0;

const accept = getDocumentAcceptAttribute();
const maxFileSizeLabel = `${Math.round(DOCUMENT_MAX_BYTES / 1024 / 1024)} MB`;
const sourceLanguageOptions = options.from;
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
const documentServiceUnavailableMessage = computed(() => getTranslationServiceUnavailableMessage(config.documentService));
const selectedCustomOpenAIProvider = computed(() => getCustomOpenAIProvider(
  config.customOpenAIProviders,
  config.documentService,
));
const documentIsCustomOpenAIProvider = computed(() => Boolean(selectedCustomOpenAIProvider.value));
const documentUsesModel = computed(() => documentIsCustomOpenAIProvider.value
  || servicesType.isUseModel(config.documentService));
const builtInDocumentModels = computed(() => (models.get(config.documentService) || [])
  .filter((model) => model !== customModelString));
const documentModelOptions = computed(() => {
  if (selectedCustomOpenAIProvider.value) return selectedCustomOpenAIProvider.value.models;
  return Array.from(new Set([
    ...builtInDocumentModels.value,
    ...(config.customModels[config.documentService] || []),
    config.documentModel[config.documentService] === customModelString
      ? config.documentCustomModel[config.documentService] || ''
      : '',
  ].filter(Boolean)));
});
const selectedDocumentModel = computed({
  get: () => documentIsCustomOpenAIProvider.value
    ? config.documentModel[config.documentService] || documentModelOptions.value[0] || ''
    : resolveConfiguredModel(
      config.documentModel[config.documentService],
      config.documentCustomModel[config.documentService],
    ) || documentModelOptions.value[0] || '',
  set: (value: string) => {
    const service = config.documentService;
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
    model: {...config.model, [config.documentService]: config.documentModel[config.documentService]},
    customModel: {...config.customModel, [config.documentService]: config.documentCustomModel[config.documentService]},
  };
  return getMissingCredentialMessage(config.documentService, credentialConfig);
});
const rowForSegment = (segment: ParsedDocument['segments'][number]) => ({
  ...segment, index: segment.id, translation: translatedSegments.value[segment.id] || '',
});
const pageRows = <T,>(rows: readonly T[]) => rows.slice((readerPage.value - 1) * READER_PAGE_SIZE, readerPage.value * READER_PAGE_SIZE);
const previewRows = computed(() => pageRows(parsedDocument.value?.segments || []).map(rowForSegment));
const hasTranslation = computed(() => translatedSegments.value.some((item) => Boolean(item?.trim())));
const completedSegments = computed(() => translatedSegments.value.filter((item) => Boolean(item?.trim())).length);
const translationComplete = computed(() => Boolean(parsedDocument.value && completedSegments.value === parsedDocument.value.segments.length));
const progress = computed(() => parsedDocument.value ? Math.floor(completedSegments.value / parsedDocument.value.segments.length * 100) : 0);
const effectivePreviewMode = computed(() => hasTranslation.value ? previewMode.value : 'source');
const currentFingerprint = computed(() => JSON.stringify({
  from: config.from, to: config.to, service: config.documentService, model: selectedDocumentModel.value,
  glossaryIds: config.documentGlossaryIds, glossaryRevision: buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
}));
const settingsChanged = computed(() => Boolean(taskFingerprint.value && taskFingerprint.value !== currentFingerprint.value));
const translationActionLabel = computed(() => settingsChanged.value ? '按新设置翻译' : translationComplete.value ? '重新翻译' : hasTranslation.value || runState.value === 'paused' ? '继续翻译' : runState.value === 'failed' ? '重试翻译' : '开始翻译');
const statusLabel = computed(() => translating.value ? '正在翻译' : translationComplete.value ? '翻译完成' : runState.value === 'paused' ? '已暂停' : runState.value === 'failed' ? '翻译中断' : hasTranslation.value ? '部分完成' : '准备就绪');
const statusHint = computed(() => translating.value ? '已完成的片段可在「校订译文」中查看，可随时暂停。' : translationComplete.value ? '可阅读、校订并下载结果。' : hasTranslation.value ? '已完成的译文已保留，继续时只翻译剩余内容。' : '先预览原文，确认设置后开始翻译。');
const fileSizeLabel = computed(() => fileSize.value >= 1024 * 1024 ? `${(fileSize.value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(fileSize.value / 1024))} KB`);
const sourceCharacterCount = computed(() => parsedDocument.value?.segments.reduce((sum, segment) => sum + segment.source.length, 0) || 0);
const hasUnsavedWork = computed(() => translating.value || editRevision.value > downloadedRevision.value);
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
const previewMeta = computed(() => getDocumentPreviewMeta(parsedDocument.value));
const emptyReaderHint = computed(() => getDocumentEmptyReaderHint(parsedDocument.value));
const readerPageCount = computed(() => isPdfDocument.value || isRichDocument.value ? 1 : Math.max(1, Math.ceil((isDocxDocument.value ? currentDocxPart.value?.paragraphSegments.length || 0 : parsedDocument.value?.segments.length || 0) / READER_PAGE_SIZE)));
const formatCode = computed(() => parsedDocument.value?.format === 'markdown' ? 'MD' : parsedDocument.value?.format.toUpperCase() || 'FILE');
const formatTone = computed(() => getDocumentFormatTone(parsedDocument.value?.format));

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
  void requestConfigPatch(patch, browser.runtime.sendMessage.bind(browser.runtime)).catch((error) => {
    console.warn('[FluentRead] 保存文档翻译设置失败', error);
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

function showError(message: string): void {
  errorMessage.value = message;

}

async function loadFile(file: File): Promise<void> {
  // 步骤 1：每次选择文件都取得新的提交所有权；无效的新文件也会淘汰仍在解析的旧文件。
  const loadRequest = documentFileLoads.begin();
  errorMessage.value = '';
  if (!getDocumentFormat(file.name)) {
    openingFile.value = false;
    showError('暂不支持该文件格式，请选择 PDF、ePub、HTML、JSON、TXT、DOCX、Markdown 或字幕文件。');
    return;
  }
  if (file.size > DOCUMENT_MAX_BYTES) {
    openingFile.value = false;
    showError(`文件大小超过 ${maxFileSizeLabel}，请先拆分文件后再翻译。`);
    return;
  }

  try {
    openingFile.value = true;
    const parsed = await parseDocumentFile(file);
    // 步骤 2：慢 PDF/ePub 可能晚于后选文件完成；旧请求不得覆盖当前页面状态。
    if (!loadRequest.isCurrent()) return;
    if (parsed.segments.length === 0) throw new Error('文件中没有找到可翻译的文本片段。');
    clearPdfPreviewUrls();
    parsedDocument.value = parsed;
    translatedSegments.value = [];
    outputMode.value = 'bilingual';
    pdfZoom.value = 1;
    epubChapterIndex.value = 0;
    docxPartIndex.value = 0;
    fileSize.value = file.size;
    previewMode.value = 'bilingual';
    readerTab.value = 'read';
    readerPage.value = 1;
    sidebarExpanded.value = false;
    taskFingerprint.value = '';
    runState.value = 'ready';
    editRevision.value = 0;
    downloadedRevision.value = 0;
  } catch (error) {
    if (!loadRequest.isCurrent()) return;
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    if (loadRequest.isCurrent()) openingFile.value = false;
  }
}

function handleFileInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void loadFile(file);
  input.value = '';
}

function handleDrop(event: DragEvent): void {
  isDragging.value = false;
  if ((event.dataTransfer?.files.length || 0) > 1) {
    showError('每次只能打开一个文件，请选择需要翻译的文档。');
    return;
  }
  const file = event.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
}

function resetDocument(): void {
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

function requestReset(): void {
  if (preparingDownload.value) return;
  if (hasUnsavedWork.value) {
    pendingAction.value = 'reset';
    confirmDialog.value?.showModal();
  } else resetDocument();
}

function requestTranslation(): void {
  if (translationComplete.value || (settingsChanged.value && hasTranslation.value)) {
    pendingAction.value = 'restart';
    confirmDialog.value?.showModal();
  } else void startTranslation(settingsChanged.value);
}

function confirmAction(): void {
  const action = pendingAction.value;
  confirmDialog.value?.close();
  if (action === 'reset') resetDocument();
  else if (action === 'restart') void startTranslation(true);
}

function pauseTranslation(): void {
  translationRequestId += 1;
  abortController?.abort();
  abortController = null;
  translating.value = false;
  runState.value = 'paused';
}

async function startTranslation(restart = false): Promise<void> {
  const document = parsedDocument.value;
  if (!document || translating.value || !hydrated.value || preparingDownload.value || credentialWarning.value) return;
  if (restart) {
    translatedSegments.value = [];
    settledTranslations.value = [];
  }
  taskFingerprint.value = currentFingerprint.value;
  const glossaryIds = config.documentGlossaryIds === null ? null : [...config.documentGlossaryIds];
  const glossaryRevision = buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled);
  runState.value = 'ready';
  translating.value = true;
  sidebarExpanded.value = false;
  errorMessage.value = '';
  downloadNotice.value = '';
  const controller = new AbortController();
  const requestId = ++translationRequestId;
  abortController = controller;
  try {
    await translateDocumentSegments(document.segments, {
      fileName: document.fileName,
      serviceOverride: config.documentService,
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
  if (translating.value || preparingDownload.value) return;
  translatedSegments.value[index] = value;
  editRevision.value += 1;
  downloadNotice.value = '';
}

function openDownload(): void {
  partialExportAcknowledged.value = false;
  downloadError.value = '';
  downloadDialog.value?.showModal();
}

async function downloadDocument(): Promise<void> {
  const document = parsedDocument.value;
  if (!document || !hasTranslation.value || translating.value || preparingDownload.value || (!translationComplete.value && !partialExportAcknowledged.value)) return;
  preparingDownload.value = true;
  downloadError.value = '';
  const revision = editRevision.value;
  const requestId = translationRequestId;
  try {
    const download = await createDocumentDownload(document, [...translatedSegments.value], outputMode.value);
    if (document !== parsedDocument.value || requestId !== translationRequestId) return;
    const url = URL.createObjectURL(new Blob([download.data], {type: download.mimeType}));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = download.fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    downloadedRevision.value = revision;
    downloadNotice.value = '已生成下载文件，请在浏览器下载列表中查看。';
    downloadDialog.value?.close();
  } catch (error) {
    if (document === parsedDocument.value) downloadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (document === parsedDocument.value) preparingDownload.value = false;
  }
}

function guardBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedWork.value && !preparingDownload.value) return;
  event.preventDefault();
  event.returnValue = '';
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

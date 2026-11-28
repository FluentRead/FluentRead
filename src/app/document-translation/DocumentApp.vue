<!--
 @file src/app/document-translation/DocumentApp.vue
 协作入口：向已绑定标签页的弹窗公开 PDF 协作开关，回到阅读视图后复验文件身份，拒绝旧文件与卸载后的请求。
 PDF 批注：原文重排与标准 PDF 注释由阅读器呈现；本组合根把批注变更归入当前文件修订，沿用历史保存、冲突检测和隐私窗口边界，不另建存储。
 服务启用：关闭的服务不进入候选，保留独立选择并提示重新启用，翻译动作沿现有可用性检查阻止发送。
 文件职责：实现独立文档翻译页面的完整 Vue 应用与 Scheme C 工作台界面，提供按已提交段落计算的实时数字与进度条、暂停及等待重试状态、微任务批量提交译文、全局键盘快捷键与亮暗主题同步；服务或模型变更时取消旧任务并保留已有译文供续译；未完成或设置待应用时突出翻译，完成后突出下载并保留次级、经确认重新请求服务的重译入口；任务提示按处理优先级在工具栏内紧凑显示，材料恢复与下载反馈保留独立位置，不覆盖正文；承载文件导入、多格式结构化阅读预览、分段翻译、人工校订双向定位、原文结构变化后旧校订的独立保留、保存原文件和双语文件导出的用户流程。
 主要内容：相同译文保留原文且不重复展示；文档打开后以紧凑工具栏承载返回首页、文件名、状态、阅读方式、页码缩放、翻译服务与目标语言、翻译与下载，窄窗口用翻译设置弹窗，移动端侧栏采用抽屉覆盖层保留正文高度；富文本（HTML/Markdown/纯文本/ePub）提供共享阅读外观栏（双栏/上下对照、五套阅读配色、字体切换）与基于 data-segment-id 的原位增量补丁、滚动目录高亮追踪，ePub 惰性加载嵌套目录、章节内嵌图片与净化样式表并提供上下章导航与内部链接跳转；CSV/TSV 提供二维电子表格网格（固定表头/行号、列翻译开关、数值对齐与按行分页）与单元格列表双视图；DOCX 渲染行内粗斜下划线/删除线/代码/超链接、H1-H6 标题层级、列表缩进、不拆表分页与暗色页面；JSON 提供命名空间侧栏目录、占位符高亮分组表格与可折叠语法树；字幕修复 LRC 单时间戳显示、支持 LRC 歌曲元信息、时长与说话人/样式徽章、安全富文本行内样式、叠排/表格双视图与长字幕时间轴目录；阅读与校订器支持双向段落跳转；批量提交译文与懒刷新本地历史减少重排与 IndexedDB 开销；导入、OCR、导出与 PDF 资源均具独立取消所有权与卸载清理。
 OCR 续译：逐页保存识别检查点，暂停或失败后只补剩余扫描页；空结果保留重试入口且不计为全文完成。混合 PDF 按原页和块身份迁移已有译文与人工确认；新增段落继续翻译，明确确认重译后才清空校订。PDF 提取文字含异常控制字符时只提示核对原文，不改写原文或译文；扫描页数字脚标未确认时提供定位原页的核对入口，切换文件后不执行迟到定位。
 原文校订：扫描段落对照原图逐行修改，只使改变的译文失效，旧原文和译文进入既有修订列表；显式重新识别当前页跳过 OCR 缓存，保留唯一同框人工校订与未改页，取消或切换任务拒绝迟到提交。
 下载面板：紧邻工具栏用小幅版式示意选择双语或仅译文，在设置之后提供单一品牌下载主按钮；PDF 排版按需展开，复用现有分段控件并独立于阅读视图，原文件保留次级入口；不重复文件名，未完成时说明原文保留规则并确认一次，失败时保留校订、展示明确重试动作，技术详情默认收起。
 材料接入：按原文件内容指纹加入本机学习工作区，恢复文档页码与章节，重解析后只按唯一原句重新匹配位置；原文件记录缺失时重新选择并核对指纹，不把同名文件误认作原件。
 ePub 范围预览：章节目录在发起翻译前显示每章已译/总片段数；翻译运行中隐藏静态计数，避免显示过期进度。
 请求依据：按本次实际发送批次惰性计算有界篇章证据及本地术语命中来源；文档可单独覆盖全局 AI 上下文偏好，但不改变全局配置，摘要只保留在当前页面。
 模块边界：ChatGPT 套餐模型选项保留全局和文档实际 slug，独立选择也直接保存，不经过自定义模型哨兵或新增发现请求；组件负责页面展示与交互，导入、OCR 与导出生命周期由 feature 控制器持有并经显式端口连接唯一任务模型；所有内部依赖仅经由 src/app/document-translation 唯一出口导入，不自行解析二进制格式、不实现片段翻译队列、配置存储协议或导出编码。
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

    <input ref="fileInput" class="visually-hidden" type="file" multiple :accept="accept" aria-label="选择文件" tabindex="-1" @change="handleFileInput" />
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
        <div v-if="parsedDocument" v-show="activeSidebarTab === 'outline' && isPdfDocument" ref="outlineHost" class="sidebar-outline" @pointerdown.capture="markMaterialReadingIntent" @keydown.capture="markMaterialReadingIntent" />
        <p v-if="parsedDocument && isPdfDocument" v-show="activeSidebarTab === 'outline'" class="sidebar-outline-empty sidebar-outline-pdf-empty">{{ t('document.pdfReading.outlineEmpty') }}</p>
        <nav v-if="parsedDocument && !isPdfDocument && outlineRows.length" v-show="activeSidebarTab === 'outline'" class="sidebar-outline document-outline" @pointerdown.capture="markMaterialReadingIntent" @keydown.capture="markMaterialReadingIntent" :aria-label="t('document.pdfReading.outline')">
          <div v-if="outlineHasLanguageToggle" class="document-outline-language" role="group" :aria-label="t('document.pdfReading.outlineLanguageToggle')">
            <button type="button" :class="{selected: richOutlineLanguage === 'source'}" :aria-pressed="richOutlineLanguage === 'source'" @click="richOutlineLanguage = 'source'">{{ t('document.pdfReading.original') }}</button>
            <button type="button" :class="{selected: richOutlineLanguage === 'translated'}" :aria-pressed="richOutlineLanguage === 'translated'" @click="richOutlineLanguage = 'translated'">{{ t('document.pdfReading.translated') }}</button>
          </div>
          <button v-for="row in outlineRows" :key="row.key" type="button" class="document-outline-item" :class="{chapter: row.isChapter, current: row.current}" :aria-current="row.current ? 'location' : undefined" :aria-label="row.coverage ? `${row.label}, ${t('document.progressSegments', row.coverage)}` : undefined" :style="{paddingLeft: `${12 + (row.level - 1) * 14}px`}" :title="row.title" data-i18n-ignore @click="activateOutlineRow(row)"><span class="document-outline-label">{{ row.label }}</span><small :hidden="!row.coverage" class="document-outline-progress" aria-hidden="true">{{ row.coverage ? `${row.coverage.completed}/${row.coverage.total}` : '' }}</small></button>
        </nav>
        <p v-if="parsedDocument && !isPdfDocument && !outlineRows.length" v-show="activeSidebarTab === 'outline'" class="sidebar-outline-empty">{{ t('document.pdfReading.outlineEmpty') }}</p>
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
          role="button"
          tabindex="0"
          :aria-busy="openingFile"
          aria-label="文档拖放区域"
          @click="handleDropZoneClick"
          @keydown.enter.prevent="openFilePicker"
          @keydown.space.prevent="openFilePicker"
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
        <section v-if="historyLoading || historyError || historyEntries.length" class="document-history" aria-label="最近翻译" :aria-busy="historyLoading">
          <header><h2>最近翻译</h2><button v-if="historyEntries.length" type="button" :disabled="queueBusy || historyMutationPending" @click="clearHistory">清空记录</button></header>
          <p v-if="historyLoading">{{ t('document.historyLoading') }}</p>
          <p v-if="historyError" class="notice warning" role="alert" data-testid="document-history-list-error">{{ t(historyError) }} <button type="button" :disabled="historyLoading || historyMutationPending" @click="refreshHistory">{{ t('document.historyRetry') }}</button></p>
          <ul>
            <li v-for="entry in historyEntries" :key="entry.id">
              <button class="history-open" type="button" :disabled="queueBusy" @click="openHistory(entry)">
                <b>{{ historyFormat(entry) }}</b>
                <span><strong data-i18n-ignore :title="entry.name">{{ entry.name }}</strong><small>{{ historyStatus(entry) }}</small></span>
              </button>
              <button class="history-remove" type="button" :disabled="queueBusy || historyMutationPending" :aria-label="`移除记录 ${entry.name}`" title="移除记录" @click="removeHistory(entry)">×</button>
            </li>
          </ul>
        </section>
        <div class="format-list" aria-label="支持的文件格式">
          <span v-for="item in formatCards" :key="item.code" class="format-card"><b :class="item.tone">{{ item.code }}</b>{{ item.label }}</span>
        </div>
        <p class="local-processing-note">{{ t('document.localProcessingNote') }}</p>
        <details class="document-samples"><summary>没有文件？先用范例试试</summary>
          <div><p>导入后确认设置，再开始翻译。范例也可以校订和下载。</p></div>
          <div class="sample-buttons"><button v-for="sample in DOCUMENT_QUICK_SAMPLES" :key="sample.name" type="button" :disabled="queueBusy" @click="loadSample(sample)"><strong>{{ sample.label }}<span aria-hidden="true"> ↗</span></strong><small>{{ sample.description }}</small></button></div>
        </details>
        <p v-if="importError || errorMessage" class="notice error" role="alert">{{ importError || errorMessage }}</p>
      </section>

      <section v-else class="workspace-section">
        <section class="document-taskbar" :class="{'has-pdf-controls': readerTab === 'read' && isPdfDocument}" aria-label="当前文档与翻译任务">
          <div class="workspace-heading">
            <button class="sidebar-toggle" type="button" :class="{active: sidebarOpen}" :aria-expanded="sidebarOpen" :aria-label="translateLegacy('文件与目录')" :title="translateLegacy('文件与目录')" @click="sidebarOpen = !sidebarOpen"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M7.5 3.5v13" stroke="currentColor" stroke-width="1.4"/></svg><small v-if="documentQueue.length > 1">{{ documentQueue.length }}</small></button>
            <button class="taskbar-home-button" type="button" :aria-label="t('document.pdfReading.homeBack')" :title="t('document.pdfReading.homeBack')" :disabled="openingFile || preparingDownload || batchRunning" @click="requestReset"><img class="taskbar-logo" src="/icon/128.png" alt="" /></button>
            <div class="file-heading"><div><h1 data-i18n-ignore :title="documentHeading">{{ documentHeading }}</h1><p class="document-status" role="status">{{ statusLabel }}<span v-if="showTranslationProgress" class="document-translation-count" data-testid="document-translation-count">{{ translationProgressLabel }}</span></p>
              <a v-if="articleSourceUrl" class="article-source-link" :href="articleSourceUrl" target="_blank" rel="noopener noreferrer" data-testid="web-article-source">{{ translateLegacy('查看原网页') }}</a>
            </div></div>
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
            <div v-if="readerTab === 'read' && !isPdfDocument" class="document-zoom-control" role="group" :aria-label="t('document.readerZoom.label')">
              <button type="button" :disabled="readerScale <= .5" :aria-label="t('document.pdfReading.zoomOut')" :title="t('document.pdfReading.zoomOut')" @click="stepReaderZoom(-1)">−</button>
              <button type="button" class="document-zoom-reset" data-document-zoom :aria-label="t('document.readerZoom.reset')" :title="t('document.readerZoom.hint')" @click="resetReaderZoom">{{ Math.round(readerScale * 100) }}%</button>
              <button type="button" :disabled="readerScale >= 3" :aria-label="t('document.pdfReading.zoomIn')" :title="t('document.pdfReading.zoomIn')" @click="stepReaderZoom(1)">+</button>
            </div>
            <button class="focus-toggle" type="button" :aria-label="translateLegacy('专注阅读')" :title="translateLegacy('专注阅读')" @click="setFocusMode(true)"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7.5 3.5h-4v4M12.5 3.5h4v4M7.5 16.5h-4v-4M12.5 16.5h4v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <button v-if="config.on && !materialPrivate" class="ghost-button material-save-button" type="button" :disabled="materialSaving || !activeTask?.historyId" @click="saveDocumentMaterial">{{ materialSaving ? '保存中…' : documentMaterialId ? '更新学习位置' : '加入学习材料' }}</button>
            </div>
          </div>
          <!-- 独立的 PDF 工具组接收阅读器控件，桌面与任务操作同排，窄屏再按可用空间换行。 -->
          <div v-show="readerTab === 'read' && isPdfDocument" ref="readerControls" class="reader-controls-slot" @pointerdown.capture="markMaterialReadingIntent" @keydown.capture="markMaterialReadingIntent" />
          <div class="taskbar-actions">
            <!-- 宽窗口直接在工具栏选择服务、模型与目标语言，窄窗口打开既有翻译设置弹窗；源语言和术语库在侧栏底部的“调整设置”里。 -->
            <div class="toolbar-translation-settings">
            <label class="toolbar-field"><span>翻译服务</span><ElSelect class="document-select toolbar-select toolbar-service" :wrap-label="false" :show-search-icon="false" append-to=".document-app" v-model="config.documentService" :empty-values="[null, undefined]" :disabled="queueBusy" aria-label="翻译服务" filterable>
              <ElOption :label="followDefaultLabel" value="" />
              <ElOption v-if="config.documentService && documentServiceUnavailableMessage" :value="config.documentService" disabled :label="unavailableDocumentServiceLabel" />
              <ElOption v-for="item in serviceOptions" :key="item.value" :value="item.value" :label="translateLegacy(item.label)" />
            </ElSelect></label>
            <label class="toolbar-field"><span>目标语言</span><ElSelect class="document-select toolbar-select toolbar-language" :wrap-label="false" :show-search-icon="false" append-to=".document-app" v-model="config.to" :disabled="queueBusy" aria-label="目标语言" filterable>
              <ElOption v-for="item in options.to" :key="item.value" :value="item.value" :label="translateLegacy(item.label)" />
            </ElSelect></label>
            <label v-if="documentUsesModel" class="toolbar-field"><span>模型</span><ElSelect class="document-select toolbar-select toolbar-model" :wrap-label="false" :show-search-icon="false" append-to=".document-app" v-model="selectedDocumentModel" :disabled="queueBusy" aria-label="模型" filterable>
              <ElOption v-for="model in documentModelOptions" :key="model" :value="model" data-i18n-ignore :label="model" />
            </ElSelect></label>
            </div>
            <div class="toolbar-primary-actions" :data-primary-action="downloadIsPrimary ? 'download' : 'translate'">
            <ElSelect v-if="parsedDocument.delimitedColumns" class="document-select delimited-column-picker" data-testid="document-column-picker" :aria-label="t('document.delimited.columns')" :placeholder="t('document.delimited.columns')" :model-value="selectedDelimitedColumns" :disabled="queueBusy" :fit-input-width="false" :wrap-label="false" :show-search-icon="false" popper-class="document-column-options" append-to=".document-app" multiple filterable @update:model-value="updateDelimitedColumns">
              <template #tag><span class="delimited-column-count">{{ t('document.delimited.count', {selected: selectedDelimitedColumns.length, total: parsedDocument.delimitedColumns.length}) }}</span></template>
              <ElOption v-for="column in parsedDocument.delimitedColumns" :key="column.index" :value="column.index" :label="delimitedColumnLabel(column)" :disabled="selectedDelimitedColumns.length === 1 && selectedDelimitedColumns[0] === column.index" />
            </ElSelect>
            <button class="ghost-button toolbar-settings-toggle" type="button" :title="translationSettingsSummary" @click="openDocumentSettings">{{ translateLegacy('翻译设置') }}</button>
            <button ref="downloadButton" class="download-button" type="button" aria-haspopup="dialog" aria-controls="document-download-panel" :aria-expanded="downloadOpen" :disabled="!originalDownloadSource && (!hasTranslation || queueBusy)" @click="openDownload">{{ downloadCopy.download }}<UiIcon name="chevron-down" :size="14" /></button>
            <div class="translation-actions">
              <button v-if="translating" class="ghost-button pause-button" type="button" @click="pauseTranslation"><i class="spinner dark-spinner" aria-hidden="true" />暂停翻译</button>
              <button v-else-if="activeSegments.length || needsOcr" class="translate-document-button" type="button" :disabled="!config.on || !hydrated || queueBusy || Boolean(credentialWarning)" @click="requestTranslation">{{ translationActionLabel }}</button>
            </div>
            </div>
          </div>
          <div v-if="showTranslationProgress" class="task-progress" :class="{ complete: translationComplete, 'is-idle': progress === 0 && !translating }" role="progressbar" :aria-label="t('document.translationProgress.label')" :aria-valuetext="translationProgressLabel" :aria-valuenow="progress" :aria-valuemin="0" :aria-valuemax="100" data-testid="document-translation-progress"><i :style="{width: `${progress}%`}" /></div>
          <!-- 持续状态占据正常布局；当前翻译只显示最需要处理的一条，独立导入始终保留取消入口。 -->
          <div class="taskbar-notices" data-testid="document-task-notices">
          <p v-if="importError" class="notice error task-notice" role="alert">{{ importError }}</p>
          <p v-if="activeTask?.historyReadUnavailable || activeTask?.historyConflict" class="notice warning task-notice" role="alert" data-testid="document-history-unavailable">{{ t(activeTask.historyConflict ? 'document.historyConflict' : 'document.historyReadUnavailable') }} <button type="button" :disabled="queueBusy" @click="retryDocumentHistory">{{ t('document.historyRetry') }}</button></p>
          <p v-if="openingFile || downloadingPdf" class="document-import-progress" role="status">{{ importProgress }} <button class="ghost-button" type="button" @click="cancelImport">{{ t('document.pdfReading.cancelImport') }}</button></p>
          <p v-if="pdfSourceCharacterWarning" class="notice warning task-notice" role="status" data-testid="document-pdf-source-warning">{{ t('document.pdfReading.sourceCharacterWarning') }}</p>
          <p v-if="pdfOcrReviewPages.length" class="notice warning task-notice" role="status" data-testid="document-pdf-ocr-review">{{ t('document.pdfReading.ocrReview', {count: pdfOcrReviewPages.length}) }} <button type="button" class="ghost-button" @click="reviewPdfOcrSource">{{ t('document.pdfReading.reviewOriginal') }}</button></p>
          <p v-if="configSaveError || credentialWarning" class="notice error task-notice" role="alert">{{ configSaveError || credentialWarning }} <button type="button" @click="documentSettingsDialog?.showModal()">调整设置</button></p>
          <div v-else-if="translationFailureVisible" class="translation-recovery" role="alert" data-testid="document-translation-recovery">
            <span class="recovery-message">{{ documentFailureSummary(errorMessage) }}</span>
            <button class="recovery-service" type="button" @click="translating ? pauseAndChangeService() : openDocumentSettings()">{{ t('document.translationRecovery.switchService') }}</button>
            <details :key="errorMessage" class="recovery-details"><summary>{{ t('document.translationRecovery.details') }}</summary><p class="recovery-error-detail" data-i18n-ignore>{{ errorMessage }}</p></details>
          </div>
          <div v-else-if="retryNotice" class="translation-recovery" role="status">
            <span class="recovery-message">{{ documentFailureSummary(retryNotice) }}</span>
            <button v-if="translating && retryWaiting" class="recovery-service" type="button" @click="pauseAndChangeService">{{ t('document.translationRecovery.switchService') }}</button>
            <details :key="retryNotice" class="recovery-details"><summary>{{ t('document.translationRecovery.details') }}</summary><p class="recovery-error-detail" data-i18n-ignore>{{ retryNotice }}</p></details>
          </div>
          <p v-else-if="errorMessage" class="notice error task-notice" role="alert">{{ errorMessage }}</p>
          <p v-else-if="settingsChanged && !pendingGlossaryRetranslation" class="notice warning task-notice" role="status">设置已更改。现有译文保留，按新设置翻译会从头开始。</p>
          <button v-if="pendingGlossaryRetranslation && !queueBusy" class="ghost-button task-notice" type="button" @click="resumeGlossaryRetranslation">{{ glossaryCopy.retry }}</button>
          <p v-if="glossaryNotice" class="notice task-notice" role="status">{{ glossaryNotice }}</p>
          <details v-if="requestEvidence" class="document-request-evidence" data-testid="document-request-evidence">
            <summary><span>{{ t('document.requestEvidence.title') }}</span><small>{{ t('document.requestEvidence.summary', {segments: requestEvidence.segmentCount, context: requestEvidence.contextItems.length, glossaryHits: requestEvidence.glossaryOccurrences}) }}</small></summary>
            <div class="document-request-evidence-body">
              <p class="document-request-location">{{ t('document.requestEvidence.location', {section: requestEvidence.section || t('document.requestEvidence.currentSection'), positions: requestEvidence.positions.join(' · ') || t('document.requestEvidence.currentBatch')}) }}</p>
              <p v-if="!requestEvidence.contextEnabled" class="document-request-empty">{{ t('document.requestEvidence.contextDisabled') }}</p>
              <p v-else-if="!requestEvidence.contextItems.length" class="document-request-empty">{{ t('document.requestEvidence.contextEmpty') }}</p>
              <ul v-else class="document-request-context-list">
                <li v-for="item in requestEvidence.contextItems" :key="`${item.kind}:${item.blockId}:${item.position}`">
                  <strong>{{ requestEvidenceKindLabel(item.kind) }}</strong><small>{{ item.position || item.section }}</small>
                  <p data-i18n-ignore>{{ item.source }}</p>
                  <p v-if="item.translation" class="document-request-evidence-translation">{{ t('document.requestEvidence.translation', {text: item.translation}) }}</p>
                </li>
              </ul>
              <p v-if="requestEvidence.glossaryOccurrences" class="document-request-glossary-summary">{{ t('document.requestEvidence.glossarySummary', {occurrences: requestEvidence.glossaryOccurrences, terms: requestEvidence.glossaryTermCount, libraries: requestEvidence.glossaryLibraryCount}) }}</p>
              <p v-else class="document-request-empty">{{ t('document.requestEvidence.glossaryNone') }}</p>
              <ul v-if="requestEvidence.glossaryTerms.length" class="document-request-glossary-list">
                <li v-for="term in requestEvidence.glossaryTerms" :key="`${term.library}:${term.source}:${term.target}`"><small>{{ term.library }}</small><span>{{ term.source }} → {{ term.target }}</span><b>{{ term.occurrences }}×</b></li>
              </ul>
              <p v-if="requestEvidence.omittedGlossaryTerms" class="document-request-empty">{{ t('document.requestEvidence.moreGlossaryTerms', {count: requestEvidence.omittedGlossaryTerms}) }}</p>
            </div>
          </details>
          <p v-if="downloadNotice" class="taskbar-toast" role="status">{{ downloadNotice }}</p>
          </div>
        </section>
        <article class="document-reading-pane" aria-label="文档内容">
        <DocumentSegmentEditor v-if="editorRequested" :key="activeDocumentId ?? 0" v-show="readerTab === 'edit'" :active="readerTab === 'edit'" :focus-segment-id="editorFocusSegmentId" :document="parsedDocument" :translations="translatedSegments" :scope-ids="columnScope" :retained-revisions="documentQueue.find(item => item.id === activeDocumentId)?.retainedRevisions" :disabled="queueBusy" @update="editSegment" @source-edit="openSourceEditor" @locate-segment="locateSegmentInReader" @focus-handled="editorFocusSegmentId = null" />
        <div v-show="readerTab === 'read'" ref="readingContent" class="reading-content" :class="{'reading-pdf': isPdfDocument}" :data-fluentread-material-fingerprint="activeTask?.historyId || undefined" :data-fluentread-material-title="parsedDocument.fileName" :data-fluentread-material-source="activeTask?.sourceUrl || undefined" :data-fluentread-material-page="isPdfDocument ? pdfPage : readerPage" :data-fluentread-material-section="isEpubDocument ? `epub:${epubChapterIndex}` : isDocxDocument ? `docx:${docxPartIndex}` : undefined" :data-reader-zoom="isPdfDocument ? undefined : readerScale" :tabindex="isPdfDocument || isRichDocument ? undefined : 0" @pointerdown="materialReadingPointerDown" @wheel.passive="markMaterialReadingIntent" @keydown.capture="markMaterialReadingIntent">
        <PdfReader
          ref="materialPdfReader"
          v-if="isPdfDocument"
          :key="activeDocumentId ?? 0"
          :document="parsedDocument"
          :translations="translatedSegments"
          :annotations="activeTask?.pdfAnnotations ?? []"
          :annotation-storage-unavailable="!historyAvailable || activeTask?.historyVersion === undefined || !!(activeTask.historyReadUnavailable || activeTask.historyConflict)"
          @update:annotations="updatePdfAnnotations"
          v-model:presentation="pdfPresentation"
          :mode="effectivePreviewMode"
          :translating="translating"
          :loading-style="config.translationLoadingStyle"
          :animated="config.animations"
          :controls-target="readerControls"
          :outline-target="outlineHost"
          :source-url="documentQueue.find(item => item.id === activeDocumentId)?.sourceUrl"
          @page-change="pdfPage = $event"
          @material-position-change="queueMaterialPositionCapture"
          @source-edit="openSourceEditor"
          :information-highlight="pdfInformationHighlight"
        />

        <section
          v-else-if="isRichDocument"
          class="rich-document-reader"
          :class="`reader-${parsedDocument.format}`"
          data-document-reader="rich"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="排版文档双语阅读预览"
        >
          <div class="rich-appearance-bar" role="toolbar" :aria-label="t('document.pdfReading.readingAppearance')">
            <div v-if="effectivePreviewMode === 'bilingual'" class="appearance-group" role="group" :aria-label="t('document.pdfReading.presentationLabel')">
              <button type="button" :class="{selected: richBilingualLayout === 'split'}" :aria-pressed="richBilingualLayout === 'split'" @click="richBilingualLayout = 'split'">{{ t('document.pdfReading.bilingualSplit') }}</button>
              <button type="button" :class="{selected: richBilingualLayout === 'stacked'}" :aria-pressed="richBilingualLayout === 'stacked'" @click="richBilingualLayout = 'stacked'">{{ t('document.pdfReading.bilingualStacked') }}</button>
            </div>
            <div class="appearance-group appearance-themes" role="group" :aria-label="t('document.pdfReading.theme')">
              <button v-for="theme in richThemeChoices" :key="theme.value" type="button" :class="{selected: richReadingTheme === theme.value}" :data-theme-swatch="theme.value" :aria-pressed="richReadingTheme === theme.value" @click="richReadingTheme = theme.value">{{ theme.label }}</button>
            </div>
            <div class="appearance-group" role="group" :aria-label="t('document.pdfReading.styleFont')">
              <button type="button" :class="{selected: richFontFamily === 'sans'}" :aria-pressed="richFontFamily === 'sans'" @click="richFontFamily = 'sans'">{{ t('document.pdfReading.styleFont.sans') }}</button>
              <button type="button" :class="{selected: richFontFamily === 'serif'}" :aria-pressed="richFontFamily === 'serif'" @click="richFontFamily = 'serif'">{{ t('document.pdfReading.styleFont.serif') }}</button>
            </div>
          </div>
          <iframe
            ref="richFrame"
            class="rich-preview-frame"
            :srcdoc="richFrameHtml"
            sandbox="allow-same-origin"
            @load="handleRichFrameLoad"
            :title="t('document.layoutPreview', {format: parsedDocument.label})"
          />
          <nav v-if="isEpubDocument && epubChapters.length > 1" class="epub-chapter-nav" :aria-label="t('document.pdfReading.outline')">
            <button type="button" class="ghost-button" :disabled="epubChapterIndex <= 0" @click="stepEpubChapter(-1)">{{ t('document.pdfReading.prevChapter') }}</button>
            <span class="epub-chapter-counter">{{ epubChapterIndex + 1 }} / {{ epubChapters.length }}</span>
            <button type="button" class="ghost-button" :disabled="epubChapterIndex >= epubChapters.length - 1" @click="stepEpubChapter(1)">{{ t('document.pdfReading.nextChapter') }}</button>
          </nav>
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
              <template v-for="block in currentDocxPaginated.blocks" :key="block.key">
                <div v-if="block.kind === 'table'" class="docx-table-scroll">
                  <table class="docx-table">
                    <thead v-if="block.rows.some(row => row.isHeader)">
                      <tr v-for="row in block.rows.filter(item => item.isHeader)" :key="`h-${row.rowIndex}`">
                        <th v-for="(cell, cellIndex) in row.cells" :key="cellIndex" :colspan="cell.colspan > 1 ? cell.colspan : undefined">
                          <section v-for="p in cell.paragraphs" :key="p.segmentIndex" class="docx-paragraph" :class="[`docx-role-${p.role}`, {'is-list-ordered': p.listOrdered}]" :data-segment="p.segmentIndex" :data-heading-level="p.headingLevel" :data-list-level="p.listLevel" @dblclick="editSegmentInProofread(p.segmentIndex)">
                            <p v-if="docxParagraphShowsSource(p)" class="docx-source document-source" data-i18n-ignore><template v-for="(run, ri) in p.sourceRuns" :key="ri"><a v-if="run.href" class="docx-inline-link" :class="docxRunClasses(run)" :href="run.href" :target="run.href.startsWith('#') ? undefined : '_blank'" :rel="run.href.startsWith('#') ? undefined : 'noopener noreferrer'">{{ run.text }}</a><code v-else-if="run.code" class="docx-inline-code" :class="docxRunClasses(run)">{{ run.text }}</code><strong v-else-if="run.bold" :class="docxRunClasses(run)">{{ run.text }}</strong><em v-else-if="run.italic" :class="docxRunClasses(run)">{{ run.text }}</em><u v-else-if="run.underline" :class="docxRunClasses(run)">{{ run.text }}</u><s v-else-if="run.strike" :class="docxRunClasses(run)">{{ run.text }}</s><template v-else>{{ run.text }}</template></template></p>
                            <p v-if="docxParagraphShowsTranslation(p)" class="docx-translation document-translation" data-i18n-ignore><template v-if="p.translationRuns.length"><template v-for="(run, ri) in p.translationRuns" :key="ri"><a v-if="run.href" class="docx-inline-link" :class="docxRunClasses(run)" :href="run.href" :target="run.href.startsWith('#') ? undefined : '_blank'" :rel="run.href.startsWith('#') ? undefined : 'noopener noreferrer'">{{ run.text }}</a><code v-else-if="run.code" class="docx-inline-code" :class="docxRunClasses(run)">{{ run.text }}</code><strong v-else-if="run.bold" :class="docxRunClasses(run)">{{ run.text }}</strong><em v-else-if="run.italic" :class="docxRunClasses(run)">{{ run.text }}</em><u v-else-if="run.underline" :class="docxRunClasses(run)">{{ run.text }}</u><s v-else-if="run.strike" :class="docxRunClasses(run)">{{ run.text }}</s><template v-else>{{ run.text }}</template></template></template><template v-else>{{ p.translationText || t('document.pdfReading.waitingTranslation') }}</template></p>
                          </section>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in block.rows.filter(item => !item.isHeader)" :key="`b-${row.rowIndex}`">
                        <td v-for="(cell, cellIndex) in row.cells" :key="cellIndex" :colspan="cell.colspan > 1 ? cell.colspan : undefined">
                          <section v-for="p in cell.paragraphs" :key="p.segmentIndex" class="docx-paragraph" :class="[`docx-role-${p.role}`, {'is-list-ordered': p.listOrdered}]" :data-segment="p.segmentIndex" :data-heading-level="p.headingLevel" :data-list-level="p.listLevel" @dblclick="editSegmentInProofread(p.segmentIndex)">
                            <p v-if="docxParagraphShowsSource(p)" class="docx-source document-source" data-i18n-ignore><template v-for="(run, ri) in p.sourceRuns" :key="ri"><a v-if="run.href" class="docx-inline-link" :class="docxRunClasses(run)" :href="run.href" :target="run.href.startsWith('#') ? undefined : '_blank'" :rel="run.href.startsWith('#') ? undefined : 'noopener noreferrer'">{{ run.text }}</a><code v-else-if="run.code" class="docx-inline-code" :class="docxRunClasses(run)">{{ run.text }}</code><strong v-else-if="run.bold" :class="docxRunClasses(run)">{{ run.text }}</strong><em v-else-if="run.italic" :class="docxRunClasses(run)">{{ run.text }}</em><u v-else-if="run.underline" :class="docxRunClasses(run)">{{ run.text }}</u><s v-else-if="run.strike" :class="docxRunClasses(run)">{{ run.text }}</s><template v-else>{{ run.text }}</template></template></p>
                            <p v-if="docxParagraphShowsTranslation(p)" class="docx-translation document-translation" data-i18n-ignore><template v-if="p.translationRuns.length"><template v-for="(run, ri) in p.translationRuns" :key="ri"><a v-if="run.href" class="docx-inline-link" :class="docxRunClasses(run)" :href="run.href" :target="run.href.startsWith('#') ? undefined : '_blank'" :rel="run.href.startsWith('#') ? undefined : 'noopener noreferrer'">{{ run.text }}</a><code v-else-if="run.code" class="docx-inline-code" :class="docxRunClasses(run)">{{ run.text }}</code><strong v-else-if="run.bold" :class="docxRunClasses(run)">{{ run.text }}</strong><em v-else-if="run.italic" :class="docxRunClasses(run)">{{ run.text }}</em><u v-else-if="run.underline" :class="docxRunClasses(run)">{{ run.text }}</u><s v-else-if="run.strike" :class="docxRunClasses(run)">{{ run.text }}</s><template v-else>{{ run.text }}</template></template></template><template v-else>{{ p.translationText || t('document.pdfReading.waitingTranslation') }}</template></p>
                          </section>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <section v-else class="docx-paragraph" :class="[`docx-role-${block.paragraph.role}`, {'is-list-ordered': block.paragraph.listOrdered}]" :data-segment="block.paragraph.segmentIndex" :data-heading-level="block.paragraph.headingLevel" :data-list-level="block.paragraph.listLevel" @dblclick="editSegmentInProofread(block.paragraph.segmentIndex)">
                  <p v-if="docxParagraphShowsSource(block.paragraph)" class="docx-source document-source" data-i18n-ignore><template v-for="(run, ri) in block.paragraph.sourceRuns" :key="ri"><a v-if="run.href" class="docx-inline-link" :class="docxRunClasses(run)" :href="run.href" :target="run.href.startsWith('#') ? undefined : '_blank'" :rel="run.href.startsWith('#') ? undefined : 'noopener noreferrer'">{{ run.text }}</a><code v-else-if="run.code" class="docx-inline-code" :class="docxRunClasses(run)">{{ run.text }}</code><strong v-else-if="run.bold" :class="docxRunClasses(run)">{{ run.text }}</strong><em v-else-if="run.italic" :class="docxRunClasses(run)">{{ run.text }}</em><u v-else-if="run.underline" :class="docxRunClasses(run)">{{ run.text }}</u><s v-else-if="run.strike" :class="docxRunClasses(run)">{{ run.text }}</s><template v-else>{{ run.text }}</template></template></p>
                  <p v-if="docxParagraphShowsTranslation(block.paragraph)" class="docx-translation document-translation" data-i18n-ignore><template v-if="block.paragraph.translationRuns.length"><template v-for="(run, ri) in block.paragraph.translationRuns" :key="ri"><a v-if="run.href" class="docx-inline-link" :class="docxRunClasses(run)" :href="run.href" :target="run.href.startsWith('#') ? undefined : '_blank'" :rel="run.href.startsWith('#') ? undefined : 'noopener noreferrer'">{{ run.text }}</a><code v-else-if="run.code" class="docx-inline-code" :class="docxRunClasses(run)">{{ run.text }}</code><strong v-else-if="run.bold" :class="docxRunClasses(run)">{{ run.text }}</strong><em v-else-if="run.italic" :class="docxRunClasses(run)">{{ run.text }}</em><u v-else-if="run.underline" :class="docxRunClasses(run)">{{ run.text }}</u><s v-else-if="run.strike" :class="docxRunClasses(run)">{{ run.text }}</s><template v-else>{{ run.text }}</template></template></template><template v-else>{{ block.paragraph.translationText || t('document.pdfReading.waitingTranslation') }}</template></p>
                  <button type="button" class="reader-edit-trigger" :aria-label="t('document.pdfReading.editInProofread')" :title="t('document.pdfReading.editInProofread')" @click.stop="editSegmentInProofread(block.paragraph.segmentIndex)">{{ t('document.pdfReading.editInProofread') }}</button>
                </section>
              </template>
            </article>
          </div>
        </section>

        <section
          v-else-if="isSubtitleDocument"
          class="subtitle-document-reader"
          :class="{single: effectivePreviewMode !== 'bilingual', stacked: subtitleViewMode === 'stacked'}"
          data-document-reader="subtitle"
          :data-segment-count="parsedDocument.segments.length"
          aria-label="字幕时间轴翻译表格"
        >
          <div class="format-reader-bar subtitle-format-bar">
            <div class="appearance-group" role="group" :aria-label="t('document.pdfReading.presentationLabel')">
              <button type="button" :class="{selected: subtitleViewMode === 'table'}" :aria-pressed="subtitleViewMode === 'table'" @click="subtitleViewMode = 'table'">{{ t('document.pdfReading.subtitleTableView') }}</button>
              <button type="button" :class="{selected: subtitleViewMode === 'stacked'}" :aria-pressed="subtitleViewMode === 'stacked'" @click="subtitleViewMode = 'stacked'">{{ t('document.pdfReading.subtitleStackedView') }}</button>
            </div>
          </div>
          <header v-if="subtitleLrcMeta" class="subtitle-lrc-header" data-i18n-ignore>
            <strong v-if="subtitleLrcMeta.title">{{ subtitleLrcMeta.title }}</strong>
            <span v-if="subtitleLrcMeta.artist">{{ subtitleLrcMeta.artist }}</span>
            <small v-if="subtitleLrcMeta.album">{{ subtitleLrcMeta.album }}</small>
          </header>
          <div v-if="subtitleViewMode === 'stacked'" class="subtitle-stacked-list" :style="readerZoomStyle" data-native-zoom-content>
            <article v-for="row in subtitleDisplayRows" :key="row.index" class="subtitle-cue-card" :data-segment="row.index" @dblclick="editSegmentInProofread(row.index)">
              <div class="subtitle-cue-meta">
                <span class="subtitle-index">#{{ row.index + 1 }}</span>
                <span class="subtitle-timing"><time>{{ row.timeStart || '—' }}</time><template v-if="row.timeEnd"><span aria-hidden="true"> → </span><time>{{ row.timeEnd }}</time></template></span>
                <span v-if="row.durationLabel" class="subtitle-duration-badge">{{ row.durationLabel }}</span>
                <span v-if="row.speaker" class="subtitle-speaker-badge" data-i18n-ignore>{{ row.speaker }}</span>
                <span v-if="row.style" class="subtitle-style-badge" data-i18n-ignore>{{ row.style }}</span>
                <button type="button" class="reader-edit-trigger" :aria-label="t('document.pdfReading.editInProofread')" @click.stop="editSegmentInProofread(row.index)">{{ t('document.pdfReading.editInProofread') }}</button>
              </div>
              <p v-if="row.showSource" class="subtitle-source document-source" data-i18n-ignore><template v-for="(run, ri) in row.sourceRuns" :key="ri"><strong v-if="run.bold" :class="{italic: run.italic, underline: run.underline}">{{ run.text }}</strong><em v-else-if="run.italic" :class="{underline: run.underline}">{{ run.text }}</em><u v-else-if="run.underline">{{ run.text }}</u><template v-else>{{ run.text }}</template></template></p>
              <p v-if="row.showTranslation" class="subtitle-translation document-translation" data-i18n-ignore><template v-if="row.translationRuns.length"><template v-for="(run, ri) in row.translationRuns" :key="ri"><strong v-if="run.bold" :class="{italic: run.italic, underline: run.underline}">{{ run.text }}</strong><em v-else-if="run.italic" :class="{underline: run.underline}">{{ run.text }}</em><u v-else-if="run.underline">{{ run.text }}</u><template v-else>{{ run.text }}</template></template></template><template v-else>{{ t('document.pdfReading.waitingTranslation') }}</template></p>
            </article>
          </div>
          <div v-else class="subtitle-table-scroll">
            <table :style="readerZoomStyle" data-native-zoom-content>
              <thead><tr><th>#</th><th>时间范围</th><th v-if="effectivePreviewMode !== 'translated'">原文</th><th v-if="effectivePreviewMode !== 'source'">译文</th></tr></thead>
              <tbody>
                <tr v-for="row in subtitleDisplayRows" :key="row.index" :data-segment="row.index" @dblclick="editSegmentInProofread(row.index)">
                  <td class="subtitle-index">{{ row.index + 1 }}</td>
                  <td class="subtitle-timing">
                    <div class="subtitle-time-range"><time>{{ row.timeStart || '—' }}</time><template v-if="row.timeEnd"><span aria-hidden="true"> → </span><time>{{ row.timeEnd }}</time></template></div>
                    <div v-if="row.durationLabel || row.speaker || row.style" class="subtitle-badges">
                      <span v-if="row.durationLabel" class="subtitle-duration-badge">{{ row.durationLabel }}</span>
                      <span v-if="row.speaker" class="subtitle-speaker-badge" data-i18n-ignore>{{ row.speaker }}</span>
                      <span v-if="row.style" class="subtitle-style-badge" data-i18n-ignore>{{ row.style }}</span>
                    </div>
                  </td>
                  <td v-if="row.showSource" :colspan="effectivePreviewMode === 'bilingual' && !row.showTranslation ? 2 : 1">
                    <p class="subtitle-source document-source" data-i18n-ignore><template v-for="(run, ri) in row.sourceRuns" :key="ri"><strong v-if="run.bold" :class="{italic: run.italic, underline: run.underline}">{{ run.text }}</strong><em v-else-if="run.italic" :class="{underline: run.underline}">{{ run.text }}</em><u v-else-if="run.underline">{{ run.text }}</u><template v-else>{{ run.text }}</template></template></p>
                  </td>
                  <td v-if="row.showTranslation" class="subtitle-translation-cell">
                    <p class="subtitle-translation document-translation" data-i18n-ignore><template v-if="row.translationRuns.length"><template v-for="(run, ri) in row.translationRuns" :key="ri"><strong v-if="run.bold" :class="{italic: run.italic, underline: run.underline}">{{ run.text }}</strong><em v-else-if="run.italic" :class="{underline: run.underline}">{{ run.text }}</em><u v-else-if="run.underline">{{ run.text }}</u><template v-else>{{ run.text }}</template></template></template><template v-else>{{ t('document.pdfReading.waitingTranslation') }}</template></p>
                    <button type="button" class="reader-edit-trigger" :aria-label="t('document.pdfReading.editInProofread')" @click.stop="editSegmentInProofread(row.index)">{{ t('document.pdfReading.editInProofread') }}</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section
          v-else-if="parsedDocument.delimitedColumns"
          class="json-document-reader delimited-document-reader"
          :class="{'delimited-grid-mode': delimitedViewMode === 'grid'}"
          data-document-reader="delimited"
          :data-segment-count="activeSegments.length"
          :aria-label="t('document.delimited.cells')"
        >
          <div class="format-reader-bar delimited-format-bar">
            <div class="appearance-group" role="group" :aria-label="t('document.pdfReading.presentationLabel')">
              <button type="button" :class="{selected: delimitedViewMode === 'grid'}" :aria-pressed="delimitedViewMode === 'grid'" @click="delimitedViewMode = 'grid'">{{ t('document.pdfReading.spreadsheetView') }}</button>
              <button type="button" :class="{selected: delimitedViewMode === 'list'}" :aria-pressed="delimitedViewMode === 'list'" @click="delimitedViewMode = 'list'">{{ t('document.pdfReading.cellListView') }}</button>
            </div>
            <span v-if="delimitedViewMode === 'grid'" class="format-bar-hint">{{ t('document.pdfReading.untranslatedColumnsHint') }}</span>
          </div>
          <div v-if="delimitedViewMode === 'grid' && delimitedGrid" class="delimited-table-scroll">
            <table class="delimited-spreadsheet" :style="readerZoomStyle" data-native-zoom-content>
              <thead>
                <tr class="delimited-col-header-row">
                  <th class="delimited-row-num" scope="col">#</th>
                  <th v-for="col in delimitedGrid.columns" :key="col.index" scope="col" class="delimited-col-header" :class="{'is-selected': col.selected, 'is-untranslated': !col.selected}">
                    <button type="button" class="delimited-col-toggle" :disabled="queueBusy || !col.translatable || (col.selected && selectedDelimitedColumns.length <= 1)" :aria-pressed="col.selected" :title="t('document.pdfReading.toggleColumnTranslate')" @click="toggleDelimitedColumn(col.index)">
                      <span class="delimited-col-letter">{{ col.letter }}</span>
                      <span class="delimited-col-name" data-i18n-ignore>{{ col.label }}</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in delimitedVisibleRows" :key="row.rowIndex" class="delimited-grid-row json-table-row" :class="{'is-header-row': row.isHeader}">
                  <th class="delimited-row-num" scope="row">{{ row.rowIndex + 1 }}</th>
                  <td v-for="cell in row.cells" :key="cell.column" class="delimited-cell" :class="{'is-untranslated': !cell.selected || cell.segmentId === undefined, 'is-numeric': cell.isNumeric, 'is-formula': cell.isFormula}" :data-segment="cell.segmentId" @dblclick="cell.segmentId !== undefined && cell.selected && editSegmentInProofread(cell.segmentId)">
                    <template v-if="cell.selected && cell.segmentId !== undefined">
                      <code class="delimited-cell-coord visually-hidden">{{ delimitedCellCoord(cell) }}</code>
                      <span v-if="delimitedCellShowsSource(cell)" class="delimited-cell-source document-source" data-i18n-ignore>{{ cell.raw }}</span>
                      <span v-if="delimitedCellShowsTranslation(cell)" class="delimited-cell-translation json-translation document-translation" data-i18n-ignore>{{ cell.translation || t('document.pdfReading.waitingTranslation') }}</span>
                      <button type="button" class="reader-edit-trigger" :aria-label="t('document.pdfReading.editInProofread')" @click.stop="editSegmentInProofread(cell.segmentId)">{{ t('document.pdfReading.editInProofread') }}</button>
                    </template>
                    <span v-else class="delimited-cell-raw" data-i18n-ignore>{{ cell.raw }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else :style="readerZoomStyle" data-native-zoom-content>
            <div class="json-table-header" :class="{ single: effectivePreviewMode !== 'bilingual' }"><span>{{ t('document.delimited.cell') }}</span><span v-if="effectivePreviewMode !== 'translated'">原字符串</span><span v-if="effectivePreviewMode !== 'source'">译文</span></div>
            <article v-for="row in previewRows" :key="row.index" class="json-table-row" :data-segment="row.index" :class="{ single: effectivePreviewMode !== 'bilingual' || (row.translation && !hasDistinctTranslation(row.source, row.translation)) }" @dblclick="editSegmentInProofread(row.index)">
              <code>{{ row.pathLabel || '$' }}</code>
              <p v-if="effectivePreviewMode !== 'translated' || (row.translation && !hasDistinctTranslation(row.source, row.translation))" class="json-source document-source" data-i18n-ignore>{{ row.source }}</p>
              <p v-if="effectivePreviewMode !== 'source' && (!row.translation || hasDistinctTranslation(row.source, row.translation))" class="json-translation document-translation" data-i18n-ignore>{{ row.translation || t('document.pdfReading.waitingTranslation') }}</p>
            </article>
          </div>
        </section>

        <section
          v-else-if="isJsonDocument"
          class="json-document-reader"
          data-document-reader="json"
          :data-segment-count="activeSegments.length"
          :aria-label="translateLegacy('JSON 字符串路径翻译表格')"
        >
          <div class="format-reader-bar json-format-bar">
            <div class="appearance-group" role="group" :aria-label="t('document.pdfReading.presentationLabel')">
              <button type="button" :class="{selected: jsonViewMode === 'table'}" :aria-pressed="jsonViewMode === 'table'" @click="jsonViewMode = 'table'">{{ t('document.pdfReading.jsonTableView') }}</button>
              <button type="button" :class="{selected: jsonViewMode === 'tree'}" :aria-pressed="jsonViewMode === 'tree'" @click="jsonViewMode = 'tree'">{{ t('document.pdfReading.jsonTreeView') }}</button>
            </div>
          </div>
          <div v-if="jsonViewMode === 'tree'" class="json-tree" :style="readerZoomStyle" data-native-zoom-content>
            <div v-for="node in visibleJsonTreeNodes" :key="node.path" class="json-tree-row" :class="[`json-kind-${node.kind}`, {'is-muted': node.muted, 'is-translatable': node.translatable}]" :style="{paddingLeft: `${12 + node.depth * 18}px`}" :data-segment="node.segmentId" @dblclick="node.segmentId !== undefined && editSegmentInProofread(node.segmentId)">
              <button v-if="node.kind === 'object' || node.kind === 'array'" type="button" class="json-tree-toggle" :aria-expanded="node.expanded" @click="toggleJsonTreePath(node.path)">{{ node.expanded ? '▾' : '▸' }}</button>
              <span v-else class="json-tree-spacer" aria-hidden="true" />
              <code class="json-tree-key" data-i18n-ignore>{{ node.key }}</code>
              <span class="json-tree-colon" aria-hidden="true">:</span>
              <span class="json-tree-value" data-i18n-ignore>{{ node.kind === 'string' ? `"${node.valueText}"` : node.valueText }}</span>
              <span v-if="node.translatable && effectivePreviewMode !== 'source'" class="json-tree-translation json-translation" data-i18n-ignore>{{ node.translation || t('document.pdfReading.waitingTranslation') }}</span>
              <button v-if="node.segmentId !== undefined" type="button" class="reader-edit-trigger" :aria-label="t('document.pdfReading.editInProofread')" @click.stop="editSegmentInProofread(node.segmentId)">{{ t('document.pdfReading.editInProofread') }}</button>
            </div>
            <div v-if="jsonTreeNodes.length > visibleJsonTreeNodes.length" class="json-tree-more">
              <button type="button" class="ghost-button" @click="jsonTreeVisibleLimit += 200">{{ translateLegacy('显示更多') }}</button>
            </div>
          </div>
          <div v-else-if="jsonGrouped" :style="readerZoomStyle" data-native-zoom-content>
            <div class="json-table-header" :class="{ single: effectivePreviewMode !== 'bilingual' }"><span>JSONPath</span><span v-if="effectivePreviewMode !== 'translated'">原字符串</span><span v-if="effectivePreviewMode !== 'source'">译文</span></div>
            <template v-for="group in jsonGrouped.groups" :key="group.parentPath">
              <div v-if="group.parentPath !== '$'" class="json-group-header" data-i18n-ignore><code>{{ group.parentPath }}</code></div>
              <article v-for="row in group.rows" :key="row.segmentId" class="json-table-row" :data-segment="row.segmentId" :class="{ single: effectivePreviewMode !== 'bilingual' || (row.translation && !row.hasDistinctTranslation) }" @dblclick="editSegmentInProofread(row.segmentId)">
                <code :title="row.pathLabel">{{ row.pathLabel || '$' }}</code>
                <p v-if="effectivePreviewMode !== 'translated' || (row.translation && !row.hasDistinctTranslation)" class="json-source document-source" data-i18n-ignore><template v-for="(token, ti) in row.sourceTokens" :key="ti"><mark v-if="token.kind === 'placeholder'" class="json-placeholder-token">{{ token.text }}</mark><template v-else>{{ token.text }}</template></template></p>
                <div v-if="effectivePreviewMode !== 'source' && (!row.translation || row.hasDistinctTranslation)" class="json-translation-cell">
                  <p class="json-translation document-translation" data-i18n-ignore><template v-if="row.translationTokens.length"><template v-for="(token, ti) in row.translationTokens" :key="ti"><mark v-if="token.kind === 'placeholder'" class="json-placeholder-token">{{ token.text }}</mark><template v-else>{{ token.text }}</template></template></template><template v-else>{{ t('document.pdfReading.waitingTranslation') }}</template></p>
                  <button type="button" class="reader-edit-trigger" :aria-label="t('document.pdfReading.editInProofread')" @click.stop="editSegmentInProofread(row.segmentId)">{{ t('document.pdfReading.editInProofread') }}</button>
                </div>
              </article>
            </template>
          </div>
        </section>

        <div v-else class="document-reader" data-document-reader="generic" :data-segment-count="parsedDocument.segments.length" :class="`reader-${parsedDocument.format}`" :style="readerZoomStyle" data-native-zoom-content aria-label="文档双语阅读预览">
          <article v-for="row in previewRows" :key="row.index" class="reader-block">
            <span v-if="row.contextLabel" class="reader-context">{{ row.contextLabel }}</span>
            <div v-if="effectivePreviewMode !== 'translated' || (row.translation && !hasDistinctTranslation(row.source, row.translation))" class="reader-source document-source" data-i18n-ignore>
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

    <dialog ref="documentSettingsDialog" class="document-dialog document-settings-dialog" aria-labelledby="document-settings-heading" @close="clearGlossaryReview">
      <h2 id="document-settings-heading" ref="documentSettingsHeading" tabindex="-1">{{ glossaryReviewOpen ? glossaryCopy.title : translateLegacy('翻译设置') }}</h2>
        <!-- 弹窗外壳先挂载；导入后再创建下拉控件，确保 Teleport 目标已存在。 -->
        <section v-if="parsedDocument && !glossaryReviewOpen" class="translation-setup" aria-label="翻译设置">
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
              <ElOption v-if="config.documentService && documentServiceUnavailableMessage" :value="config.documentService" disabled :label="unavailableDocumentServiceLabel" />
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
        <div class="document-context-choice">
          <label class="document-ai-context-toggle" data-testid="document-ai-context-toggle"><input v-model="documentAIContextPreference" type="checkbox" :disabled="queueBusy || !documentAIContextSupported" /><span><strong>{{ t('document.requestEvidence.contextToggle') }}</strong><small>{{ documentAIContextSupported ? t('document.requestEvidence.contextHint') : t('document.requestEvidence.contextUnavailable') }}</small></span></label>
          <button v-if="documentAIContextOverride !== null" class="document-context-inherit" type="button" :disabled="queueBusy" @click="documentAIContextOverride = null; requestEvidence = null">{{ t('document.requestEvidence.inheritGlobal') }}</button>
        </div>
        <GlossaryLibrarySelect
          v-if="config.glossaryLibraries.length || config.glossaryEnabled"
          v-model="config.documentGlossaryIds"
          :libraries="config.glossaryLibraries"
          :enabled="config.glossaryEnabled"
          :unsupported="!documentSupportsGlossary"
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
        <button v-if="canExtractGlossary" ref="glossaryReviewButton" type="button" class="ghost-button document-glossary-extract" :disabled="queueBusy" @click="extractGlossaryCandidates">{{ glossaryCopy.extract }}</button>
        <div v-if="isPdfDocument" class="pdf-source-actions">
          <button v-if="canEditPdfSource" type="button" class="ghost-button" :disabled="queueBusy" @click="openSourceEditor()">{{ t('document.sourceEdit.open') }}</button>
          <button type="button" class="ghost-button" :disabled="queueBusy || !hydrated || !config.on" @click="rerecognizePdfPage">{{ t('document.sourceEdit.rerecognize', {page: pdfPage}) }}</button>
          <p class="setup-privacy">{{ t('document.sourceEdit.rerecognizeHint') }}</p>
        </div>
        <p v-if="credentialWarning" class="notice warning" role="alert">{{ credentialWarning }} <button type="button" @click="openSettings">去配置</button></p>
        <p v-if="settingsChanged" class="notice warning">设置已更改。现有译文和下载内容仍使用之前的结果，按新设置翻译会从头开始。</p>
        <p class="setup-privacy">文件在本地解析，文字发送至所选服务。</p>
        </section>
      <template v-if="glossaryReviewOpen">
          <div class="document-glossary-review">
            <p v-if="glossarySuggesting" class="notice" role="status">{{ glossaryCopy.suggesting }}</p>
            <p v-if="glossaryReviewError" class="notice warning" role="status">{{ glossaryReviewError }}</p>
            <p v-if="!glossaryChoices.length" class="notice" role="status">{{ glossaryCopy.empty }}</p>
            <template v-else>
              <label class="document-glossary-destination">
                <span>{{ glossaryCopy.destination }}</span>
                <ElSelect v-model="glossaryDestinationId" class="document-select" :wrap-label="false" :show-search-icon="false"
                  append-to=".document-settings-dialog" :empty-values="[null, undefined]" :aria-label="glossaryCopy.destination" :disabled="queueBusy">
                  <ElOption v-for="library in glossaryDestinations" :key="library.id" :value="library.id" :label="library.name" data-i18n-ignore />
                  <ElOption value="" :label="glossaryCopy.newLibrary" />
                </ElSelect>
                <small data-i18n-ignore>{{ glossaryScope }}</small>
              </label>
              <ul class="document-glossary-list">
                <li v-for="choice in glossaryChoices" :key="choice.source">
                  <label class="document-glossary-term">
                    <input v-model="choice.selected" type="checkbox" :disabled="queueBusy" />
                    <strong data-i18n-ignore>{{ choice.source }}</strong>
                  </label>
                  <input v-model="choice.target" type="text" class="document-glossary-translation" maxlength="200" :disabled="queueBusy || glossarySuggesting"
                    :aria-label="`${glossaryCopy.target} · ${choice.source}`" :placeholder="glossaryCopy.target" data-i18n-ignore />
                  <p class="document-glossary-evidence" data-i18n-ignore>{{ choice.evidence }}</p>
                </li>
              </ul>
              <p class="setup-privacy">{{ glossaryCopy.effects }}</p>
            </template>
          </div>
        <div class="dialog-actions document-glossary-actions">
          <button class="ghost-button" type="button" :disabled="glossarySaving" @click="returnFromGlossaryReview">{{ glossaryCopy.back }}</button>
          <button v-if="glossaryChoices.length" class="translate-document-button" type="button" :disabled="!canApplyGlossary" @click="applyGlossaryChoices">
            {{ config.glossaryEnabled ? glossaryCopy.apply : glossaryCopy.enableAndApply }}
          </button>
        </div>
      </template>
      <template v-else>
        <p v-if="configSaveError" class="notice error" role="alert">{{ configSaveError }}</p>
        <div class="document-settings-footer"><button class="sidebar-change-file" type="button" :aria-label="documentQueue.length > 1 ? t('document.batch.clear') : translateLegacy('打开新文件')" :disabled="queueBusy" @click="changeDocument">{{ documentQueue.length > 1 ? t('document.batch.clear') : translateLegacy('更换文件') }}</button><button class="settings-link" type="button" @click="openSettings">服务连接设置 ↗</button></div>
        <div class="dialog-actions"><button class="ghost-button" type="button" autofocus @click="documentSettingsDialog?.close()">返回文档</button><button class="translate-document-button" type="button" :disabled="!config.on || !hydrated || queueBusy || Boolean(credentialWarning) || !parsedDocument" @click="translateFromSettings">{{ translationActionLabel }}</button></div>
      </template>
    </dialog>
    <dialog ref="confirmDialog" class="document-dialog" aria-labelledby="confirm-document-heading" @close="clearConfirmation">
      <h2 id="confirm-document-heading">{{ pendingAction === 'remove' ? t('document.batch.removeTitle') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clearTitle') : '打开另一份文档？') : '重新翻译这份文档？' }}</h2>
      <p>{{ pendingAction === 'remove' ? t('document.batch.removeWarning') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clearWarning') : t(historyAvailable ? 'document.changeDocument.historyHint' : 'document.changeDocument.downloadHint')) : '重新翻译会替换现有译文和人工校订。你也可以返回并先下载当前结果。' }}</p>
      <div class="dialog-actions"><button class="ghost-button" type="button" autofocus @click="confirmDialog?.close()">返回文档</button><button class="translate-document-button" type="button" @click="confirmAction">{{ pendingAction === 'remove' ? t('document.batch.remove') : pendingAction === 'reset' ? (documentQueue.length > 1 ? t('document.batch.clear') : '打开新文件') : '重新翻译' }}</button></div>
    </dialog>
    <dialog id="document-download-panel" ref="downloadDialog" class="document-dialog download-dialog" aria-labelledby="download-document-heading" :aria-busy="preparingDownload" @click="closeDownloadOnBackdrop" @close="downloadOpen = false" @cancel="preparingDownload && $event.preventDefault()">
      <header class="download-heading"><h2 id="download-document-heading">{{ downloadCopy.title }}</h2><button type="button" :aria-label="downloadCopy.close" :disabled="preparingDownload" @click="downloadDialog?.close()"><UiIcon name="close" :size="16" /></button></header>
      <div v-if="preparingDownload" class="export-progress"><p role="status" aria-live="polite">{{ downloadProgress || downloadCopy.preparing }}</p><progress v-if="downloadPdfProgress" :value="downloadPdfProgress.phase === 'rendering' ? downloadPdfProgress.completedPages : undefined" :max="downloadPdfProgress.totalPages || 1" :aria-label="downloadProgress || downloadCopy.preparing" /><button class="download-cancel" type="button" :disabled="cancelingDownload" @click="cancelDownload">{{ t(cancelingDownload ? 'document.export.canceling' : 'document.export.cancel') }}</button></div>
      <section v-else-if="pendingDownloadMode" class="download-confirmation">
        <h3>{{ downloadCopy.partialTitle }}</h3>
        <p class="notice">{{ t("document.untranslatedWarning", {count: activeSegments.length - completedSegments}) }}</p>
        <div class="dialog-actions"><button class="ghost-button" type="button" @click="backToDownloadChoices">{{ downloadCopy.back }}</button><button class="translate-document-button" type="button" :disabled="queueBusy" @click="confirmPartialDownload">{{ downloadCopy.confirm }}</button></div>
      </section>
      <template v-else>
        <fieldset class="download-versions" :disabled="queueBusy">
          <legend class="visually-hidden">{{ downloadCopy.versionLabel }}</legend>
          <label v-for="mode in (['bilingual', 'translated'] as const)" :key="mode" class="download-version" :data-mode="mode" :data-selected="downloadMode === mode">
            <input v-model="downloadMode" type="radio" name="document-download-version" :value="mode" :aria-label="mode === 'bilingual' ? downloadCopy.bilingual : downloadCopy.translated" :autofocus="downloadMode === mode" />
            <span v-if="isPdfDocument" class="download-miniature" :data-presentation="downloadPdfPresentation" aria-hidden="true"><span class="download-miniature-page"><span v-if="mode === 'bilingual'" class="download-miniature-source" /><span class="download-miniature-translation" /></span></span>
            <span class="download-version-title">{{ mode === 'bilingual' ? downloadCopy.bilingual : downloadCopy.translated }}</span>
            <span class="download-version-hint">{{ mode === 'bilingual' ? downloadCopy.bilingualHint : downloadCopy.translatedHint }}</span>
          </label>
        </fieldset>
        <p v-if="!hasTranslation" class="download-help">{{ downloadCopy.translationRequired }}</p>
        <details v-if="hasTranslation && isPdfDocument" class="download-layout" @toggle="positionDownloadPanel">
          <summary><span>{{ downloadCopy.layoutLabel }}</span><span class="download-layout-value">{{ downloadPdfPresentation === 'layout' ? downloadCopy.layoutOriginal : downloadCopy.layoutReadable }}<UiIcon name="chevron-down" :size="14" /></span></summary>
          <SegmentedControl class="download-layout-control" :label="downloadCopy.layoutLabel" :model-value="downloadPdfPresentation" :options="[{value: 'layout', label: downloadCopy.layoutOriginal}, {value: 'readable', label: downloadCopy.layoutReadable}]" :disabled="queueBusy" compact @update:model-value="downloadPdfPresentation = $event as PdfReadingPresentation" />
          <p class="download-layout-hint">{{ downloadPdfPresentation === 'layout' ? downloadCopy.layoutOriginalHint : downloadCopy.layoutReadableHint }}</p>
        </details>
      </template>
      <p v-if="hasTranslation && settingsChanged" class="notice warning">设置已更改，本次下载仍是当前保留的译文。</p>
      <p v-if="!preparingDownload && downloadProgress" class="notice" role="status">{{ downloadProgress }}</p>
      <div v-for="(failure, index) in [originalDownloadError, downloadError].filter(Boolean)" :key="index" class="download-failure"><p class="notice" role="alert"><strong>{{ downloadCopy.failedTitle }}</strong>{{ getDocumentDownloadErrorCopy(language, failure) }}</p><details @toggle="positionDownloadPanel"><summary>{{ downloadCopy.details }}</summary><pre data-i18n-ignore>{{ failure }}</pre></details></div>
      <button v-if="!preparingDownload && !pendingDownloadMode" class="download-submit" type="button" :disabled="!hasTranslation || queueBusy" @click="requestDownload(downloadMode)">{{ downloadError ? downloadCopy.retry : downloadMode === 'bilingual' ? downloadCopy.bilingualAction : downloadCopy.translatedAction }}</button>
      <footer class="download-original-row"><button class="download-original" type="button" :disabled="!originalDownloadSource" :title="downloadCopy.originalHint" @click="downloadOriginalDocument">{{ downloadCopy.original }}</button></footer>
    </dialog>
    <PdfSourceEditor v-if="sourceEditTarget && parsedDocument === sourceEditTarget.document" :document="sourceEditTarget.document" :page-number="sourceEditTarget.pageNumber" :block-index="sourceEditTarget.blockIndex" :disabled="queueBusy" @apply="applySourceEdit" @restore="restoreSourceEdit" @close="sourceEditTarget = null" />
    <footer v-if="!parsedDocument && !restoring" class="document-footer">
      <span>让语言更近，让世界更大。</span>
      <a href="https://github.com/Bistutu/FluentRead" target="_blank" rel="noreferrer">开源项目 ↗</a>
    </footer>
  </div>
</template>

<script lang="ts" setup>
import {captureDocumentMaterialLocator, resolveMaterialDocumentResume} from './materialResume';

import {ElOption} from 'element-plus';
import 'element-plus/es/components/select/style/css';
import {markRaw, computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, toRaw, watch} from 'vue';
import DocumentSegmentEditor from './DocumentSegmentEditor.vue';
const PdfSourceEditor = defineAsyncComponent(() => import('./PdfSourceEditor.vue'));
import browser from 'webextension-polyfill';
import {materialCapture, materialGet, materialGeneration, MATERIAL_RESUME_PARAMETER, type MaterialRecord, type MaterialSelection} from './index';
import {
  Config,
  useConfigEditor,
  PdfReader,
  syncRichPreview,
  patchRichPreviewSegments,
  richPreviewInterval,
  collectRichOutline,
  findActiveRichOutlineIndex,
  scrollRichOutline,
  markRichPreviewBusy,
  richPreviewPosition,
  resolveEpubChapterAssets,
  loadEpubNestedToc,
  type EpubTocItem,
  formatJsonPath,
  buildDelimitedGrid,
  paginateDelimitedRows,
  type DelimitedGridCell,
  buildDocxRichBlocks,
  loadDocxPartMetadata,
  paginateDocxBlocks,
  findDocxBlockPage,
  buildDocxOutline,
  type DocxInlineRun,
  type DocxPartMetadata,
  type DocxRichParagraph,
  buildJsonOutline,
  buildJsonGroupedRows,
  buildJsonTreeNodes,
  formatSubtitleDuration,
  extractSubtitleMetadata,
  buildSubtitleTimelineOutline,
  parseSubtitleRichText,
  trackWebArticleReading,
  normalizeWebArticleUrl,
  WEB_ARTICLE_PARAMETER,
  installDocumentZoomGestures,
  pdfPagesNeedingOcr,
  recognizePdfDocument,
  remapPdfTranslationState,
  pdfSourceEditTarget,
  correctPdfSourceLines,
  restorePdfSourceLines,
  reconcilePdfRecognition,
  type PdfSourceEditResult,
  type RichOutlineItem,
  type PdfExportProgress,
  scoreDocumentInformation,
  hasDistinctTranslation,
  TranslationRequestError,
  serializeTranslationError,
  buildGlossaryRevision,
  findGlossaryMatches,
  getGlossaryScopeReason,
  resolveGlossaryEntries,
  DOCUMENT_MAX_BYTES,
  PDF_MAX_BYTES,
  DOCUMENT_QUICK_SAMPLES,
  createDocumentDownload,
  asArrayBufferBytes,
  createPdfPageRecognizer,
  documentRetryBackoff,
  generateDocumentArchive,
  createDocumentImportWorkflow,
  createDocumentRecognitionWorkflow,
  createDocumentExportWorkflow,
  createDocumentHistory,
  createDocumentHistoryCommitter,
  createDocumentPreviewHtml,
  fetchOnlinePdf,
  readPdfSourceFragment,
  releasePdfDocument,
  filterAvailableTranslationServices,
  filterEnabledTranslationServices,
  isTranslationServiceDisabled,
  formatDocumentReaderText,
  getDocumentAcceptAttribute,
  getDocumentEmptyReaderHint,
  getDocumentMimeType,
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
  restoreSubtitleTags,
  parseDocumentFile,
  requestConfigPatch,
  resolveConfiguredModel,
  runtimeConfig,
  services,
  servicesType,
  subscribeConfig,
  translateDocumentSegments,
  withCustomOpenAIServiceOptions,
  withCompositeTranslationServiceOptions,
  getCompositeTranslationConfigFingerprint,
  hasCompositeTranslationAIContext,
  isCompositeTranslationProviderId,
  GlossaryLibrarySelect,
  documentGlossaryDestinations,
  extractDocumentGlossaryCandidates,
  filterDocumentGlossaryCandidates,
  planDocumentGlossaryUpdate,
  type DocumentGlossaryChoice,
  supportsTranslationGlossary,
  useUiI18n,
  useDocumentTasks,
  countCompletedTranslations,
  createDocumentTaskState,
  type DocumentTranslationUpdate,
  type DocumentRenderMode,
  type DocumentBilingualLayout,
  type DocumentReadingTheme,
  type DocumentReadingFontFamily,
  type DocumentHistorySummary,
  type DocumentQueueItem,
  type PdfReadingPresentation,
  type PdfAnnotation,
  normalizePdfAnnotations,
  type ParsedDocument,
  documentSegmentsInColumns,
  normalizeDelimitedColumns,
  type DelimitedColumn,
  ElSelect,
  UiIcon,
  SegmentedControl,
} from '@/src/app/document-translation';
import {getDocumentDownloadCopy, getDocumentDownloadErrorCopy} from './downloadCopy';
import {getDocumentGlossaryCopy} from './glossaryCopy';

const READER_PAGE_SIZE = 80;

type DocumentConfigPatch = Partial<Pick<Config,
  'from' | 'to' | 'documentService' | 'documentModel' | 'documentCustomModel' | 'documentGlossaryIds'
>>;
type DocumentModelMapping = Config['documentModel'];
type DocumentRequestEvidenceKind = 'definition' | 'nearby' | 'section_opening' | 'previous_machine' | 'user_confirmed';
interface DocumentRequestEvidenceItem {kind: DocumentRequestEvidenceKind; blockId: string; section: string; position: string; source: string; translation?: string}
interface DocumentRequestGlossaryTerm {library: string; source: string; target: string; occurrences: number}
interface DocumentRequestEvidenceState {
  segmentCount: number;
  contextEnabled: boolean;
  section: string;
  positions: string[];
  contextItems: DocumentRequestEvidenceItem[];
  glossaryOccurrences: number;
  glossaryTermCount: number;
  glossaryLibraryCount: number;
  glossaryTerms: DocumentRequestGlossaryTerm[];
  omittedGlossaryTerms: number;
}

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
const downloadCopy = computed(() => getDocumentDownloadCopy(language.value));
const fileInput = ref<HTMLInputElement | null>(null);
const documentTasks = useDocumentTasks();
const {documentQueue, activeDocumentId, activeTask, parsedDocument, translatedSegments,
  completedCount: taskCompletedCount, hasTranslation: taskHasTranslation, setDocumentTranslationBatch,
  confirmedTranslationIds, taskFingerprint, runState, editRevision, downloadedRevision,
  errorMessage, documentBatchTranslation, bypassCache} = documentTasks;
const taskSegments = (item: DocumentQueueItem) => item.document ? documentSegmentsInColumns(item.document, item.delimitedColumns) : [];
const activeSegments = computed(() => activeTask.value ? taskSegments(activeTask.value) : []);
const columnScope = computed(() => activeTask.value?.delimitedColumns ? new Set(activeSegments.value.map(segment => segment.id)) : undefined);
const selectedDelimitedColumns = computed(() => activeTask.value?.delimitedColumns ?? parsedDocument.value?.delimitedColumns?.map(column => column.index) ?? []);
function delimitedColumnLabel(column: DelimitedColumn): string {
  const number = t('document.delimited.column', {column: column.index + 1});
  return column.label ? `${number} · ${column.label}` : number;
}
function updateDelimitedColumns(values: unknown): void {
  const item = activeTask.value;
  if (queueBusy.value || !item?.document?.delimitedColumns || !Array.isArray(values) || !values.length) return;
  const columns = normalizeDelimitedColumns(item.document, values);
  if (JSON.stringify(columns) === JSON.stringify(item.delimitedColumns)) return;
  item.delimitedColumns = columns;
  item.state = 'ready';
  item.error = '';
  item.revision += 1;
  readerPage.value = 1;
  requestEvidence.value = null;
  downloadNotice.value = '';
  scheduleHistorySave();
}
const outputMode = ref<DocumentRenderMode>('bilingual');
const previewMode = ref<'source' | DocumentRenderMode>('bilingual');
const pdfPresentation = ref<PdfReadingPresentation>('layout');
const readerControls = ref<HTMLElement | null>(null);
const outlineHost = ref<HTMLElement | null>(null);
// 窄屏初次打开时先留出正文空间；只读取一次宽度，之后保留用户选择。多文件或导入失败仍自动展开文件页。
const sidebarOpen = ref(!window.matchMedia('(max-width: 760px)').matches);
// 专注阅读隐藏本页的全部控件，并尽量让浏览器进入全屏；退出全屏或按 Esc 即恢复。
const focusMode = ref(false);
function setFocusMode(value: boolean): void {
  focusMode.value = value;
  try {
    if (value) void window.document.documentElement.requestFullscreen?.()?.catch?.(() => undefined);
    else if (window.document.fullscreenElement) void window.document.exitFullscreen?.()?.catch?.(() => undefined);
  } catch { /* 浏览器不允许全屏时仍然隐藏控件。 */ }
}
function leaveFocusOnEscape(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  if (event.key === 'Escape' && focusMode.value) {
    setFocusMode(false);
    return;
  }
  if (!parsedDocument.value) return;
  const active = window.document?.activeElement as HTMLElement | null;
  const role = active?.getAttribute?.('role');
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable || role === 'textbox' || role === 'combobox')) return;
  if (documentSettingsDialog.value?.open || downloadDialog.value?.open || confirmDialog.value?.open || Boolean(window.document?.querySelector?.('dialog[open]'))) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
    event.preventDefault();
    sidebarOpen.value = !sidebarOpen.value;
    return;
  }
  const digit = event.code === 'Digit1' || event.key === '1' ? '1'
    : event.code === 'Digit2' || event.key === '2' ? '2'
      : event.code === 'Digit3' || event.key === '3' ? '3' : '';
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && canCompare.value && digit) {
    event.preventDefault();
    previewMode.value = digit === '1' ? 'source' : digit === '2' ? 'bilingual' : 'translated';
  }
}
function leaveFocusWithFullscreen(): void {if (!window.document.fullscreenElement && focusMode.value) focusMode.value = false;}
const sidebarTab = ref<'files' | 'outline'>('outline');
/** 文档级上下文覆盖只作用于当前打开文档，不写入全局设置或翻译历史。 */
const documentAIContextOverride = ref<boolean | null>(null);
interface RawRequestEvidence {
  segments: readonly ParsedDocument['segments'][number][];
  discourseContext?: string;
  enableAIContext: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  glossaryIds: string[] | null;
  glossaryEnabled: boolean;
  glossarySupported: boolean;
  glossaryLibraries: Config['glossaryLibraries'];
}
const rawRequestEvidence = shallowRef<RawRequestEvidence | null>(null);
const requestEvidence = computed<DocumentRequestEvidenceState | null>({
  get: () => {
    const raw = rawRequestEvidence.value;
    if (!raw) return null;
    const {segments, discourseContext, enableAIContext, sourceLanguage, targetLanguage, glossaryIds, glossaryEnabled, glossarySupported, glossaryLibraries} = raw;
    const kinds: readonly DocumentRequestEvidenceKind[] = ['definition', 'nearby', 'section_opening', 'previous_machine', 'user_confirmed'];
    let section = segments.find(segment => segment.contextLabel?.trim())?.contextLabel?.slice(0, 160) ?? '';
    let positions = [...new Set(segments.map(segment => [segment.contextLabel, segment.pathLabel, segment.timeStart, `段落 ${segment.id + 1}`]
      .filter(Boolean).join(' · ')))].slice(0, 8);
    let contextItems: DocumentRequestEvidenceItem[] = [];
    if (discourseContext) {
      try {
        const parsed: unknown = JSON.parse(discourseContext);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (record.version === 1) {
            if (!section && typeof record.section === 'string' && !/^(?:document|section:\d+)$/u.test(record.section)) section = record.section.slice(0, 160);
            const rawPositions = Array.isArray(record.positions) ? record.positions : [record.position];
            positions = [...new Set([...positions, ...rawPositions.filter((position): position is string => typeof position === 'string' && Boolean(position.trim())).map(position => position.slice(0, 160))])].slice(0, 8);
            if (Array.isArray(record.evidence)) {
              contextItems = record.evidence.flatMap((value): DocumentRequestEvidenceItem[] => {
                if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
                const item = value as Record<string, unknown>;
                if (!kinds.includes(item.kind as DocumentRequestEvidenceKind)
                  || typeof item.blockId !== 'string' || typeof item.section !== 'string' || typeof item.position !== 'string'
                  || typeof item.source !== 'string' || !item.source.trim()
                  || (item.translation !== undefined && typeof item.translation !== 'string')) return [];
                return [{kind: item.kind as DocumentRequestEvidenceKind, blockId: item.blockId.slice(0, 160),
                  section: item.section.slice(0, 160), position: item.position.slice(0, 160), source: item.source.slice(0, 480),
                  ...(typeof item.translation === 'string' && item.translation ? {translation: item.translation.slice(0, 480)} : {})}];
              }).slice(0, 8);
            }
          }
        }
      } catch { /* 不显示无法核对的上下文协议 */ }
    }
    const glossaryContext = {text: segments.map(segment => segment.source), sourceLanguage, targetLanguage, pageUrl: undefined, glossaryIds};
    const glossaryTerms = glossaryEnabled && glossarySupported
      ? resolveGlossaryEntries(glossaryLibraries, glossaryContext).terms.flatMap(term => {
        const library = glossaryLibraries.find(candidate => getGlossaryScopeReason(candidate, glossaryContext) === 'eligible'
          && candidate.entries.some(entry => entry.source === term.source && entry.target === term.target && entry.caseSensitive === term.caseSensitive));
        return library ? [{...term, library: library.name}] : [];
      }) : [];
    const matchedTerms = new Map<string, DocumentRequestGlossaryTerm>();
    let glossaryOccurrences = 0;
    for (const segment of segments) {
      for (const {entry} of findGlossaryMatches(segment.source.normalize('NFC'), glossaryTerms)) {
        const key = JSON.stringify([entry.library, entry.source, entry.target]);
        const existing = matchedTerms.get(key);
        if (existing) existing.occurrences += 1;
        else matchedTerms.set(key, {library: entry.library, source: entry.source, target: entry.target, occurrences: 1});
        glossaryOccurrences += 1;
      }
    }
    const allGlossaryTerms = [...matchedTerms.values()].sort((left, right) => right.occurrences - left.occurrences || left.source.localeCompare(right.source));
    return {segmentCount: segments.length, contextEnabled: enableAIContext, section, positions, contextItems,
      glossaryOccurrences, glossaryTermCount: matchedTerms.size, glossaryLibraryCount: new Set(allGlossaryTerms.map(term => term.library)).size,
      glossaryTerms: allGlossaryTerms.slice(0, 8), omittedGlossaryTerms: Math.max(0, allGlossaryTerms.length - 8)};
  },
  set: value => {if (!value) rawRequestEvidence.value = null;},
});
const recognitionProgress = ref('');
const retryWaiting = ref(0);
const richOutline = ref<RichOutlineItem[]>([]);
const richOutlineLanguage = ref<'source' | 'translated'>('translated');
const pdfPage = ref(1);
const sourceEditTarget = shallowRef<{document: ParsedDocument; taskId: number; pageNumber: number; blockIndex: number} | null>(null);
watch([parsedDocument, activeDocumentId], () => {sourceEditTarget.value = null;}, {flush: 'sync'});
const canEditPdfSource = computed(() => {
  const document = parsedDocument.value;
  return document?.binary?.kind === 'pdf' && document.binary.pages.find(page => page.pageNumber === pdfPage.value)?.blocks.some((_, index) => pdfSourceEditTarget(document, pdfPage.value, index));
});
const readerTab = ref<'read' | 'edit'>('read');
const editorFocusSegmentId = ref<number | null>(null);
// 阅读时不构建隐藏校订器和全文占位符映射；首次打开后保留当前文档的搜索、页码和输入状态。
const editorRequested = ref(false);
watch([activeDocumentId, readerTab], ([documentId, tab], [previousDocumentId]) => {
  if (documentId !== previousDocumentId) {
    editorRequested.value = false;
    editorFocusSegmentId.value = null;
  }
  if (tab === 'edit') editorRequested.value = true;
  else editorFocusSegmentId.value = null;
});
const APPEARANCE_STORAGE_KEY = 'fluentread.documentReader.appearance';
function readSavedAppearance(): {bilingualLayout: DocumentBilingualLayout; readingTheme: DocumentReadingTheme; fontFamily: DocumentReadingFontFamily} {
  try {
    const raw = globalThis.localStorage?.getItem(APPEARANCE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const bilingualLayout: DocumentBilingualLayout = parsed.bilingualLayout === 'stacked' ? 'stacked' : 'split';
      const readingTheme: DocumentReadingTheme = parsed.readingTheme === 'light' || parsed.readingTheme === 'sepia' || parsed.readingTheme === 'green' || parsed.readingTheme === 'dark' ? parsed.readingTheme : 'auto';
      const fontFamily: DocumentReadingFontFamily = parsed.fontFamily === 'serif' ? 'serif' : 'sans';
      return {bilingualLayout, readingTheme, fontFamily};
    }
  } catch { /* 无法读取本地外观偏好时沿用默认值。 */ }
  return {bilingualLayout: 'split', readingTheme: 'auto', fontFamily: 'sans'};
}
const savedAppearance = readSavedAppearance();
const richBilingualLayout = ref<DocumentBilingualLayout>(savedAppearance.bilingualLayout);
const richReadingTheme = ref<DocumentReadingTheme>(savedAppearance.readingTheme);
const richFontFamily = ref<DocumentReadingFontFamily>(savedAppearance.fontFamily);
watch([richBilingualLayout, richReadingTheme, richFontFamily], ([bilingualLayout, readingTheme, fontFamily]) => {
  try {
    globalThis.localStorage?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({bilingualLayout, readingTheme, fontFamily}));
  } catch { /* 存储不可用时仅保留当前会话外观。 */ }
});
const lightThemeLabel = computed(() => translateLegacy(options.theme.find(item => item.value === 'light')?.label || 'Light'));
const richThemeChoices = computed<Array<{value: DocumentReadingTheme; label: string}>>(() => [
  {value: 'auto', label: t('document.pdfReading.theme.auto')},
  {value: 'light', label: lightThemeLabel.value},
  {value: 'sepia', label: t('document.pdfReading.theme.sepia')},
  {value: 'green', label: t('document.pdfReading.theme.mint')},
  {value: 'dark', label: t('document.pdfReading.theme.dark')},
]);
const DELIMITED_PAGE_SIZE = 50;
const delimitedViewMode = ref<'grid' | 'list'>('grid');
const jsonViewMode = ref<'table' | 'tree'>('table');
const jsonExpandedPaths = ref<Set<string>>(new Set(['$']));
const jsonTreeVisibleLimit = ref(200);
const subtitleViewMode = ref<'table' | 'stacked'>('table');
const pdfInformationHighlight = computed(() => ({
  preferences: config.informationHighlight,
  scoreLocal: scoreDocumentInformation,
  available: config.on && hydrated.value && readerTab.value === 'read',
}));
const readingContent = ref<HTMLElement | null>(null);
const readerScale = ref(1);
const readerZoomStyle = computed(() => ({zoom: String(readerScale.value)}));
const readerPage = ref(1);
const settledTranslations = ref<string[]>([]);
const confirmDialog = ref<HTMLDialogElement | null>(null);
const downloadDialog = ref<HTMLDialogElement | null>(null);
const downloadButton = ref<HTMLButtonElement | null>(null);
const downloadOpen = ref(false);
const downloadMode = ref<DocumentRenderMode>('bilingual');
const downloadPdfPresentation = ref<PdfReadingPresentation>('layout');
const pendingDownloadMode = ref<DocumentRenderMode | null>(null);
const queueExpanded = ref(false);
const documentSettingsDialog = ref<HTMLDialogElement | null>(null);
const documentSettingsHeading = ref<HTMLElement | null>(null);
const glossaryReviewButton = ref<HTMLButtonElement | null>(null);
const configSaveError = ref('');
const pendingAction = ref<'reset' | 'restart' | 'remove' | null>(null);
let pendingRemoval: DocumentQueueItem | null = null;
const partialExportAcknowledged = ref(false);
const downloadError = ref('');
const downloadNotice = ref('');
const originalDownloadError = ref('');
const readingModes = [{value: 'source', label: '原文'}, {value: 'bilingual', label: '双语'}, {value: 'translated', label: '译文'}] as const;
const isDragging = ref(false);
const translating = ref(false);
const liveCompletedSegments = ref(0);

const retryNotice = ref('');
// 导入操作不属于当前文档的翻译任务，下载或解析新文件不能改写旧任务的失败原因。
const importError = ref('');
const openingFile = ref(false);
const preparingDownload = ref(false);
const cancelingDownload = ref(false);
const downloadProgress = ref('');
const downloadPdfProgress = ref<PdfExportProgress | null>(null);
const onlinePdfUrl = ref('');
const downloadingPdf = ref(false);
const importProgress = ref('');
/** 导入进度 0–1：下载按字节、解析按页；未知时为 0，进度条显示为往复动画。 */
const importRatio = ref(0);
const epubChapterIndex = ref(0);
const docxPartIndex = ref(0);
const hydrated = ref(false);
type GlossaryRetranslation = {document: ParsedDocument; fingerprint: string; pending: Set<number>};
const glossaryRetranslation = shallowRef<GlossaryRetranslation | null>(null);
let activeGlossaryRetranslation: GlossaryRetranslation | null = null;
const glossaryReviewOpen = ref(false);
const glossarySaving = ref(false);
const glossarySuggesting = ref(false);
const glossaryReviewError = ref('');
const glossaryNotice = ref('');
const glossaryDestinationId = ref('');
const glossaryChoices = ref<(DocumentGlossaryChoice & {selected: boolean})[]>([]);
let glossaryController: AbortController | null = null;
const colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
const systemDark = ref(colorSchemeMedia.matches);
const isDark = computed({
  get: () => config.theme === 'dark' ? true : config.theme === 'light' ? false : systemDark.value,
  set: (value: boolean) => { systemDark.value = value; },
});
watch(isDark, dark => {
  window.document?.documentElement?.classList?.toggle('dark', dark);
}, {immediate: true});
let abortController: AbortController | null = null;
let translationRequestId = 0;
let disposed = false;

const batchRunning = ref(false);
const batchNotice = ref('');
let nextDocumentId = 0;
let batchGeneration = 0;
const queueBusy = computed(() => translating.value || batchRunning.value || openingFile.value || downloadingPdf.value || preparingDownload.value || glossarySaving.value);
const completeItem = (item: DocumentQueueItem) => {
  const segments = taskSegments(item);
  return Boolean(segments.length
    && !pdfPagesNeedingOcr(item.document).length
    && !(item.id === activeDocumentId.value && translating.value)
    && countCompletedTranslations(item.translations, segments) === segments.length);
};
const batchCompletedCount = computed(() => documentQueue.value.filter(completeItem).length);
const batchPendingCount = computed(() => documentQueue.value.filter(item => item.document && !completeItem(item)).length);

function selectDocument(item: DocumentQueueItem): void {
  if (!item.document || item.id === activeDocumentId.value) return;
  importWorkflow.cancel();
  recognitionWorkflow.cancel();
  exportWorkflow.reset();
  if (translating.value) pauseTranslation();
  activateDocument(item);
}

/** 导入控制器只交接当前代次的完整任务，不撤销同一次多文件读取。 */
function activateDocument(item: DocumentQueueItem): void {
  if (!item.document || item.id === activeDocumentId.value) return;
  discardPendingTranslationBatch();
  releaseDocumentPreview(parsedDocument.value);
  recognitionProgress.value = '';
  activeDocumentId.value = item.id;
  documentAIContextOverride.value = null;
  requestEvidence.value = null;
  rememberOpenDocument(item.historyReadUnavailable || item.historyConflict ? null : item.historyId);
  settledTranslations.value = [...item.translations];
  downloadNotice.value = '';
  originalDownloadError.value = '';
  readerPage.value = 1;
  readerTab.value = 'read';
  epubChapterIndex.value = 0;
  docxPartIndex.value = 0;
}

function queueProgress(item: DocumentQueueItem): number {
  if (item.id === activeDocumentId.value) return progress.value;
  const segments = taskSegments(item);
  return segments.length ? Math.min(pdfPagesNeedingOcr(item.document).length ? 99 : 100, Math.floor(countCompletedTranslations(item.translations, segments) / segments.length * 100)) : 0;
}

// 最近翻译：只在浏览器提供 IndexedDB 时启用；记录留在本机，重新打开同一份文件会接着上次的译文继续。
const historyAvailable = typeof indexedDB !== 'undefined';
const history = createDocumentHistory();
const historyCommitter = createDocumentHistoryCommitter<DocumentQueueItem>(async (record, owner) => {
  if (owner.historyVersion === undefined || owner.historyConflict) return false;
  const result = await history.saveChecked(record, owner.historyVersion);
  if (result.status === 'conflict') {
    owner.historyConflict = true;
    if (activeDocumentId.value === owner.id) rememberOpenDocument(null);
    return false;
  }
  if (result.status !== 'saved') {
    owner.historyReadUnavailable = true;
    if (activeDocumentId.value === owner.id) rememberOpenDocument(null);
    return false;
  }
  owner.historyVersion = result.version;
  return true;
});
const historyEntries = ref<DocumentHistorySummary[]>([]);
const historyLoading = ref(true);
const historyError = ref('');
const historyMutationPending = ref(false);
let historyRequestEpoch = 0;
const materialPrivate = browser.extension?.inIncognitoContext === true;
const materialSaving = ref(false);
const documentMaterialId = ref('');
const materialPdfReader = ref<{resumePage(page: number): Promise<void>; resumeLocation(segmentIndex: number): Promise<boolean>; cancelMaterialResume(): void; resolveMaterialSelection(range: Range): number | undefined; captureMaterialLocation(): number | undefined; markSelection(range: Range, kind: 'highlight' | 'underline'): boolean} | null>(null);
let pendingMaterialResume: MaterialRecord | undefined;
let materialPositionTimer: ReturnType<typeof setTimeout> | undefined;
let materialEpoch = 0;
let materialResumeRevision = 0;
let materialPositionCaptureAllowed = false;
let interruptMaterialResume: (() => void) | undefined;
/** 恢复引起的页码变化不写回定位；只有用户开始阅读后才记录新位置。 */
function markMaterialReadingIntent(event: Event): void {
  if (!event.isTrusted) return;
  interruptMaterialResume?.();
  if (documentMaterialId.value && !pendingMaterialResume) materialPositionCaptureAllowed = true;
}
function materialReadingPointerDown(event: PointerEvent): void {focusNativeReader(event); markMaterialReadingIntent(event);}
/** 阅读器仅返回当前模型索引；完整原文引用由持有已核验文件摘要与模型的组合根创建。 */
function captureDocumentMaterialSelection(range: Range, quote: string): MaterialSelection | undefined {
  const item = activeTask.value, doc = parsedDocument.value, reader = materialPdfReader.value;
  if (disposed || !config.on || materialPrivate || !item?.historyId || item.historyReadUnavailable || item.historyConflict || !doc || doc.binary?.kind !== 'pdf' || typeof reader?.resolveMaterialSelection !== 'function') return;
  const index = reader.resolveMaterialSelection(range);
  const locator = index === undefined ? undefined : captureDocumentMaterialLocator(item.historyId, doc, index, READER_PAGE_SIZE);
  if (!locator?.documentReference) return;
  return {source: {kind: 'document', fingerprint: item.historyId, title: doc.fileName, ...(item.sourceUrl ? {url: item.sourceUrl} : {})},
    locator: {...locator, quote: quote.slice(0, 6000)}};
}
function markDocumentSelection(range: Range, kind: 'highlight' | 'underline'): boolean {
  return !disposed && config.on && isPdfDocument.value && materialPdfReader.value?.markSelection(range, kind) || false;
}
defineExpose({captureDocumentMaterialSelection, markDocumentSelection});
function documentMaterialSelection(): MaterialSelection | undefined {
  const item = activeTask.value; const doc = parsedDocument.value;
  if (!item?.historyId || item.historyReadUnavailable || item.historyConflict || !doc) return;
  const index = isPdfDocument.value ? materialPdfReader.value?.captureMaterialLocation?.()
    : isDocxDocument.value ? currentDocxPart.value?.paragraphSegments[(readerPage.value - 1) * READER_PAGE_SIZE]?.segmentIndex
      : isEpubDocument.value ? currentEpubChapter.value?.segmentOffset : (readerPage.value - 1) * READER_PAGE_SIZE;
  // PDF 没有可见段落或完整引用时不生成页首/粗略位置，自动保存也不能覆盖旧精确定位。
  if (isPdfDocument.value && index === undefined) return;
  const exact = index === undefined ? undefined : captureDocumentMaterialLocator(item.historyId, doc, index, READER_PAGE_SIZE);
  if (isPdfDocument.value && !exact?.documentReference) return;
  return {source: {kind: 'document', fingerprint: item.historyId, title: doc.fileName, ...(item.sourceUrl ? {url: item.sourceUrl} : {})},
    locator: exact ?? {kind: 'document', fingerprint: item.historyId, page: isPdfDocument.value ? pdfPage.value : readerPage.value,
      ...(isEpubDocument.value ? {section: `epub:${epubChapterIndex.value}`} : isDocxDocument.value ? {section: `docx:${docxPartIndex.value}`} : {})}};
}
async function saveDocumentMaterial(): Promise<void> {
  if (!config.on || materialPrivate || materialSaving.value) return;
  if (activeTask.value?.historyReadUnavailable || activeTask.value?.historyConflict) {downloadNotice.value = t('document.historyOpenUnavailable'); return;}
  const selection = documentMaterialSelection();
  if (!selection) {downloadNotice.value = '当前段落尚未显示，请等待页面加载或滚动到文字后重试；原阅读位置已保留。'; return;}
  const owner = materialEpoch; const capturedAt = Date.now(); materialSaving.value = true;
  try {const generation = await materialGeneration(); if (disposed || owner !== materialEpoch || !config.on) return;
    const record = await materialCapture({...selection, generation, capturedAt});
    if (!disposed && owner === materialEpoch) {pendingMaterialResume = undefined; materialPositionCaptureAllowed = true; documentMaterialId.value = record.id; downloadNotice.value = '已保存本机学习位置，可从学习中心继续阅读。';}
  } catch (error) {if (owner === materialEpoch) downloadNotice.value = error instanceof Error ? error.message : '学习材料保存失败，请重试。';}
  finally {if (owner === materialEpoch) materialSaving.value = false;}
}
async function applyMaterialResume(): Promise<void> {
  const record = pendingMaterialResume; const item = activeTask.value; const doc = parsedDocument.value;
  if (!record || !item?.historyId || !doc || disposed) return;
  if (item.historyId !== record.source.fingerprint) {importError.value = '所选文件与材料内容指纹不一致。请选择原文件；同名文件不会覆盖原材料。'; return;}
  const request = ++materialResumeRevision; const owner = materialEpoch; const locator = record.locator;
  materialPositionCaptureAllowed = false;
  const position = resolveMaterialDocumentResume(locator, item.historyId, doc, READER_PAGE_SIZE);
  if (position.status === 'unresolved' || position.status === 'unlocated') {
    documentMaterialId.value = record.id;
    downloadNotice.value = position.status === 'unresolved'
      ? '原文位置已变化或无法唯一匹配，已保留原定位。请找到原文后点击「更新学习位置」。'
      : '旧材料未保存可用的阅读位置。请找到原文后点击「更新学习位置」。';
    return;
  }
  const section = position.section; const page = position.page;
  if (section?.startsWith('epub:') || section && /^\d+$/u.test(section)) epubChapterIndex.value = Math.min(Math.max(0, Number(section.replace(/^epub:/u, '')) || 0), Math.max(0, epubChapters.value.length - 1));
  if (section?.startsWith('docx:')) docxPartIndex.value = Math.min(Math.max(0, Number(section.slice(5)) || 0), Math.max(0, docxParts.value.length - 1));
  await nextTick(); if (disposed || request !== materialResumeRevision || owner !== materialEpoch || doc !== parsedDocument.value || pendingMaterialResume !== record) return;
  // PdfReader 公共出口按需加载独立 chunk；普通 nextTick 不代表异步组件的公开 ref 已就绪。
  const pdfReader = materialPdfReader.value;
  if (doc.binary?.kind === 'pdf' && (typeof pdfReader?.resumePage !== 'function' || position.status === 'exact' && (typeof pdfReader?.resumeLocation !== 'function' || typeof pdfReader?.cancelMaterialResume !== 'function'))) return;
  documentMaterialId.value = record.id;
  downloadNotice.value = position.status === 'coarse' ? '已恢复保存的页码或章节，请核对原文；开始阅读后记录新的位置。' : '';
  readerPage.value = Math.max(1, Math.min(page, readerPageCount.value));
  await nextTick(); if (disposed || request !== materialResumeRevision || owner !== materialEpoch || doc !== parsedDocument.value || pendingMaterialResume !== record) return;
  if (doc.binary?.kind === 'pdf') {
    let restored: boolean;
    if (position.status === 'exact') {
      const interrupt = () => {
        if (disposed || request !== materialResumeRevision || owner !== materialEpoch || doc !== parsedDocument.value || pendingMaterialResume !== record) return;
        materialResumeRevision += 1; interruptMaterialResume = undefined;
        pdfReader!.cancelMaterialResume(); pendingMaterialResume = undefined;
        downloadNotice.value = '已停止自动定位，继续记录当前阅读位置。';
      };
      interruptMaterialResume = interrupt;
      try {restored = await pdfReader!.resumeLocation(position.segmentIndex);}
      finally {if (interruptMaterialResume === interrupt) interruptMaterialResume = undefined;}
    } else {await pdfReader!.resumePage(page); restored = true;}
    if (disposed || request !== materialResumeRevision || owner !== materialEpoch || doc !== parsedDocument.value || pendingMaterialResume !== record) return;
    if (!restored) {downloadNotice.value = '原段落布局尚未就绪，已保留阅读位置。请重新打开这份材料重试。'; return;}
  }
  pendingMaterialResume = undefined;
}
async function restoreMaterialDocument(id: string): Promise<void> {
  const owner = materialEpoch;
  try {const record = await materialGet(id); if (disposed || owner !== materialEpoch) return;
    if (!record || record.kind !== 'document' || !record.source.fingerprint) throw new Error('材料已移除或文档来源不完整，请从学习工作区检查。');
    pendingMaterialResume = record;
    const loaded = await history.loadChecked(record.source.fingerprint); if (disposed || owner !== materialEpoch) return;
    if (loaded.status === 'unavailable') {importError.value = t('document.historyOpenUnavailable');return;}
    const existing = loaded.record;
    if (!existing) {importError.value = '本机文件记录已移除。请选择原文件，FluentRead 会按内容指纹找回阅读位置与学习记录。';return;}
    await openHistory(existing); await applyMaterialResume();
  } catch (error) {if (!disposed && owner === materialEpoch) importError.value = error instanceof Error ? error.message : '恢复材料失败，请重新打开或选择原文件。';}
  finally {if (!disposed && (owner === materialEpoch || pendingMaterialResume?.id === id || documentMaterialId.value === id)) restoring.value = false;}
}
watch(activeDocumentId, () => {materialEpoch++; materialPositionCaptureAllowed = false; clearTimeout(materialPositionTimer); documentMaterialId.value = ''; materialSaving.value = false; void nextTick(applyMaterialResume);});
watch(materialPdfReader, reader => {if (typeof reader?.resumePage === 'function' && pendingMaterialResume) void applyMaterialResume();}, {flush: 'post'});
/** 阅读器沿用已有 scroll/updateViewport 通知；防抖结束后读取当前 DOM，不缓存另一套段落状态。 */
function queueMaterialPositionCapture(): void {
  clearTimeout(materialPositionTimer);
  const allowed = () => !disposed && config.on && Boolean(documentMaterialId.value) && materialPositionCaptureAllowed && !materialPrivate && !pendingMaterialResume;
  if (!allowed()) return;
  const owner = materialEpoch;
  const timer = setTimeout(async () => {
    try {
      if (owner !== materialEpoch || materialPositionTimer !== timer || !allowed()) return;
      const selection = documentMaterialSelection();
      if (!selection) return;
      const generation = await materialGeneration();
      if (owner !== materialEpoch || materialPositionTimer !== timer || !allowed()) return;
      await materialCapture({...selection, positionOnly: true, generation, capturedAt: Date.now()});
    } catch { /* 已移除、归档、未布局或隐私禁用时保留原定位。 */ }
  }, 1000);
  materialPositionTimer = timer;
}
watch([pdfPage, readerPage, epubChapterIndex, docxPartIndex], queueMaterialPositionCapture);
let historyTimer: ReturnType<typeof setTimeout> | undefined;
async function refreshHistory(): Promise<void> {
  const epoch = ++historyRequestEpoch;
  historyLoading.value = true;
  const result = await history.listChecked();
  if (disposed || epoch !== historyRequestEpoch) return;
  historyLoading.value = false;
  if (result.status === 'unavailable') {historyError.value = 'document.historyListUnavailable';return;}
  historyEntries.value = result.entries;
  historyError.value = '';
}
function persistHistory(): void {
  if (historyTimer !== undefined) {clearTimeout(historyTimer); historyTimer = undefined;}
  if (!historyAvailable) return;
  for (const item of documentQueue.value) {
    if (!item.document || !item.historyId || !item.bytes || item.historyReadUnavailable || item.historyConflict || item.revision === item.savedRevision) continue;
    const segments = taskSegments(item);
    const completed = countCompletedTranslations(item.translations, segments);
    void historyCommitter.save(item, {id: item.historyId, name: item.name, format: item.document.format, size: item.bytes.byteLength, sourceUrl: item.sourceUrl, mimeType: item.mimeType || '',
      total: segments.length, completed, updatedAt: Date.now(), bytes: item.bytes, translations: [...item.translations],
      ...(item.delimitedColumns ? {delimitedColumns: [...item.delimitedColumns]} : {}), ...(item.bypassCache ? {bypassCache: true} : {}), ...(item.pdfAnnotations ? {pdfAnnotations: toRaw(item.pdfAnnotations)} : {}), retainedRevisions: item.retainedRevisions ? toRaw(item.retainedRevisions) : undefined, fingerprint: item.fingerprint, parsed: toRaw(item.document), parsedVersion: PARSED_VERSION}).then(written => {if (written && !parsedDocument.value) void refreshHistory();});
  }
}
/** 批注沿用文件任务和历史版本校验；存储不可用时仍可下载本次副本。 */
function updatePdfAnnotations(annotations: PdfAnnotation[]): void {
  const task = activeTask.value;
  if (!task || task.document?.binary?.kind !== 'pdf') return;
  task.pdfAnnotations = normalizePdfAnnotations(annotations, task.document.binary.pages.length);
  task.revision += 1;
  persistHistory();
}
function scheduleHistorySave(): void {
  if (!historyAvailable || historyTimer !== undefined) return;
  historyTimer = setTimeout(persistHistory, 5000);
}
// 刷新后回到正在阅读的文档：当前标签页记住它在本地历史里的标识，新开的标签页仍从首页开始。
const SESSION_KEY = 'fluentread.document.open';
/** PDF 署名识别变化后重解析旧快照，按原文及位置恢复校订。 */
const PARSED_VERSION = 26;
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
  if (disposed || queueBusy.value) return;
  await importWorkflow.openHistory(entry.id);
}
async function changeHistory(operation: () => Promise<boolean | {status: 'removed' | 'conflict' | 'unavailable'}>): Promise<void> {
  if (historyMutationPending.value) return;
  historyMutationPending.value = true;
  ++historyRequestEpoch;
  historyLoading.value = false;
  const confirmed = await operation();
  if (disposed) return;
  historyMutationPending.value = false;
  if (typeof confirmed !== 'boolean' && confirmed.status === 'conflict') {historyError.value = 'document.historyRemoveConflict';return;}
  if (confirmed === false || typeof confirmed !== 'boolean' && confirmed.status === 'unavailable') {historyError.value = 'document.historyChangeUnavailable';return;}
  await refreshHistory();
}
async function removeHistory(entry: DocumentHistorySummary): Promise<void> {
  await changeHistory(() => entry.historyVersion ? history.removeChecked(entry.id, entry.historyVersion) : Promise.resolve({status: 'unavailable'}));
}
async function clearHistory(): Promise<void> {
  await changeHistory(() => history.clear());
}
function historyFormat(entry: DocumentHistorySummary): string {
  return entry.format === 'markdown' ? 'MD' : entry.format.toUpperCase();
}
function historyStatus(entry: DocumentHistorySummary): string {
  const date = new Date(entry.updatedAt).toLocaleDateString(language.value, {month: 'short', day: 'numeric'});
  return `${entry.pendingOcrPages ? t('document.pdfReading.scanned') : !entry.completed ? translateLegacy('尚未翻译') : entry.completed >= entry.total ? translateLegacy('翻译完成') : `${entry.completed} / ${entry.total}`} · ${date}`;
}

const importWorkflow = createDocumentImportWorkflow({
  parseFile: (file, options) => parseDocumentFile(file, options), fetchPdf: (url, options) => fetchOnlinePdf(url, options),
  history: historyAvailable ? history : null, parsedVersion: PARSED_VERSION,
  createTask: (file, sourceUrl) => ({...createDocumentTaskState(), id: ++nextDocumentId, name: file.name, sourceUrl}),
  appendTask: (item, select) => {
    if (item.document) item.document = markRaw(item.document);
    if (item.originalFile) item.originalFile = markRaw(item.originalFile);
    documentQueue.value.push(item);
    if (item.error) queueExpanded.value = true;
    if (item.error || documentQueue.value.length > 1) {sidebarOpen.value = true;sidebarTab.value = 'files';}
    if (select) activateDocument(documentQueue.value[documentQueue.value.length - 1]);
  },
  releaseDocument: releaseDocumentPreview,
  onStart: () => {batchNotice.value = '';importError.value = '';importProgress.value = '';importRatio.value = 0;},
  onPhase: phase => {
    openingFile.value = phase === 'reading';downloadingPdf.value = phase === 'downloading';
    importProgress.value = phase === 'downloading' ? t('document.pdfReading.downloading') : '';
  },
  onReadProgress: ({completed, total}) => {
    importProgress.value = t('document.pdfReading.importPages', {completed, total});importRatio.value = total ? completed / total : 0;
  },
  onDownloadProgress: ({received, total}) => {
    const size = (received / 1024 / 1024).toFixed(1);
    importRatio.value = total ? received / total : 0;
    importProgress.value = total ? t('document.pdfReading.downloadProgress', {size, percent: Math.round(received / total * 100)})
      : t('document.pdfReading.downloadBytes', {size});
  },
  onOnlineError: error => {importError.value = error instanceof Error ? error.message : String(error);},
  onHistoryUnavailable: () => {importError.value = t('document.historyOpenUnavailable');},
  onFinished: persistHistory,
  onHistoryMissing: refreshHistory,
});
async function retryDocumentHistory(): Promise<void> {
  const item = activeTask.value;
  if (queueBusy.value || !(item?.historyReadUnavailable || item?.historyConflict)) return;
  const file = item.originalFile ?? (item.bytes ? new File([item.bytes.slice().buffer as ArrayBuffer], item.name, {type: item.mimeType || ''}) : undefined);
  if (!file) return;
  // 保留当前任务和用户修改，重新读取的历史作为另一任务加入队列。
  await importWorkflow.loadFiles([file], item.sourceUrl);
}
const recognitionWorkflow = createDocumentRecognitionWorkflow({
  recognize: (document, recognize, options) => recognizePdfDocument(document, recognize, options),
  createRecognizer: language => createPdfPageRecognizer(language),
  onProgress: progress => {recognitionProgress.value = progress ? t('document.pdfReading.recognizing', progress) : '';},
});
const exportWorkflow = createDocumentExportWorkflow({
  createDownload: (document, translations, mode, options) => createDocumentDownload(document, translations, mode, options),
  createArchive: async () => {const {default: JSZip} = await import('jszip');return new JSZip();},
  generateArchive: (archive, options, progress) => generateDocumentArchive(archive, options, progress),
  isActiveTask: task => activeTask.value === task,
  containsTask: task => documentQueue.value.includes(task),
  createUrl: blob => URL.createObjectURL(blob), revokeUrl: url => URL.revokeObjectURL(url),
  triggerDownload: (url, fileName) => {const anchor = window.document.createElement('a');anchor.href = url;anchor.download = fileName;anchor.click();},
  onState: ({busy, canceling}) => {preparingDownload.value = busy;cancelingDownload.value = canceling;},
  onStart: kind => {
    if (kind === 'batch') batchNotice.value = '';
    else {downloadProgress.value = '';downloadPdfProgress.value = null;downloadError.value = '';}
  },
  onProgress: progress => {
    const label = 'pdf' in progress ? pdfExportProgress(progress.pdf) : 'percent' in progress ? archiveExportProgress(progress.percent) : t('document.export.saving');
    if (progress.kind === 'batch') batchNotice.value = progress.name ? `${progress.name} · ${label}` : label;
    else {downloadProgress.value = label;if ('pdf' in progress) downloadPdfProgress.value = progress.pdf;}
  },
  onComplete: (kind, count) => {
    if (kind === 'batch') batchNotice.value = t('document.batch.downloaded', {count});
    else {
      downloadNotice.value = '已生成下载文件，请在浏览器下载列表中查看。';
      downloadProgress.value = '';downloadPdfProgress.value = null;downloadDialog.value?.close();
    }
  },
  onError: (kind, error, canceled) => {
    if (kind === 'batch') batchNotice.value = canceled ? t('document.export.canceled')
      : t('document.batch.downloadFailed', {error: error instanceof Error ? error.message : String(error)});
    else {
      downloadPdfProgress.value = null;downloadProgress.value = canceled ? t('document.export.canceled') : '';
      if (!canceled) downloadError.value = error instanceof Error ? error.message : String(error);
    }
  },
  onNoticeExpired: () => {downloadNotice.value = '';},
});

function queueStatus(item: DocumentQueueItem): string {
  if (!item.document) return t('document.batch.importFailed');
  if (!item.document.segments.length && item.document.binary?.kind === 'pdf') return t('document.pdfReading.selectableSource');
  if (item.id === activeDocumentId.value) return `${translateLegacy(statusLabel.value)} · ${progress.value}%`;
  if (completeItem(item)) return translateLegacy('翻译完成');
  const segments = taskSegments(item);
  const done = countCompletedTranslations(item.translations, segments);
  return `${translateLegacy(item.state === 'failed' ? '翻译中断' : item.state === 'paused' ? '已暂停' : '等待翻译')} · ${done}/${segments.length}`;
}

async function startBatch(): Promise<void> {
  if (!config.on || queueBusy.value || !hydrated.value || credentialWarning.value) return;
  const pending = documentQueue.value.filter(item => item.document && !completeItem(item));
  // 已有译文的语言或术语设置不同，留给单文件的重译确认处理，避免批量按钮抹掉校订。
  if (pending.some(item => item.translations.some(text => text?.trim()) && !compatibleTranslationSettings(item.fingerprint, currentFingerprint.value))) {
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
      if (!compatibleTranslationSettings(fingerprint, currentFingerprint.value)) {
        batchNotice.value = t('document.batch.externalSettings');
        break;
      }
      selectDocument(item);
      await startTranslation(settingsChanged.value);
    }
  } finally {
    if (generation === batchGeneration) batchRunning.value = false;
  }
}

function removeDocument(item: DocumentQueueItem, confirmed = false): void {
  if (queueBusy.value) return;
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
      documentTasks.clearSelection();
      settledTranslations.value = [];
    }
  }
}

async function downloadBatch(): Promise<void> {
  if (disposed || queueBusy.value) return;
  await exportWorkflow.batch(documentQueue.value.filter(completeItem), outputMode.value);
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
type OriginalDocumentDownloadSource = {fileName: string; blob: File} | {fileName: string; bytes: Uint8Array; mimeType: string};
const originalDownloadSource = computed<OriginalDocumentDownloadSource | null>(() => {
  const item = documentQueue.value.find(candidate => candidate.id === activeDocumentId.value);
  if (!item?.document) return null;
  if (item.originalFile) return {fileName: item.name, blob: item.originalFile};
  // 最近翻译恢复的是已保存原始字节；不从解析文本或 PDF 预览重新生成文件。
  return item.bytes ? {fileName: item.name, bytes: item.bytes, mimeType: item.mimeType || getDocumentMimeType(item.document.format)} : null;
});
const formatCards = [
  {code: 'PDF', label: '论文 / 资料', tone: 'coral'},
  {code: 'EPUB', label: '电子书', tone: 'teal'},
  {code: 'HTML', label: '网页', tone: 'coral'},
  {code: 'JSON', label: '语言文件', tone: 'teal'},
  {code: 'CSV', label: 'CSV / TSV', tone: 'teal'},
  {code: 'TXT', label: '纯文本', tone: 'slate'},
  {code: 'DOCX', label: 'Word 文档', tone: 'slate'},
  {code: 'MD', label: 'Markdown', tone: 'sand'},
  {code: 'SUB', label: '字幕 / 歌词', tone: 'violet'},
];

const serviceOptions = computed(() => filterEnabledTranslationServices(filterAvailableTranslationServices(withCompositeTranslationServiceOptions(withCustomOpenAIServiceOptions(
  options.services,
  config.customOpenAIProviders,
), config.compositeTranslationProviders)).filter((item: any) => !item.disabled).map((item: any) => ({
  ...item,
  label: translateLegacy(item.label),
  description: item.description ? translateLegacy(item.description) : item.description,
})), config.disabledTranslationServices));
const effectiveDocumentService = computed(() => config.documentService || config.service);
// 不可用只影响可选性；旧服务必须显示真实名称，不把 ChatGPT 或本地模型误写成 Chrome。
const unavailableDocumentServiceLabel = computed(() =>
  config.customOpenAIProviders.find(item => item.id === effectiveDocumentService.value)?.name
  || config.compositeTranslationProviders.find(item => item.id === effectiveDocumentService.value)?.name
  || translateLegacy(options.services.find(item => item.value === effectiveDocumentService.value)?.label || effectiveDocumentService.value),
);
// “跟随默认”后面写明当前默认的是哪个服务，读者不必去设置页确认。
const followDefaultLabel = computed(() => {
  const name = serviceOptions.value.find(item => item.value === config.service)?.label
    || translateLegacy(options.services.find(item => item.value === config.service)?.label || config.service);
  return name ? `${t('featureServices.followDefault')} · ${name}` : t('featureServices.followDefault');
});
const activeDocumentModels = computed(() => config.documentService ? config.documentModel : config.model);
const activeDocumentCustomModels = computed(() => config.documentService ? config.documentCustomModel : config.customModel);
const documentServiceUnavailableMessage = computed(() => isTranslationServiceDisabled(config.disabledTranslationServices, effectiveDocumentService.value)
  ? t('settings.services.library.serviceDisabledMessage') : getTranslationServiceUnavailableMessage(effectiveDocumentService.value));
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
  if (effectiveDocumentService.value === services.chatgptPlan) return Array.from(new Set([
    resolveConfiguredModel(config.model[services.chatgptPlan], config.customModel[services.chatgptPlan]),
    resolveConfiguredModel(activeDocumentModels.value[services.chatgptPlan], activeDocumentCustomModels.value[services.chatgptPlan]),
  ].filter(Boolean)));
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
    if (documentIsCustomOpenAIProvider.value || service === services.chatgptPlan || builtInDocumentModels.value.includes(value)) {
      config.documentModel[service] = value;
      if (service === services.chatgptPlan) delete config.documentCustomModel[service];
      return;
    }
    // requestConfigPatch 只提交显式请求的顶层字段，因此必须在同一轮同时写入
    // sentinel 和真实模型；post-flush watcher 会把它们合并成一个原子 patch。
    config.documentCustomModel[service] = value;
    config.documentModel[service] = customModelString;
  },
});
const documentModelValue = computed(() => selectedDocumentModel.value);
const documentAIContextPreference = computed({
  get: () => documentAIContextOverride.value ?? config.enableAIContext,
  set: (enabled: boolean) => {documentAIContextOverride.value = enabled; requestEvidence.value = null;},
});
const documentAIContextSupported = computed(() => servicesType.isUseAIContext(effectiveDocumentService.value, documentModelValue.value)
  || hasCompositeTranslationAIContext(config, effectiveDocumentService.value));
const documentAIContextEnabled = computed(() => Boolean(documentAIContextPreference.value && documentAIContextSupported.value));
const documentSupportsGlossary = computed(() => isCompositeTranslationProviderId(effectiveDocumentService.value)
  || supportsTranslationGlossary(effectiveDocumentService.value, selectedDocumentModel.value));
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
const previewRows = computed(() => pageRows(activeSegments.value).map(rowForSegment));
const hasTranslation = computed(() => activeTask.value?.delimitedColumns
  ? countCompletedTranslations(translatedSegments.value, activeSegments.value) > 0
  : taskHasTranslation.value);
const completedSegments = computed(() => translating.value ? liveCompletedSegments.value
  : activeTask.value?.delimitedColumns
    ? countCompletedTranslations(translatedSegments.value, activeSegments.value)
    : taskCompletedCount.value);
const translationComplete = computed(() => Boolean(!translating.value && !needsOcr.value && activeSegments.value.length && completedSegments.value === activeSegments.value.length));
// 只有已提交译文计入分子；请求和重试不增加进度，最后一段提交后仍等任务收敛才显示 100%。
const progress = computed(() => activeSegments.value.length
  ? Math.min(translating.value || needsOcr.value ? 99 : 100, Math.floor(completedSegments.value / activeSegments.value.length * 100)) : 0);
const showTranslationProgress = computed(() => Boolean(activeSegments.value.length && !recognitionProgress.value));
const translationProgressLabel = computed(() => t('document.translationProgress.count', {
  completed: completedSegments.value, total: activeSegments.value.length, percent: progress.value,
}));
/** 默认只显示现有错误分类的短提示；完整供应商原因按需展开，重试复用工具栏唯一主按钮。 */
const translationFailureVisible = computed(() => Boolean(runState.value === 'failed' && errorMessage.value && !credentialWarning.value && !configSaveError.value));
function documentFailureSummary(message: string): string {
  const {kind} = serializeTranslationError(message);
  return t(kind === 'unknown' ? 'document.translationRecovery.interrupted' : kind === 'bad-request' || kind === 'provider' ? 'document.translationRecovery.unavailable' : `translationStats.errorKind.${kind}`);
}
function requestEvidenceKindLabel(kind: DocumentRequestEvidenceKind): string {
  switch (kind) {
    case 'definition': return t('document.requestEvidence.kind.definition');
    case 'nearby': return t('document.requestEvidence.kind.nearby');
    case 'section_opening': return t('document.requestEvidence.kind.sectionOpening');
    case 'previous_machine': return t('document.requestEvidence.kind.previousMachine');
    case 'user_confirmed': return t('document.requestEvidence.kind.userConfirmed');
  }
}
// PDF 打开即左右对照，其他格式从翻译开始进入所选方式：译文页先显示原页，各段译文到达后逐段替换。
const canCompare = computed(() => translating.value || hasTranslation.value || (isPdfDocument.value && Boolean(parsedDocument.value?.segments.length)));
const effectivePreviewMode = computed(() => canCompare.value ? previewMode.value : 'source');
const currentFingerprint = computed(() => JSON.stringify({
  from: config.from, to: config.to, service: effectiveDocumentService.value, model: selectedDocumentModel.value,
  compositeConnection: getCompositeTranslationConfigFingerprint(config, effectiveDocumentService.value),
  glossaryIds: config.documentGlossaryIds, glossaryRevision: buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled),
  documentAIContext: documentAIContextEnabled.value,
}));
/** 跨服务与模型切换保留续译；同一组合内部的配置变化仍遵循原有重译确认，语言与术语始终参与兼容判断。 */
function compatibleTranslationSettings(previous: string, current: string): boolean {
  const readSettings = (fingerprint: string) => {
    try {
      const value = JSON.parse(fingerprint);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    } catch {return undefined;}
  };
  const before = readSettings(previous), after = readSettings(current);
  if (!before || !after) return previous === current;
  const contentSettings = (value: Record<string, unknown>) => JSON.stringify([value.from, value.to, value.glossaryIds, value.glossaryRevision, value.documentAIContext]);
  return contentSettings(before) === contentSettings(after)
    && (before.service !== after.service || before.compositeConnection === after.compositeConnection);
}
const settingsChanged = computed(() => Boolean(taskFingerprint.value && !compatibleTranslationSettings(taskFingerprint.value, currentFingerprint.value)));
const glossaryCopy = computed(() => getDocumentGlossaryCopy(language.value));
const glossaryDestinations = computed(() => documentGlossaryDestinations(config));
const glossaryScope = computed(() => {
  const library = glossaryDestinations.value.find(item => item.id === glossaryDestinationId.value);
  const source = library ? library.sourceLanguage : config.from === 'auto' ? 'en' : config.from;
  const target = library ? library.targetLanguage : config.to;
  const label = (code: string) => code ? getMultilingualTargetLanguageLabel(code, code, language.value) : glossaryCopy.value.anyLanguage;
  return `${label(source)} → ${label(target)}`;
});
const canExtractGlossary = computed(() => hydrated.value && config.on && documentSupportsGlossary.value
  && activeSegments.value.length > 0 && !isSubtitleDocumentFormat(parsedDocument.value?.format ?? 'txt')
  && (config.from === 'auto' || /^en(?:-|$)/iu.test(config.from)));
const canApplyGlossary = computed(() => canExtractGlossary.value && !queueBusy.value && !glossarySuggesting.value && !credentialWarning.value
  && glossaryChoices.value.some(choice => choice.selected) && glossaryChoices.value.every(choice => !choice.selected || Boolean(choice.target.trim())));
const pendingGlossaryRetranslation = computed(() => {
  const task = glossaryRetranslation.value;
  if (!task || task.document !== parsedDocument.value || task.fingerprint !== currentFingerprint.value) return null;
  const scope = columnScope.value;
  return [...task.pending].some(id => !scope || scope.has(id)) ? task : null;
});
watch(currentFingerprint, fingerprint => {
  requestEvidence.value = null;
  if (!glossarySaving.value) clearGlossaryReview();
  if (activeGlossaryRetranslation && activeGlossaryRetranslation.fingerprint !== fingerprint) pauseTranslation();
});
watch(parsedDocument, () => {
  clearGlossaryReview();
  glossaryNotice.value = '';
});
// 只调整操作层级：完成后的下载承接当前结果；任何待应用的设置（含可续译的服务/模型）都重新突出翻译。
const downloadIsPrimary = computed(() => translationComplete.value && (!taskFingerprint.value || taskFingerprint.value === currentFingerprint.value));
// 其它文档页或设置页也可切换服务。显示新服务时必须撤销旧任务，避免仍等待旧线路却让读者以为新线路卡住。
watch([effectiveDocumentService, selectedDocumentModel], () => {
  if (translating.value || batchRunning.value) pauseTranslation();
}, {flush: 'sync'});
const translationActionLabel = computed(() => settingsChanged.value ? '按新设置翻译' : translationComplete.value ? '重新翻译' : runState.value === 'failed' ? t('document.translationRecovery.retry') : hasTranslation.value || runState.value === 'paused' ? '继续翻译' : '开始翻译');
/**
 * 整篇译完、译文却几乎都和原文一样：多半是文档本来就是目标语言。状态里直接说明，读者不必对着没有变化的页面猜原因。
 * 片段太少时不下这个判断（专名、数字本来就会原样返回）。
 */
const sameAsSource = computed(() => {
  const segments = activeSegments.value;
  if (translating.value || segments.length < 5 || !translationComplete.value) return false;
  const unchanged = segments.filter(segment => !hasDistinctTranslation(segment.source, translatedSegments.value[segment.id])).length;
  return unchanged >= segments.length * 0.9;
});
const statusLabel = computed(() => translating.value ? recognitionProgress.value || (runState.value === 'failed' ? t('document.translationProgress.collectingAfterFailure') : retryWaiting.value ? t('document.translationProgress.waitingRetry') : completedSegments.value === activeSegments.value.length ? t('document.translationProgress.finishing') : '正在翻译') : runState.value === 'paused' ? '已暂停' : runState.value === 'failed' ? '翻译中断' : needsOcr.value ? t('document.pdfReading.scanned') : isPdfDocument.value && !activeSegments.value.length ? t('document.pdfReading.selectableSource') : translationComplete.value ? (sameAsSource.value ? '译文与原文相同，可换目标语言' : '翻译完成') : hasTranslation.value ? '部分完成' : '准备就绪');
const hasUnsavedWork = computed(() => translating.value || batchRunning.value || openingFile.value || editRevision.value > downloadedRevision.value
  || documentQueue.value.some(item => item.id !== activeDocumentId.value && item.revision > item.downloaded));
const isPdfDocument = computed(() => parsedDocument.value?.binary?.kind === 'pdf');
const isEpubDocument = computed(() => parsedDocument.value?.binary?.kind === 'epub');
const isDocxDocument = computed(() => parsedDocument.value?.binary?.kind === 'docx');
const isSubtitleDocument = computed(() => isSubtitleDocumentFormat(parsedDocument.value?.format));
const isJsonDocument = computed(() => parsedDocument.value?.format === 'json');
const isRichDocument = computed(() => isRichDocumentFormat(parsedDocument.value?.format));
const articleSourceUrl = computed(() => parsedDocument.value?.format === 'html'
  ? normalizeWebArticleUrl(activeTask.value?.sourceUrl) : null);
const documentHeading = computed(() => {
  const name = parsedDocument.value?.fileName || '';
  return articleSourceUrl.value ? name.replace(/\.html$/u, '') : name;
});
const epubChapters = computed(() => parsedDocument.value?.binary?.kind === 'epub'
  ? parsedDocument.value.binary.chapters
  : []);
const currentEpubChapter = computed(() => epubChapters.value[epubChapterIndex.value]);
const epubNestedToc = ref<EpubTocItem[]>([]);
const epubResolvedHtml = ref<string | null>(null);
let epubAssetsRevoke: (() => void) | null = null;
let epubAssetRevision = 0;
let epubAssetPending = false;
let epubTocRevision = 0;
let pendingEpubFragment = '';
let pendingRichLocateSegmentId: number | null = null;

function revokeEpubAssets(): void {
  epubAssetRevision += 1;
  epubAssetPending = false;
  epubAssetsRevoke?.();
  epubAssetsRevoke = null;
  epubResolvedHtml.value = null;
}

function stepEpubChapter(delta: -1 | 1): void {
  const next = epubChapterIndex.value + delta;
  if (next >= 0 && next < epubChapters.value.length) epubChapterIndex.value = next;
}

function resolveEpubRelativeHref(basePath: string, href: string): {path: string; fragment: string} | null {
  const trimmed = href.trim();
  if (!trimmed || /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(trimmed)) return null;
  try {
    const base = `https://epub.invalid/${basePath.split('/').map(encodeURIComponent).join('/')}`;
    const url = new URL(trimmed, base);
    return {path: decodeURIComponent(url.pathname.slice(1)), fragment: decodeURIComponent(url.hash.slice(1))};
  } catch {
    return null;
  }
}

watch(parsedDocument, document => {
  epubTocRevision += 1;
  epubNestedToc.value = [];
  pendingEpubFragment = '';
  pendingRichLocateSegmentId = null;
  revokeEpubAssets();
  if (document?.binary?.kind !== 'epub' || !document.binary.bytes?.byteLength) return;
  const revision = epubTocRevision;
  const {bytes, chapters} = document.binary;
  void loadEpubNestedToc(bytes, chapters).then(items => {
    if (!disposed && revision === epubTocRevision && parsedDocument.value === document) epubNestedToc.value = items;
  }).catch(() => undefined);
}, {immediate: true});

watch([parsedDocument, currentEpubChapter], ([document, chapter]) => {
  revokeEpubAssets();
  if (document?.binary?.kind !== 'epub' || !chapter || !document.binary.bytes?.byteLength) return;
  const revision = epubAssetRevision;
  epubAssetPending = true;
  void resolveEpubChapterAssets(document.binary.bytes, chapter.path, chapter.source).then(resolved => {
    if (disposed || revision !== epubAssetRevision || parsedDocument.value !== document || currentEpubChapter.value !== chapter) {
      resolved.revoke();
      return;
    }
    epubAssetPending = false;
    epubAssetsRevoke = resolved.revoke;
    if (resolved.blobUrls.length || resolved.inlineCss) {
      epubResolvedHtml.value = resolved.html;
    } else {
      if (pendingEpubFragment) {const fragment = pendingEpubFragment; pendingEpubFragment = ''; scrollRichFragment(fragment);}
      if (pendingRichLocateSegmentId !== null) {const targetId = pendingRichLocateSegmentId; pendingRichLocateSegmentId = null; scrollRichSegment(targetId);}
    }
  }).catch(() => {
    if (revision === epubAssetRevision) {
      epubAssetPending = false;
      if (pendingEpubFragment) {const fragment = pendingEpubFragment; pendingEpubFragment = ''; scrollRichFragment(fragment);}
      if (pendingRichLocateSegmentId !== null) {const targetId = pendingRichLocateSegmentId; pendingRichLocateSegmentId = null; scrollRichSegment(targetId);}
    }
  });
}, {immediate: true});

const richPreviewDocument = computed<ParsedDocument | null>(() => {
  const document = parsedDocument.value;
  if (!document) return null;
  if (document.binary?.kind === 'epub') {
    const chapter = currentEpubChapter.value;
    return chapter ? parseDocument('chapter.html', epubResolvedHtml.value ?? chapter.source) : null;
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
    {
      bilingualLayout: richBilingualLayout.value,
      readingTheme: richReadingTheme.value,
      fontFamily: richFontFamily.value,
    },
  );
  // 跟随界面且暗色时保留原有暗色阅读底色（#202632），同时覆写全部 --reader-* 语义变量，不改变原文件或导出内容。
  return richReadingTheme.value === 'auto' && isDark.value ? html.replace(/<\/head\s*>/iu, `<style>
    :root { color-scheme: dark; --reader-bg: #202632; --reader-ink: #e8edf7; --reader-source: #c3cede; --reader-muted: #9aa7bd; --reader-surface: #272f3d; --reader-code-bg: #1a202b; --reader-border: #364154; --reader-accent: #ff8bad; --reader-pending: #2f3848; color: var(--reader-ink); background: var(--reader-bg); }
    html, body { background: var(--reader-bg); color: var(--reader-ink); }
    h1,h2,h3,h4,h5,h6,.reader-source,.reader-translation,.fluentread-translation,[data-fluent-read-document-translation="true"] { color: var(--reader-ink); }
    blockquote { color: var(--reader-muted); } a,.reader-link { color: var(--reader-accent); }
    pre,code,.document-security-note { color: var(--reader-ink); background: var(--reader-surface); border-color: var(--reader-border); }
    td,th { border-color: var(--reader-border); }
    body[data-translating] article[data-reader-mode="bilingual"] .reader-unit.is-pending::after { background: var(--reader-pending); }
  </style></head>`) : html;
}
const richFrame = ref<HTMLIFrameElement | null>(null);
const richFrameHtml = ref('');
const activeRichHeadingIndex = ref(-1);
type ReaderZoomPoint = {clientX: number; clientY: number};
type ReaderZoomSurface = {content: HTMLElement; viewport: HTMLElement; xScroller: HTMLElement; yScroller: HTMLElement; document: Document; frame: boolean};
let readerZoomDisposer: (() => void) | undefined;
let loadedRichDocument: Document | null = null;
let stopArticleReading: (() => void) | undefined;
let stopRichFrameListeners: (() => void) | undefined;
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
function scrollRichFragment(fragment: string): void {
  const doc = richFrame.value?.contentDocument;
  if (!doc || !fragment) return;
  const target = doc.getElementById?.(fragment) ?? doc.getElementsByName?.(fragment)?.[0];
  target?.scrollIntoView?.({block: 'start', behavior: 'smooth'});
}

function scrollRichSegment(segmentId: number): void {
  const doc = richFrame.value?.contentDocument;
  if (!doc) return;
  const chapter = currentEpubChapter.value;
  const localId = chapter ? segmentId - chapter.segmentOffset : segmentId;
  doc.querySelector?.(`[data-segment-id="${localId}"]`)?.scrollIntoView?.({block: 'center', behavior: 'smooth'});
}

function handleRichFrameLoad(): void {
  stopArticleReading?.();
  stopArticleReading = undefined;
  stopRichFrameListeners?.();
  stopRichFrameListeners = undefined;
  const frameDoc = richFrame.value?.contentDocument || null;
  loadedRichDocument = frameDoc;
  refreshRichPreview(true);
  bindReaderZoomGestures();
  const frameWindow = richFrame.value?.contentWindow;
  const cleanups: Array<() => void> = [];
  if (frameWindow && typeof frameWindow.addEventListener === 'function') {
    let active = true;
    let scrollRaf = 0;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const updateActiveHeading = () => {
      scrollRaf = 0;
      scrollTimer = undefined;
      if (!active) return;
      activeRichHeadingIndex.value = findActiveRichOutlineIndex(richFrame.value);
    };
    const onScroll = () => {
      if (scrollRaf || scrollTimer !== undefined) return;
      if (typeof requestAnimationFrame === 'function') scrollRaf = requestAnimationFrame(updateActiveHeading);
      else scrollTimer = setTimeout(updateActiveHeading, 16);
    };
    frameWindow.addEventListener('scroll', onScroll, {passive: true});
    cleanups.push(() => {
      active = false;
      frameWindow.removeEventListener('scroll', onScroll);
      if (scrollRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollRaf);
      if (scrollTimer !== undefined) clearTimeout(scrollTimer);
    });
  }
  if (isEpubDocument.value && frameDoc && typeof frameDoc.addEventListener === 'function') {
    const onEpubLinkClick = (event: Event) => {
      const target = (event.target as Element | null)?.closest?.('a[href]');
      if (!target) return;
      const href = target.getAttribute('href') || '';
      if (!href) return;
      if (href.startsWith('#')) {
        event.preventDefault();
        let decoded = href.slice(1);
        try {decoded = decodeURIComponent(decoded);} catch { /* 保留原始锚点片段。 */ }
        scrollRichFragment(decoded);
        return;
      }
      const chapter = currentEpubChapter.value;
      if (!chapter) return;
      const resolved = resolveEpubRelativeHref(chapter.path, href);
      if (!resolved) return;
      event.preventDefault();
      const targetIndex = epubChapters.value.findIndex(item => item.path === resolved.path || item.path.toLowerCase() === resolved.path.toLowerCase());
      if (targetIndex < 0) return;
      if (targetIndex === epubChapterIndex.value) {
        if (resolved.fragment) scrollRichFragment(resolved.fragment);
      } else {
        pendingEpubFragment = resolved.fragment;
        epubChapterIndex.value = targetIndex;
      }
    };
    frameDoc.addEventListener('click', onEpubLinkClick);
    cleanups.push(() => frameDoc.removeEventListener('click', onEpubLinkClick));
  }
  if (cleanups.length) stopRichFrameListeners = () => cleanups.forEach(fn => fn());
  if (pendingEpubFragment) {
    const fragment = pendingEpubFragment;
    if (!epubAssetPending) pendingEpubFragment = '';
    scrollRichFragment(fragment);
  }
  if (pendingRichLocateSegmentId !== null) {
    const targetId = pendingRichLocateSegmentId;
    if (!epubAssetPending) pendingRichLocateSegmentId = null;
    scrollRichSegment(targetId);
  }
  const id = activeTask.value?.historyId;
  if (articleSourceUrl.value && id && frameDoc) {
    stopArticleReading = trackWebArticleReading(frameDoc, id, history, url => {
      void browser.tabs.create({url}).catch(() => {downloadNotice.value = translateLegacy('无法打开原网页');});
    });
  }
}
watch([parsedDocument, readerTab], ([document], [previousDocument]) => {
  clearReaderZoomGestures();
  if (document !== previousDocument) {
    readerScale.value = 1;
    loadedRichDocument = null;
    stopArticleReading?.();
    stopArticleReading = undefined;
    stopRichFrameListeners?.();
    stopRichFrameListeners = undefined;
    activeRichHeadingIndex.value = -1;
  }
  const revision = readerZoomRevision;
  void nextTick().then(() => {if (revision === readerZoomRevision) bindReaderZoomGestures();});
}, {flush: 'sync'});
onUnmounted(() => {
  clearReaderZoomGestures();
  stopRichFrameListeners?.();
  stopRichFrameListeners = undefined;
  revokeEpubAssets();
});

let richPreviewTimer: ReturnType<typeof setTimeout> | undefined;
const pendingRichSegmentIds = new Set<number>();
/** 译文或阅读方式变化时原位更新预览框：流式译文优先按片段 ID 原位补丁，结构或模式切换再整页同步。 */
function refreshRichPreview(forceFull = false): void {
  clearTimeout(richPreviewTimer);
  richPreviewTimer = undefined;
  const doc = richPreviewDocument.value;
  if (!doc) return;
  if (!forceFull && pendingRichSegmentIds.size > 0) {
    const chapter = currentEpubChapter.value;
    const rawTranslations = toRaw(translatedSegments.value);
    const updates: Array<{id: number; source?: string; translation: string}> = [];
    for (const globalId of pendingRichSegmentIds) {
      if (chapter) {
        if (globalId < chapter.segmentOffset || globalId >= chapter.segmentOffset + chapter.segmentCount) continue;
        const localId = globalId - chapter.segmentOffset;
        updates.push({id: localId, source: doc.segments[localId]?.source, translation: rawTranslations[globalId] || ''});
      } else {
        updates.push({id: globalId, source: doc.segments[globalId]?.source, translation: rawTranslations[globalId] || ''});
      }
    }
    pendingRichSegmentIds.clear();
    const format = parsedDocument.value?.format;
    if (updates.length === 0) {
      markRichPreviewBusy(richFrame.value, translating.value);
      return;
    }
    if (patchRichPreviewSegments(richFrame.value, updates, {
      mode: effectivePreviewMode.value,
      format: format === 'markdown' || format === 'txt' || format === 'html' || format === 'epub' ? format : undefined,
    })) {
      markRichPreviewBusy(richFrame.value, translating.value);
      return;
    }
  }
  pendingRichSegmentIds.clear();
  const html = buildRichPreview();
  if (!syncRichPreview(richFrame.value, html)) {richFrameHtml.value = html; return;}
  applyRichReaderZoom();
  markRichPreviewBusy(richFrame.value, translating.value);
  richOutline.value = collectRichOutline(richFrame.value);
  activeRichHeadingIndex.value = findActiveRichOutlineIndex(richFrame.value);
}
/** 翻译进行中逐段到达的译文按节流间隔刷新：先译完的先显示，不必等全文结束。 */
function scheduleRichPreview(): void {
  if (richPreviewTimer !== undefined || !richPreviewDocument.value) return;
  richPreviewTimer = setTimeout(() => refreshRichPreview(false), richPreviewInterval(richPreviewDocument.value.segments.length));
}
// 换文档、换章节、换主题或阅读外观时整页载入一次；之后的译文与阅读方式变化都原位更新。
watch([richPreviewDocument, isDark, richBilingualLayout, richReadingTheme, richFontFamily], () => {
  clearTimeout(richPreviewTimer);
  richPreviewTimer = undefined;
  stopRichFrameListeners?.();
  stopRichFrameListeners = undefined;
  pendingRichSegmentIds.clear();
  richOutline.value = [];
  activeRichHeadingIndex.value = -1;
  richFrameHtml.value = buildRichPreview();
}, {immediate: true});
watch([effectivePreviewMode, translating], () => refreshRichPreview(true));
watch(settledTranslations, () => {
  if (!translating.value) refreshRichPreview(true);
});
// 只有带目录的文档才有“目录”页；其余文档始终显示文件页，避免停在不存在的页签上。
/** Word 文档的多级目录取自标题样式与大纲层级；翻译停下后显示它们的译文。 */
const docxOutline = computed<RichOutlineItem[]>(() => {
  const document = parsedDocument.value;
  if (document?.binary?.kind !== 'docx') return [];
  return buildDocxOutline(document.binary.parts, document.segments, settledTranslations.value).map(item => ({
    index: item.segmentIndex,
    level: item.level,
    source: item.source,
    translation: item.translation,
  }));
});
const documentOutline = computed(() => isDocxDocument.value ? docxOutline.value : richOutline.value);
/** 跳到目录项：富文本预览滚动到对应标题；Word 先切到标题所在的部分和分页，再滚动到该段落。 */
async function jumpOutline(item: RichOutlineItem): Promise<void> {
  if (!isDocxDocument.value) {scrollRichOutline(richFrame.value, item.index); return;}
  const partIndex = docxParts.value.findIndex(part => part.paragraphSegments.some(paragraph => paragraph.segmentIndex === item.index));
  if (partIndex < 0) return;
  docxPartIndex.value = partIndex;
  await nextTick();
  readerPage.value = findDocxBlockPage(currentDocxAllBlocks.value, item.index, READER_PAGE_SIZE);
  await nextTick();
  window.document.querySelector?.(`.docx-paragraph[data-segment="${item.index}"]`)?.scrollIntoView({block: 'start', behavior: 'smooth'});
}
/** PDF 里还有没识别的扫描页（整份扫描件，或文字 PDF 里夹着的扫描页）：开始翻译时先识别文字。空白页不触发识别。 */
const needsOcr = computed(() => pdfPagesNeedingOcr(parsedDocument.value).length > 0);
// 原文模型只在导入、恢复或识别后更换；译文和阅读控件更新不重新扫描，也不推断缺失字符的含义。
const pdfSourceCharacterWarning = computed(() => {
  const document = parsedDocument.value;
  if (document?.binary?.kind !== 'pdf') return false;
  const anomalous = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  return document.binary.pages.some(page => page.blocks.some(block => anomalous.test(block.source ?? '')))
    || document.segments.some(segment => anomalous.test(segment.source));
});
const pdfOcrReviewPages = computed(() => parsedDocument.value?.binary?.kind === 'pdf'
  ? parsedDocument.value.binary.pages.filter(page => page.ocrReviewRegions?.length).map(page => page.pageNumber) : []);
async function reviewPdfOcrSource() {
  const document = parsedDocument.value, page = pdfOcrReviewPages.value[0];
  if (!page) return;
  readerTab.value = 'read'; previewMode.value = 'source';
  await nextTick();
  if (parsedDocument.value !== document) return;
  await materialPdfReader.value?.resumePage?.(page);
}
interface DocumentOutlineRow {
  key: string;
  level: number;
  label: string;
  title: string;
  item?: RichOutlineItem;
  chapter?: number;
  fragment?: string;
  isChapter?: boolean;
  page?: number;
  segmentId?: number;
  coverage?: {completed: number; total: number};
  current: boolean;
}
const jsonOutlineEntries = computed(() => isJsonDocument.value && parsedDocument.value && typeof buildJsonOutline === 'function'
  ? buildJsonOutline(parsedDocument.value, settledTranslations.value, READER_PAGE_SIZE) : []);
const subtitleTimelineBuckets = computed(() => isSubtitleDocument.value && parsedDocument.value && typeof buildSubtitleTimelineOutline === 'function'
  ? buildSubtitleTimelineOutline(activeSegments.value, settledTranslations.value, {pageSize: READER_PAGE_SIZE}) : []);
const outlineHasLanguageToggle = computed(() => isRichDocument.value || isDocxDocument.value);

/**
 * 侧栏目录的行。ePub 列出全部章节（融合嵌套 TOC 层级与锚点），当前章节下接着各级标题；
 * Markdown/HTML/DOCX 展示标题目录并高亮视口活跃项；JSON 展示命名空间目录，长字幕展示时间轴分段。
 */
const outlineRows = computed<DocumentOutlineRow[]>(() => {
  const label = (item: RichOutlineItem) => richOutlineLanguage.value === 'translated' && item.translation ? item.translation : item.source;
  const headings = (offset: number): DocumentOutlineRow[] => documentOutline.value.map(item => ({
    key: `h${item.index}`, level: item.level + offset, label: label(item), title: item.source, item,
    current: !isDocxDocument.value && activeRichHeadingIndex.value === item.index,
  }));
  if (isJsonDocument.value) {
    return jsonOutlineEntries.value.map((entry, idx) => ({
      key: `j${idx}-${entry.path}`, level: 1, label: entry.key, title: entry.path,
      page: entry.page, segmentId: entry.startSegmentIndex,
      coverage: !translating.value ? {completed: entry.completed, total: entry.total} : undefined,
      current: readerPage.value === entry.page && idx === jsonOutlineEntries.value.findIndex(item => item.page === readerPage.value),
    }));
  }
  if (isSubtitleDocument.value) {
    if (subtitleTimelineBuckets.value.length <= 1) return [];
    const activeIdx = subtitleTimelineBuckets.value.findIndex(item => item.page === readerPage.value);
    return subtitleTimelineBuckets.value.map((bucket, idx) => ({
      key: bucket.id, level: 1, label: bucket.label, title: bucket.label,
      page: bucket.page, segmentId: bucket.firstSegmentId,
      coverage: !translating.value ? {completed: bucket.completed, total: bucket.total} : undefined,
      current: idx === activeIdx,
    }));
  }
  if (!isEpubDocument.value) return headings(0);
  const segments = parsedDocument.value!.segments, wanted = richOutlineLanguage.value === 'translated';
  const tocByChapter = new Map<number, EpubTocItem[]>();
  for (const tocItem of epubNestedToc.value) {
    if (tocItem.chapterIndex < 0) continue;
    const list = tocByChapter.get(tocItem.chapterIndex) ?? [];
    list.push(tocItem);
    tocByChapter.set(tocItem.chapterIndex, list);
  }
  return epubChapters.value.flatMap((chapter, index) => {
    const current = index === epubChapterIndex.value;
    const tocEntries = tocByChapter.get(index) ?? [];
    const primaryToc = tocEntries[0];
    const displayTitle = primaryToc?.title || chapter.title;
    const name = displayTitle.toLocaleLowerCase();
    const heading = segments.slice(chapter.segmentOffset, chapter.segmentOffset + Math.min(3, chapter.segmentCount)).find(segment => segment.source.toLocaleLowerCase().includes(name));
    const chapterSegments = segments.slice(chapter.segmentOffset, chapter.segmentOffset + chapter.segmentCount);
    const coverage = !translating.value && chapter.segmentCount > 0
      ? {completed: countCompletedTranslations(settledTranslations.value, chapterSegments), total: chapter.segmentCount}
      : undefined;
    const baseLevel = Math.max(1, primaryToc?.level ?? 1);
    const row: DocumentOutlineRow = {
      key: `c${index}`, level: baseLevel,
      label: (wanted && heading && settledTranslations.value[heading.id]) || displayTitle,
      title: displayTitle, chapter: index, fragment: primaryToc?.fragment || undefined,
      isChapter: true, coverage, current,
    };
    const subTocRows: DocumentOutlineRow[] = tocEntries.slice(1).map((sub, subIdx) => ({
      key: `c${index}-t${subIdx}`, level: Math.max(baseLevel + 1, sub.level ?? baseLevel + 1),
      label: sub.title, title: sub.title, chapter: index, fragment: sub.fragment || undefined,
      isChapter: false, current: false,
    }));
    const currentHeadings = current && !subTocRows.length
      ? headings(baseLevel).filter(entry => entry.title !== row.title && entry.title !== heading?.source)
      : [];
    return [row, ...subTocRows, ...currentHeadings];
  });
});

function expandJsonAncestorsForSegment(segmentId: number): void {
  const entries = parsedDocument.value?.jsonEntries;
  const entry = entries?.find(item => item.segmentIndex === segmentId) ?? entries?.[segmentId];
  if (!entry?.path) return;
  const next = new Set(jsonExpandedPaths.value);
  next.add('$');
  for (let depth = 1; depth < entry.path.length; depth += 1) {
    next.add(formatJsonPath(entry.path.slice(0, depth)));
  }
  jsonExpandedPaths.value = next;
  const targetIndex = jsonTreeNodes.value.findIndex(node => node.segmentId === segmentId);
  if (targetIndex >= jsonTreeVisibleLimit.value) jsonTreeVisibleLimit.value = targetIndex + 50;
}

async function activateOutlineRow(row: DocumentOutlineRow): Promise<void> {
  if (window.matchMedia('(max-width: 760px)').matches) sidebarOpen.value = false;
  if (row.item) {
    await jumpOutline(row.item);
    return;
  }
  if (row.chapter !== undefined) {
    if (row.chapter === epubChapterIndex.value) {
      if (row.fragment) scrollRichFragment(row.fragment);
    } else {
      pendingEpubFragment = row.fragment || '';
      epubChapterIndex.value = row.chapter;
    }
    return;
  }
  if (row.page !== undefined) {
    if (isJsonDocument.value && jsonViewMode.value === 'tree' && row.segmentId !== undefined) {
      expandJsonAncestorsForSegment(row.segmentId);
    } else {
      readerPage.value = row.page;
    }
    await nextTick();
    if (row.segmentId !== undefined) {
      window.document.querySelector?.(`[data-segment="${row.segmentId}"]`)?.scrollIntoView?.({block: 'start', behavior: 'smooth'});
    }
  }
}

const hasOutline = computed(() => isPdfDocument.value || outlineRows.value.length > 0);
const activeSidebarTab = computed(() => hasOutline.value ? sidebarTab.value : 'files');
onUnmounted(() => clearTimeout(richPreviewTimer));

const docxParts = computed(() => parsedDocument.value?.binary?.kind === 'docx'
  ? parsedDocument.value.binary.parts
  : []);
const currentDocxPart = computed(() => docxParts.value[docxPartIndex.value]);
const currentDocxPartMeta = shallowRef<DocxPartMetadata | null>(null);
let docxMetaGeneration = 0;
watch([parsedDocument, currentDocxPart], ([doc, part]) => {
  const generation = ++docxMetaGeneration;
  currentDocxPartMeta.value = null;
  if (!doc || doc.binary?.kind !== 'docx' || !part || typeof loadDocxPartMetadata !== 'function') return;
  void loadDocxPartMetadata(doc.binary.bytes, part.path).then(meta => {
    if (generation !== docxMetaGeneration || disposed || parsedDocument.value !== doc || currentDocxPart.value !== part) return;
    currentDocxPartMeta.value = meta;
  }).catch(() => {});
}, {immediate: true});
const currentDocxAllBlocks = computed(() => isDocxDocument.value && readerTab.value === 'read' && parsedDocument.value && currentDocxPart.value && typeof buildDocxRichBlocks === 'function'
  ? buildDocxRichBlocks(currentDocxPart.value, parsedDocument.value.segments, translatedSegments.value, currentDocxPartMeta.value ?? undefined) : []);
const currentDocxPaginated = computed(() => typeof paginateDocxBlocks === 'function'
  ? paginateDocxBlocks(currentDocxAllBlocks.value, readerPage.value, READER_PAGE_SIZE)
  : {page: 1, pageSize: READER_PAGE_SIZE, totalPages: 1, totalBlocks: 0, blocks: [], pageRanges: []});
const docxParagraphShowsSource = (paragraph: DocxRichParagraph) => effectivePreviewMode.value !== 'translated' || Boolean(paragraph.translationText && !paragraph.hasDistinctTranslation);
const docxParagraphShowsTranslation = (paragraph: DocxRichParagraph) => effectivePreviewMode.value !== 'source' && (!paragraph.translationText || paragraph.hasDistinctTranslation);
function docxRunClasses(run: DocxInlineRun): Record<string, boolean> {
  return {
    'docx-run-bold': Boolean(run.bold),
    'docx-run-italic': Boolean(run.italic),
    'docx-run-underline': Boolean(run.underline),
    'docx-run-strike': Boolean(run.strike),
    'docx-run-code': Boolean(run.code),
  };
}

const delimitedGrid = computed(() => parsedDocument.value?.delimitedColumns && delimitedViewMode.value === 'grid' && readerTab.value === 'read' && typeof buildDelimitedGrid === 'function'
  ? buildDelimitedGrid(parsedDocument.value, translatedSegments.value, {selectedColumns: selectedDelimitedColumns.value}) : null);
const delimitedPaginated = computed(() => delimitedGrid.value && typeof paginateDelimitedRows === 'function'
  ? paginateDelimitedRows(delimitedGrid.value, readerPage.value, DELIMITED_PAGE_SIZE) : null);
const delimitedVisibleRows = computed(() => {
  const grid = delimitedGrid.value, paged = delimitedPaginated.value;
  if (!grid || !paged) return [];
  return paged.page === 1 && grid.headerRow ? [grid.headerRow, ...paged.rows] : paged.rows;
});
function delimitedCellCoord(cell: DelimitedGridCell): string {
  return `R${cell.row + 1}C${cell.column + 1}`;
}
function delimitedCellShowsSource(cell: DelimitedGridCell): boolean {
  return effectivePreviewMode.value !== 'translated' || Boolean(cell.translation && !hasDistinctTranslation(cell.raw, cell.translation));
}
function delimitedCellShowsTranslation(cell: DelimitedGridCell): boolean {
  return effectivePreviewMode.value !== 'source' && (!cell.translation || hasDistinctTranslation(cell.raw, cell.translation));
}
function toggleDelimitedColumn(columnIndex: number): void {
  const current = selectedDelimitedColumns.value;
  if (current.includes(columnIndex)) {
    if (current.length <= 1) return;
    updateDelimitedColumns(current.filter(index => index !== columnIndex));
  } else {
    updateDelimitedColumns([...current, columnIndex]);
  }
}

const jsonGrouped = computed(() => isJsonDocument.value && jsonViewMode.value === 'table' && readerTab.value === 'read' && parsedDocument.value
  ? buildJsonGroupedRows(parsedDocument.value, translatedSegments.value, readerPage.value, READER_PAGE_SIZE) : null);
const jsonTreeNodes = computed(() => isJsonDocument.value && jsonViewMode.value === 'tree' && readerTab.value === 'read' && parsedDocument.value
  ? buildJsonTreeNodes(parsedDocument.value, translatedSegments.value, jsonExpandedPaths.value) : []);
const visibleJsonTreeNodes = computed(() => jsonTreeNodes.value.slice(0, jsonTreeVisibleLimit.value));
function toggleJsonTreePath(path: string): void {
  const next = new Set(jsonExpandedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  jsonExpandedPaths.value = next;
}
watch(parsedDocument, document => {
  jsonTreeVisibleLimit.value = 200;
  if (document?.format !== 'json' || document.jsonValue === undefined) {
    jsonExpandedPaths.value = new Set(['$']);
    return;
  }
  const expanded = new Set<string>(['$']);
  if (document.jsonValue && typeof document.jsonValue === 'object' && !Array.isArray(document.jsonValue)) {
    for (const key of Object.keys(document.jsonValue as Record<string, unknown>).slice(0, 10)) {
      expanded.add(/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `$.${key}` : `$[${JSON.stringify(key)}]`);
    }
  }
  jsonExpandedPaths.value = expanded;
}, {immediate: true});

const subtitleMetadata = computed(() => isSubtitleDocument.value && parsedDocument.value
  ? extractSubtitleMetadata(parsedDocument.value) : null);
const subtitleLrcMeta = computed(() => {
  const lrc = subtitleMetadata.value?.lrc;
  return lrc && (lrc.title || lrc.artist || lrc.album) ? lrc : null;
});
const subtitleRows = computed(() => previewRows.value);
const subtitleDisplayRows = computed(() => {
  const format = parsedDocument.value?.format;
  const cues = subtitleMetadata.value?.cues;
  return subtitleRows.value.map(row => {
    const plainSource = readerText(row.source);
    const plainTranslation = row.translation ? readerText(row.translation) : '';
    const distinct = Boolean(plainTranslation) && hasDistinctTranslation(plainSource, plainTranslation);
    const showSource = effectivePreviewMode.value !== 'translated' || (Boolean(plainTranslation) && !distinct);
    const showTranslation = effectivePreviewMode.value !== 'source' && (!plainTranslation || distinct);
    const metrics = formatSubtitleDuration(row.timeStart, row.timeEnd, plainSource);
    const sourceRich = parseSubtitleRichText(format, row.source);
    const translationRich = distinct ? parseSubtitleRichText(format, row.translation) : {runs: []};
    const cueMeta = cues?.get(row.index);
    return {
      ...row,
      showSource,
      showTranslation,
      durationLabel: metrics.durationLabel,
      speaker: cueMeta?.actor || sourceRich.speaker || '',
      style: cueMeta?.style || '',
      sourceRuns: sourceRich.runs.length ? sourceRich.runs : [{text: plainSource}],
      translationRuns: translationRich.runs.length ? translationRich.runs : (distinct ? [{text: plainTranslation}] : []),
    };
  });
});

function editSegmentInProofread(segmentId: number): void {
  editorFocusSegmentId.value = segmentId;
  readerTab.value = 'edit';
}

async function locateSegmentInReader(segmentId: number): Promise<void> {
  const doc = parsedDocument.value;
  if (!doc) return;
  readerTab.value = 'read';
  editorFocusSegmentId.value = null;
  await nextTick();
  if (isPdfDocument.value) {
    const pageEntry = doc.binary?.kind === 'pdf'
      ? doc.binary.pages.find(page => page.segmentIndexes.includes(segmentId))
      : undefined;
    if (typeof materialPdfReader.value?.resumeLocation === 'function') {
      const ok = await materialPdfReader.value.resumeLocation(segmentId);
      if (ok) return;
    }
    if (pageEntry) await materialPdfReader.value?.resumePage?.(pageEntry.pageNumber);
    return;
  }
  if (isEpubDocument.value) {
    const targetChapter = epubChapters.value.findIndex(chapter => segmentId >= chapter.segmentOffset && segmentId < chapter.segmentOffset + chapter.segmentCount);
    if (targetChapter < 0) return;
    if (targetChapter === epubChapterIndex.value) {
      scrollRichSegment(segmentId);
    } else {
      pendingRichLocateSegmentId = segmentId;
      epubChapterIndex.value = targetChapter;
    }
    return;
  }
  if (isRichDocument.value) {
    scrollRichSegment(segmentId);
    return;
  }
  if (isDocxDocument.value) {
    const partIndex = docxParts.value.findIndex(part => part.paragraphSegments.some(item => item.segmentIndex === segmentId));
    if (partIndex >= 0) {
      docxPartIndex.value = partIndex;
      await nextTick();
      readerPage.value = findDocxBlockPage(currentDocxAllBlocks.value, segmentId, READER_PAGE_SIZE);
      await nextTick();
      window.document.querySelector?.(`.docx-paragraph[data-segment="${segmentId}"]`)?.scrollIntoView?.({block: 'center', behavior: 'smooth'});
    }
    return;
  }
  if (doc.delimitedColumns && delimitedViewMode.value === 'grid' && delimitedGrid.value) {
    const rowIdx = delimitedGrid.value.rows.findIndex(row => row.cells.some(cell => cell.segmentId === segmentId));
    readerPage.value = rowIdx >= 0 ? Math.floor(rowIdx / DELIMITED_PAGE_SIZE) + 1 : 1;
    await nextTick();
    window.document.querySelector?.(`[data-segment="${segmentId}"]`)?.scrollIntoView?.({block: 'center', behavior: 'smooth'});
    return;
  }
  if (isJsonDocument.value && jsonViewMode.value === 'tree') {
    expandJsonAncestorsForSegment(segmentId);
    await nextTick();
    window.document.querySelector?.(`[data-segment="${segmentId}"]`)?.scrollIntoView?.({block: 'center', behavior: 'smooth'});
    return;
  }
  const activeIdx = activeSegments.value.findIndex(segment => segment.id === segmentId);
  if (activeIdx >= 0) {
    readerPage.value = Math.floor(activeIdx / READER_PAGE_SIZE) + 1;
    await nextTick();
    window.document.querySelector?.(`[data-segment="${segmentId}"]`)?.scrollIntoView?.({block: 'center', behavior: 'smooth'});
  }
}

const emptyReaderHint = computed(() => isPdfDocument.value ? t(parsedDocument.value?.segments.length ? 'document.pdfReading.startHint' : 'document.pdfReading.selectableSource') : getDocumentEmptyReaderHint(parsedDocument.value));
const readerPageCount = computed(() => {
  if (isPdfDocument.value || isRichDocument.value) return 1;
  if (isDocxDocument.value) return currentDocxPaginated.value.totalPages;
  if (parsedDocument.value?.delimitedColumns && delimitedViewMode.value === 'grid') return delimitedPaginated.value?.totalPages ?? 1;
  if (isJsonDocument.value && jsonViewMode.value === 'tree') return 1;
  return Math.max(1, Math.ceil(activeSegments.value.length / READER_PAGE_SIZE));
});
watch(readerPageCount, count => {
  if (readerPage.value > count) readerPage.value = count;
});

const pdfSegmentPages = computed(() => {
  const binary = parsedDocument.value?.binary;
  if (binary?.kind !== 'pdf') return null;
  const map = new Map<number, number>();
  binary.pages.forEach((page, index) => page.segmentIndexes.forEach(segment => { if (!map.has(segment)) map.set(segment, index); }));
  return {map, count: binary.pages.length};
});
interface ReadingPrioritySnapshot {
  readonly pages: typeof pdfSegmentPages.value;
  readonly total: number;
  readonly start: number;
}
let previousReadingPriority: ReadingPrioritySnapshot | undefined;
/** 标识涵盖排名实际使用的页码映射、全文长度与阅读锚点；富文本滚动按当前片段粒度读取。 */
function readingPriorityKey(): ReadingPrioritySnapshot {
  const pages = pdfSegmentPages.value;
  const total = parsedDocument.value?.segments.length || 1;
  let start: number;
  if (pages) start = pdfPage.value - 1;
  else {
    // ePub 从当前章节，Word 从当前部分的当前页，字幕与表格从当前页的第一段开始。
    const offset = (readerPage.value - 1) * READER_PAGE_SIZE;
    const chapter = currentEpubChapter.value;
    const anchor = chapter?.segmentOffset
      ?? (currentDocxPart.value ? currentDocxPart.value.paragraphSegments[offset]?.segmentIndex ?? 0 : isRichDocument.value ? 0 : activeSegments.value[offset]?.id ?? 0);
    const scrolled = isRichDocument.value ? Math.floor(richPreviewPosition(richFrame.value) * (chapter ? chapter.segmentCount : total)) : 0;
    start = anchor + scrolled;
  }
  if (previousReadingPriority?.pages === pages && previousReadingPriority.total === total && previousReadingPriority.start === start) return previousReadingPriority;
  return previousReadingPriority = {pages, total, start};
}
/** 从正在阅读的位置开始向后翻译，读到哪里先译哪里；前面的内容排在全文末尾之后。 */
function prioritizeReadingPosition<T extends {id: number}>(pending: readonly T[]): T[] {
  const {pages, total, start} = readingPriorityKey();
  if (pages) {
    const rank = (segment: T) => ((pages.map.get(segment.id) ?? 0) - start + pages.count) % pages.count;
    return [...pending].sort((left, right) => rank(left) - rank(right) || left.id - right.id);
  }
  if (!start) return [...pending];
  const rank = (segment: T) => (segment.id - start + total) % total;
  return [...pending].sort((left, right) => rank(left) - rank(right));
}

function releaseDocumentPreview(document: ParsedDocument | null): void {
  if (document?.binary?.kind === 'pdf') releasePdfDocument(document.binary.bytes);
}

function saveDownloadBlob(blob: Blob, fileName: string): void {
  exportWorkflow.saveBlob(blob, fileName);
}

function readerText(value: string): string {
  return formatDocumentReaderText(parsedDocument.value?.format, value);
}

function applyTheme(): void {
  systemDark.value = colorSchemeMedia.matches;
}

function handleDropZoneClick(event: MouseEvent): void {
  if (queueBusy.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.('button, a, input, label')) return;
  openFilePicker();
}

const configEditor = useConfigEditor({
  copySnapshot: value => JSON.parse(JSON.stringify(value)) as Config,
  readDraft: () => config,
  writeDraft: snapshot => {
    Object.assign(config, snapshot);
    if (!config.on && (translating.value || batchRunning.value)) pauseTranslation();
  },
  // 同一轮模型选择保留 documentModel/documentCustomModel 的原子 patch，
  // 独立模型映射继续基于最新运行时配置合并，不能覆盖其他服务的修改。
  saveDraft: (value, previous) => {
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
    return Object.keys(patch).length === 0 ? Promise.resolve()
      : requestConfigPatch(patch, browser.runtime.sendMessage.bind(browser.runtime));
  },
  subscribe: subscribeConfig,
  ready: configReady,
  readAuthority: () => runtimeConfig,
  flush: 'post',
  onEdited: () => {},
  onSaved: () => {configSaveError.value = '';},
  onSaveError: () => {configSaveError.value = '设置未能保存，请重新调整后再试。';},
  onReady: () => {hydrated.value = true;},
  onReadyError: () => {configSaveError.value = t('document.config.loadFailed');},
});

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
  await importWorkflow.loadFiles(files, sourceUrl);
}

function cancelImport(): void {importWorkflow.cancel();}

async function openOnlinePdf(): Promise<void> {
  if (disposed || queueBusy.value) return;
  await importWorkflow.openOnlinePdf(onlinePdfUrl.value);
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
  const hadDocument = Boolean(parsedDocument.value);
  pendingEpubFragment = '';
  pendingRichLocateSegmentId = null;
  discardPendingTranslationBatch();
  stopArticleReading?.();
  stopArticleReading = undefined;
  stopRichFrameListeners?.();
  stopRichFrameListeners = undefined;
  revokeEpubAssets();
  persistHistory();
  documentAIContextOverride.value = null;
  requestEvidence.value = null;
  recognitionProgress.value = '';
  cancelImport();
  releaseDocumentPreview(parsedDocument.value);
  documentQueue.value.forEach(item => releaseDocumentPreview(item.document));
  exportWorkflow.reset();
  recognitionWorkflow.cancel();
  clearConfirmation();
  configEditor.invalidateFeedback();
  cancelingDownload.value = false;
  downloadProgress.value = '';
  downloadPdfProgress.value = null;
  downloadDialog.value?.close();
  documentSettingsDialog.value?.close();
  downloadOpen.value = false;
  batchGeneration += 1;
  batchRunning.value = false;
  documentTasks.clear();
  batchNotice.value = '';
  translationRequestId += 1;
  abortController?.abort();
  abortController = null;
  translating.value = false;
  settledTranslations.value = [];
  downloadNotice.value = '';
  originalDownloadError.value = '';
  openingFile.value = false;
  preparingDownload.value = false;
  epubChapterIndex.value = 0;
  docxPartIndex.value = 0;
  if (hadDocument && historyAvailable && !disposed) void refreshHistory();
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

function clearGlossaryReview(): void {
  glossaryController?.abort();
  glossaryController = null;
  glossaryReviewOpen.value = false;
  glossarySuggesting.value = false;
  glossaryChoices.value = [];
  glossaryReviewError.value = '';
}

function returnFromGlossaryReview(): void {
  clearGlossaryReview();
  void nextTick(() => glossaryReviewButton.value?.focus?.());
}

async function extractGlossaryCandidates(): Promise<void> {
  const document = parsedDocument.value;
  if (!document || !canExtractGlossary.value || queueBusy.value) return;
  clearGlossaryReview();
  glossaryReviewOpen.value = true;
  void nextTick(() => documentSettingsHeading.value?.focus?.());
  glossaryDestinationId.value = glossaryDestinations.value[0]?.id ?? '';
  const candidates = filterDocumentGlossaryCandidates(config, extractDocumentGlossaryCandidates(activeSegments.value));
  glossaryChoices.value = candidates.map(candidate => ({...candidate, target: '', selected: false}));
  if (!candidates.length) return;
  if (credentialWarning.value) {
    glossaryReviewError.value = glossaryCopy.value.suggestionUnavailable;
    return;
  }
  const controller = glossaryController = new AbortController();
  glossarySuggesting.value = true;
  try {
    const result = await translateDocumentSegments(candidates.map(({source}, id) => ({id, source})), {
      fileName: document.fileName, signal: controller.signal, glossaryIds: [],
      sourceLanguage: config.from === 'auto' ? 'en' : config.from, targetLanguage: config.to,
      serviceOverride: effectiveDocumentService.value, modelOverride: documentUsesModel.value ? documentModelValue.value : undefined,
    });
    if (glossaryController !== controller) return;
    glossaryChoices.value.forEach((choice, id) => {choice.target = result[id]?.trim().slice(0, 200) ?? '';});
  } catch {
    if (glossaryController === controller) glossaryReviewError.value = glossaryCopy.value.suggestionUnavailable;
  } finally {
    if (glossaryController === controller) {
      glossaryController = null;
      glossarySuggesting.value = false;
    }
  }
}

async function applyGlossaryChoices(): Promise<void> {
  const document = parsedDocument.value;
  if (!document || !canApplyGlossary.value) return;
  if (settingsChanged.value) {
    glossaryReviewError.value = glossaryCopy.value.settingsChanged;
    return;
  }
  const choices = glossaryChoices.value.filter(choice => choice.selected);
  const destinationId = glossaryDestinationId.value;
  const reviewedFingerprint = currentFingerprint.value;
  const reviewedColumns = columnScope.value;
  glossarySaving.value = true;
  glossaryReviewError.value = '';
  glossaryNotice.value = '';
  try {
    await configEditor.save();
    if (disposed || parsedDocument.value !== document) return;
    if (reviewedFingerprint !== currentFingerprint.value || reviewedColumns !== columnScope.value || settingsChanged.value) {
      glossaryReviewError.value = glossaryCopy.value.settingsChanged;
      return;
    }
    const plan = planDocumentGlossaryUpdate(runtimeConfig, document.segments, choices, destinationId, glossaryCopy.value.libraryName);
    if ('error' in plan) {
      glossaryReviewError.value = glossaryCopy.value[plan.error];
      return;
    }
    const {affectedIds, ...patch} = plan;
    const fingerprint = JSON.stringify({...JSON.parse(currentFingerprint.value), glossaryIds: patch.documentGlossaryIds,
      glossaryRevision: buildGlossaryRevision(patch.glossaryLibraries, patch.glossaryEnabled)});
    await requestConfigPatch(patch, browser.runtime.sendMessage.bind(browser.runtime));
    await nextTick();
    if (disposed || parsedDocument.value !== document) return;
    if (currentFingerprint.value !== fingerprint || reviewedColumns !== columnScope.value || !config.on || credentialWarning.value) {
      glossaryNotice.value = glossaryCopy.value.changedAfterSave;
      documentSettingsDialog.value?.close();
      return;
    }
    documentSettingsDialog.value?.close();
    // 当前未选且未翻译的表格列会在第一次翻译时使用新词库。已有旧译文继续等待该列被选中。
    const pending = reactive(new Set([...affectedIds].filter(id => !reviewedColumns || reviewedColumns.has(id) || Boolean(translatedSegments.value[id]?.trim()))));
    glossaryNotice.value = glossaryCopy.value.saved;
    if (!pending.size) {
      taskFingerprint.value = fingerprint;
      editRevision.value += 1;
      scheduleHistorySave();
      return;
    }
    const task = {document, fingerprint, pending};
    glossaryRetranslation.value = task;
    if (pendingGlossaryRetranslation.value) void startTranslation(false, task);
  } catch {
    if (!disposed && parsedDocument.value === document) glossaryReviewError.value = glossaryCopy.value.saveFailed;
  } finally {
    glossarySaving.value = false;
  }
}

function resumeGlossaryRetranslation(): void {
  const task = pendingGlossaryRetranslation.value;
  if (task && !queueBusy.value) void startTranslation(false, task);
}

function requestReset(): void {
  if (openingFile.value || preparingDownload.value || batchRunning.value) return;
  if (hasUnsavedWork.value) {
    pendingAction.value = 'reset';
    confirmDialog.value?.showModal();
  } else {rememberOpenDocument(null); resetDocument();}
}

function requestTranslation(): void {
  if (!config.on || queueBusy.value || !(activeSegments.value.length || needsOcr.value)) return;
  if (translationComplete.value || (settingsChanged.value && translatedSegments.value.some(text => text?.trim()))) {
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

let pendingTranslationBatch: DocumentTranslationUpdate[] = [];
let pendingTranslationById = new Map<number, string>();
let translationFlushQueued = false;
let translationBatchOwnerId: number | null = null;
let translationBatchRequestId = 0;

function discardPendingTranslationBatch(): void {
  pendingTranslationBatch = [];
  pendingTranslationById.clear();
  pendingRichSegmentIds.clear();
  translationFlushQueued = false;
  translationBatchOwnerId = null;
  translationBatchRequestId = 0;
}

function flushTranslationBatch(): void {
  translationFlushQueued = false;
  if (disposed || !pendingTranslationBatch.length) return;
  const ownerId = translationBatchOwnerId;
  const batchRequestId = translationBatchRequestId;
  const batch = pendingTranslationBatch;
  pendingTranslationBatch = [];
  pendingTranslationById.clear();
  translationBatchOwnerId = null;
  translationBatchRequestId = 0;
  if ((ownerId !== null && ownerId !== activeDocumentId.value) || (batchRequestId !== 0 && batchRequestId !== translationRequestId)) return;
  setDocumentTranslationBatch(batch);
  scheduleHistorySave();
  scheduleRichPreview();
}

function enqueueTranslationSegment(id: number, translation: string, requestId: number): void {
  const ownerId = activeDocumentId.value;
  if ((translationBatchOwnerId !== null && translationBatchOwnerId !== ownerId) || (translationBatchRequestId !== 0 && translationBatchRequestId !== requestId)) {
    discardPendingTranslationBatch();
  }
  translationBatchOwnerId = ownerId;
  translationBatchRequestId = requestId;
  const previous = pendingTranslationById.has(id)
    ? pendingTranslationById.get(id)!
    : (toRaw(translatedSegments.value)[id] ?? '');
  liveCompletedSegments.value += Number(Boolean(translation.trim())) - Number(Boolean(previous.trim()));
  pendingTranslationById.set(id, translation);
  pendingTranslationBatch.push({id, translation});
  if (richPreviewDocument.value) pendingRichSegmentIds.add(id);
  editRevision.value += 1;
  if (!translationFlushQueued) {
    translationFlushQueued = true;
    queueMicrotask(flushTranslationBatch);
  }
}

function pauseTranslation(): void {
  flushTranslationBatch();
  retryNotice.value = '';
  retryWaiting.value = 0;
  recognitionProgress.value = '';
  batchGeneration += 1;
  batchRunning.value = false;
  translationRequestId += 1;
  abortController?.abort();
  abortController = null;
  activeGlossaryRetranslation = null;
  recognitionWorkflow.cancel();
  translating.value = false;
  runState.value = 'paused';
}

function pauseAndChangeService(): void {
  pauseTranslation();
  openDocumentSettings();
}

async function startTranslation(restart = false, glossaryTask?: GlossaryRetranslation): Promise<void> {
  let document = parsedDocument.value;
  // 扫描版 PDF 还没有任何文字：先逐页识别，再翻译识别出的段落。
  const scanned = !glossaryTask && needsOcr.value;
  if (!config.on || !document || !(activeSegments.value.length || scanned) || translating.value || !hydrated.value || preparingDownload.value || credentialWarning.value) return;
  const segmentIds = columnScope.value;
  const retranslateIds = glossaryTask ? new Set([...glossaryTask.pending].filter(id => !segmentIds || segmentIds.has(id))) : undefined;
  if (retranslateIds?.size === 0) return;
  if (restart) {
    if (segmentIds && !settingsChanged.value) {
      translatedSegments.value = translatedSegments.value.map((text, id) => segmentIds.has(id) ? '' : text);
      confirmedTranslationIds.value = confirmedTranslationIds.value.filter(id => !segmentIds.has(id));
    } else {
      translatedSegments.value = [];
      confirmedTranslationIds.value = [];
    }
    settledTranslations.value = [...translatedSegments.value];
    bypassCache.value = true;
    editRevision.value += 1;
    scheduleHistorySave();
  }
  if (!glossaryTask) {
    if (glossaryRetranslation.value?.document === document) glossaryRetranslation.value = null;
    taskFingerprint.value = currentFingerprint.value;
  }
  activeGlossaryRetranslation = glossaryTask ?? null;
  const glossaryIds = config.documentGlossaryIds === null ? null : [...config.documentGlossaryIds];
  const glossaryRevision = buildGlossaryRevision(config.glossaryLibraries, config.glossaryEnabled);
  const glossaryEnabled = config.glossaryEnabled;
  const glossarySupported = documentSupportsGlossary.value;
  const glossaryLibraries = toRaw(config.glossaryLibraries).map(library => ({
    ...library, domains: [...library.domains], entries: library.entries.map(entry => ({...entry})),
  }));
  requestEvidence.value = null;
  // OCR 可能持续较久；整个任务使用同一文件身份与设置快照，外部配置更新不混入正在处理的文件。
  const settings = {serviceOverride: effectiveDocumentService.value,
    ...(bypassCache.value || glossaryTask ? {useCache: false} : {}),
    modelOverride: documentUsesModel.value ? documentModelValue.value : undefined,
    sourceLanguage: config.from, targetLanguage: config.to, batchTranslation: documentBatchTranslation.value,
    materialId: documentQueue.value.find(item => item.id === activeDocumentId.value)?.historyId || `document:${activeDocumentId.value}`,
    enableAIContext: documentAIContextEnabled.value};
  runState.value = 'ready';
  liveCompletedSegments.value = completedSegments.value;
  translating.value = true;
  errorMessage.value = '';
  downloadNotice.value = '';
  retryWaiting.value = 0;
  const controller = new AbortController();
  const requestId = ++translationRequestId;
  abortController = controller;
  try {
    if (scanned) {
      const commitRecognition = (recognized: ParsedDocument) => {
        if (recognized === document) return;
        const retained = remapPdfTranslationState(document!, recognized, translatedSegments.value, confirmedTranslationIds.value);
        document = markRaw(recognized);
        parsedDocument.value = document;
        translatedSegments.value = retained.translations;
        settledTranslations.value = [...retained.translations];
        confirmedTranslationIds.value = retained.confirmedTranslationIds;
        liveCompletedSegments.value = retained.translations.filter(value => value.trim()).length;
        editRevision.value += 1;
        scheduleHistorySave();
      };
      const recognized = await recognitionWorkflow.recognize(document, {
        sourceLanguage: settings.sourceLanguage, signal: controller.signal, startPage: pdfPage.value - 1,
        isCurrent: () => requestId === translationRequestId && parsedDocument.value === document,
        onCheckpoint: commitRecognition,
      });
      if (!recognized) return;
      recognitionProgress.value = '';
      commitRecognition(recognized);
      if (!document.segments.length) {
        throw new Error(t('document.pdfReading.ocrEmpty'));
      }
      if (pdfPagesNeedingOcr(document).length) {
        runState.value = 'failed';
        showError(t('document.pdfReading.ocrIncomplete', {count: pdfPagesNeedingOcr(document).length}));
      }
    }
    const current = document;
    await translateDocumentSegments(document.segments, {
      fileName: document.fileName,
      ...settings,
      glossaryIds, glossaryRevision,
      initialTranslations: [...translatedSegments.value],
      ...(segmentIds ? {segmentIds} : {}),
      ...(retranslateIds ? {retranslateIds} : {}),
      confirmedTranslationIds: [...confirmedTranslationIds.value],
      signal: controller.signal,
      // 文档层统一退避重试，单批请求与等待默认最多十分钟，保留更长的服务预算；失败时显示原因。
      retryBackoff: documentRetryBackoff,
      onRetry: ({delayMs, reason}) => {
        if (requestId === translationRequestId && !controller.signal.aborted) retryNotice.value = `${translateLegacy('翻译服务暂时没有响应，将自动重试')} · ${Math.ceil(delayMs / 1000)}s · ${reason}`;
      },
      onRetryStateChange: ({waiting}) => {
        if (requestId !== translationRequestId || parsedDocument.value !== current || controller.signal.aborted) return;
        retryWaiting.value = waiting;
        if (!waiting) retryNotice.value = '';
      },
      // 一批失败时先说明原因并提供切换入口；已发出的其它成功结果仍可提交，用户显式暂停才终止它们。
      onFailure: ({reason}) => {
        if (requestId !== translationRequestId || parsedDocument.value !== current || controller.signal.aborted) return;
        runState.value = 'failed';
        showError(reason);
      },
      onRequestPrepared: ({segments, discourseContext}) => {
        if (requestId !== translationRequestId || parsedDocument.value !== current || controller.signal.aborted) return;
        rawRequestEvidence.value = {
          segments, discourseContext, enableAIContext: settings.enableAIContext,
          sourceLanguage: settings.sourceLanguage || '', targetLanguage: settings.targetLanguage || '',
          glossaryIds, glossaryEnabled, glossarySupported, glossaryLibraries,
        };
      },
      // 默认合并多段，使用 feature 的有界批量与并发；开关只作用于当前文档。
      prioritize: prioritizeReadingPosition,
      priorityKey: readingPriorityKey,
      onSegment: ({id, translation}) => {
        if (requestId !== translationRequestId || parsedDocument.value !== current || controller.signal.aborted) return;
        if (glossaryTask) {
          if (!translation.trim()) return;
          glossaryTask.pending.delete(id);
          confirmedTranslationIds.value = confirmedTranslationIds.value.filter(confirmed => confirmed !== id);
        }
        if (!retryWaiting.value) retryNotice.value = '';
        enqueueTranslationSegment(id, translation, requestId);
      },
    });
    flushTranslationBatch();
    if (glossaryTask && !glossaryTask.pending.size && requestId === translationRequestId && parsedDocument.value === current) {
      taskFingerprint.value = glossaryTask.fingerprint;
      glossaryRetranslation.value = null;
      glossaryNotice.value = glossaryCopy.value.saved;
      editRevision.value += 1;
    }
  } catch (error) {
    flushTranslationBatch();
    if (requestId !== translationRequestId || parsedDocument.value !== document) return;
    if (error instanceof TranslationRequestError && error.code === 'TRANSLATION_DISABLED') {
      pauseTranslation();
      return;
    }
    runState.value = 'failed';
    showError(error instanceof Error ? error.message : String(error));
  } finally {
    if (requestId === translationRequestId) {
      flushTranslationBatch();
      activeGlossaryRetranslation = null;
      translating.value = false;
      retryNotice.value = '';
      retryWaiting.value = 0;
      recognitionProgress.value = '';
      if (abortController === controller) abortController = null;
      persistHistory();
    }
  }
}

function openSourceEditor(segmentIndex?: number): void {
  const document = parsedDocument.value, task = activeTask.value;
  if (queueBusy.value || !task || document?.binary?.kind !== 'pdf') return;
  const page = document.binary.pages.find(page => segmentIndex === undefined ? page.pageNumber === pdfPage.value : page.segmentIndexes.includes(segmentIndex));
  if (!page) return;
  const eligible = page.blocks.flatMap((block, index) => pdfSourceEditTarget(document, page.pageNumber, index) ? [{block, index}] : []);
  const candidate = segmentIndex === undefined
    ? eligible.find(({block}) => page.ocrReviewRegions?.some(region => region.x >= block.x && region.y >= block.y && region.x < block.x + block.width && region.y < block.y + block.height)) ?? eligible[0]
    : eligible.find(({block}) => block.segmentIndex === segmentIndex);
  if (!candidate) return;
  documentSettingsDialog.value?.close();
  sourceEditTarget.value = {document, taskId: task.id, pageNumber: page.pageNumber, blockIndex: candidate.index};
}

function commitPdfSourceResult(result: PdfSourceEditResult): void {
  const task = activeTask.value!;
  if (result.document === parsedDocument.value) return;
  if (!taskFingerprint.value) taskFingerprint.value = currentFingerprint.value;
  parsedDocument.value = markRaw(result.document);
  translatedSegments.value = result.translations;
  settledTranslations.value = [...result.translations];
  confirmedTranslationIds.value = result.confirmedTranslationIds;
  task.retainedRevisions = result.retainedRevisions;
  liveCompletedSegments.value = result.translations.filter(value => value?.trim()).length;
  editRevision.value += 1;
  errorMessage.value = '';
  scheduleHistorySave();
}

function changePdfSource(blockIndex: number, lines?: string[]): void {
  const target = sourceEditTarget.value, task = activeTask.value;
  if (queueBusy.value || !target || !task || target.taskId !== task.id || target.document !== parsedDocument.value) return;
  const state = {translations: translatedSegments.value, confirmedTranslationIds: confirmedTranslationIds.value, retainedRevisions: task.retainedRevisions};
  const result = lines === undefined ? restorePdfSourceLines(target.document, target.pageNumber, blockIndex, state)
    : correctPdfSourceLines(target.document, target.pageNumber, blockIndex, lines, state);
  if (!result) return;
  commitPdfSourceResult(result);
  sourceEditTarget.value = null;
  downloadNotice.value = t(lines === undefined ? 'document.sourceEdit.restored' : 'document.sourceEdit.saved');
}
function applySourceEdit(blockIndex: number, lines: string[]): void {changePdfSource(blockIndex, lines);}
function restoreSourceEdit(blockIndex: number): void {changePdfSource(blockIndex);}

async function rerecognizePdfPage(): Promise<void> {
  const document = parsedDocument.value, task = activeTask.value;
  if (queueBusy.value || !config.on || !hydrated.value || !task || document?.binary?.kind !== 'pdf') return;
  const index = document.binary.pages.findIndex(page => page.pageNumber === pdfPage.value);
  if (index < 0) return;
  const pageNumber = document.binary.pages[index].pageNumber;
  documentSettingsDialog.value?.close();
  sourceEditTarget.value = null;
  translating.value = true; runState.value = 'ready'; errorMessage.value = ''; downloadNotice.value = '';
  const controller = new AbortController(), requestId = ++translationRequestId;
  abortController = controller;
  const current = () => !disposed && requestId === translationRequestId && activeTask.value === task && parsedDocument.value === document;
  try {
    const recognized = await recognitionWorkflow.recognize(document, {sourceLanguage: config.from, startPage: index, pageIndexes: [index], signal: controller.signal, isCurrent: current});
    if (!recognized || !current()) return;
    if (recognized === document) {showError(t('document.pdfReading.ocrEmpty')); return;}
    const result = reconcilePdfRecognition(document, recognized, pageNumber, {translations: translatedSegments.value, confirmedTranslationIds: confirmedTranslationIds.value, retainedRevisions: task.retainedRevisions});
    if (!result) {showError(t('document.sourceEdit.applyFailed')); return;}
    commitPdfSourceResult(result);
    downloadNotice.value = t('document.sourceEdit.recognized');
  } catch (error) {
    if (current() && !controller.signal.aborted) {runState.value = 'failed'; showError(error instanceof Error ? error.message : String(error));}
  } finally {
    if (requestId === translationRequestId) {
      translating.value = false; recognitionProgress.value = '';
      if (abortController === controller) abortController = null;
      persistHistory();
    }
  }
}

function editSegment(index: number, value: string): void {
  if (queueBusy.value || !activeSegments.value.some(segment => segment.id === index)) return;
  if (!taskFingerprint.value) taskFingerprint.value = currentFingerprint.value;
  setDocumentTranslationBatch([{id: index, translation: value}]);
  if (richPreviewDocument.value) pendingRichSegmentIds.add(index);
  confirmedTranslationIds.value = confirmedTranslationIds.value.filter(id => id !== index);
  if (value.trim()) confirmedTranslationIds.value.push(index);
  editRevision.value += 1;
  downloadNotice.value = '';
  scheduleHistorySave();
}

// 面板保持在下载入口旁；窄屏、展开错误和浏览器缩放后仍完整位于视口中。
function positionDownloadPanel(): void {
  const panel = downloadDialog.value, button = downloadButton.value;
  if (!downloadOpen.value || !panel?.open || !button?.getBoundingClientRect) return;
  const anchor = button.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
  // 定位只更新当前面板的样式，视口变化时不再为坐标触发整页 Vue 重渲染。
  panel.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
  panel.style.top = `${anchor.bottom + 6 + height <= window.innerHeight - 12 ? anchor.bottom + 6 : Math.max(12, anchor.top - height - 6)}px`;
}

function closeDownloadOnBackdrop(event: MouseEvent): void {
  const panel = downloadDialog.value;
  if (!panel || event.target !== panel || preparingDownload.value) return;
  const rect = panel.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) panel.close();
}

// 仅打开时订阅面板尺寸依赖，关闭后不为定位而逐段读取流式更新的译文。
watch(() => downloadOpen.value ? [downloadMode.value, downloadPdfPresentation.value, pendingDownloadMode.value, preparingDownload.value, downloadProgress.value, downloadError.value, originalDownloadError.value, hasTranslation.value, settingsChanged.value, language.value] : null, () => {void nextTick(positionDownloadPanel);});
watch(preparingDownload, busy => {void nextTick(() => {
  if (downloadOpen.value) downloadDialog.value?.querySelector?.<HTMLButtonElement>(busy ? '.download-cancel' : pendingDownloadMode.value ? '.download-confirmation .ghost-button' : '.download-submit')?.focus();
});});

function openDownload(): void {
  if (!parsedDocument.value || (!originalDownloadSource.value && (queueBusy.value || !hasTranslation.value))) return;
  if (downloadOpen.value) return;
  // 生成过程中仍可打开窗口保存原文，不能重置当前导出的选择、确认或进度。
  if (!preparingDownload.value) {
    downloadMode.value = outputMode.value;
    downloadPdfPresentation.value = pdfPresentation.value;
    pendingDownloadMode.value = null;
    partialExportAcknowledged.value = false;
    downloadError.value = '';
    downloadProgress.value = '';
    downloadPdfProgress.value = null;
  }
  originalDownloadError.value = '';
  downloadOpen.value = true;
  downloadDialog.value?.showModal();
  void nextTick(positionDownloadPanel);
}

async function requestDownload(mode: DocumentRenderMode): Promise<void> {
  if (!hasTranslation.value || queueBusy.value) return;
  outputMode.value = mode;
  if (!translationComplete.value) {
    pendingDownloadMode.value = mode;
    await nextTick();
    downloadDialog.value?.querySelector?.<HTMLButtonElement>('.download-confirmation .ghost-button')?.focus();
    return;
  }
  await downloadDocument();
}

function backToDownloadChoices(): void {
  pendingDownloadMode.value = null;
  void nextTick(() => downloadDialog.value?.querySelector?.<HTMLInputElement>('input[name="document-download-version"]:checked')?.focus());
}

async function confirmPartialDownload(): Promise<void> {
  if (!pendingDownloadMode.value || queueBusy.value) return;
  outputMode.value = pendingDownloadMode.value;
  partialExportAcknowledged.value = true;
  await downloadDocument();
}

function downloadOriginalDocument(): void {
  const source = originalDownloadSource.value;
  if (!source) return;
  originalDownloadError.value = '';
  try {
    const blob = 'bytes' in source ? new Blob([asArrayBufferBytes(source.bytes)], {type: source.mimeType}) : source.blob;
    saveDownloadBlob(blob, source.fileName);
    if (!preparingDownload.value) downloadDialog.value?.close();
  } catch (error) {
    originalDownloadError.value = error instanceof Error ? error.message : String(error);
  }
}

function pdfExportProgress(progress: PdfExportProgress): string {
  return progress.phase === 'saving' ? t('document.export.saving')
    : t('document.export.pages', {completed: progress.completedPages, total: progress.totalPages});
}

function archiveExportProgress(percent: number): string {
  return t('document.export.packaging', {percent: Math.floor(percent)});
}

function cancelDownload(): void {exportWorkflow.cancel();}

async function downloadDocument(): Promise<void> {
  const task = activeTask.value;
  if (disposed || !task?.document || !hasTranslation.value || queueBusy.value || (!translationComplete.value && !partialExportAcknowledged.value)) return;
  await exportWorkflow.single(task, outputMode.value, downloadOpen.value ? downloadPdfPresentation.value : pdfPresentation.value);
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
  window.addEventListener('resize', positionDownloadPanel);
  colorSchemeMedia.addEventListener?.('change', applyTheme);
  window.addEventListener('pagehide', resetDocument);
  window.addEventListener('beforeunload', guardBeforeUnload);
  window.addEventListener('keydown', leaveFocusOnEscape);
  window.document.addEventListener?.('fullscreenchange', leaveFocusWithFullscreen);
  void refreshHistory();
  let materialUrl: URL | undefined;
  try {materialUrl = new URL(window.location.href);} catch { /* 只在完整浏览器页面解析继续阅读参数。 */ }
  const materialId = materialUrl?.searchParams.get(MATERIAL_RESUME_PARAMETER);
  if (materialUrl && materialId && !materialPrivate) {materialUrl.searchParams.delete(MATERIAL_RESUME_PARAMETER); window.history.replaceState(window.history.state, '', materialUrl.href); void restoreMaterialDocument(materialId); return;}
  const articleId = materialUrl?.searchParams.get(WEB_ARTICLE_PARAMETER);
  if (articleId && /^[a-f0-9]{32}$/u.test(articleId)) {
    void importWorkflow.openHistory(articleId).then(() => {
      if (!disposed && !activeTask.value && !importError.value) importError.value = t('document.historyOpenUnavailable');
    });
    return;
  }
  const source = readPdfSourceFragment(window.location.hash || '');
  if (source) {onlinePdfUrl.value = source; void openOnlinePdf();}
  else void restoreOpenDocument();
});

onUnmounted(() => {
  window.removeEventListener('resize', positionDownloadPanel);
  disposed = true;
  clearGlossaryReview();
  materialEpoch++; clearTimeout(materialPositionTimer);
  configEditor.dispose();
  importWorkflow.dispose();
  recognitionWorkflow.dispose();
  exportWorkflow.dispose();
  resetDocument();
  window.document?.documentElement?.classList?.remove('dark');
  colorSchemeMedia.removeEventListener?.('change', applyTheme);
  window.removeEventListener('pagehide', resetDocument);
  window.removeEventListener('beforeunload', guardBeforeUnload);
  window.removeEventListener('keydown', leaveFocusOnEscape);
  window.document.removeEventListener?.('fullscreenchange', leaveFocusWithFullscreen);
});
</script>

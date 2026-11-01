<!--
 * @file src/features/vocabulary/ui/MaterialWorkspace.vue
 * 文件职责：以阅读材料和收藏原句为主要内容，提供主题整理、回到出处、连续学习和本地笔记。
 * 主要内容：保留轻量材料列表，空库隐藏无效搜索与主题筛选但保留管理和恢复入口，详情按来源聚合原句、实时收藏和问答；非空搜索只为当前主题保留有界小写正文，深层字段变化使缓存失效，超预算材料完整匹配且每轮只构造一次；刷新按顺序比较引用的完整协议字段，不为未变正文生成 JSON 快照；窄屏引用正文预留覆盖式滚动条空间，保持滚动时行尾可读；加载、重试、编辑、归档恢复均保护异步代次和卸载边界，笔记焦点只回到仍属于当前材料的自有输入框，保存成功只清理所属材料中与提交快照相同的草稿；隐藏期间合并普通刷新而保留已接受写入，以独立可见性代次隔离旧读取和焦点，异步迟到挂载读取上游当前可见性。
 * 模块边界：只通过本地材料与既有学习客户端读写，不访问数据库或供应商；来源恢复由公共适配器处理，个人内容不进入配置同步。
 -->
<template>
  <section class="fr-materials" aria-label="阅读材料" :aria-busy="loading || queryPending || busy || pageLoading || topicLoading">
    <div class="fr-material-toolbar">
      <label v-if="totalMaterials" class="fr-material-search"><UiIcon name="search" :size="16" /><input v-model="query" type="search" aria-label="搜索阅读材料" placeholder="搜索材料、原句或笔记" /></label>
      <input v-if="totalTopics > 100" v-model="topicSearch" type="search" :disabled="loading || busy" aria-label="查找主题" placeholder="查找主题" />
      <select v-if="totalMaterials && (totalTopics || topic)" v-model="topic" :disabled="loading || busy" aria-label="按主题筛选"><option value="">全部主题</option><option v-if="topic && !topics.includes(topic)" :value="topic">{{ topic }}</option><option v-for="item in topics" :key="item" :value="item">{{ item }}</option></select>
      <button v-if="topicNext !== null" type="button" :disabled="topicLoading || busy" @click="showMoreTopics">更多主题</button>
      <details class="fr-material-menu" @keydown.esc.stop.prevent="closeMenu">
        <summary aria-label="材料管理"><UiIcon name="sliders" :size="16" /></summary>
        <div @click="closeMenu"><button type="button" :disabled="loading || busy" @click="reload()">刷新材料</button><button type="button" :disabled="busy" @click="toggleArchive">{{ archived ? '返回阅读材料' : '查看已移除材料' }}</button><button type="button" :disabled="busy || !!fallbackDownloadUrl" @click="exportMaterials">导出材料备份</button><button type="button" :disabled="busy || !!pendingImport" @click="importInput?.click()">恢复材料备份</button><button v-if="isFirefox" type="button" :disabled="busy" @click="openTemporaryBackups">查看材料备份临时文件</button><button type="button" :disabled="busy" @click="confirmClear = true">清空全部材料</button></div>
      </details>
      <input ref="importInput" type="file" accept=".json,application/json" hidden aria-label="恢复材料备份" @change="importMaterials" />
    </div>
    <section v-if="confirmClear" class="fr-material-editor" aria-label="确认清空全部材料">
      <strong>清空全部材料？</strong><p>材料主题、阅读位置和材料中的个人笔记将永久删除。原有收藏、阅读问答和学习笔记仍保留。可以先导出材料备份。</p>
      <div class="fr-material-actions"><button type="button" :disabled="busy" @click="clearMaterials">确认清空</button><button type="button" :disabled="busy" @click="confirmClear = false">取消</button></div>
    </section>
    <p v-if="error" class="fr-material-feedback error" role="alert">{{ error }} <button type="button" :disabled="busy" @click="reload()">重试</button></p>
    <p v-if="backupWarning" class="fr-material-feedback error" role="alert">{{ backupWarning }}</p>
    <p v-if="largeRestoreRunning" class="fr-material-feedback" role="status"><span>正在读取并恢复材料备份…</span> <span>请保持此页面打开，以便中断后查询结果。</span> <button type="button" @click="cancelLargeRestore">取消恢复</button></p>
    <p v-if="exportRunning" class="fr-material-feedback" role="status">正在导出材料备份… <span v-if="exportKeepOpen">下载完成前请保持此页面打开。</span> <span v-if="exportBuffered">当前浏览器使用内存准备下载，大备份可能占用较多内存。</span> <button type="button" @click="exportController?.abort()">取消导出</button></p>
    <section v-if="exportCapacityPrompt" class="fr-material-editor" aria-label="确认保存超出恢复上限的备份">
      <strong>备份超过当前恢复上限</strong>
      <p v-if="exportCapacityPrompt.recordTooLarge">备份中有材料超过 128 MiB，当前版本无法恢复该材料。</p>
      <p v-if="exportCapacityPrompt.tooManyFrames">备份超过 20,000 个恢复分片，当前版本无法完整恢复。</p>
      <p>仍可保存以备后续处理；恢复还受设备可用空间限制。</p>
      <div class="fr-material-actions"><button type="button" @click="answerExportCapacity(true)">仍然保存备份</button><button type="button" @click="answerExportCapacity(false)">取消导出</button></div>
    </section>
    <p v-if="fallbackDownloadUrl" class="fr-material-feedback" role="status">下载已发起，关闭页面可能中断下载。请先确认浏览器下载完成，再释放临时数据。 <button type="button" @click="releaseFallbackDownload">下载已完成，释放临时数据</button></p>
    <p v-if="lateBackupWarning" class="fr-material-feedback error" role="alert">{{ lateBackupWarning }} <button type="button" @click="clearLateBackupWarning">知道了</button></p>
    <p v-if="lateBackupStatus" class="fr-material-feedback" role="status">{{ lateBackupStatus }} <button type="button" aria-label="关闭保存结果提示" @click="clearLateBackupStatus">知道了</button></p>
    <section v-if="showTemporaryBackups" class="fr-material-editor" aria-label="材料备份临时文件">
      <strong>材料备份临时文件</strong>
      <p>可取回表示备份传输已完成且文件大小一致；请下载后检查备份。</p>
      <p v-if="temporaryLoading" role="status">正在读取临时文件…</p>
      <p v-if="temporaryError" class="error" role="alert">{{ temporaryError }}</p>
      <p v-if="temporaryFailed">部分临时文件无法读取，请重试。</p>
      <p v-if="temporaryTruncated">只显示前 200 个临时文件，请处理后重新查看。</p>
      <p v-if="!temporaryLoading && !temporaryError && !temporaryItems.length && !temporaryFailed">没有材料备份临时文件。</p>
      <div v-for="item in temporaryItems" :key="item.name" class="fr-material-reference">
        <span data-i18n-ignore>{{ new Date(item.createdAt).toLocaleString() }} · {{ item.bytes.toLocaleString() }} B</span>
        <span>{{ item.ready ? '可取回' : '未完成' }}</span>
        <button v-if="item.ready" type="button" :disabled="busy" @click="recoverTemporaryBackup(item)">取回备份</button>
        <button type="button" :disabled="busy" @click="temporaryDelete = item.name">删除临时文件</button>
        <div v-if="temporaryDelete === item.name">
          <p>删除可能中断尚在运行的下载。确定删除这份临时文件？</p>
          <button type="button" :disabled="busy" @click="removeTemporaryBackup(item)">确认删除临时文件</button>
          <button type="button" :disabled="busy" @click="temporaryDelete = ''">取消</button>
        </div>
      </div>
      <div class="fr-material-actions"><button type="button" :disabled="temporaryLoading || busy" @click="openTemporaryBackups">刷新临时文件</button><button type="button" :disabled="busy" @click="closeTemporaryBackups">关闭</button></div>
    </section>
    <p v-if="pendingImport && !largeRestoreRunning" class="fr-material-feedback" role="status">上次恢复结果或暂存状态尚待确认。关闭此页面后将无法继续查询本次结果。 <button type="button" :disabled="busy" @click="checkPendingImport">检查恢复结果</button> <button type="button" :disabled="busy" @click="endPendingImport">结束未完成恢复</button> <button v-if="canForgetPending" type="button" :disabled="busy" @click="forgetPendingImport">不再查询</button></p>
    <p v-if="feedback" class="fr-material-feedback" role="status">{{ feedback }}</p>
    <p v-if="archived" class="fr-material-feedback">已移除的材料仍保留原句与笔记，恢复后可继续阅读。原有收藏与问答不受影响。</p>
    <div v-if="(loading || queryPending) && !materials.length" class="fr-material-empty" role="status">正在读取材料…</div>
    <div v-else-if="!totalMaterials && !error" class="fr-material-empty">
      <UiIcon name="book" :size="28" /><h2>{{ archived ? '没有已移除的材料' : '从一段值得留下的原文开始' }}</h2>
      <p>{{ archived ? '材料移除后可以在这里恢复。' : '收藏原句、保存阅读问答或笔记后，同一篇文章、文档或视频会归在一起。只收藏一个词也可以，无须创建项目。' }}</p>
      <button type="button" @click="archived ? toggleArchive() : emit('openTab', 'saved')">{{ archived ? '返回材料' : '查看我的收藏' }}</button>
    </div>
    <p v-else-if="!materials.length && !loading && !error" class="fr-material-feedback">没有匹配的材料。<button type="button" @click="query = ''; topic = ''">清除筛选</button></p>
    <div v-else class="fr-material-layout" :class="{'has-selection': selected}">
      <nav ref="materialListElement" class="fr-material-list" aria-label="材料列表">
        <button v-for="item in materials" :key="item.id" type="button" class="fr-material-card" :disabled="loading || busy" :data-material-id="item.id" :class="{selected: selectedId === item.id}" :aria-current="selectedId === item.id ? 'true' : undefined" @click="select(item.id)">
          <span class="fr-material-meta"><UiIcon :name="icon(item.kind)" :size="14" />{{ kindLabel(item.kind) }}<span :title="item.sourceUrl" :data-i18n-ignore="sourceLabel(item) === '本地文件' || sourceLabel(item) === '来源待恢复' ? undefined : ''">{{ sourceLabel(item) }}</span></span>
          <strong data-i18n-ignore>{{ item.title }}</strong>
          <span v-if="item.preview" class="fr-material-preview" data-i18n-ignore>{{ item.preview }}</span>
          <span class="fr-material-meta"><span v-if="item.topics.length" class="fr-material-topic" data-i18n-ignore>{{ item.topics.join(' · ') }}</span><span>{{ item.referenceCount }} 条学习内容</span><span>{{ formatDate(item.lastReadAt) }}</span></span>
        </button>
        <button v-if="materialNext !== null" type="button" :disabled="pageLoading || busy" @click="showMoreMaterials">显示更多材料（{{ materials.length }} / {{ matchedMaterials }}）</button>
      </nav>
      <p v-if="selectedId && !selected && detailLoading" class="fr-material-feedback" role="status">正在读取材料详情…</p>
      <p v-if="selectedId && !selected && detailError" class="fr-material-feedback error" role="alert">{{ detailError }} <button type="button" @click="readDetail(0)">重试</button></p>
      <article v-if="selected" class="fr-material-detail" aria-label="材料学习内容">
        <header class="fr-material-heading">
          <button class="fr-material-back" type="button" @click="backToList"><UiIcon name="arrow-right" style="transform:rotate(180deg)" :size="14" />材料列表</button>
          <div class="fr-material-meta"><span>{{ kindLabel(selected.kind) }}</span> · <span :data-i18n-ignore="sourceLabel(selected) === '本地文件' || sourceLabel(selected) === '来源待恢复' ? undefined : ''">{{ sourceLabel(selected) }}</span></div>
          <h2 data-i18n-ignore tabindex="-1" ref="detailHeading">{{ selected.title }}</h2>
          <div class="fr-material-actions">
            <a v-if="resume.href && !archived" class="fr-material-primary" :href="resume.href" target="_blank" rel="noopener noreferrer">{{ resume.label }} <UiIcon name="arrow-right" :size="15" /></a>
            <button v-if="archived" class="fr-material-primary" type="button" :disabled="busy" @click="restoreSelected">恢复材料</button>
            <button ref="organizeButton" type="button" :disabled="busy" @click="startEdit">整理材料</button>
            <button v-if="!archived" type="button" :disabled="busy" @click="archiveSelected">移除</button>
          </div>
          <p v-if="resume.recovery" class="fr-material-recovery">{{ resume.recovery }}</p>
          <p v-if="selected.topics.length" class="fr-material-topic" data-i18n-ignore>{{ selected.topics.join(' / ') }}</p>
        </header>
        <form v-if="editing" class="fr-material-editor" @submit.prevent="saveEdit" @keydown.esc.stop.prevent="cancelEdit">
          <label>材料标题<input ref="titleInput" v-model="draft.title" maxlength="200" required :disabled="busy" /></label>
          <label>主题<input v-model="draft.topics" maxlength="400" list="fr-material-topic-list" placeholder="用逗号分隔，例如：语言学习, 设计" :disabled="busy" /></label>
          <small>主题本身包含逗号时，用双引号括起；双引号可写成两个连续引号。</small>
          <datalist id="fr-material-topic-list"><option v-for="item in topics" :key="item" :value="item" /></datalist>
          <label v-if="selected.kind !== 'document'">来源地址<input v-model="draft.url" type="url" required maxlength="2048" :disabled="busy" /></label>
          <small>更换地址后会重新核对材料身份；原句仍可用于找回位置。</small>
          <div class="fr-material-actions"><button type="submit" class="fr-material-primary" :disabled="busy || !draft.title.trim()">保存</button><button type="button" :disabled="busy" @click="cancelEdit">取消</button></div>
        </form>
        <blockquote v-if="selected.locator?.quote" class="fr-material-quote"><span data-i18n-ignore>{{ selected.locator.quote }}</span><footer>{{ positionLabel(selected) }}<span v-if="selected.locator.kind === 'document' && selected.locator.section" data-i18n-ignore> · {{ selected.locator.section }}</span></footer></blockquote>
        <div v-if="detailLoading" class="fr-material-feedback" role="status">正在读取学习内容…</div>
        <p v-if="detailError" class="fr-material-feedback error" role="alert">{{ detailError }} <button type="button" @click="detailPageFailedOffset !== undefined ? readDetail(detailPageFailedOffset) : loadReferences()">重试</button></p>
        <section class="fr-material-references" aria-label="材料中的原句、问答与笔记">
          <article v-for="reference in visibleReferences" :key="referenceKey(reference)" class="fr-material-reference">
            <header><span>{{ referenceLabel(reference.kind) }}</span><span v-if="reference.kind === 'note'"><template v-if="!archived"><button type="button" :disabled="busy" @click="editNote(reference)">编辑</button> · </template><button type="button" :disabled="busy" @click="removeNote(reference)">删除笔记</button></span></header>
            <template v-if="resolved[referenceKey(reference)]?.entry">
              <h3 data-i18n-ignore>{{ resolved[referenceKey(reference)].entry!.term }}</h3>
              <p class="fr-material-translation" data-i18n-ignore>{{ entryTranslation(resolved[referenceKey(reference)].entry!) }}</p>
              <p v-if="resolved[referenceKey(reference)].entry!.note" data-i18n-ignore>{{ resolved[referenceKey(reference)].entry!.note }}</p>
            </template>
            <template v-else-if="resolved[referenceKey(reference)]?.session">
              <blockquote data-i18n-ignore>{{ resolved[referenceKey(reference)].session!.text }}</blockquote>
              <details v-for="turn in resolved[referenceKey(reference)].session!.turns" :key="turn.id" class="fr-material-turn"><summary><span v-if="turn.question" data-i18n-ignore>{{ turn.question }}</span><template v-else>阅读讲解</template></summary><ReadingAnswer v-if="turn.answer" :text="turn.answer" /><p v-else>这次问答没有保存回答。</p></details>
            </template>
            <template v-else><p v-if="reference.excerpt" data-i18n-ignore>{{ reference.excerpt }}</p><p v-if="reference.note" class="fr-material-note" data-i18n-ignore>{{ reference.note }}</p><p v-if="resolved[referenceKey(reference)]?.memory" class="fr-material-note" data-i18n-ignore>{{ resolved[referenceKey(reference)].memory }}</p></template>
            <small v-if="resolved[referenceKey(reference)]?.missing">原记录已删除或过期，保留这段原句供查找。</small>
          </article>
          <p v-if="!selected.references.length" class="fr-material-feedback">阅读位置已保存。收藏原句或添加笔记，稍后在这里继续。</p>
          <button v-if="referenceNext !== null" type="button" :disabled="detailLoading" @click="showMoreReferences">显示更多学习内容</button>
        </section>
        <form v-if="!archived" class="fr-material-note-form" @submit.prevent="saveNote">
          <label for="fr-material-note">记下这份材料的想法</label><textarea ref="noteInput" id="fr-material-note" v-model="note" rows="3" maxlength="2000" placeholder="用自己的话记下理解、疑问或下一步…" :disabled="busy" />
          <div><small>仅保存在本机</small><span><button v-if="editingNoteId" type="button" :disabled="busy" @click="editingNoteId = ''; note = ''">取消编辑</button> <button type="submit" class="fr-material-primary" :disabled="busy || !note.trim()">{{ editingNoteId ? '更新笔记' : '保存笔记' }}</button></span></div>
        </form>
      </article>
    </div>
  </section>
</template>
<script lang="ts">
import {ref as sharedRef} from 'vue';
// Blob URL 属于当前文档；组件切换不能丢失用户尚未确认的下载。
const sharedFallbackDownloadUrl = sharedRef('');
const sharedLateBackupWarnings = sharedRef<string[]>([]);
const sharedLateBackupStatuses = sharedRef<string[]>([]);
</script>
<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import browser from 'webextension-polyfill';
import UiIcon from '@/src/ui/components/UiIcon.vue';
import { ReadingAnswer } from '@/src/features/reading-assistant/ui/answer/public';
import { getHarnessSession, listLearningMemories } from '@/src/features/reading-assistant/public';
import type { HarnessSession } from '@/src/services/harness/sessionTypes';
import type { VocabularyEntry } from '../learningModel';
import { VOCABULARY_BOOK_MESSAGE, type VocabularyBookResponse } from '../protocol';
import type { MaterialPatch, MaterialReference } from '../materialProtocol';
import { MATERIAL_INLINE_BACKUP_MAX_BYTES, MATERIAL_CHANGED_MESSAGE, MATERIAL_IMPORT_MAX_FRAMES, MATERIAL_IMPORT_MAX_RECORD_BYTES } from '../materialProtocol';
import { workspaceMaterialCapture, workspaceMaterialUpdate, workspaceMaterialArchive, workspaceMaterialRestore, workspaceMaterialRemoveReference, materialClear, materialImport, materialGeneration } from '../materialClient';
import {MaterialPageClientError, requestMaterialPage, requestMaterialDetail, requestMaterialTopics} from '../materialPageClient';
import type {MaterialSummary} from '../materialSummary';
import type {MaterialDetailMetadata} from '../materialDetailPage';
import {chooseMaterialBackupTarget, saveMaterialBackup, waitForMaterialBackupTarget, type MaterialBackupSavePlatform} from '../materialBackupSave';
import {beginFirefoxMaterialBackup, beginFirefoxRecoveredMaterialBackup, listFirefoxMaterialBackupLeftovers, removeFirefoxMaterialBackupLeftover, prepareFirefoxMaterialBackupContext, type MaterialBackupLeftover} from '../materialBackupBrowserSave';
import {startMaterialBackupExport} from '../materialBackupExportClient';
import {MATERIAL_BACKUP_EXPORT_PORT_NAME} from '../materialBackupExportProtocol';
import type {MaterialReadPort} from '../materialReadTransport';
import {formatMaterialTopics, parseMaterialTopics} from '../materialTopicsInput';
import {restoreLargeMaterialBackup, queryMaterialBackup, acknowledgeMaterialBackup, discardMaterialBackup} from '../materialBackupRestore';
import type {Capability} from '../materialImportStage';
import type {MaterialImportResult} from '../materialProtocol';
import { materialResumeLink } from '../materialSource';
import { useRenderDateFormatter } from '@/src/ui/dateFormat';
const emit = defineEmits<{
    navigate: [
        section: string
    ];
    openTab: [
        tab: string
    ];
}>();
const props = defineProps<{isVisible?: () => boolean}>();
const keptAliveVisible = ref(true);
const viewVisible = computed(() => (props.isVisible?.() ?? true) && keptAliveVisible.value);
const materials = ref<MaterialSummary[]>([]), selectedId = ref(''), query = ref(''), topic = ref(''), archived = ref(false);
const totalMaterials = ref(0), matchedMaterials = ref(0), materialNext = ref<number|null>(null), pageLoading = ref(false), queryPending = ref(false);
const topics = ref<string[]>([]), topicSearch = ref(''), totalTopics = ref(0), topicNext = ref<number|null>(null), topicLoading = ref(false);
const detail = ref<(MaterialDetailMetadata & {references: MaterialReference[]})>(), referenceNext = ref<number|null>(null), referenceTotal = ref(0);
const loading = ref(false), busy = ref(false), error = ref(''), feedback = ref(''), editing = ref(false), note = ref('');
const backupWarning = ref('');
const pendingImport = ref<Capability>(), largeRestoreRunning = ref(false), canForgetPending = ref(false);
let backupController: AbortController | undefined;
const exportRunning = ref(false);
const exportKeepOpen = ref(false);
const exportBuffered = ref(false);
const exportCapacityPrompt=ref<{recordTooLarge:boolean;tooManyFrames:boolean}|null>(null);
let exportCapacityAnswer:((proceed:boolean)=>void)|undefined;
const fallbackDownloadUrl = sharedFallbackDownloadUrl;
const lateBackupWarning = computed(()=>sharedLateBackupWarnings.value[0] ?? '');
const lateBackupStatus = computed(()=>sharedLateBackupStatuses.value[0] ?? '');
const isFirefox = import.meta.env.BROWSER === 'firefox';
const showTemporaryBackups=ref(false),temporaryLoading=ref(false),temporaryItems=ref<MaterialBackupLeftover[]>([]);
const temporaryError=ref(''),temporaryDelete=ref(''),temporaryTruncated=ref(false),temporaryFailed=ref(0);
let temporaryGeneration=0;
let exportController: AbortController | undefined;
const draft = ref({ title: '', topics: '', url: '' });
const confirmClear = ref(false), importInput = ref<HTMLInputElement>(), editingNoteId = ref('');
const noteInput = ref<HTMLTextAreaElement>();
const organizeButton = ref<HTMLButtonElement>(), titleInput = ref<HTMLInputElement>(), materialListElement = ref<HTMLElement>();
const detailLoading = ref(false), detailError = ref(''), detailHeading = ref<HTMLElement>();
const detailPageFailedOffset = ref<number>();
let listController:AbortController|undefined, detailController:AbortController|undefined, topicController:AbortController|undefined;
type MaterialSession = {capability:string;revision:number;total:number;matched:number};
let currentSession:MaterialSession|undefined;
let queryTimer:ReturnType<typeof setTimeout>|undefined, topicTimer:ReturnType<typeof setTimeout>|undefined, changes = 0;
let materialVisibleTarget=30, referenceVisibleTarget=24;
let pendingTopicSearch=false;
type ResolvedReference = {
    entry?: VocabularyEntry;
    session?: HarnessSession;
    memory?: string;
    missing?: boolean;
};
const resolved = ref<Record<string, ResolvedReference>>({});
let active = true, generation = 0, detailGeneration = 0, visibilityEpoch = 0;
let pendingRefresh = false, pendingReferences = false;
function focusGuard(): () => boolean {
    const visible = viewVisible.value, epoch = visibilityEpoch;
    return () => active && visible && viewVisible.value && epoch === visibilityEpoch;
}
function flushVisibleReads(): void {
    if (!active || !viewVisible.value || busy.value || loading.value || queryTimer!==undefined) return;
    if (pendingRefresh) void reload(true);
    else if(pendingTopicSearch && !topicLoading.value && topicTimer===undefined) {pendingTopicSearch=false;void loadTopics(true).catch(topicFailure);}
    else if (pendingReferences && !detailLoading.value) void loadReferences();
}
const noteDrafts = new Map<string, {
    text: string;
    editingId: string;
}>();
const materialDrafts = new Map<string, {
    title: string;
    topics: string;
    url: string;
}>();
const selected = computed(() => detail.value?.id === selectedId.value ? detail.value : undefined);
const visibleReferences = computed(() => selected.value?.references || []);
const resume = computed(() => selected.value ? materialResumeLink(selected.value, browser.runtime.getURL('document.html')) : {} as {
    href?: string;
    label?: string;
    recovery?: string;
});
const formatDate = useRenderDateFormatter({ month: 'numeric', day: 'numeric' });
const kindLabel = (kind: string) => ({ article: '文章', document: '文档', video: '视频' }[kind] || '材料');
const icon = (kind: string) => kind === 'video' ? 'captions' : kind === 'document' ? 'card' : 'book';
const referenceLabel = (kind: string) => ({ vocabulary: '收藏原文', session: '阅读问答', memory: '学习笔记', note: '我的笔记' }[kind] || '学习内容');
const referenceKey = (reference: MaterialReference) => `${reference.kind}:${reference.id}`;
const entryTranslation = (entry: VocabularyEntry) => Object.values(entry.translations)[0]?.text || '';
function closeMenu(event: Event) { const target = event.target as HTMLElement; if (target.closest('button') || ('key' in event && event.key === 'Escape')) {
    const menu = target.closest('details');
    if (menu) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
    }
} }
function sourceLabel(item: MaterialSummary | MaterialDetailMetadata) { try {
    const sourceUrl = 'source' in item ? item.source.url : item.sourceUrl;
    if (!sourceUrl) return '本地文件';
    const url = new URL(sourceUrl);
    const label = url.host + (url.pathname === '/' ? '' : url.pathname) + url.search;
    return label.length > 100 ? label.slice(0,97) + '…' : label;
}
catch {
    return '来源待恢复';
} }
function positionLabel(item: MaterialDetailMetadata) { const locator = item.locator; return locator?.kind === 'document' ? `第 ${locator.page || 1} 页` : locator?.kind === 'video' ? `上次看到 ${Math.floor((locator.startMs || 0) / 60000)}:${String(Math.floor((locator.startMs || 0) / 1000) % 60).padStart(2, '0')}` : '上次阅读的原文'; }
function backToList() {
    const id = selectedId.value, ownsFocus = focusGuard();
    resetSelection();
    void nextTick(() => {
        if (ownsFocus() && !selectedId.value) Array.from(materialListElement.value?.querySelectorAll<HTMLButtonElement>('[data-material-id]') || []).find(button => button.dataset.materialId === id)?.focus();
    });
}
function resetSelection() {
    if (selectedId.value) {
        if (note.value)
            noteDrafts.set(selectedId.value, { text: note.value, editingId: editingNoteId.value });
        else
            noteDrafts.delete(selectedId.value);
        if (editing.value)
            materialDrafts.set(selectedId.value, { ...draft.value });
        else
            materialDrafts.delete(selectedId.value);
    }
    selectedId.value = '';
    detailController?.abort(); detailController = undefined; detail.value = undefined; referenceNext.value = null;referenceTotal.value=0;referenceVisibleTarget=24;
    editing.value = false;
    note.value = '';
    editingNoteId.value = '';
    detailGeneration++;
    pendingReferences = false;
    detailLoading.value = false;
    resolved.value = {};
    detailError.value = '';
    detailPageFailedOffset.value=undefined;
}
async function closeSession(capability:string, signal?:AbortSignal):Promise<void> {
    try {await requestMaterialPage({v:1,type:'start',operation:'close',capability},{signal,idleTimeoutMs:10_000});}
    catch {/* 断开后后台会在会话到期时释放资源。 */}
}
/** 后台最终确认与下一次请求之间可能短暂占用会话；只有限次重试读取。 */
async function pageRead<T>(read:()=>Promise<T>, signal?:AbortSignal):Promise<T> {
    for (let attempt=0;;attempt++) {
        try {return await read();}
        catch (failure) {
            if (!(failure instanceof MaterialPageClientError) || failure.code !== 'busy' || attempt >= 2 || signal?.aborted) throw failure;
            await new Promise<void>((resolve,reject) => {
                const timer=setTimeout(() => {signal?.removeEventListener('abort',abort);resolve();},50);
                const abort=() => {clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('材料读取已取消。','AbortError'));};
                signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
            });
        }
    }
}
async function loadPagedList(ticket:number, epoch:number, signal:AbortSignal):Promise<boolean> {
    const old=currentSession;currentSession=undefined;
    detailController?.abort(); topicController?.abort();
    if (old) await closeSession(old.capability,signal);
    if (signal.aborted) throw new DOMException('材料读取已取消。','AbortError');
    const observed=changes;
    const page=await requestMaterialPage({v:1,type:'start',operation:'open',options:{archived:archived.value,topic:topic.value,search:query.value}},{signal});
    if (!page?.capability) throw Error('材料列表读取失败，请重试。');
    if (!active || ticket!==generation || !viewVisible.value || epoch!==visibilityEpoch || signal.aborted) {
        if(active)pendingRefresh=true;
        void closeSession(page.capability); return false;
    }
    currentSession={capability:page.capability,revision:page.revision,total:page.total,matched:page.matched};
    materials.value=page.items; totalMaterials.value=page.total; matchedMaterials.value=page.matched; materialNext.value=page.nextOffset;
    while(materialNext.value!==null&&materials.value.length<materialVisibleTarget) {
        const session:MaterialSession=currentSession, offset=materialNext.value;
        const next=await pageRead(()=>requestMaterialPage({v:1,type:'start',operation:'page',capability:session!.capability,offset},{signal}),signal);
        if(!next||next.revision!==session!.revision||next.total!==session!.total||next.matched!==session!.matched)throw Error('材料列表已变化，请刷新。');
        if(!active||ticket!==generation||!viewVisible.value||epoch!==visibilityEpoch||signal.aborted||currentSession!==session)return false;
        materials.value=[...materials.value,...next.items];materialNext.value=next.nextOffset;
    }
    topics.value=[];totalTopics.value=0;topicNext.value=null;
    await loadTopics(true,signal);
    if (selectedId.value) {
        let loaded=await readDetail(0,signal,false);
        while(loaded&&referenceNext.value!==null&&selected.value&&selected.value.references.length<referenceVisibleTarget) loaded=await readDetail(referenceNext.value,signal,false);
        if(loaded&&selected.value)void loadReferences();
    }
    if(!active||ticket!==generation||!viewVisible.value||epoch!==visibilityEpoch||signal.aborted) {if(active)pendingRefresh=true;return false;}
    if (changes===observed) pendingRefresh=false;
    return true;
}
async function loadPagedListWithRetry(ticket:number, epoch:number, signal:AbortSignal):Promise<boolean> {
    try {return await loadPagedList(ticket,epoch,signal);}
    catch (failure) {
        if (!(failure instanceof MaterialPageClientError) || failure.code!=='stale-operation' || signal.aborted) throw failure;
        return loadPagedList(ticket,epoch,signal);
    }
}
async function reload(preserveError = false) {
    if (!active) return;
    if (!viewVisible.value || busy.value) {pendingRefresh = true; return;}
    pendingRefresh = false;
    const ticket = ++generation, epoch = visibilityEpoch;
    if(queryTimer!==undefined){clearTimeout(queryTimer);queryTimer=undefined;}queryPending.value=false;
    listController?.abort(); const controller=new AbortController();listController=controller;
    loading.value = true;
    // 广播和恢复触发的补读不能抹去刚完成操作的失败；用户显式刷新才清理旧错误。
    if (!preserveError) error.value = '';
    try {
        await loadPagedListWithRetry(ticket,epoch,controller.signal);
    }
    catch (failure) {
        if (active && ticket === generation && !controller.signal.aborted && viewVisible.value && epoch === visibilityEpoch && (!preserveError || !error.value))
            error.value = failure instanceof Error ? failure.message : '材料读取失败，请重试。';
    }
    finally {
        if (listController===controller) listController=undefined;
        if (active && ticket === generation) {loading.value = false; flushVisibleReads();}
    }
}
function toggleArchive() { if (busy.value)
    return; archived.value = !archived.value; materials.value = []; totalMaterials.value=0; resetSelection(); query.value = ''; topic.value = ''; topicSearch.value=''; feedback.value = ''; void reload(); }
async function showMoreMaterials():Promise<void> {
    const session=currentSession, offset=materialNext.value;
    if (!session || offset===null || pageLoading.value || loading.value || busy.value) return;
    const controller=new AbortController(), ticket=generation, epoch=visibilityEpoch;
    listController?.abort();listController=controller;pageLoading.value=true;
    try {
        const page=await pageRead(()=>requestMaterialPage({v:1,type:'start',operation:'page',capability:session.capability,offset},{signal:controller.signal}),controller.signal);
        if (!page || page.revision!==session.revision || page.total!==session.total || page.matched!==session.matched) throw Error('材料列表已变化，请刷新。');
        if (active && ticket===generation && viewVisible.value && epoch===visibilityEpoch && currentSession===session) {materials.value=[...materials.value,...page.items];materialNext.value=page.nextOffset;materialVisibleTarget=materials.value.length;}
    } catch (failure) {if (active && ticket===generation && !controller.signal.aborted) {
        error.value=failure instanceof Error?failure.message:'材料读取失败，请重试。';
        if(failure instanceof MaterialPageClientError && failure.code==='stale-operation')pendingRefresh=true;
    }}
    finally {if(listController===controller)listController=undefined;pageLoading.value=false;flushVisibleReads();}
}
async function loadTopics(reset:boolean, signal?:AbortSignal):Promise<void> {
    const session=currentSession;if(!session)return;
    const offset=reset?0:topicNext.value;if(offset===null)return;
    topicController?.abort();const controller=new AbortController();topicController=controller;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const term=topicSearch.value, ticket=generation;topicLoading.value=true;
    try {
        const page=await pageRead(()=>requestMaterialTopics({v:1,type:'start',operation:'topics',capability:session.capability,offset,search:term},session.revision,{signal:controller.signal}),controller.signal);
        if(active && ticket===generation && currentSession===session && topicSearch.value===term && !controller.signal.aborted) {
            topics.value=reset?page.topics:[...topics.value,...page.topics];totalTopics.value=page.total;topicNext.value=page.nextOffset;pendingTopicSearch=false;
        }
    } finally {signal?.removeEventListener('abort',abort);if(topicController===controller){topicController=undefined;topicLoading.value=false;}}
}
function topicFailure(failure:unknown):void {
    if(!active||!viewVisible.value||(failure instanceof Error&&failure.name==='AbortError'))return;
    error.value=failure instanceof Error?failure.message:'主题读取失败，请重试。';
    if(failure instanceof MaterialPageClientError&&failure.code==='stale-operation'){pendingRefresh=true;flushVisibleReads();}
}
function showMoreTopics():void {void loadTopics(false).catch(topicFailure);}
async function select(id: string) {
    if (busy.value || loading.value || selectedId.value === id)
        return;
    const ownsFocus = focusGuard();
    resetSelection();
    selectedId.value = id;
    feedback.value = '';
    const pendingNote = noteDrafts.get(id);
    if (pendingNote) {
        note.value = pendingNote.text;
        editingNoteId.value = pendingNote.editingId;
    }
    const pendingMaterial = materialDrafts.get(id);
    if (pendingMaterial) {
        draft.value = { ...pendingMaterial };
        editing.value = true;
    }
    await readDetail(0);
    await nextTick();
    if (ownsFocus() && selectedId.value === id)
        detailHeading.value?.focus({ preventScroll: true });
}
async function readDetail(offset:number, signal?:AbortSignal, resolveReferences=true):Promise<boolean> {
    const session=currentSession, id=selectedId.value;
    if(!session||!id)return false;
    detailController?.abort();const controller=new AbortController();detailController=controller;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const ticket=++detailGeneration,epoch=visibilityEpoch;
    detailLoading.value=true;detailError.value='';detailPageFailedOffset.value=undefined;
    try {
        const page=await pageRead(()=>requestMaterialDetail({v:1,type:'start',operation:'detail',capability:session.capability,id,offset},session.revision,{signal:controller.signal}),controller.signal);
        if(!active||ticket!==detailGeneration||selectedId.value!==id||!viewVisible.value||epoch!==visibilityEpoch||currentSession!==session)return false;
        if ((page.metadata.archivedAt!==null)!==archived.value) {resetSelection();return false;}
        if(offset!==0 && (!detail.value || detail.value.id!==id || page.total!==referenceTotal.value)) throw Error('材料详情已变化，请刷新。');
        detail.value={...page.metadata,references:offset===0?page.references:[...detail.value!.references,...page.references]};
        referenceTotal.value=page.total;referenceNext.value=page.nextOffset;
        if(offset===0)resolved.value={};
        detailLoading.value=false;
        if(resolveReferences)void loadReferences();
        return true;
    } catch(failure) {
        if(active&&ticket===detailGeneration&&!controller.signal.aborted&&viewVisible.value&&epoch===visibilityEpoch) {
            if(failure instanceof MaterialPageClientError && failure.code==='not-found') {error.value=failure.message;resetSelection();return false;}
            detailError.value=failure instanceof Error?failure.message:'材料详情读取失败，请重试。';
            detailPageFailedOffset.value=offset;
            if(failure instanceof MaterialPageClientError && failure.code==='stale-operation') {
                if(loading.value)throw failure;
                pendingRefresh=true;
            }
        }
        return false;
    } finally {
        signal?.removeEventListener('abort',abort);
        if(detailController===controller)detailController=undefined;
        if(active&&ticket===detailGeneration){detailLoading.value=false;flushVisibleReads();}
    }
}
async function loadReferences() {
    if (!active) return;
    if (!viewVisible.value || busy.value) {pendingReferences = Boolean(selected.value); return;}
    const item = selected.value;
    pendingReferences = false;
    if (!item) return;
    const ticket = ++detailGeneration, epoch = visibilityEpoch;
    detailLoading.value = true;
    detailError.value = '';
    try {
        const references = visibleReferences.value.filter(reference => !Object.hasOwn(resolved.value,referenceKey(reference)));
        const memories = references.some(reference => reference.kind === 'memory') ? await listLearningMemories() : [];
        if (!active || ticket !== detailGeneration || selectedId.value !== item.id) return;
        if (!viewVisible.value || epoch !== visibilityEpoch) {pendingReferences = true; return;}
        const results = await Promise.allSettled(references.map(async (reference) => {
            let value: ResolvedReference = {};
            if (reference.kind === 'vocabulary') {
                const result = await browser.runtime.sendMessage({ type: VOCABULARY_BOOK_MESSAGE, action: 'get', entryId: reference.id }) as VocabularyBookResponse<VocabularyEntry | undefined>;
                if (!result?.success)
                    throw new Error('读取收藏失败');
                value = result.data ? { entry: result.data } : { missing: true };
            }
            else if (reference.kind === 'session') {
                const session = await getHarnessSession(reference.id);
                value = session ? { session } : { missing: true };
            }
            else if (reference.kind === 'memory') {
                const memory = memories.find(value => value.id === reference.id);
                value = memory ? { memory: memory.content } : { missing: true };
            }
            return [referenceKey(reference), value] as const;
        }));
        if (active && ticket === detailGeneration && selectedId.value === item.id && viewVisible.value && epoch === visibilityEpoch) {
            resolved.value = {...resolved.value,...Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))};
            if (results.some(result => result.status === 'rejected'))
                detailError.value = '部分学习内容读取失败，原句仍保留。请重试。';
        }
    }
    catch {
        if (active && ticket === detailGeneration && viewVisible.value && epoch === visibilityEpoch)
            detailError.value = '部分学习内容读取失败，原句仍保留。请重试。';
    }
    finally {
        if (active && ticket === detailGeneration) {detailLoading.value = false; flushVisibleReads();}
    }
}
async function showMoreReferences() {if(referenceNext.value!==null&&!detailLoading.value){const loaded=await readDetail(referenceNext.value);if(loaded&&selected.value)referenceVisibleTarget=selected.value.references.length;}}
async function mutate(operation: () => Promise<{id:string} | void>, done: () => void) {
    if (busy.value)
        return;
    if (loading.value) pendingRefresh = true;
    listController?.abort();detailController?.abort();topicController?.abort();
    busy.value = true;
    loading.value = false;
    error.value = '';
    feedback.value = '';
    const ticket = ++generation;
    try {
        await operation();
        if (active && ticket === generation) {done();pendingRefresh=true;}
    }
    catch (failure) {
        if (active && ticket === generation) {
            error.value = failure instanceof Error ? failure.message : '操作未完成，请重试。';
            pendingRefresh=true;
        }
    }
    finally {
        if (active && ticket === generation)
            {busy.value = false; flushVisibleReads();}
    }
}
function startEdit() { const item = selected.value; if (!item)
    return; const ownsFocus = focusGuard(); draft.value = { title: item.title, topics: formatMaterialTopics(item.topics), url: item.source.url || '' }; editing.value = true; void nextTick(() => {if (ownsFocus() && selectedId.value === item.id) titleInput.value?.focus();}); }
function cancelEdit() {if (busy.value) return; const id = selectedId.value, ownsFocus = focusGuard(); editing.value = false; void nextTick(() => {if (ownsFocus() && selectedId.value === id) organizeButton.value?.focus();});}
async function saveEdit() {
    const item = selected.value;
    if (!item) return;
    const ownsFocus = focusGuard();
    const submitted = { ...draft.value };
    const matchesSubmitted = (value: typeof submitted | undefined) => value?.title === submitted.title
        && value.topics === submitted.topics && value.url === submitted.url;
    const patch:MaterialPatch = {};
    if(submitted.title!==item.title)patch.title=submitted.title;
    if(submitted.topics!==formatMaterialTopics(item.topics)) {
        try {patch.topics=parseMaterialTopics(submitted.topics);}
        catch(failure){error.value=failure instanceof Error?failure.message:'主题格式无效。';return;}
    }
    if(item.kind!=='document'&&submitted.url!==(item.source.url||''))patch.source={...item.source,url:submitted.url};
    if(!Object.keys(patch).length){cancelEdit();feedback.value='材料没有需要保存的更改。';return;}
    await mutate(() => workspaceMaterialUpdate(item.id, patch), () => {
        // 返回列表或归档响应可能刚缓存了提交中的草稿；仅清理这一份，不覆盖后续输入。
        if (matchesSubmitted(materialDrafts.get(item.id))) materialDrafts.delete(item.id);
        if (selectedId.value === item.id && matchesSubmitted(draft.value)) {
            editing.value = false;
            void nextTick(() => {if (ownsFocus() && selectedId.value === item.id && !editing.value) organizeButton.value?.focus();});
        }
        feedback.value = '材料已整理。';
    });
}
async function archiveSelected() { const item = selected.value; if (!item)
    return; await mutate(() => workspaceMaterialArchive(item.id), () => { materials.value = materials.value.filter(value => value.id !== item.id); resetSelection(); feedback.value = '已移除材料，可在材料管理中恢复。原有收藏与问答仍保留。'; }); }
async function restoreSelected() { const item = selected.value; if (!item)
    return; await mutate(() => workspaceMaterialRestore(item.id), () => { materials.value = materials.value.filter(value => value.id !== item.id); resetSelection(); feedback.value = '材料已恢复，返回阅读材料即可继续。'; }); }
function editNote(reference: MaterialReference) {
    const id = selectedId.value;
    if (!id || archived.value) return;
    const ownsFocus = focusGuard();
    editingNoteId.value = reference.id;
    note.value = reference.note || '';
    void nextTick(() => {
        if (ownsFocus() && selectedId.value === id && editingNoteId.value === reference.id) noteInput.value?.focus();
    });
}
async function saveNote() {
    const item = selected.value, content = note.value.trim(), capturedAt = Date.now();
    if (!item || !content)
        return;
    const submitted = { text: note.value, editingId: editingNoteId.value };
    const matchesSubmitted = (value: typeof submitted | undefined) => value?.text === submitted.text
        && value.editingId === submitted.editingId;
    const reference = { kind: 'note' as const, id: submitted.editingId || crypto.randomUUID(), note: content, createdAt: capturedAt };
    const referenceMode = submitted.editingId ? 'update-existing' as const : undefined;
    await mutate(async () => { const storageGeneration = await materialGeneration(); if (!active)
        return; return workspaceMaterialCapture({ source: item.source, reference, capturedAt, generation: storageGeneration, ...(referenceMode ? {referenceMode} : {}) }); }, () => {
        if (matchesSubmitted(noteDrafts.get(item.id))) noteDrafts.delete(item.id);
        if (selectedId.value === item.id && matchesSubmitted({ text: note.value, editingId: editingNoteId.value })) {
            note.value = '';
            editingNoteId.value = '';
        }
        feedback.value = '笔记已保存。';
    });
}
async function removeNote(reference: MaterialReference) { const item = selected.value; if (!item)
    return; await mutate(() => workspaceMaterialRemoveReference(item.id, reference.kind, reference.id), () => {if (editingNoteId.value === reference.id) {editingNoteId.value = ''; note.value = '';} feedback.value = '笔记已删除。'; }); }
async function clearMaterials() { await mutate(async () => { await materialClear(); }, () => { materials.value = []; resetSelection(); noteDrafts.clear(); materialDrafts.clear(); confirmClear.value = false; feedback.value = '全部材料已清空。'; }); }
function reportLateBackupCleanup(kind:'firefox'|'picker'|'buffered') {
    recordBackupWarning(kind==='firefox'?'取消后无法清理材料备份临时文件。确认没有下载进行后，重载当前页面以释放占用，再在临时文件列表处理。'
        :kind==='picker'?'取消后无法清理已选择的文件，请检查保存位置是否留有不完整文件。':'取消后无法清理下载缓存，请检查浏览器下载。');
}
function recordBackupWarning(message:string) {sharedLateBackupWarnings.value.push(message);}
function clearLateBackupWarning() {sharedLateBackupWarnings.value.shift();}
function recordBackupStatus(message:string) {sharedLateBackupStatuses.value.push(message);}
function clearLateBackupStatus() {sharedLateBackupStatuses.value.shift();}
function isBackupError(failure:unknown,name:string):boolean {
    try {return failure instanceof Error && failure.name===name;} catch {return false;}
}
function backupFailureMessage(failure:unknown,cancelledMessage:string,fallback:string,firefoxTarget=false):string {
    try {
        if(!(failure instanceof Error))return fallback;
        const name=failure.name;
        if(name==='AbortError')return cancelledMessage;
        if(name==='MaterialBackupOpfsCleanupError')
            return '备份已下载，但临时文件未清理。确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。';
        if(name==='MaterialBackupSaveCleanupError')
            return firefoxTarget?'备份未完成，临时文件清理失败。确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。':'材料备份未完成，清理失败，请检查保存位置是否存在不完整文件';
        const message=failure.message;
        if(['无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载','无法确认材料备份下载是否已开始，临时文件已保留，请检查浏览器下载'].includes(message))
            return '无法确认备份下载状态。请先检查浏览器下载，确认没有下载进行后重载当前页面以释放占用，再在临时文件列表处理。';
        return message;
    } catch {return fallback;}
}
function retainUnmountedBackupFailure(failure:unknown,kind:'firefox'|'picker'|'buffered') {
    try {
        if(!(failure instanceof Error))return;
        const name=failure.name;
        if(name==='AbortError')return;
        if(kind==='firefox' && (name==='MaterialBackupSaveCleanupError' || name==='MaterialBackupOpfsCleanupError'))
            recordBackupWarning(backupFailureMessage(failure,'已取消导出。','导出失败，请重试。',true));
        else if(kind==='picker' && name==='MaterialBackupSaveCleanupError')
            recordBackupWarning('备份未完成且无法清理已选择的文件，请检查保存位置是否留有不完整文件。');
        else if(['无法确认材料备份下载状态，临时文件已保留，请检查浏览器下载','无法确认材料备份下载是否已开始，临时文件已保留，请检查浏览器下载'].includes(failure.message) && kind==='firefox')
            recordBackupWarning(backupFailureMessage(failure,'已取消导出。','导出失败，请重试。',true));
    } catch {recordBackupWarning('导出失败，请重试。');}
}
async function openTemporaryBackups() {
    const ticket=++temporaryGeneration;showTemporaryBackups.value=true;temporaryLoading.value=true;
    temporaryError.value='';temporaryDelete.value='';temporaryItems.value=[];temporaryFailed.value=0;temporaryTruncated.value=false;
    try {
        const result=await listFirefoxMaterialBackupLeftovers();
        if(!active||ticket!==temporaryGeneration)return;
        temporaryItems.value=result.items;temporaryTruncated.value=result.truncated;temporaryFailed.value=result.failed;
    } catch(failure) {
        if(active&&ticket===temporaryGeneration)temporaryError.value=failure instanceof Error?failure.message:'临时文件读取失败，请重试。';
    } finally {if(active&&ticket===temporaryGeneration)temporaryLoading.value=false;}
}
function closeTemporaryBackups() {
    temporaryGeneration++;showTemporaryBackups.value=false;temporaryLoading.value=false;temporaryDelete.value='';
}
async function removeTemporaryBackup(item:MaterialBackupLeftover) {
    if(busy.value||temporaryDelete.value!==item.name)return;
    busy.value=true;temporaryError.value='';
    try {
        await removeFirefoxMaterialBackupLeftover(item.name);
        if(active){temporaryItems.value=temporaryItems.value.filter(value=>value.name!==item.name);temporaryDelete.value='';}
    } catch(failure) {if(active)temporaryError.value=failure instanceof Error?failure.message:'临时文件删除失败，请重试。';}
    finally {if(active){busy.value=false;flushVisibleReads();}}
}
async function recoverTemporaryBackup(item:MaterialBackupLeftover) {
    if(busy.value||!item.ready)return;
    if(loading.value)pendingRefresh=true;
    busy.value=true;loading.value=false;error.value='';temporaryError.value='';
    const ticket=++generation,controller=new AbortController();exportController=controller;exportRunning.value=true;exportKeepOpen.value=true;
    const filename=`fluentread-materials-recovered-${new Date().toISOString().slice(0,10)}.json`;
    try {
        // Firefox 的权限请求必须在用户点击的同步调用栈里启动。
        const pending=beginFirefoxRecoveredMaterialBackup(item.name,filename).then(choice=>{
            if(choice.status!=='ready')throw new Error(choice.status==='denied'?'未获得下载权限，无法取回备份。':'当前浏览器无法取回临时备份。');
            return choice.target;
        });
        const target=await waitForMaterialBackupTarget(pending,controller.signal,()=>reportLateBackupCleanup('firefox'));
        const result=await saveMaterialBackup(target,async()=>{},{signal:controller.signal});
        const message=result.state==='saved'?'备份下载完成，临时文件仍保留；确认后可删除。':'已发起备份下载，临时文件仍保留；请确认下载完成后再处理。';
        if(active&&ticket===generation)feedback.value=message;
        else recordBackupStatus(result.state==='saved'?'此前开始的临时备份下载已完成，临时文件仍保留；确认后可删除。':'此前开始的临时备份下载已发起，临时文件仍保留；请确认下载完成后再处理。');
    } catch(failure) {
        if(isBackupError(failure,'MaterialBackupContextError'))void prepareFirefoxMaterialBackupContext();
        if(active&&ticket===generation)temporaryError.value=backupFailureMessage(failure,'已取消取回备份。','取回备份失败，请重试。',true);
        else if(isBackupError(failure,'AbortError'))recordBackupStatus('此前开始的临时备份取回已取消。');
        else retainUnmountedBackupFailure(failure,'firefox');
    } finally {
        if(exportController===controller)exportController=undefined;exportRunning.value=false;exportKeepOpen.value=false;
        if(active&&ticket===generation){busy.value=false;flushVisibleReads();}
    }
}
function releaseFallbackDownload() {
    if (!fallbackDownloadUrl.value) return;
    URL.revokeObjectURL(fallbackDownloadUrl.value);fallbackDownloadUrl.value='';
}
function answerExportCapacity(proceed:boolean) {exportCapacityAnswer?.(proceed);}
function confirmExportCapacity(statistics:{maxRecordBytes:number;frames:number},signal:AbortSignal):Promise<void> {
    const recordTooLarge=statistics.maxRecordBytes>MATERIAL_IMPORT_MAX_RECORD_BYTES,tooManyFrames=statistics.frames>MATERIAL_IMPORT_MAX_FRAMES;
    if(!recordTooLarge&&!tooManyFrames)return Promise.resolve();
    return new Promise((resolve,reject)=>{
        let settled=false;
        const finish=(proceed:boolean)=>{
            if(settled)return;settled=true;signal.removeEventListener('abort',abort);exportCapacityAnswer=undefined;exportCapacityPrompt.value=null;
            if(proceed)resolve();else reject(new DOMException('材料导出已取消','AbortError'));
        };
        const abort=()=>finish(false);
        exportCapacityAnswer=finish;exportCapacityPrompt.value={recordTooLarge,tooManyFrames};
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
}
async function exportMaterials() {
    if (busy.value || fallbackDownloadUrl.value)
        return;
    if (loading.value) pendingRefresh = true;
    busy.value = true;
    const ticket = ++generation;
    loading.value = false;
    error.value = '';
    backupWarning.value = '';
    const controller=new AbortController();exportController=controller;exportRunning.value=true;exportKeepOpen.value=false;exportBuffered.value=false;
    const name=`fluentread-materials-${new Date().toISOString().slice(0,10)}.json`;
    const picker=(window as Window & {showSaveFilePicker?:MaterialBackupSavePlatform['pick']}).showSaveFilePicker;
    // 文件选择器和 Firefox 可选权限必须在首次 await 前由用户手势启动。
    const firefoxChoice=picker?undefined:beginFirefoxMaterialBackup(name);
    const fallback=()=>chooseMaterialBackupTarget(name,{
        ...(picker?{pick:picker.bind(window)}:{}),
        async downloadBuffered(filename,parts,signal) {
            if(signal.aborted)throw new DOMException('材料导出已取消','AbortError');
            if(fallbackDownloadUrl.value)throw new Error('请先确认上一份备份下载完成。');
            const blob=new Blob(parts.map(part=>part as Uint8Array<ArrayBuffer>),{type:'application/json'}), url=URL.createObjectURL(blob);
            const revoke=()=>{try{URL.revokeObjectURL(url);}catch{/* 清理失败不覆盖导出结果。 */}};
            try {const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;anchor.click();fallbackDownloadUrl.value=url;return 'initiated' as const;}
            catch(error){revoke();throw error;}
        },
    });
    let selectedFirefox=false,selectedBuffered=false;
    const targetPromise=firefoxChoice?firefoxChoice.catch(failure=>{
        if(isBackupError(failure,'MaterialBackupContextError')) {void prepareFirefoxMaterialBackupContext();throw failure;}
        if(isBackupError(failure,'MaterialBackupInitializationCleanupError'))
            recordBackupWarning('创建备份时未能清理新建的空临时文件，请在临时文件列表检查。');
        return {status:'unavailable' as const};
    }).then(choice=>{
        if(choice.status==='ready'){selectedFirefox=true;return choice.target;}
        selectedBuffered=true;
        return fallback();
    }):fallback();
    try {
        const target=await waitForMaterialBackupTarget(targetPromise,controller.signal,()=>reportLateBackupCleanup(selectedFirefox?'firefox':picker?'picker':'buffered'));
        exportKeepOpen.value=selectedFirefox;exportBuffered.value=selectedBuffered;
        const result=await saveMaterialBackup(target,async (consume,signal)=>{
            const port=browser.runtime.connect({name:MATERIAL_BACKUP_EXPORT_PORT_NAME}) as unknown as MaterialReadPort;
            const readController=new AbortController(),cancelRead=()=>readController.abort();
            signal.addEventListener('abort',cancelRead,{once:true});if(signal.aborted)cancelRead();
            let receiving:Promise<import('../materialBackupExportProtocol').MaterialBackupExportStatistics>|undefined;
            try {
                const receiver=startMaterialBackupExport(port,consume,{signal:readController.signal});receiving=receiver.result;void receiving.catch(()=>{});
                try {port.postMessage({v:1,type:'start',operation:'export'});} catch(error) {receiver.assertOpen();throw error;}
                const statistics=await receiving;await confirmExportCapacity(statistics,signal);
            }
            catch(failure){cancelRead();try{port.disconnect();}catch{/* 端口可能已关闭。 */}if(receiving)await receiving.catch(()=>{});throw failure;}
            finally {signal.removeEventListener('abort',cancelRead);}
        },{signal:controller.signal});
        const message=result.state==='saved'?'材料备份已保存，包含来源、原句与个人笔记，请妥善保管。':'已发起材料备份下载，包含来源、原句与个人笔记，请检查浏览器下载。';
        if (!active || ticket !== generation) {
            // Blob 地址已有同文档提示，无需重复提示同一次下载发起。
            if(!(selectedBuffered && result.state==='initiated' && fallbackDownloadUrl.value))
                recordBackupStatus(result.state==='saved'?'此前开始的材料备份已保存，包含来源、原句与个人笔记，请妥善保管。':'此前开始的材料备份下载已发起，包含来源、原句与个人笔记，请检查浏览器下载。');
            if(result.bytes > MATERIAL_INLINE_BACKUP_MAX_BYTES)recordBackupStatus('此前开始的备份较大，恢复受设备空间、单份材料 128 MiB 和总计 20,000 个 128 KiB 分片的限制。请保留现有材料并妥善保存备份文件。');
            return;
        }
        feedback.value = message;
        if (result.bytes > MATERIAL_INLINE_BACKUP_MAX_BYTES)
            backupWarning.value = '备份较大，恢复受设备空间、单份材料 128 MiB 和总计 20,000 个 128 KiB 分片的限制。请保留现有材料并妥善保存备份文件。';
    }
    catch (failure) {
        if (active && ticket === generation)
            error.value = backupFailureMessage(failure,'已取消导出。','导出失败，请重试。',selectedFirefox);
        else if(isBackupError(failure,'AbortError'))recordBackupStatus('此前开始的材料备份导出已取消。');
        else retainUnmountedBackupFailure(failure,selectedFirefox?'firefox':picker?'picker':'buffered');
    }
    finally {
        if(exportController===controller)exportController=undefined;exportRunning.value=false;exportKeepOpen.value=false;exportBuffered.value=false;
        if (active && ticket === generation)
            {busy.value = false; flushVisibleReads();}
    }
}
async function importMaterials(event: Event) {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    input.value = '';
    if (!file || busy.value || pendingImport.value)
        return;
    if (loading.value) pendingRefresh = true;
    busy.value = true;
    const ticket = ++generation;
    loading.value = false;
    error.value = '';
    const capturedAt = Date.now();
    const controller = file.size > MATERIAL_INLINE_BACKUP_MAX_BYTES ? new AbortController() : undefined;
    let committed = false;
    if (controller) {backupController = controller; largeRestoreRunning.value = true;}
    try {
        const storageGeneration = await (controller ? backupGeneration(controller.signal) : materialGeneration());
        if (!active || ticket !== generation)
            return;
        if (controller) {
            const outcome = await restoreLargeMaterialBackup(file, {generation: storageGeneration, capturedAt}, {
                signal: controller.signal,
                onCapability: value => {if (active && ticket === generation) {pendingImport.value = value; canForgetPending.value = false;} else controller.abort();},
            });
            if (!active || ticket !== generation) return;
            if (outcome.kind === 'committed') {
                committed = true;
                feedback.value = importFeedback(outcome.result);
                await refreshImported(outcome.capability, ticket, controller.signal);
            } else if (outcome.kind === 'unknown') error.value = '无法确认材料是否已恢复，请先检查恢复结果。';
            else {
                if (!outcome.cleanupPending) pendingImport.value = undefined;
                error.value = outcome.kind === 'cancelled' ? '已取消恢复。' : backupErrorMessage(outcome.error);
            }
            return;
        }
        const text = await file.text();
        if (!active || ticket !== generation)
            return;
        const result = await materialImport(JSON.parse(text), { generation: storageGeneration, capturedAt });
        if (!active || ticket !== generation)
            return;
        committed = true;
        feedback.value = importFeedback(result);
        resetSelection();
        listController?.abort();const refresh=new AbortController();listController=refresh;
        try {await loadPagedListWithRetry(ticket,visibilityEpoch,refresh.signal);}
        finally {if(listController===refresh)listController=undefined;}
    }
    catch (failure) {
        if (active && ticket === generation)
            error.value = committed ? '材料已恢复，但列表尚未刷新。可检查恢复结果后重试。' : failure instanceof SyntaxError ? '备份文件无法读取，请选择有效的材料 JSON 备份。' : failure instanceof Error ? failure.message : '恢复失败，请检查材料备份文件。';
    }
    finally {
        if (backupController === controller) backupController = undefined;
        if (controller) largeRestoreRunning.value = false;
        if (active && ticket === generation)
            {busy.value = false; flushVisibleReads();}
    }
}
function importFeedback(result: MaterialImportResult): string {
    return result.inserted + result.updated === 0 ? `没有恢复材料，跳过 ${result.skipped} 条无效、冲突或较旧的记录。` : `已恢复 ${result.inserted + result.updated} 份材料（新增 ${result.inserted} · 更新 ${result.updated} · 跳过 ${result.skipped}）。`;
}
function backupErrorMessage(failure: unknown): string {
    if (failure instanceof SyntaxError) return '备份文件无法读取，请选择有效的材料 JSON 备份。';
    if (failure instanceof Error && failure.name === 'MaterialBackupCapacityError') {
        if (failure.message === '材料记录超过恢复大小限制') return '材料记录超过恢复大小限制，请保留原材料和备份文件。';
        if (failure.message === '备份文件嵌套层级超过恢复限制') return '备份文件嵌套层级超过恢复限制，请保留原材料和备份文件。';
        if (failure.message === '备份版本字段超过恢复大小限制') return '备份版本字段超过恢复大小限制，请保留原材料和备份文件。';
        return '材料备份超出当前恢复容量，请保留原材料和备份文件。';
    }
    return failure instanceof Error && failure.name === 'TimeoutError' ? '恢复请求超时，请重试。' : '恢复失败，请检查材料备份文件。';
}
/** 只停止等待，不能声称底层只读消息已经终止。 */
function backupRead<T>(start: () => Promise<T>, signal: AbortSignal | undefined, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let done = false;
        const finish = (error?: Error, value?: T) => {
            if (done) return;
            done = true; signal?.removeEventListener('abort', abort); clearTimeout(timer);
            if (error) reject(error); else resolve(value!);
        };
        const abort = () => finish(Object.assign(new Error('已取消恢复。'), {name: 'AbortError'}));
        const timer = setTimeout(() => finish(new Error(timeoutMessage)), 30_000);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) {abort(); return;}
        Promise.resolve().then(() => {if (signal?.aborted) throw Object.assign(new Error('已取消恢复。'), {name: 'AbortError'}); return start();})
            .then(value => finish(undefined, value), failure => finish(failure instanceof Error ? failure : new Error('材料状态读取失败。')));
    });
}
function backupGeneration(signal: AbortSignal): Promise<number> {return backupRead(materialGeneration, signal, '材料状态读取超时，请重试。');}
async function refreshImported(capability: Capability, ticket: number, signal?: AbortSignal): Promise<void> {
    resetSelection();
    listController?.abort();const refresh=new AbortController();listController=refresh;
    const abort=()=>refresh.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let refreshed=false;
    try {refreshed=await loadPagedListWithRetry(ticket,visibilityEpoch,refresh.signal);}
    finally {signal?.removeEventListener('abort',abort);if(listController===refresh)listController=undefined;}
    if (!refreshed || !active || ticket !== generation) return;
    await nextTick();
    if (!active || ticket !== generation) return;
    // 结果已展示并刷新；确认失败只保留后台回执直至过期，不改变提交结果。
    pendingImport.value = undefined; canForgetPending.value = false;
    void acknowledgeMaterialBackup(capability).catch(() => undefined);
}
function cancelLargeRestore(): void {backupController?.abort();}
async function resolvePendingImport(discard: boolean): Promise<void> {
    const cap = pendingImport.value;
    if (!cap || busy.value) return;
    busy.value = true; error.value = ''; const ticket = ++generation;
    let committed = false;
    try {
        const state = discard ? await discardMaterialBackup(cap) : await queryMaterialBackup(cap);
        if (!active || ticket !== generation) return;
        if (state.state === 'committed') {committed = true; feedback.value = importFeedback(state.result); await refreshImported(cap, ticket);}
        else if (state.state === 'discarded') {pendingImport.value = undefined; canForgetPending.value = false; feedback.value = '未完成的恢复已结束。';}
        else error.value = '恢复尚未完成。可继续检查，或结束未完成的恢复。';
    } catch {if (active && ticket === generation) {if (discard && !committed) canForgetPending.value = true; error.value = committed ? '材料已恢复，但列表尚未刷新。可检查恢复结果后重试。' : '暂时无法确认恢复状态，请检查材料列表后重试。';}}
    finally {if (active && ticket === generation) {busy.value = false; flushVisibleReads();}}
}
function checkPendingImport(): Promise<void> {return resolvePendingImport(false);}
function endPendingImport(): Promise<void> {return resolvePendingImport(true);}
function forgetPendingImport(): void {
    if (busy.value) return;
    pendingImport.value = undefined;
    canForgetPending.value = false;
    error.value = '';
    feedback.value = '恢复结果尚未确认，暂存可能仍在本机。请先检查材料列表，再决定是否重新恢复。';
}
const onChanged = (message: unknown): undefined => {
    if (active && typeof message === 'object' && message !== null && (message as {type?: string}).type === MATERIAL_CHANGED_MESSAGE) {
        changes++;
        pendingRefresh = true;
        flushVisibleReads();
    }
    return undefined;
};
watch(viewVisible, visible => {
    if (!active) return;
    if (visible) {flushVisibleReads(); return;}
    visibilityEpoch++;
    if(listController)pendingRefresh=true;
    listController?.abort();detailController?.abort();topicController?.abort();
    const session=currentSession;currentSession=undefined;if(session){pendingRefresh=true;void closeSession(session.capability);}
    if (loading.value) pendingRefresh = true;
    loading.value = false;
    if (detailLoading.value) pendingReferences = Boolean(selected.value);
    detailGeneration++;
    detailLoading.value = false;
}, {flush: 'sync'});
watch([query,topic], () => {
    if (!active) return;
    listController?.abort();pendingRefresh=true;materialVisibleTarget=30;queryPending.value=true;materials.value=[];materialNext.value=null;
    if(queryTimer!==undefined)clearTimeout(queryTimer);
    queryTimer=setTimeout(()=>{queryTimer=undefined;queryPending.value=false;void reload(true);},150);
}, {flush:'sync'});
watch(topicSearch, () => {
    topicController?.abort();pendingTopicSearch=true;
    if(topicTimer!==undefined)clearTimeout(topicTimer);
    topicTimer=setTimeout(()=>{topicTimer=undefined;flushVisibleReads();},150);
}, {flush:'sync'});
onActivated(() => {keptAliveVisible.value = true;});
onDeactivated(() => {keptAliveVisible.value = false;});
onMounted(() => { void prepareFirefoxMaterialBackupContext(); void reload(); browser.runtime.onMessage.addListener(onChanged); });
onBeforeUnmount(() => { active = false; generation++; detailGeneration++; temporaryGeneration++; backupController?.abort();exportController?.abort();listController?.abort();detailController?.abort();topicController?.abort();if(queryTimer!==undefined)clearTimeout(queryTimer);if(topicTimer!==undefined)clearTimeout(topicTimer);const session=currentSession;currentSession=undefined;if(session)void closeSession(session.capability);browser.runtime.onMessage.removeListener(onChanged); });
</script>
<style scoped>
.fr-materials {
  color:var(--ink);
  font-size:13px;
  line-height:1.65;
  min-width:0
}
.fr-materials button,.fr-materials input,.fr-materials select,.fr-materials textarea,.fr-materials a {
  font:inherit
}
.fr-materials button,.fr-materials select,.fr-materials a {
  cursor:pointer
}
.fr-materials button:disabled {
  cursor:wait;
  opacity:.55
}
.fr-materials button,.fr-materials a {
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:6px;
  border:1px solid var(--line);
  border-radius:8px;
  padding:6px 11px;
  background:var(--surface);
  color:var(--ink);
  text-decoration:none
}
.fr-materials :is(button,a,input,textarea,select,summary):focus-visible {
  outline:2px solid var(--brand);
  outline-offset:3px
}
.fr-material-toolbar {
  display:flex;
  gap:8px;
  align-items:center;
  margin-bottom:16px
}
.fr-material-search {
  display:flex;
  align-items:center;
  gap:8px;
  min-width:0;
  flex:1;
  border:1px solid var(--line);
  border-radius:9px;
  padding:7px 10px;
  color:var(--muted)
}
.fr-material-search input {
  width:100%;
  min-width:0;
  padding:0;
  border:0;
  outline:0;
  background:transparent;
  color:var(--ink)
}
.fr-material-toolbar select {
  max-width:170px;
  min-width:90px;
  background:var(--surface);
  color:var(--ink);
  border:1px solid var(--line);
  border-radius:8px;
  padding:7px
}
.fr-material-menu {
  position:relative;
  margin-left:auto
}
.fr-material-menu>summary {
  display:flex;
  align-items:center;
  justify-content:center;
  width:34px;
  height:34px;
  cursor:pointer;
  list-style:none;
  border-radius:8px
}
.fr-material-menu>summary::-webkit-details-marker {
  display:none
}
.fr-material-menu>div {
  position:absolute;
  right:0;
  top:40px;
  z-index:3;
  display:grid;
  gap:4px;
  width:175px;
  padding:6px;
  border:1px solid var(--line);
  border-radius:10px;
  background:var(--surface);
  box-shadow:0 8px 24px #0002
}
.fr-material-menu button {
  justify-content:flex-start;
  border:0
}
.fr-material-feedback {
  padding:8px 0;
  margin:0 0 12px;
  color:var(--muted)
}
.fr-material-feedback button {
  padding:2px 8px;
  margin-left:6px
}
.fr-material-feedback.error {
  color:var(--fr-danger)
}
.fr-material-empty {
  max-width:540px;
  padding:42px 18px;
  margin:auto;
  text-align:center;
  color:var(--muted)
}
.fr-material-empty h2 {
  font-size:17px;
  color:var(--ink)
}
.fr-material-empty p {
  margin:10px 0 22px
}
.fr-material-layout {
  display:grid;
  min-width:0;
  gap:24px
}
.fr-material-list {
  display:grid;
  align-content:start;
  gap:0;
  min-width:0
}
.fr-materials .fr-material-card {
  display:flex;
  align-items:stretch;
  flex-direction:column;
  gap:8px;
  text-align:left;
  padding:17px 10px;
  border:0;
  border-radius:0;
  border-bottom:1px solid var(--line);
  background:transparent;
  min-width:0
}
.fr-material-card:hover {
  background:var(--brand-soft)
}
.fr-material-card strong {
  font-size:16px;
  font-weight:650;
  line-height:1.45;
  overflow-wrap:anywhere
}
.fr-material-meta {
  display:flex;
  align-items:center;
  gap:7px;
  flex-wrap:wrap;
  color:var(--muted);
  font-size:11px
}
.fr-material-meta>span {
  overflow-wrap:anywhere
}
.fr-material-preview {
  display:-webkit-box;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
  overflow:hidden;
  color:var(--muted);
  font-size:13px
}
.fr-material-topic {
  color:var(--brand-strong);
  font-size:11px;
  overflow-wrap:anywhere
}
.has-selection {
  grid-template-columns:minmax(190px,28%) minmax(0,1fr)
}
.has-selection .fr-material-list {
  border-right:1px solid var(--line);
  padding-right:14px
}
.has-selection .fr-material-card {
  padding:13px 10px;
  border-radius:8px;
  border-bottom:0
}
.has-selection .fr-material-card strong {
  font-size:13px
}
.has-selection .fr-material-card.selected {
  background:var(--brand-soft)
}
.has-selection .fr-material-preview {
  font-size:11px
}
.fr-material-detail {
  min-width:0
}
.fr-material-heading {
  margin-bottom:20px
}
.fr-material-heading h2 {
  font-size:22px;
  line-height:1.4;
  margin:6px 0 16px;
  overflow-wrap:anywhere
}
.fr-material-heading h2:focus {
  outline:0
}
.fr-materials .fr-material-back {
  display:none;
  border:0;
  padding:0;
  margin-bottom:12px;
  font-size:12px;
  color:var(--brand-strong);
  background:transparent
}
.fr-material-actions {
  display:flex;
  gap:7px;
  flex-wrap:wrap
}
.fr-materials .fr-material-primary {
  background:var(--brand);
  color:white;
  border-color:var(--brand);
  font-weight:600
}
.fr-material-recovery {
  font-size:11px;
  color:var(--muted);
  margin:10px 0 0;
  line-height:1.7
}
.fr-material-quote {
  margin:0 0 20px;
  border-left:3px solid var(--brand);
  padding:7px 0 7px 14px;
  font-size:16px;
  line-height:1.85;
  overflow-wrap:anywhere
}
.fr-material-quote footer {
  font-size:11px;
  color:var(--muted);
  margin-top:8px
}
.fr-material-reference {
  padding:16px 0;
  border-top:1px solid var(--line);
  overflow-wrap:anywhere
}
.fr-material-reference>header {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:8px;
  color:var(--muted);
  font-size:11px
}
.fr-material-reference>header button {
  border:0;
  padding:0;
  background:transparent;
  font-size:11px;
  color:var(--muted)
}
.fr-material-reference h3 {
  font-size:16px;
  margin:8px 0
}
.fr-material-reference p {
  margin:8px 0;
  white-space:pre-wrap
}
.fr-material-reference blockquote {
  margin:10px 0;
  font-size:15px
}
.fr-material-translation {
  color:var(--muted)
}
.fr-material-reference small {
  color:var(--muted);
  font-size:11px
}
.fr-material-turn {
  margin:10px 0
}
.fr-material-turn summary {
  cursor:pointer;
  list-style:revert;
  font-size:13px;
  line-height:1.6
}
.fr-material-note-form {
  display:grid;
  gap:8px;
  margin-top:22px
}
.fr-material-note-form>div {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px
}
.fr-material-note-form small,.fr-material-editor small {
  color:var(--muted);
  font-size:11px
}
.fr-material-note-form label {
  font-size:12px;
  font-weight:600
}
.fr-materials textarea,.fr-material-editor input {
  width:100%;
  box-sizing:border-box;
  background:var(--surface);
  color:var(--ink);
  border:1px solid var(--line);
  border-radius:8px;
  padding:9px 11px;
  resize:vertical
}
.fr-material-editor {
  display:grid;
  gap:12px;
  padding:16px;
  margin:0 0 20px;
  background:var(--brand-soft);
  border-radius:10px
}
.fr-material-editor label {
  display:grid;
  gap:5px;
  font-size:12px
}
.fr-material-note {
  white-space:pre-wrap
}
.fr-materials .fr-material-menu > summary {
  width:34px;
  min-height:34px;
  margin:0;
  padding:0;
  border:1px solid var(--line);
  background:var(--surface);
  font-weight:400
}
.fr-materials .fr-material-menu > summary::after {
  display:none;
  content:none
}
@media(max-width:850px) {
  .has-selection {
    grid-template-columns:1fr
  }
  .has-selection .fr-material-list {
    display:none
  }
  .fr-materials .fr-material-back {
    display:inline-flex
  }
  .fr-material-heading h2 {
    font-size:20px
  }
}
@media(max-width:480px) {
  .fr-material-references {
    /* 覆盖式滚动条不为 gutter 留位，局部内边距保护原句和问答行尾。 */
    padding-inline-end:16px
  }
  .fr-material-toolbar {
    flex-wrap:wrap
  }
  .fr-material-search {
    flex-basis:calc(100% - 60px);
    order:0
  }
  .fr-material-menu {
    order:1
  }
  .fr-material-toolbar select {
    order:2;
    max-width:100%;
    width:100%
  }
  .fr-material-heading h2 {
    font-size:18px
  }
  .fr-material-empty {
    padding:25px 4px
  }
  .fr-material-quote {
    font-size:15px
  }
}
</style>

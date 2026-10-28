<!--
 * @file src/features/vocabulary/ui/MaterialWorkspace.vue
 * 文件职责：以阅读材料和收藏原句为主要内容，提供主题整理、回到出处、连续学习和本地笔记。
 * 主要内容：保留轻量材料列表，空库隐藏无效搜索与主题筛选但保留管理和恢复入口，详情按来源聚合原句、实时收藏和问答；非空搜索只为当前主题保留有界小写正文，深层字段变化使缓存失效，超预算材料完整匹配且每轮只构造一次；刷新按顺序比较引用的完整协议字段，不为未变正文生成 JSON 快照；窄屏引用正文预留覆盖式滚动条空间，保持滚动时行尾可读；加载、重试、编辑、归档恢复均保护异步代次和卸载边界，笔记焦点只回到仍属于当前材料的自有输入框，保存成功只清理所属材料中与提交快照相同的草稿；隐藏期间合并普通刷新而保留已接受写入，以独立可见性代次隔离旧读取和焦点，异步迟到挂载读取上游当前可见性。
 * 模块边界：只通过本地材料与既有学习客户端读写，不访问数据库或供应商；来源恢复由公共适配器处理，个人内容不进入配置同步。
 -->
<template>
  <section class="fr-materials" aria-label="阅读材料" :aria-busy="loading">
    <div class="fr-material-toolbar">
      <label v-if="materials.length" class="fr-material-search"><UiIcon name="search" :size="16" /><input v-model="query" type="search" aria-label="搜索阅读材料" placeholder="搜索材料、原句或笔记" /></label>
      <select v-if="materials.length && (topics.length || topic)" v-model="topic" aria-label="按主题筛选"><option value="">全部主题</option><option v-for="item in topics" :key="item" :value="item">{{ item }}</option></select>
      <details class="fr-material-menu" @keydown.esc.stop.prevent="closeMenu">
        <summary aria-label="材料管理"><UiIcon name="sliders" :size="16" /></summary>
        <div @click="closeMenu"><button type="button" :disabled="loading || busy" @click="reload()">刷新材料</button><button type="button" :disabled="busy" @click="toggleArchive">{{ archived ? '返回阅读材料' : '查看已移除材料' }}</button><button type="button" :disabled="busy" @click="exportMaterials">导出材料备份</button><button type="button" :disabled="busy" @click="importInput?.click()">恢复材料备份</button><button type="button" :disabled="busy" @click="confirmClear = true">清空全部材料</button></div>
      </details>
      <input ref="importInput" type="file" accept=".json,application/json" hidden aria-label="恢复材料备份" @change="importMaterials" />
    </div>
    <section v-if="confirmClear" class="fr-material-editor" aria-label="确认清空全部材料">
      <strong>清空全部材料？</strong><p>材料主题、阅读位置和材料中的个人笔记将永久删除。原有收藏、阅读问答和学习笔记仍保留。可以先导出材料备份。</p>
      <div class="fr-material-actions"><button type="button" :disabled="busy" @click="clearMaterials">确认清空</button><button type="button" :disabled="busy" @click="confirmClear = false">取消</button></div>
    </section>
    <p v-if="error" class="fr-material-feedback error" role="alert">{{ error }} <button type="button" :disabled="busy" @click="reload()">重试</button></p>
    <p v-if="backupWarning" class="fr-material-feedback error" role="alert">{{ backupWarning }}</p>
    <p v-if="feedback" class="fr-material-feedback" role="status">{{ feedback }}</p>
    <p v-if="archived" class="fr-material-feedback">已移除的材料仍保留原句与笔记，恢复后可继续阅读。原有收藏与问答不受影响。</p>
    <div v-if="loading && !materials.length" class="fr-material-empty" role="status">正在读取材料…</div>
    <div v-else-if="!materials.length && !error" class="fr-material-empty">
      <UiIcon name="book" :size="28" /><h2>{{ archived ? '没有已移除的材料' : '从一段值得留下的原文开始' }}</h2>
      <p>{{ archived ? '材料移除后可以在这里恢复。' : '收藏原句、保存阅读问答或笔记后，同一篇文章、文档或视频会归在一起。只收藏一个词也可以，无须创建项目。' }}</p>
      <button type="button" @click="archived ? toggleArchive() : emit('openTab', 'saved')">{{ archived ? '返回材料' : '查看我的收藏' }}</button>
    </div>
    <p v-else-if="!filtered.length" class="fr-material-feedback">没有匹配的材料。<button type="button" @click="query = ''; topic = ''">清除筛选</button></p>
    <div v-else class="fr-material-layout" :class="{'has-selection': selected}">
      <nav ref="materialListElement" class="fr-material-list" aria-label="材料列表">
        <button v-for="item in visibleMaterials" :key="item.id" type="button" class="fr-material-card" :data-material-id="item.id" :class="{selected: selectedId === item.id}" :aria-current="selectedId === item.id ? 'true' : undefined" @click="select(item.id)">
          <span class="fr-material-meta"><UiIcon :name="icon(item.kind)" :size="14" />{{ kindLabel(item.kind) }}<span :title="item.source.url" :data-i18n-ignore="sourceLabel(item) === '本地文件' || sourceLabel(item) === '来源待恢复' ? undefined : ''">{{ sourceLabel(item) }}</span></span>
          <strong data-i18n-ignore>{{ item.title }}</strong>
          <span v-if="preview(item)" class="fr-material-preview" data-i18n-ignore>{{ preview(item) }}</span>
          <span class="fr-material-meta"><span v-if="item.topics.length" class="fr-material-topic" data-i18n-ignore>{{ item.topics.join(' · ') }}</span><span>{{ item.references.length }} 条学习内容</span><span>{{ formatDate(item.lastReadAt) }}</span></span>
        </button>
        <button v-if="visibleMaterials.length < filtered.length" type="button" @click="materialLimit += 30">显示更多材料（{{ visibleMaterials.length }} / {{ filtered.length }}）</button>
      </nav>
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
          <datalist id="fr-material-topic-list"><option v-for="item in topics" :key="item" :value="item" /></datalist>
          <label v-if="selected.kind !== 'document'">来源地址<input v-model="draft.url" type="url" required maxlength="2048" :disabled="busy" /></label>
          <small>更换地址后会重新核对材料身份；原句仍可用于找回位置。</small>
          <div class="fr-material-actions"><button type="submit" class="fr-material-primary" :disabled="busy || !draft.title.trim()">保存</button><button type="button" :disabled="busy" @click="cancelEdit">取消</button></div>
        </form>
        <blockquote v-if="selected.locator?.quote" class="fr-material-quote"><span data-i18n-ignore>{{ selected.locator.quote }}</span><footer>{{ positionLabel(selected) }}<span v-if="selected.locator.kind === 'document' && selected.locator.section" data-i18n-ignore> · {{ selected.locator.section }}</span></footer></blockquote>
        <div v-if="detailLoading" class="fr-material-feedback" role="status">正在读取学习内容…</div>
        <p v-if="detailError" class="fr-material-feedback error" role="alert">{{ detailError }} <button type="button" @click="loadReferences">重试</button></p>
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
          <button v-if="visibleReferences.length < selected.references.length" type="button" :disabled="detailLoading" @click="showMoreReferences">显示更多学习内容</button>
        </section>
        <form v-if="!archived" class="fr-material-note-form" @submit.prevent="saveNote">
          <label for="fr-material-note">记下这份材料的想法</label><textarea ref="noteInput" id="fr-material-note" v-model="note" rows="3" maxlength="2000" placeholder="用自己的话记下理解、疑问或下一步…" :disabled="busy" />
          <div><small>仅保存在本机</small><span><button v-if="editingNoteId" type="button" :disabled="busy" @click="editingNoteId = ''; note = ''">取消编辑</button> <button type="submit" class="fr-material-primary" :disabled="busy || !note.trim()">{{ editingNoteId ? '更新笔记' : '保存笔记' }}</button></span></div>
        </form>
      </article>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import browser from 'webextension-polyfill';
import UiIcon from '@/src/ui/components/UiIcon.vue';
import { ReadingAnswer } from '@/src/features/reading-assistant/ui/answer/public';
import { getHarnessSession, listLearningMemories } from '@/src/features/reading-assistant/public';
import type { HarnessSession } from '@/src/services/harness/sessionTypes';
import type { VocabularyEntry } from '../learningModel';
import { VOCABULARY_BOOK_MESSAGE, type VocabularyBookResponse } from '../protocol';
import type { MaterialRecord, MaterialReference } from '../materialProtocol';
import { MATERIAL_BACKUP_MAX_BYTES, MATERIAL_CHANGED_MESSAGE } from '../materialProtocol';
import { materialList, materialCapture, materialUpdate, materialArchive, materialRestore, materialRemoveReference, materialClear, materialExport, materialImport, materialGeneration } from '../materialClient';
import { materialResumeLink } from '../materialSource';
import { useRenderDateFormatter } from '@/src/ui/dateFormat';
import { downloadTextFile } from '@/src/shared/dom/downloadTextFile';
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
const materials = ref<MaterialRecord[]>([]), selectedId = ref(''), query = ref(''), topic = ref(''), archived = ref(false);
const loading = ref(false), busy = ref(false), error = ref(''), feedback = ref(''), editing = ref(false), note = ref('');
const backupWarning = ref('');
const draft = ref({ title: '', topics: '', url: '' });
const confirmClear = ref(false), importInput = ref<HTMLInputElement>(), editingNoteId = ref('');
const noteInput = ref<HTMLTextAreaElement>();
const organizeButton = ref<HTMLButtonElement>(), titleInput = ref<HTMLInputElement>(), materialListElement = ref<HTMLElement>();
const detailLoading = ref(false), detailError = ref(''), detailHeading = ref<HTMLElement>();
const referenceLimit = ref(24);
const materialLimit = ref(30);
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
    if (!active || !viewVisible.value || busy.value || loading.value) return;
    if (pendingRefresh) void reload(true);
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
const selected = computed(() => materials.value.find(item => item.id === selectedId.value));
const visibleReferences = computed(() => selected.value?.references.slice(0, referenceLimit.value) || []);
const topics = computed(() => [...new Set(materials.value.flatMap(item => item.topics))].sort((a, b) => a.localeCompare(b)));
function materialSearchParts(item: MaterialRecord): (string | undefined)[] {
    return [item.title, item.source.url, ...item.topics, ...item.references.flatMap(reference => [reference.excerpt, reference.note])];
}
const topicMaterials = computed(() => materials.value.filter(item => !topic.value || item.topics.includes(topic.value)));
const searchActive = computed(() => Boolean(query.value.trim()));
// 限制额外保留的小写文本为 4 Mi 字符（UTF-16 载荷至多约 8 MiB，Map 与对象另计）。
const SEARCH_TEXT_CHARACTER_LIMIT = 4 * 1024 * 1024;
type MaterialSearchMemo = {items: MaterialRecord[]; texts: Map<MaterialRecord, string>; remaining: number};
let retainedSearchMemo: MaterialSearchMemo | undefined;
function clearSearchMemo(): void {
    if (!retainedSearchMemo) return;
    retainedSearchMemo.texts.clear();
    retainedSearchMemo.items = [];
    retainedSearchMemo = undefined;
}
const searchMemo = computed(() => {
    const items = topicMaterials.value;
    clearSearchMemo();
    // 只登记当前主题的全部可搜索深层依赖，不在这里拼接或保留正文；原地编辑也须清除旧缓存。
    if (searchActive.value) for (const item of items) materialSearchParts(item);
    const memo = {items, texts: new Map<MaterialRecord, string>(), remaining: SEARCH_TEXT_CHARACTER_LIMIT};
    retainedSearchMemo = memo;
    return memo;
});
// 空库模板不消费 lazy computed；同步释放旧缓存的正文和材料列表引用，不强制建立新索引。
watch([topicMaterials, searchActive], clearSearchMemo, {flush: 'sync'});
const filtered = computed(() => {
    const search = query.value.trim().toLocaleLowerCase();
    // 空搜索也读取新容器，释放上一轮正文及材料引用，不改变原有主题和顺序。
    const memo = searchMemo.value;
    if (!search) return memo.items;
    return memo.items.filter(item => {
        let text = memo.texts.get(item);
        if (text === undefined) {
            text = materialSearchParts(item).join(' ').toLocaleLowerCase();
            if (text.length <= memo.remaining) {
                memo.texts.set(item, text);
                memo.remaining -= text.length;
            }
        }
        // 超预算正文只在当前过滤中使用一次，不截断、不持有，也不妨碍后续小材料入缓存。
        return text.includes(search);
    });
});
const visibleMaterials = computed(() => filtered.value.slice(0,materialLimit.value));
watch([query,topic], () => {materialLimit.value = 30;});
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
const preview = (item: MaterialRecord) => item.locator?.quote || item.references.find(reference => reference.excerpt || reference.note)?.excerpt || item.references.find(reference => reference.note)?.note || '';
const entryTranslation = (entry: VocabularyEntry) => Object.values(entry.translations)[0]?.text || '';
function closeMenu(event: Event) { const target = event.target as HTMLElement; if (target.closest('button') || ('key' in event && event.key === 'Escape')) {
    const menu = target.closest('details');
    if (menu) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
    }
} }
function sourceLabel(item: MaterialRecord) { try {
    if (!item.source.url) return '本地文件';
    const url = new URL(item.source.url);
    const label = url.host + (url.pathname === '/' ? '' : url.pathname) + url.search;
    return label.length > 100 ? label.slice(0,97) + '…' : label;
}
catch {
    return '来源待恢复';
} }
function positionLabel(item: MaterialRecord) { const locator = item.locator; return locator?.kind === 'document' ? `第 ${locator.page || 1} 页` : locator?.kind === 'video' ? `上次看到 ${Math.floor((locator.startMs || 0) / 60000)}:${String(Math.floor((locator.startMs || 0) / 1000) % 60).padStart(2, '0')}` : '上次阅读的原文'; }
function replace(item: MaterialRecord) {
    const matches = (item.archivedAt !== null) === archived.value;
    materials.value = materials.value.flatMap(previous => previous.id === item.id ? matches ? [item] : [] : [previous]).sort((a, b) => b.lastReadAt - a.lastReadAt);
    if (!matches && selectedId.value === item.id) resetSelection();
}
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
    editing.value = false;
    note.value = '';
    editingNoteId.value = '';
    referenceLimit.value = 24;
    detailGeneration++;
    pendingReferences = false;
    detailLoading.value = false;
    resolved.value = {};
    detailError.value = '';
}
/** 比较全部引用的同序字段；缺省与 undefined 等价，不受对象键插入顺序影响。 */
function sameReferences(previous: readonly MaterialReference[] | undefined, next: readonly MaterialReference[] | undefined): boolean {
    if (previous === next) return true;
    if (!previous || !next || previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index++) {
        const left = previous[index], right = next[index];
        if (left.kind !== right.kind || left.id !== right.id || left.excerpt !== right.excerpt
            || left.note !== right.note || left.createdAt !== right.createdAt || left.updatedAt !== right.updatedAt) return false;
    }
    return true;
}
async function reload(preserveError = false) {
    if (!active) return;
    if (!viewVisible.value || busy.value) {pendingRefresh = true; return;}
    pendingRefresh = false;
    const ticket = ++generation, epoch = visibilityEpoch;
    loading.value = true;
    // 广播和恢复触发的补读不能抹去刚完成操作的失败；用户显式刷新才清理旧错误。
    if (!preserveError) error.value = '';
    try {
        const items = await materialList({ archived: archived.value });
        if (!active || ticket !== generation)
            return;
        if (!viewVisible.value || epoch !== visibilityEpoch) {pendingRefresh = true; return;}
        const previousReferences = selected.value?.references;
        materials.value = items;
        if (selectedId.value && !items.some(item => item.id === selectedId.value))
            resetSelection();
        else if (selectedId.value && !sameReferences(previousReferences, selected.value?.references)) {
            pendingReferences = true;
            detailGeneration++;
            detailLoading.value = false;
        }
    }
    catch (failure) {
        if (active && ticket === generation && viewVisible.value && epoch === visibilityEpoch && (!preserveError || !error.value))
            error.value = failure instanceof Error ? failure.message : '材料读取失败，请重试。';
    }
    finally {
        if (active && ticket === generation) {loading.value = false; flushVisibleReads();}
    }
}
function toggleArchive() { if (busy.value)
    return; archived.value = !archived.value; materials.value = []; resetSelection(); query.value = ''; topic.value = ''; feedback.value = ''; void reload(); }
async function select(id: string) {
    if (busy.value || selectedId.value === id)
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
    void loadReferences();
    await nextTick();
    if (ownsFocus() && selectedId.value === id)
        detailHeading.value?.focus({ preventScroll: true });
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
    resolved.value = {};
    try {
        const references = visibleReferences.value;
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
            resolved.value = Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
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
function showMoreReferences() { referenceLimit.value += 24; void loadReferences(); }
async function mutate(operation: () => Promise<MaterialRecord | void>, done: (item?: MaterialRecord) => void) {
    if (busy.value)
        return;
    if (loading.value) pendingRefresh = true;
    busy.value = true;
    loading.value = false;
    error.value = '';
    feedback.value = '';
    const ticket = ++generation;
    try {
        const item = await operation();
        if (active && ticket === generation)
            done(item || undefined);
    }
    catch (failure) {
        if (active && ticket === generation)
            error.value = failure instanceof Error ? failure.message : '操作未完成，请重试。';
    }
    finally {
        if (active && ticket === generation)
            {busy.value = false; flushVisibleReads();}
    }
}
function startEdit() { const item = selected.value; if (!item)
    return; const ownsFocus = focusGuard(); draft.value = { title: item.title, topics: item.topics.join(', '), url: item.source.url || '' }; editing.value = true; void nextTick(() => {if (ownsFocus() && selectedId.value === item.id) titleInput.value?.focus();}); }
function cancelEdit() {if (busy.value) return; const id = selectedId.value, ownsFocus = focusGuard(); editing.value = false; void nextTick(() => {if (ownsFocus() && selectedId.value === id) organizeButton.value?.focus();});}
async function saveEdit() {
    const item = selected.value;
    if (!item) return;
    const ownsFocus = focusGuard();
    const submitted = { ...draft.value };
    const matchesSubmitted = (value: typeof submitted | undefined) => value?.title === submitted.title
        && value.topics === submitted.topics && value.url === submitted.url;
    const patch = { title: submitted.title, topics: submitted.topics.split(/[,，]/u).map(value => value.trim()).filter(Boolean), ...(item.kind === 'document' ? {} : { source: { ...item.source, url: submitted.url } }) };
    await mutate(() => materialUpdate(item.id, patch), updated => {
        if (updated) replace(updated);
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
    return; await mutate(() => materialArchive(item.id), () => { materials.value = materials.value.filter(value => value.id !== item.id); resetSelection(); feedback.value = '已移除材料，可在材料管理中恢复。原有收藏与问答仍保留。'; }); }
async function restoreSelected() { const item = selected.value; if (!item)
    return; await mutate(() => materialRestore(item.id), () => { materials.value = materials.value.filter(value => value.id !== item.id); resetSelection(); feedback.value = '材料已恢复，返回阅读材料即可继续。'; }); }
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
        return; return materialCapture({ source: item.source, reference, capturedAt, generation: storageGeneration, ...(referenceMode ? {referenceMode} : {}) }); }, updated => {
        if (updated) replace(updated);
        if (matchesSubmitted(noteDrafts.get(item.id))) noteDrafts.delete(item.id);
        if (selectedId.value === item.id && matchesSubmitted({ text: note.value, editingId: editingNoteId.value })) {
            note.value = '';
            editingNoteId.value = '';
        }
        feedback.value = '笔记已保存。';
    });
}
async function removeNote(reference: MaterialReference) { const item = selected.value; if (!item)
    return; await mutate(() => materialRemoveReference(item.id, reference.kind, reference.id), updated => { if (updated)
    replace(updated); if (editingNoteId.value === reference.id) {editingNoteId.value = ''; note.value = '';} feedback.value = '笔记已删除。'; }); }
async function clearMaterials() { await mutate(async () => { await materialClear(); }, () => { materials.value = []; resetSelection(); noteDrafts.clear(); materialDrafts.clear(); confirmClear.value = false; feedback.value = '全部材料已清空。'; }); }
async function exportMaterials() {
    if (busy.value)
        return;
    if (loading.value) pendingRefresh = true;
    busy.value = true;
    const ticket = ++generation;
    loading.value = false;
    error.value = '';
    backupWarning.value = '';
    try {
        const data = await materialExport();
        if (!active || ticket !== generation)
            return;
        const bytes = downloadTextFile(`fluentread-materials-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
        feedback.value = '材料备份已导出，包含来源、原句与个人笔记，请妥善保存。';
        if (bytes > MATERIAL_BACKUP_MAX_BYTES)
            backupWarning.value = '此备份超过 20 MB，当前版本无法恢复。请保留现有材料，并妥善保存备份文件。';
    }
    catch (failure) {
        if (active && ticket === generation)
            error.value = failure instanceof Error ? failure.message : '导出失败，请重试。';
    }
    finally {
        if (active && ticket === generation)
            {busy.value = false; flushVisibleReads();}
    }
}
async function importMaterials(event: Event) {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    input.value = '';
    if (!file || busy.value)
        return;
    if (file.size > MATERIAL_BACKUP_MAX_BYTES) {
        error.value = '材料备份超过 20 MB，请选择较小的备份文件。';
        return;
    }
    if (loading.value) pendingRefresh = true;
    busy.value = true;
    const ticket = ++generation;
    loading.value = false;
    error.value = '';
    const capturedAt = Date.now();
    try {
        const storageGeneration = await materialGeneration();
        if (!active || ticket !== generation)
            return;
        const text = await file.text();
        if (!active || ticket !== generation)
            return;
        const result = await materialImport(JSON.parse(text), { generation: storageGeneration, capturedAt });
        if (!active || ticket !== generation)
            return;
        const items = await materialList({ archived: archived.value });
        if (!active || ticket !== generation)
            return;
        materials.value = items;
        resetSelection();
        feedback.value = result.inserted + result.updated === 0 ? `没有恢复材料，跳过 ${result.skipped} 条无效、冲突或较旧的记录。` : `已恢复 ${result.inserted + result.updated} 份材料（新增 ${result.inserted} · 更新 ${result.updated} · 跳过 ${result.skipped}）。`;
    }
    catch (failure) {
        if (active && ticket === generation)
            error.value = failure instanceof SyntaxError ? '备份文件无法读取，请选择有效的材料 JSON 备份。' : failure instanceof Error ? failure.message : '恢复失败，请检查材料备份文件。';
    }
    finally {
        if (active && ticket === generation)
            {busy.value = false; flushVisibleReads();}
    }
}
const onChanged = (message: unknown): undefined => {
    if (active && typeof message === 'object' && message !== null && (message as {type?: string}).type === MATERIAL_CHANGED_MESSAGE) {
        pendingRefresh = true;
        flushVisibleReads();
    }
    return undefined;
};
watch(viewVisible, visible => {
    if (!active) return;
    if (visible) {flushVisibleReads(); return;}
    visibilityEpoch++;
    if (loading.value) pendingRefresh = true;
    loading.value = false;
    if (detailLoading.value) pendingReferences = Boolean(selected.value);
    detailGeneration++;
    detailLoading.value = false;
}, {flush: 'sync'});
onActivated(() => {keptAliveVisible.value = true;});
onDeactivated(() => {keptAliveVisible.value = false;});
onMounted(() => { void reload(); browser.runtime.onMessage.addListener(onChanged); });
onBeforeUnmount(() => { active = false; generation++; detailGeneration++; clearSearchMemo(); browser.runtime.onMessage.removeListener(onChanged); });
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

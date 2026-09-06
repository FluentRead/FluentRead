<!--
 * @file src/features/glossary/ui/GlossarySettings.vue
 * 文件职责：提供可直接上手的个人术语库设置，集中管理词库、适用语言、网站范围和固定译名。
 * 主要内容：支持内置主题词库添加、启停排序、词条搜索编辑、文件导入导出，以及使用真实领域解析器的本地匹配预览。
 * 模块边界：配置通过现有 requestConfigPatch 保存并在失败时回读权威状态；文件只在本地解析，界面不请求翻译服务、不改写宿主网页。
 -->
<template>
  <div class="fluentread-glossary" data-testid="glossary-settings" data-i18n-ignore>
    <FeatureEnableCard :model-value="enabled" :title="t('glossary.enable')" :description="t('glossary.intro')" :disabled="busy || !ready" @update:model-value="setEnabled" />
    <p class="glossary-help">{{ t('glossary.services') }}</p>
    <p v-if="error" class="glossary-error" role="alert">{{ error }}</p>
    <p class="glossary-save-state" role="status" aria-live="polite">{{ busy ? t('glossary.saving') : saved && !hasMetadataDraft ? t('glossary.saved') : '' }}</p>

    <BuiltinGlossaries :libraries="libraries" :enabled="enabled" :disabled="busy || !ready" @add="addBuiltin" />

    <div class="glossary-toolbar">
      <strong>{{ t('glossary.libraries') }} <small>{{ libraries.length }}/{{ GLOSSARY_LIMITS.libraries }}</small></strong>
      <div class="glossary-actions">
        <button type="button" :disabled="busy || !ready" @click="openImport">{{ t('glossary.import') }}</button>
        <button type="button" class="primary" :disabled="busy || !ready || libraries.length >= GLOSSARY_LIMITS.libraries" @click="addLibrary">{{ t('glossary.newLibrary') }}</button>
      </div>
    </div>
    <div v-if="!libraries.length" class="glossary-card glossary-empty">
      <span aria-hidden="true">Aa → 译</span><h3>{{ t('glossary.emptyTitle') }}</h3>
      <p>{{ t('glossary.emptyHelp') }}</p><code>large language model → 大语言模型<br />FluentRead → FluentRead</code>
    </div>
    <div v-else class="glossary-workbench">
      <aside class="glossary-card glossary-libraries" :aria-label="t('glossary.libraries')">
        <div v-for="(library, index) in libraries" :key="library.id" class="glossary-library-row" :class="{selected: selectedId === library.id}">
          <button type="button" class="glossary-library-name" :aria-pressed="selectedId === library.id" @click="selectLibrary(library.id)">
            <strong>{{ library.name }}</strong><small>{{ t('glossary.entryCount', {count: library.entries.length}) }} · {{ library.enabled ? t('glossary.on') : t('glossary.off') }}</small>
          </button>
          <div class="glossary-library-order">
            <button type="button" :aria-label="t('glossary.moveUp', {name: library.name})" :disabled="busy || index === 0" @click="moveLibrary(index, -1)">↑</button>
            <button type="button" :aria-label="t('glossary.moveDown', {name: library.name})" :disabled="busy || index === libraries.length - 1" @click="moveLibrary(index, 1)">↓</button>
          </div>
        </div>
        <p class="glossary-help">{{ t('glossary.priority') }}</p>
      </aside>
      <section v-if="selected" :key="`${selected.id}-${viewRevision}`" class="glossary-card glossary-editor" :aria-label="t('glossary.librarySettings')">
        <fieldset :disabled="!ready">
          <div class="glossary-metadata">
            <label class="glossary-wide">{{ t('glossary.name') }}<input :value="metadataValue('name')" :maxlength="GLOSSARY_LIMITS.nameLength" @input="editMetadata('name', $event)" @change="updateName" /></label>
            <label>{{ t('glossary.sourceLanguage') }}<ElSelect class="glossary-select"  :model-value="selected.sourceLanguage" :aria-label="t('glossary.sourceLanguage')" @change="updateLanguage('sourceLanguage', $event)">
              <ElOption value="" :label="t('glossary.anyLanguage')" /><ElOption v-for="item in languageOptions(selected.sourceLanguage)" :key="item.value" :value="item.value" :label="item.label" />
            </ElSelect></label>
            <label>{{ t('glossary.targetLanguage') }}<ElSelect class="glossary-select"  :model-value="selected.targetLanguage" :aria-label="t('glossary.targetLanguage')" @change="updateLanguage('targetLanguage', $event)">
              <ElOption value="" :label="t('glossary.anyLanguage')" /><ElOption v-for="item in languageOptions(selected.targetLanguage)" :key="item.value" :value="item.value" :label="item.label" />
            </ElSelect></label>
            <label class="glossary-wide">{{ t('glossary.domains') }}<textarea rows="2" :value="metadataValue('domains')" :aria-label="t('glossary.domains')" :placeholder="t('glossary.domainsPlaceholder')" @input="editMetadata('domains', $event)" @change="updateDomains" /><small>{{ t('glossary.domainsHelp') }}</small></label>
          </div>
          <div class="glossary-toolbar">
            <label class="glossary-check"><input type="checkbox" :checked="selected.enabled" @change="patchLibrary({enabled: ($event.target as HTMLInputElement).checked})" />{{ t('glossary.libraryEnabled') }}</label>
            <div class="glossary-actions"><ElSelect class="glossary-select"  v-model="exportFormat" :aria-label="t('glossary.exportFormat')"><ElOption label="CSV" :value="'CSV'" /><ElOption label="TSV" :value="'TSV'" /><ElOption label="JSON" :value="'JSON'" /></ElSelect><button type="button" @click="downloadLibrary">{{ t('glossary.export') }}</button><button type="button" class="danger" @click="deleteLibrary">{{ t('glossary.deleteLibrary') }}</button></div>
          </div>
        </fieldset>
        <div class="glossary-entry-toolbar">
          <input v-model="query" type="search" :aria-label="t('glossary.search')" :placeholder="t('glossary.search')" />
          <button type="button" :disabled="!ready || selected.entries.length >= GLOSSARY_LIMITS.entriesPerLibrary" @click="editEntry()">{{ t('glossary.addEntry') }}</button>
        </div>
        <form v-if="entryDraft" class="glossary-entry-form" @submit.prevent="saveEntry">
          <label>{{ t('glossary.source') }}<input v-model="entryDraft.source" required :maxlength="GLOSSARY_LIMITS.termLength" /></label>
          <label>{{ t('glossary.target') }}<input v-model="entryDraft.target" :maxlength="GLOSSARY_LIMITS.termLength" :placeholder="t('glossary.keepOriginal')" /></label>
          <label class="glossary-check"><input v-model="entryDraft.caseSensitive" type="checkbox" />{{ t('glossary.caseSensitive') }}</label>
          <small v-if="duplicateEntry" class="glossary-warning">{{ t('glossary.duplicateHelp') }}</small>
          <div class="glossary-actions"><button type="button" @click="entryDraft = null">{{ t('common.cancel') }}</button><button type="submit" class="primary" :disabled="busy">{{ t('common.save') }}</button></div>
        </form>
        <div class="glossary-table-scroll">
          <table class="glossary-table"><thead><tr><th>{{ t('glossary.source') }}</th><th>{{ t('glossary.target') }}</th><th>{{ t('glossary.actions') }}</th></tr></thead>
            <tbody><tr v-for="entry in visibleEntries" :key="entry.id"><td><span>{{ entry.source }}</span><small v-if="entry.caseSensitive">Aa</small></td><td>{{ entry.target || t('glossary.keepOriginal') }}</td><td><div class="glossary-actions"><button type="button" :disabled="busy" :aria-label="t('glossary.editNamed', {name: entry.source})" @click="editEntry(entry)">{{ t('glossary.edit') }}</button><button type="button" :disabled="busy" :aria-label="t('glossary.deleteNamed', {name: entry.source})" @click="deleteEntry(entry)">{{ t('glossary.delete') }}</button></div></td></tr>
            <tr v-if="!filteredEntries.length"><td colspan="3" class="glossary-no-results">{{ query ? t('glossary.noResults') : t('glossary.noEntries') }}</td></tr></tbody>
          </table>
        </div>
        <div v-if="filteredEntries.length > PAGE_SIZE" class="glossary-pagination"><button type="button" :aria-label="t('glossary.previousPage')" :disabled="entryPage === 0" @click="entryPage--">←</button><span>{{ entryPage + 1 }}/{{ Math.ceil(filteredEntries.length / PAGE_SIZE) }}</span><button type="button" :aria-label="t('glossary.nextPage')" :disabled="(entryPage + 1) * PAGE_SIZE >= filteredEntries.length" @click="entryPage++">→</button></div>
      </section>
    </div>

    <section class="glossary-card glossary-preview">
      <h3>{{ t('glossary.preview') }}</h3><p class="glossary-help">{{ t('glossary.previewHelp') }}</p>
      <label>{{ t('glossary.previewText') }}<textarea v-model="previewText" rows="3" placeholder="FluentRead uses a large language model." /></label>
      <div class="glossary-preview-context">
        <label>{{ t('glossary.sourceLanguage') }}<ElSelect class="glossary-select"  v-model="previewSource" :aria-label="t('glossary.sourceLanguage')"><ElOption value="" :label="t('glossary.autoLanguage')" /><ElOption v-for="item in languageOptions(previewSource)" :key="item.value" :value="item.value" :label="item.label" /></ElSelect></label>
        <label>{{ t('glossary.targetLanguage') }}<ElSelect class="glossary-select"  v-model="previewTarget" :aria-label="t('glossary.targetLanguage')"><ElOption v-for="item in languageOptions(previewTarget)" :key="item.value" :value="item.value" :label="item.label" /></ElSelect></label>
        <label>{{ t('glossary.previewUrl') }}<input v-model="previewUrl" type="url" placeholder="https://example.com/article" /></label>
      </div>
      <p v-if="!enabled" class="glossary-warning">{{ t('glossary.previewDisabled') }}</p>
      <p v-if="previewText && !preview.terms.length" class="glossary-help">{{ t('glossary.noMatches') }}</p>
      <div v-if="preview.terms.length" class="glossary-matches" data-testid="glossary-matches"><span v-for="term in preview.terms" :key="term.source">{{ term.source }} → {{ term.target }}</span></div>
      <div v-if="preview.conflicts.length" class="glossary-warning" role="status"><strong>{{ t('glossary.conflicts') }}</strong><p v-for="(conflict, index) in preview.conflicts" :key="index">{{ t('glossary.conflict', {source: conflict.source, kept: conflict.keptTarget, ignored: conflict.ignoredTarget}) }}</p></div>
    </section>

    <el-dialog v-model="importOpen" :title="t('glossary.import')" width="min(720px, calc(100vw - 28px))" :close-on-click-modal="false" class="glossary-import-dialog">
      <div class="fluentread-glossary" data-i18n-ignore>
        <p class="glossary-help">{{ t('glossary.importHelp') }}</p>
        <label>{{ t('glossary.file') }}<input type="file" accept=".csv,.tsv,.json,text/csv,text/tab-separated-values,application/json" @change="readImportFile" /></label>
        <label>{{ t('glossary.format') }}<ElSelect class="glossary-select"  v-model="importFormat" :aria-label="t('glossary.format')" @change="invalidateFileRead"><ElOption value="csv" label="CSV" /><ElOption value="tsv" label="TSV" /><ElOption value="json" label="JSON" /></ElSelect></label>
        <label>{{ t('glossary.importText') }}<textarea v-model="importText" rows="6" placeholder="source,target,tgt_lng&#10;large language model,大语言模型,zh-Hans" @input="invalidateFileRead" /></label>
        <p v-if="fileError" class="glossary-error" role="alert">{{ fileError }}</p>
        <template v-if="importText.trim()">
          <p role="status">{{ t('glossary.importSummary', {total: importPreview.totalEntries, accepted: importPreview.acceptedEntries, libraries: importPreview.libraries.length}) }}</p>
          <div v-for="(message, index) in importErrors" :key="`error-${index}`" class="glossary-error" role="alert">{{ message }}</div>
          <div v-for="(message, index) in importPreview.warnings" :key="`warning-${index}`" class="glossary-warning">{{ message }}</div>
          <div class="glossary-import-preview"><details v-for="library in importPreview.libraries" :key="library.id" open><summary>{{ library.name }} · {{ t('glossary.entryCount', {count: library.entries.length}) }}</summary><p v-for="entry in library.entries" :key="entry.id">{{ entry.source }} → {{ entry.target || t('glossary.keepOriginal') }}</p></details></div>
          <label v-if="importPreview.warnings.length" class="glossary-check"><input v-model="acceptWarnings" type="checkbox" />{{ t('glossary.acceptWarnings') }}</label>
        </template>
        <div class="glossary-actions glossary-dialog-actions"><button type="button" @click="importOpen = false">{{ t('common.cancel') }}</button><button type="button" class="primary" :disabled="!canImport || busy" @click="confirmImport">{{ t('glossary.confirmImport') }}</button></div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import ElSelect from '@/src/ui/components/UiSelect.vue';
import {ElOption} from 'element-plus';
import 'element-plus/es/components/select/style/css';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import {computed, onBeforeUnmount, ref, watch} from 'vue';
import {ElMessageBox} from 'element-plus';
import browser from 'webextension-polyfill';
import {config, configReady, requestConfigPatch, subscribeConfig} from '@/src/services/config/store';
import {getMultilingualTargetLanguageLabel, options} from '@/src/core/config/catalog';
import {GLOSSARY_LIMITS, createGlossaryEntry, createGlossaryLibrary, normalizeGlossaryDomain,
  normalizeGlossaryLibraries, resolveGlossary, parseGlossaryImport, exportGlossary,
  type GlossaryEntry, type GlossaryLibrary, type GlossaryImportFormat} from '@/src/core/glossary';
import {useUiI18n} from '@/src/ui/i18n';
import {addBuiltinGlossary, BUILTIN_GLOSSARIES} from '@/src/core/glossary/builtins';
import BuiltinGlossaries from './BuiltinGlossaries.vue';

const {t, language} = useUiI18n();
const libraries = ref<GlossaryLibrary[]>([]);
const enabled = ref(false);
const selectedId = ref('');
const ready = ref(false);
const busy = ref(false);
const saved = ref(false);
const error = ref('');
const viewRevision = ref(0);
const query = ref('');
const entryPage = ref(0);
const PAGE_SIZE = 30;
const entryDraft = ref<GlossaryEntry | null>(null);
type MetadataTextField = 'name' | 'domains';
const metadataDrafts = ref<Partial<Record<MetadataTextField, {libraryId: string; value: string}>>>({});
const hasMetadataDraft = computed(() => Object.keys(metadataDrafts.value).length > 0);
const exportFormat = ref('CSV');
let disposed = false;
let pendingSaves = 0;
let saveQueue: Promise<unknown> = Promise.resolve();
let fileReadGeneration = 0;
const selected = computed(() => libraries.value.find(item => item.id === selectedId.value));
const filteredEntries = computed(() => (selected.value?.entries || []).filter(entry => `${entry.source}\n${entry.target}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
const visibleEntries = computed(() => filteredEntries.value.slice(entryPage.value * PAGE_SIZE, (entryPage.value + 1) * PAGE_SIZE));
const duplicateEntry = computed(() => entryDraft.value && selected.value?.entries.some(entry => entry.id !== entryDraft.value!.id && entry.source.toLowerCase() === entryDraft.value!.source.trim().toLowerCase()));
watch([query, selectedId, () => filteredEntries.value.length], () => {entryPage.value = 0;});

function hydrate(next = config): void {
  const previousId = selectedId.value;
  libraries.value = normalizeGlossaryLibraries(next.glossaryLibraries);
  enabled.value = next.glossaryEnabled;
  if (!libraries.value.some(item => item.id === selectedId.value)) selectedId.value = libraries.value[0]?.id || '';
  if (selectedId.value !== previousId) metadataDrafts.value = {};
}
const unsubscribe = subscribeConfig(next => {if (!disposed) hydrate(next);});
void configReady.then(() => {if (!disposed) {hydrate(); ready.value = true;}}).catch(() => {if (!disposed) error.value = t('glossary.loadFailed');});
onBeforeUnmount(() => {disposed = true; fileReadGeneration++; unsubscribe();});

type GlossaryPatch = {glossaryLibraries?: GlossaryLibrary[]; glossaryEnabled?: boolean};
function persist(patch: GlossaryPatch | (() => GlossaryPatch)): Promise<boolean> {
  if (!ready.value) {error.value = t('glossary.loadFailed'); return Promise.resolve(false);}
  pendingSaves++; busy.value = true; error.value = ''; saved.value = false;
  const operation = saveQueue.then(async () => {
    try {
      await requestConfigPatch(typeof patch === 'function' ? patch() : patch, browser.runtime.sendMessage.bind(browser.runtime));
      if (!disposed) {hydrate(); saved.value = true;}
      return true;
    } catch {
      if (!disposed) {hydrate(); saved.value = false; viewRevision.value++; error.value = t('glossary.saveFailed');}
      return false;
    } finally {pendingSaves--; if (!disposed) busy.value = pendingSaves > 0;}
  });
  saveQueue = operation;
  return operation;
}
function setEnabled(value: boolean): void {void persist({glossaryEnabled: value});}
function selectLibrary(id: string): void {selectedId.value = id; entryDraft.value = null; metadataDrafts.value = {}; query.value = '';}
async function addLibrary(): Promise<void> {
  const library = createGlossaryLibrary(libraries.value);
  library.name = t('glossary.newName');
  if (await persist({glossaryLibraries: [...libraries.value, library]})) selectLibrary(library.id);
}
async function addBuiltin(id: string): Promise<void> {
  if (busy.value || !ready.value) return;
  const preset = BUILTIN_GLOSSARIES.find(item => item.id === id);
  if (!preset) return;
  const result = addBuiltinGlossary(id, libraries.value, t(preset.nameKey));
  if (result.status === 'capacity') {error.value = t('glossary.capacity'); return;}
  if (result.status === 'existing') {selectLibrary(result.library.id); return;}
  if (result.status === 'added' && await persist({glossaryLibraries: result.libraries})) selectLibrary(result.library.id);
}
async function patchLibrary(patch: Partial<GlossaryLibrary>): Promise<boolean> {
  if (!selected.value) return false;
  const libraryId = selectedId.value;
  return persist(() => ({glossaryLibraries: libraries.value.map(item => item.id === libraryId ? {...item, ...patch} : item)}));
}
function updateName(event: Event): void {
  editMetadata('name', event);
  const name = (event.target as HTMLInputElement).value.trim();
  if (!name) {error.value = t('glossary.nameRequired'); viewRevision.value++; return;}
  void saveMetadata('name', {name});
}
function updateLanguage(field: 'sourceLanguage' | 'targetLanguage', value: string): void {void patchLibrary({[field]: value});}
function updateDomains(event: Event): void {
  editMetadata('domains', event);
  const values = (event.target as HTMLTextAreaElement).value.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  const domains = values.map(normalizeGlossaryDomain);
  if (domains.some(value => !value) || domains.length > GLOSSARY_LIMITS.domainsPerLibrary) {error.value = t('glossary.invalidDomains'); return;}
  void saveMetadata('domains', {domains: [...new Set(domains as string[])]});
}
function metadataValue(field: MetadataTextField): string {
  const draft = metadataDrafts.value[field];
  if (draft?.libraryId === selectedId.value) return draft.value;
  return field === 'name' ? selected.value?.name || '' : selected.value?.domains.join('\n') || '';
}
function editMetadata(field: MetadataTextField, event: Event): void {
  if (!selected.value) return;
  metadataDrafts.value[field] = {libraryId: selectedId.value, value: (event.target as HTMLInputElement | HTMLTextAreaElement).value};
}
async function saveMetadata(field: MetadataTextField, patch: Partial<GlossaryLibrary>): Promise<void> {
  const draft = metadataDrafts.value[field];
  if (!draft || draft.libraryId !== selectedId.value) return;
  // 输入即归本地草稿所有，但仍只在 change 时保存；旧回执不能覆盖继续输入的值。
  await patchLibrary(patch);
  if (metadataDrafts.value[field] === draft) delete metadataDrafts.value[field];
}
function languageOptions(current: string): {value: string; label: string}[] {
  const values = [...new Map([...options.to, {value: 'de', label: 'Deutsch'}, {value: 'pt', label: 'Português'}, {value: 'it', label: 'Italiano'}].map(item => [item.value.toLowerCase(), {value: item.value.toLowerCase(), label: getMultilingualTargetLanguageLabel(item.value, item.label, language.value)}])).values()];
  if (current && !values.some(item => item.value === current)) values.push({value: current, label: current});
  return values;
}
function moveLibrary(index: number, direction: number): void {
  const next = [...libraries.value];
  [next[index], next[index + direction]] = [next[index + direction], next[index]];
  void persist({glossaryLibraries: next});
}
async function confirmDeletion(name: string): Promise<boolean> {
  try {await ElMessageBox.confirm(t('glossary.deleteConfirm', {name}), t('glossary.delete'), {confirmButtonText: t('glossary.delete'), cancelButtonText: t('common.cancel'), type: 'warning'}); return true;} catch {return false;}
}
async function deleteLibrary(): Promise<void> {
  const library = selected.value;
  if (library && await confirmDeletion(library.name)) await persist(() => ({glossaryLibraries: libraries.value.filter(item => item.id !== library.id)}));
}
function editEntry(entry?: GlossaryEntry): void {entryDraft.value = entry ? {...entry} : createGlossaryEntry(selected.value?.entries || []);}
async function saveEntry(): Promise<void> {
  const library = selected.value; const draft = entryDraft.value;
  if (!library || !draft) return;
  const submittedDraft = {...draft};
  const source = submittedDraft.source.trim();
  if (!source) {error.value = t('glossary.sourceRequired'); return;}
  const entry = {...submittedDraft, source, target: submittedDraft.target.trim()};
  const existing = library.entries.some(item => item.id === entry.id);
  const entries = existing ? library.entries.map(item => item.id === entry.id ? entry : item) : [...library.entries, entry];
  if (entries.length > GLOSSARY_LIMITS.entriesPerLibrary || libraries.value.reduce((total, item) => total + (item.id === library.id ? entries.length : item.entries.length), 0) > GLOSSARY_LIMITS.totalEntries) {error.value = t('glossary.capacity'); return;}
  // 保存期间仍可继续编辑；旧回执只能清空内容未变化的同一份草稿。
  if (await patchLibrary({entries}) && entryDraft.value === draft
    && draft.id === submittedDraft.id && draft.source === submittedDraft.source
    && draft.target === submittedDraft.target && draft.caseSensitive === submittedDraft.caseSensitive) entryDraft.value = null;
}
async function deleteEntry(entry: GlossaryEntry): Promise<void> {
  const libraryId = selected.value?.id;
  if (libraryId && await confirmDeletion(entry.source)) await persist(() => ({glossaryLibraries: libraries.value.map(library => library.id === libraryId ? {...library, entries: library.entries.filter(item => item.id !== entry.id)} : library)}));
}
function downloadLibrary(): void {
  if (!selected.value) return;
  const format = exportFormat.value.toLowerCase() as GlossaryImportFormat;
  const mime = format === 'json' ? 'application/json' : format === 'tsv' ? 'text/tab-separated-values' : 'text/csv';
  const url = URL.createObjectURL(new Blob([exportGlossary(selected.value, format)], {type: `${mime};charset=utf-8`}));
  const anchor = document.createElement('a'); anchor.href = url;
  anchor.download = `${selected.value.name.replace(/[\\/:*?"<>|]/gu, '_')}.${format}`;
  anchor.click(); URL.revokeObjectURL(url);
}

const previewText = ref('');
const previewSource = ref('en');
const previewTarget = ref(config.to.toLowerCase());
const previewUrl = ref('');
const preview = computed(() => resolveGlossary(libraries.value, {text: previewText.value, sourceLanguage: previewSource.value, targetLanguage: previewTarget.value, pageUrl: previewUrl.value}));

const importOpen = ref(false);
const importText = ref('');
const importFormat = ref<GlossaryImportFormat>('csv');
const acceptWarnings = ref(false);
const fileError = ref('');
const importPreview = computed(() => parseGlossaryImport(importText.value, importFormat.value));
const importErrors = computed(() => {
  const result = [...importPreview.value.errors];
  if (libraries.value.length + importPreview.value.libraries.length > GLOSSARY_LIMITS.libraries || libraries.value.reduce((total, library) => total + library.entries.length, 0) + importPreview.value.acceptedEntries > GLOSSARY_LIMITS.totalEntries) result.push(t('glossary.capacity'));
  return result;
});
const canImport = computed(() => Boolean(importText.value.trim()) && !fileError.value && !importErrors.value.length && importPreview.value.acceptedEntries > 0 && (!importPreview.value.warnings.length || acceptWarnings.value));
watch([importText, importFormat], () => {acceptWarnings.value = false;});
watch(importOpen, () => {fileReadGeneration++;});
function invalidateFileRead(): void {fileReadGeneration++; fileError.value = '';}
function openImport(): void {fileReadGeneration++; importText.value = ''; fileError.value = ''; acceptWarnings.value = false; importOpen.value = true;}
async function readImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
  const generation = ++fileReadGeneration;
  importText.value = ''; fileError.value = '';
  if (file.size > GLOSSARY_LIMITS.importBytes) {fileError.value = t('glossary.fileTooLarge'); input.value = ''; return;}
  importFormat.value = file.name.toLowerCase().endsWith('.json') ? 'json' : file.name.toLowerCase().endsWith('.tsv') ? 'tsv' : 'csv';
  try {const text = await file.text(); if (!disposed && importOpen.value && generation === fileReadGeneration) importText.value = text;}
  catch {if (!disposed && importOpen.value && generation === fileReadGeneration) fileError.value = t('glossary.fileFailed');}
  if (!disposed && generation === fileReadGeneration) input.value = '';
}
async function confirmImport(): Promise<void> {
  if (!canImport.value) return;
  const next = [...libraries.value];
  let firstId = '';
  for (const imported of importPreview.value.libraries) {
    const library = {...imported, id: createGlossaryLibrary(next).id};
    firstId ||= library.id; next.push(library);
  }
  if (await persist({glossaryLibraries: next})) {selectLibrary(firstId); importOpen.value = false;}
}
</script>

<style scoped src="./glossary-settings.css"></style>

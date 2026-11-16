<!--
 * @file src/features/settings/ui/DictionaryWorkspaceSettings.vue
 * 文件职责：在划词设置中集中管理词典配方、离线导入和双面学习卡模板。
 * 主要内容：紧凑来源列表、无代码 JSON 字段映射、脚本转换编辑、可取消的 Worker 导入及本地 Anki 字段设置。
 * 模块边界：只修改父级配置草稿；来源测试通过既有后台消息，文件索引由隔离 Worker 处理，不在 UI 请求供应商。
 -->
<template>
  <details class="dictionary-settings" data-i18n-ignore data-testid="dictionary-workspace">
    <summary>{{ t('dictionary.title') }}</summary>
    <div class="dictionary-body">
      <h3>{{ t('dictionary.sources') }}</h3>
      <p v-if="!workspace.recipes.length" class="dictionary-note">{{ t('dictionary.empty') }}</p>
      <div v-for="recipe in workspace.recipes" :key="recipe.id" class="dictionary-source-row">
        <span>{{ recipe.name }}<small>{{ recipe.kind === 'local' ? t('dictionary.local') : recipe.kind === 'iframe' ? t('dictionary.web') : recipe.kind === 'script' ? 'JavaScript' : 'JSON API' }}</small></span>
        <button v-if="recipe.kind !== 'local'" type="button" @click="edit(recipe)">{{ t('dictionary.edit') }}</button>
        <button type="button" :disabled="busy" @click="remove(recipe)">{{ t('dictionary.remove') }}</button>
      </div>
      <div class="dictionary-actions">
        <button type="button" :disabled="busy" @click="edit()">{{ t('dictionary.add') }}</button>
        <button type="button" :disabled="busy" @click="recipeInput?.click()">{{ t('dictionary.import') }}</button>
        <button type="button" :disabled="!workspace.recipes.some(item => item.kind !== 'local')" @click="exportRecipes">{{ t('dictionary.export') }}</button>
        <button type="button" :disabled="busy" @click="dictionaryInput?.click()">{{ t('dictionary.offline') }}</button>
      </div>
      <input ref="recipeInput" type="file" accept=".json" hidden @change="importRecipes">
      <input ref="dictionaryInput" type="file" accept=".mdx,.mdd,.ifo,.idx,.dict,.dz,.gz,.dsl,.zip,.css,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp3,.ogg,.wav,.woff,.woff2" multiple hidden @change="importOffline">
      <p class="dictionary-note">{{ t('dictionary.offlineHelp') }}</p>
      <p v-if="busy" role="status">{{ t('dictionary.importing') }} <button type="button" @click="cancelImport">{{ t('dictionary.cancel') }}</button></p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <form v-if="draft" class="dictionary-editor" @submit.prevent="save">
        <label>{{ t('dictionary.name') }}<input v-model="draft.name" maxlength="80" required></label>
        <label>{{ t('dictionary.kind') }}<select v-model="draft.kind"><option value="json">JSON API</option><option value="iframe">{{ t('dictionary.web') }}</option><option value="script">JavaScript</option></select></label>
        <label class="dictionary-wide">{{ t('dictionary.url') }}<input v-model="draft.url" required maxlength="2048" placeholder="https://api.example.com/dictionary/{{word}}" spellcheck="false"></label>
        <p class="dictionary-note dictionary-wide">{{ t('dictionary.urlHelp', {word: wordPlaceholder}) }}</p>
        <template v-if="draft.kind !== 'iframe'">
          <fieldset class="dictionary-wide dictionary-mapping"><legend>{{ t('dictionary.mapping') }}</legend>
            <label v-for="field in DICTIONARY_FIELDS" :key="field">{{ t(`dictionary.${field}`) }}<input v-model="draft.fields[field]" maxlength="256" :placeholder="field === 'definition' ? 'data[0].definition' : ''" spellcheck="false"></label>
          </fieldset>
          <p class="dictionary-note dictionary-wide">{{ t('dictionary.mappingHelp') }}</p>
          <label class="dictionary-wide">{{ t('dictionary.headers') }}<textarea v-model="headers" rows="2" spellcheck="false" placeholder='{"Authorization":"Bearer …"}' /></label>
        </template>
        <template v-if="draft.kind === 'script'">
          <label class="dictionary-wide">JavaScript<textarea v-model="draft.script" rows="5" maxlength="16384" spellcheck="false" /></label>
          <p class="dictionary-note dictionary-wide">{{ t('dictionary.scriptHelp') }}</p>
        </template>
        <div class="dictionary-actions dictionary-wide"><button type="submit">{{ t('dictionary.save') }}</button><button type="button" @click="draft = null">{{ t('dictionary.cancel') }}</button></div>
      </form>
      <details class="dictionary-templates"><summary>{{ t('dictionary.templates') }}</summary>
        <div class="dictionary-grid"><label>{{ t('dictionary.front') }}<textarea v-model="workspace.front" maxlength="16384" rows="3" spellcheck="false" /></label><label>{{ t('dictionary.back') }}<textarea v-model="workspace.back" maxlength="16384" rows="3" spellcheck="false" /></label></div>
        <p class="dictionary-variables" v-text="'{{word}} · {{phonetic}} · {{definition}} · {{example}} · {{audio}} · {{etymology}} · {{inflections}} · {{ai_explanation}} · {{context_sentence}} · {{source}} · {{source_url}}'" />
        <details><summary>AnkiConnect</summary><div class="dictionary-grid">
          <label>URL<input v-model="workspace.anki.url" placeholder="http://127.0.0.1:8765" spellcheck="false"></label>
          <label v-for="field in ankiFields" :key="field">{{ t(`dictionary.${field}`) }}<input v-model="workspace.anki[field]" maxlength="120"></label>
        </div></details>
      </details>
      <p class="dictionary-note">{{ t('dictionary.shareHelp') }}</p>
    </div>
  </details>
</template>
<script setup lang="ts">
import {computed, onBeforeUnmount, ref} from 'vue';
import {ElMessageBox} from 'element-plus';
import type {Config} from '@/src/core/config/model';
import {DICTIONARY_FIELDS, EMPTY_DICTIONARY_FIELDS, validateDictionaryRecipe, importDictionaryRecipes, exportDictionaryRecipes, type DictionaryRecipe} from '@/src/core/config/dictionaryWorkspace';
import {dictionaryPath} from '@/src/features/selection-translation/dictionary/public';
import {downloadTextFile} from '@/src/shared/dom/downloadTextFile';
import {useUiI18n} from '@/src/ui/i18n';
const {t} = useUiI18n();
const props = defineProps<{config: Config}>();
const workspace = computed(() => props.config.selectionDictionaryWorkspace);
const draft = ref<DictionaryRecipe | null>(null), headers = ref('{}'), notice = ref(''), busy = ref(false);
const recipeInput = ref<HTMLInputElement>(), dictionaryInput = ref<HTMLInputElement>();
const ankiFields = ['deck', 'model', 'frontField', 'backField'] as const;
const wordPlaceholder = '{{word}}';
let worker: Worker | null = null;
let disposed = false;
function edit(recipe?: DictionaryRecipe): void {
  draft.value = recipe ? JSON.parse(JSON.stringify(recipe)) : {id: crypto.randomUUID(), name: '', kind: 'json', url: '', headers: {}, fields: {...EMPTY_DICTIONARY_FIELDS, definition: 'definition'}, script: 'return {definition: data.definition};', localId: ''};
  headers.value = recipe ? props.config.customHeaders[`dictionary:${recipe.id}`] || JSON.stringify(recipe.headers, null, 2) : '{}'; notice.value = '';
}
function save(): void {
  try {
    const recipe = validateDictionaryRecipe({...draft.value, headers: JSON.parse(headers.value)});
    for (const path of Object.values(recipe.fields)) if (path) dictionaryPath({}, path);
    const recipes = workspace.value.recipes.filter(item => item.id !== recipe.id);
    if (recipes.length >= 32) throw new Error('Too many dictionary sources');
    props.config.customHeaders[`dictionary:${recipe.id}`] = JSON.stringify(recipe.headers);
    workspace.value.recipes = [...recipes, {...recipe, headers: {}}]; workspace.value.revision = Date.now(); draft.value = null; notice.value = '';
  } catch {notice.value = t('dictionary.invalid');}
}
async function remove(recipe: DictionaryRecipe): Promise<void> {
  try {await ElMessageBox.confirm(recipe.name, t('dictionary.remove'), {confirmButtonText: t('dictionary.remove'), cancelButtonText: t('dictionary.cancel'), type: 'warning'});}
  catch {return;}
  if (disposed) return;
  try {
    if (recipe.kind === 'local') {
      const {DictionaryRepository} = await import('@/src/platform/storage/dictionaryRepository');
      const database = new DictionaryRepository();
      try {await database.remove(recipe.localId);} finally {database.close();}
    }
    workspace.value.recipes = workspace.value.recipes.filter(item => item.id !== recipe.id);
    delete props.config.customHeaders[`dictionary:${recipe.id}`];
    if (props.config.selectionDictionaryRecipe === recipe.id) props.config.selectionDictionaryRecipe = '';
    if (draft.value?.id === recipe.id) draft.value = null;
  } catch {notice.value = t('dictionary.importError');}
}
async function importRecipes(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Recipe file is too large');
    const recipes = importDictionaryRecipes(await file.text());
    if (disposed) return;
    const ids = new Set(workspace.value.recipes.map(item => item.id));
    const additions = recipes.filter(recipe => !ids.has(recipe.id));
    if (workspace.value.recipes.length + additions.length > 32) throw new Error('Too many dictionary sources');
    for (const recipe of additions) props.config.customHeaders[`dictionary:${recipe.id}`] = JSON.stringify(recipe.headers);
    workspace.value.recipes = [...workspace.value.recipes, ...additions.map(recipe => ({...recipe, headers: {}}))]; notice.value = t('dictionary.imported');
  } catch {notice.value = t('dictionary.importError');}
}
function exportRecipes(): void {
  try {downloadTextFile('FluentRead-dictionary-recipes.json', exportDictionaryRecipes(workspace.value.recipes), 'application/json');}
  catch {notice.value = t('dictionary.exportError');}
}
function cancelImport(): void {worker?.terminate(); worker = null; busy.value = false;}
function importOffline(event: Event): void {
  const input = event.target as HTMLInputElement; const files = Array.from(input.files || []); input.value = '';
  if (!files.length || busy.value) return;
  if (files.reduce((sum, file) => sum + file.size, 0) > 128 * 1024 * 1024 || workspace.value.recipes.length >= 32) {notice.value = t('dictionary.importError'); return;}
  busy.value = true; notice.value = '';
  try {
    const id = crypto.randomUUID();
    worker = new Worker(new URL('../../selection-translation/dictionary/importWorker.ts', import.meta.url), {type: 'module'});
    worker.onmessage = event => {
      const result = event.data as {success?: boolean; data?: {name: string}; error?: string};
      cancelImport();
      if (disposed) return;
      if (!result.success || !result.data) {notice.value = `${t('dictionary.importError')} ${result.error || ''}`; return;}
      workspace.value.recipes = [...workspace.value.recipes, {id, name: result.data.name, kind: 'local', url: '', headers: {}, fields: {...EMPTY_DICTIONARY_FIELDS}, script: '', localId: id}];
      notice.value = t('dictionary.imported');
    };
    worker.onerror = () => {cancelImport(); if (!disposed) notice.value = t('dictionary.importError');};
    worker.postMessage({id, files});
  } catch {cancelImport(); notice.value = t('dictionary.importError');}
}
onBeforeUnmount(() => {disposed = true; cancelImport();});
</script>
<style scoped>
.dictionary-settings{margin-top:12px;font-size:12px;color:var(--ink)}summary{cursor:pointer;padding:8px 0;font-weight:600}.dictionary-body{padding:4px 16px 8px}h3{font-size:12px;margin:10px 0}.dictionary-source-row{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 0;border-bottom:1px solid var(--line)}.dictionary-source-row>span{flex:1;min-width:0;overflow-wrap:anywhere}small{margin-left:8px;color:var(--muted);font-size:10px}.dictionary-actions{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}button{font:inherit;cursor:pointer;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)}button:disabled{opacity:.5;cursor:default}.dictionary-note{font-size:11px;line-height:1.7;color:var(--muted);margin:8px 0}.dictionary-editor,.dictionary-grid,.dictionary-mapping{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 0}.dictionary-wide{grid-column:1/-1}label{display:flex;flex-direction:column;gap:6px;min-width:0}input,textarea,select{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--line);border-radius:6px;padding:7px 9px;background:var(--surface);color:var(--ink);font:inherit}textarea{resize:vertical;line-height:1.6}.dictionary-mapping{padding:12px;border:1px solid var(--line);border-radius:8px}.dictionary-variables{font:11px/1.8 monospace;color:var(--muted);overflow-wrap:anywhere}button:focus-visible,summary:focus-visible{outline:2px solid var(--brand);outline-offset:2px}@media(max-width:540px){.dictionary-editor,.dictionary-grid,.dictionary-mapping{grid-template-columns:1fr}}
@media(any-pointer:coarse){button,input,select,summary{min-height:44px;box-sizing:border-box}}
</style>

<!--
 * @file src/features/settings/ui/SiteAdaptationSettings.vue
 * 文件职责：提供易发现、可解释、可扩展的正文适配规则工作区。
 * 主要内容：使用统一的下拉选择器保持控件与菜单风格一致；独立标题分隔栏与启用控制行，目录与详情并排展示，单次确认保存可视化规则；JSON 与备份按需展开，保留冲突保护、合并导入、草稿撤销与离页提醒。
 * 模块边界：复用规则包与严格校验，保存等待后台确认；不请求网址、不执行规则代码，不将草稿误当作生效配置。
 -->
<template>
  <div class="rule-workspace" data-setting="site-adaptation">
    <section class="rule-card" aria-labelledby="site-adaptation-heading">
      <header class="rule-section-heading settings-card-heading">
        <h2 id="site-adaptation-heading">{{ tr('正文适配') }}</h2><p>{{ tr('选择要翻译和保留原文的区域') }}</p>
      </header>
      <div class="rule-toggle-row">
        <span>{{ tr('启用网站适配') }}</span>
        <el-switch :model-value="modelValue.enabled" :disabled="saving" :aria-label="tr('启用网站适配')" @update:model-value="setEnabled(Boolean($event))" />
      </div>
      <p v-if="!modelValue.enabled" class="rule-notice">{{ tr('正文适配已关闭，规则仍保留；网页使用通用正文识别') }}</p>
      <div v-if="(isDirty || saving) && !form" class="draft-bar" role="status"><span>{{ tr(saving ? '正在保存，等待后台确认' : '草稿未保存，网页仍使用已保存规则') }}</span><button type="button" class="rule-primary" :disabled="saving || !!form || draftConflict" :aria-busy="saving" @click="saveDraft">{{ tr(saving ? '正在保存' : '保存并应用') }}</button></div>
      <p v-if="draftConflict" class="rule-error" role="alert">{{ tr('已保存规则在其他页面发生变化。草稿已保留，请先导出或复制草稿，再恢复最新配置并重新合并。') }}</p>
      <p v-if="downloadError" class="rule-error" role="alert">{{ t('siteAdaptation.exportFailed') }}</p>
      <div v-if="!form" class="catalog-toolbar">
        <label class="rule-field"><span class="sr-only">{{ tr('搜索网站规则') }}</span><input v-model="search" type="search" :aria-label="tr('搜索网站规则')" :placeholder="tr('输入网站名称、域名或规则标识')" @input="visibleLimit = 30" /></label>
        <button type="button" class="rule-primary" :disabled="saving || !!form" @click="startForm()">{{ tr('新建规则') }}</button>
      </div>
      <div v-if="!form" class="catalog-filters" role="group" :aria-label="tr('筛选网站规则')">
        <button v-for="option in filters" :key="option.id" type="button" :aria-pressed="filter === option.id" :class="{'is-active': filter === option.id}" @click="filter = option.id; visibleLimit = 30">{{ tr(option.label) }} <span>{{ option.count }}</span></button>
      </div>
      <form v-if="form" ref="formArea" class="visual-editor" data-rule-form @submit.prevent="saveForm">
        <fieldset :disabled="saving">
          <header class="rule-heading settings-card-heading"><div class="settings-card-heading-copy"><h3>{{ tr(editingId ? '编辑规则' : '新建规则') }}</h3><p>{{ tr('每行填写一项，保存后应用到网页') }}</p></div><button type="button" :disabled="saving" @click="cancelForm">{{ tr('取消编辑') }}</button></header>
          <p v-if="formConflict" class="rule-error" role="alert">{{ tr('规则已从其他页面更新，请关闭编辑器后重新打开，避免覆盖新配置') }}</p>
          <h4>{{ tr('匹配网站') }}</h4>
          <div class="rule-columns">
            <label class="rule-field"><span>{{ tr('规则名称') }}</span><input v-model="form.name" data-i18n-ignore :aria-label="tr('规则名称')" maxlength="160" :placeholder="tr('例如：我的技术博客')" /></label>
            <label class="rule-field"><span>{{ tr('匹配域名') }}</span><textarea v-model="form.hosts" data-i18n-ignore rows="3" :aria-label="tr('匹配域名')" placeholder="example.com&#10;*.example.com" /><small class="rule-hint">{{ tr('不含协议或路径；*.example.com 包含主域和子域') }}</small></label>
            <label class="rule-field"><span>{{ tr('匹配路径（可选）') }}</span><textarea v-model="form.paths" data-i18n-ignore rows="2" :aria-label="tr('匹配路径（可选）')" placeholder="/articles/*" /></label>
          </div>
          <h4 class="form-section-heading">{{ tr('翻译范围') }}</h4>
          <div class="recognition-modes" role="radiogroup" :aria-label="tr('识别模式')">
            <label :class="{'is-active': form.mode === 'augment'}"><input v-model="form.mode" type="radio" name="site-rule-recognition-mode" value="augment" />{{ tr('补充识别：在通用正文上增加指定区域') }}</label>
            <label :class="{'is-active': form.mode === 'focus'}"><input v-model="form.mode" type="radio" name="site-rule-recognition-mode" value="focus" />{{ tr('限定范围：只翻译指定的正文区域') }}</label>
          </div>
          <section class="content-editor"><h4>{{ tr('正文区域') }}</h4><p class="rule-hint">{{ tr('建议指定标题、段落或列表项，如 article h1、article p；限定范围模式至少需填写一个区域') }}</p>
            <div v-for="(content, index) in form.content" :key="index" class="content-row">
              <label class="rule-field"><span>{{ tr('CSS 选择器') }} {{ index + 1 }}</span><textarea v-model="content.css" data-i18n-ignore rows="3" :aria-label="tr('正文 CSS 选择器') + ' ' + (index + 1)" placeholder="article h1&#10;article p&#10;article li" /></label>
              <div class="rule-actions"><label><input v-model="content.atomic" type="checkbox" /> {{ tr('将选中节点作为整体翻译') }}</label><button type="button" :aria-label="tr('移除正文区域') + ' ' + (index + 1)" @click="form.content.splice(index, 1)">{{ tr('移除') }}</button></div>
              <details><summary>{{ tr('区域高级选项') }}</summary><label class="rule-field"><span>{{ tr('节点解析') }}</span><UiSelect :aria-label="tr('节点解析')" v-model="content.resolve"><el-option value="self" :label="tr('使用选中节点')" /><el-option value="closest" :label="tr('使用最近的匹配祖先')" /></UiSelect></label><label><input v-model="content.splitOnBr" type="checkbox" /> {{ tr('按直接子级换行标签分段') }}</label><label class="rule-field"><span>{{ tr('区域标识（可选）') }}</span><input v-model="content.key" data-i18n-ignore /></label></details>
            </div>
            <button type="button" :disabled="form.content.length >= SITE_RULE_LIMITS.content" @click="form.content.push({css: '', atomic: true, resolve: 'self', splitOnBr: false})">{{ tr('添加正文区域') }}</button>
          </section>
          <div class="rule-columns"><label class="rule-field"><span>{{ tr('保留原文区域（可选）') }}</span><textarea v-model="form.protect" data-i18n-ignore rows="3" :aria-label="tr('保留原文区域（可选）')" placeholder="code&#10;pre&#10;button" /></label><label class="rule-field"><span>{{ tr('排除扫描区域（可选）') }}</span><textarea v-model="form.exclude" data-i18n-ignore rows="3" :aria-label="tr('排除扫描区域（可选）')" placeholder="nav&#10;.advertisement" /></label></div>
          <details class="form-advanced"><summary>{{ tr('高级选项') }}</summary><div class="rule-columns">          <label class="rule-field"><span>{{ tr('规则标识') }}</span><input v-model="form.id" data-i18n-ignore :aria-label="tr('规则标识')" :disabled="!!editingId" maxlength="96" placeholder="my-article-site" /><small class="rule-hint">{{ tr('用于覆盖与识别；创建后保持稳定') }}</small></label><label class="rule-field"><span>{{ tr('排除路径（可选）') }}</span><textarea v-model="form.excludePaths" data-i18n-ignore rows="2" :aria-label="tr('排除路径（可选）')" placeholder="/account/*" /></label><label class="rule-field"><span>{{ tr('优先级') }}</span><input v-model.number="form.priority" type="number" min="-10000" max="10000" step="1" :aria-label="tr('优先级')" /><small class="rule-hint">{{ tr('数字越大，正文候选越优先；保护区域仍共同生效') }}</small></label><label class="rule-field"><span>{{ tr('忽略动态变化区域（可选）') }}</span><textarea v-model="form.watchIgnore" data-i18n-ignore rows="3" :aria-label="tr('忽略动态变化区域（可选）')" /><small class="rule-hint">{{ tr('仅用于时钟、计数器等非正文') }}</small></label></div><p v-if="originalRule" class="rule-hint">{{ tr('未展示的高级字段会完整保留；需要修改时请使用高级 JSON 编辑') }}</p></details>
          <ul v-if="issues.length" class="rule-error" role="alert"><li v-for="(issue, index) in issues" :key="index"><code data-i18n-ignore>{{ issue.path }}</code> {{ tr(issue.message) }}</li></ul>
          <div class="rule-actions"><button type="submit" class="rule-primary" :disabled="formConflict || draftConflict" :aria-busy="saving">{{ tr(saving ? '正在保存' : '保存并应用') }}</button><button type="button" @click="cancelForm">{{ tr('取消编辑') }}</button></div>
        </fieldset>
      </form>
      <div v-else ref="catalogArea" class="catalog-browser" :class="{'has-detail': selected && selectedResolved}">
        <div class="catalog-directory">
        <div class="catalog-list" role="list" :aria-label="tr('网站规则目录')">
          <article v-for="item in visibleRules" :key="item.rule.id" class="catalog-rule" role="listitem" :data-adaptation-rule="item.rule.id">
            <button class="catalog-name" type="button" :aria-expanded="selectedId === item.rule.id" :aria-controls="selectedId === item.rule.id ? 'site-adaptation-rule-detail' : undefined" :class="{'is-selected': selectedId === item.rule.id}" @click="selectedId = selectedId === item.rule.id ? '' : item.rule.id">
              <strong data-i18n-ignore>{{ item.rule.name }}</strong><small data-i18n-ignore>{{ item.rule.match.hosts.join(', ') }}</small><span class="catalog-tags"><span class="rule-badge">{{ tr(item.source === 'custom' ? item.overridesBuiltin ? '自定义覆盖' : '自定义' : '内置') }}</span><span>{{ tr((item.rule.mode ?? item.pack.profiles?.[item.rule.profile ?? '']?.mode) === 'focus' ? '限定正文' : '补充识别') }}</span><span v-if="!item.enabled">{{ tr('已停用') }}</span></span>
            </button>
            <el-switch :title="tr('只停用这条规则，其他匹配规则仍会生效')" :model-value="item.enabled" :disabled="saving || isDirty || !!form" :aria-label="tr('启用规则') + ' ' + item.rule.name" @update:model-value="toggleRule(item.rule.id, Boolean($event))" />
          </article>
        </div>
        <div v-if="!matchingRules.length" class="rule-empty"><strong>{{ tr('没有匹配的网站规则') }}</strong><p>{{ tr('试试其他关键词，或切换规则来源') }}</p></div>
        <button v-if="visibleRules.length < matchingRules.length" type="button" class="catalog-more" @click="visibleLimit += 30">{{ tr('显示更多') }} ({{ visibleRules.length }}/{{ matchingRules.length }})</button>
        </div>
        <section v-if="selected && selectedResolved" id="site-adaptation-rule-detail" class="rule-detail" data-rule-detail>
          <header class="rule-heading settings-card-heading"><div class="settings-card-heading-copy"><h3 data-i18n-ignore>{{ selected.rule.name }}</h3></div><button type="button" @click="selectedId = ''">{{ tr('关闭详情') }}</button></header>
          <dl><dt>{{ tr('匹配域名') }}</dt><dd data-i18n-ignore>{{ selectedResolved.match.hosts.join(' · ') }}</dd><dt>{{ tr('匹配路径') }}</dt><dd data-i18n-ignore>{{ selectedResolved.match.paths?.join(' · ') || tr('所有路径') }}</dd><dt v-if="selectedResolved.match.excludePaths?.length">{{ tr('排除路径') }}</dt><dd v-if="selectedResolved.match.excludePaths?.length" data-i18n-ignore>{{ selectedResolved.match.excludePaths.join(' · ') }}</dd><dt>{{ tr('正文区域') }}</dt><dd data-i18n-ignore>{{ selectedResolved.content?.flatMap(item => item.css).join(' · ') || tr('通用正文识别') }}</dd><dt>{{ tr('保留原文') }}</dt><dd data-i18n-ignore>{{ selectedResolved.protect?.join(' · ') || '—' }}</dd><dt>{{ tr('排除扫描') }}</dt><dd data-i18n-ignore>{{ selectedResolved.exclude?.join(' · ') || '—' }}</dd><dt>{{ tr('优先级') }}</dt><dd>{{ selectedResolved.priority ?? 0 }}</dd></dl>
          <div class="rule-actions"><button type="button" class="rule-primary" :disabled="saving || !!form" @click="startForm(selected)">{{ tr(selected.source === 'builtin' ? '基于此规则自定义' : '编辑自定义规则') }}</button><button v-if="selected.source === 'custom'" type="button" :disabled="saving || !!form" @click="removeCustom(selected.rule.id)">{{ tr('从草稿移除') }}</button><button type="button" @click="downloadPack({version: 1, rules: [selectedResolved]}, selected.rule.id + '.json')">{{ tr('导出此规则') }}</button></div>
          <p v-if="selected.overridesBuiltin" class="rule-hint">{{ tr('同 ID 的自定义规则完整替换内置规则；移除自定义版本后恢复内置版本') }}</p>
          <details><summary>{{ tr('查看展开后的 JSON') }}</summary><p class="rule-hint" data-i18n-ignore>{{ selected.rule.id }}</p><pre data-i18n-ignore>{{ JSON.stringify(selectedResolved, null, 2) }}</pre></details>
        </section>

      </div>
      <div v-if="!form" id="adaptation-editor-feedback" class="adaptation-feedback" aria-live="polite"><ul v-if="issues.length" class="rule-error" role="alert"><li v-for="(issue, index) in issues" :key="index"><code data-i18n-ignore>{{ issue.path }}</code> {{ tr(issue.message) }}</li></ul><p v-else-if="status" class="rule-hint" role="status">{{ tr(status) }}</p></div>
    </section>
    <details v-show="!form" class="rule-card backup-tools">
      <summary>{{ tr('JSON 与备份') }}</summary>
      <section aria-labelledby="adaptation-custom-heading">
        <header class="rule-heading settings-card-heading"><div class="settings-card-heading-copy"><h3 id="adaptation-custom-heading">{{ tr('自定义规则与备份') }}</h3><p>{{ tr('可视化编辑与 JSON 编辑共用一份草稿，请检查后保存；导入默认合并，现有规则会保留') }}</p></div><span v-if="isDirty" class="rule-badge">{{ tr('未保存') }}</span></header>
        <div class="rule-actions import-actions"><button type="button" :disabled="saving || !!form" @click="insertExample">{{ tr('插入示例') }}</button><label class="import-mode">{{ tr('导入方式') }} <UiSelect :aria-label="tr('导入方式')" v-model="importMode" :disabled="saving"><el-option value="merge" :label="tr('合并（同 ID 替换）')" /><el-option value="replace" :label="tr('替换整个草稿')" /></UiSelect></label><button type="button" :disabled="saving || !!form" @click="fileInput?.click()">{{ tr('导入 JSON') }}</button><button type="button" @click="downloadPack(modelValue.custom, 'fluentread-custom-sites.json')">{{ tr('导出已保存规则') }}</button><button v-if="isDirty && parsedDraft.ok" type="button" @click="downloadPack(workingPack, 'fluentread-draft-sites.json')">{{ tr('导出草稿') }}</button><button type="button" @click="downloadPack(builtinSiteRulePack, 'fluentread-builtin-sites.json')">{{ tr('导出内置规则') }}</button><input ref="fileInput" hidden type="file" accept=".json,application/json" @change="importFile" /></div>
        <details :open="jsonOpen" class="json-editor" @toggle="jsonOpen = ($event.target as HTMLDetailsElement).open"><summary>{{ tr('高级 JSON 编辑') }}</summary><p class="rule-hint">{{ tr('支持模板、多个内容区域及全部高级字段；每次保存都会校验格式、域名、路径与 CSS 选择器') }}</p><label class="rule-field"><span>{{ tr('JSON 编辑草稿') }}</span><textarea v-model="draft" data-i18n-ignore rows="16" spellcheck="false" autocomplete="off" :disabled="saving || !!form" :aria-label="tr('JSON 编辑草稿')" :aria-invalid="issues.length > 0" aria-describedby="adaptation-editor-feedback" @input="markDraftEdited" /></label><div class="rule-actions"><button type="button" :disabled="saving || !!form" @click="validateDraft">{{ tr('校验草稿') }}</button><button type="button" :disabled="saving || !!form" @click="clearCustom">{{ tr('清空自定义草稿') }}</button></div></details>
        <div class="rule-actions save-actions"><button type="button" :disabled="!isDirty || saving || !!form" @click="restoreSaved">{{ tr('恢复已保存草稿') }}</button><button v-if="undoDraft !== null" type="button" :disabled="saving || !!form" @click="undoReplacement">{{ tr('撤销草稿替换') }}</button><span class="rule-hint">{{ tr(saving ? '正在保存，等待后台确认' : isDirty ? '目录显示草稿；网页仍使用已保存规则' : '当前规则已保存') }}</span></div>
        <details class="rule-guide"><summary>{{ tr('如何编写规则') }}</summary><p class="rule-hint">{{ tr('“补充识别”在通用正文中增加指定区域，“限定范围”仅翻译匹配的正文区域；所有匹配规则的保护区域共同生效，存在限定范围规则时会限制通用识别') }}</p><p class="rule-hint">{{ tr('修改规则会恢复正在翻译的页面，请重新触发翻译；网址预览不验证网站当前 DOM') }}</p><a href="https://fluent.thinkstu.com/guide/custom-site-rules" target="_blank" rel="noopener noreferrer">{{ tr('查看完整自定义教程') }}</a></details>
      </section>
    </details>
  </div>
</template>
<script setup lang="ts">
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {downloadTextFile} from '@/src/shared/dom/downloadTextFile';
import {computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {resolveSiteRule} from '@/src/core/site-adaptation/compiler';
import {SITE_RULE_LIMITS} from '@/src/core/site-adaptation/schema';
import type {SiteAdaptationSettings, SiteRule, SiteRuleIssue, SiteRulePack} from '@/src/core/site-adaptation/types';
import {useUiI18n} from '@/src/ui/i18n';
import {buildSiteRuleFromForm, completeSiteRuleDraftSave, copySiteRuleToDraft, createSiteAdaptationCommitter,
  createSiteRuleDraftImportGuard, createSiteRuleForm, formatSiteRulePack, listSiteRuleCatalog, mergeSiteRuleDraft,
  parseSiteAdaptationDraft, reconcileSiteRuleDraft, searchSiteRules, setSiteRuleEnabled, SITE_ADAPTATION_EXAMPLE,
  upsertSiteRuleDraft, type SiteRuleCatalogItem, type SiteRuleForm} from '../model/siteAdaptationEditor';
const props = withDefaults(defineProps<{modelValue: SiteAdaptationSettings; saveSettings: (value: SiteAdaptationSettings) => Promise<void>; inspectRuleId?: string; active?: boolean}>(), {active: true});
const {translateLegacy: tr, t} = useUiI18n();
const search = ref(''); const filter = ref('all'); const visibleLimit = ref(30); const selectedId = ref('');
const draft = ref(formatSiteRulePack(props.modelValue.custom)); const draftOwned = ref(false);
const draftBase = ref(draft.value); const formArea = ref<HTMLElement | null>(null); const catalogArea = ref<HTMLElement | null>(null);
const saving = ref(false); const undoDraft = ref<string | null>(null); const issues = ref<SiteRuleIssue[]>([]); const status = ref('');
const downloadError = ref(false); let downloadRevision = 0; let alive = true;
watch(() => props.active, active => {if (!active) {downloadRevision += 1; downloadError.value = false;}}, {flush: 'sync'});
onActivated(() => {alive = true;});
onDeactivated(() => {alive = false; downloadRevision += 1; downloadError.value = false;});
const fileInput = ref<HTMLInputElement | null>(null); const importMode = ref('merge'); const jsonOpen = ref(false);
const form = ref<SiteRuleForm | null>(null); const originalRule = ref<SiteRule>(); const editingId = ref<string | null>(null);
let formBaseline = ''; let formSettingsBaseline = ''; let formInitial = '';
const committer = createSiteAdaptationCommitter(value => props.saveSettings(value));
const importGuard = createSiteRuleDraftImportGuard();
const isDirty = computed(() => draft.value !== formatSiteRulePack(props.modelValue.custom));
const hasUnsavedWork = computed(() => saving.value || isDirty.value || (!!form.value && JSON.stringify(form.value) !== formInitial));
function warnBeforeExit(event: BeforeUnloadEvent) {
  if (!hasUnsavedWork.value) return;
  event.preventDefault(); event.returnValue = '';
}
watch(hasUnsavedWork, active => {
  if (active) window.addEventListener('beforeunload', warnBeforeExit);
  else window.removeEventListener('beforeunload', warnBeforeExit);
}, {immediate: true});
onBeforeUnmount(() => {alive = false; window.removeEventListener('beforeunload', warnBeforeExit);});
const draftConflict = computed(() => draftOwned.value && isDirty.value && !saving.value && draftBase.value !== formatSiteRulePack(props.modelValue.custom));
const parsedDraft = computed(() => parseSiteAdaptationDraft(draft.value, document));
const workingPack = computed(() => parsedDraft.value.ok ? parsedDraft.value.pack : props.modelValue.custom);
const catalog = computed(() => listSiteRuleCatalog(builtinSiteRulePack, {...props.modelValue, custom: workingPack.value}));
const filters = computed(() => [{id: 'all', label: '全部规则', count: catalog.value.length},
  {id: 'custom', label: '自定义', count: catalog.value.filter(item => item.source === 'custom').length},
  {id: 'builtin', label: '内置', count: catalog.value.filter(item => item.source === 'builtin').length},
  {id: 'disabled', label: '已停用', count: catalog.value.filter(item => !item.enabled).length}]);
const matchingRules = computed(() => {
  const matching = new Set(searchSiteRules(catalog.value.map(item => item.rule), search.value).map(rule => rule.id));
  return catalog.value.filter(item => matching.has(item.rule.id) && (filter.value === 'all' || (filter.value === 'disabled' ? !item.enabled : item.source === filter.value)));
});
watch(matchingRules, rules => {
  if (selectedId.value && !rules.some(item => item.rule.id === selectedId.value)) selectedId.value = '';
});
const visibleRules = computed(() => matchingRules.value.slice(0, visibleLimit.value));
const selected = computed(() => catalog.value.find(item => item.rule.id === selectedId.value));
const selectedResolved = computed(() => selected.value ? resolveSiteRule(selected.value.pack, selected.value.rule) : null);
watch(() => props.inspectRuleId, id => {
  if (!id || saving.value) return;
  if (form.value) { cancelForm(); if (form.value) return; }
  selectedId.value = id; search.value = id; filter.value = 'all'; visibleLimit.value = 30;
}, {immediate: true});
const formConflict = computed(() => !!form.value && (draft.value !== formBaseline || formatSiteRulePack(props.modelValue.custom) !== formSettingsBaseline));
watch(() => props.modelValue.custom, (incoming, previous) => {
  draft.value = reconcileSiteRuleDraft(draft.value, previous, incoming, draftOwned.value || saving.value);
});
function openJsonEditor() {
  jsonOpen.value = true;
  void nextTick(() => {
    const tools = fileInput.value?.closest<HTMLDetailsElement>('.backup-tools');
    if (tools) tools.open = true;
  });
}
function clearFeedback() { issues.value = []; status.value = ''; }
function markDraftEdited() { if (!draftOwned.value) draftBase.value = formatSiteRulePack(props.modelValue.custom); draftOwned.value = true; clearFeedback(); }
function replaceDraft(value: string) { undoDraft.value = draft.value; draft.value = value; markDraftEdited(); }
async function commitSettings(value: SiteAdaptationSettings): Promise<boolean> {
  if (saving.value) return false;
  clearFeedback(); saving.value = true;
  const result = await committer.commit(value); saving.value = false;
  if (result !== 'saved') { issues.value = [{path: '$', message: '保存失败，草稿仍保留；请重试'}]; return false; }
  return true;
}
async function setEnabled(enabled: boolean) { if (await commitSettings({...props.modelValue, enabled})) status.value = '网站适配设置已保存'; }
async function toggleRule(id: string, enabled: boolean) { if (await commitSettings(setSiteRuleEnabled(props.modelValue, id, enabled))) status.value = '规则开关已保存'; }
function validateDraft() { clearFeedback(); const result = parsedDraft.value; if (!result.ok) issues.value = result.issues; else status.value = '草稿校验通过，点击保存并应用后生效'; }
async function saveDraft() {
  if (saving.value || form.value || draftConflict.value) return;
  clearFeedback(); const submitted = draft.value; const result = parsedDraft.value;
  if (!result.ok) { issues.value = result.issues; openJsonEditor(); return; }
  draftOwned.value = true;
  if (!await commitSettings({...props.modelValue, custom: result.pack})) return;
  const completed = completeSiteRuleDraftSave(draft.value, submitted, result.pack);
  draft.value = completed.draft;
  if (completed.clearUndo) { undoDraft.value = null; draftOwned.value = false; draftBase.value = formatSiteRulePack(result.pack); }
  status.value = completed.clearUndo ? '规则已应用；正在翻译的页面会恢复原文，请重新触发翻译' : '已保存提交的规则，新的草稿修改尚未保存';
}
function startForm(item?: SiteRuleCatalogItem) {
  if (!parsedDraft.value.ok) { issues.value = parsedDraft.value.issues; openJsonEditor(); return; }
  originalRule.value = item ? resolveSiteRule(item.pack, item.rule) : undefined;
  editingId.value = item?.rule.id ?? null;
  form.value = createSiteRuleForm(originalRule.value);
  if (!item) form.value.id = 'user-site-' + (globalThis.crypto?.randomUUID?.()
    ?? Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  formBaseline = draft.value; formSettingsBaseline = formatSiteRulePack(props.modelValue.custom); formInitial = JSON.stringify(form.value);
  clearFeedback();
  void nextTick(() => formArea.value?.scrollIntoView({block: 'start'}));
}
function cancelForm() {
  if (JSON.stringify(form.value) !== formInitial && !window.confirm(tr('放弃尚未保存的规则修改？'))) return;
  form.value = null; originalRule.value = undefined;
}
async function saveForm() {
  if (!form.value || formConflict.value || draftConflict.value || saving.value) return;
  clearFeedback();
  if (!editingId.value && builtinSiteRulePack.rules.some(rule => rule.id === form.value!.id.trim())) {
    issues.value = [{path: '$.id', message: '该标识属于内置规则，请从目录选择“基于此规则自定义”'}]; return;
  }
  const result = upsertSiteRuleDraft(draft.value, buildSiteRuleFromForm(form.value, originalRule.value), editingId.value, document);
  if (!result.ok) { issues.value = result.issues; return; }
  // 表单先校验整份合并结果，保存失败时保留表单与已有 JSON 草稿，只有后台确认后才退出编辑。
  const id = form.value.id.trim();
  draftOwned.value = true;
  if (!await commitSettings({...props.modelValue, custom: result.pack})) return;
  draft.value = result.draft; draftBase.value = result.draft; draftOwned.value = false; undoDraft.value = null;
  form.value = null; originalRule.value = undefined;
  filter.value = 'custom'; search.value = ''; selectedId.value = id; visibleLimit.value = 30;
  status.value = '规则已应用；正在翻译的页面会恢复原文，请重新触发翻译';
  void nextTick(() => catalogArea.value?.scrollIntoView({block: 'start'}));
}
function removeCustom(id: string) {
  const parsed = parsedDraft.value; if (!parsed.ok) { issues.value = parsed.issues; openJsonEditor(); return; }
  replaceDraft(formatSiteRulePack({...parsed.pack, rules: parsed.pack.rules.filter(rule => rule.id !== id)}));
  status.value = '已从草稿移除；保存后生效，同 ID 内置规则将恢复';
}
function restoreSaved() { replaceDraft(formatSiteRulePack(props.modelValue.custom)); draftBase.value = draft.value; draftOwned.value = false; }
function clearCustom() { replaceDraft(formatSiteRulePack({version: 1, rules: []})); status.value = '已清空草稿，点击保存后生效'; }
function undoReplacement() { if (undoDraft.value === null) return; draft.value = undoDraft.value; undoDraft.value = null; markDraftEdited(); }
function insertExample() {
  const example = SITE_ADAPTATION_EXAMPLE.rules[0]!; const parsed = parsedDraft.value;
  if (parsed.ok && parsed.pack.rules.some(rule => rule.id === example.id)) {
    status.value = '示例已存在，现有修改已保留'; filter.value = 'custom'; search.value = example.id; return;
  }
  const result = copySiteRuleToDraft(draft.value, SITE_ADAPTATION_EXAMPLE, example, document);
  if (!result.ok) { issues.value = result.issues; openJsonEditor(); return; }
  replaceDraft(result.draft); filter.value = 'custom'; selectedId.value = example.id; search.value = '';
  status.value = '示例已加入草稿，编辑后点击保存并应用';
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
  if (!file || saving.value || form.value) return;
  const ticket = importGuard.begin(draft.value); const mode = importMode.value; clearFeedback();
  if (file.size > SITE_RULE_LIMITS.bytes) { issues.value = [{path: '$', message: '规则包不能超过 2 MB'}]; return; }
  try {
    const text = await file.text(); const state = importGuard.check(ticket, draft.value);
    if (state === 'superseded') return;
    if (state === 'edited' || saving.value || form.value) { status.value = '读取文件期间草稿已更改，请重新导入以替换当前草稿'; return; }
    const parsed = parseSiteAdaptationDraft(text, document);
    if (!parsed.ok) { issues.value = parsed.issues; return; }
    const result = mode === 'merge' ? mergeSiteRuleDraft(draft.value, parsed.pack, document) : {ok: true as const, draft: formatSiteRulePack(parsed.pack)};
    if (!result.ok) { issues.value = result.issues; return; }
    replaceDraft(result.draft); filter.value = 'custom'; search.value = ''; status.value = '已导入草稿，检查后点击保存';
  } catch { if (importGuard.check(ticket, draft.value) === 'current') issues.value = [{path: '$', message: '无法读取文件，请重新选择本地 JSON 文件'}]; }
}
function downloadPack(pack: SiteRulePack, filename: string) {
  const revision = ++downloadRevision; downloadError.value = false;
  try {downloadTextFile(filename, formatSiteRulePack(pack), 'application/json;charset=utf-8');}
  catch {if (alive && props.active && revision === downloadRevision) downloadError.value = true;}
}
</script>
<style scoped>
@import './site-rule-workspace.css';
.catalog-toolbar { display: flex; gap: 12px; align-items: center; margin-top: 20px; }
.draft-bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 12px; margin-top: 16px; border: 1px solid var(--brand-strong); border-radius: 9px; background: var(--surface); color: var(--muted); font-size: 12px; }
.catalog-toolbar .rule-field { margin: 0; flex: 1; }
.catalog-filters { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 14px; }
.catalog-filters button { border-color: transparent; background: var(--surface-soft); }
.catalog-filters button.is-active { border-color: var(--brand-strong); color: var(--brand-strong); }
.catalog-filters span { margin-left: 5px; color: var(--muted); font-size: 11px; }
.catalog-list { max-height: 280px; overflow: auto; scrollbar-gutter: stable; margin-top: 16px; }
.catalog-rule { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid var(--line); padding: 10px 7px 10px 0; }
.catalog-rule .catalog-name { display: grid; gap: 7px; min-width: 0; text-align: left; border: 0; background: transparent; }
.catalog-name strong { font-size: 13px; overflow-wrap: anywhere; }
.catalog-name small { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.catalog-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; font-size: 11px; color: var(--muted); }
.catalog-more { margin-top: 12px; }
.rule-detail, .visual-editor { border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-top: 20px; background: var(--surface-soft); }
.catalog-browser { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; margin-top: 16px; align-items: start; }
.catalog-browser.has-detail { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.catalog-directory { min-width: 0; }
.catalog-browser .catalog-list { margin-top: 0; }
.catalog-browser .rule-detail { margin-top: 0; padding: 16px; }
.catalog-rule .catalog-name { flex: 1; }
.catalog-rule .catalog-name.is-selected { background: var(--brand-soft, var(--surface-soft)); box-shadow: inset 3px 0 var(--brand-strong); }
.visual-editor fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.visual-editor .rule-heading { margin-bottom: 22px; }
.recognition-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.recognition-modes label { display: flex; align-items: flex-start; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 12px; line-height: 1.7; cursor: pointer; }
.recognition-modes label.is-active { border-color: var(--brand-strong); background: var(--brand-soft, var(--surface)); }
.recognition-modes input { margin-top: 4px; accent-color: var(--brand-strong); }
.form-section-heading { margin-top: 16px !important; }
.rule-workspace details.backup-tools { margin-top: 0; padding: 18px 24px; }
.backup-tools > summary { color: var(--ink); }
.backup-tools > section { padding-top: 18px; }
.rule-detail dl { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px; margin: 20px 0; font-size: 12px; line-height: 1.7; }
.rule-detail dt { color: var(--muted); } .rule-detail dd { margin: 0; overflow-wrap: anywhere; }
.rule-workspace details { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }
.rule-workspace summary { cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 550; }
.rule-detail pre { max-height: 350px; }
.content-row { border: 1px solid var(--line); border-radius: 9px; padding: 14px; margin-bottom: 14px; }
.content-row label { font-size: 12px; line-height: 1.7; }
.content-row input[type=checkbox] { accent-color: var(--brand-strong); }
.content-editor { margin: 20px 0; }
.import-actions { margin: 18px 0; }
.import-mode { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; font-size: 12px; color: var(--muted); }
.import-mode .fluentread-select { width: 220px; max-width: 100%; }
.json-editor textarea { font: 12px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.save-actions { margin-top: 18px; }
.rule-guide a { color: var(--brand-strong); font-size: 12px; }
@media (max-width: 1000px) { .catalog-browser.has-detail { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 650px) { .recognition-modes { grid-template-columns: minmax(0, 1fr); } .catalog-toolbar { flex-wrap: wrap; } .catalog-toolbar .rule-field { flex-basis: 100%; } .rule-detail, .visual-editor { padding: 15px; } .rule-detail dl { grid-template-columns: minmax(0, 1fr); gap: 4px; } .rule-detail dd { margin-bottom: 8px; } }
</style>

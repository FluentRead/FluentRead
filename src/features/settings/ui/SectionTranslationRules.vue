<!--
 * @file src/features/settings/ui/SectionTranslationRules.vue
 * 文件职责：在局部翻译设置中管理用户明确记住的网站区域，让下次访问时自动翻译或显示提醒。
 * 主要内容：列表只展示网站、下次动作与启停，支持筛选、编辑、删除和手动添加；编辑器以网站和动作为主，仅在有可选方案或已有引用时展示方案，CSS 路径收在高级设置；编辑草稿独立于配置，校验后一次提交，外部配置或页面切换使旧草稿失效。
 * 模块边界：组件仅编辑父级 Config.sectionTranslationRules 并由既有配置编辑器持久化，不访问网页、不猜测元素、不请求翻译或直接读写存储；规则格式与校验归 core/config/sectionTranslationRules。
 -->
<template>
  <section class="section-rules" data-testid="section-translation-rules" :aria-label="t('sectionTranslation.rules.title')">
    <SettingsItem class="rules-heading" :label="t('sectionTranslation.rules.title')">
      <template #copy>
        <h3 class="rules-title"><strong>{{ t('sectionTranslation.rules.title') }}</strong></h3>
        <small v-if="!rules.length && !draft" class="rules-empty">{{ t('sectionTranslation.rules.empty') }}</small>
      </template>
      <button v-if="!draft" type="button" class="settings-add-button" :disabled="!active || rules.length >= 100" @click="addRule">
        {{ t('sectionTranslation.rules.add') }}
      </button>
    </SettingsItem>
    <el-input v-if="rules.length > 5 && !draft" v-model="filter" class="rules-filter" :placeholder="t('sectionTranslation.rules.search')" :aria-label="t('sectionTranslation.rules.search')" clearable />
    <p v-if="rules.length && !filteredRules.length && !draft" class="rules-empty rules-no-results">{{ t('sectionTranslation.rules.noResults') }}</p>
    <div v-if="filteredRules.length && !draft" class="rules-list">
      <article v-for="rule in filteredRules" :key="rule.id" class="rule-row" :class="{'is-disabled': !rule.enabled}" :data-rule-id="rule.id">
        <el-switch :model-value="rule.enabled" :disabled="!active" :aria-label="t('sectionTranslation.rules.enable', {site: rule.site})" @update:model-value="updateRule(rule, {enabled: Boolean($event)})" />
        <div class="rule-main"><strong :title="rule.site" data-i18n-ignore>{{ rule.site }}</strong><small v-if="isMissingProfile(rule.profileId)" class="rule-profile-missing" role="status">{{ t('sectionTranslation.rules.profileMissing') }}</small></div>
        <el-select :model-value="rule.mode" class="rule-mode" :disabled="!active" :aria-label="t('sectionTranslation.rules.modeFor', {site: rule.site})" @update:model-value="updateRule(rule, {mode: $event})"><el-option value="remind" :label="t('sectionTranslation.rules.remind')" /><el-option value="auto" :label="t('sectionTranslation.rules.auto')" /></el-select>
        <div class="rule-actions"><el-button size="small" :disabled="!active" @click="editRule(rule)">{{ t('sectionTranslation.rules.edit') }}</el-button><el-button size="small" text type="danger" :disabled="!active" :aria-label="t('sectionTranslation.rules.deleteFor', {site: rule.site})" @click="removeRule(rule)">{{ t('sectionTranslation.rules.delete') }}</el-button></div>
      </article>
    </div>
    <form v-if="draft" class="rule-editor" @submit.prevent="saveDraft">
      <label><span>{{ t('sectionTranslation.rules.website') }}</span><el-input v-model="draft.site" :aria-label="t('sectionTranslation.rules.website')" placeholder="*.example.com/articles/" /></label>
      <label><span>{{ t('sectionTranslation.rules.nextVisit') }}</span><el-select v-model="draft.mode" :aria-label="t('sectionTranslation.rules.nextVisit')"><el-option value="remind" :label="t('sectionTranslation.rules.remind')" /><el-option value="auto" :label="t('sectionTranslation.rules.auto')" /></el-select></label>
      <label v-if="sectionProfiles.length || draft.profileId" class="profile-editor"><span>{{ t('sectionTranslation.rules.profile') }}</span><el-select :model-value="draft.profileId ?? ''" data-testid="section-rule-profile" :aria-label="t('sectionTranslation.rules.profile')" @update:model-value="draft.profileId = $event || undefined"><el-option value="" :label="t('sectionTranslation.rules.profileDefault')" /><el-option v-if="isMissingProfile(draft.profileId)" :value="draft.profileId" :label="t('sectionTranslation.rules.profileMissing')" disabled /><el-option v-for="profile in sectionProfiles" :key="profile.id" :value="profile.id" :label="profile.hotkey || t('sectionTranslation.rules.profileNoShortcut')" /></el-select><small v-if="isMissingProfile(draft.profileId)" class="rule-profile-missing" role="status">{{ t('sectionTranslation.rules.profileMissingHelp') }}</small></label>
      <details class="rule-advanced" :open="advancedOpen" @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open">
        <summary>{{ t('sectionTranslation.rules.advanced') }}</summary>
        <label class="selector-editor"><span>{{ t('sectionTranslation.rules.selectors') }}</span><el-input v-model="draft.selectorsText" type="textarea" :rows="3" :aria-label="t('sectionTranslation.rules.selectors')" placeholder="article .content" /><small>{{ t('sectionTranslation.rules.selectorsHelp') }}</small></label>
      </details>
      <p v-if="error" class="rule-error" role="alert">{{ error }}</p>
      <div class="editor-actions"><el-button size="small" @click="cancelDraft">{{ t('sectionTranslation.rules.cancel') }}</el-button><el-button size="small" type="primary" native-type="submit" :disabled="!active">{{ t('sectionTranslation.rules.save') }}</el-button></div>
    </form>
  </section>
</template>

<script setup lang="ts">
import {computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue';
import type {Config} from '@/src/core/config/model';
import {normalizeSectionRuleSite, validateSectionTranslationRule, type SectionTranslationRule} from '@/src/core/config/sectionTranslationRules';
import {useUiI18n} from '@/src/ui/i18n';
import SettingsItem from './components/SettingsItem.vue';

const props = withDefaults(defineProps<{config: Config; active?: boolean}>(), {active: true});
const {t} = useUiI18n();
const rules = computed(() => props.config.sectionTranslationRules);
const sectionProfiles = computed(() => props.config.quickTranslationProfiles.filter(profile => profile.action === 'section'));
const sectionProfileIds = computed(() => new Set(sectionProfiles.value.map(profile => profile.id)));
const isMissingProfile = (profileId: string | undefined): boolean => Boolean(profileId && !sectionProfileIds.value.has(profileId));
const filter = ref('');
const filteredRules = computed(() => rules.value.filter(rule => rule.site.toLocaleLowerCase().includes(filter.value.trim().toLocaleLowerCase())));
const draft = ref<(SectionTranslationRule & {selectorsText: string; existing: boolean}) | null>(null);
const advancedOpen = ref(false);
const error = ref('');
let baseline = '';
let baselineConfig: Config | undefined;
let viewActive = true;
const available = (): boolean => props.active && viewActive;
const snapshot = (): string => JSON.stringify(rules.value);
function cancelDraft(): void { draft.value = null; error.value = ''; baselineConfig = undefined; }
watch(() => props.active, active => { if (!active) cancelDraft(); });
watch(() => props.config, () => cancelDraft());
watch(rules, () => { if (draft.value && snapshot() !== baseline) cancelDraft(); }, {deep: true});
onActivated(() => {viewActive = true;});
onDeactivated(() => {viewActive = false; cancelDraft();});
onBeforeUnmount(() => {viewActive = false; cancelDraft();});
function addRule(): void {
    if (!available() || draft.value || rules.value.length >= 100) return;
    baseline = snapshot();
    baselineConfig = props.config;
    draft.value = {id: `section-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, enabled: true, site: '', selectors: [], selectorsText: '', mode: 'remind', existing: false};
    advancedOpen.value = true;
    error.value = '';
}
function editRule(rule: SectionTranslationRule): void {
    if (!available() || draft.value || !rules.value.includes(rule)) return;
    baseline = snapshot();
    baselineConfig = props.config;
    draft.value = {...rule, selectors: rule.selectors.map(path => [...path]), selectorsText: rule.selectors.map(path => path.join(' >>> ')).join('\n'), existing: true};
    advancedOpen.value = false;
    error.value = '';
}
function updateRule(rule: SectionTranslationRule, patch: Partial<SectionTranslationRule>): void {
    if (!available() || draft.value || !rules.value.includes(rule)) return;
    props.config.sectionTranslationRules = rules.value.map(item => item.id === rule.id ? {...item, ...patch} : item);
}
function removeRule(rule: SectionTranslationRule): void {
    if (!available() || draft.value || !rules.value.includes(rule)) return;
    props.config.sectionTranslationRules = rules.value.filter(item => item.id !== rule.id);
}
function saveDraft(): void {
    const current = draft.value;
    if (!available() || !current || props.config !== baselineConfig || snapshot() !== baseline) {cancelDraft(); return;}
    const rule: SectionTranslationRule = {
        id: current.id, enabled: current.enabled, site: normalizeSectionRuleSite(current.site) ?? current.site,
        selectors: current.selectorsText.split('\n').map(line => line.trim()).filter(Boolean).map(line => line.split(/\s*>>>\s*/u).map(selector => selector.trim())),
        mode: current.mode, ...(current.profileId ? {profileId: current.profileId} : {}),
    };
    const invalid = validateSectionTranslationRule(rule);
    if (invalid) {error.value = t(invalid === 'site' ? 'sectionTranslation.rules.invalidSite' : 'sectionTranslation.rules.invalidSelectors'); if (invalid !== 'site') advancedOpen.value = true; return;}
    const probe = document.createElement('div');
    try { for (const path of rule.selectors) for (const selector of path) probe.matches(selector); }
    catch {error.value = t('sectionTranslation.rules.invalidSelectors'); advancedOpen.value = true; return;}
    props.config.sectionTranslationRules = current.existing ? rules.value.map(item => item.id === rule.id ? rule : item) : [...rules.value, rule];
    cancelDraft();
}
</script>

<style scoped>
/* 记住的区域面板：改为与设置页一致的行式结构，不再自建圆角卡片；列表行与编辑表单统一消费平台皮肤 token。 */
.section-rules { display: grid; gap: 16px; border-top: 1px solid var(--fr-card-border, var(--line)); }
/* 有列表或编辑器时补底部间距，与设置页行式节奏统一。 */
.section-rules:has(> :is(.rules-list, .rules-no-results, .rule-editor)) { padding-bottom: var(--fr-settings-row-padding-block, 14px); }
.rules-heading { grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.rules-title { margin: 0; font: inherit; }
.rules-title > strong { display: block; }
.rules-filter, .rules-no-results, .rules-list, .rule-editor { margin-inline: var(--fr-card-padding-inline, 20px); }
.section-rules > .rules-filter { width: auto; }
.rules-no-results { margin-block: 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.rules-list { display: grid; }
.rule-row { display: flex; align-items: center; gap: 10px; padding: var(--fr-settings-row-padding-block, 14px) 0; border-top: 1px solid var(--fr-card-border, var(--line)); }
.rule-row:first-child { border-top: 0; }
.rule-row.is-disabled .rule-main { opacity: .55; }
.rule-main { flex: 1; min-width: 0; }
.rule-main strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 1.5; color: var(--ink, #172033); }
.rule-profile-missing { font-size: 11px; line-height: 1.5; color: var(--el-color-warning, #a66a00); }
.rule-mode { flex: 0 0 144px; width: 144px; }
.rule-actions { display: flex; gap: 4px; align-items: center; }
.rule-actions :deep(.el-button + .el-button) { margin-left: 0; }
/* 编辑表单改为行式：顶部分隔线取代圆角卡片，与列表共用皮肤 token。 */
.rule-editor { display: grid; grid-template-columns: minmax(0, 1fr) 140px; gap: 12px; padding-top: 14px; border-top: 1px solid var(--fr-card-border, var(--line)); }
.rule-editor label { display: grid; gap: 6px; min-width: 0; font-size: 12px; color: var(--ink, #172033); }
.profile-editor, .rule-advanced, .rule-error, .editor-actions { grid-column: 1 / -1; }
.rule-advanced { min-width: 0; }
.section-rules .rule-editor .rule-advanced > summary { width: fit-content; min-height: 0; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; color: var(--muted, #737c8f); font-size: 12px; line-height: 24px; cursor: pointer; }
.section-rules .rule-editor .rule-advanced[open] > summary { margin-bottom: 8px; }
.selector-editor small { color: var(--muted, #737c8f); line-height: 1.5; }
.selector-editor :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.rule-error { margin: 0; font-size: 12px; color: var(--el-color-danger, #d92c60); }
.editor-actions { display: flex; justify-content: flex-end; gap: 8px; }
.editor-actions :deep(.el-button + .el-button) { margin-left: 0; }
@media (max-width: 640px) {
    .rule-row { display: grid; grid-template-columns: max-content minmax(0, 1fr) auto; gap: 8px; }
    .rule-main { grid-column: 2 / -1; }
    .rule-mode { grid-column: 1 / 3; grid-row: 2; width: min(100%, 144px); min-width: 0; }
    .rule-actions { grid-column: 3; grid-row: 2; justify-self: end; }
    .rule-editor { grid-template-columns: minmax(0, 1fr); }
}
</style>

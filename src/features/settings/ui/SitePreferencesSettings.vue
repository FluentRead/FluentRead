<!--
 * @file src/features/settings/ui/SitePreferencesSettings.vue
 * 文件职责：在同一张紧凑偏好卡中管理全局自动翻译与网站的自动翻译、禁用、悬浮球及仅译文偏好。
 * 主要内容：使用统一的下拉选择器保持控件与菜单风格一致；独立标题分隔栏与下方自动翻译开关，提供域名归并预览、添加校验、搜索、单站编辑、删除撤销及后台确认反馈；网站名单变化时只归一化排序一次，搜索复用已有行。
 * 模块边界：复用既有配置数组及异步补丁端口，不创建新配置格式、不读取当前标签页，不宣称尚未确认的保存成功。
 -->
<template>
  <div class="site-preferences rule-workspace" data-setting="site-preferences">
    <section class="rule-card" aria-labelledby="site-preferences-heading">
      <header class="rule-section-heading settings-card-heading"><div class="preference-title"><h2 id="site-preferences-heading">{{ tr('网站偏好') }}</h2><span v-if="rows.length" class="rule-badge">{{ rows.length }}</span></div><p>{{ tr('按主域名生效，包含所有子域') }}</p></header>
      <div class="rule-toggle-row">
        <span :title="tr('开启后自动翻译所有未禁用扩展的网站，并保留下方的“始终翻译”名单')">{{ tr('所有网站自动翻译') }}</span>
        <el-switch :model-value="settings.autoTranslate" :disabled="saving" :aria-label="tr('所有网站自动翻译')" @update:model-value="commit({autoTranslate: Boolean($event)})" />
      </div>
      <p v-if="!settings.on" class="rule-notice">{{ tr('插件已关闭，网站偏好仍会保存，重新开启插件后生效') }}</p>
      <form class="preference-add" @submit.prevent="addSite">
        <label class="rule-field"><span>{{ tr('域名或完整网址') }}</span><input v-model="input" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://docs.example.com/article" :disabled="saving" :title="tr('包含主域及所有子域；路径、参数和端口不进入偏好')" :aria-invalid="Boolean(error)" aria-describedby="site-preference-feedback" @input="error = ''" /></label>
        <label class="rule-field"><span>{{ tr('初始偏好') }}</span><UiSelect :aria-label="tr('初始偏好')" v-model="initialPreference" :disabled="saving"><el-option value="always" :label="tr('始终翻译')" /><el-option value="disabled" :label="tr('禁用扩展')" /><el-option value="hidden" :label="tr('隐藏悬浮球')" /><el-option value="single" :label="tr('仅显示译文')" /></UiSelect></label>
        <button type="submit" class="rule-primary" :disabled="saving">{{ tr('添加网站') }}</button>
      </form>
      <p v-if="normalized" class="rule-hint" data-domain-preview><span>{{ tr('将保存为') }} </span><strong data-i18n-ignore>{{ normalized }}</strong></p>
      <div id="site-preference-feedback" aria-live="polite"><p v-if="error" class="rule-error" role="alert">{{ tr(error) }}</p><p v-else-if="saving" class="rule-hint" role="status">{{ tr('正在保存，等待后台确认') }}</p><p v-else-if="status" class="rule-hint" role="status">{{ tr(status) }}</p></div>
      <label v-if="rows.length" class="rule-field preference-search"><span class="sr-only">{{ tr('搜索网站偏好') }}</span><input v-model="search" type="search" :aria-label="tr('搜索网站偏好')" :placeholder="tr('搜索域名')" /></label>
      <div v-if="visibleRows.length" class="preference-list" role="list" :aria-label="tr('网站偏好')">
        <article v-for="row in visibleRows" :key="row.domain" role="listitem" class="preference-row" :data-site-preference="row.domain">
          <div class="preference-domain"><UiIcon name="globe" :size="18" /><div><strong data-i18n-ignore>{{ row.domain }}</strong><template v-if="settings.on"><small v-if="row.extensionDisabled && (row.alwaysTranslate || row.floatingBallHidden || row.translationOnly)">{{ tr('已禁用扩展，其他偏好暂不生效') }}</small><template v-else-if="!row.extensionDisabled"><small v-if="settings.autoTranslate && !row.alwaysTranslate">{{ tr('自动翻译 · 全局开启') }}</small><small v-if="settings.disableFloatingBall && !row.floatingBallHidden">{{ tr('悬浮球') }} · {{ tr('已隐藏 · 全局设置') }}</small></template></template></div></div>
          <div class="preference-options">
            <label><input type="checkbox" :checked="row.alwaysTranslate" :disabled="saving" :aria-label="`${tr('始终翻译')} ${row.domain}`" @change="change(row, 'alwaysTranslate', $event)" />{{ tr('始终翻译') }}</label>
            <label :title="tr('禁用扩展优先于自动翻译；关闭插件后所有偏好仍保留')"><input type="checkbox" :checked="row.extensionDisabled" :disabled="saving" :aria-label="`${tr('禁用扩展')} ${row.domain}`" @change="change(row, 'extensionDisabled', $event)" />{{ tr('禁用扩展') }}</label>
            <label :title="tr('只隐藏悬浮球时，其他功能仍可用')"><input type="checkbox" :checked="row.floatingBallHidden" :disabled="saving" :aria-label="`${tr('隐藏悬浮球')} ${row.domain}`" @change="change(row, 'floatingBallHidden', $event)" />{{ tr('隐藏悬浮球') }}</label>
            <label :title="tr('仅此网站使用仅译文，其他网站沿用全局显示模式；谷歌翻译仅支持双语')"><input type="checkbox" :checked="row.translationOnly" :disabled="saving" :aria-label="`${tr('仅显示译文')} ${row.domain}`" @change="change(row, 'translationOnly', $event)" />{{ tr('仅显示译文') }}</label>
            <button type="button" :disabled="saving" :aria-label="`${tr('移除网站偏好')} ${row.domain}`" @click="remove(row)">{{ tr('移除') }}</button>
          </div>
        </article>
      </div>
      <p v-if="!visibleRows.length" class="rule-hint" role="status">{{ tr(rows.length ? '没有匹配的网站' : '尚未添加网站偏好') }}</p>
      <div v-if="removed" class="rule-actions"><span class="rule-hint" data-i18n-ignore>{{ removed.domain }}</span><button type="button" :disabled="saving" @click="undoRemove">{{ tr('撤销移除') }}</button></div>
    </section>
  </div>
</template>
<script setup lang="ts">
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {computed, ref} from 'vue';
import UiIcon from '@/src/ui/components/UiIcon.vue';
import {getSiteBaseDomain} from '@/src/core/site-rules/domain';
import {useUiI18n} from '@/src/ui/i18n';
import {listSitePreferences, updateSitePreference, type SitePreferences, type SitePreferenceLists, type SitePreferenceRow} from '../model/sitePreferences';
const props = defineProps<{settings: SitePreferences; savePreferences: (patch: Partial<SitePreferenceLists> & {autoTranslate?: boolean}) => Promise<void>}>();
const {translateLegacy: tr} = useUiI18n();
const input = ref('');
const initialPreference = ref('always');
const search = ref('');
const saving = ref(false);
const error = ref('');
const status = ref('');
const removed = ref<SitePreferenceRow | null>(null);
const rows = computed(() => listSitePreferences(props.settings));
const visibleRows = computed(() => {
  const term = search.value.trim().toLowerCase();
  return term ? rows.value.filter(row => row.domain.includes(term)) : rows.value;
});
const normalized = computed(() => getSiteBaseDomain(input.value));
async function commit(patch: Partial<SitePreferenceLists> & {autoTranslate?: boolean}): Promise<boolean> {
  if (saving.value) return false;
  saving.value = true; error.value = ''; status.value = '';
  try {
    await props.savePreferences(patch);
    status.value = '网站偏好已保存';
    return true;
  } catch {
    error.value = '保存失败，请重试；已有偏好未被清空';
  } finally {
    saving.value = false;
  }
  return false;
}
async function addSite() {
  const domain = normalized.value;
  if (!domain) { error.value = '请输入有效的域名或 HTTP(S) 网址'; return; }
  const existing = rows.value.find(row => row.domain === domain);
  const field = initialPreference.value === 'disabled' ? 'extensionDisabled' : initialPreference.value === 'hidden' ? 'floatingBallHidden' : initialPreference.value === 'single' ? 'translationOnly' : 'alwaysTranslate';
  if (existing?.[field]) { error.value = '该网站已有此偏好，可在下方直接调整'; search.value = domain; return; }
  const row = {...existing, alwaysTranslate: existing?.alwaysTranslate ?? false, extensionDisabled: existing?.extensionDisabled ?? false, floatingBallHidden: existing?.floatingBallHidden ?? false, translationOnly: existing?.translationOnly ?? false, [field]: true};
  const patch = updateSitePreference(props.settings, domain, row)!;
  if (await commit(patch)) { input.value = ''; search.value = ''; }
}
function change(row: SitePreferenceRow, field: 'alwaysTranslate' | 'extensionDisabled' | 'floatingBallHidden' | 'translationOnly', event: Event) {
  const patch = updateSitePreference(props.settings, row.domain, {...row, [field]: (event.target as HTMLInputElement).checked});
  if (patch) void commit(patch);
}
async function remove(row: SitePreferenceRow) {
  const patch = updateSitePreference(props.settings, row.domain, null)!;
  if (await commit(patch)) removed.value = {...row};
}
async function undoRemove() {
  if (!removed.value) return;
  // 撤销只补回被移除的偏好，不覆盖之后从弹窗添加的同站偏好。
  const current = rows.value.find(row => row.domain === removed.value!.domain);
  const row = {...removed.value, alwaysTranslate: removed.value.alwaysTranslate || current?.alwaysTranslate === true,
    extensionDisabled: removed.value.extensionDisabled || current?.extensionDisabled === true,
    floatingBallHidden: removed.value.floatingBallHidden || current?.floatingBallHidden === true,
    translationOnly: removed.value.translationOnly || current?.translationOnly === true};
  if (await commit(updateSitePreference(props.settings, row.domain, row)!)) removed.value = null;
}
</script>
<style scoped>
@import './site-rule-workspace.css';
.preference-title { display: flex; align-items: center; gap: 10px; }
.preference-add { display: grid; grid-template-columns: minmax(0, 1fr) 150px auto; align-items: end; gap: 12px; margin-top: 16px; }
.preference-add .rule-field { margin: 0; }
.preference-search { max-width: 420px; }
.preference-row { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.preference-domain { display: flex; gap: 10px; align-items: center; min-width: 0; }
.preference-domain > div { display: grid; gap: 6px; min-width: 0; }
.preference-domain strong { overflow-wrap: anywhere; font-size: 13px; }
.preference-domain small { color: var(--muted); font-size: 11px; line-height: 1.6; }
.preference-options { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 16px; flex-shrink: 0; }
.preference-options label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.preference-options input { accent-color: var(--brand-strong); width: 16px; height: 16px; }
@media (max-width: 1150px) { .preference-row { align-items: flex-start; flex-direction: column; gap: 12px; } .preference-options { justify-content: flex-start; } }
@media (max-width: 650px) { .preference-add { grid-template-columns: minmax(0, 1fr); } .preference-options { gap: 12px; } }
</style>

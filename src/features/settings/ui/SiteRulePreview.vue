<!--
 * @file src/features/settings/ui/SiteRulePreview.vue
 * 文件职责：通过紧凑网址表单检查已保存的网站偏好与正文规则，检查前不展示结果占位。
 * 主要内容：通过独立标题分隔栏标明预览区域，校验完整网址、提示过期结果，展示关键开关状态、正文范围与 allScopes 条件，并提供命中规则详情入口。
 * 模块边界：仅调用纯网址判定与规则编译器，不请求网站、不检查 DOM，不宣称实际站点兼容性。
 -->
<template>
  <div class="rule-workspace" data-setting="site-rule-preview">
    <section class="rule-card" aria-labelledby="site-rule-preview-heading">
      <header class="rule-section-heading settings-card-heading"><h2 id="site-rule-preview-heading">{{ tr('生效预览') }}</h2><p>{{ tr('检查已保存规则，不访问网站') }}</p></header>
      <form class="preview-form" @submit.prevent="checkRules">
        <label class="rule-field"><span>{{ tr('输入完整网址') }}</span><input v-model="input" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/articles/hello" :aria-invalid="Boolean(checked && input === checkedUrl && !preferences)" aria-describedby="site-rule-preview-result" /></label>
        <button type="submit" class="rule-primary" :title="tr('预览仅检查已保存规则，网址匹配后能否翻译仍取决于网页结构、权限、语言过滤和翻译服务')">{{ tr('检查规则') }}</button>
      </form>
      <div id="site-rule-preview-result" aria-live="polite">
        <p v-if="checked && input !== checkedUrl" class="rule-notice">{{ tr('网址已修改，请重新检查；下方暂时显示上一次的结果') }}</p>
        <p v-if="checked && !preferences" class="rule-error" role="alert">{{ tr('请输入以 http:// 或 https:// 开头的完整网址') }}</p>
        <template v-else-if="preferences">
          <p class="preview-domain" data-i18n-ignore>{{ preferences.url }}</p>
          <div class="preview-states">
            <article><span>{{ tr('扩展功能') }}</span><strong>{{ tr(extensionLabels[preferences.extension]) }}</strong><small v-if="preferences.domain" data-i18n-ignore>{{ preferences.domain }}</small></article>
            <article><span>{{ tr('网页翻译') }}</span><strong>{{ tr(translationLabels[preferences.translation]) }}</strong></article>
            <article><span>{{ tr('译文显示') }}</span><strong>{{ tr(preferences.display === 'single' ? '仅显示译文' : '双语对照') }}</strong></article>
            <article><span>{{ tr('悬浮球') }}</span><strong>{{ tr(ballLabels[preferences.floatingBall]) }}</strong></article>
          </div>
          <section class="preview-adaptation"><h4>{{ tr('正文识别结果') }}</h4><p v-if="scope === 'all'" class="rule-hint">{{ tr('当前为全部节点识别，仅显式声明 allScopes 的适配规则参与') }}</p><p class="rule-hint" :title="preferences.extension === 'enabled' && activeRules.length ? tr(focused ? '命中限定范围规则，只翻译规则声明的正文区域；所有命中规则的保护区域共同生效' : '命中补充规则，在通用正文识别上增加指定区域，并共同保护原文区域') : undefined">{{ tr(preferences.extension !== 'enabled' ? '扩展功能未运行，匹配的正文规则暂不生效' : !adaptation.enabled ? '正文适配已关闭，将使用通用正文识别' : !activeRules.length ? '未命中启用的专属规则，将使用通用正文识别' : focused ? '限定范围：只翻译指定的正文区域' : '补充识别：在通用正文上增加指定区域') }}</p>
            <ol v-if="matches.ok && matches.rules.length" class="preview-matches"><li v-for="item in matches.rules" :key="item.rule.id" :data-preview-rule="item.rule.id"><div><strong data-i18n-ignore>{{ item.rule.name }}</strong><small>{{ tr(item.source === 'custom' ? '自定义' : '内置') }} · {{ tr(!item.applicable ? '不适用于全部节点' : !adaptation.enabled ? '适配已关闭' : !item.enabled ? '已停用' : preferences.extension !== 'enabled' ? '暂不生效' : '已启用') }} · {{ tr('优先级') }} {{ item.rule.priority ?? 0 }}</small></div><button type="button" @click="emit('inspect-rule', item.rule.id)">{{ tr('查看规则') }}</button></li></ol>
          </section>
        </template>
      </div>
    </section>
  </div>
</template>
<script setup lang="ts">
import {computed, ref} from 'vue';
import {useUiI18n} from '@/src/ui/i18n';
import {builtinSiteRulePack} from '@/src/core/site-adaptation/catalog';
import {resolveSiteRule} from '@/src/core/site-adaptation/compiler';
import type {SiteAdaptationSettings} from '@/src/core/site-adaptation/types';
import {previewSitePreferences, type SitePreferences} from '../model/sitePreferences';
import {previewSiteRules} from '../model/siteAdaptationEditor';
const props = defineProps<{settings: SitePreferences; adaptation: SiteAdaptationSettings; scope?: 'content' | 'all'}>();
const emit = defineEmits<{'inspect-rule': [id: string]}>();
const {translateLegacy: tr} = useUiI18n();
const input = ref(''); const checkedUrl = ref(''); const checked = ref(false);
function checkRules() { checkedUrl.value = input.value; checked.value = true; }
const preferences = computed(() => checked.value ? previewSitePreferences(checkedUrl.value, props.settings) : null);
const matches = computed(() => previewSiteRules(checkedUrl.value, builtinSiteRulePack, props.adaptation, props.scope));
const activeRules = computed(() => matches.value.ok ? matches.value.rules.filter(item => item.enabled) : []);
const focused = computed(() => activeRules.value.some(item => resolveSiteRule(item.source === 'custom' ? props.adaptation.custom : builtinSiteRulePack, item.rule).mode === 'focus'));
const extensionLabels = {paused: '插件已关闭', disabled: '此网站已禁用扩展', enabled: '扩展已启用'};
const translationLabels = {paused: '插件已关闭', disabled: '此网站已禁用扩展', global: '自动翻译 · 全局开启', site: '自动翻译 · 网站偏好', manual: '按需手动翻译'};
const ballLabels = {paused: '插件已关闭', disabled: '此网站已禁用扩展', 'hidden-global': '已隐藏 · 全局设置', 'hidden-site': '已隐藏 · 网站偏好', visible: '显示悬浮球'};
</script>
<style scoped>
@import './site-rule-workspace.css';
.preview-form { display: flex; align-items: end; gap: 12px; margin-top: 16px; }
.preview-form .rule-field { flex: 1; margin: 0; }
.preview-domain { padding: 15px 0; margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.preview-states { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.preview-states article { display: grid; align-content: start; gap: 6px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft); }
.preview-states span, .preview-states small { color: var(--muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.preview-states strong { font-size: 13px; line-height: 1.6; }
.preview-adaptation { margin-top: 18px; }
.preview-matches { margin: 16px 0 0; padding: 0; list-style: none; }
.preview-matches li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.preview-matches li > div { display: grid; gap: 6px; min-width: 0; }
.preview-matches strong { font-size: 13px; overflow-wrap: anywhere; }
.preview-matches small { font-size: 11px; color: var(--muted); }
@media (max-width: 850px) { .preview-states { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 650px) { .preview-form { flex-wrap: wrap; } .preview-form .rule-field { flex-basis: 100%; } }
</style>

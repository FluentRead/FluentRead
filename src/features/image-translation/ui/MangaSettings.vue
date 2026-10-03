<!--
 * @file src/features/image-translation/ui/MangaSettings.vue
 * 文件职责：组织漫画连续阅读的设置，优先展示是否开启、独立按钮和翻译选择，同页展示其他图片翻译常用开关，再按需展开资源与网站规则。
 * 主要内容：漫画开关独立于单张图片和悬浮球；可关闭或恢复独立按钮；资源按用途分组，自定义网站规则按精确地址与图片选择器添加和删除，非法输入给出就地反馈。
 * 模块边界：编辑父级配置副本，由既有设置持久化负责保存；不调用漫画翻译、不扫描其他网站、不访问会员或章节接口。
 -->
<template>
  <div class="manga-settings" data-testid="manga-settings">
    <section class="manga-settings-card">
      <header><div><h2>{{ t('漫画连续翻译') }}</h2><p>{{ t('一次开启，滚动阅读时自动继续。随时切回原图。') }}</p></div><el-switch v-model="settings.imageTranslationMangaEnabled" :disabled="!available" :aria-label="t('启用漫画连续翻译')" /></header>
      <div class="manga-setting-row"><div><strong>{{ t('独立漫画按钮') }}</strong><p>{{ t('关闭悬浮球时显示小漫画按钮。阅读和翻译时不自动弹出面板。') }}</p></div><el-switch v-model="settings.imageTranslationMangaPromptEnabled" :disabled="!available || !settings.imageTranslationMangaEnabled" :aria-label="t('独立漫画按钮')" /></div>
      <div class="manga-setting-fields">
        <label class="manga-prefetch-setting">{{ t('提前翻译后续页面') }}<select v-model.number="settings.imageTranslationMangaPrefetchPages" :disabled="!available || !settings.imageTranslationMangaEnabled" :aria-label="t('提前翻译后续页面')"><option :value="0">{{ t('只翻译当前页面') }}</option><option v-for="count in 5" :key="count" :value="count">{{ count }} {{ t('张图片') }}</option></select><small>{{ t('当前页优先，后台准备后续页面。只处理网站已加载的图片；更多页面会增加设备资源和翻译服务用量。') }}</small></label>
        <label>{{ t('翻译成') }}<select v-model="settings.to" :aria-label="t('漫画目标语言')"><option v-for="item in targetLanguages" :key="item.value" :value="item.value" data-i18n-ignore>{{ t(item.label) }}</option></select><small>{{ t('与网页默认目标语言同步') }}</small></label>
        <label>{{ t('翻译服务') }}<select v-model="settings.imageTranslationService" :aria-label="t('漫画翻译服务')"><option value="">{{ t('跟随网页翻译服务') }}</option><option v-for="item in serviceOptions" :key="item.value" :value="item.value" :disabled="item.disabled" data-i18n-ignore>{{ t(item.label) }}</option></select><small>{{ t('识别和文字清除在本地，译文质量取决于所选服务') }}</small></label>
      </div>
    </section>
    <slot />
    <details v-if="available" class="manga-settings-card manga-resources" @toggle="resourcesOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('漫画阅读资源与下载') }}</summary>
      <MangaModelSettings v-if="resourcesOpen" />
    </details>
    <slot name="resources" />
    <details class="manga-settings-card manga-sites">
      <summary>{{ t('支持的网站') }}</summary>
      <div class="manga-site"><span><strong data-i18n-ignore>MANGA Plus</strong><small>{{ t('阅读器页面 · 滚动自动翻译') }}</small></span><span class="manga-site-badge">{{ t('内置适配') }}</span></div>
      <div class="manga-site"><span><strong data-i18n-ignore>Pixiv</strong><small>{{ t('作品阅读页 · 自动识别正文图片') }}</small></span><span class="manga-site-badge">{{ t('内置适配') }}</span></div>
      <p>{{ t('其他漫画网站会自动检测图片阅读器。画布、分片或受保护的阅读器需要单独适配。') }}</p>
      <p>{{ t('进入阅读页即可识别，无需先开启普通图片翻译或悬浮球。') }}</p>
      <details><summary>{{ t('添加其他漫画网站') }}</summary><p>{{ t('仅处理阅读页里可访问的图片。可按网站结构调整图片选择器，不绕过登录或付费限制。') }}</p>
        <div v-for="(rule, index) in settings.imageTranslationMangaSites" :key="`${rule.hostname}${rule.pathPrefix}`" class="manga-custom-site"><span data-i18n-ignore>{{ rule.hostname }}{{ rule.pathPrefix }}<small>{{ rule.selector }}</small></span><button type="button" :aria-label="`${t('删除网站')} ${rule.hostname}`" @click="settings.imageTranslationMangaSites.splice(index, 1)">{{ t('删除') }}</button></div>
        <form @submit.prevent="addSite">
          <label>{{ t('阅读页或阅读路径') }}<input v-model="url" type="url" required placeholder="https://example.com/chapter/" :aria-label="t('阅读页或阅读路径')" /></label>
          <label>{{ t('漫画图片选择器') }}<input v-model="selector" required placeholder="main img, article img" :aria-label="t('漫画图片选择器')" /></label>
          <p v-if="error" role="alert" class="manga-settings-error" data-i18n-ignore>{{ t(error) }}</p><button type="submit">{{ t('添加网站') }}</button>
        </form>
      </details>
    </details>
  </div>
</template>
<script setup lang="ts">
import {ref} from 'vue';
import type {Config} from '@/src/core/config/model';
import {createMangaSiteRule, normalizeMangaSiteRules} from '@/src/core/config/manga';
import {options} from '@/src/core/config/catalog';
import {useUiI18n} from '@/src/ui/i18n';
import MangaModelSettings from './MangaModelSettings.vue';
const props = defineProps<{settings: Config; available: boolean; serviceOptions: {label: string; value: string; disabled?: boolean}[]}>();
const {translateLegacy: t} = useUiI18n();
const targetLanguages = options.to;
const url = ref(''), selector = ref('main img, article img'), error = ref('');
const resourcesOpen = ref(false);
function addSite() {
  error.value = '';
  const rule = createMangaSiteRule(url.value, selector.value);
  if (!rule) {error.value = '请输入有效的阅读页地址和图片选择器';return;}
  try {document.createDocumentFragment().querySelector(rule.selector);} catch {error.value = '图片选择器无效，请检查后重试';return;}
  if (props.settings.imageTranslationMangaSites.length >= 20) {error.value = '最多添加 20 个漫画网站规则';return;}
  props.settings.imageTranslationMangaSites = normalizeMangaSiteRules([rule, ...props.settings.imageTranslationMangaSites]);
  url.value = '';
}
</script>
<style scoped>
.manga-settings{display:grid;gap:16px}.manga-settings-card{padding:20px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary)}.manga-settings>details.manga-settings-card{border:0;padding:0;background:transparent}.manga-settings :deep(.settings-group){margin-bottom:0}.manga-settings-card>summary{cursor:pointer;font-size:14px;font-weight:600}.manga-resources[open]>summary{margin-bottom:14px}.manga-settings h2{font-size:16px;margin:0 0 6px}.manga-settings p{font-size:13px;color:var(--el-text-color-secondary);line-height:1.6;margin:4px 0}.manga-settings header,.manga-setting-row{display:flex;align-items:center;justify-content:space-between;gap:24px}.manga-setting-row{margin-top:18px;padding-top:18px;border-top:1px solid var(--el-border-color-lighter)}.manga-setting-row strong{font-size:14px}.manga-setting-fields{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:20px}.manga-prefetch-setting{grid-column:1/-1}.manga-settings label{display:grid;gap:7px;font-size:13px}.manga-settings select,.manga-settings input{width:100%;min-height:36px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary);font:inherit;padding:6px 9px}.manga-settings small{display:block;color:var(--el-text-color-secondary);font-size:12px}.manga-site{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding:12px 0}.manga-site-badge{font-size:12px;background:var(--el-color-primary-light-9);color:var(--el-color-primary);padding:3px 8px;border-radius:6px}.manga-sites details{margin-top:16px;padding-top:14px;border-top:1px solid var(--el-border-color-lighter);font-size:13px}.manga-sites summary{cursor:pointer;font-weight:600}.manga-sites form{display:grid;gap:12px;margin-top:14px}.manga-sites button{justify-self:start;font:inherit;cursor:pointer;border:1px solid var(--el-border-color);border-radius:7px;padding:6px 12px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary)}.manga-custom-site{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;overflow-wrap:anywhere}.manga-settings-error{color:var(--el-color-danger)!important}.manga-settings :is(button,select,input,summary):focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}@media(max-width:650px){.manga-settings-card{padding:16px}.manga-setting-fields{grid-template-columns:1fr}.manga-settings header,.manga-setting-row{gap:12px}}
</style>

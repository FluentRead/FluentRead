<!--
 * @file src/features/image-translation/ui/MangaSettings.vue
 * 文件职责：组织漫画连续阅读的设置，优先展示公共语言与翻译服务、单图识别方式和漫画提前翻译；入口、缓存、资源和网站规则按需展开。
 * 主要内容：图片可选择通用 Tesseract 或与漫画共用的 PaddleOCR；漫画开关独立于单张图片和悬浮球，资源按用途分组，自定义网站规则按精确地址与图片选择器添加和删除，非法输入给出就地反馈；主要模块标记页内导航目标，保留折叠区的渐进展开。
 * 模块边界：编辑父级配置副本，由既有设置持久化负责保存；不调用漫画翻译、不扫描其他网站、不访问会员或章节接口。
 -->
<template>
  <div class="manga-settings" data-testid="manga-settings">
    <section class="manga-settings-card manga-translation-options" data-settings-anchor="language-service" :data-settings-anchor-label="t('翻译服务')">
      <div class="manga-setting-fields">
        <label>{{ t('area.settings.sourceLanguage') }}<UiSelect v-model="settings.from" :aria-label="t('area.settings.sourceLanguage')"><el-option v-for="item in sourceLanguages" :key="item.value" :value="item.value" :label="t(item.label)" /></UiSelect></label>
        <label>{{ t('翻译成') }}<UiSelect v-model="settings.to" :aria-label="t('漫画目标语言')"><el-option v-for="item in targetLanguages" :key="item.value" :value="item.value" :label="t(item.label)" data-i18n-ignore>{{ t(item.label) }}</el-option></UiSelect></label>
        <label>{{ t('翻译服务') }}<UiSelect v-model="settings.imageTranslationService" :empty-values="[null, undefined]" :placeholder="t('跟随网页翻译服务')" :aria-label="t('漫画翻译服务')"><el-option value="" :label="t('跟随网页翻译服务')" /><el-option v-for="item in serviceOptions" :key="item.value" :value="item.value" :disabled="item.disabled" :label="t(item.label)" data-i18n-ignore>{{ t(item.label) }}</el-option></UiSelect></label>
      </div>
    </section>
    <section class="manga-settings-card image-recognition-settings" data-testid="image-recognition-settings" data-settings-anchor="image" :data-settings-anchor-label="t('网页图片翻译')">
      <header><div><h2>{{ t('网页图片翻译') }}</h2><p>{{ t('悬停图片或右键翻译，随时对照原图。') }}</p></div><el-switch :model-value="imageEnabled" :disabled="!available" :aria-label="t('网页图片翻译')" @update:model-value="emit('update:imageEnabled', Boolean($event))" /></header>
      <label class="manga-setting-inline">{{ t('图片识别方式') }}<UiSelect v-model="settings.imageTranslationOcrEngine" :disabled="!available" :aria-label="t('图片识别方式')"><el-option value="tesseract" :label="t('通用文字 · Tesseract')" /><el-option value="paddle" :label="t('漫画文字 · PaddleOCR')" /></UiSelect></label>
      <p class="image-engine-hint">{{ t(settings.imageTranslationOcrEngine === 'paddle' ? '适合漫画与气泡文字。首次翻译下载约 30 MB，与漫画共用，已下载无需重复下载。' : '适合截图、图表与清晰排版文字。按原文语言准备语言包。') }}</p>
    </section>
    <section class="manga-settings-card" data-settings-anchor="manga" :data-settings-anchor-label="t('漫画连续翻译')">
      <header><div><h2>{{ t('漫画连续翻译') }}</h2><p>{{ t('开启后随滚动自动翻译新页面，可随时切回原图') }}</p></div><el-switch v-model="settings.imageTranslationMangaEnabled" :disabled="!available" :aria-label="t('启用漫画连续翻译')" /></header>
      <label class="manga-setting-inline manga-prefetch-setting">{{ t('提前翻译后续页面') }}<UiSelect v-model="settings.imageTranslationMangaPrefetchPages" :disabled="!available || !settings.imageTranslationMangaEnabled" :aria-label="t('提前翻译后续页面')"><el-option :value="0" :label="t('只翻译当前页面')" /><el-option v-for="count in 5" :key="count" :value="count" :label="`${count} ${t('张图片')}`" /></UiSelect></label>
      <p>{{ t('使用 PaddleOCR，当前页优先，只提前处理已加载的图片。') }}</p>
    </section>
    <slot />
    <details class="manga-settings-card manga-advanced" data-settings-anchor="entry-cache" :data-settings-anchor-label="t('入口与缓存')">
      <summary>{{ t('入口与缓存') }}</summary>
      <div class="manga-setting-row"><strong>{{ t('image.hover') }}</strong><el-switch v-model="settings.imageTranslationHoverEnabled" :disabled="!available || settings.disableImageTranslator" :aria-label="t('image.hover')" /></div>
      <div class="manga-setting-row"><strong>{{ t('image.context') }}</strong><el-switch v-model="settings.imageTranslationContextMenuEnabled" :disabled="!available || settings.disableImageTranslator" :aria-label="t('image.context')" /></div>
      <div class="manga-setting-row"><div><strong>{{ t('独立漫画按钮') }}</strong><p>{{ t('隐藏悬浮球时显示独立漫画按钮，阅读和翻译过程中不会自动弹出面板') }}</p></div><el-switch v-model="settings.imageTranslationMangaPromptEnabled" :disabled="!available || !settings.imageTranslationMangaEnabled" :aria-label="t('独立漫画按钮')" /></div>
      <label class="manga-setting-inline manga-cache-setting">{{ t('快速缓存图片数量') }}<UiSelect v-model="settings.imageTranslationMangaCachePages" :disabled="!available || !settings.imageTranslationMangaEnabled || !settings.useCache" :aria-label="t('快速缓存图片数量')"><el-option v-for="count in 24" :key="count" :value="count" :label="`${count} ${t('张图片')}`" /></UiSelect></label><small>{{ t('最近页面直接显示。较早页面保留轻量缓存，返回时自动恢复；大图会按内存预算减少快速缓存数量。') }}</small>
    </details>
    <details v-if="available" class="manga-settings-card manga-resources" data-settings-anchor="resources" :data-settings-anchor-label="t('识别资源与下载')" @toggle="resourcesOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('识别资源与下载') }}</summary>
      <template v-if="resourcesOpen"><MangaModelSettings v-if="settings.imageTranslationMangaEnabled || settings.imageTranslationOcrEngine === 'paddle'" :show-inpainting="settings.imageTranslationMangaEnabled" /><slot name="resources" /></template>
    </details>
    <details class="manga-settings-card manga-sites" data-settings-anchor="sites" :data-settings-anchor-label="t('支持的网站')">
      <summary>{{ t('支持的网站') }}</summary>
      <div class="manga-site"><span><strong data-i18n-ignore>MANGA Plus</strong><small>{{ t('阅读器页面 · 滚动自动翻译') }}</small></span><span class="manga-site-badge">{{ t('内置适配') }}</span></div>
      <div class="manga-site"><span><strong data-i18n-ignore>Pixiv</strong><small>{{ t('作品阅读页 · 自动识别正文图片') }}</small></span><span class="manga-site-badge">{{ t('内置适配') }}</span></div>
      <p>{{ t('其他漫画网站会自动检测图片阅读器，画布、分片或受保护的阅读器需单独适配') }}</p>
      <p>{{ t('进入阅读页即可识别，无需先开启普通图片翻译或悬浮球') }}</p>
      <details><summary>{{ t('添加其他漫画网站') }}</summary><p>{{ t('仅翻译阅读页中可访问的图片，可按网站结构调整图片选择器，不会绕过登录或付费限制') }}</p>
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
import UiSelect from '@/src/ui/components/UiSelect.vue';
import MangaModelSettings from './MangaModelSettings.vue';
const props = defineProps<{settings: Config; imageEnabled: boolean; available: boolean; serviceOptions: {label: string; value: string; disabled?: boolean}[]}>();
const emit = defineEmits<{'update:imageEnabled': [enabled: boolean]}>();
const {t: message, translateLegacy} = useUiI18n();
const t = (source: string) => /^(image|area)\./.test(source) ? message(source) : translateLegacy(source);
const targetLanguages = options.to, sourceLanguages = options.from;
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
.manga-settings{display:grid;gap:12px}.manga-settings-card{padding:16px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary)}.manga-settings>details.manga-settings-card{padding:12px 16px}.manga-settings :deep(.settings-group){margin-bottom:0}.manga-settings-card>summary{cursor:pointer;font-size:14px;font-weight:600}.manga-settings>details.manga-settings-card>summary{border:0;padding:0;min-height:32px;background:transparent}.manga-settings>details.manga-settings-card[open]>summary{margin-bottom:12px}.manga-resources[open]>summary{margin-bottom:14px}.manga-settings h2{font-size:16px;margin:0 0 6px}.manga-settings p{font-size:13px;color:var(--el-text-color-secondary);line-height:1.6;margin:4px 0}.manga-settings header,.manga-setting-row{display:flex;align-items:center;justify-content:space-between;gap:24px}.manga-setting-row{margin-top:18px;padding-top:18px;border-top:1px solid var(--el-border-color-lighter)}.manga-setting-row strong{font-size:14px}.manga-setting-fields{display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:14px;margin-top:0}.manga-setting-inline{display:grid!important;grid-template-columns:minmax(140px,1fr) minmax(180px,320px);align-items:center;gap:16px!important;margin:14px 0 7px}.manga-settings .image-engine-hint{font-size:12px}.manga-resources :deep(.image-ocr-section){margin-top:16px;border-top:1px solid var(--el-border-color-lighter);padding-top:16px}.manga-settings label{display:grid;gap:7px;font-size:13px}.manga-settings input{width:100%;min-height:36px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary);font:inherit;padding:6px 9px}.manga-settings small{display:block;color:var(--el-text-color-secondary);font-size:12px}.manga-site{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding:12px 0}.manga-site-badge{font-size:12px;background:var(--el-color-primary-light-9);color:var(--el-color-primary);padding:3px 8px;border-radius:6px}.manga-sites details{margin-top:16px;padding-top:14px;border-top:1px solid var(--el-border-color-lighter);font-size:13px}.manga-sites summary{cursor:pointer;font-weight:600}.manga-sites form{display:grid;gap:12px;margin-top:14px}.manga-sites button{justify-self:start;font:inherit;cursor:pointer;border:1px solid var(--el-border-color);border-radius:7px;padding:6px 12px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary)}.manga-custom-site{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;overflow-wrap:anywhere}.manga-settings-error{color:var(--el-color-danger)!important}.manga-settings :is(button,select,input,summary):focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}@media(max-width:650px){.manga-settings-card{padding:16px}.manga-setting-fields,.manga-setting-inline{grid-template-columns:1fr}.manga-settings header,.manga-setting-row{gap:12px}}
</style>

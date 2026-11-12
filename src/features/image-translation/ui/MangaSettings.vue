<!--
 * @file src/features/image-translation/ui/MangaSettings.vue
 * 图片与漫画共用的本地处理后端通过父配置保存；选择本身不下载或初始化模型。
 * 文件职责：组织漫画连续阅读的设置，优先展示公共语言与翻译服务、单图识别方式和漫画提前翻译；直接呈现入口、缓存、资源状态和可搜索的完整网站清单。
 * 主要内容：图片识别方式和图片入口、漫画提前翻译和按钮及缓存分别归入对应预览右侧，漫画开关独立于单张图片和悬浮球；共享资源在单层设置框中按用途分隔，自定义网站规则按精确地址与图片选择器添加和删除，非法输入给出就地反馈；主要模块标记页内导航目标，备用模型、语言包管理、离线导入和自定义规则按需展开。
 * 模块边界：编辑父级配置副本，由既有设置持久化负责保存；不调用漫画翻译、不扫描其他网站、不访问会员或章节接口。
 -->
<template>
  <div class="manga-settings" data-testid="manga-settings">
    <SettingsGroup class="manga-translation-options" :title="t('image.settings.languageServiceTitle')" :description="t('原语言和目标语言与网页翻译共用；图片与漫画共用这里的翻译服务。')" data-settings-anchor="language-service" :data-settings-anchor-label="t('image.settings.languageServiceTitle')">
      <SettingsItem :label="t('area.settings.sourceLanguage')"><UiSelect v-model="settings.from" :aria-label="t('area.settings.sourceLanguage')"><el-option v-for="item in sourceLanguages" :key="item.value" :value="item.value" :label="t(item.label)" /></UiSelect></SettingsItem>
      <SettingsItem :label="t('翻译成')"><UiSelect v-model="settings.to" :aria-label="t('漫画目标语言')"><el-option v-for="item in targetLanguages" :key="item.value" :value="item.value" :label="t(item.label)" data-i18n-ignore>{{ t(item.label) }}</el-option></UiSelect></SettingsItem>
      <SettingsItem :label="t('翻译服务')"><UiSelect v-model="settings.imageTranslationService" :empty-values="[null, undefined]" :placeholder="t('跟随网页翻译服务')" :aria-label="t('漫画翻译服务')"><el-option value="" :label="t('跟随网页翻译服务')" /><el-option v-for="item in serviceOptions" :key="item.value" :value="item.value" :disabled="item.disabled" :label="t(item.label)" data-i18n-ignore>{{ t(item.label) }}</el-option></UiSelect></SettingsItem>
      <SettingsItem :label="t('本地处理后端')" :description="t('图片与漫画共用。浏览器卡顿时可选 CPU（WASM），下次处理生效。')"><UiSelect v-model="settings.imageTranslationInferenceBackend" :disabled="!available" :aria-label="t('本地处理后端')"><el-option value="auto" :label="t('自动')" /><el-option value="cpu" :label="t('CPU（WASM）')" /></UiSelect></SettingsItem>
    </SettingsGroup>
    <SettingsGroup class="image-recognition-settings" data-testid="image-recognition-settings" data-settings-anchor="image" :data-settings-anchor-label="t('网页图片翻译')">
      <FeatureEnableCard :model-value="imageEnabled" :disabled="!available" :title="t('网页图片翻译')" :description="t('悬停图片或右键翻译，随时对照原图。')" @update:model-value="emit('update:imageEnabled', $event)" />
      <SettingsPreviewLayout :label="t('图片翻译效果预览')">
        <template #preview><ImageTranslationSettingsPreview /></template>
        <div class="manga-preview-preferences">
          <SettingsItem :label="t('图片识别方式')" :description="t(settings.imageTranslationOcrEngine === 'paddle' ? '适合普通图片、截图和漫画文字。首次翻译下载约 30 MB，与漫画共用，已下载无需重复下载。' : '适合截图、图表与清晰排版文字。按原文语言准备语言包。')" stacked>
            <UiSelect v-model="settings.imageTranslationOcrEngine" :disabled="!available" :aria-label="t('图片识别方式')"><el-option value="paddle" :label="t('PaddleOCR（标准模型）')" /><el-option value="tesseract" :label="t('Tesseract（轻量模型）')" /></UiSelect>
          </SettingsItem>
          <SettingsItem :label="t('image.hover')" :description="t('鼠标停在图片上时显示翻译入口')" :disabled="!available || !imageEnabled"><el-switch v-model="settings.imageTranslationHoverEnabled" :disabled="!available || !imageEnabled" :aria-label="t('image.hover')" /></SettingsItem>
          <SettingsItem :label="t('image.context')" :description="t('右键点击图片时提供翻译操作')" :disabled="!available || !imageEnabled"><el-switch v-model="settings.imageTranslationContextMenuEnabled" :disabled="!available || !imageEnabled" :aria-label="t('image.context')" /></SettingsItem>
        </div>
      </SettingsPreviewLayout>
    </SettingsGroup>
    <SettingsGroup data-settings-anchor="manga" :data-settings-anchor-label="t('漫画连续翻译')">
      <FeatureEnableCard v-model="settings.imageTranslationMangaEnabled" :disabled="!available" :title="t('漫画连续翻译')" :description="t('开启后随滚动自动翻译新页面，可随时切回原图')" />
      <SettingsPreviewLayout :label="t('漫画翻译效果预览')">
        <template #preview><ImageTranslationSettingsPreview manga /></template>
        <div class="manga-preview-preferences">
          <SettingsItem :label="t('提前翻译后续页面')" :description="t('按原文语言选择识别资源，当前页优先，只提前处理已加载的图片。')" stacked>
            <UiSelect v-model="settings.imageTranslationMangaPrefetchPages" :disabled="!available || !settings.imageTranslationMangaEnabled" :aria-label="t('提前翻译后续页面')"><el-option :value="0" :label="t('只翻译当前页面')" /><el-option v-for="count in 5" :key="count" :value="count" :label="`${count} ${t('张图片')}`" /></UiSelect>
          </SettingsItem>
          <SettingsItem :label="t('独立漫画按钮')" :description="t('隐藏悬浮球时显示独立漫画按钮，阅读和翻译过程中不会自动弹出面板')" :disabled="!available || !settings.imageTranslationMangaEnabled"><el-switch v-model="settings.imageTranslationMangaPromptEnabled" :disabled="!available || !settings.imageTranslationMangaEnabled" :aria-label="t('独立漫画按钮')" /></SettingsItem>
          <SettingsItem :label="t('快速缓存图片数量')" :description="t(settings.useCache ? '最近页面直接显示。较早页面保留轻量缓存，返回时自动恢复；大图会按内存预算减少快速缓存数量。' : '翻译缓存已关闭；开启通用设置中的翻译缓存后可调整。')" stacked :disabled="!available || !settings.imageTranslationMangaEnabled || !settings.useCache"><UiSelect v-model="settings.imageTranslationMangaCachePages" :disabled="!available || !settings.imageTranslationMangaEnabled || !settings.useCache" :aria-label="t('快速缓存图片数量')"><el-option v-for="count in 24" :key="count" :value="count" :label="`${count} ${t('张图片')}`" /></UiSelect></SettingsItem>
        </div>
      </SettingsPreviewLayout>
    </SettingsGroup>
    <slot />
    <SettingsGroup v-if="available" :title="t('识别资源')" data-settings-anchor="resources" :data-settings-anchor-label="t('识别资源')">
      <div class="manga-resource-body"><MangaModelSettings v-if="settings.imageTranslationMangaEnabled || settings.imageTranslationOcrEngine === 'paddle'" embedded :image-recognition="settings.imageTranslationOcrEngine === 'paddle'" :show-inpainting="settings.imageTranslationMangaEnabled" /><slot name="resources" /></div>
    </SettingsGroup>
    <section class="manga-settings-card manga-sites" data-settings-anchor="sites" :data-settings-anchor-label="t('支持的网站')">
      <header class="settings-card-heading"><h2>{{ t('支持的网站') }}</h2></header>
      <p>{{ t('正文图片自动检测；画布或分片阅读页可圈选翻译。部分网站可能停服、限制访问或要求登录。') }}</p>
      <label class="manga-site-search">{{ t('搜索网站名称或域名') }}<input v-model="siteSearch" type="search" :aria-label="t('搜索网站名称或域名')" /></label>
      <small data-i18n-ignore>{{ filteredSites.length }} / {{ MANGA_SITE_CATALOG.length }}</small>
      <div class="manga-site-list">
        <div v-for="site in filteredSites" :key="site.name" class="manga-site"><span><strong data-i18n-ignore>{{ site.name }}</strong><small data-i18n-ignore>{{ site.hosts.join(' · ') || t('域名待确认') }}</small></span><span class="manga-site-badge">{{ siteBadge(site) }}</span></div>
        <p v-if="filteredSites.length === 0">{{ t('没有匹配的网站') }}</p>
      </div>
      <p>{{ t('进入阅读页即可识别，无需先开启普通图片翻译或悬浮球') }}</p>
      <details><summary>{{ t('添加其他漫画网站') }}</summary><p>{{ t('仅翻译阅读页中可访问的图片，可按网站结构调整图片选择器，不会绕过登录或付费限制') }}</p>
        <div v-for="(rule, index) in settings.imageTranslationMangaSites" :key="`${rule.hostname}${rule.pathPrefix}`" class="manga-custom-site"><span data-i18n-ignore>{{ rule.hostname }}{{ rule.pathPrefix }}<small>{{ rule.selector }}</small></span><button type="button" :aria-label="`${t('删除网站')} ${rule.hostname}`" @click="settings.imageTranslationMangaSites.splice(index, 1)">{{ t('删除') }}</button></div>
        <form @submit.prevent="addSite">
          <label>{{ t('阅读页或阅读路径') }}<input v-model="url" type="url" required placeholder="https://example.com/chapter/" :aria-label="t('阅读页或阅读路径')" /></label>
          <label>{{ t('漫画图片选择器') }}<input v-model="selector" required placeholder="main img, article img" :aria-label="t('漫画图片选择器')" /></label>
          <p v-if="error" role="alert" class="manga-settings-error" data-i18n-ignore>{{ t(error) }}</p><button type="submit">{{ t('添加网站') }}</button>
        </form>
      </details>
    </section>
  </div>
</template>
<script setup lang="ts">
import {computed, ref} from 'vue';
import type {Config} from '@/src/core/config/model';
import {createMangaSiteRule, normalizeMangaSiteRules} from '@/src/core/config/manga';
import {MANGA_SITE_CATALOG} from '@/src/core/config/mangaSiteCatalog';
import {MANGA_AREA_READER_HOSTS, MANGA_CANVAS_READER_HOSTS, MANGA_BACKGROUND_READER_HOSTS} from '@/src/core/config/mangaReaderProfiles';
import {options} from '@/src/core/config/catalog';
import {useUiI18n} from '@/src/ui/i18n';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {SettingsGroup, SettingsItem, SettingsPreviewLayout} from '@/src/features/settings/public';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import ImageTranslationSettingsPreview from './ImageTranslationSettingsPreview.vue';
import MangaModelSettings from './MangaModelSettings.vue';
const props = defineProps<{settings: Config; imageEnabled: boolean; available: boolean; serviceOptions: {label: string; value: string; disabled?: boolean}[]}>();
const emit = defineEmits<{'update:imageEnabled': [enabled: boolean]}>();
const {t: message, translateLegacy} = useUiI18n();
const t = (source: string) => /^(image|area)\./.test(source) ? message(source) : translateLegacy(source);
const targetLanguages = options.to, sourceLanguages = options.from;
const url = ref(''), selector = ref('main img, article img'), error = ref('');
const siteSearch = ref('');
const filteredSites = computed(() => {
  const search = siteSearch.value.trim().toLocaleLowerCase();
  return MANGA_SITE_CATALOG.filter(site => `${site.name} ${site.hosts.join(' ')}`.toLocaleLowerCase().includes(search));
});
function siteBadge({hosts, name}: typeof MANGA_SITE_CATALOG[number]): string {
  if (hosts.length === 0) return t('域名待确认');
  if (hosts.some(host => MANGA_AREA_READER_HOSTS.includes(host))) return t('画布或分片 · 圈选翻译');
  if (hosts.some(host => MANGA_CANVAS_READER_HOSTS.includes(host) || MANGA_BACKGROUND_READER_HOSTS.includes(host))
      || ['Pixiv', 'MANGA Plus by SHUEISHA'].includes(name)) return t('内置适配');
  return t('已登记图片阅读器');
}
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
.manga-site-list{max-height:340px;overflow-y:auto;overscroll-behavior:contain;margin-top:8px}.manga-site-list .manga-site{gap:12px;margin:0;padding:10px 0;border-bottom:1px solid var(--el-border-color-lighter)}.manga-site-list .manga-site>span:first-child{min-width:0;overflow-wrap:anywhere}.manga-site-list .manga-site-badge{flex-shrink:0;max-width:45%;text-align:center}.manga-site-search{margin:12px 0 6px}
.manga-settings{display:grid;gap:12px}.manga-settings-card{padding:16px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary)}.manga-settings>details.manga-settings-card{padding:12px 16px}.manga-settings :deep(.settings-group){margin-bottom:0}.manga-settings-card>summary{cursor:pointer;font-size:14px;font-weight:600}.manga-settings>details.manga-settings-card>summary{border:0;padding:0;min-height:32px;background:transparent}.manga-settings>details.manga-settings-card[open]>summary{margin-bottom:12px}.manga-resources[open]>summary{margin-bottom:14px}.manga-settings h2{font-size:16px;margin:0 0 6px}.manga-settings p{font-size:13px;color:var(--el-text-color-secondary);line-height:1.6;margin:4px 0}.manga-settings header,.manga-setting-row{display:flex;align-items:center;justify-content:space-between;gap:24px}.manga-setting-row{margin-top:18px;padding-top:18px;border-top:1px solid var(--el-border-color-lighter)}.manga-setting-row strong{font-size:14px}.manga-setting-fields{display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:14px;margin-top:0}.manga-setting-inline{display:grid!important;grid-template-columns:minmax(140px,1fr) minmax(180px,320px);align-items:center;gap:16px!important;margin:14px 0 7px}.manga-settings .image-engine-hint{font-size:12px}.manga-resources :deep(.image-ocr-section){margin-top:16px;border-top:1px solid var(--el-border-color-lighter);padding-top:16px}.manga-settings label{display:grid;gap:7px;font-size:13px}.manga-settings input{width:100%;min-height:36px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary);font:inherit;padding:6px 9px}.manga-settings small{display:block;color:var(--el-text-color-secondary);font-size:12px}.manga-site{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding:12px 0}.manga-site-badge{font-size:12px;background:var(--el-color-primary-light-9);color:var(--el-color-primary);padding:3px 8px;border-radius:6px}.manga-sites details{margin-top:16px;padding-top:14px;border-top:1px solid var(--el-border-color-lighter);font-size:13px}.manga-sites summary{cursor:pointer;font-weight:600}.manga-sites form{display:grid;gap:12px;margin-top:14px}.manga-sites button{justify-self:start;font:inherit;cursor:pointer;border:1px solid var(--el-border-color);border-radius:7px;padding:6px 12px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary)}.manga-custom-site{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;overflow-wrap:anywhere}.manga-settings-error{color:var(--el-color-danger)!important}.manga-settings :is(button,select,input,summary):focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}@media(max-width:650px){.manga-settings-card{padding:16px}.manga-setting-fields,.manga-setting-inline{grid-template-columns:1fr}.manga-settings header,.manga-setting-row{gap:12px}}
.manga-settings { width:min(100%,1080px); margin-inline:auto; gap:20px; }
.manga-settings-card { border-color:var(--line); border-radius:10px; background:var(--surface); }
.manga-resource-body { padding:20px; }
.manga-preview-preferences :deep(.settings-item) { grid-template-columns:minmax(0,1fr) auto; padding:16px 0; gap:12px; }
.manga-preview-preferences :deep(.settings-item:first-child) { padding-top:0; }
.manga-preview-preferences :deep(.settings-item.stacked) { grid-template-columns:minmax(0,1fr); }
.manga-preview-preferences p { margin-top:16px; font-size:12px; color:var(--muted); }
@media(max-width:480px) { .manga-resource-body { padding:14px 12px; } }
.manga-settings-card > header.settings-card-heading { margin:-16px -16px 14px; padding:12px 20px; border-bottom:1px solid var(--line); border-radius:11px 11px 0 0; }
</style>

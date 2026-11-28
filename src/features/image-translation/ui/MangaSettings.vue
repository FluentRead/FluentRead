<!--
 * @file src/features/image-translation/ui/MangaSettings.vue
 * 文件职责：以分层方式组织网页图片翻译、漫画连续翻译、圈选区域及按需展开的识别资源与支持网站列表。
 * 主要内容：关闭网页图片或漫画开关时收起下属配置；移除重复的全局语言/翻译服务选择、重复右键开关与静态装饰预览，识别后端、本地模型、OCR 语言包与漫画网站目录收进默认折叠的进阶分组。
 * 模块边界：编辑父级配置副本，由既有设置持久化负责保存；不调用漫画翻译、不扫描其他网站、不访问会员或章节接口。
 -->
<template>
  <div class="manga-settings" data-testid="manga-settings">
    <SettingsGroup class="image-recognition-settings" data-testid="image-recognition-settings" data-settings-anchor="image" :data-settings-anchor-label="t('网页图片翻译')">
      <FeatureEnableCard :model-value="imageEnabled" :disabled="!available" :title="t('网页图片翻译')" :description="t('悬停图片或右键翻译，随时对照原图。')" @update:model-value="emit('update:imageEnabled', $event)" />
      <template v-if="imageEnabled">
        <SettingsItem :label="t('图片识别方式')" :description="t(imageOcrEngine === 'paddle' ? '适合普通图片、截图和漫画文字。首次使用下载约 30 MB，与漫画共用。' : '适合截图、图表与清晰排版文字，按原文语言准备语言包。')">
          <UiSelect v-model="imageOcrEngine" :disabled="!available" :aria-label="t('图片识别方式')">
            <el-option value="paddle" :label="t('PaddleOCR（标准模型）')" :disabled="!paddleSupportsSource" />
            <el-option value="tesseract" :label="t('Tesseract（轻量模型）')" />
          </UiSelect>
        </SettingsItem>
        <SettingsItem :label="t('image.hover')" :description="t('鼠标停在图片上时显示翻译入口')" :disabled="!available">
          <el-switch v-model="settings.imageTranslationHoverEnabled" :disabled="!available" :aria-label="t('image.hover')" />
        </SettingsItem>
      </template>
    </SettingsGroup>

    <SettingsGroup data-settings-anchor="manga" :data-settings-anchor-label="t('漫画连续翻译')">
      <FeatureEnableCard v-model="settings.imageTranslationMangaEnabled" :disabled="!available" :title="t('漫画连续翻译')" :description="t('开启后随滚动自动翻译新页面，可随时切回原图')" />
      <template v-if="settings.imageTranslationMangaEnabled">
        <SettingsItem :label="t('提前翻译后续页面')" :description="t('当前页优先，只提前处理已加载的图片')">
          <UiSelect v-model="settings.imageTranslationMangaPrefetchPages" :disabled="!available" :aria-label="t('提前翻译后续页面')">
            <el-option :value="0" :label="t('只翻译当前页面')" />
            <el-option v-for="count in 5" :key="count" :value="count" :label="`${count} ${t('张图片')}`" />
          </UiSelect>
        </SettingsItem>
        <SettingsItem :label="t('独立漫画按钮')" :description="t('隐藏悬浮球时显示独立漫画按钮')" :disabled="!available">
          <el-switch v-model="settings.imageTranslationMangaPromptEnabled" :disabled="!available" :aria-label="t('独立漫画按钮')" />
        </SettingsItem>
        <SettingsItem :label="t('快速缓存图片数量')" :description="t(settings.useCache ? '最近页面直接显示，返回时自动恢复' : '翻译缓存已关闭；开启高级与隐私中的翻译缓存后可调整')" :disabled="!available || !settings.useCache">
          <UiSelect v-model="settings.imageTranslationMangaCachePages" :disabled="!available || !settings.useCache" :aria-label="t('快速缓存图片数量')">
            <el-option v-for="count in 24" :key="count" :value="count" :label="`${count} ${t('张图片')}`" />
          </UiSelect>
        </SettingsItem>
      </template>
    </SettingsGroup>

    <slot />

    <SettingsDisclosure v-if="available" :title="message('settings.image.resourcesTitle')" :status="imageOcrEngine === 'paddle' ? 'PaddleOCR' : 'Tesseract'" data-settings-anchor="resources" :data-settings-anchor-label="t('识别资源')">
      <SettingsItem :label="t('本地处理后端')" :description="t('浏览器卡顿时可选 CPU（WASM），下次处理生效')">
        <UiSelect v-model="settings.imageTranslationInferenceBackend" :disabled="!available" :aria-label="t('本地处理后端')">
          <el-option value="auto" :label="t('自动')" />
          <el-option value="cpu" :label="t('CPU（WASM）')" />
        </UiSelect>
      </SettingsItem>
      <div class="manga-resource-body">
        <template v-for="resource in resourceOrder" :key="resource">
          <slot v-if="resource === 'language-packs'" name="resources" />
          <MangaModelSettings v-else-if="settings.imageTranslationMangaEnabled || imageOcrEngine === 'paddle'"
                              embedded :image-recognition="imageOcrEngine === 'paddle'" :manga-recognition="paddleSupportsSource"
                              :show-inpainting="settings.imageTranslationMangaEnabled" />
        </template>
      </div>
    </SettingsDisclosure>

    <SettingsDisclosure :title="message('settings.image.sitesTitle')" :status="`${MANGA_SITE_CATALOG.length}`" data-settings-anchor="sites" :data-settings-anchor-label="t('支持的网站')">
      <div class="manga-sites">
        <p>{{ t('正文图片自动检测；画布或分片阅读页可圈选翻译。部分网站可能停服、限制访问或要求登录。') }}</p>
        <label class="manga-site-search">{{ t('搜索网站名称或域名') }}<input v-model="siteSearch" type="search" :aria-label="t('搜索网站名称或域名')" /></label>
        <small data-i18n-ignore>{{ filteredSites.length }} / {{ MANGA_SITE_CATALOG.length }}</small>
        <div class="manga-site-list">
          <div v-for="site in filteredSites" :key="site.name" class="manga-site"><span><strong data-i18n-ignore>{{ site.name }}</strong><small data-i18n-ignore>{{ site.hosts.join(' · ') || t('域名待确认') }}</small></span><span class="manga-site-badge">{{ siteBadge(site) }}</span></div>
          <p v-if="filteredSites.length === 0">{{ t('没有匹配的网站') }}</p>
        </div>
        <details class="manga-custom-sites-details"><summary>{{ t('添加其他漫画网站') }}</summary>
          <p>{{ t('仅翻译阅读页中可访问的图片，可按网站结构调整图片选择器，不会绕过登录或付费限制') }}</p>
          <div v-for="(rule, index) in settings.imageTranslationMangaSites" :key="`${rule.hostname}${rule.pathPrefix}`" class="manga-custom-site"><span data-i18n-ignore>{{ rule.hostname }}{{ rule.pathPrefix }}<small>{{ rule.selector }}</small></span><button type="button" :aria-label="`${t('删除网站')} ${rule.hostname}`" @click="settings.imageTranslationMangaSites.splice(index, 1)">{{ t('删除') }}</button></div>
          <form @submit.prevent="addSite">
            <label>{{ t('阅读页或阅读路径') }}<input v-model="url" type="url" required placeholder="https://example.com/chapter/" :aria-label="t('阅读页或阅读路径')" /></label>
            <label>{{ t('漫画图片选择器') }}<input v-model="selector" required placeholder="main img, article img" :aria-label="t('漫画图片选择器')" /></label>
            <p v-if="error" role="alert" class="manga-settings-error" data-i18n-ignore>{{ t(error) }}</p><button type="submit">{{ t('添加网站') }}</button>
          </form>
        </details>
      </div>
    </SettingsDisclosure>
  </div>
</template>
<script setup lang="ts">
import {computed, ref} from 'vue';
import type {Config} from '@/src/core/config/model';
import {createMangaSiteRule, normalizeMangaSiteRules} from '@/src/core/config/manga';
import {MANGA_SITE_CATALOG} from '@/src/core/config/mangaSiteCatalog';
import {MANGA_AREA_READER_HOSTS, MANGA_CANVAS_READER_HOSTS, MANGA_BACKGROUND_READER_HOSTS} from '@/src/core/config/mangaReaderProfiles';
import {useUiI18n} from '@/src/ui/i18n';
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {SettingsGroup, SettingsDisclosure, SettingsItem} from '@/src/features/settings/public';
import FeatureEnableCard from '@/src/ui/components/FeatureEnableCard.vue';
import MangaModelSettings from './MangaModelSettings.vue';
import {getImageOcrEngine, getMangaOcrEngine} from '../ocrLanguages';

const props = defineProps<{settings: Config; imageEnabled: boolean; available: boolean; serviceOptions: {label: string; value: string; disabled?: boolean}[]}>();
const emit = defineEmits<{'update:imageEnabled': [enabled: boolean]}>();
const {t: message, translateLegacy} = useUiI18n();
const t = (source: string) => /^(image|area)\./.test(source) ? message(source) : translateLegacy(source);
const paddleSupportsSource = computed(() => getMangaOcrEngine(props.settings.from) === 'paddle');
const imageOcrEngine = computed({
  get: () => getImageOcrEngine(props.settings.from, props.settings.imageTranslationOcrEngine),
  set: engine => {props.settings.imageTranslationOcrEngine = engine;},
});
const resourceOrder = computed(() => imageOcrEngine.value === 'paddle'
  ? ['local-models', 'language-packs']
  : ['language-packs', 'local-models']);
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
.manga-settings { display: grid; width: min(100%, 1080px); margin-inline: auto; gap: 20px; }
.manga-settings :deep(.settings-group), .manga-settings :deep(.settings-disclosure) { margin-bottom: 0; }
.manga-resource-body { padding: 16px 20px 20px; border-top: 1px solid var(--line); }
.manga-resource-body > :deep(:is(.image-ocr-section, .manga-model-settings):not(:first-child)) { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.manga-sites { padding: 16px 20px 20px; }
.manga-sites p { font-size: 12.5px; color: var(--muted); line-height: 1.6; margin: 0 0 10px; }
.manga-sites label { display: grid; gap: 6px; font-size: 12.5px; color: var(--ink); }
.manga-sites input { width: 100%; min-height: 36px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; padding: 6px 10px; box-sizing: border-box; }
.manga-sites small { display: block; color: var(--muted); font-size: 11.5px; }
.manga-site-search { margin: 8px 0 6px; }
.manga-site-list { max-height: 320px; overflow-y: auto; overscroll-behavior: contain; margin-top: 8px; }
.manga-site { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.manga-site > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.manga-site-badge { flex-shrink: 0; max-width: 45%; font-size: 11.5px; background: var(--brand-soft); color: var(--brand-strong); padding: 3px 8px; border-radius: 6px; text-align: center; }
.manga-custom-sites-details { margin-top: 14px; }
.manga-custom-sites-details form { display: grid; gap: 12px; margin-top: 12px; }
.manga-custom-sites-details button { justify-self: start; font: inherit; cursor: pointer; border: 1px solid var(--line); border-radius: 7px; padding: 6px 12px; background: var(--surface); color: var(--ink); font-size: 12px; }
.manga-custom-site { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; overflow-wrap: anywhere; font-size: 12.5px; }
.manga-settings-error { color: var(--el-color-danger) !important; }
@media (max-width: 480px) { .manga-resource-body, .manga-sites { padding: 14px 12px; } }
</style>

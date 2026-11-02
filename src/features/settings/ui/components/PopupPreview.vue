<!--
@file src/features/settings/ui/components/PopupPreview.vue
文件职责：用真实 DOM 按菜单栏的实际结构、尺寸和皮肤变量还原一份 Popup，供风格预览和菜单栏布局预览共用，保证两处看到的是同一个界面。
主要内容：优先复用脚本构建注入的品牌图标并保留扩展资源回退，依次绘制品牌与版本、赞赏图标、受支持时的侧边栏图标和设置、语言与服务、网页及局部翻译、站点开关、快捷入口卡片和底部信息栏；按构建与实际平台能力过滤专属入口，区域与快捷入口按传入顺序渲染，传入编辑层级和排序控制器时叠加拖动手柄与插入提示。
模块边界：只负责展示与把排序手势交给外部控制器，不读取用户配置、不连接浏览器状态，也不执行菜单栏业务；范例里的服务、快捷键和开关状态是固定示意，不代表用户当前设置。
-->
<template>
  <div
    class="preview-popup"
    :class="{editing: Boolean(editScope)}"
    :data-preview-skin="skin.value"
    :data-preview-kind="skin.kind"
    :data-preview-popup-width="skin.popupWidth"
  >
    <header class="preview-header" aria-hidden="true">
      <span class="preview-brand">
        <img class="preview-logo" :src="iconUrl" alt="" width="32" height="32" />
        <span><strong>{{ t('common.brand') }}</strong><small>v{{ version }}</small></span>
      </span>
      <span class="preview-header-actions">
        <span class="preview-header-icon"><Coffee /></span>
        <span v-if="sidepanelAvailable" class="preview-header-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><path d="M12.5 3.5v13M5.5 8h4M5.5 11h4"/></svg></span>
        <span><Setting />{{ translateLegacy('设置') }}</span>
      </span>
    </header>

    <div class="preview-flow">
      <template v-for="module in orderedModules" :key="module.id">
        <PopupLayoutPreviewItem
          v-if="module.id === 'translation'"
          as="section"
          :item="module"
          :editable="editScope === 'popupModule'"
          :controller="moduleDrag"
          class="preview-hero"
          data-preview-popup-module="translation"
        >
          <div class="preview-language-pair" aria-hidden="true">
            <span class="preview-language">
              <small>{{ t('popup.sourceLanguage') }}</small>
              <span class="preview-language-select"><strong>{{ translateLegacy('自动检测') }}</strong><i /></span>
            </span>
            <b>→</b>
            <span class="preview-language">
              <small>{{ t('popup.targetLanguage') }}</small>
              <span class="preview-language-select"><strong>{{ translateLegacy('简体中文') }}</strong><i /></span>
            </span>
          </div>

          <div class="preview-service" aria-hidden="true">
            <strong>{{ t('popup.providers.title') }}</strong>
            <span class="preview-provider-icons">
              <span v-for="service in previewProviders" :key="service" class="preview-provider-avatar">
                <ServiceIcon :service="service" size="small" />
              </span>
              <b>›</b>
            </span>
          </div>

          <div class="preview-action-row" aria-hidden="true">
            <span class="preview-action"><b>A↔译</b><strong>{{ t('popup.translateCurrentPage') }}</strong><kbd>Option+T</kbd></span>
            <span class="preview-section-action">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15M10 10l7 2.6-3 1.1-1.1 3z" /></svg>
              {{ t('popup.sectionTranslation') }}
            </span>
          </div>

          <PopupLayoutPreviewItem
            v-if="siteModuleNestedInTranslation && siteModule"
            :item="siteModule"
            :editable="editScope === 'popupModule'"
            :controller="moduleDrag"
            class="preview-site-rules nested"
            data-preview-popup-module="siteRule"
          >
            <span class="preview-site-rule-button" aria-hidden="true">{{ translateLegacy('始终翻译此网站') }}<i /></span>
            <span class="preview-site-rule-button preview-site-disable" aria-hidden="true">{{ translateLegacy('在此网站禁用扩展') }}<i /></span>
          </PopupLayoutPreviewItem>
        </PopupLayoutPreviewItem>

        <PopupLayoutPreviewItem
          v-else-if="module.id === 'siteRule' && !siteModuleNestedInTranslation"
          :item="module"
          :editable="editScope === 'popupModule'"
          :controller="moduleDrag"
          class="preview-site-rules"
          data-preview-popup-module="siteRule"
        >
          <span class="preview-site-rule-button" aria-hidden="true">{{ translateLegacy('始终翻译此网站') }}<i /></span>
          <span class="preview-site-rule-button preview-site-disable" aria-hidden="true">{{ translateLegacy('在此网站禁用扩展') }}<i /></span>
        </PopupLayoutPreviewItem>

        <PopupLayoutPreviewItem
          v-else-if="module.id === 'quickFeatures'"
          as="section"
          :item="module"
          :editable="editScope === 'popupModule'"
          :controller="moduleDrag"
          class="preview-quick-features"
          data-preview-popup-module="quickFeatures"
        >
          <div v-if="editScope === 'popupModule'" class="preview-section-heading">
            <button type="button" data-preview-action @click="emit('edit:scope', 'quickFeature')">{{ t('settings.interface.popupLayout.editFeatures') }} →</button>
          </div>
          <div class="preview-features">
            <PopupLayoutPreviewItem
              v-for="feature in orderedQuickFeatures"
              :key="feature.id"
              :item="feature"
              :editable="editScope === 'quickFeature'"
              :controller="featureDrag"
              axis="x"
              class="preview-feature"
              :data-preview-quick-feature="feature.id"
            >
              <span class="preview-feature-icon" :class="featureTone(feature.id)" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path :d="featurePath(feature.id)" /></svg>
              </span>
              <span class="preview-feature-copy" aria-hidden="true"><strong>{{ feature.label }}</strong><small>{{ featureSummary(feature.id) }}</small></span>
              <span v-if="featureStatus(feature.id)" class="preview-feature-status" :class="{active: featureStatus(feature.id) === 'on'}" aria-hidden="true" />
              <b v-else aria-hidden="true">↗</b>
            </PopupLayoutPreviewItem>
          </div>
        </PopupLayoutPreviewItem>

        <PopupLayoutPreviewItem
          v-else-if="module.id === 'footer'"
          as="footer"
          :item="module"
          :editable="editScope === 'popupModule'"
          :controller="moduleDrag"
          class="preview-footer"
          :class="{framed: module.id !== lastModuleId}"
          data-preview-popup-module="footer"
        >
          <span aria-hidden="true">{{ t('popup.translationCount', {count: 0}) }}</span>
          <span class="preview-open-source" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.26c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.17.77.84 1.24 1.91 1.24 3.22 0 4.62-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .3" /></svg>
            {{ t('popup.openSourceProject') }} ↗
          </span>
          <span class="preview-clear-cache" aria-hidden="true">{{ t('popup.clearCache') }}</span>
        </PopupLayoutPreviewItem>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import {computed} from 'vue'
import {Coffee, Setting} from '@element-plus/icons-vue'
import {version} from '@/package.json'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import {canOpenTranslationSidepanel} from '@/src/platform/browser/translationSidepanel'
import {
  POPUP_QUICK_FEATURE_IDS,
  popupModuleOptions,
  popupQuickFeatureOptions,
  type InterfaceSkinOption,
  type PopupQuickFeatureId,
} from '@/src/core/config/interfaceAppearance'
import {popupQuickFeatureIconPaths, popupQuickFeatureIconTones} from '@/src/ui/popupQuickFeatureIcons'
import {useUiI18n} from '@/src/ui/i18n'
import PopupLayoutPreviewItem from './PopupLayoutPreviewItem.vue'
import type {usePopupLayoutReorder} from '../usePopupLayoutReorder'

interface PreviewLayoutItem {
  id: string
  label: string
}

const props = defineProps<{
  skin: InterfaceSkinOption
  /** 按显示顺序排列、且已排除隐藏项的区域；不传时展示完整的默认菜单栏。 */
  modules?: readonly PreviewLayoutItem[]
  /** 按显示顺序排列、且已排除隐藏项的快捷入口；不传时展示当前平台可用的范例入口。 */
  quickFeatures?: readonly PreviewLayoutItem[]
  editScope?: 'popupModule' | 'quickFeature'
  moduleDrag?: ReturnType<typeof usePopupLayoutReorder>
  featureDrag?: ReturnType<typeof usePopupLayoutReorder>
}>()
const emit = defineEmits<{'edit:scope': [scope: 'popupModule' | 'quickFeature']}>()
const {t, translateLegacy} = useUiI18n()
const iconUrl = globalThis.__FLUENTREAD_ICON_DATA__ || '/icon/128.png'
const sidepanelAvailable = import.meta.env.BROWSER !== 'userscript' && canOpenTranslationSidepanel()

// 固定范例用于比较外观，不表示这些服务、快捷键或开关已在用户配置中启用。
const previewProviders = ['localTranslation', 'freeTranslation', 'microsoft', 'deepseek']
const sampleQuickFeatureIds: PopupQuickFeatureId[] = ['hover', 'selection', 'image', 'document']
const sampleSummaries: Record<PopupQuickFeatureId, string> = {
  hover: 'Ctrl',
  selection: '已关闭',
  appearance: '仅显示译文',
  image: 'Shift+Z',
  document: 'PDF / Word / …',
}
const sampleStatus: Partial<Record<PopupQuickFeatureId, 'on' | 'off'>> = {hover: 'on', selection: 'off', image: 'on'}

const orderedModules = computed<readonly PreviewLayoutItem[]>(() => props.modules
  ?? popupModuleOptions.map((module) => ({id: module.id, label: t(module.labelKey)})))
// 只预览当前菜单的合法快捷入口，不把备份中的旧项投影回界面。
const orderedQuickFeatures = computed<readonly PreviewLayoutItem[]>(() => (props.quickFeatures
  ?? sampleQuickFeatureIds.map((id) => {
    const feature = popupQuickFeatureOptions.find((item) => item.id === id)!
    return {id, label: t(feature.labelKey)}
  })).filter(item => POPUP_QUICK_FEATURE_IDS.includes(item.id as PopupQuickFeatureId)))
const siteModule = computed(() => orderedModules.value.find((item) => item.id === 'siteRule'))
// 与真实菜单栏一致：站点开关紧跟翻译控制时并入同一张卡片，否则作为独立一行。
const siteModuleNestedInTranslation = computed(() => {
  const translationIndex = orderedModules.value.findIndex((item) => item.id === 'translation')
  return translationIndex >= 0 && orderedModules.value[translationIndex + 1]?.id === 'siteRule'
})
const lastModuleId = computed(() => orderedModules.value.at(-1)?.id)

const isQuickFeatureId = (id: string): id is PopupQuickFeatureId => id in popupQuickFeatureIconPaths
const featurePath = (id: string) => isQuickFeatureId(id) ? popupQuickFeatureIconPaths[id] : ''
const featureTone = (id: string) => isQuickFeatureId(id) ? popupQuickFeatureIconTones[id] : 'rose'
const featureSummary = (id: string) => isQuickFeatureId(id) ? translateLegacy(sampleSummaries[id]) : ''
const featureStatus = (id: string) => isQuickFeatureId(id) ? sampleStatus[id] : undefined
</script>

<style scoped>
/* 尺寸、间距与字号取自 src/app/popup/popup.css 的实际菜单栏；颜色与造型读取当前皮肤变量，四类皮肤各有一段与真实样式对应的规则。 */
.preview-popup {
  --layout-preview-accent: var(--brand);
  --layout-preview-surface: var(--surface);
  position: relative;
  width: 100%;
  padding: 10px 16px 4px;
  overflow: hidden;
  /* 外框用不占位的描边，内部可用宽度与真实菜单栏完全一致，文字换行位置才不会走样。 */
  border-radius: 14px;
  color: var(--ink);
  background: var(--surface);
  box-shadow: 0 0 0 1px var(--line);
  font-size: 11px;
  line-height: 1.4;
  text-align: left;
}
.preview-popup *, .preview-popup *::before, .preview-popup *::after { box-sizing: border-box; }
.preview-popup strong { color: inherit; font-size: inherit; font-weight: 650; line-height: 1.35; }
.preview-popup small { color: var(--muted); font-size: 10px; line-height: 1.4; }

.preview-header, .preview-brand, .preview-header-actions, .preview-header-actions > span { display: flex; align-items: center; }
.preview-header { flex-wrap: wrap; gap: 8px; justify-content: space-between; margin-bottom: 10px; }
.preview-brand { min-width: 0; gap: 9px; }
.preview-logo { width: 32px; height: 32px; flex: none; }
.preview-brand > span { display: flex; min-width: 0; flex-direction: column; }
.preview-popup .preview-brand strong { font-size: 14px; font-weight: 760; line-height: 1.25; white-space: nowrap; }
.preview-popup .preview-brand small { margin-top: 2px; }
.preview-header-actions { flex: none; gap: 7px; margin-left: auto; }
.preview-header-actions > span {
  justify-content: center; gap: 5px; height: 34px; padding: 0 8px; border: 1px solid var(--line);
  border-radius: 11px; color: var(--ink); background: var(--surface); font-size: 11px; font-weight: 700;
}
.preview-header-actions > span:first-child { color: var(--muted); }
.preview-header-actions > .preview-header-icon { width: 34px; padding: 0; }
.preview-header-actions svg { width: 16px; height: 16px; flex: none; }

.preview-flow { display: flex; flex-direction: column; gap: 10px; }
.preview-hero {
  display: grid; min-width: 0; gap: 8px; padding: 10px 12px; border: 1px solid var(--line);
  border-radius: 14px; background: var(--surface);
}
.preview-language-pair { display: grid; grid-template-columns: minmax(0, 1fr) 16px minmax(0, 1fr); align-items: end; gap: 6px; }
.preview-language { display: grid; min-width: 0; gap: 5px; }
.preview-popup .preview-language > small { padding-left: 3px; font-weight: 650; }
.preview-language-select {
  display: flex; min-height: 35px; align-items: center; justify-content: space-between; gap: 6px; padding: 0 9px;
  border: 1px solid var(--line); border-radius: 11px; background: var(--surface-soft);
}
.preview-popup .preview-language-select strong { min-width: 0; overflow-wrap: anywhere; }
.preview-language-select i { width: 7px; height: 7px; margin-top: -3px; flex: none; border-right: 1px solid var(--muted); border-bottom: 1px solid var(--muted); transform: rotate(45deg); }
.preview-language-pair > b { display: grid; height: 35px; place-items: center; color: var(--muted); font-weight: 400; }
.preview-service {
  display: flex; min-width: 0; min-height: 40px; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 9px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface-soft);
}
.preview-popup .preview-service > strong { font-size: 12px; font-weight: 600; }
.preview-provider-icons { display: flex; flex: none; align-items: center; padding-left: 6px; }
.preview-provider-avatar {
  display: grid; width: 29px; height: 29px; margin-left: -6px; place-items: center;
  border: 2px solid var(--surface); border-radius: 50%; background: var(--surface-soft);
}
.preview-provider-avatar :deep(.service-icon) { width: 23px; height: 23px; border-radius: 50%; }
.preview-provider-icons > b { margin-left: 7px; color: var(--muted); font-size: 19px; font-weight: 400; line-height: 1; }
.preview-action-row { display: flex; align-items: stretch; gap: 7px; }
.preview-action {
  display: flex; min-width: 0; min-height: 40px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 6px; padding: 8px;
  border-radius: 14px; color: #fff; background: linear-gradient(135deg, #f35482, #e93267);
  box-shadow: 0 6px 16px rgba(233, 50, 103, .16);
}
.preview-action > b { flex: none; font-size: 9px; font-weight: 850; }
.preview-popup .preview-action > strong { min-width: 0; font-size: 12px; font-weight: 750; text-align: center; overflow-wrap: anywhere; }
.preview-action kbd {
  display: inline-flex; min-height: 22px; flex: none; align-items: center; padding: 0 5px; border: 1px solid rgba(255, 255, 255, .42);
  border-radius: 7px; color: inherit; background: rgba(255, 255, 255, .16); font: inherit; font-size: 9px; font-weight: 700; white-space: nowrap;
}
.preview-section-action {
  display: inline-flex; min-width: 50px; flex: none; flex-direction: column; align-items: center; justify-content: center; gap: 1px; padding: 3px 8px;
  border: 1px solid var(--line); border-radius: 14px; color: var(--brand-strong); background: var(--surface-soft);
  font-size: 10px; font-weight: 750; line-height: 1.1; white-space: nowrap;
}
.preview-section-action svg { width: 16px; height: 16px; }
.preview-site-rules {
  display: flex; min-height: 34px; flex-wrap: wrap; align-items: center; gap: 5px; padding: 6px 8px;
  border: 1px solid var(--line); border-radius: 11px; background: var(--surface-soft);
}
.preview-site-rule-button {
  display: inline-flex; min-width: 0; min-height: 24px; align-items: center; gap: 6px; padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--brand) 26%, var(--line)); border-radius: 8px; color: var(--brand-strong);
  background: var(--surface); font-size: 9px; font-weight: 750;
}
.preview-site-rule-button.preview-site-disable { border-color: var(--line); color: var(--muted); }
.preview-site-rule-button > i { width: 6px; height: 6px; flex: none; border-radius: 50%; background: color-mix(in srgb, var(--muted) 55%, transparent); }

.preview-quick-features { display: grid; gap: 6px; }
.preview-features { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.preview-feature {
  display: grid; grid-template-columns: 26px minmax(0, 1fr) 6px; min-width: 0; min-height: 50px; align-items: center; gap: 8px; padding: 7px 8px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
}
.preview-feature-icon { display: grid; width: 26px; height: 28px; place-items: center; border-radius: 9px; }
.preview-feature-icon svg { width: 19px; height: 19px; }
/* 未被皮肤统一着色时，五个入口沿用菜单栏各自的图标色调。 */
.preview-feature-icon.rose { color: #e73a6c; background: #fff0f4; }
.preview-feature-icon.violet { color: #6f55d9; background: #f1edff; }
.preview-feature-icon.blue { color: #2678c9; background: #eaf4ff; }
.preview-feature-icon.amber { color: #a75f16; background: #fff4df; }
.preview-feature-icon.teal { color: #087f82; background: #e4f8f6; }
:root.dark .preview-feature-icon.rose { background: rgba(231, 58, 108, .14); }
:root.dark .preview-feature-icon.violet { background: rgba(111, 85, 217, .17); }
:root.dark .preview-feature-icon.blue { background: rgba(38, 120, 201, .17); }
:root.dark .preview-feature-icon.amber { background: rgba(177, 104, 29, .17); }
:root.dark .preview-feature-icon.teal { background: rgba(8, 127, 130, .18); }
.preview-feature-copy { display: flex; min-width: 0; flex-direction: column; overflow-wrap: anywhere; }
.preview-popup .preview-feature-copy strong { font-size: 11.5px; font-weight: 600; line-height: 1.4; }
.preview-popup .preview-feature-copy small { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-feature > b { justify-self: center; color: var(--muted); font-size: 12px; font-weight: 400; }
.preview-feature-status { width: 5px; height: 5px; justify-self: center; border-radius: 50%; background: #b8bec9; }
.preview-feature-status.active { background: #24b47e; box-shadow: 0 0 0 4px rgba(36, 180, 126, .12); }

.preview-footer {
  display: grid; min-height: 30px; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 6px;
  padding: 6px 3px 1px; border-top: 1px solid var(--line); color: var(--muted); font-size: 9.5px;
}
.preview-footer.framed { padding: 6px 8px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-soft); }
.preview-open-source {
  display: inline-flex; min-height: 22px; align-items: center; gap: 4px; padding: 2px 6px; border: 1px solid transparent;
  border-radius: 999px; background: var(--surface-soft); font-weight: 650; white-space: nowrap;
}
.preview-open-source svg { width: 12px; height: 12px; flex: none; }
.preview-clear-cache { justify-self: end; font-size: 10px; font-weight: 500; }

/* 布局编辑：在真实界面上叠加排序手柄与入口切换，不改变各区域自身的样子。 */
.preview-section-heading { display: flex; align-items: center; padding-left: 8px; }
.preview-section-heading button { padding: 2px 3px; border: 0; color: var(--brand-strong); background: transparent; font: inherit; font-size: 10px; cursor: pointer; }
.preview-section-heading button:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.preview-footer.editable > span:first-of-type { padding-left: 10px; }

/* 默认：五个入口图标统一为品牌色。 */
.preview-popup[data-preview-kind="default"] .preview-feature-icon { color: var(--brand-strong); background: var(--brand-soft); }

/* 简约：对应 minimal.css——没有卡片外框，控件是中性浅灰，入口只留标题。 */
.preview-popup[data-preview-kind="minimal"] { padding: 12px 12px 10px; }
.preview-popup[data-preview-kind="minimal"] .preview-header { min-height: 42px; margin-bottom: 12px; }
.preview-popup[data-preview-kind="minimal"] .preview-brand { gap: 8px; }
.preview-popup[data-preview-kind="minimal"] .preview-logo { width: 38px; height: 38px; }
.preview-popup[data-preview-kind="minimal"] .preview-brand small { font-size: 9px; }
.preview-popup[data-preview-kind="minimal"] .preview-header-actions { gap: 5px; }
.preview-popup[data-preview-kind="minimal"] .preview-header-actions > span { color: var(--muted); background: transparent; font-size: 9px; }
.preview-popup[data-preview-kind="minimal"] .preview-flow { gap: 11px; }
.preview-popup[data-preview-kind="minimal"] .preview-hero { gap: 10px; padding: 0; border: 0; border-radius: 0; background: transparent; }
.preview-popup[data-preview-kind="minimal"] .preview-language-select { border-color: transparent; }
.preview-popup[data-preview-kind="minimal"] .preview-action {
  min-height: 46px; padding: 10px 12px; border: 1px solid transparent; color: var(--ink); background: var(--surface-soft); box-shadow: none;
}
.preview-popup[data-preview-kind="minimal"] .preview-action > b { color: var(--brand-strong); }
.preview-popup[data-preview-kind="minimal"] .preview-action kbd { border-color: var(--line); border-radius: 5px; color: var(--muted); background: var(--surface); }
.preview-popup[data-preview-kind="minimal"] .preview-site-rules { border: 0; border-radius: 13px; }
.preview-popup[data-preview-kind="minimal"] .preview-site-rule-button { min-height: 22px; padding: 3px 6px; border-radius: 6px; }
.preview-popup[data-preview-kind="minimal"] .preview-features { gap: 5px; }
.preview-popup[data-preview-kind="minimal"] .preview-feature { grid-template-columns: 30px minmax(0, 1fr) 6px; min-height: 48px; padding: 7px 9px; border-radius: 14px; }
.preview-popup[data-preview-kind="minimal"] .preview-feature-icon { width: 30px; height: 30px; color: var(--muted); background: var(--surface-soft); }
.preview-popup[data-preview-kind="minimal"] .preview-feature-copy strong { font-size: 11px; line-height: 1.3; }
.preview-popup[data-preview-kind="minimal"] .preview-feature-copy small { display: none; }
.preview-popup[data-preview-kind="minimal"] .preview-feature > b { font-size: 15px; }
.preview-popup[data-preview-kind="minimal"] .preview-footer { min-height: 32px; padding: 7px 14px; border: 0; background: var(--surface-soft); font-size: 10px; }
.preview-popup[data-preview-kind="minimal"] .preview-footer:not(.framed) { margin: 0 -12px -10px; }
.preview-popup[data-preview-kind="minimal"] .preview-open-source { min-height: 20px; padding: 1px 4px; border-radius: 6px; }

/* 紧凑：对应 compact.css——压缩间距与控件高度，文字不缩到难以辨认。 */
.preview-popup[data-preview-kind="compact"] {
  padding: 8px 12px 4px;
  background: radial-gradient(circle at 92% 0, rgba(239, 71, 118, .12), transparent 30%), linear-gradient(180deg, var(--surface) 0, var(--surface-soft) 165px);
}
.preview-popup[data-preview-kind="compact"] .preview-header { margin-bottom: 5px; }
.preview-popup[data-preview-kind="compact"] .preview-brand { gap: 7px; }
.preview-popup[data-preview-kind="compact"] .preview-brand strong { font-size: 13px; }
.preview-popup[data-preview-kind="compact"] .preview-brand small { font-size: 9.5px; }
.preview-popup[data-preview-kind="compact"] .preview-header-actions > span { height: 29px; padding: 0 7px; border-radius: 8px; font-size: 9.5px; }
.preview-popup[data-preview-kind="compact"] .preview-flow { gap: 6px; }
.preview-popup[data-preview-kind="compact"] .preview-hero { gap: 6px; padding: 9px; border-radius: 15px; box-shadow: 0 6px 15px rgba(27, 36, 57, .06); }
.preview-popup[data-preview-kind="compact"] .preview-language-pair { grid-template-columns: minmax(0, 1fr) 24px minmax(0, 1fr); gap: 5px; margin-top: 8px; }
.preview-popup[data-preview-kind="compact"] .preview-action-row { margin-top: 1px; }
.preview-popup[data-preview-kind="compact"] .preview-language { gap: 3px; }
.preview-popup[data-preview-kind="compact"] .preview-language > small { font-size: 9.5px; }
.preview-popup[data-preview-kind="compact"] .preview-language-select { min-height: 32px; border-radius: 8px; }
.preview-popup[data-preview-kind="compact"] .preview-language-pair > b { height: 32px; }
.preview-popup[data-preview-kind="compact"] .preview-service { min-height: 34px; padding: 3px 8px; border-radius: 9px; }
.preview-popup[data-preview-kind="compact"] .preview-provider-avatar { width: 26px; height: 26px; }
.preview-popup[data-preview-kind="compact"] .preview-provider-avatar :deep(.service-icon) { width: 20px; height: 20px; }
.preview-popup[data-preview-kind="compact"] .preview-action { min-height: 36px; border-radius: 9px; box-shadow: none; }
.preview-popup[data-preview-kind="compact"] .preview-action > strong { font-size: 10.5px; }
.preview-popup[data-preview-kind="compact"] .preview-section-action { border-radius: 9px; }
.preview-popup[data-preview-kind="compact"] .preview-site-rules { min-height: 28px; padding: 3px 5px 3px 7px; border-radius: 8px; }
.preview-popup[data-preview-kind="compact"] .preview-site-rule-button { min-height: 22px; padding: 0 7px; }
.preview-popup[data-preview-kind="compact"] .preview-features { gap: 4px; }
.preview-popup[data-preview-kind="compact"] .preview-feature { grid-template-columns: 24px minmax(0, 1fr) 6px; gap: 5px; min-height: 42px; padding: 4px 6px; border-radius: 9px; }
.preview-popup[data-preview-kind="compact"] .preview-feature-icon { width: 24px; height: 24px; border-radius: 7px; }
.preview-popup[data-preview-kind="compact"] .preview-feature-copy strong { font-size: 10.5px; line-height: 1.25; }
.preview-popup[data-preview-kind="compact"] .preview-feature-copy small { margin-top: 1px; font-size: 9px; }
.preview-popup[data-preview-kind="compact"] .preview-footer { min-height: 26px; padding-top: 4px; font-size: 9px; }

/* 高对比：对应 contrast.css——粗描边、方角、浅黄控件与实色主按钮。 */
.preview-popup[data-preview-kind="contrast"] { padding-bottom: 8px; border-radius: 7px; box-shadow: 0 0 0 2px var(--line); }
.preview-popup[data-preview-kind="contrast"] :is(.preview-hero, .preview-header-actions > span, .preview-language-select, .preview-service, .preview-site-rules, .preview-feature, .preview-section-action) {
  border: 2px solid var(--line); border-radius: 7px;
}
.preview-popup[data-preview-kind="contrast"] .preview-header-actions > span { color: var(--ink); }
.preview-popup[data-preview-kind="contrast"] .preview-action { border: 2px solid var(--line); border-radius: 7px; color: var(--surface); background: var(--brand); box-shadow: none; }
.preview-popup[data-preview-kind="contrast"] .preview-feature-icon { border: 1px solid var(--line); border-radius: 4px; color: var(--ink); background: var(--brand-soft); }

/* 传统色风格：逐项读取 palette.css 的造型契约，与真实菜单栏使用同一组变量；各风格文件里的专属规则同时匹配这里的类名。 */
.preview-popup[data-preview-kind="palette"] {
  border-radius: min(var(--skin-panel-radius, 14px), 18px);
  background: var(--skin-page, var(--surface));
}
.preview-popup[data-preview-kind="palette"] .preview-header-actions > span {
  border: var(--skin-chip-border, 1px solid var(--line)); border-radius: var(--skin-chip-radius, var(--skin-control-radius, 10px));
  color: var(--skin-chip-color, var(--ink)); background: var(--skin-chip-background, var(--surface));
  box-shadow: var(--skin-chip-shadow, none);
}
.preview-popup[data-preview-kind="palette"] .preview-header-actions > span:first-child { color: var(--skin-chip-color, var(--muted)); }
.preview-popup[data-preview-kind="palette"] .preview-hero {
  border: var(--skin-panel-border, 1px solid var(--line)); border-radius: var(--skin-panel-radius, 14px);
  background: var(--skin-panel-background, var(--surface)); box-shadow: var(--skin-panel-shadow, none);
}
.preview-popup[data-preview-kind="palette"] .preview-language > small { color: var(--skin-label-color, var(--muted)); }
.preview-popup[data-preview-kind="palette"] :is(.preview-language-select, .preview-service, .preview-section-action, .preview-site-rules) {
  border: var(--skin-control-border, 1px solid var(--line)); border-radius: var(--skin-control-radius, 10px);
  background: var(--skin-control-background, var(--surface-soft)); box-shadow: var(--skin-control-shadow, none);
}
.preview-popup[data-preview-kind="palette"] .preview-section-action { color: var(--skin-section-color, var(--brand-strong)); }
.preview-popup[data-preview-kind="palette"] .preview-provider-avatar { border-color: var(--skin-avatar-ring, var(--surface)); background: var(--skin-avatar-background, var(--surface-soft)); }
.preview-popup[data-preview-kind="palette"] .preview-site-rule-button {
  border-radius: var(--skin-tag-radius, min(8px, var(--skin-control-radius, 8px))); background: var(--skin-tag-background, var(--surface));
}
.preview-popup[data-preview-kind="palette"] .preview-action {
  border: var(--skin-action-border, 0); border-radius: var(--skin-action-radius, var(--skin-control-radius, 10px)); color: var(--skin-action-text, #fff);
  background: var(--skin-action-background, var(--brand)); box-shadow: var(--skin-action-shadow, none);
}
.preview-popup[data-preview-kind="palette"] .preview-action kbd { border-color: color-mix(in srgb, currentColor 30%, transparent); border-radius: min(6px, var(--skin-control-radius, 6px)); background: color-mix(in srgb, currentColor 8%, transparent); }
.preview-popup[data-preview-kind="palette"] .preview-feature {
  border: var(--skin-feature-border, 1px solid var(--line)); border-radius: var(--skin-feature-radius, 10px);
  background: var(--skin-feature-background, var(--surface)); box-shadow: var(--skin-feature-shadow, none);
}
.preview-popup[data-preview-kind="palette"] .preview-feature-icon {
  border: var(--skin-icon-border, 0); border-radius: var(--skin-icon-radius, 8px);
  color: var(--skin-icon-color, var(--brand-strong)); background: var(--skin-icon-background, var(--brand-soft)); box-shadow: var(--skin-icon-shadow, none);
}
.preview-popup[data-preview-kind="palette"] .preview-footer { border-color: var(--skin-footer-line, var(--line)); color: var(--muted); }
.preview-popup[data-preview-kind="palette"] .preview-open-source { background: var(--skin-chip-background, var(--surface-soft)); }
</style>

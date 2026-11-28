<!--
@file src/features/settings/ui/components/PopupPreview.vue
文件职责：用真实 DOM 按菜单栏的实际结构、尺寸和皮肤变量还原一份 Popup，供 Popup Skin Studio 实时预览和菜单栏布局预览共用，保证两处看到的是同一个界面。
主要内容：优先复用脚本构建注入的品牌图标并保留扩展资源回退，依次绘制品牌与版本、赞赏图标、受支持时的侧边栏图标和设置、语言与服务、网页及局部翻译、站点开关、右侧译文字体与双语模式工具、快捷入口卡片和底部信息栏；按构建与实际平台能力过滤专属入口，区域与快捷入口按传入顺序渲染，传入编辑层级和排序控制器时叠加拖动手柄与插入提示。
模块边界：只负责展示与把排序手势交给外部控制器，不读取用户配置、不连接浏览器状态，也不执行菜单栏业务；范例里的服务、快捷键和开关状态是固定示意，不代表用户当前设置；皮肤配色与造型统一由外部 `.popup-skin-scope` 与 `popup-skins-base.css` 注入。
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
        <PopupBrandIcon :skin="skin.value" :src="iconUrl" img-class="preview-logo" />
        <span><strong>{{ t('common.brand') }}</strong><small>v{{ version }}</small></span>
      </span>
      <span class="preview-header-actions">
        <span class="preview-header-icon"><Coffee /></span>
        <span v-if="sidepanelAvailable" class="preview-header-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><path d="M12.5 3.5v13M5.5 8h4M5.5 11h4"/></svg></span>
        <span class="preview-settings"><Setting /><span>{{ translateLegacy('设置') }}</span></span>
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
            <span class="preview-service-copy"><small>{{ t('popup.providers.title') }}</small><strong>{{ translateLegacy('微软翻译') }}</strong></span>
            <span class="preview-provider-icons">
              <span class="preview-provider-avatar"><ServiceIcon service="microsoft" size="small" /></span>
              <b>›</b>
            </span>
          </div>

          <div class="preview-action-row" aria-hidden="true">
            <span class="preview-action"><strong>{{ t('popup.compact.translate') }} (⌥+T)</strong></span>
            <span class="preview-section-action">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15M10 10l7 2.6-3 1.1-1.1 3z" /></svg>
              <span>{{ t('popup.sectionTranslation') }}</span>
            </span>
          </div>

          <div class="preview-meta">
            <PopupLayoutPreviewItem
              v-if="siteModuleNestedInTranslation && siteModule"
              :item="siteModule"
              :editable="editScope === 'popupModule'"
              :controller="moduleDrag"
              class="preview-site-rules nested"
              data-preview-popup-module="siteRule"
            >
              <span class="preview-site-rule-button" aria-hidden="true"><span>{{ translateLegacy('始终翻译此网站') }}</span><i /></span>
              <span class="preview-site-rule-button preview-site-disable" aria-hidden="true"><span>{{ translateLegacy('在此网站禁用扩展') }}</span><i /></span>
            </PopupLayoutPreviewItem>
            <span class="preview-tools" aria-hidden="true">
              <span>Aa</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path :d="featurePath('appearance')" /></svg>
            </span>
          </div>
        </PopupLayoutPreviewItem>

        <PopupLayoutPreviewItem
          v-else-if="module.id === 'siteRule' && !siteModuleNestedInTranslation"
          :item="module"
          :editable="editScope === 'popupModule'"
          :controller="moduleDrag"
          class="preview-site-rules"
          data-preview-popup-module="siteRule"
        >
          <span class="preview-site-rule-button" aria-hidden="true"><span>{{ translateLegacy('始终翻译此网站') }}</span><i /></span>
          <span class="preview-site-rule-button preview-site-disable" aria-hidden="true"><span>{{ translateLegacy('在此网站禁用扩展') }}</span><i /></span>
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
            <span>{{ t('popup.openSourceProject') }}</span><span class="preview-external-mark">↗</span>
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
import PopupBrandIcon from '@/src/ui/components/PopupBrandIcon.vue'
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
/* 尺寸、间距与字号取自 src/app/popup/popup.css 的实际菜单栏；craft 皮肤配色与造型统一由 .popup-skin-scope + popup-skins-base.css 注入。 */
.preview-popup {
  --layout-preview-accent: var(--brand);
  --layout-preview-surface: var(--surface);
  position: relative;
  width: 100%;
  padding: 10px 12px 6px;
  overflow: hidden;
  border-radius: 12px;
  color: var(--ink);
  background: var(--preview-canvas-bg, var(--surface));
  box-shadow: 0 0 0 1px var(--line);
  font-size: 11px;
  line-height: 1.4;
  text-align: left;
  transition: background-color 150ms var(--fr-ease-out, ease), border-color 150ms var(--fr-ease-out, ease), color 150ms var(--fr-ease-out, ease);
}
.preview-popup *, .preview-popup *::before, .preview-popup *::after { box-sizing: border-box; }
.preview-popup strong { color: inherit; font-size: inherit; font-weight: 600; line-height: 1.35; }
.preview-popup small { color: var(--muted); font-size: 10.5px; line-height: 1.4; }

.preview-header, .preview-brand, .preview-header-actions, .preview-header-actions > span { display: flex; align-items: center; }
.preview-header { flex-wrap: nowrap; gap: 8px; justify-content: space-between; margin-bottom: 10px; }
.preview-brand { min-width: 0; gap: 8px; }
.preview-logo { width: 32px; height: 32px; flex: none; }
.preview-brand > span { display: flex; min-width: 0; flex-direction: column; }
.preview-popup .preview-brand strong { font-size: 14px; font-weight: 650; line-height: 1.25; white-space: nowrap; }
.preview-popup .preview-brand small { margin-top: 1px; font-variant-numeric: tabular-nums; }
.preview-header-actions { flex: none; gap: 6px; margin-left: auto; }
.preview-header-actions > span {
  justify-content: center; gap: 5px; height: 32px; padding: 0 8px; border: 1px solid var(--line);
  border-radius: 8px; color: var(--ink); background: var(--surface); font-size: 11px; font-weight: 550;
}
.preview-header-actions > span:first-child { color: var(--muted); }
.preview-header-actions > .preview-header-icon { width: 32px; padding: 0; }
.preview-header-actions svg { width: 16px; height: 16px; flex: none; }

.preview-flow { display: flex; flex-direction: column; gap: 10px; }
.preview-hero {
  display: grid; min-width: 0; gap: 8px; padding: 10px 12px; border: 1px solid var(--line);
  border-radius: 12px; background: var(--surface); box-shadow: var(--fr-shadow-xs, 0 1px 3px rgba(23, 32, 51, .04));
}
.preview-language-pair { display: grid; grid-template-columns: minmax(0, 1fr) 16px minmax(0, 1fr); align-items: end; gap: 6px; }
.preview-language { display: grid; min-width: 0; gap: 4px; }
.preview-popup .preview-language > small { padding-left: 2px; font-weight: 550; }
.preview-language-select {
  display: flex; min-height: 34px; align-items: center; justify-content: space-between; gap: 6px; padding: 0 9px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft);
}
.preview-popup .preview-language-select strong { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
.preview-language-select i { width: 6px; height: 6px; margin-top: -3px; flex: none; border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted); transform: rotate(45deg); }
.preview-language-pair > b { display: grid; height: 34px; place-items: center; color: var(--muted); font-weight: 400; }
.preview-service {
  display: flex; min-width: 0; min-height: 42px; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 9px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft);
}
.preview-service-copy { display: flex; min-width: 0; flex: 1; align-items: baseline; gap: 6px; }
.preview-popup .preview-service-copy strong { font-size: 12px; font-weight: 600; }
.preview-provider-icons { display: flex; flex: none; align-items: center; padding-left: 6px; }
.preview-provider-avatar {
  display: grid; width: 28px; height: 28px; margin-left: -6px; place-items: center;
  border: 2px solid var(--surface); border-radius: 50%; background: var(--surface-soft);
}
.preview-provider-avatar :deep(.service-icon) { width: 22px; height: 22px; border-radius: 50%; }
.preview-provider-icons > b { margin-left: 6px; color: var(--muted); font-size: 18px; font-weight: 400; line-height: 1; }
.preview-action-row { display: flex; align-items: stretch; gap: 6px; }
.preview-action {
  display: flex; min-width: 0; min-height: 42px; flex: 1 1 auto; align-items: center; justify-content: center; gap: 6px; padding: 6px 10px;
  border-radius: 8px; color: #fff; background: var(--fr-color-brand-action-gradient, linear-gradient(135deg, #f45686, #e53268));
  box-shadow: var(--fr-shadow-brand-action, 0 4px 12px rgba(233, 50, 103, .20));
}
.preview-popup .preview-action > strong { min-width: 0; font-size: 12.5px; font-weight: 650; text-align: center; overflow-wrap: anywhere; }
.preview-section-action {
  display: inline-flex; width: 46px; min-width: 46px; flex: none; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 4px 5px;
  border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface-soft);
  font-size: 10px; font-weight: 600; line-height: 1.1; white-space: nowrap;
}
.preview-section-action svg { width: 15px; height: 15px; color: var(--brand); }

.preview-meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
.preview-site-rules {
  display: grid; grid-template-columns: minmax(0, 10fr) minmax(0, 11fr); align-items: center; gap: 4px;
  min-height: 24px; padding: 0; border: 0; background: transparent;
}
.preview-site-rules.nested { flex: 1; min-width: 0; }
.preview-site-rule-button {
  display: inline-flex; min-width: 0; min-height: 24px; align-items: center; justify-content: space-between; gap: 5px; padding: 0 7px;
  border: 1px solid color-mix(in srgb, var(--brand) 26%, var(--line)); border-radius: 6px; color: var(--brand-strong);
  background: var(--surface); font-size: 9.5px; font-weight: 600;
}
.preview-site-rule-button.preview-site-disable { border-color: var(--line); color: var(--muted); }
.preview-site-rule-button > i { width: 5.5px; height: 5.5px; flex: none; border-radius: 50%; background: color-mix(in srgb, var(--muted) 55%, transparent); }

.preview-tools { display: flex; flex: none; gap: 4px; margin-inline-start: auto; color: var(--brand-strong); }
.preview-tools > * { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 6px; background: var(--surface-soft); }
.preview-tools > span { font: 600 13px Georgia, serif; }
.preview-tools > svg { padding: 3px; }

.preview-quick-features { display: grid; gap: 6px; }
.preview-features { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.preview-feature {
  display: grid; grid-template-columns: 28px minmax(0, 1fr) 6px; min-width: 0; min-height: 48px; align-items: center; gap: 8px; padding: 7px 9px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
}
.preview-feature-icon { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 6px; }
.preview-feature-icon svg { width: 17px; height: 17px; }
/* 默认皮肤快捷卡图标沿用品牌色；深色由 .popup-skin-scope[data-popup-theme="dark"] 控制，不读取 Options 的 :root.dark。 */
.preview-feature-icon.rose { color: var(--brand, #ef4776); background: var(--brand-soft, #fff0f5); }
.preview-feature-icon.violet { color: #6f55d9; background: #f1edff; }
.preview-feature-icon.blue { color: var(--fr-info, #2563a6); background: var(--fr-info-soft, #edf4ff); }
.preview-feature-icon.amber { color: var(--fr-warning, #8f5f16); background: var(--fr-warning-soft, #fff6e2); }
.preview-feature-icon.teal { color: var(--fr-success, #147e5c); background: var(--fr-success-soft, #eaf7f3); }
.preview-popup[data-preview-kind="default"] .preview-feature-icon { color: var(--brand); background: var(--brand-soft); }

.preview-feature-copy { display: flex; min-width: 0; flex-direction: column; overflow-wrap: anywhere; }
.preview-popup .preview-feature-copy strong { font-size: 11.5px; font-weight: 600; line-height: 1.35; }
.preview-popup .preview-feature-copy small { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-feature > b { justify-self: center; color: var(--muted); font-size: 12px; font-weight: 400; }
.preview-feature-status { width: 6px; height: 6px; justify-self: center; border-radius: 50%; background: var(--fr-color-line-strong, #cfd5e0); }
.preview-feature-status.active { background: var(--fr-success-indicator, #24b47e); box-shadow: var(--fr-success-indicator-ring, 0 0 0 3px rgba(36, 180, 126, .16)); }

.preview-footer {
  display: grid; min-height: 30px; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: center; gap: 6px;
  padding: 7px 2px 2px; border-top: 1px solid var(--line); color: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums;
}
.preview-footer.framed { padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-soft); }
.preview-open-source {
  display: inline-flex; min-width: 0; min-height: 24px; align-items: center; justify-content: center; gap: 4px; padding: 2px 6px; border: 1px solid transparent;
  border-radius: 999px; background: var(--surface-soft); font-weight: 550; white-space: nowrap;
}
.preview-open-source svg { width: 12px; height: 12px; flex: none; }
.preview-clear-cache { justify-self: end; font-size: 10.5px; font-weight: 500; }
.preview-external-mark { flex: none; }

/* 布局编辑：在真实界面上叠加排序手柄与入口切换，不改变各区域自身的样子。 */
.preview-section-heading { display: flex; align-items: center; padding-left: 8px; }
.preview-section-heading button { padding: 2px 3px; border: 0; color: var(--brand-strong); background: transparent; font: inherit; font-size: 10px; cursor: pointer; }
.preview-section-heading button:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.preview-footer.editable > span:first-of-type { padding-left: 10px; }

/* 单行溢出省略，保持预览排版规整。 */
.preview-popup :is(
  .preview-brand strong, .preview-settings > span, .preview-language-select strong, .preview-language > small, .preview-service-copy > *,
  .preview-action > strong, .preview-section-action > span, .preview-site-rule-button > span,
  .preview-feature-copy > *, .preview-footer > span:not(.preview-open-source), .preview-open-source > span:not(.preview-external-mark)
) { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }

@media (prefers-reduced-motion: reduce) {
  .preview-popup { transition: none; }
}
</style>

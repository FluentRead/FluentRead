<!--
@file src/features/settings/ui/components/PopupLayoutPreview.vue
文件职责：在菜单栏布局设置中把用户当前的区域顺序、快捷入口顺序和显隐结果投影到真实的菜单栏预览上，并提供直接拖动排序。
主要内容：按保存的顺序筛出可见区域与快捷入口，交给与风格预览共用的 PopupPreview 渲染；维护两级拖放与键盘排序控制器，切换编辑层级时结束未完成的拖放，并向读屏播报移动结果。
模块边界：本组件只消费外部投影后的布局数据，通过排序事件编辑布局，不读写配置或浏览器状态，不绘制菜单栏本身，也不执行 Popup 的业务行为。
-->
<template>
  <section
    class="popup-layout-live-preview"
    :data-preview-skin="skin.value"
    :data-preview-kind="skin.kind"
    :style="{'--interface-popup-width': `${skin.popupWidth}px`}"
    role="group"
    :aria-label="previewAriaLabel"
  >
    <PopupPreview
      :skin="skin"
      :modules="visibleModules"
      :quick-features="visibleQuickFeatures"
      :edit-scope="editScope"
      :module-drag="moduleDrag"
      :feature-drag="featureDrag"
      @edit:scope="emit('edit:scope', $event)"
    />
    <p class="layout-preview-announcement" aria-live="polite">{{ announcement }}</p>
  </section>
</template>

<script setup lang="ts">
import {computed, ref, watch} from 'vue'
import PopupPreview from './PopupPreview.vue'
import {usePopupLayoutReorder} from '../usePopupLayoutReorder'
import type {InterfaceSkinOption} from '@/src/core/config/interfaceAppearance'
import {useUiI18n} from '@/src/ui/i18n'

interface PreviewLayoutItem {
  id: string
  label: string
  visible: boolean
}

const props = defineProps<{
  skin: InterfaceSkinOption
  skinLabel: string
  moduleItems: readonly PreviewLayoutItem[]
  moduleOrder: readonly string[]
  quickFeatureItems: readonly PreviewLayoutItem[]
  quickFeatureOrder: readonly string[]
  editScope: 'popupModule' | 'quickFeature'
}>()
const {t} = useUiI18n()
const emit = defineEmits<{
  'update:moduleOrder': [order: string[]]
  'update:quickFeatureOrder': [order: string[]]
  'edit:scope': [scope: 'popupModule' | 'quickFeature']
}>()
const announcement = ref('')

function orderItems(items: readonly PreviewLayoutItem[], order: readonly string[]): PreviewLayoutItem[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const ordered = order.map((id) => byId.get(id)).filter((item): item is PreviewLayoutItem => Boolean(item))
  const orderedIds = new Set(ordered.map((item) => item.id))
  return [...ordered, ...items.filter((item) => !orderedIds.has(item.id))]
}

const visibleQuickFeatures = computed(() => orderItems(props.quickFeatureItems, props.quickFeatureOrder)
  .filter((item) => item.visible))
// 与真实菜单栏一致：没有任何可见快捷入口时，整个快捷功能栏不占位。
const visibleModules = computed(() => orderItems(props.moduleItems, props.moduleOrder)
  .filter((item) => item.visible && (item.id !== 'quickFeatures' || visibleQuickFeatures.value.length > 0)))
function announceMove(order: string[], id: string, items: readonly PreviewLayoutItem[]) {
  const item = items.find((entry) => entry.id === id)
  const visibleOrder = order.filter((entry) => items.some((candidate) => candidate.id === entry && candidate.visible))
  announcement.value = t('settings.interface.popupLayout.moved', {label: item?.label ?? id, position: visibleOrder.indexOf(id) + 1})
}
const moduleDrag = usePopupLayoutReorder({
  order: () => props.moduleOrder,
  visibleIds: () => visibleModules.value.map((item) => item.id),
  onUpdate: (order, id) => { emit('update:moduleOrder', order); announceMove(order, id, visibleModules.value) },
})
const featureDrag = usePopupLayoutReorder({
  order: () => props.quickFeatureOrder,
  visibleIds: () => visibleQuickFeatures.value.map((item) => item.id),
  onUpdate: (order, id) => { emit('update:quickFeatureOrder', order); announceMove(order, id, visibleQuickFeatures.value) },
})
watch(() => props.editScope, () => { moduleDrag.finish(); featureDrag.finish() })
const previewAriaLabel = computed(() => `${t('settings.interface.popupLayout.previewTitle')}: ${props.skinLabel}`)
</script>

<style scoped>
/* 与真实菜单栏同宽：窄版跟随皮肤登记的宽度，拉丁字母与西里尔字母语言沿用菜单栏的加宽规则。 */
.popup-layout-live-preview {
  --preview-popup-width: var(--interface-popup-width, 320px);
  position: relative;
  width: min(100%, var(--preview-popup-width));
  margin: 0 auto;
}
:root:is(:lang(en), :lang(fr), :lang(ru), :lang(es)) .popup-layout-live-preview:not([data-preview-kind="default"]) { --preview-popup-width: max(var(--interface-popup-width, 320px), 380px); }
.layout-preview-announcement { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); }
</style>

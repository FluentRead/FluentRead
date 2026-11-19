<!--
@file src/features/settings/ui/components/InterfaceSkinPreview.vue
文件职责：在界面风格设置旁展示当前所选皮肤下的完整菜单栏，让用户直接比较配色、层次和密度。
主要内容：以默认的区域顺序和固定范例入口渲染共用的 PopupPreview，并提供整体的无障碍名称；宽度跟随所选皮肤登记的菜单栏宽度。
模块边界：本组件仅展示无交互的外观范例，不读取用户配置、不连接浏览器状态；菜单栏的具体还原由 PopupPreview 负责，风格选择和持久化由设置页负责。
-->
<template>
  <section
    class="interface-skin-live-preview"
    :data-preview-skin="skin.value"
    :data-preview-kind="skin.kind"
    :style="{'--interface-popup-width': `${skin.popupWidth}px`}"
    role="img"
    :aria-label="previewLabel"
  >
    <PopupPreview :skin="skin" aria-hidden="true" />
  </section>
</template>

<script setup lang="ts">
import type {InterfaceSkinOption} from '@/src/core/config/interfaceAppearance'
import PopupPreview from './PopupPreview.vue'

defineProps<{
  skin: InterfaceSkinOption
  previewLabel: string
}>()
</script>

<style scoped>
/* 与真实菜单栏同宽：窄版跟随皮肤登记的宽度，拉丁字母与西里尔字母语言沿用菜单栏的加宽规则。 */
.interface-skin-live-preview { --preview-popup-width: var(--interface-popup-width, 320px); width: var(--preview-popup-width); max-width: 100%; }
:root:is(:lang(en), :lang(fr), :lang(ru), :lang(es)) .interface-skin-live-preview:not([data-preview-kind="default"]) { --preview-popup-width: max(var(--interface-popup-width, 320px), 380px); }
</style>

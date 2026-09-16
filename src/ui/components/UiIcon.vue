<!--
 @file src/ui/components/UiIcon.vue
 文件职责：为扩展自有界面提供统一的本地线条图标，避免系统字形差异与重复图标底块。
 主要内容：使用 24 像素画布、1.7 线宽和圆角笔触，根据语义名称选择 SVG 路径；继承颜色并支持尺寸，作为装饰隐藏于辅助技术。
 模块边界：组件不含设置分区或业务状态，不加载外部资源；可访问名称由包含图标的按钮或链接提供。
-->
<template>
  <svg class="fr-ui-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path :d="paths[name] || paths.info" />
  </svg>
</template>
<script setup lang="ts">
withDefaults(defineProps<{name: string; size?: number}>(), {size: 18})
const paths: Record<string, string> = {
  'home': 'M3 10l9-7 9 7 M5 9v11h5v-6h4v6h5V9',
  'layout': 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M4 9h16 M9 9v11',
  'plug': 'M8 3v5 M16 3v5 M6 8h12v3a6 6 0 0 1-12 0V8z M12 17v4',
  'translate': 'M3 5h12 M9 3v2 M12 5c-1 5-4 8-9 10 M5 8c1 3 4 5 7 6 M13 21l4-11 4 11 M14.5 17h5',
  'card': 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M8 8h8 M8 12h8 M8 16h4',
  'image': 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M4 16l5-5 4 4 3-3 4 4 M16 8h.01',
  'scan': 'M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M8 8h8v8H8z',
  'captions': 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M7 11h4 M14 11h3 M7 15h3 M13 15h4',
  'globe': 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18z',
  'pen': 'M14 5l5 5 M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6z M13 20h7',
  'swap': 'M3 7h16l-4-4 M19 7l-4 4 M21 17H5l4-4 M5 17l4 4',
  'book': 'M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1z M12 6v14',
  'glossary': 'M6 3h13v18H6a3 3 0 0 1 0-6h13 M3 18V6a3 3 0 0 1 3-3 M10 6v6l2-1 2 1V6',
  'chart': 'M4 3v17h17 M8 16v-5 M13 16V6 M18 16v-8',
  'gauge': 'M3.5 17a9 9 0 1 1 17 0 M12 14l4-5 M12 14h.01 M7 17h10',
  'sliders': 'M4 6h4 M12 6h8 M4 12h9 M17 12h3 M4 18h2 M10 18h10 M8 3v6 M13 9v6 M6 15v6',
  'history': 'M7 8H3V4 M3 8a9 9 0 1 1 0 8 M12 7v5l3 2',
  'info': 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M12 11v6 M12 7h.01',
  'close': 'M6 6l12 12 M6 18L18 6',
  'plus': 'M12 5v14 M5 12h14',
  'search': 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0z',
  'chevron-down': 'M6 9l6 6 6-6',
  'arrow-right': 'M4 12h16 M14 6l6 6-6 6',
  'external': 'M14 3h7v7 M21 3L10 14 M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5',
  'grip': 'M8 5h.01 M16 5h.01 M8 12h.01 M16 12h.01 M8 19h.01 M16 19h.01',
  'check': 'M5 12l4 4L19 6',
  'star': 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3z',
  'shield': 'M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3z M8 12l3 3 5-6',
  'keyboard': 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 9h.01 M12 9h.01 M17 9h.01 M7 13h.01 M12 13h.01 M17 13h.01 M8 16h8',
}
</script>
<style scoped>
.fr-ui-icon { display: inline-block; flex: none; vertical-align: middle; }
</style>

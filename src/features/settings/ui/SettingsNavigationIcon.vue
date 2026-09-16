<!--
 @file src/features/settings/ui/SettingsNavigationIcon.vue
 文件职责：为设置页各导航入口提供统一的本地线条图标，保持与 Popup 快捷入口相同的画布、线宽和圆角笔触。
 主要内容：按设置分区标识选择共享 UiIcon 的语义名称；图标继承菜单颜色，作为装饰隐藏于辅助技术，入口名称由按钮文字提供。
 模块边界：只负责导航图形，不控制路由、用户配置或主题，不请求外部图标资源。
-->
<template><UiIcon :name="icons[section] || 'info'" /></template>
<script setup lang="ts">
import UiIcon from '@/src/ui/components/UiIcon.vue'
defineProps<{section: string}>()
const icons: Record<string, string> = {
  'settings-general': 'home',
  'settings-interface': 'layout',
  'settings-services': 'plug',
  'settings-translation': 'translate',
  'settings-harness': 'card',
  'settings-image-translation': 'image',
  'settings-area-translation': 'scan',
  'settings-video': 'captions',
  'settings-sites': 'globe',
  'settings-writing': 'pen',
  'settings-translation-center': 'swap',
  'settings-vocabulary': 'book',
  'settings-glossary': 'glossary',
  'settings-translation-stats': 'gauge',
  'settings-model-usage': 'chart',
  'settings-advanced': 'sliders',
  'settings-data': 'history',
  'settings-about': 'info',
 }
</script>

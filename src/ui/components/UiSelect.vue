<!--
 * @file src/ui/components/UiSelect.vue
 * 文件职责：提供扩展界面统一的下拉选择外观，避免浏览器原生菜单破坏品牌风格。
 * 主要内容：复用 Element Plus 的选择、键盘、焦点与弹层定位，透传受控值和事件，统一亮暗主题及窄屏菜单。
 * 模块边界：不解释选项、不读写配置；选项内容和挂载容器由调用方提供，不用于宿主网页原生控件。
 -->
<template>
  <ElSelect class="fluentread-select" popper-class="fluentread-select-popper" v-bind="$attrs"><slot /></ElSelect>
</template>
<script setup lang="ts">
import {ElSelect} from 'element-plus';
import 'element-plus/es/components/select/style/css';
defineOptions({inheritAttrs: false});
</script>
<style>
.fluentread-select { min-width: 0; width: 100%; --el-color-primary: var(--brand, #ef4776); --el-text-color-regular: var(--ink, #172033); --el-text-color-placeholder: var(--muted, #737c8f); --el-fill-color-blank: var(--surface, #fff); }
.fluentread-select .el-select__wrapper { min-height: 38px; padding: 0 11px; border: 1px solid var(--line, #e7e9f0); border-radius: 10px; background: var(--surface-soft, #f7f8fb); box-shadow: none; }
.fluentread-select .el-select__wrapper:hover { border-color: var(--brand, #ef4776); }
.fluentread-select .el-select__wrapper.is-focused { border-color: var(--brand, #ef4776); box-shadow: 0 0 0 3px var(--brand-soft, #fff0f4); }
.fluentread-select .el-select__wrapper.is-disabled { opacity: .6; background: var(--surface-soft, #f7f8fb); }
.fluentread-select .el-select__selected-item { color: var(--ink, #172033); font-size: 12px; }
.fluentread-select-popper.el-popper { max-width: calc(100vw - 20px); border: 1px solid var(--line, #e7e9f0); border-radius: 12px; background: var(--surface, #fff); box-shadow: 0 12px 32px rgba(27,36,57,.16); --el-bg-color-overlay: var(--surface, #fff); --el-border-color-light: var(--line, #e7e9f0); }
.fluentread-select-popper .el-select-dropdown__list { padding: 6px; }
.fluentread-select-popper .el-select-dropdown__item { height: auto; min-height: 34px; padding: 8px 12px; border-radius: 7px; color: var(--ink, #172033); font-size: 12px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.fluentread-select-popper .el-select-dropdown__item.is-hovering { background: var(--surface-soft, #f7f8fb); }
.fluentread-select-popper .el-select-dropdown__item.is-selected { color: var(--brand-strong, #dc315f); background: var(--brand-soft, #fff0f4); font-weight: 700; }
.fluentread-select-popper .el-select-dropdown__item.is-disabled { color: var(--muted, #737c8f); opacity: .6; }
.fluentread-select-popper .el-popper__arrow::before { border-color: var(--line, #e7e9f0); background: var(--surface, #fff); }
</style>

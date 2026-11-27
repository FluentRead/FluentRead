/**
 * @file src/features/settings/public.ts
 * 文件职责：公开设置页面可复用的布局组件，让功能设置通过稳定入口使用统一视觉结构。
 * 主要内容：导出设置分组、设置项与预览布局三个展示组件。
 * 模块边界：只导出展示契约，不公开设置运行时、持久化逻辑或其他内部组件。
 */
export {default as SettingsGroup} from './ui/components/SettingsGroup.vue';
export {default as SettingsDisclosure} from './ui/components/SettingsDisclosure.vue';
export {default as SettingsItem} from './ui/components/SettingsItem.vue';
export {default as SettingsPreviewLayout} from './ui/components/SettingsPreviewLayout.vue';

/**
 * @file userscript/videoSemanticSettings.ts
 * 文件职责：在脚本构建中移除没有后台支持的 AI 断句设置表单。
 * 主要内容：提供不可见的空组件；父设置页原有 extensionDom 门禁保持不变。
 * 模块边界：只替代扩展专属设置组件，不改变视频配置数据、语言资源或运行时能力。
 */
export default {name: 'UserscriptVideoSemanticSettingsUnavailable', render: () => null};

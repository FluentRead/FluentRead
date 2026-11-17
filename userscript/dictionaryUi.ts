/**
 * @file userscript/dictionaryUi.ts
 * 文件职责：在油猴构建边界移除依赖扩展后台的高级词典界面。
 * 主要内容：为两个仅扩展使用的组件提供无资源、无副作用的空展示端口，避免 standalone 解析离线 Worker。
 * 模块边界：只供 userscript alias 使用；不改变浏览器扩展组件或原有在线查词流程。
 */
export default {render: () => null};

/**
 * @file src/features/selection-translation/content/index.ts
 * 文件职责：作为划词翻译网页运行时的稳定出口，向 content feature registry 暴露 Vue 覆盖层的挂载和卸载能力。
 * 主要内容：文件从 runtime.ts 精确再导出 mountSelectionTranslator 与 unmountSelectionTranslator，并从 contextMenuBridge.ts 导出右键触发入口，不暴露异步挂载 Promise、实例引用或 Shadow UI 句柄。
 * 模块边界：这里不读取选区或配置，也不创建 DOM；生命周期细节在 runtime.ts，实际划词交互在 SelectionTranslator.vue，应用组合层负责依据站点和配置启停。
 */
export {
    mountSelectionTranslator,
    translateSelectionFromRange,
    unmountSelectionTranslator,
} from './runtime';
export {translateSelectionFromContextMenu} from './contextMenuBridge';

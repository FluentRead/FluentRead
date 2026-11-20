/**
 * @file src/features/selection-translation/public.ts
 * 文件职责：定义划词翻译 feature 面向应用和少量外部调用者的公共表面，集中暴露内容层生命周期与安全的选区基础判断。
 * 主要内容：再导出 mountSelectionTranslator、unmountSelectionTranslator、右键触发入口与选区基础判断供外部消费。
 * 模块边界：公共出口刻意隐藏词典 provider、TTS 协议、Vue 实例和复杂展示状态；后台注册应使用 background 子路径，组件内部算法可从 feature 私有模块引用。
 */
export {
    mountSelectionTranslator,
    translateSelectionFromContextMenu,
    translateSelectionFromRange,
    unmountSelectionTranslator,
} from './content';
export {
    isSameLanguage,
    normalizeSelectionText,
    readSelectionText,
    shouldIgnoreSelection,
} from './core';

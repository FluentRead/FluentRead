/**
 * @file src/features/command-palette/public.ts
 * 文件职责：为内容脚本组合层提供全局命令面板的稳定公共入口，避免跨层依赖内部实现。
 * 主要内容：重导出命令面板的挂载、卸载、状态查询、显式打开关闭及动作注入端口类型定义。
 * 模块边界：纯 barrel 模块，不在加载时注册事件监听器、创建 DOM 节点或访问持久化存储。
 */
export {
    mountCommandPalette,
    unmountCommandPalette,
    isCommandPaletteMounted,
    openCommandPalette,
    closeCommandPalette,
    type CommandPaletteActionPorts,
} from './content/runtime';

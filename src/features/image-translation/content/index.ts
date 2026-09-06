/**
 * @file src/features/image-translation/content/index.ts
 * 文件职责：作为图片翻译网页运行时的稳定出口，向 feature registry 提供挂载图片悬浮按钮和彻底卸载相关 DOM/监听器的生命周期函数。
 * 主要内容：文件从 runtime.ts 精确再导出 mountImageTranslator、unmountImageTranslator 与 toggleContextMenuImage，隐藏每张图片的 WeakMap 状态、覆盖层节点和超时控制细节。
 * 模块边界：此处不操作页面和不读取配置；内容运行时负责 DOM 协调，后台协议在 services/client，OCR 与绘图在 Offscreen 服务，应用层负责依据浏览器能力决定是否挂载。
 */
export {
    toggleContextMenuImage,
    mountImageTranslator,
    unmountImageTranslator,
} from './runtime';

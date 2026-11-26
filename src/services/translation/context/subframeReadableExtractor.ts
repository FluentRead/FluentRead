/**
 * @file src/services/translation/context/subframeReadableExtractor.ts
 *
 * 文件职责：为受限子 frame 内容脚本提供零依赖的正文提取器占位实现，避免在嵌入播放器与邮件 iframe 中重复内联 Defuddle 与 Turndown。
 * 主要内容：返回 null，使浏览器上下文服务直接复用已清洗的脱离文档正文回退提取逻辑。
 * 模块边界：仅由构建配置在受限子 frame 入口替换 readableExtractor 使用；顶层网页与扩展页仍使用完整正文提取器。
 */

export async function loadReadablePageExtractor(): Promise<null> {
    return null;
}

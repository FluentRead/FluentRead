/**
 * @file src/core/context-menu/feedback.ts
 * 文件职责：定义右键操作失败的有限反馈原因，避免把浏览器异常或网页选区直接展示给用户。
 * 主要内容：声明选区、图片、圈选、停用、页面未就绪和通用失败六类原因，并严格校验跨运行时消息。
 * 模块边界：这里只定义纯数据契约，不读取配置、不发送消息、不创建通知；文案属于 i18n，反馈交付由 app 层负责。
 */
const REASONS = ['selectionUnavailable', 'imageUnavailable', 'areaUnavailable', 'disabled', 'unavailable', 'failed'] as const;
export type ContextMenuFailureReason = typeof REASONS[number];

export function isContextMenuFailureReason(value: unknown): value is ContextMenuFailureReason {
    return typeof value === 'string' && (REASONS as readonly string[]).includes(value);
}

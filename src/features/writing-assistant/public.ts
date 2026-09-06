/**
 * @file src/features/writing-assistant/public.ts
 * 文件职责：提供写作助手对内容脚本应用层的公开组合接口与挂载状态查询。
 * 主要内容：导出内容生命周期，仅用于支持的网页场景。
 * 模块边界：跨 feature 调用仅经过此出口，后台协议由应用层单独组装。
 */
export {mountWritingAssistant, unmountWritingAssistant, isWritingAssistantMounted} from './content';

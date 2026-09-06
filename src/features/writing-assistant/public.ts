/**
 * @file src/features/writing-assistant/public.ts
 * 文件职责：提供写作助手的公开内容生命周期和可复用偏好选项组件。
 * 主要内容：为支持的网页导出挂载状态，为设置页与写作卡片共享无副作用的互斥标签组选项。
 * 模块边界：跨 feature 调用仅经过此出口，选项组件不保存配置或请求模型，后台协议由应用层单独组装。
 */
export {mountWritingAssistant, unmountWritingAssistant, isWritingAssistantMounted} from './content';
export {default as WritingChoices} from './ui/WritingChoices.vue';

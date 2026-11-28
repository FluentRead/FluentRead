/**
 * @file src/features/reading-assistant/public.ts
 * 文件职责：公开阅读选区与纯数据契约、流式阅读和本机学习记忆客户端，避免数据消费者加载阅读卡样式。
 * 主要内容：保留选区捕获、证据锚点、阅读请求和记忆管理导出；纯文本回答结构解析由 answer/public.ts 单独公开，完整阅读卡和记录管理界面由独立 UI 出口提供。
 * 模块边界：此入口不引入 Vue 组件或 UI 样式，不注册事件或初始化模型；客户端仅在显式调用时发送原有后台协议。
 */
export {captureReadingSelection} from './selectionContext';
export {createReadingEvidenceAnchor} from './evidenceAnchor';
export type {ReadingEvidenceAnchor} from './evidenceAnchor';
export type {ReadingSelection} from './types';
export {streamReading, getHarnessSession} from './client';
export {clearLearningMemories, deleteLearningMemory, listLearningMemories, saveLearningMemory} from './client';
export type {LearningMemory} from '@/src/services/harness/learningMemory';

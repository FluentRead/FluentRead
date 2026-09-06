/**
 * @file src/features/reading-assistant/public.ts
 * 文件职责：提供可被划词翻译和设置页复用的阅读卡、回答呈现、选区捕获及纯数据契约。
 * 主要内容：导出阅读卡、共用 Markdown 回答及纯文本结构解析、阅读记录界面、选区捕获与会话和记忆客户端，隐藏后台请求编排与模型实现。
 * 模块边界：只做静态导出，不注册事件或初始化模型；跨 feature 调用保持在这个公开入口。
 */
export {default as ReadingPanel} from './ui/ReadingPanel.vue';
export {default as ReadingAnswer} from './ui/ReadingAnswer.vue';
export {readingAnswerBlocks, readingAnswerSpans} from './answerFormat';
export {default as HarnessReadingHistory} from './ui/HarnessReadingHistory.vue';
export {captureReadingSelection} from './selectionContext';
export type {ReadingSelection} from './types';
export {streamReading} from './client';
export {clearHarnessSessions, deleteHarnessSession, getHarnessSession, listHarnessSessions} from './client';
export {clearLearningMemories, deleteLearningMemory, listLearningMemories, saveLearningMemory} from './client';
export type {LearningMemory, LearningMemoryInput, LearningMemoryKind} from '@/src/services/harness/learningMemory';

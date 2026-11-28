/**
 * @file src/features/selection-translation/speech/public.ts
 * 文件职责：向学习中心与跨 feature 调用方暴露划词朗读的播放所有权控制器、语言规范化及浏览器原生语音兜底辅助，复用统一的朗读通路。
 * 主要内容：静态导出 createSelectionTtsContentController、createSelectionTtsClientRequestId、normalizeSpeechLanguage，以及 browserSpeech 中的 selectBrowserSpeechVoice、loadBrowserSpeechVoices 与 inferWordSpeechLanguage。
 * 模块边界：公共出口不挂载划词 UI、不读取配置或直接发起网络请求；组件自行注入 runtime 消息并管理本页音频与浏览器语音资源。
 */
export {createSelectionTtsContentController} from '../content/selectionTtsContentController';
export {createSelectionTtsClientRequestId} from '../protocol';
export {normalizeSpeechLanguage} from '../core';
export {
    inferWordSpeechLanguage,
    loadBrowserSpeechVoices,
    selectBrowserSpeechVoice,
    type SpeechSynthesisVoiceSource,
} from './browserSpeech';

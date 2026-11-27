/**
 * @file src/core/config/model/types.ts
 *
 * 文件职责：集中声明 FluentRead 核心配置模型使用的纯联合类型与键值映射契约，供配置类、默认值和归一化子模块共享。
 * 主要内容：导出 DeepSeekApiType、DeepSeekThinkingMode、VideoSubtitleDisplayMode、TranslationSidepanelScope、VideoLocalTranscriptionModel、VideoTranscriptionProvider、FullPageTranslationMode、FloatingBallToolsDisplay、FloatingBallClickAction、IMapping 与 IExtra。
 * 模块边界：本文件为纯类型声明模块，不包含任何运行时语句、常量或函数，不产生静态或运行时依赖边。
 */

export type DeepSeekApiType = 'auto' | 'responses' | 'chat';
export type DeepSeekThinkingMode = 'enabled' | 'disabled';
export type VideoSubtitleDisplayMode = 'bilingual' | 'translation-only' | 'original-only';
export type TranslationSidepanelScope = 'tab' | 'window';
export type VideoLocalTranscriptionModel = 'tiny' | 'base' | 'small';
export type VideoTranscriptionProvider = 'browser' | 'native-qwen';
export type FullPageTranslationMode = 'viewport' | 'all';
export type FloatingBallToolsDisplay = 'hover' | 'always' | 'hidden';
export type FloatingBallClickAction = 'translate' | 'settings' | 'none';

export interface IMapping {
    [key: string]: string;
}

export interface IExtra {
    [key: string]: any;
}

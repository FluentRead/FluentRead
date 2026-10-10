/**
 * @file src/features/information-highlight/protocol.ts
 * 文件职责：定义信息高亮的跨上下文纯数据协议及本地模型状态。
 * 主要内容：阅读会话、UTF-16 分数区间、带模型身份的下载状态及评分边界；消息不会携带 DOM、AbortSignal 或模型张量。
 * 模块边界：只导出 feature 公共数据，不导出内容脚本控制器或界面实现；偏好类型复用 core 配置。
 */
import type {InformationHighlightMode} from '@/src/core/config/informationHighlight';
import type {InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';

export interface InformationHighlightState {
    enabled: boolean;
    phase: 'idle' | 'loading-model' | 'analyzing' | 'active' | 'paused' | 'error' | 'unsupported';
    sessionId: string;
    processedParagraphs: number;
    queuedParagraphs: number;
    highlightedSpans: number;
    mode: InformationHighlightMode;
    errorCode?: string;
}
export interface InformationHighlightSpan {start: number; end: number; score: number}
export interface InformationHighlightResult {spans: InformationHighlightSpan[]; engine: string}
export type InformationHighlightModelErrorCode =
    | 'INFORMATION_HIGHLIGHT_MODEL_NETWORK' | 'INFORMATION_HIGHLIGHT_MODEL_INTEGRITY'
    | 'INFORMATION_HIGHLIGHT_STORAGE_QUOTA' | 'INFORMATION_HIGHLIGHT_DOWNLOAD_FAILED' | 'INFORMATION_HIGHLIGHT_REMOVE_FAILED'
    | 'INFORMATION_HIGHLIGHT_MODEL_INITIALIZATION_FAILED' | 'INFORMATION_HIGHLIGHT_MODEL_RUNTIME_FAILED' | 'INFORMATION_HIGHLIGHT_MODEL_TIMEOUT';
export interface InformationHighlightModelStatus {
    modelId: InformationHighlightModelId;
    phase: 'absent' | 'queued' | 'downloading' | 'verifying' | 'paused' | 'ready' | 'error' | 'removing';
    downloaded: boolean;
    initialized: boolean;
    downloadedBytes: number;
    totalBytes: number;
    supported: boolean;
    modelName: string;
    downloadSizeBytes: number;
    reason?: string;
    errorCode?: InformationHighlightModelErrorCode;
}
export const INFORMATION_HIGHLIGHT_DOWNLOAD_ID = 'information-highlight:model';
export const INFORMATION_HIGHLIGHT_MAX_CHARACTERS = 12_000;
export const INFORMATION_HIGHLIGHT_MAX_TOKENS = 2_048;
export const INFORMATION_HIGHLIGHT_CHUNK_TOKENS = 32;

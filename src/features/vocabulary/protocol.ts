/**
 * @file src/features/vocabulary/protocol.ts
 * 文件职责：定义内容页、设置页和后台共用的轻量词书消息合同，作为状态、选项、响应与消息常量的唯一来源，避免调用者引入领域算法或 Dexie 副作用。
 * 主要内容：包含全部四种收藏状态、消息常量、收藏输入、原始视频片段平台与时间、列表与导出选项、动作联合、RuntimeMessage、统一响应和变更通知；线上语境允许缺少正文，领域模型再要求有效正文。
 * 模块边界：协议文件只承载可序列化类型，不校验数据库记录、不计算复习计划也不发送消息；后台 handler 负责验证，learningModel/repository 保持权威领域状态。
 */
export const VOCABULARY_BOOK_MESSAGE = 'fluentReadVocabularyBook' as const;
export const VOCABULARY_BOOK_CHANGED_MESSAGE = 'fluentReadVocabularyBookChanged' as const;

export type VocabularyStatus = 'new' | 'learning' | 'familiar' | 'mastered';
export type VocabularyReviewRating = 'again' | 'good' | 'manual-mastered' | 'relearn';
export type VocabularyScheduledReviewRating = Extract<VocabularyReviewRating, 'again' | 'good'>;

/** 原始媒体时间轴中的片段，不使用译文顺序推算位置；来源地址沿用语境 sourceUrl。 */
export interface VocabularyVideoSource {
    platform: 'youtube' | 'x';
    startMs: number;
    endMs: number;
}

export interface VocabularyContextInput {
    text?: string;
    sourceUrl?: string;
    pageTitle?: string;
    capturedAt?: number;
    video?: VocabularyVideoSource;
}

export interface VocabularyUpsertInput {
    sourceLanguage: string;
    targetLanguage: string;
    term: string;
    translation: string;
    kind?: 'sentence' | 'expression';
    note?: string;
    phonetic?: string;
    partOfSpeech?: string | string[];
    context?: VocabularyContextInput;
    contexts?: VocabularyContextInput[];
}

export interface VocabularyListOptions {
    status?: VocabularyStatus | VocabularyStatus[];
    sourceLanguage?: string;
    targetLanguage?: string;
    search?: string;
    dueOnly?: boolean;
    now?: number;
    order?: 'recent' | 'due' | 'term';
    offset?: number;
    limit?: number;
}

export interface VocabularyExportOptions {
    includePrivateContext?: boolean;
    now?: number;
}

export type VocabularyBookErrorCode =
    | 'invalid-input'
    | 'not-found'
    | 'limit-exceeded'
    | 'invalid-export'
    | 'storage-error';

export type VocabularyBookAction =
    | 'reencounterList'
    | 'reencounterGet'
    | 'list'
    | 'get'
    | 'getByTerm'
    | 'upsert'
    | 'updateNote'
    | 'review'
    | 'setMastery'
    | 'relearn'
    | 'getReviewLogs'
    | 'remove'
    | 'removeWithUndo'
    | 'listUndo'
    | 'restoreUndo'
    | 'discardUndo'
    | 'clear'
    | 'exportData'
    | 'importData';

export interface VocabularyBookRuntimeMessage {
    type: typeof VOCABULARY_BOOK_MESSAGE;
    action?: unknown;
    entryId?: unknown;
    undoId?: unknown;
    term?: unknown;
    word?: unknown;
    sourceLanguage?: unknown;
    rating?: unknown;
    input?: unknown;
    options?: unknown;
    data?: unknown;
    note?: unknown;
}

export type VocabularyBookResponse<T = unknown> =
    | {success: true; data: T}
    | {
        success: false;
        error: {
            code: VocabularyBookErrorCode;
            message: string;
        };
    };

export interface VocabularyBookChangedMessage {
    type: typeof VOCABULARY_BOOK_CHANGED_MESSAGE;
    reason:
        | 'upsert'
        | 'note'
        | 'review'
        | 'manual-mastered'
        | 'relearn'
        | 'remove'
        | 'undo'
        | 'clear'
        | 'import';
    entryId?: string;
}

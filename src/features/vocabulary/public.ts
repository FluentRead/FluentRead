/**
 * @file src/features/vocabulary/public.ts
 * 文件职责：暴露学习收藏供其他 feature 消费的稳定纯领域合同。
 * 主要内容：重导出原文校验、消息请求常量、纯函数与类型；阅读时再次遇见的浏览器生命周期由 content/public.ts 单独公开。
 * 模块边界：本文件保持纯领域出口，不引入 Vue、UI、配置存储或数据库；组件由 vocabulary/ui/public.ts 单独公开。
 */
export {
    vocabularyStudyPrompt,
    normalizeLearningSourceText,
    VOCABULARY_BOOK_EXPORT_FORMAT,
    VOCABULARY_BOOK_EXPORT_VERSION,
    VOCABULARY_BOOK_MESSAGE,
    vocabularyImportNeedsConfirmation,
    type VocabularyBookExport,
    type VocabularyBookRequest,
    type VocabularyBookResponse,
    type VocabularyImportResult,
    type VocabularyVideoSource,
    type VocabularyUpsertInput,
    type VocabularyContext,
    type VocabularyContextInput,
} from './learningModel';
export {sanitizeVocabularyVideoSource, sanitizeVocabularyVideoUrl} from './source';

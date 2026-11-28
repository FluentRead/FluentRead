/**
 * @file src/features/document-translation/ui/formatReaders.ts
 * 文件职责：聚合导出 CSV/TSV 二维电子表格、DOCX 富文本与表格分页、JSON 结构化大纲/树形阅读及字幕时间轴导航视图模型构造器。
 * 主要内容：作为纯导出门面，统一转发 readers/delimitedReader、readers/docxReader、readers/jsonReader 与 readers/subtitleReader 的公开接口和类型定义。
 * 模块边界：仅做模块再导出，不含可执行业务逻辑，不读写浏览器 DOM、不访问网络或压缩包 I/O，也不修改传入的 ParsedDocument。
 */

export {
    delimitedColumnLetter,
    buildDelimitedGrid,
    paginateDelimitedRows,
    type DelimitedGridColumn,
    type DelimitedGridCell,
    type DelimitedGridRow,
    type DelimitedGrid,
    type BuildDelimitedGridOptions,
    type PaginatedDelimitedRows,
} from './readers/delimitedReader';

export {
    parseDocxRelationshipsXml,
    parseDocxOrderedNumberingXml,
    buildDocxRichBlocks,
    paginateDocxBlocks,
    findDocxBlockPage,
    buildDocxOutline,
    type DocxInlineRun,
    type DocxRichParagraph,
    type DocxRichTableCell,
    type DocxRichTableRow,
    type DocxRichBlock,
    type DocxRelationshipMap,
    type BuildDocxRichBlocksOptions,
    type PaginatedDocxBlocks,
    type DocxOutlineItem,
} from './readers/docxReader';

export {
    tokenizeJsonInterpolation,
    buildJsonOutline,
    buildJsonGroupedRows,
    buildJsonTreeNodes,
    type JsonTextToken,
    type JsonOutlineEntry,
    type JsonGroupedRow,
    type JsonRowGroup,
    type PaginatedJsonGroupedRows,
    type JsonValueKind,
    type JsonTreeNode,
    type BuildJsonTreeNodesOptions,
} from './readers/jsonReader';

export {
    parseSubtitleTimestampMs,
    formatSubtitleDuration,
    extractSubtitleMetadata,
    buildSubtitleTimelineOutline,
    type SubtitleTimingMetrics,
    type SubtitleLrcMeta,
    type SubtitleCueMeta,
    type SubtitleDocumentMetadata,
    type SubtitleTimelineBucket,
} from './readers/subtitleReader';

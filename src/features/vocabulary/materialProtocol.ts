/**
 * @file src/features/vocabulary/materialProtocol.ts
 * 文件职责：定义文章、文档与视频学习材料的本地消息合同。
 * 主要内容：材料来源身份、原文定位、学习引用、主题和可序列化请求响应；正文与来源仅进入本地材料库。
 * 模块边界：不访问浏览器、数据库或同步配置；采集器与界面通过 typed client 访问后台权威仓库。
 */
import type {DocumentMaterialReference} from '@/src/features/document-translation/material/public';

export const MATERIAL_MESSAGE = 'fluentReadMaterials' as const;
export const MATERIAL_CHANGED_MESSAGE = 'fluentReadMaterialsChanged' as const;
export const MATERIAL_BACKUP_MAX_BYTES = 20 * 1024 * 1024;
export type MaterialKind = 'article' | 'document' | 'video';
export interface MaterialSource {kind: MaterialKind; url?: string; title?: string; fingerprint?: string}
export interface MaterialLocator {
    kind: 'text' | 'document' | 'video';
    quote?: string; prefix?: string; suffix?: string; paragraphId?: string;
    page?: number; section?: string; startMs?: number; endMs?: number; fingerprint?: string;
    /** 原样保存的精确文档位置；quote 只作展示/搜索，不得代替此引用。 */
    documentReference?: DocumentMaterialReference;
}
export interface MaterialReference {
    kind: 'vocabulary' | 'session' | 'memory' | 'note';
    id: string; excerpt?: string; note?: string; createdAt?: number; updatedAt?: number;
}
export interface MaterialRecord {
    id: string; identityKey: string; aliases?: string[]; kind: MaterialKind; title: string; source: MaterialSource;
    locator?: MaterialLocator; topics: string[]; references: MaterialReference[];
    createdAt: number; updatedAt: number; lastReadAt: number; archivedAt: number | null;
}
export interface MaterialCaptureInput {
    source: MaterialSource; locator?: MaterialLocator; reference?: MaterialReference;
    /** 自动阅读位置更新不会复活归档材料，且不能覆盖显式的新位置。 */
    positionOnly?: boolean;
    /** 编辑旧引用时只更新现存项，迟到保存不得复活其他标签页已删除的笔记。 */
    referenceMode?: 'update-existing';
    generation?: number;
    capturedAt?: number;
}
export interface MaterialPatch {title?: string; topics?: string[]; source?: MaterialSource; locator?: MaterialLocator}
export interface MaterialListOptions {archived?: boolean; topic?: string; search?: string}
export type MaterialErrorCode = 'invalid-input' | 'not-found' | 'privacy-disabled' | 'stale-operation' | 'limit-exceeded' | 'storage-error';
export type MaterialResponse<T = unknown> = {success: true; data: T} | {success: false; error: {code: MaterialErrorCode; message: string}};
export interface MaterialBackup {format: 'fluentread-learning-materials'; version: 1; exportedAt: number; materials: MaterialRecord[]}
export interface MaterialOperationGuard {generation: number; capturedAt: number}
export interface MaterialImportResult {inserted: number; updated: number; skipped: number}
export type MaterialRequest =
    | {type: typeof MATERIAL_MESSAGE; action: 'list'; options?: MaterialListOptions}
    | {type: typeof MATERIAL_MESSAGE; action: 'generation'}
    | {type: typeof MATERIAL_MESSAGE; action: 'get' | 'resolve'; id: string}
    | {type: typeof MATERIAL_MESSAGE; action: 'removeReference'; id: string; kind: MaterialReference['kind']; referenceId: string}
    | {type: typeof MATERIAL_MESSAGE; action: 'capture'; input: MaterialCaptureInput}
    | {type: typeof MATERIAL_MESSAGE; action: 'update'; id: string; patch: MaterialPatch}
    | {type: typeof MATERIAL_MESSAGE; action: 'archive' | 'restore'; id: string}
    | {type: typeof MATERIAL_MESSAGE; action: 'clear' | 'exportData'}
    | {type: typeof MATERIAL_MESSAGE; action: 'importData'; data: unknown; guard?: MaterialOperationGuard};

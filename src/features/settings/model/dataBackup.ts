/**
 * @file src/features/settings/model/dataBackup.ts
 * 文件职责：定义设置、单词本与模型用量的统一本机备份信封，并识别可兼容导入的旧版独立数据文件。
 * 主要内容：提供版本化完整备份类型、严格的顶层结构校验、导入类型识别与预览统计。
 * 模块边界：该模块只处理可序列化数据形状，不读取 IndexedDB、不保存配置、不下载文件；各领域仓库继续拥有自己的校验与合并语义。
 */

import {
    isConfigImportValid,
    type ConfigImportCredentialMode,
} from '@/src/core/config/transfer';
import {
    CONFIG_CREDENTIAL_FIELDS,
    type ConfigCredentialField,
} from '@/src/core/config/credentials';
import {
    VOCABULARY_BOOK_EXPORT_FORMAT,
    VOCABULARY_BOOK_EXPORT_VERSION,
    type VocabularyBookExport,
} from '@/src/features/vocabulary/public';
import {MODEL_USAGE_TRANSFER_FORMAT, MODEL_USAGE_TRANSFER_VERSION, type ModelUsageTransferDocument} from '@/src/services/model-usage/types';

export const FLUENTREAD_DATA_BACKUP_FORMAT = 'fluentread-data-backup' as const;
export const FLUENTREAD_DATA_BACKUP_LEGACY_VERSION = 1 as const;
export const FLUENTREAD_DATA_BACKUP_VERSION = 2 as const;
export const FLUENTREAD_DATA_BACKUP_EXACT_CREDENTIAL_MODE = 'exact-replace' as const;

export interface FluentReadDataBackup {
    format: typeof FLUENTREAD_DATA_BACKUP_FORMAT;
    version: typeof FLUENTREAD_DATA_BACKUP_LEGACY_VERSION | typeof FLUENTREAD_DATA_BACKUP_VERSION;
    configCredentialMode?: typeof FLUENTREAD_DATA_BACKUP_EXACT_CREDENTIAL_MODE;
    exportedAt: number;
    config: Record<string, unknown>;
    vocabulary: VocabularyBookExport;
    modelUsage: ModelUsageTransferDocument;
}

export type LocalDataImport =
    | {kind: 'complete'; backup: FluentReadDataBackup}
    | {kind: 'vocabulary'; vocabulary: VocabularyBookExport}
    | {kind: 'model-usage'; modelUsage: ModelUsageTransferDocument}
    | {kind: 'config'; config: Record<string, unknown>};

export interface LocalDataImportSummary {
    kind: LocalDataImport['kind'];
    configIncluded: boolean;
    vocabularyEntries: number;
    vocabularyReviewLogs: number;
    modelUsageEvents: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isStringMapping(value: unknown): boolean {
    return isPlainRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

const exactCredentialFieldValidators: Record<ConfigCredentialField, (value: unknown) => boolean> = {
    privacyProtectionSecretTerms: value => Array.isArray(value) && value.length <= 128
        && value.every(term => typeof term === 'string' && term.length <= 256),
    token: isStringMapping,
    apiKeys: value => isPlainRecord(value)
        && Object.values(value).every(item => Array.isArray(item) && item.every(key => typeof key === 'string')),
    secret: isStringMapping,
    customHeaders: isStringMapping,
    ak: value => typeof value === 'string',
    sk: value => typeof value === 'string',
    appid: value => typeof value === 'string',
    key: value => typeof value === 'string',
    youdaoAppKey: value => typeof value === 'string',
    youdaoAppSecret: value => typeof value === 'string',
    tencentSecretId: value => typeof value === 'string',
    tencentSecretKey: value => typeof value === 'string',
    extra: isPlainRecord,
};

/** v2 会覆盖整份凭据；早期格式已有的字段必须完整，后来新增的映射允许缺省。 */
function hasExactCredentialSnapshot(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return CONFIG_CREDENTIAL_FIELDS.every(field => (
        // 早期 v2 尚无后续字段；隐私词、secret/请求头缺省为空，apiKeys 从旧 token 迁移。
        // 只兼容缺失，显式提供的畸形值仍须拒绝，不能在校验前用默认值掩盖。
        ((field === 'secret' || field === 'customHeaders' || field === 'apiKeys' || field === 'privacyProtectionSecretTerms')
            && !Object.prototype.hasOwnProperty.call(record, field))
        || (Object.prototype.hasOwnProperty.call(record, field)
        && exactCredentialFieldValidators[field](record[field]))
    ));
}

function isVocabularyExport(value: unknown): value is VocabularyBookExport {
    return isPlainRecord(value)
        && value.format === VOCABULARY_BOOK_EXPORT_FORMAT
        && value.version === VOCABULARY_BOOK_EXPORT_VERSION
        && typeof value.exportedAt === 'number'
        && typeof value.includesPrivateContext === 'boolean'
        && Array.isArray(value.entries)
        && Array.isArray(value.reviewLogs);
}

function isModelUsageExport(value: unknown): value is ModelUsageTransferDocument {
    return isPlainRecord(value)
        && value.format === MODEL_USAGE_TRANSFER_FORMAT
        && value.version === MODEL_USAGE_TRANSFER_VERSION
        && typeof value.exportedAt === 'number'
        && Array.isArray(value.events);
}

export function createFluentReadDataBackup(input: {
    config: Record<string, unknown>;
    vocabulary: VocabularyBookExport;
    modelUsage: ModelUsageTransferDocument;
    exportedAt?: number;
}): FluentReadDataBackup {
    if (!isConfigImportValid(input.config)) throw new TypeError('完整备份中的配置无效');
    if (!hasExactCredentialSnapshot(input.config)) {
        throw new TypeError('完整备份配置的精确凭据快照无效');
    }
    if (!isVocabularyExport(input.vocabulary)) throw new TypeError('完整备份中的单词本数据无效');
    if (!isModelUsageExport(input.modelUsage)) throw new TypeError('完整备份中的模型用量无效');
    const exportedAt = input.exportedAt ?? Date.now();
    if (!Number.isFinite(exportedAt) || exportedAt < 0) throw new TypeError('完整备份导出时间无效');
    return {
        format: FLUENTREAD_DATA_BACKUP_FORMAT,
        version: FLUENTREAD_DATA_BACKUP_VERSION,
        configCredentialMode: FLUENTREAD_DATA_BACKUP_EXACT_CREDENTIAL_MODE,
        exportedAt,
        config: input.config,
        vocabulary: input.vocabulary,
        modelUsage: input.modelUsage,
    };
}

export function parseLocalDataImport(value: unknown): LocalDataImport {
    if (!isPlainRecord(value)) throw new TypeError('备份文件必须是 JSON 对象');

    if (value.format === FLUENTREAD_DATA_BACKUP_FORMAT) {
        if (value.version !== FLUENTREAD_DATA_BACKUP_LEGACY_VERSION
            && value.version !== FLUENTREAD_DATA_BACKUP_VERSION) {
            throw new TypeError('完整备份版本不受支持');
        }
        if (value.version === FLUENTREAD_DATA_BACKUP_VERSION
            && value.configCredentialMode !== FLUENTREAD_DATA_BACKUP_EXACT_CREDENTIAL_MODE) {
            throw new TypeError('完整备份缺少精确凭据快照标记');
        }
        if (!Number.isFinite(value.exportedAt) || (value.exportedAt as number) < 0) {
            throw new TypeError('完整备份导出时间无效');
        }
        if (!isConfigImportValid(value.config)) throw new TypeError('完整备份中的配置无效');
        if (value.version === FLUENTREAD_DATA_BACKUP_VERSION
            && !hasExactCredentialSnapshot(value.config)) {
            throw new TypeError('完整备份配置的精确凭据快照无效');
        }
        if (!isVocabularyExport(value.vocabulary)) throw new TypeError('完整备份中的单词本数据无效');
        if (!isModelUsageExport(value.modelUsage)) throw new TypeError('完整备份中的模型用量无效');
        return {kind: 'complete', backup: value as unknown as FluentReadDataBackup};
    }

    if (isVocabularyExport(value)) return {kind: 'vocabulary', vocabulary: value};
    if (isModelUsageExport(value)) return {kind: 'model-usage', modelUsage: value};
    if (isConfigImportValid(value)) return {kind: 'config', config: value};
    throw new TypeError('不是受支持的 FluentRead 备份或旧版配置文件');
}

/** 只有 v2 明确声明完整凭据快照；旧 v1 可能由未完成水合的页面导出，恢复时必须合并。 */
export function usesExactCredentialReplacement(backup: FluentReadDataBackup): boolean {
    return backup.version === FLUENTREAD_DATA_BACKUP_VERSION
        && backup.configCredentialMode === FLUENTREAD_DATA_BACKUP_EXACT_CREDENTIAL_MODE
        && hasExactCredentialSnapshot(backup.config);
}

/**
 * v2 带有经过校验的完整凭据快照，可以精确替换。v1 没有水合完成标记，
 * 其默认空标量不能证明用户主动清空，因此使用只接受非空标量的安全合并。
 */
export function resolveBackupConfigCredentialMode(
    backup: FluentReadDataBackup,
): ConfigImportCredentialMode {
    return usesExactCredentialReplacement(backup) ? 'replace' : 'merge-hydration-safe';
}

export function summarizeLocalDataImport(value: LocalDataImport): LocalDataImportSummary {
    if (value.kind === 'complete') {
        return {
            kind: value.kind,
            configIncluded: true,
            vocabularyEntries: value.backup.vocabulary.entries.length,
            vocabularyReviewLogs: value.backup.vocabulary.reviewLogs.length,
            modelUsageEvents: value.backup.modelUsage.events.length,
        };
    }
    if (value.kind === 'vocabulary') {
        return {
            kind: value.kind,
            configIncluded: false,
            vocabularyEntries: value.vocabulary.entries.length,
            vocabularyReviewLogs: value.vocabulary.reviewLogs.length,
            modelUsageEvents: 0,
        };
    }
    if (value.kind === 'config') {
        return {
            kind: value.kind,
            configIncluded: true,
            vocabularyEntries: 0,
            vocabularyReviewLogs: 0,
            modelUsageEvents: 0,
        };
    }
    return {
        kind: value.kind,
        configIncluded: false,
        vocabularyEntries: 0,
        vocabularyReviewLogs: 0,
        modelUsageEvents: value.modelUsage.events.length,
    };
}

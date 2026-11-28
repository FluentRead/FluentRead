/**
 * @file src/services/config/learningCloudSync.ts
 * 文件职责：将本地单词本、个人校订与阅读材料仓库适配为云同步学习资产的捕获、预览与应用端口。
 * 主要内容：按显式勾选范围只读投影词条、校订规则与无二进制大文件的材料元数据，在下载或合并确认后以原子方式回写本地仓库，同时保留未同步的本地扩展引用与撤销记录。
 * 模块边界：仅通过依赖注入访问本地仓库端口，不直接操作网络、加密、设置界面或浏览器消息。
 */
import {
    buildLearningSyncDiff,
    hasAnyLearningSyncScope,
    hasLearningBundleContent,
    LEARNING_SYNC_FORMAT,
    LEARNING_SYNC_MAX_MATERIAL_NOTES,
    LEARNING_SYNC_MAX_MATERIAL_TOPICS,
    LEARNING_SYNC_MAX_MATERIALS,
    LEARNING_SYNC_MAX_VOCABULARY,
    LEARNING_SYNC_VERSION,
    LearningSyncError,
    mergeLearningPersonalCorrections,
    validateLearningSyncBundle,
    type LearningSyncBundle,
    type LearningSyncMaterialLocator,
    type LearningSyncMaterialNote,
    type LearningSyncPreviewSummary,
    type LearningSyncReadingMaterial,
    type LearningSyncScope,
    type LearningSyncVocabularyEntry,
} from '@/src/core/config/learningSync';
import type {VocabularyBookExport, VocabularyExportOptions} from '@/src/features/vocabulary/learningModel';
import type {MaterialBackup, MaterialRecord, MaterialReference} from '@/src/features/vocabulary/materialProtocol';
import type {PersonalCorrectionStore} from '@/src/services/personal-corrections/store';

export interface LearningSyncVocabularyPort {
    exportData(options?: VocabularyExportOptions): Promise<VocabularyBookExport>;
    importData(data: unknown, now?: number): Promise<unknown>;
}

export interface LearningSyncMaterialPort {
    exportData(now?: number): Promise<MaterialBackup>;
    importData(input: unknown, now?: number): Promise<unknown>;
}

export interface LearningCloudSyncPorts {
    vocabulary: LearningSyncVocabularyPort;
    personalCorrections: PersonalCorrectionStore;
    materials: LearningSyncMaterialPort;
    now?: () => number;
}

export interface LearningCloudSyncService {
    captureLocal(scope: LearningSyncScope): Promise<LearningSyncBundle | null>;
    preview(scope: LearningSyncScope, local: LearningSyncBundle | null, remote: LearningSyncBundle | null): {
        merged: LearningSyncBundle;
        summary: LearningSyncPreviewSummary;
    };
    selectCloudBundle(
        direction: 'upload' | 'download' | 'merge',
        scope: LearningSyncScope,
        local: LearningSyncBundle | null,
        remote: LearningSyncBundle | null,
        merged: LearningSyncBundle | null,
    ): LearningSyncBundle | null;
    applyLocal(
        direction: 'upload' | 'download' | 'merge',
        scope: LearningSyncScope,
        remote: LearningSyncBundle | null,
        merged: LearningSyncBundle | null,
    ): Promise<void>;
}

function stripUndefined<T extends object>(record: T): T {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function projectMaterialLocator(locator: MaterialRecord['locator']): LearningSyncMaterialLocator | undefined {
    if (!locator) return undefined;
    return stripUndefined<LearningSyncMaterialLocator>({
        kind: locator.kind,
        quote: locator.quote?.slice(0, 500),
        page: locator.page,
        section: locator.section?.slice(0, 240),
        startMs: locator.startMs,
        endMs: locator.endMs,
        fingerprint: locator.fingerprint?.slice(0, 128),
    });
}

function projectMaterialRecord(record: MaterialRecord): LearningSyncReadingMaterial {
    const notes: LearningSyncMaterialNote[] = record.references
        .filter((ref): ref is MaterialReference => ref.kind === 'note')
        .slice(0, LEARNING_SYNC_MAX_MATERIAL_NOTES)
        .map(ref => stripUndefined<LearningSyncMaterialNote>({
            id: ref.id,
            excerpt: ref.excerpt?.slice(0, 500),
            note: ref.note?.slice(0, 4_000),
            createdAt: ref.createdAt,
            updatedAt: ref.updatedAt,
        }));
    const locator = projectMaterialLocator(record.locator);
    return stripUndefined<LearningSyncReadingMaterial>({
        id: record.id,
        identityKey: record.identityKey,
        aliases: record.aliases?.length ? record.aliases.slice(-100) : undefined,
        kind: record.kind,
        title: record.title.slice(0, 240),
        source: stripUndefined({
            kind: record.source.kind,
            url: record.source.url,
            title: record.source.title?.slice(0, 240),
            fingerprint: record.source.fingerprint,
        }),
        locator,
        topics: record.topics.slice(0, LEARNING_SYNC_MAX_MATERIAL_TOPICS),
        notes,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastReadAt: record.lastReadAt,
        archivedAt: record.archivedAt,
    });
}

function toMaterialRecord(item: LearningSyncReadingMaterial, existing?: MaterialRecord): MaterialRecord {
    const preservedRefs = (existing?.references ?? []).filter(ref => ref.kind !== 'note');
    const noteRefs: MaterialReference[] = item.notes.map(note => stripUndefined<MaterialReference>({
        kind: 'note',
        id: note.id,
        excerpt: note.excerpt,
        note: note.note,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
    }));
    return stripUndefined<MaterialRecord>({
        id: existing?.id ?? item.id,
        identityKey: item.identityKey,
        aliases: item.aliases?.length ? [...item.aliases] : undefined,
        kind: item.kind,
        title: item.title,
        source: {...item.source},
        locator: item.locator ? {...item.locator} : undefined,
        topics: [...item.topics],
        references: [...preservedRefs, ...noteRefs].slice(0, 1_000),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastReadAt: item.lastReadAt,
        archivedAt: item.archivedAt,
    });
}

export function createLearningCloudSync(ports: LearningCloudSyncPorts): LearningCloudSyncService {
    const now = ports.now ?? Date.now;

    async function captureLocal(scope: LearningSyncScope): Promise<LearningSyncBundle | null> {
        if (!hasAnyLearningSyncScope(scope)) return null;
        const bundle: LearningSyncBundle = {
            format: LEARNING_SYNC_FORMAT,
            version: LEARNING_SYNC_VERSION,
        };
        if (scope.includeVocabulary) {
            const exported = await ports.vocabulary.exportData({
                includePrivateContext: scope.includeVocabularyContext,
                now: now(),
            });
            const entries: LearningSyncVocabularyEntry[] = exported.entries
                .slice(0, LEARNING_SYNC_MAX_VOCABULARY)
                .map(entry => stripUndefined<LearningSyncVocabularyEntry>({
                    id: entry.id,
                    identityKey: entry.identityKey,
                    sourceLanguage: entry.sourceLanguage,
                    term: entry.term,
                    normalizedTerm: entry.normalizedTerm,
                    kind: entry.kind,
                    note: entry.note,
                    noteUpdatedAt: entry.noteUpdatedAt,
                    translations: structuredClone(entry.translations),
                    phonetic: entry.phonetic,
                    partOfSpeech: entry.partOfSpeech,
                    contexts: entry.contexts.map(ctx => (
                        scope.includeVocabularyContext
                            ? stripUndefined({
                                capturedAt: ctx.capturedAt,
                                text: ctx.text,
                                sourceUrl: ctx.sourceUrl,
                                pageTitle: ctx.pageTitle,
                            })
                            : {capturedAt: ctx.capturedAt}
                    )),
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                    lastSeenAt: entry.lastSeenAt,
                    encounterCount: entry.encounterCount,
                    masteryLevel: entry.masteryLevel,
                    status: entry.status,
                    nextReviewAt: entry.nextReviewAt,
                    lastReviewedAt: entry.lastReviewedAt,
                    reviewCount: entry.reviewCount,
                    lapseCount: entry.lapseCount,
                    schemaVersion: 1,
                }));
            bundle.vocabulary = {
                includesContext: scope.includeVocabularyContext,
                entries,
            };
        }
        if (scope.includePersonalCorrections) {
            const {value} = await ports.personalCorrections.read();
            bundle.personalCorrections = structuredClone(value.state);
        }
        if (scope.includeReadingMaterials) {
            const exported = await ports.materials.exportData(now());
            bundle.readingMaterials = exported.materials
                .slice(0, LEARNING_SYNC_MAX_MATERIALS)
                .map(projectMaterialRecord);
        }
        return validateLearningSyncBundle(bundle);
    }

    function preview(scope: LearningSyncScope, local: LearningSyncBundle | null, remote: LearningSyncBundle | null) {
        return buildLearningSyncDiff(scope, local, remote);
    }

    function selectCloudBundle(
        direction: 'upload' | 'download' | 'merge',
        scope: LearningSyncScope,
        local: LearningSyncBundle | null,
        remote: LearningSyncBundle | null,
        merged: LearningSyncBundle | null,
    ): LearningSyncBundle | null {
        if (direction === 'download') return remote;
        if (direction === 'merge') {
            return hasLearningBundleContent(merged) ? merged : null;
        }
        // 上传时仅更新本次启用的学习类别，保留云端其他未勾选的既有类别以免误删。
        const next: LearningSyncBundle = {format: LEARNING_SYNC_FORMAT, version: LEARNING_SYNC_VERSION};
        if (scope.includeVocabulary && local?.vocabulary) next.vocabulary = structuredClone(local.vocabulary);
        else if (remote?.vocabulary) next.vocabulary = structuredClone(remote.vocabulary);

        if (scope.includePersonalCorrections && local?.personalCorrections) next.personalCorrections = structuredClone(local.personalCorrections);
        else if (remote?.personalCorrections) next.personalCorrections = structuredClone(remote.personalCorrections);

        if (scope.includeReadingMaterials && local?.readingMaterials) next.readingMaterials = structuredClone(local.readingMaterials);
        else if (remote?.readingMaterials) next.readingMaterials = structuredClone(remote.readingMaterials);

        return hasLearningBundleContent(next) ? validateLearningSyncBundle(next) : null;
    }

    async function applyPersonalCorrections(incoming: NonNullable<LearningSyncBundle['personalCorrections']>): Promise<void> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const {value, expected} = await ports.personalCorrections.read();
            const merged = mergeLearningPersonalCorrections(value.state, incoming).merged;
            const cleanEntries = merged.entries.map(({updatedAt: _updatedAt, ...rest}) => rest);
            const committed = await ports.personalCorrections.write(expected, {
                state: {
                    version: 1,
                    revision: merged.revision,
                    entries: cleanEntries,
                    projects: merged.projects,
                    memberships: merged.memberships,
                },
                undo: value.undo,
            });
            if (committed) return;
        }
        throw new LearningSyncError('个人校订在同步期间发生变化，请重新生成预览后重试');
    }

    async function applyLocal(
        direction: 'upload' | 'download' | 'merge',
        scope: LearningSyncScope,
        remote: LearningSyncBundle | null,
        merged: LearningSyncBundle | null,
    ): Promise<void> {
        if (direction === 'upload' || !hasAnyLearningSyncScope(scope)) return;
        const source = direction === 'merge' ? merged : remote;
        if (!source) return;
        const timestamp = now();
        if (scope.includeVocabulary && source.vocabulary) {
            await ports.vocabulary.importData({
                format: 'fluentread-vocabulary-book',
                version: 1,
                exportedAt: timestamp,
                includesPrivateContext: source.vocabulary.includesContext,
                entries: source.vocabulary.entries,
                reviewLogs: [],
            }, timestamp);
        }
        if (scope.includePersonalCorrections && source.personalCorrections) {
            await applyPersonalCorrections(source.personalCorrections);
        }
        if (scope.includeReadingMaterials && source.readingMaterials) {
            const existing = await ports.materials.exportData(timestamp);
            const existingByIdentity = new Map(existing.materials.map(item => [item.identityKey, item]));
            const materials = source.readingMaterials.map(item => toMaterialRecord(item, existingByIdentity.get(item.identityKey)));
            await ports.materials.importData({
                format: 'fluentread-learning-materials',
                version: 1,
                exportedAt: timestamp,
                materials,
            }, timestamp);
        }
    }

    return {captureLocal, preview, selectCloudBundle, applyLocal};
}

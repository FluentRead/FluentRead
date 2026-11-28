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
    LEARNING_SYNC_MAX_CORRECTION_PROJECTS,
    LEARNING_SYNC_MAX_CORRECTIONS,
    LEARNING_SYNC_MAX_CORRECTIONS_BYTES,
    LEARNING_SYNC_MAX_MATERIAL_FINGERPRINT,
    LEARNING_SYNC_MAX_MATERIAL_NOTES,
    LEARNING_SYNC_MAX_MATERIAL_TOPICS,
    LEARNING_SYNC_MAX_MATERIAL_URL,
    LEARNING_SYNC_MAX_MATERIALS,
    LEARNING_SYNC_MAX_VOCABULARY,
    LEARNING_SYNC_VERSION,
    LearningSyncError,
    mergeLearningPersonalCorrections,
    validateLearningSyncBundle,
    type LearningSyncBundle,
    type LearningSyncMaterialLocator,
    type LearningSyncMaterialNote,
    type LearningSyncMaterialSource,
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
    importData(input: unknown, now?: number, guard?: unknown, options?: {authoritative?: boolean}): Promise<unknown>;
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
    validateApply(
        direction: 'upload' | 'download' | 'merge',
        scope: LearningSyncScope,
        remote: LearningSyncBundle | null,
        merged: LearningSyncBundle | null,
    ): Promise<void>;
    applyLocal(
        direction: 'upload' | 'download' | 'merge',
        scope: LearningSyncScope,
        remote: LearningSyncBundle | null,
        merged: LearningSyncBundle | null,
    ): Promise<void>;
}

const MATERIAL_REPO_MAX_RECORDS = 10_000;

function stripUndefined<T extends object>(record: T): T {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function projectMaterialLocator(locator: MaterialRecord['locator']): LearningSyncMaterialLocator | undefined {
    if (!locator) return undefined;
    const page = typeof locator.page === 'number' && Number.isSafeInteger(locator.page) && locator.page >= 1 && locator.page <= 1_000_000
        ? locator.page
        : undefined;
    const startMs = typeof locator.startMs === 'number' && Number.isFinite(locator.startMs) && locator.startMs >= 0
        ? Math.floor(locator.startMs)
        : undefined;
    const endMs = typeof locator.endMs === 'number' && Number.isFinite(locator.endMs) && locator.endMs >= (startMs ?? 0)
        ? Math.floor(locator.endMs)
        : undefined;
    return stripUndefined<LearningSyncMaterialLocator>({
        kind: locator.kind,
        quote: locator.quote?.slice(0, 6_000),
        page,
        section: locator.section?.slice(0, 240),
        startMs,
        endMs,
        fingerprint: locator.fingerprint?.slice(0, LEARNING_SYNC_MAX_MATERIAL_FINGERPRINT),
    });
}

function projectMaterialRecord(record: MaterialRecord): LearningSyncReadingMaterial {
    const notes: LearningSyncMaterialNote[] = record.references
        .filter((ref): ref is MaterialReference => ref.kind === 'note')
        .slice(0, LEARNING_SYNC_MAX_MATERIAL_NOTES)
        .map(ref => stripUndefined<LearningSyncMaterialNote>({
            id: ref.id,
            excerpt: ref.excerpt?.slice(0, 6_000),
            note: ref.note?.slice(0, 12_000),
            createdAt: ref.createdAt,
            updatedAt: ref.updatedAt,
        }));
    const locator = projectMaterialLocator(record.locator);
    return stripUndefined<LearningSyncReadingMaterial>({
        id: record.id,
        identityKey: record.identityKey.slice(0, LEARNING_SYNC_MAX_MATERIAL_URL + 16),
        aliases: record.aliases?.length ? record.aliases.slice(-100).map(alias => alias.slice(0, LEARNING_SYNC_MAX_MATERIAL_URL + 16)) : undefined,
        kind: record.kind,
        title: record.title.slice(0, 240),
        source: stripUndefined({
            kind: record.source.kind,
            url: record.source.url?.slice(0, LEARNING_SYNC_MAX_MATERIAL_URL),
            title: record.source.title?.slice(0, 240),
            fingerprint: record.source.fingerprint?.slice(0, LEARNING_SYNC_MAX_MATERIAL_FINGERPRINT),
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

function mergePreservedLocator(
    incoming: LearningSyncMaterialLocator | undefined,
    source: LearningSyncMaterialSource,
    existing?: MaterialRecord,
): MaterialRecord['locator'] {
    if (!incoming) return undefined;
    const local = existing?.locator;
    if (!local || local.kind !== incoming.kind) return {...incoming};
    const sameQuote = !incoming.quote || !local.quote || incoming.quote === local.quote;
    const sameFingerprint = !source.fingerprint || !local.fingerprint || local.fingerprint === source.fingerprint;
    const samePage = incoming.page === undefined || local.page === undefined || incoming.page === local.page;
    const keepTextAnchors = sameQuote && sameFingerprint;
    const keepDocRef = incoming.kind === 'document'
        && source.kind === 'document'
        && Boolean(local.documentReference)
        && samePage
        && sameFingerprint
        && (!source.fingerprint || local.documentReference!.materialId === source.fingerprint);
    return stripUndefined({
        ...incoming,
        ...(keepTextAnchors ? {
            prefix: local.prefix,
            suffix: local.suffix,
            paragraphId: local.paragraphId,
        } : {}),
        ...(keepDocRef ? {
            fingerprint: local.documentReference!.materialId,
            documentReference: structuredClone(local.documentReference),
        } : {}),
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
    const source: LearningSyncMaterialSource = stripUndefined({
        ...item.source,
        fingerprint: item.source.fingerprint ?? existing?.source.fingerprint,
    });
    return stripUndefined<MaterialRecord>({
        id: existing?.id ?? item.id,
        identityKey: item.identityKey,
        aliases: item.aliases?.length ? [...item.aliases] : undefined,
        kind: item.kind,
        title: item.title,
        source,
        locator: mergePreservedLocator(item.locator, source, existing),
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
            if (exported.entries.length > LEARNING_SYNC_MAX_VOCABULARY) {
                throw new LearningSyncError('本机单词本超出 5000 条同步上限，请清理后再同步');
            }
            const entries: LearningSyncVocabularyEntry[] = exported.entries
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
            const sorted = [...exported.materials].sort((a, b) => b.lastReadAt - a.lastReadAt || a.identityKey.localeCompare(b.identityKey));
            bundle.readingMaterials = sorted
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

    async function validateApply(
        direction: 'upload' | 'download' | 'merge',
        scope: LearningSyncScope,
        remote: LearningSyncBundle | null,
        merged: LearningSyncBundle | null,
    ): Promise<void> {
        if (direction === 'upload' || !hasAnyLearningSyncScope(scope)) return;
        const source = direction === 'merge' ? merged : remote;
        if (!source) return;
        if (scope.includeVocabulary && source.vocabulary) {
            const existing = await ports.vocabulary.exportData({includePrivateContext: false, now: now()});
            const keys = new Set(existing.entries.map(entry => entry.identityKey));
            for (const entry of source.vocabulary.entries) keys.add(entry.identityKey);
            if (keys.size > LEARNING_SYNC_MAX_VOCABULARY) {
                throw new LearningSyncError('合并后的单词本超出 5000 条上限，请清理后再同步');
            }
        }
        if (scope.includePersonalCorrections && source.personalCorrections) {
            const {value} = await ports.personalCorrections.read();
            const projectIds = new Set([
                ...value.state.projects.map(project => project.id),
                ...source.personalCorrections.projects.map(project => project.id),
            ]);
            const entryKeys = new Set([
                ...value.state.entries.map(entry => `${entry.scope.kind}\u0000${entry.scope.id}\u0000${entry.sourceLanguage}\u0000${entry.targetLanguage}\u0000${entry.source}`),
                ...source.personalCorrections.entries.map(entry => `${entry.scope.kind}\u0000${entry.scope.id}\u0000${entry.sourceLanguage}\u0000${entry.targetLanguage}\u0000${entry.source}`),
            ]);
            const membershipIds = new Set([
                ...value.state.memberships.map(item => item.materialId),
                ...source.personalCorrections.memberships.map(item => item.materialId),
            ]);
            if (entryKeys.size > LEARNING_SYNC_MAX_CORRECTIONS
                || projectIds.size > LEARNING_SYNC_MAX_CORRECTION_PROJECTS
                || membershipIds.size > LEARNING_SYNC_MAX_CORRECTIONS) {
                throw new LearningSyncError('合并后的个人校订超出条目上限，请清理后再同步');
            }
            const combined = mergeLearningPersonalCorrections(value.state, source.personalCorrections).merged;
            const cleanEntries = combined.entries.map(({updatedAt: _updatedAt, ...rest}) => rest);
            const nextState = {
                version: 1 as const,
                revision: combined.revision,
                entries: cleanEntries,
                projects: combined.projects,
                memberships: combined.memberships,
            };
            const bytes = new TextEncoder().encode(JSON.stringify({state: nextState, undo: []})).length;
            if (bytes > LEARNING_SYNC_MAX_CORRECTIONS_BYTES) {
                throw new LearningSyncError('合并后的个人校订超过 4 MiB 上限，请清理后再同步');
            }
        }
        if (scope.includeReadingMaterials && source.readingMaterials) {
            const existing = await ports.materials.exportData(now());
            const keys = new Set(existing.materials.map(item => item.identityKey));
            for (const item of source.readingMaterials) keys.add(item.identityKey);
            if (keys.size > MATERIAL_REPO_MAX_RECORDS) {
                throw new LearningSyncError('合并后的阅读材料超出上限，请清理后再同步');
            }
        }
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
            const includeContext = scope.includeVocabularyContext;
            const entries = source.vocabulary.entries.map(entry => ({
                ...entry,
                contexts: entry.contexts.map(ctx => (includeContext ? {...ctx} : {capturedAt: ctx.capturedAt})),
            }));
            await ports.vocabulary.importData({
                format: 'fluentread-vocabulary-book',
                version: 1,
                exportedAt: timestamp,
                includesPrivateContext: includeContext,
                entries,
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
            }, timestamp, undefined, {authoritative: true});
        }
    }

    return {captureLocal, preview, selectCloudBundle, validateApply, applyLocal};
}

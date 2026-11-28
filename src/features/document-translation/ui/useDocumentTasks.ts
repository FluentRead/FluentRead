/**
 * @file src/features/document-translation/ui/useDocumentTasks.ts
 * PDF 批注：当前文件的可选批注数组由同一个任务拥有，切换文件不共享批注状态，历史提交沿用文件修订。
 * 文件职责：持有文档阅读页面的任务队列和当前任务选择，为阅读、校订、翻译与导出提供同一份响应式任务状态。
 * 主要内容：定义每份文件的译文、人工确认、重译缓存策略、修订、导出和历史读取失败状态，提供无额外数组分配的译文完成计数辅助、单次响应式提交整批译文的 applyDocumentTranslations/setDocumentTranslationBatch 与基于缓存计算的 completedCount/hasTranslation，以可写 computed 将当前任务字段交给页面；没有打开文件时使用独立空状态，切换不复制译文或修订，清空后不保留旧任务引用。
 * 模块边界：只管理文档 feature 的页面模型，不发起网络、OCR、解析、历史保存或下载；异步提交资格和资源释放由任务运行时与页面生命周期负责，配置草稿独立管理。
 */
import {computed, reactive, ref, toRaw, type WritableComputedRef} from 'vue';
import type {ParsedDocument} from '../core/document';
import type {PdfAnnotation} from '../core/pdfAnnotations';
import type {DocumentRetainedRevision} from '../services/history';

export interface DocumentTranslationUpdate {
    id: number;
    translation: string;
}

export interface DocumentTaskState {
    document: ParsedDocument | null;
    translations: string[];
    confirmedTranslationIds: number[];
    fingerprint: string;
    state: 'ready' | 'paused' | 'failed';
    revision: number;
    downloaded: number;
    error: string;
    batchTranslation: boolean;
    /** 用户确认的重译持续跳过旧缓存，暂停、失败和切换文件时保留当前任务的选择。 */
    bypassCache: boolean;
}

export interface DocumentQueueItem extends DocumentTaskState {
    pdfAnnotations?: PdfAnnotation[];
    delimitedColumns?: readonly number[];
    id: number;
    name: string;
    originalFile?: File;
    historyId?: string;
    bytes?: Uint8Array;
    mimeType?: string;
    savedRevision?: number;
    /** 本次导入未能确认旧记录时禁止按同一指纹自动写回，避免覆盖已有校订。 */
    historyReadUnavailable?: boolean;
    /** 最后读取或成功写入的历史记录身份；null 表示确认没有记录。 */
    historyVersion?: string | null;
    historyConflict?: boolean;
    sourceUrl?: string;
    retainedRevisions?: DocumentRetainedRevision[];
}

export function createDocumentTaskState(): DocumentTaskState {
    return {
        document: null, translations: [], confirmedTranslationIds: [], fingerprint: '',
        state: 'ready', revision: 0, downloaded: 0, error: '', batchTranslation: true, bypassCache: false,
    };
}

/** 单趟统计有效译文数，不创建中间过滤数组；传入片段集合时仅统计目标范围。 */
export function countCompletedTranslations(
    translations: readonly string[],
    segments?: readonly {id: number}[],
): number {
    let completed = 0;
    if (segments) {
        for (let index = 0; index < segments.length; index += 1) {
            if (translations[segments[index].id]?.trim()) completed += 1;
        }
        return completed;
    }
    for (let index = 0; index < translations.length; index += 1) {
        if (translations[index]?.trim()) completed += 1;
    }
    return completed;
}

/** 一次响应式替换提交整批译文并返回已完成片段数的精确增量，避免逐段写入反复触发视图重算。 */
export function applyDocumentTranslations(
    task: Pick<DocumentTaskState, 'translations'>,
    entries: readonly DocumentTranslationUpdate[],
): number {
    if (!entries.length) return 0;
    const current = toRaw(task.translations);
    let next: string[] | undefined;
    let delta = 0;
    for (const {id, translation} of entries) {
        const source = next ?? current;
        const previous = source[id] ?? '';
        if (previous === translation) continue;
        if (!next) next = current.slice();
        const had = previous.trim().length > 0;
        const has = translation.trim().length > 0;
        if (had !== has) delta += has ? 1 : -1;
        next[id] = translation;
    }
    if (next) task.translations = next;
    return delta;
}

/** 字段引用始终指向队列中的任务，页面与任务列表不维护互相拷贝的第二份状态。 */
export function useDocumentTasks() {
    const documentQueue = ref<DocumentQueueItem[]>([]);
    const activeDocumentId = ref<number | null>(null);
    const emptyState = reactive(createDocumentTaskState());
    const activeTask = computed(() => documentQueue.value.find(item => item.id === activeDocumentId.value) ?? null);

    function field<K extends keyof DocumentTaskState>(key: K): WritableComputedRef<DocumentTaskState[K]> {
        return computed({
            get: () => (activeTask.value ?? emptyState)[key],
            set: value => { (activeTask.value ?? emptyState)[key] = value; },
        });
    }

    const parsedDocument = field('document');
    const translatedSegments = field('translations');
    const completedCount = computed(() => countCompletedTranslations(translatedSegments.value, parsedDocument.value?.segments));
    const hasTranslation = computed(() => completedCount.value > 0);

    function setDocumentTranslationBatch(entries: readonly DocumentTranslationUpdate[]): number {
        return applyDocumentTranslations(activeTask.value ?? emptyState, entries);
    }

    function clearSelection(): void {
        activeDocumentId.value = null;
        Object.assign(emptyState, createDocumentTaskState());
    }

    function clear(): void {
        documentQueue.value = [];
        clearSelection();
    }

    return {
        documentQueue, activeDocumentId, activeTask, clearSelection, clear,
        parsedDocument, translatedSegments, completedCount, hasTranslation, setDocumentTranslationBatch,
        confirmedTranslationIds: field('confirmedTranslationIds'), taskFingerprint: field('fingerprint'),
        runState: field('state'), editRevision: field('revision'), downloadedRevision: field('downloaded'),
        errorMessage: field('error'), documentBatchTranslation: field('batchTranslation'),
        bypassCache: field('bypassCache'),
    };
}

/**
 * @file src/features/document-translation/ui/useDocumentTasks.ts
 * 文件职责：持有文档阅读页面的任务队列和当前任务选择，为阅读、校订、翻译与导出提供同一份响应式任务状态。
 * 主要内容：定义每份文件的译文、人工确认、重译缓存策略、修订、导出和历史读取失败状态，以可写 computed 将当前任务字段交给页面；没有打开文件时使用独立空状态，切换不复制译文或修订，清空后不保留旧任务引用。
 * 模块边界：只管理文档 feature 的页面模型，不发起网络、OCR、解析、历史保存或下载；异步提交资格和资源释放由任务运行时与页面生命周期负责，配置草稿独立管理。
 */
import {computed, reactive, ref, type WritableComputedRef} from 'vue';
import type {ParsedDocument} from '../core/document';
import type {DocumentRetainedRevision} from '../services/history';

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
        parsedDocument: field('document'), translatedSegments: field('translations'),
        confirmedTranslationIds: field('confirmedTranslationIds'), taskFingerprint: field('fingerprint'),
        runState: field('state'), editRevision: field('revision'), downloadedRevision: field('downloaded'),
        errorMessage: field('error'), documentBatchTranslation: field('batchTranslation'),
        bypassCache: field('bypassCache'),
    };
}

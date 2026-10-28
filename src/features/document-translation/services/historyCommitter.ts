/**
 * @file src/features/document-translation/services/historyCommitter.ts
 * 文件职责：协调文档任务修订与本地历史保存的确认时机，只有数据库接受快照后才标记任务已保存。
 * 主要内容：同一文件历史按发起顺序串行写入，同一任务修订在途时复用一次保存；失败或容量拒绝保留 dirty 状态供后续重试，旧确认不会降低较新的已保存修订，结算后释放队列与任务引用。
 * 模块边界：只协调传入的历史保存端口和任务修订，不读取页面或全局配置、不构造解析快照、不清理历史数据库，也不把文档发送到网络。
 */
import type {DocumentHistoryRecord} from './history';

interface DocumentHistoryRevisionOwner {
    revision: number;
    savedRevision?: number;
}

export function createDocumentHistoryCommitter<T extends DocumentHistoryRevisionOwner = DocumentHistoryRevisionOwner>(save: (record: DocumentHistoryRecord, owner: T) => Promise<boolean>) {
    const tails = new Map<string, Promise<void>>();
    const pending = new WeakMap<DocumentHistoryRevisionOwner, Map<number, Promise<boolean>>>();

    return {
        save(owner: T, record: DocumentHistoryRecord): Promise<boolean> {
            const revision = owner.revision;
            if (revision === owner.savedRevision) return Promise.resolve(true);
            const previousRequest = pending.get(owner)?.get(revision);
            if (previousRequest) return previousRequest;
            const requests = pending.get(owner) ?? new Map<number, Promise<boolean>>();
            pending.set(owner, requests);
            const previous = tails.get(record.id) ?? Promise.resolve();
            const operation = previous.then(() => save(record, owner)).then(written => {
                if (written) owner.savedRevision = Math.max(owner.savedRevision ?? -1, revision);
                return written;
            }).catch(() => false);
            requests.set(revision, operation);
            const tail = operation.then(() => {
                requests.delete(revision);
                if (!requests.size) pending.delete(owner);
                if (tails.get(record.id) === tail) tails.delete(record.id);
            });
            tails.set(record.id, tail);
            return operation;
        },
    };
}

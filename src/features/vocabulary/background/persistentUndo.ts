/**
 * @file src/features/vocabulary/background/persistentUndo.ts
 * 文件职责：实现浏览器扩展词书删除快照的后台事务与过期清理。
 * 主要内容：原子删除、限量保留、一次恢复、无正文回执及过期清理。
 * 模块边界：仅由扩展后台组合层注入；userscript 使用独立内存撤销，绝不将快照写入宿主数据库。
 */
import {cloneEntry, createUuid, restoreVocabularySnapshot, VocabularyBookError, type FluentReadVocabularyBookDatabase} from '../repository';
import {type VocabularyUndoRecord, type VocabularyUndoTicket} from '../learningModel';

export const VOCABULARY_UNDO_TTL_MS = 24 * 60 * 60 * 1000;
export const VOCABULARY_UNDO_MAX_PENDING = 20;
export const VOCABULARY_UNDO_MAX_BYTES = 8 * 1024 * 1024;

export class VocabularyPersistentUndo {
  constructor(private readonly db: FluentReadVocabularyBookDatabase) {}
  /** 删除与私密快照同事务提交；达到容量时保留原词条而不是丢失旧快照。 */
  async removeWithUndo(entryId: string, now?: number): Promise<VocabularyUndoTicket | null> {
    return this.db.transaction('rw', this.db.entries, this.db.reviewLogs, this.db.undo, async () => {
      await this.db.undo.where('expiresAt').belowOrEqual(now ?? Date.now()).delete();
      const entry = await this.db.entries.get(entryId);
      if (!entry) return null;
      const pending = await this.db.undo.where('state').equals('pending').toArray();
      if (pending.length >= VOCABULARY_UNDO_MAX_PENDING) {
        throw new VocabularyBookError('limit-exceeded', '待处理的删除恢复记录已满，请先恢复或放弃已有记录。');
      }
      const reviewLogs = await this.db.reviewLogs.where('entryId').equals(entryId).toArray();
      const snapshot = {entry: cloneEntry(entry), reviewLogs};
      const encoder = new TextEncoder();
      const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
      if (size(snapshot) + pending.reduce((total, record) => total + size(record), 0) > VOCABULARY_UNDO_MAX_BYTES) {
        throw new VocabularyBookError('limit-exceeded', '删除恢复记录空间已满，请先恢复或放弃已有记录。');
      }
      const createdAt = now ?? Date.now(), id = createUuid(), expiresAt = createdAt + VOCABULARY_UNDO_TTL_MS;
      await this.db.undo.add({id, createdAt, expiresAt, state: 'pending', snapshot});
      await this.db.entries.delete(entryId);
      await this.db.reviewLogs.where('entryId').equals(entryId).delete();
      // 长时间挂起使记录在提交前到期时，整个删除事务回滚。
      if (now === undefined && Date.now() >= expiresAt) throw new VocabularyBookError('storage-error', '删除未完成，请重试。');
      return {id, term: entry.term, createdAt, expiresAt};
    });
  }

  /** 仅返回票据，不把上下文和复习日志发到调用页面。 */
  async listUndo(now = Date.now()): Promise<VocabularyUndoTicket[]> {
    return this.db.transaction('rw', this.db.undo, async () => {
      await this.db.undo.where('expiresAt').belowOrEqual(now).delete();
      const records = await this.db.undo.where('state').equals('pending').toArray();
      return records.filter((record): record is Extract<VocabularyUndoRecord, {state: 'pending'}> => record.state === 'pending')
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .map(record => ({id: record.id, term: record.snapshot.entry.term, createdAt: record.createdAt, expiresAt: record.expiresAt}));
    });
  }

  /** 成功后仅保留无正文的回执；同一票据重试不会重复插入。 */
  async restoreUndo(id: string, now?: number): Promise<'restored' | 'previously-restored' | 'expired' | 'missing'> {
    const clock = () => now ?? Date.now();
    const expiredDuringWrite = new Error('expired during restore');
    try {
      return await this.db.transaction('rw', this.db.entries, this.db.reviewLogs, this.db.undo, async () => {
        const record = await this.db.undo.get(id);
        if (!record) return 'missing';
        if (record.expiresAt <= clock()) {await this.db.undo.delete(id); return 'expired';}
        if (record.state === 'restored') return 'previously-restored';
        await restoreVocabularySnapshot(this.db, record.snapshot);
        await this.db.undo.put({id, createdAt: record.createdAt, expiresAt: record.expiresAt, state: 'restored'});
        // 写操作完成后再次取时；若到期，抛错回滚整个事务，不能留下部分恢复。
        if (record.expiresAt <= clock()) throw expiredDuringWrite;
        return 'restored';
      });
    } catch (error) {
      if (error !== expiredDuringWrite) throw error;
      await this.db.transaction('rw', this.db.undo, async () => {
        const record = await this.db.undo.get(id);
        if (record && record.expiresAt <= clock()) await this.db.undo.delete(id);
      });
      return 'expired';
    }
  }

  async discardUndo(id: string): Promise<void> {await this.db.undo.delete(id);}

  async pruneUndo(now = Date.now()): Promise<void> {await this.db.undo.where('expiresAt').belowOrEqual(now).delete();}

}

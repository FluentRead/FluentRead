/**
 * @file src/platform/storage/dictionaryRepository.ts
 * 文件职责：为主动导入的离线词典保存独立、按词项索引的本地数据。
 * 主要内容：用 IndexedDB 原子提交词条与媒体，按来源和规范词形定点读取，支持完整删除；词库不进入配置备份。
 * 模块边界：只处理本地持久化，不解析文件、不请求在线来源、不修改用户词书。
 */
import Dexie, {type Table} from 'dexie';
import type {ImportedDictionary, ImportedDictionaryEntry, ImportedDictionaryResource} from '@/src/features/selection-translation/dictionary/imports';
export interface DictionaryMetadata {id: string; name: string; format: string; count: number; created: number; css: string}
interface StoredEntry extends ImportedDictionaryEntry {id?: number; dictionaryId: string}
interface StoredResource extends ImportedDictionaryResource {dictionaryId: string}
export class DictionaryRepository extends Dexie {
    dictionaries!: Table<DictionaryMetadata, string>;
    entries!: Table<StoredEntry, number>;
    resources!: Table<StoredResource, [string, string]>;
    constructor(name = 'fluentread-offline-dictionaries-v1') {
        super(name);
        this.version(1).stores({dictionaries: '&id', entries: '++id,[dictionaryId+key],dictionaryId', resources: '[dictionaryId+path],dictionaryId'});
    }
    async install(id: string, dictionary: ImportedDictionary): Promise<DictionaryMetadata> {
        const metadata: DictionaryMetadata = {id, name: dictionary.name.slice(0, 80), format: dictionary.format, count: dictionary.entries.length, created: Date.now(), css: dictionary.css};
        await this.transaction('rw', this.dictionaries, this.entries, this.resources, async () => {
            await this.entries.where('dictionaryId').equals(id).delete();
            await this.resources.where('dictionaryId').equals(id).delete();
            for (let at = 0; at < dictionary.entries.length; at += 2000) await this.entries.bulkAdd(dictionary.entries.slice(at, at + 2000).map(item => ({...item, dictionaryId: id})));
            for (let at = 0; at < dictionary.resources.length; at += 100) await this.resources.bulkPut(dictionary.resources.slice(at, at + 100).map(item => ({...item, dictionaryId: id})));
            await this.dictionaries.put(metadata);
        });
        return metadata;
    }
    async remove(id: string): Promise<void> {
        await this.transaction('rw', this.dictionaries, this.entries, this.resources, async () => {
            await this.entries.where('dictionaryId').equals(id).delete();
            await this.resources.where('dictionaryId').equals(id).delete();
            await this.dictionaries.delete(id);
        });
    }
    async lookup(id: string, key: string): Promise<{metadata: DictionaryMetadata; entries: StoredEntry[]}> {
        const metadata = await this.dictionaries.get(id);
        if (!metadata) throw new Error('Local dictionary is not installed on this device');
        const entries = await this.entries.where('[dictionaryId+key]').equals([id, key]).limit(8).toArray();
        return {metadata, entries};
    }
}

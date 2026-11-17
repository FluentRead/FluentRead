/**
 * @file src/features/selection-translation/dictionary/importWorker.ts
 * 文件职责：在独立 Worker 内完成离线词典解析与索引写入，避免设置页面卡顿。
 * 主要内容：接收 File 列表、校验总容量，传回原子安装结果；解析或配额失败时返回可显示错误。
 * 模块边界：仅由扩展设置页创建，不消费网页消息、不访问网络；关闭 Worker 即停止尚未提交的导入。
 */
import {parseDictionaryFiles, DICTIONARY_IMPORT_BYTES} from './imports';
import {DictionaryRepository} from '@/src/platform/storage/dictionaryRepository';
const scope = self as unknown as {onmessage: ((event: MessageEvent<{id: string; files: File[]}>) => void) | null; postMessage(value: unknown): void};
scope.onmessage = event => {
    void (async () => {
        const {id, files} = event.data;
        if (!Array.isArray(files) || files.reduce((sum, file) => sum + file.size, 0) > DICTIONARY_IMPORT_BYTES) throw new Error('Select dictionary files up to 128 MiB');
        const dictionary = await parseDictionaryFiles(await Promise.all(files.map(async file => ({name: file.name, bytes: new Uint8Array(await file.arrayBuffer())}))));
        const database = new DictionaryRepository();
        try {scope.postMessage({success: true, data: await database.install(id, dictionary)});}
        finally {database.close();}
    })().catch(error => scope.postMessage({success: false, error: error instanceof Error ? error.message : String(error)}));
};

/**
 * @file src/features/image-translation/services/ocrModelCache.ts
 * 文件职责：删除 Tesseract.js 浏览器缓存中指定的 OCR 语言包。
 * 主要内容：按当前引擎 idb-keyval 的数据库、对象仓库和 cachePath 精确删除 traineddata，等待事务提交后返回。
 * 模块边界：只删除明确指定的模型键，不清空数据库、不修改下载记录；Worker 释放与配置记录由调用层协调。
 */
import type {ImageOcrLanguageCode} from '../ocrLanguages';

export function removeOcrModelFiles(languages: ImageOcrLanguageCode[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('keyval-store');
        request.onupgradeneeded = () => request.result.createObjectStore('keyval');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('keyval')) { database.close(); resolve(); return; }
            const transaction = database.transaction('keyval', 'readwrite');
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onabort = () => { database.close(); reject(transaction.error || new Error('语言包清除失败')); };
            for (const language of languages) transaction.objectStore('keyval').delete(`fluent-read-image-ocr/${language}.traineddata`);
        };
    });
}

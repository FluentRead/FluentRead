/**
 * @file src/features/image-translation/background/ocrLanguageRepository.ts
 * 文件职责：封装已下载 OCR 语言包列表的读取、规范化和持久化，使后台下载 handler 不直接依赖某一种浏览器存储实现。
 * 主要内容：定义 ImageOcrLanguageStorage 与 ImageOcrLanguageRepository 契约，并由 createImageOcrLanguageRepository 提供 read、write 和合并已下载语言代码的操作。
 * 模块边界：仓库只保存语言代码状态，不下载 Tesseract 资源也不判断浏览器能力；实际 storage adapter 由 composition root 注入，语言白名单与推荐集合来自 ocrLanguages.ts。
 */
import {
    getRequiredImageOcrLanguages,
    IMAGE_OCR_LANGUAGE_PACKS,
    IMAGE_OCR_LANGUAGE_STATE_KEY,
    normalizeImageOcrLanguageCodes,
    type ImageOcrLanguageCode,
} from '@/src/features/image-translation/ocrLanguages';

export interface ImageOcrLanguageStorage {
    get(key: string): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
}

export interface ImageOcrLanguageRepository {
    getDownloaded(): Promise<ImageOcrLanguageCode[]>;
    markDownloaded(languages: ImageOcrLanguageCode[]): Promise<ImageOcrLanguageCode[]>;
    markRemoved(languages: ImageOcrLanguageCode[]): Promise<ImageOcrLanguageCode[]>;
    assertDownloaded(sourceLanguage: string): Promise<void>;
}

/** 创建 OCR 语言包仓库；后台加密配置存储仅通过 adapter 注入。 */
export function createImageOcrLanguageRepository(
    storage: ImageOcrLanguageStorage,
): ImageOcrLanguageRepository {
    let pendingMark = Promise.resolve();

    const getDownloaded = async (): Promise<ImageOcrLanguageCode[]> => {
        const stored = await storage.get(IMAGE_OCR_LANGUAGE_STATE_KEY);
        return normalizeImageOcrLanguageCodes(stored[IMAGE_OCR_LANGUAGE_STATE_KEY]);
    };

    const markDownloaded = async (
        languages: ImageOcrLanguageCode[],
        remove = false,
    ): Promise<ImageOcrLanguageCode[]> => {
        let releasePendingMark!: () => void;
        const previousMark = pendingMark;
        pendingMark = new Promise<void>((resolve) => {
            releasePendingMark = resolve;
        });

        await previousMark;
        try {
            const downloaded = new Set(await getDownloaded());
            for (const language of languages) { if (remove) downloaded.delete(language); else downloaded.add(language); }
            const next = normalizeImageOcrLanguageCodes([...downloaded]);
            await storage.set({[IMAGE_OCR_LANGUAGE_STATE_KEY]: next});
            return next;
        } finally {
            releasePendingMark();
        }
    };

    return {
        getDownloaded,
        markDownloaded,
        markRemoved: languages => markDownloaded(languages, true),
        async assertDownloaded(sourceLanguage) {
            const downloaded = new Set(await getDownloaded());
            const missing = getRequiredImageOcrLanguages(sourceLanguage)
                .filter((language) => !downloaded.has(language));
            if (missing.length === 0) return;

            const labels = new Map(IMAGE_OCR_LANGUAGE_PACKS.map((pack) => [pack.code, pack.label]));
            const missingLabels = missing.map((language) => labels.get(language)!).join('、');
            throw new Error(`图片文字识别需要先下载${missingLabels}语言包，请前往设置 > 图片翻译下载`);
        },
    };
}

/** 构建期空适配器：明确隔离必须依赖扩展专属 API 的功能。 */
export function mountAreaTranslator(): undefined {
    return undefined;
}

export function unmountAreaTranslator(): void {}

export function isAreaTranslatorMounted(): boolean {
    return false;
}

export function mountImageTranslator(): void {}

export function unmountImageTranslator(): void {}

/** 再次遇见只在扩展中挂载，油猴构建不包含扫描器和浮层。 */
export function mountVocabularyReencounter(): void {}
export function unmountVocabularyReencounter(): void {}

export function mountVideoSubtitleTranslation(): () => void {
    return () => undefined;
}

/** Userscript 不注入 YouTube/X MAIN-world bridge，因此始终关闭扩展专属字幕 runtime。 */
export function isSupportedVideoPage(): boolean {
    return false;
}

export function toggleContextMenuImage(): boolean { return false; }

/** Userscript 没有原生右键菜单，圈选翻译入口始终不可用。 */
export function startAreaTranslationFromContextMenu(): boolean { return false; }

// 完整设置页仍需要语言状态契约；扩展专属的内容运行时继续禁用。
export {IMAGE_OCR_LANGUAGE_STATE_KEY, normalizeImageOcrLanguageCodes} from '@/src/features/image-translation/ocrLanguages';
export const prepareImageOcrLanguages = async (): Promise<void> => undefined;

export {
    VIDEO_LOCAL_TRANSCRIPTION_MODELS,
    VIDEO_LOCAL_TRANSCRIPTION_STATE_KEY,
    VIDEO_LOCAL_TRANSCRIPTION_RECOMMENDED_MODEL,
    normalizeVideoLocalTranscriptionModels,
} from '@/src/features/video-subtitle/transcription';
export type {VideoLocalTranscriptionModel} from '@/src/features/video-subtitle/transcription';
export {
    VIDEO_AI_SUBTITLE_CACHE_CLEAR_MESSAGE,
    VIDEO_AI_SUBTITLE_CACHE_STATS_MESSAGE,
} from '@/src/features/video-subtitle/transcriptionCache';

/** 油猴没有扩展 OCR/offscreen 能力，悬浮球漫画入口始终不可用。 */
export function toggleMangaTranslation(): boolean { return false; }
export function openMangaEntry(): boolean { return false; }
export function isMangaReaderPage(): boolean { return false; }
export function isImageTranslatorNeeded(): boolean { return false; }
export async function mountMangaEntry(): Promise<void> {}
export function unmountMangaEntry(): void {}
export function subscribeMangaTranslation(listener: (status: {available: boolean; active: boolean; pending: boolean; errors: number}) => void): () => void {
    listener({available: false, active: false, pending: false, errors: 0});
    return () => undefined;
}

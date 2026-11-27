/**
 * @file src/core/config/localTranslation.ts
 *
 * 文件职责：定义浏览器本地翻译静态模型目录、下载状态键与无需文本识别的模型配置规则。
 * 主要内容：提供中英/日英轻量语言包、混元翻译和旧模型兼容目录，定义持久下载任务、模型语言名称与 OPUS 仓库映射。
 * 模块边界：只处理静态配置、下载状态与模型元数据，不导入文本检测或读取浏览器存储；指定和自动语言解析由 core/language/localTranslation.ts 消费本目录。
 */

export const LOCAL_TRANSLATION_SERVICE_ID = 'localTranslation' as const;
export const LOCAL_TRANSLATION_MODEL_STATE_KEY = 'fluentReadLocalTranslationModels' as const;
export const LOCAL_TRANSLATION_DOWNLOAD_STATE_KEY = 'fluentReadLocalTranslationDownloadsV2' as const;
export const LOCAL_TRANSLATION_DTYPE = 'q8' as const;
export const LOCAL_TRANSLATION_MODEL_REMOTE_HOST = 'https://huggingface.co/' as const;
export const LOCAL_TRANSLATION_MODEL_REVISION = 'main' as const;

export const LOCAL_TRANSLATION_MODEL_IDS = {
    opusZhEn: 'fluentread/opus-zh-en',
    opusJaEn: 'fluentread/opus-ja-en',
    hunyuan: 'tencent/Hy-MT2-1.8B-GGUF',
    m2m100: 'Xenova/m2m100_418M',
    nllb: 'Xenova/nllb-200-distilled-600M',
} as const;

export type LocalTranslationModelId = typeof LOCAL_TRANSLATION_MODEL_IDS[keyof typeof LOCAL_TRANSLATION_MODEL_IDS];

export interface LocalTranslationModel {
    value: LocalTranslationModelId;
    label: string;
    descriptionKey: string;
    nameKey?: string;
    languagesKey: string;
    downloadSizeMb: number;
    memoryMb: readonly [number, number];
    engine: 'opus' | 'hunyuan' | 'legacy';
    repositories: readonly string[];
    legacy?: boolean;
}

export type LocalTranslationDownloadPhase = 'idle' | 'queued' | 'downloading' | 'verifying' | 'paused' | 'ready' | 'error' | 'removing';
export interface LocalTranslationDownloadState {
    model: LocalTranslationModelId;
    phase: LocalTranslationDownloadPhase;
    downloadedBytes: number;
    totalBytes: number;
    bytesPerSecond: number;
    updatedAt: number;
    error?: 'network' | 'storage' | 'integrity' | 'unknown';
}
export interface LocalTranslationDownloadSnapshot {
    version: 2;
    tasks: LocalTranslationDownloadState[];
}

export const LOCAL_TRANSLATION_MODELS: readonly LocalTranslationModel[] = [
    {
        value: LOCAL_TRANSLATION_MODEL_IDS.opusZhEn,
        label: 'OPUS-MT Chinese / English',
        nameKey: 'settings.localTranslation.opusZhEn',
        descriptionKey: 'settings.localTranslation.opusZhEnDescription',
        languagesKey: 'settings.localTranslation.languagesZhEn',
        downloadSizeMb: 239,
        memoryMb: [500, 2000],
        engine: 'opus',
        repositories: ['Xenova/opus-mt-en-zh', 'Xenova/opus-mt-zh-en'],
    },
    {
        value: LOCAL_TRANSLATION_MODEL_IDS.hunyuan,
        label: 'Hy-MT2 1.8B',
        nameKey: 'settings.localTranslation.hunyuan',
        descriptionKey: 'settings.localTranslation.hunyuanDescription',
        languagesKey: 'settings.localTranslation.languagesHunyuan',
        downloadSizeMb: 1133,
        memoryMb: [1500, 2500],
        engine: 'hunyuan',
        repositories: ['tencent/Hy-MT2-1.8B-GGUF'],
    },
    {
        value: LOCAL_TRANSLATION_MODEL_IDS.opusJaEn,
        label: 'OPUS-MT Japanese / English',
        nameKey: 'settings.localTranslation.opusJaEn',
        descriptionKey: 'settings.localTranslation.opusJaEnDescription',
        languagesKey: 'settings.localTranslation.languagesJaEn',
        downloadSizeMb: 214,
        memoryMb: [500, 2000],
        engine: 'opus',
        repositories: ['Xenova/opus-mt-ja-en', 'Xenova/opus-mt-en-jap'],
    },
    {
        value: LOCAL_TRANSLATION_MODEL_IDS.m2m100,
        label: 'M2M100 418M',
        descriptionKey: 'settings.localTranslation.model.m2m100Description',
        downloadSizeMb: 630,
        memoryMb: [1200, 2200],
        languagesKey: 'settings.localTranslation.languagesLegacy',
        engine: 'legacy', repositories: ['Xenova/m2m100_418M'], legacy: true,
    },
    {
        value: LOCAL_TRANSLATION_MODEL_IDS.nllb,
        label: 'NLLB-200 Distilled 600M',
        descriptionKey: 'settings.localTranslation.model.nllbDescription',
        downloadSizeMb: 990,
        memoryMb: [1800, 3000],
        languagesKey: 'settings.localTranslation.languagesLegacy',
        engine: 'legacy', repositories: ['Xenova/nllb-200-distilled-600M'], legacy: true,
    },
] as const;

export const DEFAULT_LOCAL_TRANSLATION_MODEL = LOCAL_TRANSLATION_MODEL_IDS.opusZhEn;

export function getLocalTranslationModel(value: unknown): LocalTranslationModel {
    return LOCAL_TRANSLATION_MODELS.find((model) => model.value === value) || LOCAL_TRANSLATION_MODELS[0]!;
}

export function isLocalTranslationModel(value: unknown): value is LocalTranslationModelId {
    return LOCAL_TRANSLATION_MODELS.some((model) => model.value === value);
}

export function normalizeLocalTranslationModel(value: unknown): LocalTranslationModelId {
    return isLocalTranslationModel(value) ? value : DEFAULT_LOCAL_TRANSLATION_MODEL;
}

export function normalizeLocalTranslationDownloadSnapshot(value: unknown): LocalTranslationDownloadSnapshot | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const snapshot = value as Partial<LocalTranslationDownloadSnapshot>;
    if (snapshot.version !== 2 || !Array.isArray(snapshot.tasks)) return undefined;
    const phases: readonly string[] = ['idle', 'queued', 'downloading', 'verifying', 'paused', 'ready', 'error', 'removing'];
    const tasks: LocalTranslationDownloadState[] = [];
    for (const item of snapshot.tasks) {
        if (!item || !isLocalTranslationModel(item.model) || !phases.includes(item.phase)) return undefined;
        if (tasks.some((task) => task.model === item.model)) return undefined;
        const numbers = [item.downloadedBytes, item.totalBytes, item.bytesPerSecond, item.updatedAt];
        if (numbers.some((number) => typeof number !== 'number' || !Number.isFinite(number) || number < 0)) return undefined;
        if (item.downloadedBytes > item.totalBytes) return undefined;
        tasks.push({
            model: item.model, phase: item.phase, downloadedBytes: item.downloadedBytes,
            totalBytes: item.totalBytes, bytesPerSecond: item.bytesPerSecond, updatedAt: item.updatedAt,
            error: ['network', 'storage', 'integrity', 'unknown'].includes(item.error || '') ? item.error : undefined,
        });
    }
    return {version: 2, tasks};
}

export const HUNYUAN_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
    zh: 'Chinese', en: 'English', ja: 'Japanese', fr: 'French', pt: 'Portuguese',
    es: 'Spanish', tr: 'Turkish', ru: 'Russian', ar: 'Arabic', ko: 'Korean', th: 'Thai',
    it: 'Italian', de: 'German', vi: 'Vietnamese', ms: 'Malay', id: 'Indonesian', tl: 'Filipino',
    hi: 'Hindi', 'zh-Hant': 'Traditional Chinese', pl: 'Polish', cs: 'Czech', nl: 'Dutch',
    km: 'Khmer', my: 'Burmese', fa: 'Persian', gu: 'Gujarati', ur: 'Urdu', te: 'Telugu',
    mr: 'Marathi', he: 'Hebrew', bn: 'Bengali', ta: 'Tamil', uk: 'Ukrainian',
    bo: 'Tibetan', kk: 'Kazakh', mn: 'Mongolian', ug: 'Uyghur', yue: 'Cantonese',
};

export function resolveOpusTranslationRepository(model: unknown, source: string, target: string): string {
    const item = getLocalTranslationModel(model);
    const pair = `${source}-${target === 'ja' ? 'jap' : target}`;
    const repository = `Xenova/opus-mt-${pair}`;
    if (item.engine !== 'opus' || !item.repositories.includes(repository)) {
        throw new Error('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED');
    }
    return repository;
}

export function localTranslationErrorKey(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('LOCAL_TRANSLATION_NOT_DOWNLOADED')) return 'settings.localTranslation.error.notDownloaded';
    if (message.includes('LOCAL_TRANSLATION_LANGUAGE_UNSUPPORTED')) return 'settings.localTranslation.error.language';
    if (/LOCAL_TRANSLATION_(REPETITION|OUTPUT_LIMIT|EMPTY)/u.test(message)) return 'settings.localTranslation.error.repetition';
    if (message.includes('LOCAL_TRANSLATION_TIMEOUT') || /超时|超过|timeout/iu.test(message)) return 'settings.localTranslation.error.timeout';
    if (message.includes('LOCAL_TRANSLATION_MODEL_REMOVED')) return 'settings.localTranslation.error.removed';
    if (message.includes('LOCAL_TRANSLATION_BROWSER_UNSUPPORTED') || message.includes('ONNX_WASM_JSPI_UNSUPPORTED')) return 'settings.localTranslation.error.browser';
    return 'settings.localTranslation.trialError';
}

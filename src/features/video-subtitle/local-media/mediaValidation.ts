/**
 * @file src/features/video-subtitle/local-media/mediaValidation.ts
 * 文件职责：校验导入本地音视频文件的扩展名、MIME 类型、体积与时长上限，并格式化展示信息。
 * 主要内容：限定 mp4/webm/mp3/m4a/wav/ogg/flac 支持集合，区分音频与视频渲染形态，提供统一的 200 MB 与 20 分钟边界常量及时间戳和字节格式化工具。
 * 模块边界：纯数据校验与文本格式化模块，不接触 FileReader、Web Audio、DOM 或浏览器扩展存储。
 */

export const LOCAL_MEDIA_SUPPORTED_EXTENSIONS = [
    '.mp4',
    '.webm',
    '.mp3',
    '.m4a',
    '.wav',
    '.ogg',
    '.flac',
] as const;

export type LocalMediaExtension = typeof LOCAL_MEDIA_SUPPORTED_EXTENSIONS[number];
export type LocalMediaKind = 'audio' | 'video';

export const LOCAL_MEDIA_ACCEPT_ATTRIBUTE =
    '.mp4,.webm,.mp3,.m4a,.wav,.ogg,.flac,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/flac,audio/webm,video/mp4,video/webm';

export const MAX_LOCAL_MEDIA_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_LOCAL_MEDIA_DURATION_SECONDS = 20 * 60;

const VIDEO_EXTENSIONS = new Set<string>(['.mp4', '.webm']);
const AUDIO_EXTENSIONS = new Set<string>(['.mp3', '.m4a', '.wav', '.ogg', '.flac']);

const SUPPORTED_MIME_TO_KIND: Readonly<Record<string, LocalMediaKind>> = {
    'video/mp4': 'video',
    'video/webm': 'video',
    'audio/mpeg': 'audio',
    'audio/mp3': 'audio',
    'audio/mp4': 'audio',
    'audio/x-m4a': 'audio',
    'audio/m4a': 'audio',
    'audio/wav': 'audio',
    'audio/x-wav': 'audio',
    'audio/wave': 'audio',
    'audio/ogg': 'audio',
    'audio/flac': 'audio',
    'audio/x-flac': 'audio',
    'audio/webm': 'audio',
};

export interface LocalMediaFileLike {
    readonly name: string;
    readonly type: string;
    readonly size: number;
}

export type LocalMediaValidationErrorCode = 'empty' | 'unsupportedFormat' | 'tooLarge';

export type LocalMediaValidationResult =
    | {
        readonly ok: true;
        readonly kind: LocalMediaKind;
        readonly extension: LocalMediaExtension | '';
        readonly baseName: string;
    }
    | {
        readonly ok: false;
        readonly code: LocalMediaValidationErrorCode;
        readonly maxBytes: number;
    };

function extractExtension(name: string): string {
    const trimmed = name.trim().toLowerCase();
    const dot = trimmed.lastIndexOf('.');
    return dot > 0 ? trimmed.slice(dot) : '';
}

function extractBaseName(name: string): string {
    const trimmed = name.trim();
    const dot = trimmed.lastIndexOf('.');
    return (dot > 0 ? trimmed.slice(0, dot) : trimmed) || 'local-media';
}

export function classifyLocalMediaKind(file: Pick<LocalMediaFileLike, 'name' | 'type'>): LocalMediaKind | null {
    const extension = extractExtension(file.name);
    const mime = file.type.trim().toLowerCase().split(';')[0];
    if (mime && mime !== 'application/octet-stream') {
        const mimeKind = SUPPORTED_MIME_TO_KIND[mime];
        if (!mimeKind) return null;
        if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
        if (VIDEO_EXTENSIONS.has(extension)) return mimeKind;
        return extension ? null : mimeKind;
    }
    if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
    if (VIDEO_EXTENSIONS.has(extension)) return 'video';
    return null;
}

export function validateLocalMediaFile(file: LocalMediaFileLike): LocalMediaValidationResult {
    if (!Number.isFinite(file.size) || file.size <= 0) {
        return {ok: false, code: 'empty', maxBytes: MAX_LOCAL_MEDIA_FILE_BYTES};
    }
    if (file.size > MAX_LOCAL_MEDIA_FILE_BYTES) {
        return {ok: false, code: 'tooLarge', maxBytes: MAX_LOCAL_MEDIA_FILE_BYTES};
    }
    const kind = classifyLocalMediaKind(file);
    if (!kind) {
        return {ok: false, code: 'unsupportedFormat', maxBytes: MAX_LOCAL_MEDIA_FILE_BYTES};
    }
    const rawExtension = extractExtension(file.name);
    const extension = (LOCAL_MEDIA_SUPPORTED_EXTENSIONS as readonly string[]).includes(rawExtension)
        ? rawExtension as LocalMediaExtension
        : '';
    return {
        ok: true,
        kind,
        extension,
        baseName: extractBaseName(file.name),
    };
}

export function formatMediaBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMediaTimestamp(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const body = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    return hours > 0 ? `${hours}:${body}` : body;
}

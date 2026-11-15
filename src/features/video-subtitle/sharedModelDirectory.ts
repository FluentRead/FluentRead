/**
 * @file src/features/video-subtitle/sharedModelDirectory.ts
 * 文件职责：让用户可选的本地目录承载跨浏览器共享的 Whisper 权重。
 * 主要内容：在扩展本地 IndexedDB 保存目录授权句柄，以版本化的 FluentRead/whisper 路径读写受限模型文件，并对写入文件计算 SHA-256、读取时边传给推理端边校验。
 * 模块边界：只处理用户授权目录与模型文件缓存接口；目录选择只从设置页用户手势触发，默认浏览器 CacheStorage 仍由 modelCache 管理。
 */
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
import {getVideoLocalTranscriptionModelId, type VideoLocalTranscriptionModel} from './transcription';
import {
  getVideoAiModelFileSets,
  VIDEO_AI_MODEL_REVISION,
  VIDEO_AI_Q4_MODEL_FILES,
  VIDEO_AI_Q8_MODEL_FILES,
  VIDEO_AI_SMALL_MODEL_FILES,
  type VideoAiModelFile,
} from './modelFiles';

type PermissionState = 'granted' | 'prompt' | 'denied' | 'unavailable';
type PermissionMode = 'read' | 'readwrite';
type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {mode?: 'read' | 'readwrite'}) => Promise<FileSystemDirectoryHandle>;
};

export interface SharedVideoAiDirectoryStatus {
  supported: boolean;
  configured: boolean;
  read: PermissionState;
  write: PermissionState;
}

export interface VideoAiModelCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  putWithProgress?(request: RequestInfo | URL, response: Response, onProgress: (loaded: number, total?: number) => void): Promise<void>;
}

export interface SharedVideoAiModelCache extends VideoAiModelCache {
  putWithProgress(request: RequestInfo | URL, response: Response, onProgress: (loaded: number, total?: number) => void): Promise<void>;
}

interface ModelFileIdentity {
  model: VideoLocalTranscriptionModel;
  modelId: string;
  revision: string;
  file: VideoAiModelFile;
  folder: string;
}

interface ModelFileMetadata {
  schema: 1;
  modelId: string;
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
}

const DATABASE_NAME = 'fluentread-video-shared-models';
const DATABASE_VERSION = 1;
const HANDLE_STORE = 'directories';
const HANDLE_KEY = 'whisper-model-directory';
const SHARED_DIRECTORY_ROOT = ['FluentRead', 'whisper'] as const;
const SHARE_PERMISSION_ERROR = '共享模型目录需要重新授权，请在本地 AI 字幕设置中重新选择同一文件夹';
const MAX_SHARED_MODEL_FILE_BYTES = 384 * 1024 * 1024;
const ALLOWED_FILES = new Set<string>([
  ...VIDEO_AI_Q4_MODEL_FILES,
  ...VIDEO_AI_Q8_MODEL_FILES,
  ...VIDEO_AI_SMALL_MODEL_FILES,
]);

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法读取共享模型目录授权'));
  });
}

function openDirectoryDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('当前浏览器不支持保存共享目录授权'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE)) request.result.createObjectStore(HANDLE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开共享模型目录授权'));
  });
}

async function readStoredDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  const database = await openDirectoryDatabase();
  try {
    const transaction = database.transaction(HANDLE_STORE, 'readonly');
    const value = await requestResult(transaction.objectStore(HANDLE_STORE).get(HANDLE_KEY));
    return value && typeof value === 'object' && (value as FileSystemDirectoryHandle).kind === 'directory'
      ? value as FileSystemDirectoryHandle
      : undefined;
  } finally {
    database.close();
  }
}

async function writeStoredDirectory(handle: FileSystemDirectoryHandle | undefined): Promise<void> {
  const database = await openDirectoryDatabase();
  try {
    const transaction = database.transaction(HANDLE_STORE, 'readwrite');
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('无法保存共享模型目录授权'));
      transaction.onabort = () => reject(transaction.error || new Error('无法保存共享模型目录授权'));
    });
    const request = (handle
      ? transaction.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY)
      : transaction.objectStore(HANDLE_STORE).delete(HANDLE_KEY)) as IDBRequest<unknown>;
    await Promise.all([requestResult(request), completed]);
  } finally {
    database.close();
  }
}

export function supportsSharedVideoAiDirectory(): boolean {
  return typeof indexedDB !== 'undefined'
    && typeof window !== 'undefined'
    && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

async function permission(handle: FileSystemDirectoryHandle, mode: PermissionMode): Promise<PermissionState> {
  try {
    const queryPermission = (handle as FileSystemDirectoryHandle & {
      queryPermission?: (descriptor?: {mode?: PermissionMode}) => Promise<PermissionState>;
    }).queryPermission;
    return queryPermission ? await queryPermission.call(handle, {mode}) : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function getSharedVideoAiDirectoryStatus(): Promise<SharedVideoAiDirectoryStatus> {
  const supported = supportsSharedVideoAiDirectory();
  if (!supported) return {supported, configured: false, read: 'unavailable', write: 'unavailable'};
  const handle = await readStoredDirectory();
  if (!handle) return {supported, configured: false, read: 'unavailable', write: 'unavailable'};
  const [read, write] = await Promise.all([permission(handle, 'read'), permission(handle, 'readwrite')]);
  return {supported, configured: true, read, write};
}

/** 只在设置页按钮点击时打开系统目录选择器，不在页面加载或模型下载时弹出授权。 */
export async function chooseSharedVideoAiDirectory(): Promise<SharedVideoAiDirectoryStatus> {
  if (!supportsSharedVideoAiDirectory()) throw new Error('当前浏览器不支持共享模型目录');
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  const handle = await picker!.call(window, {mode: 'readwrite'});
  await writeStoredDirectory(handle);
  const [read, write] = await Promise.all([permission(handle, 'read'), permission(handle, 'readwrite')]);
  return {supported: true, configured: true, read, write};
}

/** 仅忘记当前扩展实例中的授权；共享目录里的模型由用户自行管理，绝不递归删除。 */
export async function disconnectSharedVideoAiDirectory(): Promise<void> {
  await writeStoredDirectory(undefined);
}

function requestUrl(request: RequestInfo | URL): string {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.toString();
  return request.url;
}

function parseModelFileIdentity(request: RequestInfo | URL): ModelFileIdentity | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl(request));
  } catch {
    return undefined;
  }
  if (url.origin !== 'https://modelscope.cn' || url.search || url.hash || url.username || url.password) return undefined;
  const match = url.pathname.match(/^\/models\/onnx-community\/whisper-(tiny|base|small)\/resolve\/([^/]+)\/(.+)$/u);
  if (!match) return undefined;
  const model = match[1] as VideoLocalTranscriptionModel;
  let revision: string;
  let file: string;
  try {
    revision = decodeURIComponent(match[2]!);
    file = decodeURIComponent(match[3]!);
  } catch {
    return undefined;
  }
  // 固定清单只有受控的文件名；其他路径（包括点段与额外子目录）一律拒绝。
  if (revision !== VIDEO_AI_MODEL_REVISION || !ALLOWED_FILES.has(file)) return undefined;
  const modelId = getVideoLocalTranscriptionModelId(model);
  return {model, modelId, revision, file: file as VideoAiModelFile, folder: `whisper-${model}`};
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'NotFoundError');
}

async function fileDirectory(
  root: FileSystemDirectoryHandle,
  identity: ModelFileIdentity,
  create: boolean,
): Promise<{directory: FileSystemDirectoryHandle; name: string}> {
  let directory = root;
  for (const name of [...SHARED_DIRECTORY_ROOT, identity.folder, identity.revision, ...identity.file.split('/').slice(0, -1)]) {
    directory = await directory.getDirectoryHandle(name, {create});
  }
  return {directory, name: identity.file.split('/').at(-1)!};
}

async function readMetadata(handle: FileSystemDirectoryHandle, identity: ModelFileIdentity): Promise<ModelFileMetadata | undefined> {
  try {
    const {directory, name} = await fileDirectory(handle, identity, false);
    const metadataHandle = await directory.getFileHandle(`${name}.fluentread.json`);
    const metadata = JSON.parse(await (await metadataHandle.getFile()).text()) as Partial<ModelFileMetadata>;
    if (metadata.schema !== 1 || metadata.modelId !== identity.modelId || metadata.revision !== identity.revision
      || metadata.file !== identity.file || !Number.isSafeInteger(metadata.bytes) || metadata.bytes! <= 0
      || metadata.bytes! > MAX_SHARED_MODEL_FILE_BYTES
      || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.sha256)) return undefined;
    return metadata as ModelFileMetadata;
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function verifiedResponse(file: File, metadata: ModelFileMetadata, onIntegrityFailure: () => Promise<void>): Response {
  const reader = file.stream().getReader();
  const hash = sha256.create();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (cancelled) return;
        if (chunk.done) {
          if (bytesToHex(hash.digest()) !== metadata.sha256) {
            await onIntegrityFailure();
            controller.error(new Error('共享模型文件校验失败，请重新下载或迁移模型'));
            return;
          }
          controller.close();
          return;
        }
        hash.update(chunk.value);
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size)},
  });
}

async function writeText(handle: FileSystemFileHandle, value: string): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(value);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

function createSharedCache(handle: FileSystemDirectoryHandle): SharedVideoAiModelCache {
  let readPermission: Promise<PermissionState> | undefined;
  let writePermission: Promise<PermissionState> | undefined;
  const canRead = () => readPermission ||= permission(handle, 'read');
  const canWrite = () => writePermission ||= permission(handle, 'readwrite');
  const match = async (request: RequestInfo | URL): Promise<Response | undefined> => {
    const identity = parseModelFileIdentity(request);
    if (!identity || await canRead() !== 'granted') return undefined;
    try {
      const metadata = await readMetadata(handle, identity);
      if (!metadata) return undefined;
      const {directory, name} = await fileDirectory(handle, identity, false);
      const fileHandle = await directory.getFileHandle(name);
      const file = await fileHandle.getFile();
      if (!file.size || file.size !== metadata.bytes) return undefined;
      return verifiedResponse(file, metadata, async () => {
        if (await canWrite() !== 'granted') return;
        await directory.removeEntry(`${name}.fluentread.json`).catch(() => undefined);
      });
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  };

  const putWithProgress = async (
    request: RequestInfo | URL,
    response: Response,
    onProgress?: (loaded: number, total?: number) => void,
  ): Promise<void> => {
    const identity = parseModelFileIdentity(request);
    if (!identity) throw new Error('不支持写入此共享模型文件');
    if (await canWrite() !== 'granted') throw new Error(SHARE_PERMISSION_ERROR);
    if (response.status !== 200 || !response.body || /text\/html/iu.test(response.headers.get('Content-Type') || '')) {
      throw new Error('共享模型文件响应无效，请重试下载');
    }
    const expectedLength = Number(response.headers.get('Content-Length'));
    const encoded = Boolean(response.headers.get('Content-Encoding'));
    const total = !encoded && Number.isSafeInteger(expectedLength) && expectedLength > 0 ? expectedLength : undefined;
    const maximum = identity.file === 'onnx/encoder_model.onnx' ? MAX_SHARED_MODEL_FILE_BYTES : 256 * 1024 * 1024;
    if (total !== undefined && total > maximum) throw new Error('共享模型文件超过大小限制');

    const {directory, name} = await fileDirectory(handle, identity, true);
    const fileHandle = await directory.getFileHandle(name, {create: true});
    const writable = await fileHandle.createWritable();
    const reader = response.body.getReader();
    const hash = sha256.create();
    let loaded = 0;
    try {
      onProgress?.(0, total);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        loaded += chunk.value.byteLength;
        if (loaded > maximum || total !== undefined && loaded > total) throw new Error('共享模型文件超过大小限制');
        hash.update(chunk.value);
        await writable.write(chunk.value);
        onProgress?.(loaded, total);
      }
      if (!loaded || total !== undefined && loaded !== total) throw new Error('共享模型文件长度不完整，请重试');
      await writable.close();
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      await writable.abort().catch(() => undefined);
      throw error;
    }
    const metadata: ModelFileMetadata = {
      schema: 1,
      modelId: identity.modelId,
      revision: identity.revision,
      file: identity.file,
      bytes: loaded,
      sha256: bytesToHex(hash.digest()),
    };
    const metadataHandle = await directory.getFileHandle(`${name}.fluentread.json`, {create: true});
    await writeText(metadataHandle, JSON.stringify(metadata));
  };

  return {
    match,
    put: (request, response) => putWithProgress(request, response),
    putWithProgress,
  };
}

/** 返回每个扩展实例独立的授权句柄；没有配置共享目录时返回 undefined。 */
export async function createSharedVideoAiModelCache(): Promise<SharedVideoAiModelCache | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  const handle = await readStoredDirectory();
  return handle ? createSharedCache(handle) : undefined;
}

/** 精确检查模型档位、固定仓库 revision、完整文件清单和写入时保存的字节完整性记录。 */
export async function readSharedVideoAiModels(cache: VideoAiModelCache | undefined): Promise<VideoLocalTranscriptionModel[]> {
  if (!cache) return [];
  const available: VideoLocalTranscriptionModel[] = [];
  for (const model of ['tiny', 'base', 'small'] as const) {
    for (const files of getVideoAiModelFileSets(model)) {
      const complete = await Promise.all(files.map(async file => {
        const response = await cache.match(sharedModelFileUrl(model, file));
        if (!response) return false;
        await response.body?.cancel();
        return true;
      }));
      if (complete.every(Boolean)) {
        available.push(model);
        break;
      }
    }
  }
  return available;
}

export function sharedModelFileUrl(model: VideoLocalTranscriptionModel, file: string): string {
  return `https://modelscope.cn/models/${getVideoLocalTranscriptionModelId(model)}/resolve/${VIDEO_AI_MODEL_REVISION}/${file}`;
}
